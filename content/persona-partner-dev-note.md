---
persona: Partner dev
entry_point: Arrives through a partner framework, not through our docs
format: Short integration-specific reference note
agentic_shift: Journey shape is set entirely by the partner surface. A generic post doesn't reach them; a partner-specific reference implementation does.
keyword_lane: flux tts markup livekit plugin  (partner-scoped; no overlap with any other piece)
status: DRAFT — partner gap needs confirmation before publish (FLAGS.md F-011)
partner_selected: LiveKit (agent plugin), on the flush-behavior gap
HOLD: 🚨 Do not publish — FLAGS.md F-012. Markup is not stripped on staging; it is billed, and some tags return NET-0000. Verified 2026-08-11.
---

# Markup handling when you're driving Flux TTS from an agent plugin

If you reach Flux TTS through an agent framework rather than calling `/v2/speak`
yourself, markup handling has one wrinkle that the direct-integration docs won't
tell you: **you may never see the warning frame.**

## The problem

Markup stripping is reported over the wire, as a `Warning` frame with code
`INPUT_MARKUP_STRIPPED`. The billable count arrives on `SpeechMetadata`.

Both are *connection-level* events. A plugin layer sits between you and that
connection, and most plugin layers surface audio and errors while dropping
informational frames — because for most purposes, that's the right call.

The consequence: your LLM emits text containing markup (which it will, if its
system prompt or few-shot examples contain any), the markup is silently stripped,
and you have no signal that it happened. Audio comes out clean, nothing errors, and
you never learn that the pause tags your prompt is carefully emitting do nothing.

This is strictly worse than the direct-integration case, where the warning is
visible if you look for it.

## What to do about it

### 1. Check whether your plugin surfaces the warning

Before assuming anything, look for whether informational frames reach you at all —
an event, a callback, a debug-level log. If they do, subscribe and log
`INPUT_MARKUP_STRIPPED` with the `source` values. If they don't, that's a gap worth
filing upstream; it's a small change on the plugin side and it saves every
downstream user the same discovery.

### 2. Strip on your side, deliberately

Do not rely on server-side stripping as your markup strategy. Strip in your own
layer before the text reaches the plugin, so that:

- You know it happened, because you did it
- You can log what you removed
- Your token accounting and your billable-character accounting agree
- The behavior does not change under you when the plugin version changes

The strip contract is small enough to reimplement — there's a reference
implementation in `public/markup.js` at
https://github.com/dg-coreylweathers/byom that is deliberately dependency-free and
importable from both a server and a browser.

### 3. Audit your system prompt, not just your templates

This is the partner-specific trap. In a direct integration, your markup lives in
templates you wrote. In an agent integration, **the LLM generates the text**, and it
will happily emit SSML if anything in its context suggests that's expected — a
system prompt mentioning pauses, a few-shot example containing tags, or a tool
description that shows marked-up output.

So the audit target is different: check your system prompt and your examples, not
only your static templates. A single tag in a few-shot example will reproduce itself
across every generation.

### 4. Know that pause control isn't available to route around

Inline pause and pronunciation controls are unavailable during Early Access —
`controls_applied` counts are always zero. If your agent's design depends on
inserting pauses, that has to be solved at the text level or with turn boundaries,
not with markup. Worth knowing before you build the prompt around it.

## Flush behavior, while you're here

Related and easy to conflate: flush semantics differ between calling the endpoint
directly and going through a plugin. If you're seeing turns that never complete, or
audio that arrives after you expected the turn to be over, that's a flush question
rather than a markup question — but both surface as "the connection did something I
didn't expect," so they get diagnosed together.

Confirm what your plugin sends on turn end, and whether it waits for the
corresponding acknowledgement before considering the turn complete.

---

## Notes for reviewers — not for publication

**The partner selection needs confirming before this ships.** PRD §7 says to start
with whichever partner has an open Flux TTS integration gap, and names three
candidates to check: the LiveKit plugin flush issue, and the .NET and Rust SDK
threads in flight.

This draft targets **LiveKit, on the flush-behavior gap**, because a flush gap and
a dropped-informational-frame gap are the same class of problem — a plugin layer
mediating connection-level protocol — so one note can honestly address both.

**What I could not verify:** whether that LiveKit flush issue is actually open right
now, its current state, and whether the .NET or Rust threads are the more urgent
gap. None of that is resolvable from this repo. **Do not publish until someone
confirms the partner and the gap are current** — PRD §7's acceptance criteria
require a real, current partner gap rather than a hypothetical one, and this draft
would fail that check on its own evidence. FLAGS.md F-011.

If the real gap turns out to be .NET or Rust, sections 2 through 4 port directly;
only the framing and the flush section need rewriting.
