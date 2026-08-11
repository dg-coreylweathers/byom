# Samples

Copy-paste inputs for BYOM. Every outcome below was **measured against
`wss://api.staging.deepgram.com`, model `flux-rufus-en`, on 2026-08-11** — not
predicted.

> ## ⚠️ Outcomes are NOT deterministic
>
> The same input does not reliably produce the same result. Measured: the inline
> control sample run 6 times returned **3 successes and 3 `NET-0000` errors** — the
> same bytes, a 50% failure rate. Plain text was stable at 6/6.
>
> So read every table below as *"this is what happened when I ran it"*, not as a
> per-tag rule. Run anything more than once before concluding anything. Failure
> modes seen for the same input include `NET-0000`, a 60s timeout with hundreds of
> audio frames and no terminator, and the connection closing mid-turn.
>
> **Plain text is the only input that behaved consistently.** See `FLAGS.md` F-012.

Two ways to run them:

**Live instance** (pointed at staging, rate-limited to 5/min per client):
```bash
BYOM=https://byom-staging.fly.dev
curl -s -X POST $BYOM/api/speak -H 'content-type: application/json' \
  -d '{"text":"Your transfer went through. Your balance is forty-two dollars."}' | jq
```
Or just open https://byom-staging.fly.dev and paste into the field.

**Locally**, if you want to run the whole set without hitting the limit:
```bash
git clone https://github.com/dg-coreylweathers/byom && cd byom && npm install
DEEPGRAM_BASE_URL=wss://api.staging.deepgram.com \
DEEPGRAM_STAGING_API_KEY=$DEEPGRAM_STAGING_API_KEY \
PER_IP_PER_MINUTE=60 GLOBAL_PER_MINUTE=60 PORT=8100 node server.js
```

---

## 1. Start here — the one that works

```
Your transfer went through. Your balance is forty-two dollars.
```

62 submitted, **62 billed, `origin: api`**, ~4.4s of audio. This is the receipt path
working end to end against the real API: `billable_character_count` read off
`SpeechMetadata`, peak measured at −0.43 dBFS so the normalize warning fires.

Use this one to confirm your setup before trying anything else.

---

## 2. Markup is SPOKEN ALOUD, and billed

Proven by transcribing BYOM's own output back through STT:

| Input | Transcript of the audio it produced |
|---|---|
| `Your balance is forty-two dollars.` | `"Your balance is $42."` |
| `<prosody rate="slow">Your balance is forty-two dollars.</prosody>` | **`"Prosody rate equals slow your balance is $42 prosody."`** |

Load the "Speaking rate" sample and press play — you can hear the tag being read.

## 3. Markup is billed, not stripped

Each of these **succeeded on the runs shown**, and each was billed for every
character including the tags. No `INPUT_MARKUP_STRIPPED` warning was emitted for any
of them. Any of these can also fail on a later attempt — see the warning above.

| Paste this | Submitted | Billed |
|---|---|---|
| `<s>Your balance is forty-two dollars.</s>` | 41 | **41** |
| `<speak>Your balance is forty-two dollars.</speak>` | 49 | **49** |
| `<prosody rate="slow">Your balance is forty-two dollars.</prosody>` | 65 | **65** |
| `Weight is <sub alias="ten kilograms">10 kg</sub> total.` | 55 | **55** |
| `Say <phoneme alphabet="ipa" ph="dip">Deepgram</phoneme> now.` | 60 | **60** |

Compare the first row against sample 1: the plain sentence is 34 characters and bills
34; wrapping it in `<s></s>` makes it 41 and bills 41. The 7 characters of markup are
charged.

**The clearest single demo** is running sample 1 and then the `<s>` row back to back.

---

## 4. Markup that kills the connection

Each of these terminated the turn with an error on the runs shown. Expect a wait —
several stream runaway audio first. `<break>` and `<emphasis>` failed on every
attempt; the others were less consistent.

| Paste this | Result |
|---|---|
| `Your balance is forty-two dollars.<break time="1s"/>` | `Error NET-0000` internal error |
| `Your balance is <emphasis>forty-two</emphasis> dollars.` | `Error NET-0000` internal error |
| `Your balance is [pause] forty-two dollars.` | `Error NET-0000` internal error |
| `Call <say-as interpret-as="telephone">5551234</say-as> today.` | Runaway — **783 audio frames**, no terminator, times out at 60s |
| `<s>Your transfer went through. Your balance is forty-two dollars.</s><break time="1s"/>` | `Error NET-0000` internal error |

That last row is the 87-character preset from the launch hook. It does not complete.

`<break>` is the one that matters most: it is the most common tag in real prompt
libraries, and it is fatal.

---

## 5. Inline controls — the documented syntax

Inline controls are escaped JSON objects in the text, per the TTS voice-controls
guide. Against Flux they either crash or are billed and ignored — and the
`{"speed"}` row is the one measured at a 50% failure rate across repeat runs.

| Paste this | Result |
|---|---|
| `Take {"word": "Deepgram", "pronounce": "ˈdiːpɡræm"} daily.` | `Error NET-0000` — the **documented** pronunciation control crashes |
| `{"speed": "0.9"} Your balance is forty-two dollars.` | Succeeds. Billed 51 of 51. `controls_applied` all zero — not applied |
| `Your balance is {"pause": "500ms"} forty-two dollars.` | Succeeds. Billed 53 of 53. `controls_applied` all zero |
| `Your balance is {pause} forty-two dollars.` | `Error DATA-0002` — "malformed inline TTS control" |

`DATA-0002` is the interesting one: it is a *proper validation error* that names the
feature, which is how we know inline controls are a real code path rather than an
unimplemented idea. `controls_applied.breaks_applied` never left zero in any run.

---

## 6. Edge cases that are fine

Worth running to see where the boundary is — these all behave sensibly.

| Paste this | Result |
|---|---|
| `Your balance is < forty-two dollars.` | Fine, billed 36. A bare `<` is not treated as markup |
| `Your balance is {{template}} dollars.` | Fine — double braces are left alone, not read as a control |
| *(900+ characters)* | Rejected client-side and server-side with the cap stated. Does not consume a rate-limit slot |
| *(voice `flux-marcus-en`)* | Rejected server-side with a reason, even hand-crafted. Excluded for reported defects |

---

## What to look at in the response

```bash
curl -s -X POST $BYOM/api/speak -H 'content-type: application/json' \
  -d '{"text":"<s>Your balance is forty-two dollars.</s>"}' \
  | jq '{submitted:.submitted.value, billed:.billed, stripped:.stripped, warnings, disagreement}'
```

- `billed.origin` — `api` means it came from `SpeechMetadata`; `local` means the tool
  computed it and says so. It is never silently one or the other.
- `stripped.origin` / `disagreement` — where the inventory came from, and any
  mismatch between the tool's local mirror and the server, shown rather than hidden.
- `wire` — every frame verbatim in protocol order. This is the thing to read when you
  do not believe a number. Note the real order: `Flushed` arrives *before* the audio
  as an acknowledgement, and `SpeechMetadata` terminates the turn.

---

## Summary of what these samples establish

Nothing that looks like markup or an inline control currently works on Flux staging.
Every input above either **reads the markup aloud to your listener while billing you
for it**, or terminates the connection. See `FLAGS.md` F-012 — this is GA-blocking and is why everything in
`/content` is on hold.
