#!/usr/bin/env node
/**
 * Reference upstream — a standalone `/v2/speak` server.
 *
 * WHY THIS EXISTS
 * There is no staging host available to this build (FLAGS.md F-001), and the
 * build may never target production. Without an upstream, BYOM could only ever be
 * exercised through an in-process test double injected at the SDK boundary, which
 * leaves the real transport path — SDK connection, subprotocol auth, binary frame
 * delivery, protocol ordering — unexercised, and makes any deploy a shell.
 *
 * So this implements the server side of the protocol for real. BYOM connects to it
 * over an actual WebSocket through the actual SDK. Everything from
 * `client.speak.v2.createConnection()` down is the same code path a staging or
 * production host would drive.
 *
 * WHAT IT IS NOT
 * It is not a synthesizer. The audio is structured tone, not speech, and it says
 * so. Every response announces itself via `SessionMetadata.implementation`, which
 * BYOM reads and surfaces — so a receipt produced against this upstream is
 * labelled as reference-derived and is never presented as API-reported. That
 * follows the precedent PRD §3 sets for the batch fallback: numbers that did not
 * come from the API must be visibly marked, not quietly displayed.
 *
 * WHAT IT DELIBERATELY REPRODUCES
 * Both PRD §5.3 output defects, because BYOM's handling of them should be
 * demonstrable rather than merely asserted by unit test:
 *   - ~350ms of dead air at the head of the stream
 *   - output peaking at full scale with no headroom
 * A well-behaved mock would hide exactly the two things this tool exists to show.
 *
 * It shares `public/markup.js` with BYOM on purpose. That file is the strip
 * contract; a reference implementation of the contract should not restate it. The
 * consequence is that mirror and upstream agree by construction, which is the
 * correct default — use `--fault` to force a disagreement and exercise BYOM's
 * disagreement flag.
 */

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { analyze } from "../public/markup.js";

const SAMPLE_RATE_DEFAULT = 24000;

/** PRD §5.3: the head-of-stream dead air BYOM has to trim and disclose. */
const DEAD_AIR_MS = 350;

/** Marks every session as reference-derived. BYOM reads this and labels the receipt. */
export const IMPLEMENTATION = "byom-reference-upstream";

/**
 * Structured tone standing in for speech.
 *
 * Peaks at full scale on purpose — reproducing the no-headroom defect — and is
 * preceded by dead air. Syllable-ish amplitude segmentation is derived from word
 * lengths in the clean text so the waveform has visible structure to render,
 * which is what the envelope display needs to look like anything.
 */
function synthesizeTone(cleanText, sampleRate) {
  const words = cleanText.split(/\s+/).filter(Boolean);
  const perWordMs = 260;
  const bodyMs = Math.max(400, words.length * perWordMs);

  const silentSamples = Math.round((DEAD_AIR_MS / 1000) * sampleRate);
  const bodySamples = Math.round((bodyMs / 1000) * sampleRate);
  const out = new Int16Array(silentSamples + bodySamples);

  const wordSamples = Math.max(1, Math.floor(bodySamples / Math.max(1, words.length)));

  // Built in floating point first, then scaled to exactly full scale. Summed
  // harmonics only reach unity when their phases happen to align, so scaling by a
  // fixed factor would leave incidental headroom — and headroom is precisely the
  // thing this is supposed NOT to have. Normalizing makes the defect exact and
  // repeatable rather than dependent on word count and pitch.
  const body = new Float64Array(bodySamples);
  let maxAbs = 0;

  for (let i = 0; i < bodySamples; i += 1) {
    const t = i / sampleRate;
    const wordIndex = Math.min(words.length - 1, Math.floor(i / wordSamples));
    const withinWord = (i % wordSamples) / wordSamples;

    // Gate between words so the envelope shows discrete bursts rather than a slab.
    const gate = withinWord < 0.82 ? Math.sin(Math.PI * (withinWord / 0.82)) : 0;
    if (gate <= 0) continue;

    // Pitch varies per word so successive bursts are distinguishable.
    const f0 = 110 + ((words[wordIndex] || "").length % 7) * 14;
    const value =
      gate *
      (0.62 * Math.sin(2 * Math.PI * f0 * t) +
        0.26 * Math.sin(2 * Math.PI * f0 * 2 * t) +
        0.12 * Math.sin(2 * Math.PI * f0 * 3 * t));

    body[i] = value;
    const a = Math.abs(value);
    if (a > maxAbs) maxAbs = a;
  }

  // Peak at full scale, no headroom — PRD §5.3's defect, on purpose.
  const scale = maxAbs > 0 ? 32767 / maxAbs : 0;
  for (let i = 0; i < bodySamples; i += 1) {
    out[silentSamples + i] = Math.max(-32768, Math.min(32767, Math.round(body[i] * scale)));
  }

  return out;
}

