# FLAGS

Items needing a human owner outside this build. Each entry is written to be
forwarded as-is — context included, no need to come back and ask what it meant.

Build run: 2026-08-11 · repo `byom` · Corey Weathers (DevRel)

---

## F-001 — No staging base URL exists in the build environment · 2026-08-11

**Owner needed:** whoever owns Deepgram staging endpoints (Product/Engineering)

`DEEPGRAM_STAGING_API_KEY` is available in the build environment. A staging
**host** is not — no env var supplies one, and the PRD (§3, §5.2) names
`wss://api.deepgram.com/v2/speak`, which is production.

Because every call in this build is required to target staging and never
production, live verification is halted. What that blocks and what it doesn't:

- **Blocked:** live `/v2/speak` call, real `INPUT_MARKUP_STRIPPED` payload
  capture, real `SpeechMetadata.billable_character_count` reading, the ~350ms
  dead-air and true-peak measurements against real audio, and the PRD §6 unit 3
  video capture (which requires a deployed tool and explicitly permits no mock).
- **Not blocked:** the entire build and PRD §5.4's acceptance checklist, which
  run against a mocked `/v2/speak` and need no live key.

**To unblock:** supply the staging WebSocket host. Set `DEEPGRAM_BASE_URL`; no
code change is needed. The server intentionally has no default value for it
(DECISIONS.md D-002) so that a missing config can never silently resolve to
production.

---

## F-002 — Hosting and deploy target decision is a placeholder · 2026-08-11

**Owner needed:** Corey + Product

PRD §5.5 lists repo home and deploy target as an open decision and says don't
guess. This build had to pick something to produce a working deploy, so it took
the conservative option and is flagging it rather than presenting it as settled.

**Placeholders in effect:**

| Item | Placeholder | Needs |
|---|---|---|
| Fly.io org | **`deepgram`** (deployed) | `personal` is billing-blocked (trial ended). The shared org turned out to be the conventional home — it already hosts `aura3-speaks`, `aura-comparison-app`, `agent-connection-demo-*`. Confirm this is where you want it. See D-011. |
| CDN | none configured | PRD §10 requires deploy behind a CDN |
| API key scope | **placeholder, not a real credential** | The real staging key was deliberately NOT deployed — the instance talks only to a loopback reference upstream that does not validate it (D-012). PRD §10's restricted TTS-only key is still needed at cutover. |
| Spend cap | not set | PRD §10 requires a spend cap; no value is specified anywhere in the PRD. Interim backstop only: `min_machines_running = 0` so the app scales to zero when idle. |

**Framing to use with Product, from PRD §8:** BYOM is a migration diagnostic,
not a second "try it" link — so it ships *alongside* the Playground rather than
against it. The Playground overlap is the substance of this decision.

---

## F-003 — Two named skills are not installed; skill-creator is unavailable · 2026-08-11

**Owner needed:** Corey (tooling)

The build goal directs use of `devrel-code-review` and
`deepgram-devrel-drafting`, and directs using `skill-creator` to extend a skill
that lacks needed coverage. In this environment only `devrel-review` is
installed; the other two, and `skill-creator` itself, are absent.

Substitutions are logged in DECISIONS.md D-005. The consequence worth a human's
attention: **the goal's prescribed mechanism for closing skill gaps could not be
exercised at all.** No skill was created or modified in this run. If the drafting
work here surfaced a format the DevRel skill set should cover permanently, that
needs a session where `skill-creator` is present.

---

## F-004 — Launch WER voice guidance names four voices that do not exist · 2026-08-11

**Owner needed:** Product/Engineering — and this is time-critical before Aug 12 GA

This is PRD §8's voice-guidance discrepancy, now with evidence. It is worse than
the PRD states.

Launch guidance recommends **meghan, rufus, conor, wes** for lowest WER and says
avoid **brittany, marcus**.

The shipping 12-voice catalog (`@deepgram/sdk` v5.7.0,
`src/api/types/Deepgram.ts`) is: alexis, bruce, cole, drew, haley, heather,
jack, marcus, priya, renee, rufus, sharon.

**Four of the six names in the guidance — meghan, conor, wes, brittany — are not
in the shipping catalog.** Only rufus and marcus are, and marcus is
independently flagged as defective (PRD §5.3), which leaves exactly one usable
name out of four recommendations.

**Why this is urgent:** WER ranking has to be re-run against shipping voice
names before Aug 12. As the PRD notes, this affects every team producing launch
audio, not just this cluster — anyone following current guidance is picking
voices that cannot be synthesized.

BYOM defaults to `flux-rufus-en` and rejects `flux-marcus-en` server-side, which
is correct under both old and new guidance, so this does not block this build.

---

## F-005 — Aura→Flux migration guide should be reopened before GA · 2026-08-11

**Owner needed:** Corey + Greg (joint ticket, per PRD scope)

