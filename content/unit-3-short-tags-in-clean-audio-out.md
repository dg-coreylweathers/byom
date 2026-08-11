---
unit: 3 (PRD §6)
type: Short-form video, 10s
target_persona: Curious dev (primary) + Builder (secondary)
entry_point: Feed scroll — the clip is the first contact
status: script and shot list final; NEEDS REAL CAPTURE against the deployed tool
capture_blocker: no staging endpoint yet (FLAGS.md F-001). PRD §6 explicitly permits no mock.
hook: "You pasted 87 characters. We billed 62."
HOLD: 🚨 Do not publish — FLAGS.md F-012. Markup is not stripped on staging; it is billed, and some tags return NET-0000. Verified 2026-08-11.
---

# Tags in, clean audio out

**Runtime:** 10 seconds. No voiceover. On-screen text and UI only.
**Aspect:** 9:16 primary; 1:1 crop-safe (keep all text inside the centre 80%).
**Sound:** the synthesized audio at 0:06 is the only sound. Must read with sound
off — every claim lands as on-screen text.

## Why no voiceover

The clip has to work muted in a feed. It also has to be honest: the one moment of
audio in it is real output from the tool, so a narrator talking over it would be
covering the thing the clip exists to show.

## Beat sheet

| Time | On screen | Text | Note |
|---|---|---|---|
| 0:00–0:02 | Cursor pastes a tag-heavy prompt into the empty field | *(none — let the paste read)* | Real paste, not typed. The tags must be visibly, obviously present. |
| 0:02–0:03 | Field holds the pasted text; counter ticks up | `87 characters` | Counter is live UI, not a graphic. |
| 0:03–0:04 | Submit. The ring appears and spins once | *(none)* | This is the only motion beat. Do not cut it short — it's the "something real is happening" moment. |
| 0:04–0:06 | Receipt lands. Tags strike out in sequence; the total rolls 87 → 62 | `62 billable` | **The money shot.** Both the strike-out and the roll must be legible. Shoot at 60fps so this survives platform re-encoding. |
| 0:06–0:08 | Waveform renders; audio plays | *(none)* | Real audio from the tool. Unmodified. |
| 0:08–0:10 | Hold on the receipt. Caption card | `You pasted 87 characters.` / `We billed 62.` | Two lines, sequential, not simultaneous. |

## Capture requirements

- **Real tool, real report.** No mock, no After Effects recreation of the UI. PRD §6
  is explicit about this and it's the right call — a recreated UI would be the one
  dishonest frame in a piece of content whose entire argument is "we measured it."
- **Use the default preset.** It is arithmetically correct: 87 submitted, 62
  billable, 25 stripped across three spans, and the stripped spans sum exactly to
  the delta. Do not retype it — a hand-edited variant will not add up, and the
  numbers are the content.
- **No vendor names, logos, or UI chrome from any other product in frame.** Check
  the browser tab, any bookmarks bar, and the OS dock before rolling. Full-screen
  the browser.
- **Dark theme.** The tool ships dark; matching it keeps the clip consistent with
  the rest of the launch surface.
- Record at 2x display scale, then downscale — the receipt figures are small and
  need to stay crisp after platform compression.

## Caption / description copy

> You pasted 87 characters. We billed 62.
>
> Markup gets stripped before synthesis, and you're not billed for it. This runs
> against a real prompt from your codebase and shows you exactly what came out.
>
> Repo in comments.

## Platform variants

- **Primary (9:16):** as cut.
- **Curious-dev variant:** identical footage, caption ends on *"ask your coding
  agent to build this"* with the repo link. Rationale in
  `persona-curious-dev-short.md` — this persona doesn't read a blog post, they
  screenshot and prompt.

## Accessibility

- Burned-in captions for both caption-card lines.
- Alt text: `A tag-heavy text prompt is pasted into a diagnostic tool. The character
  counter reads 87. On submit, the markup tags strike out one by one and the total
  rolls down to 62 billable characters, then a waveform renders and audio plays.`
  (No vendor name — constraint check passed.)
