---
unit: 2 (PRD §6)
type: Blog post
target_persona: Builder — application developer migrating an existing TTS integration
entry_point: Actively evaluating a switch; already has markup baked into prompts
keyword_lane: flux tts markup stripping
status: publish-ready
word_count: ~1,180
hook: "You pasted 87 characters. We billed 62."
verify_open: free-credit amount / signup terms (FLAGS.md F-009)
---

# Bring the markup you already have

You pasted 87 characters. We billed 62.

That gap is the whole story of migrating a text-to-speech integration, and it is
usually the thing nobody tells you until after you've committed.

## The real cost of switching isn't the API call

If you're evaluating a TTS change, you've probably already read the latency
numbers and listened to the samples. That part is easy to evaluate — you can hear
it in an afternoon.

Here's the part you can't hear: your prompts are not clean text. They have years of
markup in them. Pause tags where a sentence needed to breathe. Emphasis on the word
that kept getting swallowed. A phoneme override for the one product name the model
never got right. Rate adjustments wrapped around the legal disclaimer.

None of that was decoration. Every tag is there because someone found a problem and
fixed it. And it's scattered across template files, database rows, prompt
constants, and a helper function somebody wrote in 2023.

So the question that actually decides whether you migrate isn't "is the new voice
better." It's: **what happens to all of that, and how much of it do I have to
rewrite?**

Most answers to that question are a blog post asserting that migration is easy.
This is not that. This is a tool that answers it against your actual text.

## What Flux TTS does with markup

Flux TTS strips markup before synthesis and tells you it did.

Send text containing tags, and the tags are removed. You get a `Warning` frame with
the code `INPUT_MARKUP_STRIPPED`, carrying an inventory of every span that was
taken out. Then you get audio of the remaining text, and a `SpeechMetadata` frame
with the billable character count for the turn.

Three things follow from that, and they're the three things worth knowing before
you plan a migration.

**You are not billed for markup.** `billable_character_count` is the input
character count with stripped characters removed. The tags cost you nothing. If
you've been budgeting your TTS spend against the full length of your templates,
your real number is lower — possibly a lot lower, if your prompts are tag-heavy.

**Nothing fails.** Markup doesn't produce an error, and it doesn't get read aloud.
Your existing prompts will synthesize on the first try. That means you can point a
staging environment at Flux TTS without touching your prompt library first, and
find out what you're dealing with before you commit engineering time.

**You get told exactly what was dropped.** This is the part that turns a vague
migration risk into a work estimate. The warning names each removed span, so you
can see whether your prompt library leans on twelve pause tags or four hundred.

## The honest part: most markup has no replacement

Here's where a vendor blog post would pivot to a migration table mapping every old
tag to a shiny new equivalent. That table doesn't exist, and pretending otherwise
would waste your time.

There are real answers for some things:

- **Rate** maps to the `speed` parameter. One caveat that will bite you if you miss
  it: the accepted range is 0.85 to 1.15, and values outside it are **rejected, not
  clamped**. If you're currently sending a rate of 0.7, that request fails rather
  than quietly synthesizing at the nearest legal value. Fix the values before you
  cut over, not after.
- **Voice selection** maps to the `model` parameter.
- **Substitution** — where you wrote an alias for how something should be spoken —
  maps to simply writing the spoken form in the text. That's what you wanted
  synthesized anyway.
- **Paragraph and sentence structure** comes from punctuation and spacing. Drop the
  structural wrappers; keep the periods.

And there are things with no equivalent today. Inline pause and pronunciation
controls are not available during Early Access — the `controls_applied` counts on
every `SpeechMetadata` frame are currently zero, by design. So if your prompts
depend on a hard 300ms pause in a specific place, or a phoneme override for a
proper noun, there is no drop-in substitute right now. That's a real constraint,
and you should know it before you plan the work rather than discovering it in
review.

Knowing which bucket each of your tags falls into is the difference between a
two-day migration and a two-week one. That's what the tool is for.

## Run it against your own prompt

BYOM — Bring Your Own Markup — takes a real prompt from your codebase and gives
you back a report:

- **The receipt.** Characters submitted, characters billed, and the difference,
  read from `SpeechMetadata.billable_character_count` rather than estimated. Every
  figure says where it came from.
- **The inventory.** Every span that was removed, with what to use instead where
  there's a real answer, and "no direct equivalent" where there isn't.
- **The audio**, with its rough edges disclosed rather than smoothed over. Leading
  silence is trimmed and the tool tells you how much. True peak is measured, and
  you get a warning when there's no headroom left — which there usually isn't.
- **The wire log.** Every frame, in protocol order, verbatim. If you don't believe
  a number, you can read the frame it came from.

Paste one template. You'll know within a minute whether your migration is a
find-and-replace or a rewrite.

## What we learned building it

Two things worth passing along, because they'll save you time.

**Read the warning frame, not just the character count.** The count tells you what
you saved. The inventory tells you what you have to fix. Those are different
questions and you need both — the first one makes the business case, the second
one makes the ticket.

**Don't trust a single number without knowing its source.** BYOM shows the
provenance of every figure for a reason: it computes its own projection locally
*and* reads the server's number, and when they disagree it shows you the
disagreement rather than picking one. Building it that way caught a real bug during
development, where audio was being silently dropped while the character accounting
still looked perfect. A report that looks complete and is quietly wrong is worse
than one that errors.

## Start here

The tool is open source. Point it at a staging environment, paste something real
from your own codebase, and read the report.

- **Repo:** https://github.com/dg-coreylweathers/byom
- **Docs:** Flux TTS markup handling — what gets stripped
- **Migrating from Aura:** see the Aura → Flux migration guide

If you're already on Deepgram, your existing credentials work. If you're not,
signing up gets you free credit to try it — check current terms on the console.
<!-- [verify] exact free-credit amount and current signup terms — not resolvable
     from this repo or the spec. FLAGS.md F-009. -->

You don't have to clean up your prompts to find out what switching costs. Bring the
markup you already have.
