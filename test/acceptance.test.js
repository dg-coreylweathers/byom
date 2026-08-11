/**
 * PRD §5.4 acceptance criteria, one test per checkbox, plus the build's hard
 * constraints. Runs entirely against a mocked /v2/speak — no live key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp, MAX_INPUT_CHARS, DEFAULT_PRESET, describeDisagreement } from "../server.js";
import { analyze } from "../public/markup.js";
import { resolveVoice, DEFAULT_VOICE, ALLOWED, EXCLUDED } from "../lib/voices.js";
import { validateBaseUrl } from "../lib/flux.js";
import { resolveSafe } from "../lib/static.js";
import { redact } from "../lib/redact.js";
import { Limiter, configFromEnv, clientId } from "../lib/ratelimit.js";
import { trimLeadingSilence, measurePeak, toWav, PRE_ROLL_MS } from "../lib/wav.js";
import { mockClientFactory, defaultFrames, makePcm } from "./mock-speak.js";

const STAGING = "wss://api.staging.example.internal";
const FAKE_KEY = "mock-key-not-a-real-credential";

const BASE_ENV = {
  DEEPGRAM_BASE_URL: STAGING,
  DEEPGRAM_STAGING_API_KEY: FAKE_KEY,
};

/** Boot the app on an ephemeral port and return a fetch helper. */
async function withServer(t, { env = {}, clientFactory, now } = {}) {
  const app = createApp({
    env: { ...BASE_ENV, ...env },
    clientFactory: clientFactory || mockClientFactory(),
    now,
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  return {
    app,
    port,
    async post(path, body) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { res, text, body: parsed };
    },
    async get(path) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { res, text, body: parsed };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// HARD CONSTRAINT: the API key never leaves the server.
// Verified in the test suite, not just review.
// ───────────────────────────────────────────────────────────────────────────────

test("the API key is absent from /api/config", async (t) => {
  const c = await withServer(t);
  const { text, body } = await c.get("/api/config");
  assert.ok(!text.includes(FAKE_KEY), "key leaked into /api/config");
  // Nothing key-derived either — no prefix, no length, no hash.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(FAKE_KEY.slice(0, 8)), "key prefix leaked");
  assert.ok(!/apiKey|api_key|authorization|secret|token/i.test(serialized), "config names a credential field");
});

test("the API key is absent from a successful /api/speak response", async (t) => {
  const c = await withServer(t);
  const { text } = await c.post("/api/speak", { text: DEFAULT_PRESET });
  assert.ok(!text.includes(FAKE_KEY), "key leaked into speak response");
});

test("the API key is absent from error responses", async (t) => {
  const c = await withServer(t, {
    clientFactory: () => {
      throw new Error(`upstream refused with key ${FAKE_KEY}`);
    },
  });
  const { res, text } = await c.post("/api/speak", { text: "hello" });
  assert.equal(res.status, 502);
  assert.ok(!text.includes(FAKE_KEY), "key leaked through an error message");
});

test("redaction scrubs the exact key even when it is not credential-shaped", () => {
  const plain = "short-plain-key";
  assert.equal(redact(`failed with ${plain} at host`, [plain]), "failed with [redacted] at host");
});

test("redaction scrubs credential-shaped values it was never given", () => {
  // An upstream error can carry a request-scoped token the server never held.
  assert.match(redact("Bearer abcdef1234567890 rejected"), /\[redacted\] rejected/);
  assert.match(redact("connect wss://h/v2/speak?key=abcdef1234567890 failed"), /\?key=\[redacted\]/);
});

test("a secret containing regex metacharacters is handled literally", () => {
  const nasty = "a.b*c+d(e)";
  assert.equal(redact(`key ${nasty} bad`, [nasty]), "key [redacted] bad");
});

test("the key is passed to the SDK but never rendered into the report", async (t) => {
  let seenKey = null;
  const c = await withServer(t, {
    clientFactory: mockClientFactory({ onConnect: ({ apiKey }) => (seenKey = apiKey) }),
  });
  const { text } = await c.post("/api/speak", { text: DEFAULT_PRESET });
  assert.equal(seenKey, FAKE_KEY, "server should authenticate with the staging key");
  assert.ok(!text.includes(FAKE_KEY), "and must not echo it");
});

// ───────────────────────────────────────────────────────────────────────────────
// HARD CONSTRAINT: staging only, never production.
// ───────────────────────────────────────────────────────────────────────────────

test("a production host is rejected outright", () => {
  assert.throws(() => validateBaseUrl("wss://api.deepgram.com"), /production host/);
  assert.throws(() => validateBaseUrl("wss://agent.deepgram.com"), /production host/);
});

test("a missing base URL fails closed rather than defaulting", () => {
  // The SDK would otherwise silently resolve to wss://api.deepgram.com.
  assert.throws(() => validateBaseUrl(undefined), /required and has no default/);
  assert.throws(() => validateBaseUrl(""), /required and has no default/);
  assert.throws(() => validateBaseUrl("   "), /required and has no default/);
});

test("the server refuses to start without a base URL", () => {
  assert.throws(
    () => createApp({ env: { DEEPGRAM_STAGING_API_KEY: FAKE_KEY } }),
    /DEEPGRAM_BASE_URL is required/,
  );
});

test("the server requires the staging key by name, not a generic one", () => {
  assert.throws(
    () => createApp({ env: { DEEPGRAM_BASE_URL: STAGING, DEEPGRAM_API_KEY: FAKE_KEY } }),
    /DEEPGRAM_STAGING_API_KEY is required/,
  );
});

test("the configured staging URL is what reaches the SDK", async (t) => {
  let seenBase = null;
  const c = await withServer(t, {
    clientFactory: mockClientFactory({ onConnect: ({ baseUrl }) => (seenBase = baseUrl) }),
  });
  await c.post("/api/speak", { text: DEFAULT_PRESET });
  assert.equal(seenBase, STAGING);
});

// ───────────────────────────────────────────────────────────────────────────────
// Receipt: billable count and its provenance.
// ───────────────────────────────────────────────────────────────────────────────

test("the receipt reads billable_character_count from SpeechMetadata", async (t) => {
  const c = await withServer(t);
  const { body } = await c.post("/api/speak", { text: DEFAULT_PRESET });
  assert.equal(body.billed.origin, "api");
  assert.equal(body.billed.value, 62);
  assert.equal(body.submitted.value, 87);
  assert.equal(body.billed.note, null);
});

test("the receipt says explicitly when it cannot read the API's number", async (t) => {
  // Same sequence, minus SpeechMetadata.
  const frames = defaultFrames({ pcm: makePcm() }).filter((f) => Buffer.isBuffer(f) || f.type !== "SpeechMetadata");
  const c = await withServer(t, { clientFactory: mockClientFactory({ frames }) });
  const { body } = await c.post("/api/speak", { text: DEFAULT_PRESET });

  assert.equal(body.billed.origin, "local");
  assert.match(body.billed.note, /computed locally/);
  // Still reports a usable figure rather than nothing.
  assert.equal(body.billed.value, 62);
});

test("the default preset's arithmetic is correct — 87 in, 62 billed, 25 stripped", () => {
  const a = analyze(DEFAULT_PRESET);
  assert.equal(a.submitted, 87);
  assert.equal(a.billed, 62);
  assert.equal(a.submitted - a.billed, 25);
  // The delta must equal the sum of the stripped spans, which is precisely what
  // the spec's own example gets wrong (FLAGS.md F-006).
  const sum = a.stripped.reduce((n, s) => n + s.raw.length, 0);
  assert.equal(sum, 25);
});

test("the preset honours the launch content constraints", () => {
  // PRD §5.3: no preset may contain the plural of "interruption", and none may
  // spell letter-by-letter.
  assert.ok(!/interruptions/i.test(DEFAULT_PRESET));
  assert.ok(!/\b([A-Za-z])[-\s]([A-Za-z])[-\s]([A-Za-z])\b/.test(DEFAULT_PRESET));
});

// ───────────────────────────────────────────────────────────────────────────────
// Stripped inventory, fallback, and visible disagreement.
// ───────────────────────────────────────────────────────────────────────────────

test("the stripped inventory reads from the API's stripped[] array", async (t) => {
  const c = await withServer(t);
  const { body } = await c.post("/api/speak", { text: DEFAULT_PRESET });
  assert.equal(body.stripped.origin, "api");
  assert.deepEqual(
    body.stripped.entries.map((e) => e.raw),
    ["<s>", "</s>", '<break time="1s"/>'],
  );
  assert.equal(body.disagreement, null);
});

test("it falls back to the local mirror with a visible disagreement flag", async (t) => {
  const frames = defaultFrames({ pcm: makePcm() }).map((f) =>
    !Buffer.isBuffer(f) && f.type === "Warning" ? { type: "Warning", code: "INPUT_MARKUP_STRIPPED", description: "stripped" } : f,
  );
  const c = await withServer(t, { clientFactory: mockClientFactory({ frames }) });
  const { body } = await c.post("/api/speak", { text: DEFAULT_PRESET });

  assert.equal(body.stripped.origin, "local");
  assert.ok(Array.isArray(body.disagreement), "disagreement must be surfaced, not hidden");
  assert.match(body.disagreement.join(" "), /did not report a stripped inventory/);
});

test("a count mismatch between mirror and server is surfaced", () => {
  const mirror = analyze(DEFAULT_PRESET);
  const notes = describeDisagreement(mirror, [{ raw: "<s>", source: "ssml" }], 62);
  assert.ok(notes);
  assert.match(notes.join(" "), /found 3 markup span\(s\); the server reported 1/);
});

test("a billable mismatch names the server as authoritative", () => {
  const mirror = analyze(DEFAULT_PRESET);
  const notes = describeDisagreement(mirror, null, 55);
  assert.match(notes.join(" "), /projected 62 .*server reported 55.*server is authoritative/s);
});

// ───────────────────────────────────────────────────────────────────────────────
// Advice: only where verified.
// ───────────────────────────────────────────────────────────────────────────────

test('advice is null where no equivalent exists, rather than invented', async (t) => {
  const c = await withServer(t);
  const { body } = await c.post("/api/speak", { text: DEFAULT_PRESET });

  const brk = body.advice.find((a) => a.raw.startsWith("<break"));
  assert.ok(brk, "the break tag should appear in the advice list");
  // Pause controls are unavailable at Early Access, so there is no honest advice.
  assert.equal(brk.advice, null);
  assert.equal(brk.hasEquivalent, false);
});

test("advice is present where an equivalent is verified", () => {
  const a = analyze('<prosody rate="slow">hi</prosody>');
  const prosody = a.stripped.find((s) => s.name === "prosody");
  assert.ok(prosody.advice, "prosody rate maps to the speed parameter");
  assert.match(prosody.advice, /0\.85–1\.15/);
  // The breaking change matters: rejected, not clamped.
  assert.match(prosody.advice, /rejected, not clamped/);
});

// ───────────────────────────────────────────────────────────────────────────────
// HARD CONSTRAINT: no vendor names in UI chrome. `source` only in the log.
// ───────────────────────────────────────────────────────────────────────────────

test("the tag inventory carries no competitor names", () => {
  const banned = /\b(amazon|aws|polly|google|azure|microsoft|elevenlabs|eleven labs|openai|playht|play\.ht|resemble|murf|wellsaid|speechify|cartesia|rime|lmnt)\b/i;
  const serialized = JSON.stringify(analyze('<speak><break time="1s"/><prosody rate="slow">x</prosody></speak>'));
  assert.ok(!banned.test(serialized), "a competitor name reached the analysis payload");
});

test("the wire log is where source lives, and it is present there", async (t) => {
  const c = await withServer(t);
  const { body } = await c.post("/api/speak", { text: DEFAULT_PRESET });
  const warning = body.wire.find((e) => e.frame && e.frame.type === "Warning");
  assert.ok(warning, "the Warning frame must appear in the log");
  // PRD §3: naming formats/vendors in the raw payload and log is fine.
  assert.equal(warning.frame.stripped[0].source, "ssml");
});

// ───────────────────────────────────────────────────────────────────────────────
// Wire log fidelity.
// ───────────────────────────────────────────────────────────────────────────────

test("the wire log shows frames verbatim in protocol order", async (t) => {
  const c = await withServer(t);
  const { body } = await c.post("/api/speak", { text: DEFAULT_PRESET });

  const seqs = body.wire.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq must be monotonic");

  const types = body.wire.map((e) => e.type);
  assert.deepEqual(types, [
    "Speak",
    "Flush",
    "Connected",
    "SessionMetadata",
    "Warning",
    "SpeechStarted",
    "audio",
    "SpeechMetadata",
    "Flushed",
  ]);

  // Outbound frames are recorded too, so the log is a complete transcript.
  assert.equal(body.wire[0].direction, "send");
  assert.equal(body.wire[2].direction, "recv");

  // Audio is recorded as a byte count, never as inlined payload in the log.
  const audio = body.wire.find((e) => e.binary);
  assert.ok(audio.bytes > 0);
  assert.equal(audio.frame, null);
});

test("an unrecognized frame still reaches the log", async (t) => {
  const frames = [
    { type: "Connected" },
    { type: "SomethingNew", detail: "from a future server" },
    makePcm({ leadingSilenceMs: 0, toneMs: 50 }),
    { type: "Flushed" },
  ];
  const c = await withServer(t, { clientFactory: mockClientFactory({ frames }) });
  const { body } = await c.post("/api/speak", { text: "hello" });

  const unknown = body.wire.find((e) => e.type === "SomethingNew");
  assert.ok(unknown, "the log records what arrived, not only what we understood");
  assert.equal(unknown.recognized, false);
  assert.equal(unknown.frame.detail, "from a future server");
});

// ───────────────────────────────────────────────────────────────────────────────
// Voices.
// ───────────────────────────────────────────────────────────────────────────────

test("the default voice is flux-rufus-en", () => {
  assert.equal(DEFAULT_VOICE, "flux-rufus-en");
  assert.equal(resolveVoice(undefined).voice, "flux-rufus-en");
});

test("flux-marcus-en is excluded from the list and rejected server-side", () => {
  assert.ok(!ALLOWED.includes("flux-marcus-en"));
  const r = resolveVoice("flux-marcus-en");
  assert.equal(r.ok, false);
  // The rejection explains itself — it was deliberate, not a typo.
  assert.match(r.error, /excluded: reported defects/);
});

test("marcus is rejected even on a hand-crafted request", async (t) => {
  const c = await withServer(t);
  const { res, body } = await c.post("/api/speak", { text: "hello", voice: "flux-marcus-en" });
  assert.equal(res.status, 400);
  assert.match(body.error, /excluded/);
});

test("marcus is absent from /api/config", async (t) => {
  const c = await withServer(t);
  const { body } = await c.get("/api/config");
  assert.ok(!body.voices.includes("flux-marcus-en"));
  assert.equal(body.defaultVoice, "flux-rufus-en");
});

test("an unknown voice is rejected with a different message than a defective one", () => {
  // Names from the WER guidance that do not exist in the shipping catalog — see
  // FLAGS.md F-004.
  for (const phantom of ["flux-meghan-en", "flux-conor-en", "flux-wes-en", "flux-brittany-en"]) {
    const r = resolveVoice(phantom);
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown voice/);
  }
  assert.ok(EXCLUDED.has("flux-marcus-en"));
});

// ───────────────────────────────────────────────────────────────────────────────
// Input cap, rate limiting, concurrency, traversal.
// ───────────────────────────────────────────────────────────────────────────────

test("input is capped at 900 characters", async (t) => {
  assert.equal(MAX_INPUT_CHARS, 900);
  const c = await withServer(t);
  const { res, body } = await c.post("/api/speak", { text: "x".repeat(901) });
  assert.equal(res.status, 400);
  assert.equal(body.cap, 900);
  assert.equal(body.submitted, 901);
});

test("REJECTED REQUESTS DO NOT CONSUME A RATE-LIMIT SLOT", async (t) => {
  const c = await withServer(t, { env: { PER_IP_PER_MINUTE: "2" } });

  // Five invalid requests of assorted kinds.
  await c.post("/api/speak", { text: "x".repeat(901) }); // over cap
  await c.post("/api/speak", { text: "" }); // empty
  await c.post("/api/speak", { nope: true }); // missing text
  await c.post("/api/speak", "not json"); // unparseable
  await c.post("/api/speak", { text: "hi", voice: "flux-marcus-en" }); // excluded voice

  // The per-IP budget of 2 must be fully intact.
  const first = await c.post("/api/speak", { text: DEFAULT_PRESET });
  const second = await c.post("/api/speak", { text: DEFAULT_PRESET });
  assert.equal(first.res.status, 200, "first valid request should succeed");
  assert.equal(second.res.status, 200, "second valid request should succeed");

  const third = await c.post("/api/speak", { text: DEFAULT_PRESET });
  assert.equal(third.res.status, 429, "third should now be limited");
});

test("rate limiting returns 429 with retry-after", async (t) => {
  const c = await withServer(t, { env: { PER_IP_PER_MINUTE: "1" } });
  await c.post("/api/speak", { text: DEFAULT_PRESET });
  const { res, body } = await c.post("/api/speak", { text: DEFAULT_PRESET });
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
  assert.match(body.error, /limit reached/);
});

test("limits are configurable via env, not hardcoded", () => {
  const cfg = configFromEnv({
    GLOBAL_PER_MINUTE: "77",
    GLOBAL_PER_DAY: "888",
    PER_IP_PER_MINUTE: "9",
    MAX_CONCURRENT: "4",
    TRUSTED_PROXY_HOPS: "1",
  });
  assert.equal(cfg.globalPerMinute, 77);
  assert.equal(cfg.globalPerDay, 888);
  assert.equal(cfg.perIpPerMinute, 9);
  assert.equal(cfg.maxConcurrent, 4);
  assert.equal(cfg.trustedProxyHops, 1);
});

test("a malformed limit value is rejected rather than silently defaulted", () => {
  assert.throws(() => configFromEnv({ GLOBAL_PER_MINUTE: "lots" }), /non-negative integer/);
  assert.throws(() => configFromEnv({ GLOBAL_PER_DAY: "-5" }), /non-negative integer/);
});

test("the global per-minute cap is enforced", () => {
  let t0 = 1_000_000;
  const lim = new Limiter(configFromEnv({ GLOBAL_PER_MINUTE: "2", PER_IP_PER_MINUTE: "99" }), () => t0);
  assert.equal(lim.check("a").ok, true);
  lim.consume("a");
  lim.consume("b");
  assert.equal(lim.check("c").ok, false);
  // Window rolls.
  t0 += 60_001;
  assert.equal(lim.check("c").ok, true);
});

test("the concurrency cap is enforced and released", () => {
  const lim = new Limiter(configFromEnv({ MAX_CONCURRENT: "1" }));
  lim.acquire();
  assert.equal(lim.check("a").ok, false);
  assert.match(lim.check("a").reason, /concurrent/);
  lim.release();
  assert.equal(lim.check("a").ok, true);
});

test("X-Forwarded-For is ignored unless hops are trusted", () => {
  const req = {
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    socket: { remoteAddress: "10.0.0.1" },
  };
  // Default 0 — a forged header cannot influence per-IP limits.
  assert.equal(clientId(req, 0), "10.0.0.1");
  // Behind one trusted proxy, believe the last appended entry.
  assert.equal(clientId(req, 1), "5.6.7.8");
});

test("path traversal is blocked", () => {
  const root = "/srv/app/public";
  const blocked = [
    "/../server.js",
    "/../../etc/passwd",
    "/%2e%2e/server.js",
    "/%2e%2e%2f%2e%2e%2fetc/passwd",
    "/....//server.js",
    "/subdir/../../server.js",
  ];
  for (const p of blocked) {
    const resolved = resolveSafe(root, p);
    if (resolved !== null) {
      assert.ok(
        resolved.startsWith(root + "/"),
        `traversal escaped containment via ${p} → ${resolved}`,
      );
    }
  }
  // A NUL byte is refused outright.
  assert.equal(resolveSafe(root, "/index.html\0.png"), null);
  // Normal paths still work.
  assert.equal(resolveSafe(root, "/markup.js"), "/srv/app/public/markup.js");
  assert.equal(resolveSafe(root, "/"), "/srv/app/public/index.html");
});

test("a sibling directory sharing the root's prefix is not reachable", () => {
  assert.equal(resolveSafe("/srv/app/public", "/../public-secrets/key.json"), null);
});

// ───────────────────────────────────────────────────────────────────────────────
// Audio pipeline — PRD §5.3.
// ───────────────────────────────────────────────────────────────────────────────

test("leading silence is trimmed with a 12ms pre-roll", () => {
  const sampleRate = 24000;
  const pcm = makePcm({ sampleRate, leadingSilenceMs: 350, toneMs: 200 });
  const { trimmedMs, wasTrimmed, preRollMs } = trimLeadingSilence(pcm, sampleRate);

  assert.equal(wasTrimmed, true);
  assert.equal(preRollMs, PRE_ROLL_MS);
  // ~350ms of dead air, less the 12ms pre-roll we deliberately keep.
  assert.ok(trimmedMs > 330 && trimmedMs < 342, `trimmed ${trimmedMs}ms`);
});

test("the pre-roll keeps the attack rather than clipping it", () => {
  const sampleRate = 24000;
  const pcm = makePcm({ sampleRate, leadingSilenceMs: 100, toneMs: 100 });
  const { samples } = trimLeadingSilence(pcm, sampleRate);
  const preRollSamples = Math.round((PRE_ROLL_MS / 1000) * sampleRate);
  // The retained head should still be silence — proof we cut before the onset.
  assert.equal(samples[0], 0);
  assert.ok(preRollSamples > 0);
});

test("entirely silent audio is left alone rather than trimmed to nothing", () => {
  const sampleRate = 24000;
  const silent = Buffer.alloc(sampleRate * 2, 0);
  const { wasTrimmed, samples } = trimLeadingSilence(silent, sampleRate);
  assert.equal(wasTrimmed, false);
  assert.equal(samples.length, sampleRate, "silence must stay diagnosable, not vanish");
});

test("true peak is measured and a normalize warning fires above -0.5 dBFS", () => {
  const hot = new Int16Array([32767, -32768, 100]);
  const hotPeak = measurePeak(hot);
  assert.ok(hotPeak.peakDbfs > -0.5);
  assert.equal(hotPeak.needsNormalize, true);

  // ~-6 dBFS has headroom.
  const quiet = new Int16Array([16384, -16000]);
  const quietPeak = measurePeak(quiet);
  assert.ok(quietPeak.peakDbfs < -0.5);
  assert.equal(quietPeak.needsNormalize, false);
});

test("digital silence reports -Infinity rather than a misleading number", () => {
  const { peakDbfs, needsNormalize } = measurePeak(new Int16Array(64));
  assert.equal(peakDbfs, -Infinity);
  assert.equal(needsNormalize, false);
});

test("the trim and peak figures are disclosed in the response", async (t) => {
  const c = await withServer(t);
  const { body } = await c.post("/api/speak", { text: DEFAULT_PRESET });
  assert.equal(body.audio.trim.wasTrimmed, true);
  assert.equal(body.audio.trim.preRollMs, 12);
  assert.ok(body.audio.trim.trimmedMs > 0, "trim is disclosed, not hidden");
  assert.equal(body.audio.peak.needsNormalize, true, "mock audio peaks at full scale");
});

test("the WAV header is well-formed", () => {
  const samples = new Int16Array([0, 1000, -1000, 32767]);
  const wav = toWav(samples, 24000);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wav.readUInt16LE(20), 1, "PCM");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
  assert.equal(wav.readUInt32LE(40), samples.length * 2);
  assert.equal(wav.length, 44 + samples.length * 2);
});

// ───────────────────────────────────────────────────────────────────────────────
// Deliberately-cut items must not exist.
// ───────────────────────────────────────────────────────────────────────────────

test("no aggregate tag-frequency counter exists", async (t) => {
  const c = await withServer(t);
  // Two requests; the config endpoint must not accumulate anything about content.
  await c.post("/api/speak", { text: DEFAULT_PRESET });
  await c.post("/api/speak", { text: DEFAULT_PRESET });
  const { body, text } = await c.get("/api/config");

  // Usage exposes counts of requests only — never anything derived from text.
  assert.deepEqual(Object.keys(body.usage).sort(), ["dayCount", "inFlight", "minuteCount"]);
  assert.ok(!/tagCounts|mostPasted|popularTags|tagFrequency/i.test(text));
});

test("the response carries no A/B comparison of markup vs no-markup", async (t) => {
  const c = await withServer(t);
  const { body } = await c.post("/api/speak", { text: DEFAULT_PRESET });
  // Exactly one synthesis, one audio payload. A side-by-side panel would need two.
  assert.equal(typeof body.audio.wav, "string");
  assert.ok(!("comparison" in body) && !("withMarkup" in body) && !("withoutMarkup" in body));
});

// ───────────────────────────────────────────────────────────────────────────────
// Text retention.
// ───────────────────────────────────────────────────────────────────────────────

test("submitted text is not echoed into the config or usage surface", async (t) => {
  const c = await withServer(t);
  const secret = "MY-PRIVATE-PROMPT-TEXT";
  await c.post("/api/speak", { text: `<s>${secret}</s>` });
  const { text } = await c.get("/api/config");
  assert.ok(!text.includes(secret), "submitted text must not outlive the request");
});

test("submitted text is never written to stdout or stderr", async (t) => {
  const secret = "DO-NOT-LOG-THIS-PROMPT";
  const written = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return origOut(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return origErr(chunk, ...rest);
  };
  t.after(() => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  });

  const c = await withServer(t);
  await c.post("/api/speak", { text: `<s>${secret}</s>` });
  assert.ok(!written.join("").includes(secret), "submitted text reached a log stream");
});
