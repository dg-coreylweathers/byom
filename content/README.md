# Content — BYOM launch cluster

> # 🚨 ALL CONTENT IN THIS DIRECTORY IS ON HOLD — 2026-08-11
>
> **Do not publish any of this until FLAGS.md F-012 is resolved.**
>
> Every piece here asserts two things that are **currently false** against
> `wss://api.staging.deepgram.com`, measured with the real staging key:
>
> 1. **"Markup is stripped before synthesis and reported via
>    `INPUT_MARKUP_STRIPPED`."** No such warning frame is ever emitted. Markup that
>    does not crash is passed through and **billed** — `<s>…</s>` took the billable
>    count from 34 to 41, exactly the tag length.
> 2. **"You are not billed for markup."** Customers currently are.
>
> Separately, `<break>`, `<emphasis>` and bracketed directives return
> `Error NET-0000` (internal server error), after streaming runaway audio — one case
> produced 44 seconds of audio for a 62-character sentence.
>
> The **87 → 62 hook is not reproducible against the real API today.** It is
> arithmetically correct and it is what the documented contract implies; the API just
> does not do it yet.
>
> What is verified and safe: `billable_character_count` arrives and is accurate for
> clean text, and the no-headroom output issue is real (measured 0.00 to −0.43 dBFS).
> The ~350ms head dead air was **not** reproducible and should not be repeated in
> launch notes without re-checking.
>
> Nothing here needs rewriting yet — the drafts describe the intended contract
> correctly. They need the API to match, or they need reframing as forward-looking.
> That is a call for Corey, not a copy edit.


Full drafts, not outlines. Every piece names its target persona and entry point in
its front matter, per PRD §7's acceptance criteria.

## PRD §6 — the drafted units

| # | Piece | Type | Status |
|---|---|---|---|
| 1 | The repo itself | Sample app | Shipped. Build notes live in `../DECISIONS.md`, `../SDK_WATCH.md`, `../REVIEW.md` |
| 2 | [Bring the markup you already have](unit-2-blog-bring-the-markup-you-already-have.md) | Blog, ~1,180 words | Publish-ready. 1 `[verify]` open (F-009) |
| 3 | [Tags in, clean audio out](unit-3-short-tags-in-clean-audio-out.md) | Short, 10s | Script + shot list final. **Needs real capture** — blocked on F-001 |
| 4 | [Markup handling and what gets stripped](unit-4-docs-markup-handling-and-what-gets-stripped.md) | Docs, 271 words | Publish-ready. 2 `[verify]` open (F-010). Migration-guide cross-link in place |

## PRD §7 — persona-mapped pieces

| Persona | Piece | Format | Status |
|---|---|---|---|
| Curious dev | [The second cut](persona-curious-dev-short.md) | Short-form recut, agent-actionable CTA | Publish-ready (depends on unit 3 capture) |
| Explorer | [What happens to your SSML](persona-explorer-comparison.md) | Short declarative post, ~620 words | Publish-ready |
| Builder | — | — | **No new asset.** Unit 2 *is* this persona's post, confirmed as the canonical migration piece |
| Scaler | [Auditing a prompt library before cutover](persona-scaler-runbook.md) | Ops runbook | Publish-ready |
| Champion | [How BYOM works, and what broke](persona-champion-teardown.md) | Build teardown | Publish-ready — public repo requirement satisfied |
| Partner dev | [Markup handling from an agent plugin](persona-partner-dev-note.md) | Integration note | **Draft.** Partner + gap need confirming (F-011) |
| Agent operator | [When your agent writes the markup](persona-agent-operator-UNVALIDATED.md) | Operational note | ⚠️ **Do not publish.** Persona not in the canonical reference (F-007) |

## Keyword lanes — no two pieces compete

PRD §6 requires unit 4 not to compete with unit 2. Extended across everything:

| Lane | Owner |
|---|---|
| `flux tts markup stripping` | Unit 2 (blog) — the migration narrative |
| `flux tts markup handling` | Unit 4 (docs) — the reference |
| `flux tts ssml handling` | Explorer — the "I have SSML specifically" phrasing |
| `flux tts prompt library audit` | Scaler — corpus-scale ops |
| `byom architecture` | Champion — linked-to, not searched-for |
| `flux tts markup livekit plugin` | Partner dev — partner-scoped |
| none | Curious dev (deliberately not competing for search) |
| unassigned | Agent operator (would need one only if the persona is ratified) |

## PRD §7 acceptance check

- [x] No two pieces compete for the same keyword lane or the same persona
- [x] Each piece names its target persona and entry point explicitly in front matter
- [x] Curious-dev and Explorer assets stay short — Curious dev is video-only, Explorer is ~620 words
- [x] Champion teardown links the actual repo
- [ ] Partner-dev piece picks a real, current partner gap — **cannot be verified from this repo.** Draft names LiveKit/flush and says explicitly it must not ship unconfirmed (F-011)

## Shared constraints, verified across every file

- **No vendor or competitor names.** Checked; the Explorer comparison piece is framed
  as handled-vs-unhandled rather than vendor-vs-vendor, which is both compliant and
  more durable since competitor behavior changes without notice.
- **No plural of "interruption"** in any copy or preset (PRD §5.3). Checked.
- **No letter-by-letter spelling** in any preset (PRD §5.3). Checked.
- **Speed range stated as 0.85–1.15, rejected not clamped**, everywhere it appears —
  this is the breaking change most likely to bite a migrating developer.
- **"No direct equivalent" where none exists**, never invented advice. Pause and
  pronunciation controls are described as unavailable during Early Access, consistent
  with `controls_applied` always being zero.
- **The 87 → 62 hook** is arithmetically correct and asserted by test: 87 submitted,
  62 billable, 25 stripped across three spans, and the stripped spans sum exactly to
  the delta. This is the figure offered to docs as a replacement for the spec's
  example, which does not add up (F-006).
