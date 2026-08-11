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
| Fly.io org | `personal` | Real org call — shared `deepgram` org is the higher-consequence guess, so it was not used |
| CDN | none configured | PRD §10 requires deploy behind a CDN |
| API key scope | staging key, unrestricted | PRD §10 requires a restricted TTS-only key |
| Spend cap | not set | PRD §10 requires a spend cap; no value is specified anywhere in the PRD |

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
