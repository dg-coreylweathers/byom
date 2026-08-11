# Review: byom (local repo), BYOM Flux TTS migration diagnostic

Classification: **code** (no customer-facing docs in the diff; the README is
reviewed under the code checklist's §8 developer-messaging lens)
Verdict: **approve-with-nits** — all four findings below were fixed in this run
and are covered by tests. One item is routed to a human (see Needs human).

Reviewed: `server.js`, `lib/*.js`, `public/*.js`, `tools/reference-upstream.js`,
`test/*.js`. Reviewer of record: Corey. Review run 2026-08-11.

## INTENT

Ship a diagnostic that proves markup-stripping and migration-cost claims by
demonstration, per `BYOM-flux-tts-prd.md` §5. Must not change: the API key stays
server-side and out of git history; every call targets staging and must be
structurally unable to reach production; no vendor or competitor name in UI,
copy, or alt text; submitted text is held for the request only, never logged or
persisted. Gated by Aug 12 Flux TTS GA. Temporary: no — this is a launch artifact
intended to stay up.

## Blocking

### [B1] Lockfile did not record `ws` as a root dependency

**Summary.** `ws` was added to `package.json` without regenerating
`package-lock.json`, so the lockfile's root dependency set listed only the SDK.

**Description.** `ws` was added with `npm pkg set`, which edits `package.json` and
does not touch the lockfile. `npm ls` still resolved cleanly and the test suite
passed, because `ws` was already present in the tree as a transitive dependency of
`@deepgram/sdk`. That masked the problem: `npm ci` installs strictly from the
lockfile, and the lockfile's `packages[""].dependencies` did not include `ws`. A
fresh CI checkout could therefore fail to install the package that
`tools/reference-upstream.js` imports directly, and the failure would appear only
in CI, not locally. Checklist §1 treats a stale lockfile as must-not-merge.

**Expected.** `package-lock.json` records every declared root dependency, and
`npm ci` reproduces a working tree from the lockfile alone.
**Observed.** Root dependencies recorded as `{"@deepgram/sdk":"^5.7.0"}` only;
`ws` present in the tree solely by transitive luck.

**Fix applied.** Regenerated the lockfile and verified `npm ci` resolves from it
alone after deleting `node_modules`. Root deps now
`{"@deepgram/sdk":"^5.7.0","ws":"^8.21.3"}`.

### [B2] An audio-less turn returned 200 with a header-only WAV

**Summary.** If the endpoint completed a turn but no audio frames arrived, the
server returned a successful report containing a 44-byte WAV.

**Description.** `synthesize()` resolved on `Flushed` regardless of whether any
binary frames had been collected. `Buffer.concat([])` yields an empty buffer,
`toWav()` wraps it in a valid 44-byte header, and the response carried HTTP 200
with correct character accounting, a real-looking duration field, and no audio.
Checklist §4 is explicit: empty-result paths must fail loudly and never write a
header-only artifact while reporting success.

This is not a hypothetical. It is the exact symptom the Blob-misclassification bug
produced earlier in this build (`SDK_WATCH.md` W-004) — audio was being dropped
and the report still rendered as complete. That cause was fixed; the guard against
the *class* of failure was not added until this review. For a tool whose entire
claim is that its numbers and audio are real, a silently empty result is worse
than an error.

**Expected.** A turn producing no audio fails with a clear error.
**Observed.** HTTP 200, a complete-looking receipt, and 44 bytes of audio.

**Fix applied.** `lib/flux.js` now rejects when `chunks.length === 0`, and again if
the decoded buffer is zero-length. Two tests cover both paths.

### [B3] No README on a repo intended to be public

**Summary.** The repo had no README, so anyone landing on it — including the
audience for the planned build-teardown piece — got nothing.

**Description.** Checklist §8 treats developer-facing messaging as blocking rather
than cosmetic. This repo is slated to go public and to be linked from launch
content as a forkable artifact, and it has two required environment variables with
non-obvious semantics (both intentionally lacking defaults) plus a bundled
reference upstream that is easy to mistake for a real synthesizer. None of that
was discoverable.

**Expected.** A README covering what the tool is, how to run it, both required env
vars and why they have no defaults, and how to run it with no endpoint available.
**Observed.** No README present.

**Fix applied.** Added `README.md`. Two tests assert it documents both variables
and carries no vendor name.

## Should-fix

### [S1] Encoding was hardcoded in two places with nothing coupling them

**Summary.** The request asked for `linear16` in `lib/flux.js` while
`lib/wav.js` independently hardcoded PCM format code 1 and 16 bits per sample.

**Description.** The two constants agreed, so output was correct — but nothing
enforced that. Changing the requested encoding would leave the WAV header
declaring PCM over data that isn't PCM. Checklist §3 names this as a blocking-class
trap when live (format code 1 is wrong for mulaw, which is 7, and alaw, which is 6)
because it ships audio that plays as noise while every other signal looks healthy:
byte count right, duration right, report complete. Here it was latent rather than
live — one edit away rather than broken today — hence should-fix, not blocking.

Related and already correct: sample rate *is* derived from `SessionMetadata` rather
than assumed, which is the other half of §3's derived-not-hardcoded check.

**Expected.** The container's declared format cannot disagree with the requested
encoding.
**Observed.** Two independent hardcoded constants, coupled only by coincidence.

**Fix applied.** `lib/wav.js` gained an `ENCODINGS` table and exports
`DEFAULT_ENCODING`, which `lib/flux.js` now uses for the request. An unmapped
encoding throws with a message saying explicitly not to fall back to PCM. Tests
assert both the throw and the linear16 → format-code-1 mapping.

## Nits

### [N1] `console.log` on startup prints the resolved host

**Summary.** Startup logs the base URL.

**Expected/Observed.** Same axis: an operator should be able to confirm which
environment the process is pointed at, and can. Flagged only to record that it was
considered and is intentional — the host is exactly the thing worth logging, and
no credential is included. Verified by test that submitted text and the key never
reach stdout/stderr.

**Fix.** None. Keep.

## Verified (evidence)

| Claim | Result | Evidence |
|---|---|---|
| Key never reaches the client | PASS | Tests assert absence from `/api/config`, success responses, and error responses. The error path was a real leak caught by test, fixed with `lib/redact.js`. |
| Key never lands in git history | PASS | `git log -p --all` scanned against both `DEEPGRAM_STAGING_API_KEY` and `DEEPGRAM_API_KEY` — absent from all commits. `.gitignore` excluded `.env` before the first commit. |
| Cannot reach production | PASS | `validateBaseUrl` rejects `api.deepgram.com` / `agent.deepgram.com` outright and requires the var with no default, because the SDK's own fallback is production (`CustomClient.ts:1118-1120`). |
| No vendor names in UI/copy | PASS | `test/ui.test.js` scans all shipped `public/` files plus the README. Caught two real instances in my own CSS comments. |
| Submitted text not logged or persisted | PASS | Test patches `process.stdout.write`/`stderr.write` and asserts the text never appears; also asserted absent from `/api/config`. |
| Unknown/typo/bare-prefix voice handling | PASS | `resolveVoice` returns distinct messages for excluded vs unknown; `flux-marcus-en` rejected even on a hand-crafted request. Explicit default rather than implicit fallback. |
| WAV header byte-correct | PASS | Asserted field by field: RIFF/WAVE/data tags, format code, channels, sample rate, block align, bits per sample, chunk sizes. |
| Sample rate derived, not assumed | PASS | Read from `SessionMetadata.sample_rate`. |
| Connection lifecycle on error paths | PASS | Close before `Flushed` rejects rather than resolving with partial audio; `settled` guard makes `finish()` idempotent against duplicate `Flushed`/`close`. |
| Rejected requests don't consume quota | PASS | Verified across five rejection kinds. |
| Tests need no live service | PASS | 81 tests; mocked endpoint plus the bundled reference upstream. |

## Needs human

**Multiple `SpeechMetadata` frames in one turn.** The Flux edge case the checklist
names (repeated `StartOfTurn`, empty transcripts) is an STT-side behavior; the
speak-side analogue would be more than one `SpeechMetadata` per turn. This code
takes last-write-wins on `billable_character_count`, which is correct for the
single-shot request it makes and would be wrong for a multi-turn session.

Cannot be settled from this repo — it's a server-contract question. **Who decides:**
the API owners, same group already receiving `FLAGS.md` F-006. Worth folding into
that thread rather than opening a new one. Not blocking: BYOM sends one `Speak` and
one `Flush`, so the multi-turn case is unreachable here.

## Developer-facing messaging

What a developer experiences: they paste real markup and get a report that names
the source of every number. Where a stripped tag has no equivalent, it says "no
direct equivalent" rather than inventing advice — which matters, because at Early
Access most SSML genuinely has none, and `controls_applied` documents pause and
pronunciation controls as unavailable. Overclaiming here would be the worst
possible failure for a tool whose pitch is honesty about migration cost.

Two disclosures are surfaced rather than hidden, per PRD §5.3: the trimmed leading
silence (with the pre-roll stated, so it's clear the attack wasn't clipped) and the
true-peak reading with a normalize warning when headroom is gone.

The reference upstream is the one place where a developer could be misled, and it's
handled: it self-identifies, and figures derived from it are labelled
reference-reported with an explicit note that it is not a real synthesis. That
follows the precedent PRD §3 sets for the batch fallback's locally-computed
numbers. Recommend keeping that label non-dismissible — it currently is.
