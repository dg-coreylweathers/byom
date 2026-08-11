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

---

## Step 1b — Reference upstream, and what it caught · complete

Built `tools/reference-upstream.js`: a real `/v2/speak` server. BYOM now connects
to it over an actual WebSocket through the actual SDK, so the transport is
exercised rather than stubbed. **65 tests passing** (52 acceptance + 13 end-to-end).

Building it real found three defects the injected double structurally could not:

1. **Audio arrives as `Blob` under Node** (SDK_WATCH W-004). `Blob.type` is `""`,
   so the binary frames were being classified as control frames and the PCM
   dropped — producing a complete-looking report with a 44-byte header-only WAV.
   Worst possible failure shape for this tool: the receipt renders, the audio is
   empty, nothing errors.
2. **`sendSpeak`/`sendFlush` don't set `type`** (W-005). Omitting it opens the
   socket, gets frames accepted, and draws `NO_ACTIVE_SPEECH` warnings instead of
   synthesis — the turn just never completes. TypeScript enforces this field;
   plain JS doesn't.
3. **An absent `Warning` frame was misread as a reporting failure.** On text with
   no markup there is nothing to warn about, so no Warning arrives — and BYOM was
   flagging a spurious mirror/server disagreement. Silence is only suspicious when
   the mirror expected a warning.

Also closed PRD §5.5's WebSocket-auth open decision: the SDK sends an
`Authorization` header and no subprotocol, so neither branch of that contingency
applies (D-008).

**Honesty guard:** the upstream self-identifies in `SessionMetadata.implementation`;
BYOM labels those receipts `origin: "reference"`, never `"api"`, with a note that
the figures aren't API-reported. Asserted by test. It also reproduces both PRD §5.3
audio defects on purpose, so BYOM's trim and normalize-warning behaviour is
demonstrated rather than only unit-tested.

---
---

# FINAL HANDOFF · 2026-08-11

> Supersedes the interim handoff above, which was written at the first commit.

## Live now

| | |
|---|---|
| **Staging app** | https://byom-staging.fly.dev |
| **Repo** | https://github.com/dg-coreylweathers/byom (public, `main`, 40 files) |
| **Fly app** | `byom-staging`, `deepgram` org, scale-to-zero |
| **Tests** | 81 passing, no live credential required (`npm test`) |

Verified against the live deployment: 87 submitted → 62 billed, receipt labelled
`origin: reference`, 338ms of leading silence trimmed with the 12ms pre-roll kept,
peak 0 dBFS firing the normalize warning, 40 wire frames in protocol order,
`flux-marcus-en` absent from the voice list, per-IP rate limit cutting over at 5
requests, and the real staging key absent from every response and from every pushed
commit.

## What shipped

**Steps 1–5 all completed.** One step (4) completed differently than specified; see
Departures below.

- **Step 1 — the repo** (PRD §5). Server, transport via the official SDK, shared
  strip contract, audio pipeline, rate limiting, static serving. All of PRD §5.4's
  acceptance checklist passes, including the last checkbox (no vendor names in UI
  chrome) once the UI landed.
- **Step 1b — reference upstream.** A real `/v2/speak` server, added so the deploy
  and the tests exercise the actual transport instead of an injected double.
- **Step 1c — UI.** talk.deepgram.com skin with design tokens read from the live
  site, precision content per PRD §3.
- **Step 2 — review.** `devrel-review` run; four findings, all fixed with tests.
  `REVIEW.md`.
- **Step 3 — content.** Nine full drafts in `/content`, eight distinct keyword lanes.
- **Step 4 — deploy.** Live, staging-only.
- **Step 5 — push.** Public.

## The five bugs this build found in its own work

Listed because they are the substance of what the process bought, and four of the
five were found by a mechanism rather than by reading the code.

1. **The API key leaked through the error path.** The 502 handler interpolated the
   upstream error message verbatim; an upstream failure can carry the credential.
   Caught by a test, not review — the happy path never touches that line. Fixed with
   `lib/redact.js`.
2. **Audio arrived as `Blob`, was classified as a control frame, and was dropped.**
   `Blob.type` is `""`. Produced HTTP 200, correct character accounting, and a
   44-byte header-only WAV. The worst possible failure shape for this tool. Only
   findable against a real transport (SDK_WATCH W-004).
3. **`sendSpeak`/`sendFlush` need an explicit `type`.** Omitting it opens the socket,
   gets frames accepted, and draws "unhandled message type" warnings instead of
   synthesis, so the turn never completes. TypeScript enforces the field; plain JS
   does not (W-005).
4. **An absent `Warning` frame was read as a reporting failure.** On clean text
   there is nothing to warn about, so BYOM was flagging a spurious disagreement.
5. **An audio-less turn reported success.** Distinct from #2: fixing that cause did
   not add a guard against the class. Found by the review (B2).

## Placeholders

