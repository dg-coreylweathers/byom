/**
 * End-to-end against the reference upstream over a real WebSocket.
 *
 * The acceptance suite injects a double at the SDK-client boundary, which leaves
 * the transport itself unexercised: the real `createConnection`, the subprotocol
 * auth, binary frame delivery, and protocol ordering as the SDK actually parses
 * them. These tests cover that path. Everything below
 * `client.speak.v2.createConnection()` is the same code a staging host would drive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp, DEFAULT_PRESET } from "../server.js";
import { createUpstream, IMPLEMENTATION } from "../tools/reference-upstream.js";

const FAKE_KEY = "reference-upstream-does-not-validate-this";

async function withStack(t, { fault = false, env = {} } = {}) {
  const upstream = createUpstream({ fault });
  await new Promise((resolve) => upstream.listen(0, resolve));
  const upstreamPort = upstream.address().port;
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const app = createApp({
    env: {
      // ws:// on loopback — a staging-shaped URL that is structurally incapable of
      // being production, and which validateBaseUrl accepts.
      DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstreamPort}`,
      DEEPGRAM_STAGING_API_KEY: FAKE_KEY,
      ...env,
    },
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  return {
    upstreamPort,
    async speak(body) {
      const res = await fetch(`http://127.0.0.1:${port}/api/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { res, body: await res.json() };
    },
  };
}

test("a full report is produced over a real WebSocket via the SDK", async (t) => {
  const stack = await withStack(t);
  const { res, body } = await stack.speak({ text: DEFAULT_PRESET });

  assert.equal(res.status, 200);
  assert.equal(body.submitted.value, 87);
  assert.equal(body.billed.value, 62);
  assert.ok(body.audio.wav.length > 0, "audio should come back through the binary path");
  assert.equal(body.audio.sampleRate, 24000);
});

test("the receipt is labelled reference-derived, never API-reported", async (t) => {
  const stack = await withStack(t);
  const { body } = await stack.speak({ text: DEFAULT_PRESET });

  assert.equal(body.upstream, IMPLEMENTATION);
  assert.equal(body.billed.origin, "reference");
  assert.notEqual(body.billed.origin, "api");
  assert.match(body.billed.note, /not by the API/);
  assert.match(body.billed.note, /not a real synthesis/);
  assert.equal(body.stripped.origin, "reference");
});

test("the wire log records the real protocol order, including binary frames", async (t) => {
  const stack = await withStack(t);
  const { body } = await stack.speak({ text: DEFAULT_PRESET });

  const types = body.wire.map((e) => e.type);
  assert.equal(types[0], "Speak");
  assert.equal(types[1], "Flush");
  assert.ok(types.includes("Connected"));
  assert.ok(types.includes("SessionMetadata"));
  assert.ok(types.includes("Warning"));
  assert.ok(types.includes("SpeechMetadata"));
  assert.equal(types.at(-1), "Flushed");

  // Real streaming produces multiple audio frames, not one blob.
  const audioFrames = body.wire.filter((e) => e.binary);
  assert.ok(audioFrames.length > 1, `expected several audio frames, got ${audioFrames.length}`);
  assert.ok(audioFrames.every((f) => f.bytes > 0 && f.frame === null));

  const seqs = body.wire.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("the stripped inventory arrives from the wire, with source", async (t) => {
  const stack = await withStack(t);
  const { body } = await stack.speak({ text: DEFAULT_PRESET });

  assert.deepEqual(
    body.stripped.entries.map((e) => e.raw),
    ["<s>", "</s>", '<break time="1s"/>'],
  );
  // `source` is permitted in the payload and log, never in UI chrome.
  assert.ok(body.stripped.entries.every((e) => e.source === "ssml"));
  const warning = body.wire.find((e) => e.frame && e.frame.type === "Warning");
  assert.equal(warning.frame.code, "INPUT_MARKUP_STRIPPED");
});

test("mirror and upstream agree by default, so no disagreement is reported", async (t) => {
  const stack = await withStack(t);
  const { body } = await stack.speak({ text: DEFAULT_PRESET });
  assert.equal(body.disagreement, null);
});

test("fault injection surfaces a real disagreement rather than hiding it", async (t) => {
  const stack = await withStack(t, { fault: true });
  const { body } = await stack.speak({ text: DEFAULT_PRESET });

  assert.ok(Array.isArray(body.disagreement), "a dropped span must be surfaced");
  assert.match(body.disagreement.join(" "), /found 3 markup span\(s\); the server reported 2/);
  // The server's inventory is still what gets shown — the flag reports the
  // difference rather than substituting the mirror silently.
  assert.equal(body.stripped.origin, "reference");
  assert.equal(body.stripped.entries.length, 2);
});

test("both PRD §5.3 audio defects are reproduced and then handled", async (t) => {
  const stack = await withStack(t);
  const { body } = await stack.speak({ text: DEFAULT_PRESET });

  // ~350ms of dead air was present and got trimmed, with the 12ms pre-roll kept.
  assert.equal(body.audio.trim.wasTrimmed, true);
  assert.equal(body.audio.trim.preRollMs, 12);
  assert.ok(
    body.audio.trim.trimmedMs > 330 && body.audio.trim.trimmedMs < 342,
    `trimmed ${body.audio.trim.trimmedMs}ms, expected ~338`,
  );

  // Output peaked at full scale, so the normalize warning fires.
  assert.equal(body.audio.peak.needsNormalize, true);
  assert.ok(body.audio.peak.dbfs > -0.5, `peak ${body.audio.peak.dbfs} dBFS`);
});

test("the audio is a well-formed WAV with real duration", async (t) => {
  const stack = await withStack(t);
  const { body } = await stack.speak({ text: DEFAULT_PRESET });

  const wav = Buffer.from(body.audio.wav, "base64");
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.ok(body.audio.durationMs > 200, `duration ${body.audio.durationMs}ms`);
  // Envelope is fixed-width so the UI has no layout shift.
  assert.equal(body.audio.envelope.length, 240);
  assert.ok(body.audio.envelope.some((v) => v > 0.5), "envelope should show the tone bursts");
});

test("text with no markup produces a receipt where nothing was stripped", async (t) => {
  const stack = await withStack(t);
  const { body } = await stack.speak({ text: "Your transfer went through." });

  assert.equal(body.submitted.value, 27);
  assert.equal(body.billed.value, 27);
  assert.equal(body.stripped.entries.length, 0);
  assert.equal(body.disagreement, null);
});

test("the upstream rejects a connection with no auth at all", async (t) => {
  const upstream = createUpstream();
  await new Promise((resolve) => upstream.listen(0, resolve));
  const port = upstream.address().port;
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  // A bare WebSocket with neither Authorization header nor subprotocol.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v2/speak`);
  const outcome = await new Promise((resolve) => {
    ws.addEventListener("open", () => resolve("open"));
    ws.addEventListener("error", () => resolve("rejected"));
  });
  assert.equal(outcome, "rejected", "auth must be required, not accidentally optional");
});

test("the upstream exposes a health endpoint for the deploy check", async (t) => {
  const upstream = createUpstream();
  await new Promise((resolve) => upstream.listen(0, resolve));
  const port = upstream.address().port;
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.implementation, IMPLEMENTATION);
});