Verbatim from PRD §8, forwarded unresolved as instructed. The guide shipped
Jul 14. Two breaking changes post-date it:

1. Speed range narrowed to 0.85–1.15, **rejected rather than clamped** — locked
   Jul 23
2. Markup handling shipped as strip-with-warning

The guide is reportedly the highest-read page of the launch for current
customers, and the GA changelog is scheduled to link it. Recommendation is to
reopen before GA. Explicitly out of scope for this build (PRD §4) — not touched.

Related dependency inside this build: PRD §6 unit 4 (docs guide) is required to
cross-link this guide. That cross-link is in place, which means unit 4 currently
points at a page with two known-stale breaking changes.

---

## F-006 — Two spec documentation findings · 2026-08-11

**Owner needed:** Product/Engineering

From PRD §8, forwarded unresolved.

1. **The spec's example `INPUT_MARKUP_STRIPPED` payload does not add up.** It
   shows an 87/62 delta of 25 characters, but the two `raw` strings in it total
   31 characters. BYOM's default preset is arithmetically correct and can
   replace the example in the docs — offered, not assumed.

2. **`INPUT_MARKUP_STRIPPED` is missing a severity** in the warning-codes table.
   Every adjacent code has one.

---

## F-007 — Agent-operator persona is not in the canonical persona reference · 2026-08-11

**Owner needed:** Corey (content strategy)

The build goal directs drafting an agent-operator persona piece and flagging its
unvalidated status. Done — the draft exists in `/content`.

