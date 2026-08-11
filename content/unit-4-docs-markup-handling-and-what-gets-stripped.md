---
unit: 4 (PRD §6)
type: Docs guide
target_persona: Any developer reading reference docs mid-implementation
keyword_lane: flux tts markup handling
status: publish-ready — 2 [verify] items open with API owners (FLAGS.md F-010)
word_count: 284 body words (PRD cites the prior draft at 269; this is a new draft)
required_cross_link: Aura → Flux migration guide (present, see below)
---

# Markup handling and what gets stripped

Flux TTS synthesizes plain text. Markup in your input is removed before synthesis
and reported back to you — it is never read aloud, and it never causes the request
to fail.

## What you receive

When input markup is removed, the connection sends a `Warning` frame:

- `code` is `INPUT_MARKUP_STRIPPED`
- `stripped` lists each removed span, with a `source` identifying the markup family

The turn's `SpeechMetadata` frame then reports `billable_character_count`: the input
character count with stripped characters removed. **Markup is not billed.**

## What has an equivalent

| Instead of | Use |
|---|---|
| Rate adjustment | The `speed` parameter, range 0.85–1.15. Values outside the range are **rejected, not clamped**. |
| Voice selection markup | The `model` parameter |
| Substitution / alias | Write the spoken form directly in the text |
| Paragraph and sentence structure | Punctuation and blank lines |

## What has no equivalent

Inline pause and pronunciation controls are unavailable during Early Access. Every
`controls_applied` count on `SpeechMetadata` is `0`. Emphasis, interpret-as,
phoneme, marker, and language-override markup have no substitute today — restructure
the text instead.

## Ordering

Markup is stripped before text normalization, so `billable_character_count`
reflects the stripped text.
<!-- [verify] 1. Confirm strip-before-normalization ordering with API owners.
     2. Confirm whether normalization can itself change the billable count after
        stripping. Neither is resolvable from the spec as written. FLAGS.md F-010. -->

## Related

- [Aura → Flux migration guide](/docs/tts-migration-aura-to-flux) — **required
  cross-link.** Note: this guide predates two breaking changes (the speed range
  narrowing and strip-with-warning markup handling). See FLAGS.md F-005.
- Warning codes reference
- Streaming TTS: `/v2/speak`

To see this against your own text, run
[BYOM](https://github.com/dg-coreylweathers/byom).
