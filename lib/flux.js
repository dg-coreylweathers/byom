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
import { DEFAULT_ENCODING } from "./wav.js";
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
  timeoutMs = 60000,
  // How long audio may be silent before we call the turn unterminated.
  idleMs = 3000,
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
    // Shared with lib/wav.js so the requested encoding and the WAV header the
    // container declares cannot drift apart.
    encoding: DEFAULT_ENCODING,
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
  let lastAudioAt = 0;

  return await new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      finish(
        new Error(
          `timed out after ${timeoutMs}ms waiting for SpeechMetadata` +
            (chunks.length > 0 ? ` (${chunks.length} audio frame(s) received)` : " (no audio received)"),
        ),
      );
    }, timeoutMs);

    // Idle watchdog. If audio arrives and then stops without a SpeechMetadata
    // frame, that is a distinct failure from "nothing happened" and deserves a
    // distinct message — it means the turn produced output but was never closed
    // out. Blanket timeouts hide that difference, and it is exactly the shape of a
    // runaway synthesis.
    const idleTimer = setInterval(() => {
      if (settled || chunks.length === 0) return;
      if (Date.now() - lastAudioAt < idleMs) return;

      // Audio arrived and then stopped, with no SpeechMetadata to close the turn.
      //
      // RESOLVE rather than reject. PRD §5.4 requires the receipt to read
      // `billable_character_count` and to "say explicitly when it cannot" — so the
      // absence of that frame is a reportable condition, not a failure. Rejecting
      // would throw away real audio and a usable local projection, and would leave
      // the developer with nothing to look at.
      //
      // The condition is surfaced as a warning so the UI states it plainly instead
      // of quietly presenting a locally-computed figure as though it were reported.
      warnings.push({
        code: "TURN_NOT_TERMINATED",
        description:
          `Audio stopped for ${idleMs}ms with no SpeechMetadata frame. ` +
          `${chunks.length} audio frame(s) received. The billable count below is computed ` +
          "locally because the server never reported one for this turn.",
      });
      finish(null);
    }, 500);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(idleTimer);
      try {
        socket.close();
      } catch {
        // Closing a socket that is already gone is not an error worth surfacing.
      }
      if (err) {
        reject(err);
        return;
      }
      // An empty-audio turn must fail loudly rather than produce a header-only WAV
      // alongside a receipt that looks complete. This is not hypothetical: the Blob
      // misclassification bug (SDK_WATCH W-004) produced exactly that — a 200
      // response, correct character accounting, and 44 bytes of audio. A silent
      // empty result is worse than an error here, because the whole claim of this
      // tool is that its output is real.
      if (chunks.length === 0) {
        reject(
          new Error(
            "the turn completed but no audio frames arrived — refusing to return a header-only file",
          ),
        );
        return;
      }

      // Frames were collected in arrival order and are converted only now, so
      // Blob's async extraction cannot reorder the audio.
      Promise.all(chunks.map(toBuffer))
        .then((buffers) => {
          const audio = Buffer.concat(buffers);
          if (audio.length === 0) {
            throw new Error("audio frames arrived but decoded to zero bytes");
          }
          return audio;
        })
        .then((audio) =>
          resolve({
            audio,
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
        lastAudioAt = Date.now();
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
          // This is the turn terminator. Verified against staging: it arrives
          // after the final audio frame and its `audio_duration_ms` matches the
          // audio actually delivered.
          finish(null);
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
        // `Flushed` is an ACKNOWLEDGEMENT of the flush request, not a completion
        // signal. Verified against staging: Flushed arrives ~2ms after Flush is
        // sent and ~4s before the audio finishes streaming. Treating it as the
        // terminator closes the socket before any audio arrives, which reads as
        // "no audio frames arrived" — a confusing symptom for a correct server.
        //
        // The real terminator is `SpeechMetadata`, which arrives after the last
        // audio frame for the turn and carries the billable count. See the
        // SpeechMetadata case below.
        case "Flushed":
          break;
        case "Error":
          finish(
            new Error(
              `server returned Error${frame.code ? ` ${frame.code}` : ""}: ` +
                (frame.description || frame.message || "no description"),
            ),
          );
          break;
        default:
          break;
      }
    });

    socket.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));

    socket.on("close", () => {
      if (settled) return;

      // The turn ended without a terminator. Say what actually happened rather
      // than naming a frame — an earlier version of this message said "closed
      // before Flushed", which was wrong twice over: Flushed is only an
      // acknowledgement, and naming it sent anyone debugging this looking at the
      // wrong frame.
      //
      // Audio-received is the useful split. No audio means the connection never
      // produced anything (auth, routing, an upstream refusal). Audio-then-close
      // means synthesis started and was cut off, which is a server-side fault and
      // is worth reporting differently.
      if (chunks.length === 0) {
        finish(
          new Error(
            "the connection closed before any audio or SpeechMetadata arrived — " +
              `${wire.length} frame(s) were received. Check the wire log for the last frame before the close.`,
          ),
        );
        return;
      }

      const seconds = (chunks.length * 3840) / 2 / (negotiatedRate || 24000);
      finish(
        new Error(
          `the connection closed mid-turn after ${chunks.length} audio frame(s) ` +
            `(roughly ${seconds.toFixed(1)}s of audio) with no SpeechMetadata — the turn was cut off ` +
            "server-side. Partial audio is not returned, because a receipt built on it would look complete.",
        ),
      );
    });

    socket.connect();
  });
}