**The unvalidated part:** PRD §7 derives from [Developer journey by persona
archetype](https://app.notion.com/p/368a615b8fd781db8660fdfb0889e117), which
defines **six** archetypes: Curious dev, Explorer, Builder, Scaler, Champion,
Partner dev. Agent-operator is not among them, and PRD §7's acceptance criteria
require every piece to name a target persona and entry point drawn from that
reference.

So the agent-operator draft is the only piece in `/content` whose target persona
has no canonical definition behind it — its entry point and agentic shift are
inferred by this build, not sourced. **It should not ship until either the
persona reference adds the archetype or the piece is retargeted at one of the
six.** Everything else in §7 maps to a defined archetype.

---

## F-008 — Server contract: can one turn emit multiple SpeechMetadata frames? · 2026-08-11

**Owner needed:** API owners — same group already receiving F-006; fold into that
thread rather than opening a new one.

Raised by the code review (REVIEW.md, Needs human). BYOM takes last-write-wins on
`billable_character_count` when more than one `SpeechMetadata` frame arrives in a
turn. That is correct for the single-shot request it makes — one `Speak`, one
`Flush` — and would be wrong for a multi-turn session.

The question: **does the server ever emit more than one `SpeechMetadata` per turn,
and if so, are the counts per-turn or cumulative?** This cannot be answered from
the client repo.

**Not blocking this build** — the multi-turn path is unreachable in BYOM. It
matters for anyone building a conversational client on the same transport, which is
why it is worth answering once, in writing.

The Flux edge case documented on the STT side (repeated `StartOfTurn`, empty
transcripts) suggests the speak side deserves the same explicit treatment.

---

## F-009 — Unit 2 `[verify]`: free-credit amount and signup terms · 2026-08-11

**Owner needed:** Corey, or whoever owns console signup copy

PRD §6 lists two `[verify]` items on unit 2 (the blog). One is now closed: the repo
URL is `https://github.com/dg-coreylweathers/byom`.

The other cannot be closed from this repo or the spec: **the current free-credit
amount and signup terms.** The draft deliberately says "check current terms on the
console" rather than naming a figure, so it is publishable as-is — but if you want a
specific number in the copy, someone has to supply the current one. Marked inline in
the draft with an HTML comment so it is visible to an editor and invisible in render.

Guessing here would be worse than omitting: a stale credit figure in launch copy is
the kind of error a developer notices at exactly the wrong moment.

---

## F-010 — Unit 4 `[verify]`: markup/normalization pipeline ordering · 2026-08-11

**Owner needed:** API owners — same thread as F-006 and F-008

PRD §6 requires confirming two pipeline-ordering points with API owners before the
docs guide ships. Neither is resolvable from the spec as written:

1. **Is markup stripped before text normalization?** The guide currently states that
   it is, because `billable_character_count` is documented as "the input character
   count with stripped control characters removed," which implies stripping precedes
   the count. That is an inference, not a confirmation.
2. **Can normalization itself change the billable count after stripping?** If it can,
   the guide's ordering statement is incomplete and the arithmetic developers derive
   from it will occasionally be wrong.

The draft is otherwise publish-ready. These are marked inline as HTML comments.

---

## F-011 — Partner-dev piece: partner and gap need confirming · 2026-08-11

**Owner needed:** Corey (content strategy) + whoever tracks partner integration state

PRD §7 says the partner-dev piece must pick a real, current partner gap rather than
a hypothetical one, and names three candidates to check: the LiveKit plugin flush
issue, and the .NET and Rust SDK threads in flight.

The draft targets **LiveKit, on the flush-behavior gap**, chosen because a flush gap
and a dropped-informational-frame gap are the same class of problem — a plugin layer
mediating connection-level protocol — so one note addresses both honestly.

**What could not be verified from this repo:** whether that LiveKit flush issue is
currently open, its state, and whether .NET or Rust is actually the more urgent gap.

**Do not publish until confirmed.** By PRD §7's own acceptance criteria this draft
fails the "real, current gap" check on its own evidence, and it says so in its
reviewer notes. If the real gap is .NET or Rust, sections 2–4 port directly; only the
framing and the flush section need rewriting.

---

## 🚨 F-012 — Markup is not stripped on staging. It is BILLED, and some tags crash synthesis. · 2026-08-11

**Owner needed:** Flux TTS API owners + launch owner. **This is GA-blocking and GA is
tomorrow.** Escalate today.

The launch premise is that markup handling shipped as **strip-with-warning**. Against
`wss://api.staging.deepgram.com/v2/speak`, model `flux-rufus-en`, that is not what
happens — in either direction.

### What was measured

Same voice, same endpoint, only the input varies. `billed` is
`SpeechMetadata.billable_character_count` as reported by the API.

| Input | Submitted | Billed | Outcome |
|---|---|---|---|
| `Your balance is forty-two dollars.` | 34 | 34 | ✅ fine |
| `<s>Your balance is forty-two dollars.</s>` | 41 | **41** | ⚠️ tags **billed**, not stripped |
| `<speak>Your balance is forty-two dollars.</speak>` | 49 | **49** | ⚠️ tags **billed**, not stripped |
| `Your balance is < forty-two dollars.` | 36 | 36 | ✅ fine (bare `<` is safe) |
| `Your balance is forty-two dollars.<break time="1s"/>` | — | — | ❌ `Error NET-0000` internal error |
| `Your balance is <emphasis>forty-two</emphasis> dollars.` | — | — | ❌ `Error NET-0000` internal error |
| `Your balance is [pause] forty-two dollars.` | — | — | ❌ `Error NET-0000` internal error |

### Two separate defects

**1. Markup that does not crash is billed rather than stripped.** `<s>…</s>` is 7
characters of markup, and the billable count went from 34 to 41 — the exact tag
length. **Customers are being charged for markup that the launch says is free.**
No `INPUT_MARKUP_STRIPPED` warning is emitted, so they have no way to notice.

**2. `<break>`, `<emphasis>`, and bracketed directives return `NET-0000`, "The
server encountered an internal error."** Before erroring, the connection streams
runaway audio — one measured case produced **44 seconds of audio for a
62-character sentence**, then errored at 42.8s. An internal error on ordinary
input is a stability problem, not just a feature gap.

`<break>` failing is the worst case of the three: it is the single most common tag in
real prompt libraries.

### Also not observed on staging, contrary to the spec

- **No `Warning` / `INPUT_MARKUP_STRIPPED` frame, ever** — not even for the inputs
  that succeed and are billed for their tags.
- **No `SessionMetadata` frame at all.** `Connected` carries `model_name`,
  `model_version`, `model_uuids` and no `sample_rate`.
- **`Flushed` is an acknowledgement, not a completion signal.** It arrives ~2ms after
  `Flush` is sent and up to 4s before audio finishes. `SpeechMetadata` is the real
  terminator. This is undocumented and is an easy way to build a client that closes
  the socket before receiving any audio — it cost this build a debugging cycle.
- **~350ms of head dead air was NOT reproducible.** PRD §5.3 treats it as a known
  defect; measured trim on staging was 0ms across every successful run. Either it is
  fixed or it was never in this path. Worth confirming before the launch notes repeat
  it.
- **Output headroom IS confirmed.** Measured peak 0.00 to −0.43 dBFS, i.e. at or
  fractionally under full scale. The normalize warning is warranted.

### Reproduce

```
git clone https://github.com/dg-coreylweathers/byom && cd byom && npm install
DEEPGRAM_BASE_URL=wss://api.staging.deepgram.com \
DEEPGRAM_STAGING_API_KEY=<staging key> node server.js
# then POST any of the inputs from the table above to /api/speak
```
Or use the deployed instance: https://byom-staging.fly.dev — it is pointed at
staging and shows the verbatim wire log for every request.

### Consequence for this cluster

**All BYOM content is on hold.** Every piece in `/content` asserts strip-with-warning
behavior and states that markup is not billed. Both claims are currently false on
staging. Publishing on Aug 12 would ship documentation of behavior the API does not
have, on the exact topic the launch is about. See `content/README.md`.

The tool itself is correct and is what produced this table — it is a diagnostic, and
it found that the thing it was built to demonstrate does not work yet.
