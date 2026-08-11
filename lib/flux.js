/**
 * Transport. The only file that changes if deployment auth changes (PRD §5.5).
 *
 * Uses the official SDK — `@deepgram/sdk` v5.7.0 — per the build's SDK-first
 * rule. The SDK owns connecting to `/v2/speak`, auth, and binary audio frame
 * delivery. See DECISIONS.md D-001 for why this overrides PRD §5.2's
 * zero-dependency stance, and SDK_WATCH.md for the frame-level gaps that are
 * still hand-rolled in `lib/frames.js`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY `baseUrl` IS REQUIRED AND HAS NO DEFAULT
 *
 * The SDK resolves its WebSocket host as (CustomClient.ts:1118-1120):
 *
 *     options.baseUrl ?? (options.environment ?? DeepgramEnvironment.Production)[environmentKey]
 *
 * and `WrappedSpeakV2Client.connect()` passes `environmentKey: "production"`
 * hardcoded. `DeepgramEnvironment` defines only `Production`.
 *
 * So `baseUrl` genuinely overrides — the SDK can be pointed at staging — but if
 * `baseUrl` is absent the SDK silently connects to `wss://api.deepgram.com`.
 * Production. No error, no warning.
 *
 * This build targets staging only, and is forbidden from having a convenience
 * path that flips to production by accident. A default value for the base URL
 * IS that path. So the base URL is required, validated, and has no fallback:
 * misconfiguration fails loudly at startup instead of quietly succeeding
 * against production. See DECISIONS.md D-002, FLAGS.md F-001.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { DeepgramClient } from "@deepgram/sdk";
import { isMarkupStripped, readStripped, readBillable, readInputCount, logEntry } from "./frames.js";

/** Hosts we refuse to talk to regardless of configuration. */
const PRODUCTION_HOSTS = new Set(["api.deepgram.com", "agent.deepgram.com"]);

/**
 * Validate the configured base URL.
 *
 * Rejects production hosts outright. This is a structural guard, not a
 * convenience: the whole point is that no env var value, typo, or copied config
 * can make this build reach production.
 */
export function validateBaseUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      "DEEPGRAM_BASE_URL is required and has no default. This build targets staging only; " +
        "the SDK would otherwise silently fall back to production (wss://api.deepgram.com). " +
        "See FLAGS.md F-001.",
    );
  }
  const value = raw.trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`DEEPGRAM_BASE_URL is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
    throw new Error(`DEEPGRAM_BASE_URL must be ws/wss (or http/https for a local mock), got ${url.protocol}`);
  }
  if (PRODUCTION_HOSTS.has(url.hostname)) {
    throw new Error(
      `DEEPGRAM_BASE_URL points at a production host (${url.hostname}). ` +
        "This build is staging-only. Production cutover is a separate, deliberate step.",
    );
  }
  return value;
}

export function apiKeyFromEnv(env = process.env) {
  const key = env.DEEPGRAM_STAGING_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(
      "DEEPGRAM_STAGING_API_KEY is required. Note the name: the staging key specifically, " +
        "not DEEPGRAM_API_KEY, so a production key cannot be picked up by accident.",
    );
  }
  return key.trim();
}

/**
 * Synthesize one turn and return the full report.
 *
 * Single-shot by design: one Speak, one Flush, read to Flushed. BYOM is a
 * diagnostic, not a conversational session, so it needs no barge-in — which is
 * why the missing Interrupt type (SDK_WATCH W-002) is not a blocker here.
 *
 * Returns `{ audio, wire, billable, inputCount, stripped, warnings, sampleRate }`.
 * `stripped` is `null` when the server reported no usable inventory, which is
 * distinct from `[]` (server affirmatively reported nothing stripped). The caller
 * needs that distinction to satisfy PRD §5.4's disagreement flag.
 */
export async function synthesize({
  text,
  voice,
  baseUrl,
  apiKey,
  sampleRate = 24000,
  timeoutMs = 20000,
  clientFactory,
}) {
  const validated = validateBaseUrl(baseUrl);

  // Injectable so the test suite can drive a mocked /v2/speak with no live key.
  const makeClient =
    clientFactory ||
    ((opts) => new DeepgramClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));

  const client = makeClient({ apiKey, baseUrl: validated });

  const socket = await client.speak.v2.createConnection({
    model: voice,
    encoding: "linear16",
    sample_rate: sampleRate,
  });

  const wire = [];
  const chunks = [];
  const warnings = [];
  let seq = 0;
  let billable = null;
  let inputCount = null;
  let stripped = null;
  let negotiatedRate = sampleRate;

  return await new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error(`timed out after ${timeoutMs}ms waiting for Flushed`));
    }, timeoutMs);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Closing a socket that is already gone is not an error worth surfacing.
      }
      if (err) reject(err);
      else
        resolve({
          audio: Buffer.concat(chunks),
          wire,
          billable,
          inputCount,
          stripped,
          warnings,
          sampleRate: negotiatedRate,
        });
    }

    socket.on("open", () => {
      // Recorded in the wire log as sent, so the log reads as a complete
      // protocol transcript rather than only the inbound half.
      const speak = { type: "Speak", text };
      wire.push(logEntry(seq++, "send", speak));
      socket.sendSpeak({ text });

      const flush = { type: "Flush" };
      wire.push(logEntry(seq++, "send", flush));
      socket.sendFlush({});
    });

    socket.on("message", (message) => {
      // Binary → audio. The SDK's wrapper is what makes this reliable; the
      // autogenerated socket parsed everything as JSON.
      if (message instanceof ArrayBuffer || Buffer.isBuffer(message) || message instanceof Uint8Array) {
        const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
        chunks.push(buf);
        wire.push(logEntry(seq++, "recv", null, { binary: true, bytes: buf.length }));
        return;
      }

      let frame = message;
      if (typeof message === "string") {
        try {
          frame = JSON.parse(message);
        } catch {
          wire.push(logEntry(seq++, "recv", { type: "unparseable", raw: message }));
          return;
        }
      }

      wire.push(logEntry(seq++, "recv", frame));

      switch (frame && frame.type) {
        case "SessionMetadata": {
          if (Number.isInteger(frame.sample_rate)) negotiatedRate = frame.sample_rate;
          break;
        }
        case "SpeechMetadata": {
          const b = readBillable(frame);
          if (b !== null) billable = b;
          const i = readInputCount(frame);
          if (i !== null) inputCount = i;
          break;
        }
        case "Warning": {
          warnings.push({ code: frame.code, description: frame.description });
          // SDK_WATCH W-001: `stripped[]` is not on the SDK's Warning type, so it
          // is read off the raw frame here.
          if (isMarkupStripped(frame)) {
            const s = readStripped(frame);
            if (s !== null) stripped = s;
          }
          break;
        }
        case "Flushed":
          finish(null);
          break;
        case "Error":
          finish(new Error(frame.description || frame.message || "server returned Error frame"));
          break;
        default:
          break;
      }
    });

    socket.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));

    socket.on("close", () => {
      // A close before Flushed means we never got a complete turn. Resolving with
      // partial audio would produce a receipt that looks authoritative and isn't.
      if (!settled) finish(new Error("connection closed before Flushed"));
    });

    socket.connect();
  });
}
