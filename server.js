/**
 * BYOM server.
 *
 * Holds the API key (PRD §5.2 — never sent to the client), rate limits, caps
 * input length, and returns the report the browser renders.
 *
 * Submitted text is held in memory for the life of the request only (PRD §5.4).
 * It is never logged and never persisted. The log lines below deliberately record
 * outcomes and byte counts, never content — that constraint is also what rules
 * out the deliberately-cut aggregate tag counter (PRD §3), which would require
 * retaining user text.
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyze } from "./public/markup.js";
import { synthesize, validateBaseUrl, apiKeyFromEnv } from "./lib/flux.js";
import { resolveVoice, ALLOWED, DEFAULT_VOICE } from "./lib/voices.js";
import { Limiter, configFromEnv, clientId } from "./lib/ratelimit.js";
import { process as processAudio } from "./lib/wav.js";
import { serveStatic } from "./lib/static.js";
import { safeErrorMessage } from "./lib/redact.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");

/** PRD §5.3: keep any stretch under five minutes → cap input at 900 characters. */
export const MAX_INPUT_CHARS = 900;

/** PRD §5.4 default preset. Arithmetically correct: 87 submitted, 62 billed, 25 stripped. */
export const DEFAULT_PRESET =
  '<s>Your transfer went through. Your balance is forty-two dollars.</s><break time="1s"/>';

const MAX_BODY_BYTES = 8 * 1024;

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("request body too large");
      err.code = "BODY_TOO_LARGE";
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createApp({ env = process.env, now = () => Date.now(), clientFactory } = {}) {
  // Fail closed at startup. A missing base URL would otherwise let the SDK
  // resolve to production silently — see lib/flux.js and DECISIONS.md D-002.
  const baseUrl = validateBaseUrl(env.DEEPGRAM_BASE_URL);
  const apiKey = apiKeyFromEnv(env);
  const limiterConfig = configFromEnv(env);
  const limiter = new Limiter(limiterConfig, now);

  async function handleSpeak(req, res) {
    const id = clientId(req, limiterConfig.trustedProxyHops);

    // ── Ordering matters and is required ──────────────────────────────────────
    // PRD §5.4: "Rejected requests do not consume a rate-limit slot."
    // So: check the limit WITHOUT consuming, validate the request fully, and only
    // then spend a slot. A developer whose paste is malformed or over-length must
    // not burn their own quota discovering that.
    const gate = limiter.check(id);
    if (!gate.ok) {
      return json(res, 429, { error: gate.reason }, { "retry-after": String(gate.retryAfterSec) });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err.code === "BODY_TOO_LARGE") return json(res, 413, { error: "request body too large" });
      return json(res, 400, { error: "could not read request body" });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "body must be JSON" });
    }

    const text = payload && typeof payload.text === "string" ? payload.text : null;
    if (text === null) return json(res, 400, { error: "text is required and must be a string" });
    if (text.trim() === "") return json(res, 400, { error: "text is empty" });
    if (text.length > MAX_INPUT_CHARS) {
      return json(res, 400, {
        error: `text exceeds the ${MAX_INPUT_CHARS}-character cap`,
        submitted: text.length,
        cap: MAX_INPUT_CHARS,
      });
    }

    const voiceResult = resolveVoice(payload.voice);
    if (!voiceResult.ok) return json(res, 400, { error: voiceResult.error });

    // Request is valid. NOW spend the slot.
    limiter.consume(id);
    limiter.acquire();

    // The mirror runs server-side too, so the response can carry both numbers and
    // the UI can show a disagreement rather than pick a winner.
    const mirror = analyze(text);

    try {
      const result = await synthesize({
        text,
        voice: voiceResult.voice,
        baseUrl,
        apiKey,
        clientFactory,
      });

      const audio = processAudio(result.audio, result.sampleRate);

      // Which number came from where. PRD §5.2/§5.4: the receipt reads from
      // SpeechMetadata.billable_character_count and says explicitly when it
      // cannot. `origin` is what the UI renders that disclosure from.
      const billed =
        result.billable !== null
          ? { value: result.billable, origin: "api", note: null }
          : {
              value: mirror.billed,
              origin: "local",
              note: "SpeechMetadata.billable_character_count was not received; this figure is computed locally.",
            };

      const serverStripped = result.stripped;
      const inventory =
        serverStripped !== null
          ? { entries: serverStripped, origin: "api" }
          : {
              entries: mirror.stripped.map((s) => ({
                raw: s.raw,
                source: s.source,
                replacement: s.advice,
              })),
              origin: "local",
            };

      const disagreement = describeDisagreement(mirror, serverStripped, result.billable);

      return json(res, 200, {
        submitted: { value: text.length, origin: "local" },
        billed,
        inputCount: result.inputCount,
        stripped: inventory,
        // Advice is attached from the mirror's verified table, and is null where
        // no equivalent exists (PRD §5.4). Never invented.
        advice: mirror.stripped.map((s) => ({
          raw: s.raw,
          label: s.label,
          advice: s.advice,
          hasEquivalent: s.advice !== null,
        })),
        disagreement,
        audio: {
          wav: audio.wav.toString("base64"),
          envelope: audio.envelope,
          durationMs: Math.round(audio.durationMs),
          sampleRate: audio.sampleRate,
          trim: audio.trim,
          peak: {
            dbfs: Number.isFinite(audio.peak.peakDbfs) ? Number(audio.peak.peakDbfs.toFixed(2)) : null,
            needsNormalize: audio.peak.needsNormalize,
          },
        },
        warnings: result.warnings,
        wire: result.wire,
        voice: voiceResult.voice,
      });
    } catch (err) {
      // The message may describe a transport failure, and an upstream failure can
      // legitimately carry the credential (an auth error echoing the token, a URL
      // with the key in a query param). Scrubbed before it crosses the boundary —
      // a test caught this leaking verbatim. See lib/redact.js.
      return json(res, 502, { error: `synthesis failed: ${safeErrorMessage(err, [apiKey])}` });
    } finally {
      limiter.release();
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/api/speak" && req.method === "POST") {
        return await handleSpeak(req, res);
      }

      if (url.pathname === "/api/config" && req.method === "GET") {
        // PRD §5.4: the key must be absent from every response and from
        // /api/config specifically. Nothing key-derived is included — not the
        // value, not a prefix, not a length, not a hash.
        return json(res, 200, {
          voices: ALLOWED,
          defaultVoice: DEFAULT_VOICE,
          preset: DEFAULT_PRESET,
          maxInputChars: MAX_INPUT_CHARS,
          limits: {
            globalPerMinute: limiterConfig.globalPerMinute,
            globalPerDay: limiterConfig.globalPerDay,
            perIpPerMinute: limiterConfig.perIpPerMinute,
            maxConcurrent: limiterConfig.maxConcurrent,
          },
          usage: limiter.snapshot(),
        });
      }

      if (req.method !== "GET") {
        return json(res, 405, { error: "method not allowed" });
      }

      return await serveStatic(PUBLIC_DIR, url.pathname, res);
    } catch {
      return json(res, 500, { error: "internal error" });
    }
  });

  return { server, limiter, config: limiterConfig };
}

