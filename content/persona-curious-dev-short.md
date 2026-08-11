---
persona: Curious dev
entry_point: Sees a "wow" clip in a feed; wants to try it immediately
format: Short-form video only — no long-form companion
agentic_shift: Awareness collapses straight to first code. They don't read; they screenshot and prompt their coding agent.
keyword_lane: none — deliberately not competing for search
status: publish-ready (extends unit 3's capture)
---

# Curious dev: the second cut

## Why this is a video and not a post

This persona's journey has one shape: they see something, and within about ninety
seconds they're either typing at an agent or they've moved on. A blog post is the
wrong instrument. There is no reading step to capture.

So this is unit 3's footage, recut, with one change that matters: **the call to
action is something an agent can act on.** Not "read the docs," not "sign up" — a
prompt they can paste.

No signup gate before the magic moment. The clip has to land first.

## The cut

Same footage as unit 3. Two changes:

1. **Trim the front.** Start at the paste, no setup frame. This audience gives you
   the first half-second.
2. **Replace the closing card.** Where unit 3 holds on the receipt, this ends on
   the agent prompt.

## Closing card

Two beats, 0:08–0:10:

> **You pasted 87 characters. We billed 62.**
>
> Ask your coding agent to build this.

## Caption copy

> Paste a prompt with markup in it, get back what got stripped and what it cost.
>
> Ask your coding agent:
>
> "Build me a Node app that opens a streaming TTS connection, sends text
> containing SSML, reads the INPUT_MARKUP_STRIPPED warning frame and the
> billable_character_count from SpeechMetadata, and prints what was stripped
> against what was billed."
>
> That prompt is the whole thing. Working version in comments if you'd rather read
> it than build it.

## Why that prompt specifically

It is copy-pasteable into any coding agent and it names the four things that make
the demo work: the streaming connection, sending markup deliberately, the warning
frame, and the billable count. An agent given that prompt produces something close
to BYOM's core loop, which means the developer's first contact with the API is
*their own working code* rather than our sample.

That is the agentic shift working in our favor. The old funnel needed them to read
a tutorial. This one needs them to have a good prompt.

The repo link goes in comments as the fallback for the subset who would rather read
a reference implementation than generate one.

## What this piece must not do

- **No signup gate, no email capture, no "book a demo."** Any friction here loses
  the persona entirely.
- **No long-form companion.** If someone wants depth, unit 2 exists and the
  Champion teardown exists. Adding a post for this persona would just split the
  keyword lane with unit 2 for no gain.
- **No vendor comparison.** Not this persona's question. That's Explorer.

## Accessibility

Burned-in captions on both closing lines. Alt text as in unit 3, with the closing
card described: `Closing card reads: you pasted 87 characters, we billed 62. Ask
your coding agent to build this.`
