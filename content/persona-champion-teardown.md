---
persona: Champion
entry_point: Already advocates for us; wants to go deeper and produce public artifacts
format: Build teardown
agentic_shift: Champions want to build on top, not just read. Their stated failure mode is having no structured invitation.
keyword_lane: byom architecture  (no overlap — nobody searches this; it's a linked-to piece, not a found one)
status: publish-ready
requires: public repo (satisfied — https://github.com/dg-coreylweathers/byom)
HOLD: 🚨 Do not publish — FLAGS.md F-012. Markup is not stripped on staging; it is billed, and some tags return NET-0000. Verified 2026-08-11.
---

# How BYOM works, and what broke while building it

This is the teardown. If you want to fork it, extend it, or write your own version,
here's the architecture and — more usefully — the four things that went wrong.

Repo: https://github.com/dg-coreylweathers/byom

## The shape

```
browser ──POST /api/speak──▶ server.js ──wss──▶ /v2/speak
   │                            │
   │                            ├── holds the API key (never sent to the client)
   │                            ├── rate limits, caps input length
   │                            ├── wraps raw linear16 in a WAV container
   │                            ├── trims the leading silence
   │                            └── computes the waveform envelope
   │
   └── renders the report, and shows which numbers came from where
```

One runtime dependency: the official SDK. Everything else is standard library.

## The design decision worth stealing: mirror, not authority

`public/markup.js` is imported by **both** the server and the browser.

The browser needs it to highlight tags live, before any request goes out — that
immediacy is most of what makes the tool feel like an instrument rather than a form.
The server needs it to compute a local projection. Sharing one file means the tag
inventory cannot fork between them, which is the bug that would otherwise be
guaranteed within a month.

But it's explicitly a **mirror, not the authority.** The server's reported
`stripped[]` array is the truth. So what happens when they disagree?

The tool shows the disagreement. It does not silently prefer one.

```js
if (serverStripped === null) {
  if (mirror.stripped.length > 0) {
    notes.push("The server did not report a stripped inventory, so the list below is the local mirror's.");
  }
}
```

That `if (mirror.stripped.length > 0)` guard is there because of a bug. The first
version treated a missing `Warning` frame as "the server failed to report." But on
text with no markup there's *nothing to warn about*, so no frame arrives — and the
tool was flagging a disagreement on perfectly clean input. Silence is only
suspicious when you had reason to expect a warning.

If you build something similar: decide early whether absence means "no data" or
"zero," and make the two representable separately. Conflating them costs more later
than the distinction costs now.

## Four things that broke

### 1. Audio arrives as a `Blob`, and `Blob.type` is the empty string

This is the one that would have shipped silently.

Under Node, the SDK delivers binary audio frames as `Blob` objects. A reasonable
control-frame check looks like `typeof msg.type === "string"` — and `Blob.type` *is*
a string. The empty one. So every audio frame classified as a control frame with an
unknown type, the PCM was dropped on the floor, and the tool returned HTTP 200 with
a complete-looking receipt, correct character accounting, and a 44-byte header-only
WAV.

No error. Nothing in the logs. The report rendered.

The fix is to check for binary shapes *first*, before any control-frame logic, and
to accept all four shapes (`Blob`, `Buffer`, `ArrayBuffer`, typed array) because
guessing wrong loses audio rather than erroring:

```js
function isBinaryFrame(message) {
  if (message === null || typeof message !== "object") return false;
  if (typeof Blob !== "undefined" && message instanceof Blob) return true;
  if (Buffer.isBuffer(message)) return true;
  if (message instanceof ArrayBuffer) return true;
  return ArrayBuffer.isView(message);
}
```

One wrinkle: `Blob.arrayBuffer()` is async, so converting inline can reorder your
audio. Collect the frames unconverted in arrival order and convert them all at the
end.

### 2. `sendSpeak()` does not set the message type for you

`sendSpeak(message)` passes its argument straight through. `type` is a required
field of the message contract, so TypeScript enforces it — but this project is plain
JavaScript, where nothing does.

`socket.sendSpeak({ text })` fails in a genuinely unhelpful way: the socket opens,
the frame is accepted, and the server answers with "unhandled message type" warnings
instead of synthesizing. There's no error and no `Flushed`, so the call just times
out. The symptom points nowhere near the cause.

Send `{ type: "Speak", text }`. And log the *same object* you send, so your wire log
can't drift from what actually went out.

### 3. An empty result reported success

Related to #1 but a distinct bug, and the more important lesson.

After fixing the Blob classification, the *guard* was still missing: a turn that
completed with zero audio frames still returned 200 with a header-only WAV. Fixing
the cause is not the same as defending against the class of failure. If your tool's
claim is that its output is real, an empty result must fail loudly.

### 4. The API key leaked through the error path

The 502 handler interpolated the upstream error message verbatim. An upstream
failure can legitimately carry the credential — an auth error echoing the token, a
transport error with the key in a query parameter.

A test caught it, which is the point: the happy path never touches that line, so
review would very likely have missed it. Scrub outbound error messages, and scrub
the exact secret literally rather than by pattern — a key that doesn't look
credential-shaped still must not escape.

## The thing that made all four findable

There was no staging endpoint available while building this. The obvious move is to
inject a fake client at the SDK boundary and unit-test against it.

That would have found **none** of the four bugs above. All of them live in the
transport: the real socket, real binary delivery, real frame parsing.

So the repo ships `tools/reference-upstream.js` — an actual WebSocket server
implementing the endpoint's protocol. The client talks to it over a real connection
through the real SDK. It deliberately reproduces the two known output rough edges
(≈350ms of leading dead air, and output normalized to exactly full scale) because a
well-behaved mock would hide the two things the tool exists to demonstrate.

It is not a synthesizer, and it never pretends to be: it announces itself in
`SessionMetadata.implementation`, and the client labels any figure derived from it
as reference-reported rather than API-reported.

**If you take one thing from this teardown:** the fidelity of your test double
determines which bugs you're allowed to find. A double that stubs the boundary you
most need to exercise will pass forever.

## Fork it

```bash
git clone https://github.com/dg-coreylweathers/byom
cd byom && npm install && npm test     # 81 tests, no credential needed
node tools/reference-upstream.js       # then point DEEPGRAM_BASE_URL at it
```

Read `SDK_WATCH.md` first if you're going to copy any of the frame-handling code —
several of the workarounds exist for reasons that aren't visible from the code
alone, and it says what to check before removing each one.

Obvious extensions, none of which are built: batch corpus mode (see the Scaler
runbook for what it should output), a diff view against a previous run, and
`INPUT_MARKUP_STRIPPED` rate tracking over time.

Two things deliberately *not* built, and worth knowing why before you add them: a
side-by-side markup/no-markup A/B panel doubles the latency of the one moment that
has to feel instant, and an aggregate "most-pasted tags" counter would require
retaining user text. The second one is a privacy decision, not a technical one.