/**
 * Describe any mirror/server disagreement in words the UI can render directly.
 * PRD §5.2: show the disagreement, don't hide it. Returns null when they agree.
 */
export function describeDisagreement(mirror, serverStripped, serverBillable) {
  const notes = [];

  if (serverStripped === null) {
    notes.push(
      "The server did not report a stripped inventory, so the list below is the local mirror's.",
    );
  } else {
    if (serverStripped.length !== mirror.stripped.length) {
      notes.push(
        `The local mirror found ${mirror.stripped.length} markup span(s); the server reported ${serverStripped.length}.`,
      );
    } else {
      for (let i = 0; i < serverStripped.length; i += 1) {
        if (serverStripped[i].raw !== mirror.stripped[i].raw) {
          notes.push(`Span ${i + 1} differs between the local mirror and the server.`);
          break;
        }
      }
    }
  }

  if (serverBillable !== null && serverBillable !== mirror.billed) {
    notes.push(
      `The local mirror projected ${mirror.billed} billable characters; the server reported ${serverBillable}. The server is authoritative.`,
    );
  }

  return notes.length === 0 ? null : notes;
}

// Started directly, not imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  const { server } = createApp();
  server.listen(port, () => {
    // Host is logged so an operator can confirm at a glance which environment
    // this process is pointed at. Never logs the key.
    console.log(`byom listening on :${port} → ${process.env.DEEPGRAM_BASE_URL}`);
  });
}
