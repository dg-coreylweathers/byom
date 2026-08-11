---
persona: Agent operator  ⚠️ NOT IN THE CANONICAL PERSONA REFERENCE
entry_point: INFERRED, not sourced — running an agent in production that generates text for synthesis
format: Operational note
status: ⚠️ DRAFT — DO NOT PUBLISH. Target persona is unvalidated. FLAGS.md F-007.
keyword_lane: none assigned — would need one only if the persona is ratified
HOLD: 🚨 Do not publish — FLAGS.md F-012. Markup is not stripped on staging; it is billed, and some tags return NET-0000. Verified 2026-08-11.
---

> **Why this file is marked unvalidated.**
>
> This piece was explicitly requested, and it is drafted in full below. But it is
> the only piece in `/content` whose target persona has no definition behind it.
>
> The canonical reference — *Developer journey by persona archetype* — defines
> **six** archetypes: Curious dev, Explorer, Builder, Scaler, Champion, Partner dev.
> **Agent operator is not among them.** PRD §7's acceptance criteria require every
> piece to name a target persona and entry point drawn from that reference, so this
> draft fails that check by construction: its entry point and agentic shift below are
> inferred by me, not sourced.
>
> **Two ways to resolve, either is fine:** ratify the archetype in the persona
> reference, or retarget this at Scaler, which is the closest existing fit — the
> overlap is production operations and cost control.
>
> **The risk of publishing as-is** is not that the content is wrong. It's that a
> seventh de-facto persona enters the content system without a definition, and the
> next person writing for "agent operators" has no shared idea of who that is. That
> is how persona-mapped content quietly stops being persona-mapped.
>
> Flagged in FLAGS.md F-007. Everything below is a complete draft, ready if the
> persona is ratified.

---

# When your agent writes the markup

You didn't put the SSML there. Your model did.

That's the difference between operating an agent in production and shipping a
templated integration, and it changes what markup handling means for you.

## Why this happens

An LLM generating text for synthesis will emit markup if anything in its context
suggests markup is expected. The usual sources, in rough order of how often they're
the culprit:

1. **A few-shot example containing tags.** The single most common cause. One example
   with a pause tag reproduces across every generation.
2. **A system prompt that mentions pacing or emphasis.** Even without showing a tag,
   asking a model to "pause for emphasis" invites it to reach for SSML, because
   that's what its training data does.
3. **Pretraining priors.** Models have seen a great deal of SSML. Ask for text that
   will be spoken aloud and some will volunteer tags unprompted.
4. **A tool or function description** whose output example is marked up.

None of these are visible in your templates, because you don't have templates. They
live in your prompt and your examples.

## What actually happens to it

Flux TTS strips markup before synthesis and reports it: a `Warning` frame with code
`INPUT_MARKUP_STRIPPED` carrying a `stripped` array, and a
`billable_character_count` on `SpeechMetadata` that excludes the stripped
characters.

So the failure is not audible. Your agent emits tags, the tags are removed, and the
audio is clean. Nothing errors. Nothing sounds wrong.

Which is precisely the problem: **your agent is spending output tokens generating
markup that is thrown away.** You pay for those tokens on the generation side, get
nothing for them on the synthesis side, and have no signal unless you look.

The synthesis side won't bill you for the tags. The generation side already did.

## What to do

### Measure the rate first

Log `INPUT_MARKUP_STRIPPED` — counts and `source` values, never the generated text —
and compute the proportion of turns in which anything was stripped.

Interpretation:

- **Near zero:** your prompt isn't inviting markup. Nothing to do.
- **A few percent:** something in your context occasionally triggers it. Worth
  finding, low urgency.
- **Consistently high:** your prompt is actively teaching the model to emit markup
  on every turn, and you are paying for it on every turn.

The last case is common and almost always traces to a single few-shot example.

### Fix the prompt, not the output

The instinct is to strip markup in a post-processing step. Do that as a safety net,
but it is not the fix — you're still paying to generate the tokens.

The fix is upstream:

- Remove tags from every few-shot example
- Drop pacing and emphasis instructions from the system prompt, since the controls
  they'd map to are unavailable anyway (see below)
- If you must instruct on delivery, instruct in terms of *word choice and sentence
  length*, which actually affect synthesized output, rather than markup, which
  doesn't

### Know what isn't available before designing around it

Inline pause and pronunciation controls are unavailable during Early Access —
`controls_applied` counts on every `SpeechMetadata` frame are zero. If your agent's
design assumes it can insert a pause or override a pronunciation, that assumption
needs replacing at the text level or with turn boundaries.

Also: the `speed` parameter accepts 0.85 to 1.15, and out-of-range values are
**rejected, not clamped**. If your agent computes a rate, clamp it in your own code.
A model asked to pick a speaking rate will cheerfully choose 0.5.

### Watch the rate as a regression signal

A rising strip rate is a prompt-drift detector. If it climbs after a deploy,
something changed in your prompt, your examples, or your model version. It's cheap
to watch and it catches a class of change that's otherwise invisible — nothing
breaks, output just quietly gets worse and more expensive.

## Check it against your real output

Take actual generated text from your agent's logs — not a hand-written example — and
run it through a diagnostic that shows the raw frames:
https://github.com/dg-coreylweathers/byom

Use real generations. Hand-written test input won't contain the markup your model
actually produces, which is the entire thing you're trying to measure.
