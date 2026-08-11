# SDK_WATCH

Every place this repo hand-rolls around a gap in the official SDK. Each entry
names the file, the gap, and the specific thing to look for in the SDK's release
notes before deleting the workaround.

Checked against **`@deepgram/sdk` v5.7.0** — latest published as of 2026-08-11
(local clone at `~/code/deepgram-js-sdk`, HEAD `1b690ca` 2026-08-04, "Adding more
unit tests for speak v2").

**What the SDK already covers, and is therefore NOT hand-rolled here:** opening
the `/v2/speak` connection (`client.speak.v2.createConnection`), binary audio
frame delivery, and the typed frames `Connected`, `Close`, `Error`,
`SessionMetadata`, `SpeechStarted`, `Speak`, `Flush`, `Flushed`, `Warning`,
`SpeechMetadata` — including `SpeechMetadata.billable_character_count`, which
PRD §5.4 requires and which needs no workaround.

---

## W-001 — `SpeakV2Warning` cannot carry the markup-stripping payload

**File:** `lib/frames.js`

**Gap.** The SDK's typed Warning frame is:

```ts
interface SpeakV2Warning {
    type: "Warning";
    code: string;
    description: string;
}
```

Three fields. The payload BYOM exists to display has neither of the two parts it
needs:

- **No `stripped[]` array.** PRD §5.4 requires the stripped inventory to read
  from the API's `stripped[]` array. There is no typed field for it.
- **No `source` field.** PRD §3 and §5.4 require `source` to be readable in the
  wire log and never in UI chrome. There is no typed field for it.

The `code` field is a bare `string`, and the docstring enumerates the Early
Access codes as `NO_ACTIVE_SPEECH` and `SYNTHESIS_RETRYING` only —
**`INPUT_MARKUP_STRIPPED` is not in the SDK's enumeration at all.**

**Workaround.** `lib/frames.js` parses the raw Warning frame itself, reading
`stripped[]` and each entry's `source` off the untyped JSON rather than the
typed interface, and narrows on `code === "INPUT_MARKUP_STRIPPED"` by string
comparison. The SDK connection is still what delivers the frame; only the field
extraction is hand-rolled. Extraction is defensive — a Warning arriving without
`stripped[]` degrades to the local mirror with a visible disagreement flag
(PRD §5.4) rather than throwing.

**Before removing, check release notes for:** a `stripped` field added to
`SpeakV2Warning`, an entry shape carrying `source` / `raw` / `replacement`, or
`INPUT_MARKUP_STRIPPED` added to the documented warning-code set. Any of the
three means re-checking this file; all three means deleting most of it.

**Related:** FLAGS.md F-006 — the spec's own `INPUT_MARKUP_STRIPPED` example is
arithmetically wrong (87/62 delta of 25 against `raw` strings totalling 31). The
typed surface being incomplete and the documented example being wrong are
probably the same underlying gap: this warning code has not been through the same
review pass as its neighbours, which is also why it is missing a severity.

---

## W-002 — No Interrupt or Clear frame type

**File:** `lib/frames.js`

**Gap.** The build goal names "handling Flush/Interrupt" as SDK-covered. Only
half is. `SpeakV2Flush` and `SpeakV2Flushed` exist; there is no `SpeakV2Interrupt`
and no `SpeakV2Clear` anywhere in
`src/api/resources/speak/resources/v2/types/`.

**Workaround.** BYOM is a single-shot diagnostic — it sends one `Speak`, one
`Flush`, and reads to `Flushed`. It has no barge-in, so it needs no Interrupt on
the happy path. `lib/frames.js` therefore recognises an inbound Interrupt-shaped
frame for the wire log only, so the log stays a faithful verbatim record if the
server ever sends one, and does not construct outbound Interrupt messages.

**Consequence, and why this is low-risk here but not generally:** any future tool
built on this transport that *does* need barge-in has to hand-roll the outbound
message. That is a real gap for conversational use — it just isn't one for this
diagnostic.

**Before removing, check release notes for:** `SpeakV2Interrupt` or
`SpeakV2Clear` types, or a documented barge-in method on the v2 speak client.

---

## W-004 — Binary audio arrives as a `Blob` under Node, undocumented and async-only

**File:** `lib/flux.js` (`isBinaryFrame`, `byteLengthOf`, `toBuffer`)

**Gap.** `setupBinaryHandling` (`CustomClient.ts:969-1002`) passes non-string
`event.data` through untouched. Under Node that turns out to be a **`Blob`** —
confirmed empirically against the reference upstream: 11 of 11 audio frames
arrived as `Blob`, never Buffer or ArrayBuffer. Nothing in the typed surface says
so, and `SpeakV2Socket`'s message type does not model binary frames at all.

**Why it is worth a permanent entry.** This fails in a genuinely dangerous way.
`Blob.type` is the empty string, so any control-frame check of the form
`typeof msg.type === "string"` classifies audio as a control frame. The PCM is
dropped, no error is raised, and the report still renders — with a 44-byte
header-only WAV. A receipt that looks complete and contains no audio is a worse
outcome than a crash, and for this tool specifically it would undermine the exact
claim it exists to make.

**Workaround.** `isBinaryFrame()` checks Blob first, then Buffer / ArrayBuffer /
ArrayBuffer view, and the check runs *before* any control-frame handling.
`byteLengthOf()` reads `Blob.size` synchronously so the wire log needs no await.
Frames are pushed to the queue unconverted and normalized in `finish()` via
`Promise.all`, because `Blob.arrayBuffer()` is async and converting inline could
reorder audio. Two regression tests cover the classification and the ordering.

**Before removing, check release notes for:** a typed binary-message channel on
the v2 speak socket, a documented `binaryType`, or a normalization helper that
hands back Buffers. Until then, keep accepting all four shapes — guessing wrong
loses audio silently rather than erroring.

---

## W-005 — `sendSpeak`/`sendFlush` do not set the `type` discriminator

**File:** `lib/flux.js` (the `open` handler)

**Gap.** Not an SDK defect — a JS-caller trap worth recording because it cost
real debugging time here. `sendSpeak()` and `sendFlush()` pass their argument
straight to `sendJson()` without injecting `type`
(`.../speak/resources/v2/client/Socket.ts:75-83`). `type` is a required field of
`SpeakV2Speak` / `SpeakV2Flush`, so TypeScript enforces it — but this project is
plain JS, where nothing does.

**How it fails.** Silently and confusingly. `socket.sendSpeak({ text })` opens
fine, the server accepts the frame, and it replies with `NO_ACTIVE_SPEECH`
"unhandled message type" warnings instead of synthesizing. There is no error and
no `Flushed`, so the turn simply never completes and the call times out. The
symptom (a timeout) points nowhere near the cause (a missing string field).

**Workaround.** Send `{ type: "Speak", text }` and `{ type: "Flush" }` explicitly,
and send the *same object* that is written to the wire log so the two cannot
drift.

**Before removing:** nothing to remove. Revisit only if the SDK starts injecting
the discriminator, at which point passing it explicitly stays harmless.

---

## W-003 — Voice catalog is typed but the shipping set is unverified against WER guidance

**File:** `lib/voices.js`

**Gap.** Not an SDK defect — a data disagreement the SDK lets us detect. The SDK
types the full `flux-*` catalog in `src/api/types/Deepgram.ts` (12 voices), which
is what made it possible to prove that 4 of the 6 voices in launch WER guidance
do not exist. See FLAGS.md F-004.

**Workaround.** `lib/voices.js` keeps its own allow-list rather than deriving the
voice list from the SDK enum directly, because it must additionally *exclude*
`flux-marcus-en` server-side (PRD §5.3 — reported defects; rejected even on a
hand-crafted request). Deriving straight from the enum would silently re-admit
marcus the moment the enum is regenerated.

**Before removing, check release notes for:** voices added to or removed from the
catalog, and specifically whether `flux-marcus-en` is withdrawn upstream — at
which point the local exclusion becomes redundant rather than load-bearing.
