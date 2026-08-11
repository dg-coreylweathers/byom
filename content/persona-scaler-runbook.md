---
persona: Scaler
entry_point: Already decided to migrate; taking it to production and hitting cost or latency walls
format: Ops runbook, not a pitch
agentic_shift: Failure mode is a cost/latency wall post-migration, not the migration decision itself
keyword_lane: flux tts prompt library audit
status: publish-ready
---

# Auditing a prompt library for markup before cutover

You've decided. This is the runbook for doing it across a corpus instead of one
template at a time.

The failure mode this prevents: cutting over, then discovering three weeks later
that 8% of your templates carry a rate value outside the accepted range and those
requests have been failing in a queue nobody watches.

## Step 1 — Inventory before you touch anything

Do not start by rewriting. Start by counting. You cannot size the work from a
sample, because markup is never evenly distributed — it clusters in whatever
templates gave someone trouble.

Extract every prompt your system can emit and run each through a strip pass,
grouping by the `source` field on each stripped span. `source` identifies the
markup family, which is what lets you tell "we have one legacy format" from "we
have four and one of them is homegrown."

What you want out of it:

- Total spans by `source`
- Distinct tag names by frequency
- Templates ranked by span count — your top 20 are most of your work
- Templates whose stripped output is empty or near-empty (these are prompts that
  were *mostly* markup, and they need rewriting, not porting)

The last one is the group people miss. A template that is 60% tags is not a
migration; it's a rewrite, and it's better to find those on day one.

## Step 2 — Pre-flight checklist

Three checks that each catch a class of production failure.

### Speed values outside 0.85–1.15

**This is the one that will actually break you.** The accepted range is 0.85 to
1.15 and out-of-range values are **rejected, not clamped**. A request with rate 0.7
fails. It does not synthesize slightly faster than you asked — it errors.

Grep your corpus for every rate value you emit, including values computed at
runtime rather than hardcoded. Runtime-computed rates are the dangerous ones,
because they don't show up in a static grep of your templates.

Decide the mapping now, in one place, and apply it before cutover:

| Current rate | Action |
|---|---|
| Within 0.85–1.15 | Pass through as `speed` |
| Outside the range | Clamp deliberately, in your code, with a logged decision — or restructure the text |

Clamping in your own layer is the right call because it's visible. Letting requests
fail and retry is not a strategy.

### Prompts depending on pause or pronunciation control

Inline pause and pronunciation controls are unavailable during Early Access —
`controls_applied` counts are always zero. Any prompt whose correctness depends on a
hard pause or a phoneme override needs a text-level solution, not a parameter.

Find these by looking for pause and phoneme tags in your inventory from step 1, then
have someone listen to the stripped version. Some will be fine. The ones that aren't
are usually disclaimers, phone numbers, and product names.

### Output headroom

Output peaks at full scale with no headroom. If you're mixing TTS output with
anything else — hold music, a notification chime, another speaker — you need to
normalize, and you need to decide that before you're debugging clipping in
production.

Measure true peak on a representative sample. If it's above −0.5 dBFS, add a
normalization stage.

## Step 3 — Reconcile billing before and after

`billable_character_count` is the input character count with stripped characters
removed, so your billable volume after cutover will be **lower** than your
character volume today, by roughly the proportion of your corpus that is markup.

Compute that ratio during step 1. Two reasons it's worth doing properly:

- It's the strongest number in your internal case for the migration, and it's
  defensible because it comes from the API rather than an estimate.
- It gives you a **cutover regression signal.** If post-cutover billable volume
  doesn't drop by roughly the predicted proportion, something is wrong — most likely
  a path that isn't going through your new client at all.

That second use is the one people don't think of, and it's the more valuable one.

## Step 4 — Instrument the warning frame in production

Do not treat `INPUT_MARKUP_STRIPPED` as a development-only signal. Log it —
counts and `source` values, never the prompt text — and alert on it *rising* after
cutover.

A rising strip rate weeks after migration means new markup is entering your prompts
from somewhere: a template someone copied from an old file, a rolled-back deploy, a
prompt-building path you didn't know existed. It's a cheap, precise regression
detector for prompt hygiene, and it costs you nothing to watch.

## Step 5 — Verify one template end to end first

Before the bulk cutover, take your single worst template — highest span count from
step 1 — and run it through the real connection. Read the actual frames: the
`Warning` with its `stripped` array, and `SpeechMetadata` with the billable count.
Confirm the numbers match what your local audit predicted.

If your prediction and the server disagree, your audit tooling has a bug, and you
want to know that on one template rather than after ten thousand.

There's an open-source diagnostic that does exactly this one-template check and
shows the raw frames: https://github.com/dg-coreylweathers/byom — it prints the
wire log verbatim, which is what you need for reconciliation.

## Checklist

- [ ] Full corpus inventoried; spans grouped by `source`
- [ ] Templates ranked by span count; top 20 reviewed by a human
- [ ] Mostly-markup templates identified and routed to rewrite, not port
- [ ] Every rate value found, including runtime-computed ones
- [ ] Out-of-range rate values given an explicit clamp decision, logged
- [ ] Pause and pronunciation dependencies listened to in stripped form
- [ ] True peak measured; normalization stage added if above −0.5 dBFS
- [ ] Predicted billable-volume drop computed and recorded as a cutover signal
- [ ] `INPUT_MARKUP_STRIPPED` logged in production with alerting on a rising rate
- [ ] Worst single template verified end to end against real frames
