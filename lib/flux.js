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
import {
  isMarkupStripped,
  readStripped,
  readBillable,
  readInputCount,
  readImplementation,
  logEntry,
} from "./frames.js";

/** Hosts we refuse to talk to regardless of configuration. */
const PRODUCTION_HOSTS = new Set(["api.deepgram.com", "agent.deepgram.com"]);

/**
 * Is this message an audio frame rather than a control frame?
 *
 * Under Node the SDK delivers binary audio as a **Blob** — `setupBinaryHandling`
 * passes `event.data` through untouched, and the underlying socket's binaryType
 * yields Blob. That is not obvious from the typed surface, and it bites in a quiet
 * way: `Blob.type` is the empty string, so a naive `typeof msg.type === "string"`
 * check classifies audio as a control frame, the PCM is silently dropped, and you
 * get a complete-looking report containing a header-only WAV.
 *
 * The other shapes are accepted because a different runtime or a real host may
 * deliver Buffer/ArrayBuffer/typed-array instead, and guessing wrong here loses
 * audio rather than erroring. SDK_WATCH W-004.
 */
function isBinaryFrame(message) {
  if (message === null || typeof message !== "object") return false;
  if (typeof Blob !== "undefined" && message instanceof Blob) return true;
  if (Buffer.isBuffer(message)) return true;
  if (message instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(message)) return true;
  return false;
}

/** Byte length available synchronously, so the wire log needs no await. */
function byteLengthOf(message) {
  if (typeof Blob !== "undefined" && message instanceof Blob) return message.size;
  if (Buffer.isBuffer(message) || ArrayBuffer.isView(message)) return message.byteLength;
  if (message instanceof ArrayBuffer) return message.byteLength;
  return 0;
}

/** Normalize any accepted binary shape to a Buffer. Async only because Blob is. */
async function toBuffer(message) {
  if (typeof Blob !== "undefined" && message instanceof Blob) {
    return Buffer.from(await message.arrayBuffer());
  }
  if (Buffer.isBuffer(message)) return message;
  if (ArrayBuffer.isView(message)) {
    return Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  }
  return Buffer.from(message);
}

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
  let implementation = null;

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
      if (err) {
        reject(err);
        return;
      }
      // Frames were collected in arrival order and are converted only now, so
      // Blob's async extraction cannot reorder the audio.
      Promise.all(chunks.map(toBuffer))
        .then((buffers) =>
          resolve({
            audio: Buffer.concat(buffers),
            wire,
            billable,
            inputCount,
            stripped,
            warnings,
            sampleRate: negotiatedRate,
            implementation,
          }),
        )
        .catch(reject);
    }

    socket.on("open", () => {
      // `type` must be supplied by the caller. `sendSpeak`/`sendFlush` pass the
      // payload straight to `sendJson` without injecting the discriminator, and
      // it is a required field of SpeakV2Speak/SpeakV2Flush. TypeScript enforces
      // that; plain JS does not, and omitting it fails in a genuinely nasty way —
      // the socket opens, frames are accepted, and the server answers with
      // "unhandled message type" warnings instead of synthesizing. No error, just
      // a turn that never completes.
      //
      // The same object is logged and sent, so the wire log cannot drift from what
      // actually went out.
      const speak = { type: "Speak", text };
      wire.push(logEntry(seq++, "send", speak));
      socket.sendSpeak(speak);

      const flush = { type: "Flush" };
      wire.push(logEntry(seq++, "send", flush));
      socket.sendFlush(flush);
    });

    socket.on("message", (message) => {
      // Binary → audio. Checked BEFORE any control-frame handling, because a Blob
      // would otherwise be misread as a control frame with an empty `type`.
      // Stored unconverted to preserve arrival order; converted in finish().
      if (isBinaryFrame(message)) {
        chunks.push(message);
        wire.push(logEntry(seq++, "recv", null, { binary: true, bytes: byteLengthOf(message) }));
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
          implementation = readImplementation(frame);
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
