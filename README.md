# Bring Your Own Markup

Paste a real prompt from your codebase — tags and all. Get back exactly what was
removed, what it cost, the audio, and the server frames verbatim.

**You pasted 87 characters. We billed 62.**

---

## What this is

A diagnostic, not a demo. If you already have SSML or vendor tags baked into your
prompts, the question that actually matters before switching TTS providers is not
"does it sound good" — it's *what happens to the markup I already have, and what
does it cost me*.

So this runs against your real text and produces a report:

- **Character accounting.** What you submitted, what was billable, and the
  difference — read from `SpeechMetadata.billable_character_count`, with the source
  of every figure labelled.
- **The stripped inventory.** Every span that was removed, and what to use instead
  where there is a real answer. Where there isn't one, it says "no direct
  equivalent" rather than inventing something.
- **The audio**, with its two rough edges disclosed rather than hidden: leading
  silence trimmed (with a pre-roll so the attack survives) and a true-peak reading
  that warns you when there's no headroom left.
- **The wire log** — every frame, in protocol order, verbatim.

It is deliberately not a "try it and hear a voice" page. That comparison is
already served elsewhere; this answers the migration-cost question instead.

## Run it

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env     # then fill it in
npm start
```

Two variables are required and neither has a default:

| Variable | Why it has no default |
|---|---|
| `DEEPGRAM_BASE_URL` | The SDK resolves its host as `baseUrl ?? environment[key]`, and its only built-in environment is production. An unset value would connect to production silently, so this server refuses to start instead. Production hostnames are rejected outright. |
| `DEEPGRAM_STAGING_API_KEY` | Named for staging specifically, so a production key sitting in `DEEPGRAM_API_KEY` can't be picked up by accident. |

The remaining variables — rate limits, concurrency, `TRUSTED_PROXY_HOPS` — are
documented in `.env.example`. Set `TRUSTED_PROXY_HOPS=1` behind a proxy; at the
default of `0` the `X-Forwarded-For` header is ignored entirely so a forged header
can't influence per-client limits.

### No endpoint to point at?

There's a reference implementation of the streaming endpoint in the box:

```bash
node tools/reference-upstream.js          # listens on :8081
DEEPGRAM_BASE_URL=ws://127.0.0.1:8081 npm start
```

It speaks the real protocol over a real WebSocket, so the whole client path is
exercised. It is **not** a synthesizer: the audio is structured tone, and it
announces itself in `SessionMetadata.implementation` so every figure it produces
is labelled reference-reported rather than API-reported. Pass `--fault` to make it
disagree with the local mirror on purpose, which is how you can see the
disagreement reporting work.

## How it's put together

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

`public/markup.js` is imported by **both** the server and the browser. That's
deliberate: the browser needs to highlight tags before any request goes out, and
sharing one file means the tag inventory can't fork. It is a *mirror*, though —
the server is the authority, and where the two disagree the UI shows the
disagreement instead of quietly picking a winner.

One runtime dependency, the official SDK. `ws` is there only because
`tools/reference-upstream.js` needs a WebSocket *server*, which Node has no
built-in for.

## Tests

```bash
npm test
```

79 tests, no live credential required — the suite covers both a mocked endpoint
and the bundled reference upstream. They assert the constraints, not just the
happy path: that the key is absent from every response including error paths, that
a production host is refused, that rejected requests don't consume a rate-limit
slot, that an audio-less turn fails loudly instead of returning a header-only
file, and that no vendor name appears in any shipped file.

## Reading the repo

| File | What's in it |
|---|---|
| `DECISIONS.md` | Every judgment call, what it overrides, and what would reverse it |
| `SDK_WATCH.md` | Each place this builds around an SDK gap, and what to watch for before removing it |
| `FLAGS.md` | Items that need an owner outside this repo |
| `STATUS.md` | Build log and handoff |

`SDK_WATCH.md` is the one worth reading before you copy anything out of here —
several of the workarounds exist for reasons that aren't visible from the code
alone.
