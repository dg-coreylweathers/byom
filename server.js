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

/**
 * Loadable samples.
 *
 * Labelled by WHAT MARKUP THEY CONTAIN, never by what the server will do with
 * them. Two reasons that distinction matters:
 *
 * 1. The tool's entire job is to show what actually happens. Baking an expected
 *    outcome into the UI would mean asserting behavior instead of measuring it —
 *    and if the two ever disagreed, the label would be the thing people believed.
 * 2. Outcomes are environment- and version-specific. A label that says "this one
 *    fails" goes stale the moment it is fixed, and then the tool is lying.
 *
 * Measured outcomes live in SAMPLES.md, dated and attributed to an environment.
 *
 * Every sample honours PRD §5.3's content constraints — no plural of
 * "interruption", no letter-by-letter spelling — and is asserted so by test.
 */
export const SAMPLES = [
  {
    label: "Plain text",
    note: "No markup. The control case — run this first.",
    text: "Your transfer went through. Your balance is forty-two dollars.",
  },
  {
    label: "Sentence tags + pause",
    note: "The 87-character example. Structural tags and a timed pause.",
    text: DEFAULT_PRESET,
  },
  {
    label: "Speaking rate",
    note: "Rate markup. Compare against the `speed` request parameter, which accepts 0.85–1.15.",
    text: '<prosody rate="slow">Your balance is forty-two dollars.</prosody>',
  },
  {
    label: "Emphasis",
    note: "Emphasis on a single word.",
    text: "Your balance is <emphasis>forty-two</emphasis> dollars.",
  },
  {
    label: "Spoken-form substitution",
    note: "An alias for how a written form should be read aloud.",
    text: 'Weight is <sub alias="ten kilograms">10 kg</sub> total.',
  },
  {
    label: "Pronunciation override",
    note: "Phoneme markup using IPA.",
    text: 'Say <phoneme alphabet="ipa" ph="dip">Deepgram</phoneme> now.',
  },
  {
    label: "Inline control (JSON)",
    note: "The escaped-JSON inline control form, rather than XML-style tags.",
    text: '{"speed": "0.9"} Your balance is forty-two dollars.',
  },
  {
    label: "A realistic mixed prompt",
    note: "Closer to what actually sits in a template: several kinds at once.",
    text:
      '<speak><p>Thanks for calling.</p><break time="500ms"/>' +
      '<prosody rate="slow">Your balance is forty-two dollars.</prosody></speak>',
  },
];

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
      //
      // A reference upstream self-identifies in SessionMetadata. When it does, the
      // frames are protocol-real but the numbers are not API-reported, so they are
      // labelled `reference` — never `api`. Same principle PRD §3 applies to the
      // batch fallback: a figure that did not come from the API is marked, not
      // quietly displayed.
      const upstreamOrigin = result.implementation ? "reference" : "api";
      const billed =
        result.billable !== null
          ? {
              value: result.billable,
              origin: upstreamOrigin,
              note: result.implementation
                ? `Reported by ${result.implementation}, not by the API. Protocol-accurate; not a real synthesis.`
                : null,
            }
          : {
              value: mirror.billed,
              origin: "local",
              note: "SpeechMetadata.billable_character_count was not received; this figure is computed locally.",
            };

      const serverStripped = result.stripped;
      // When the mirror found nothing either, the missing Warning frame is the
      // server confirming nothing was stripped — not a gap we had to paper over.
      const nothingToStrip = serverStripped === null && mirror.stripped.length === 0;
      const inventory =
        serverStripped !== null || nothingToStrip
          ? { entries: serverStripped ?? [], origin: upstreamOrigin }
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
        // Non-null means the report came from a reference upstream. The UI renders
        // a persistent banner from this; it is never omitted or made dismissible.
        upstream: result.implementation,
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
          samples: SAMPLES,
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

      if (url.pathname === "/api/health" && req.method === "GET") {
        // Deploy health check. Reports which host it is pointed at by SHAPE, never
        // the value — a health endpoint is unauthenticated, so it must not become a
        // way to read configuration.
        return json(res, 200, {
          ok: true,
          upstreamConfigured: true,
          staging: true,
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
    // No Warning frame arrived. That is only a disagreement if the mirror expected
    // one: when the text contained no markup there is nothing to warn about, and
    // the absence of a warning IS the server agreeing that nothing was stripped.
    // Treating silence as a failure here produced a spurious flag on clean text.
    if (mirror.stripped.length > 0) {
      notes.push(
        "The server did not report a stripped inventory, so the list below is the local mirror's.",
      );
    }
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

  // No staging endpoint exists yet (FLAGS.md F-001). Rather than deploy something
  // that cannot complete a request, the bundled reference upstream can run
  // in-process on loopback. It is opt-in, it binds only to 127.0.0.1, and every
  // figure it produces is labelled reference-reported rather than API-reported —
  // both in the payload and in the UI. Set BYOM_REFERENCE_UPSTREAM=0 the moment a
  // real endpoint is available; nothing else needs to change.
  if (process.env.BYOM_REFERENCE_UPSTREAM === "1") {
    if (process.env.DEEPGRAM_BASE_URL) {
      // Refuse to silently override an explicitly configured endpoint. If both are
      // set, the operator's intent is ambiguous and guessing wrong could mean
      // serving reference numbers while looking like a real deployment.
      console.error(
        "both BYOM_REFERENCE_UPSTREAM=1 and DEEPGRAM_BASE_URL are set. " +
          "Unset one — refusing to guess which upstream you meant.",
      );
      process.exit(1);
    }
    const { createUpstream } = await import("./tools/reference-upstream.js");
    const upstreamPort = Number.parseInt(process.env.UPSTREAM_PORT || "8081", 10);
    await new Promise((resolve) => createUpstream().listen(upstreamPort, "127.0.0.1", resolve));
    process.env.DEEPGRAM_BASE_URL = `ws://127.0.0.1:${upstreamPort}`;
    console.log(`reference upstream on 127.0.0.1:${upstreamPort} — figures will be labelled reference-reported`);
  }

  const { server } = createApp();
  server.listen(port, () => {
    // Host is logged so an operator can confirm at a glance which environment this
    // process is pointed at. Never logs the key.
    console.log(`byom listening on :${port} → ${process.env.DEEPGRAM_BASE_URL}`);
  });
}
