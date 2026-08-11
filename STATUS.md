# STATUS

Running log for the unattended BYOM build. Appended as work happens, not
reconstructed at the end. Handoff summary lives at the bottom.

**Repo:** `byom` · **Started:** 2026-08-11 · **Target ship:** Aug 12 (Flux TTS GA)
**Environment:** staging only. No call in this build targets production.

---

## Step 0 — Environment recon · complete

Checked before writing any code, because four findings changed how the rest runs.

| Check | Result |
|---|---|
| PRD on disk | `~/Downloads/BYOM-flux-tts-prd.md` — read in full |
| Staging key | `DEEPGRAM_STAGING_API_KEY` present |
| Staging base URL | **absent** → F-001, halts live verification only |
| `@deepgram/sdk` | v5.7.0 published & cloned; covers `/v2/speak` → D-001 |
| Node | v26.5.0 (PRD asks 22+) |
| `gh` | authenticated, `dg-coreylweathers` |
| `flyctl` | authenticated, `corey.weathers@deepgram.com`; orgs `deepgram`, `personal` |
| Skills | only `devrel-review`; two named skills + `skill-creator` absent → F-003 |

**Consequences carried forward**

1. **SDK over hand-rolled WebSocket** (D-001). The SDK ships a working
   `/v2/speak` connection with binary-frame handling. PRD §5.2's "zero runtime
   dependencies" is overridden by the goal's SDK-first rule; the repo takes one
   runtime dependency.
2. **Live verification halted, build unblocked** (F-001, D-002). No staging host
   exists. `DEEPGRAM_BASE_URL` is required with no default so a missing config
   can never resolve to production by accident. PRD §5.4's gate runs mocked and
   is unaffected.
3. **The two SDK gaps that matter are in the Warning frame** (W-001, W-002).
   `SpeakV2Warning` is `{type, code, description}` — no `stripped[]`, no
   `source`, and `INPUT_MARKUP_STRIPPED` is not in its documented code set. That
   is precisely the payload this tool exists to render, so frame parsing is
   hand-rolled while the connection is not. `billable_character_count` *is*
   typed and needs no workaround.
4. **PRD §8's voice flag is confirmed and worse than stated** (F-004). 4 of the 6
   voices in launch WER guidance — meghan, conor, wes, brittany — do not exist in
   the shipping 12-voice catalog. `flux-rufus-en` is correct by elimination.

Tracking files created: DECISIONS.md, FLAGS.md, SDK_WATCH.md, STATUS.md.

---

## Step 1 — Build the BYOM repo (PRD §5) · server complete, UI not built

Gate: PRD §5.4 acceptance checklist against a mocked `/v2/speak`.
**Result: 52 tests, 52 passing, no live key required.** (`npm test`)

### What exists

| File | Role |
|---|---|
| `server.js` | HTTP surface, `/api/speak`, `/api/config`, request validation ordering |
| `lib/flux.js` | Transport via the official SDK; base-URL validation and production refusal |
| `lib/frames.js` | Frame reading, incl. the hand-rolled `stripped[]`/`source` extraction (W-001) |
| `lib/markup.js` → `public/markup.js` | The strip contract, imported by both Node and browser |
| `lib/wav.js` | Silence trim + 12ms pre-roll, true-peak dBFS, envelope, WAV container |
| `lib/ratelimit.js` | Fixed-window limits, concurrency, `X-Forwarded-For` trust model |
| `lib/voices.js` | Voice allow-list; marcus excluded with cause |
| `lib/static.js` | Static serving with containment-based traversal guard |
| `lib/redact.js` | Outbound error scrubbing — added in response to a test failure, below |
| `test/` | Acceptance suite + mocked `/v2/speak` |

### PRD §5.4 checklist

- [x] Real `/v2/speak` call path; key held server-side; absent from every response and `/api/config`
- [x] Receipt reads `SpeechMetadata.billable_character_count`; says explicitly when it cannot
- [x] Stripped inventory reads the API's `stripped[]`, falls back to the mirror with a visible disagreement flag
- [x] Wire log shows verbatim frames in protocol order (incl. outbound, and unrecognized frames)
- [x] No vendor names in payloads; `source` present in the log only
- [x] "What to use instead" only where verified; `null` where no equivalent exists
- [x] Rate limiting, input cap (900), concurrency cap, path traversal blocked
- [x] **Rejected requests do not consume a rate-limit slot** — verified with five rejection kinds
- [x] Suite passes with a mocked `/v2/speak`; CI needs no live key
- [x] Default `flux-rufus-en`; `flux-marcus-en` excluded and rejected server-side
- [x] `TRUSTED_PROXY_HOPS`, `GLOBAL_PER_MINUTE`, `GLOBAL_PER_DAY` env-configurable
- [x] Submitted text held for the request only — asserted it never reaches stdout/stderr or `/api/config`
- [ ] **No vendor names in UI chrome** — partially verified. Payload-level asserted; UI not yet built.

### A real bug the suite caught

The "key absent from error responses" test failed on first run. `/api/speak`'s 502
handler interpolated the upstream error message verbatim, and an upstream failure
can carry the credential — an auth error echoing the token, or a transport error
including a URL with the key as a query param. Fixed by adding `lib/redact.js`,
which scrubs exact secrets (literally, not as a pattern) plus credential-shaped
values the server never held, and caps message length.

Worth noting because the build goal specifically asked for this constraint to be
verified in the test suite rather than in review. Review would very likely have
missed it: the happy path never touches that line.

### Two findings that hardened the design

1. **The SDK's production fallback is silent.** `CustomClient.ts:1118-1120`
   resolves `options.baseUrl ?? (options.environment ?? Production)[environmentKey]`,
   and the v2 speak path passes `environmentKey: "production"` hardcoded. `baseUrl`
   does override — staging works — but an *unset* base URL connects to
   `wss://api.deepgram.com` with no error. So the base URL is required with no
   default, and production hostnames are rejected outright. D-002.
2. **The spec's broken example is reproducible.** `<prosody rate="slow">` +
   `</prosody>` is exactly 31 characters — the figure PRD §8 says the spec's
   `raw` strings total while claiming a delta of 25. The default preset here is
   arithmetically correct (87 / 62 / 25 across 3 spans, delta equal to the sum of
   stripped spans) and is asserted by test. Offered to docs via F-006.

---

## Handoff — as of first commit

### Shipped and verified
Server-side BYOM per PRD §5, with the §5.4 checklist passing against a mocked
`/v2/speak`. 52 tests, no live credential needed. Committed.

### Not yet built
- **UI** (`public/index.html`, `app.js`, styles) — the talk.deepgram.com skin,
  the receipt, the strike-out animation, the wire log rendering. `public/markup.js`
  is written and already browser-importable, so the mirror half is done.
- **Step 2** — `devrel-review` run against the repo.
- **Step 3** — `/content`: the three PRD §6 units and the PRD §7 persona pieces.
- **Step 4** — Fly.io deploy. Blocked on F-001 for anything live; deployable with
  a mocked upstream, which would be misleading, so not done.
- **Step 5** — GitHub push to `dg-coreylweathers/byom`.

### Placeholders in effect
Rate limits (`lib/ratelimit.js` DEFAULTS), Fly org (`personal`), no CDN, no spend
cap, unrestricted staging key. All in F-002.

### Blocked
Only live verification, and only on the missing staging base URL (F-001). Nothing
else in the build depends on it — the mocked path covers the acceptance gate.

### Skills modified
None. `skill-creator` is not installed, so the goal's prescribed mechanism for
closing skill gaps was unavailable. F-003, D-005.