/** Split PCM into frames the size a streaming server would actually emit. */
function chunk(samples, bytesPerFrame = 4096) {
  const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2);
  const frames = [];
  for (let o = 0; o < buf.length; o += bytesPerFrame) {
    frames.push(buf.subarray(o, Math.min(buf.length, o + bytesPerFrame)));
  }
  return frames;
}

export function createUpstream({ fault = false } = {}) {
  const http = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, implementation: IMPLEMENTATION }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/v2/speak") {
      socket.destroy();
      return;
    }
    // Auth must be PRESENT. Not validated against anything — there is no account
    // behind this — but absent auth is rejected so BYOM's auth path is genuinely
    // exercised rather than accidentally optional.
    const hasHeader = Boolean(req.headers.authorization);
    const hasSubprotocol = Boolean(req.headers["sec-websocket-protocol"]);
    if (!hasHeader && !hasSubprotocol) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const sampleRate = Number.parseInt(url.searchParams.get("sample_rate") || "", 10) || SAMPLE_RATE_DEFAULT;
    const model = url.searchParams.get("model") || "unknown";

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    send({ type: "Connected", request_id: `ref-${Date.now().toString(36)}` });
    send({
      type: "SessionMetadata",
      request_id: `ref-${Date.now().toString(36)}`,
      model,
      sample_rate: sampleRate,
      // The honesty marker. BYOM reads this to label the receipt.
      implementation: IMPLEMENTATION,
    });

    let pending = null;

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;

      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        send({ type: "Error", description: "message was not valid JSON" });
        return;
      }

      if (msg.type === "Speak") {
        const text = typeof msg.text === "string" ? msg.text : "";
        // Never logged. Same constraint as BYOM itself — this holds user text for
        // the life of the turn and no longer.
        pending = text;

        const a = analyze(text);

        if (a.stripped.length > 0) {
          const stripped = a.stripped.map((s) => ({
            raw: s.raw,
            // `source` names the markup family. Permitted in the payload and the
            // wire log; BYOM is responsible for keeping it out of UI chrome.
            source: s.source,
            replacement: s.advice,
          }));

          // `--fault` drops one span so BYOM's mirror-vs-server disagreement flag
          // can be demonstrated on a live connection.
          const payload = fault && stripped.length > 1 ? stripped.slice(1) : stripped;

          send({
            type: "Warning",
            code: "INPUT_MARKUP_STRIPPED",
            description: "Input markup was removed before synthesis.",
            // Not on the SDK's SpeakV2Warning type — see SDK_WATCH.md W-001. Sent
            // here because it is what the real payload carries and what BYOM reads.
            stripped: payload,
          });
        }
        return;
      }

      if (msg.type === "Flush") {
        const text = pending ?? "";
        const a = analyze(text);
        const samples = synthesizeTone(a.clean, sampleRate);

        // ORDER MATTERS, and this order is the one staging actually uses:
        //   SpeechStarted → Flushed (ack) → audio… → SpeechMetadata (terminator)
        //
        // The first version of this file sent Flushed last, which taught the client
        // that Flushed means "turn complete." That passed every test and then failed
        // against the real endpoint by closing the socket before any audio arrived.
        // A reference implementation that gets the ordering wrong is worse than no
        // reference implementation, so this is deliberately faithful.
        send({ type: "SpeechStarted", speech_id: "ref-speech" });
        send({ type: "Flushed", speech_id: "ref-speech" });

        for (const frame of chunk(samples)) {
          if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
        }

        send({
          type: "SpeechMetadata",
          speech_id: "ref-speech",
          audio_duration_ms: Math.round((samples.length / sampleRate) * 1000),
          input_character_count: a.submitted,
          billable_character_count: a.billed,
          // `breaks_applied` mirrors what staging returns; it is absent from the
          // SDK's ControlsApplied type (SDK_WATCH W-006).
          controls_applied: { pronunciations_applied: 0, breaks_applied: 0, pronunciation_warnings: 0 },
        });
        pending = null;
        return;
      }

      send({ type: "Warning", code: "NO_ACTIVE_SPEECH", description: `unhandled message type: ${msg.type}` });
    });
  });

  return http;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.UPSTREAM_PORT || "8081", 10);
  const fault = process.argv.includes("--fault");
  createUpstream({ fault }).listen(port, () => {
    console.log(`reference upstream on :${port}/v2/speak${fault ? " (fault injection on)" : ""}`);
    console.log("NOT a synthesizer. Audio is structured tone; every session is marked reference-derived.");
  });
}