| Item | Current value | Needs |
|---|---|---|
| Rate limits | 20/min, 500/day, 5/IP/min, 2 concurrent | Real numbers with the spend cap (F-002) |
| Spend cap | **none** | F-002. Interim backstop only: scale-to-zero when idle |
| CDN | none | PRD §10 requires one (F-002) |
| API key on the deploy | **placeholder, not a real credential** | Real restricted TTS-only key at cutover (D-012, F-002) |
| Upstream | in-process reference implementation | A staging endpoint (F-001) |
| Design spacing scale | inferred | Marked `[verify]` in `styles.css` (D-009) |

## Departures from the goal, all logged

1. **PRD §5.2's "zero runtime dependencies" was overridden** in favour of the
   official SDK, per the goal's SDK-first rule (D-001). Two dependencies: the SDK,
   and `ws` for the reference upstream's server.
2. **Fly org reversed from `personal` to `deepgram`** (D-011). `personal` is
   billing-blocked, and the premise was wrong regardless — the shared org already
   hosts the other launch demos.
3. **The real staging key was not deployed** (D-012). A placeholder was set via
   `fly secrets set` instead. The instance talks only to a loopback reference
   upstream that requires the variable present but does not validate it, so shipping
   the real credential would expose a live secret for no functionality. This follows
   the intent of the goal's key rule over its letter. Cutover commands are in D-012.
4. **The skin is dark-only**, a deliberate departure from PRD §3's
   `prefers-color-scheme` ask, because a light variant would break the required skin
   match (D-009). The one place the two documents cannot both be satisfied.

## FLAGS.md — 11 items needing an owner

**Time-critical before Aug 12 GA**
- **F-004** — Launch WER guidance names four voices that do not exist in the
  shipping catalog (meghan, conor, wes, brittany). Only rufus and marcus exist, and
  marcus is defective. Affects every team producing launch audio.
- **F-005** — Aura→Flux migration guide should be reopened; two breaking changes
  post-date it and the GA changelog is scheduled to link it.

**Blocking specific deliverables**
- **F-001** — No staging base URL exists. Blocks live verification and unit 3's
  video capture.
- **F-002** — Hosting: org confirmation, CDN, restricted key, spend cap.
- **F-011** — Partner-dev piece: the partner and gap could not be verified. Do not
  publish unconfirmed.
- **F-007** — Agent-operator persona is absent from the canonical reference. Draft
  complete, marked do-not-publish.

**Route and continue**
- **F-006** — Two spec documentation findings, including the `INPUT_MARKUP_STRIPPED`
  example that does not add up. BYOM's preset is arithmetically correct and is
  offered as a replacement.
- **F-008** — Server contract: can one turn emit multiple `SpeechMetadata` frames?
- **F-009** — Unit 2's remaining `[verify]`: free-credit amount and signup terms.
- **F-010** — Unit 4's two `[verify]` items on markup/normalization ordering.
- **F-003** — Tooling: two named skills and `skill-creator` are not installed.

## SDK_WATCH.md — 5 hand-rolled workarounds

| | Gap | Why it matters |
|---|---|---|
| W-001 | `SpeakV2Warning` has no `stripped[]`, no `source`, and does not list `INPUT_MARKUP_STRIPPED` | This is the exact payload the tool exists to render |
| W-002 | No `Interrupt`/`Clear` type | Low risk here (single-shot); real for any barge-in client |
| W-003 | Voice allow-list kept locally rather than derived from the enum | Deriving would silently re-admit `flux-marcus-en` on regeneration |
| W-004 | Binary audio arrives as `Blob`, undocumented, async-only | Misclassification silently drops audio |
| W-005 | `sendSpeak`/`sendFlush` do not inject `type` | Fails as a timeout pointing nowhere near the cause |

Each entry names what to look for in release notes before deleting the workaround.

## Skills modified

**None.** The goal directs using `skill-creator` to add a missing check that a
codebase's shape clearly needs; `skill-creator` is not installed (F-003, D-005).

Worth recording what would have been proposed: the review checklist's binary-format
and empty-result checks are written for CLI tools that write files, and both applied
cleanly to a server returning base64 audio over HTTP. Two of the four review
findings came from them. That generalization belongs in the skill rather than in this
repo's history, and it could not be made here.

## Still blocked

**One thing only: unit 3's video capture.** PRD §6 requires a real capture against
the deployed tool and explicitly permits no mock. The tool is deployed, but its
figures currently come from the reference upstream and are labelled as such — so a
capture made now would either show the reference label (dishonest for launch content
implying real synthesis) or require hiding it (worse). Needs F-001 resolved first.

Everything else is either done or is a flagged decision waiting on a human.

## If you pick this up next

1. Read `FLAGS.md` top to bottom — F-004 and F-005 are the two with an Aug 12 clock
   on them and neither is DevRel's to fix.
2. Get a staging host (F-001). Then the three commands in D-012, and the receipt
   label switches from `reference` to `api` with no code change.
3. Confirm the Fly org (F-002/D-011) before anyone links the staging URL publicly.
4. Do not publish the agent-operator or partner-dev pieces until F-007 and F-011
   are resolved. Everything else in `/content` is publish-ready.
