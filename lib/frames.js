/**
 * Frame reading for `/v2/speak`.
 *
 * The SDK delivers these frames; it does not fully type the one that matters.
 * See SDK_WATCH.md W-001 and W-002. Everything here is field extraction over the
 * raw frame, not transport.
 *
 * Checked against `@deepgram/sdk` v5.7.0:
 *   typed and used as-is  — SpeechMetadata (incl. billable_character_count),
 *                           Connected, Close, Error, SessionMetadata,
 *                           SpeechStarted, Flushed
 *   typed but incomplete  — Warning: `{type, code, description}` only. No
 *                           `stripped[]`, no `source`, and
 *                           INPUT_MARKUP_STRIPPED is absent from its documented
 *                           code set. Hand-rolled below.
 *   not typed at all      — Interrupt / Clear. Recognized for the wire log only.
 */

export const MARKUP_STRIPPED = "INPUT_MARKUP_STRIPPED";

/**
 * Pull the stripped inventory off a Warning frame.
 *
 * Defensive by requirement, not by habit: PRD §5.4 says the inventory reads from
 * the API's `stripped[]` array and falls back to the local mirror WITH A VISIBLE
 * DISAGREEMENT FLAG. So a malformed or absent array must degrade to "the server
 * told us nothing usable" rather than throw or, worse, produce a plausible empty
 * inventory that reads as "nothing was stripped."
 *
 * Returns `null` when the frame carries no usable inventory — distinct from `[]`,
 * which means the server affirmatively reported zero stripped spans.
 */
export function readStripped(frame) {
  if (!frame || typeof frame !== "object") return null;
  if (!Array.isArray(frame.stripped)) return null;

  const entries = [];
  for (const item of frame.stripped) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.raw !== "string") continue; // `raw` is the one field we cannot do without
    entries.push({
      raw: item.raw,
      // `source` names the markup family/vendor. PRD §3: fine in the raw payload
      // and the wire log, never in UI chrome. Carried through untouched; the UI
      // layer is responsible for not rendering it outside the log.
      source: typeof item.source === "string" ? item.source : null,
      replacement: typeof item.replacement === "string" ? item.replacement : null,
    });
  }
  return entries;
}

/** Is this the markup-stripping warning? String comparison — the SDK does not enumerate it. */
export function isMarkupStripped(frame) {
  return Boolean(frame) && frame.type === "Warning" && frame.code === MARKUP_STRIPPED;
}

/**
 * Read the billable count. This field IS typed by the SDK
 * (`SpeakV2SpeechMetadata.billable_character_count`) and needs no workaround —
 * but PRD §5.4 requires the receipt to say explicitly when it cannot read it, so
 * absence has to be representable rather than defaulted to a number.
 *
 * Returns `null` when unavailable. Never 0 as a stand-in for missing.
 */
export function readBillable(frame) {
  if (!frame || frame.type !== "SpeechMetadata") return null;
  const n = frame.billable_character_count;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Read the upstream's self-identification from SessionMetadata.
 *
 * A reference upstream (`tools/reference-upstream.js`) announces itself here. When
 * present, every number in the report is reference-derived and must be labelled as
 * such rather than shown as API-reported — the same rule PRD §3 applies to the
 * batch fallback's locally-computed figures.
 *
 * Returns null for a real API host, which sends no such field.
 */
export function readImplementation(frame) {
  if (!frame || frame.type !== "SessionMetadata") return null;
  return typeof frame.implementation === "string" && frame.implementation !== ""
    ? frame.implementation
    : null;
}

export function readInputCount(frame) {
  if (!frame || frame.type !== "SpeechMetadata") return null;
  const n = frame.input_character_count;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Frame types this tool understands. Anything not listed still reaches the wire
 * log verbatim — the log is a record of what arrived, not of what we recognized.
 */
export const KNOWN_TYPES = new Set([
  "Connected",
  "SpeechStarted",
  "SpeechMetadata",
  "Warning",
  "Flushed",
  "Error",
  "SessionMetadata",
  "Close",
  // Not SDK-typed. Recognized so the log can label them if the server sends them.
  // SDK_WATCH W-002.
  "Interrupt",
  "Cleared",
]);

/**
 * Normalize a frame for the wire log.
 *
 * PRD §5.4: the log shows verbatim frames in protocol order. So this records the
 * frame as received and adds only metadata *about* the record — never edits the
 * payload. `seq` establishes protocol order independent of render order.
 */
export function logEntry(seq, direction, frame, { binary = false, bytes = 0 } = {}) {
  return {
    seq,
    direction, // "recv" | "send"
    type: binary ? "audio" : (frame && frame.type) || "unknown",
    recognized: binary ? true : KNOWN_TYPES.has(frame && frame.type),
    binary,
    bytes,
    // Verbatim. The UI renders this as a technical artifact and does not
    // pretty-filter it. `source` fields inside are expected and permitted here.
    frame: binary ? null : frame,
  };
}
