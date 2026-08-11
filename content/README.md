# Content — BYOM launch cluster

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
