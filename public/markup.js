/**
 * The strip contract, shared verbatim by the server and the browser.
 *
 * PRD §5.2: this file is a MIRROR, not the authority. The server is the source
 * of truth. The browser imports this same file so tags can highlight live before
 * any request goes out, and so the tag inventory cannot fork between the two.
 *
 * Where this mirror and the server's reported `stripped[]` disagree, the UI shows
 * the disagreement. It never hides it and never silently prefers one side.
 *
 * Imported by Node (`server.js`, `lib/*`) and by the browser (`public/app.js`).
 * Keep it dependency-free and free of any Node or DOM global.
 */

/**
 * Advice is deliberately sparse. PRD §5.4: "what to use instead" advice is shown
 * only where actually verified; "no direct equivalent" where none exists.
 *
 * The honest state of Flux TTS at Early Access is that most SSML has no
 * equivalent. `SpeakV2SpeechMetadata.controls_applied` documents inline
 * pronunciation and pause controls as unavailable during Early Access — every
 * count is always 0 — so claiming a pause or phoneme equivalent would be wrong.
 *
 * `source` names the markup family. PRD §3 permits vendor/format names in the
 * raw payload and the wire log; they must never reach UI chrome. The UI renders
 * `label`, never `source`.
 */
const TAGS = [
  // --- Structural: safe to drop, meaning preserved by punctuation ---
  {
    name: "speak",
    kind: "element",
    source: "ssml",
    label: "Document wrapper",
    advice: "Drop it. Send the text on its own — there is no wrapper element.",
    verified: true,
  },
  {
    name: "p",
    kind: "element",
    source: "ssml",
    label: "Paragraph",
    advice:
      "Use a blank line between paragraphs. Paragraph breaks are inferred from punctuation and spacing.",
    verified: true,
  },
  {
    name: "s",
    kind: "element",
    source: "ssml",
    label: "Sentence",
    advice: "End the sentence with a period. Sentence boundaries come from punctuation.",
    verified: true,
  },

  // --- Substitution: the alias is just text, so this one has a real answer ---
  {
    name: "sub",
    kind: "element",
    source: "ssml",
    label: "Substitution",
    advice:
      'Write the spoken form directly in the text. The alias in `alias="…"` is what you want synthesized — put that.',
    verified: true,
  },

  // --- Rate: a real parameter, with a real and narrow range ---
  {
    name: "prosody",
    kind: "element",
    source: "ssml",
    label: "Prosody",
    advice:
      "Rate only: use the request's `speed` parameter, which accepts 0.85–1.15. Values outside that range are rejected, not clamped. Pitch and volume have no equivalent.",
    verified: true,
  },

  // --- Voice selection: a real parameter ---
  {
    name: "voice",
    kind: "element",
    source: "ssml",
    label: "Voice selection",
    advice: "Choose the voice with the request's `model` parameter instead.",
    verified: true,
  },

  // --- No equivalent. Say so plainly rather than inventing one. ---
  {
    name: "break",
    kind: "element",
    source: "ssml",
    label: "Pause",
    advice: null, // pause controls unavailable at Early Access
    verified: true,
  },
  {
    name: "emphasis",
    kind: "element",
    source: "ssml",
    label: "Emphasis",
    advice: null,
    verified: true,
  },
  {
    name: "phoneme",
    kind: "element",
    source: "ssml",
    label: "Phoneme",
    advice: null, // pronunciation controls unavailable at Early Access
    verified: true,
  },
  {
    name: "say-as",
    kind: "element",
    source: "ssml",
    label: "Interpret-as",
    advice: null,
    verified: true,
  },
  {
    name: "audio",
    kind: "element",
    source: "ssml",
    label: "Audio insert",
    advice: null, // not a synthesis concern at all
    verified: true,
  },
  {
    name: "mark",
    kind: "element",
    source: "ssml",
    label: "Marker",
    advice: null,
    verified: true,
  },
  {
    name: "lang",
    kind: "element",
    source: "ssml",
    label: "Language override",
    advice: null,
    verified: true,
  },
  {
    name: "w",
    kind: "element",
    source: "ssml",
    label: "Word role",
    advice: null,
    verified: true,
  },
];

const ELEMENT_NAMES = new Set(TAGS.filter((t) => t.kind === "element").map((t) => t.name));

/** Lookup by element name. Unknown elements still strip, but carry no advice. */
const BY_NAME = new Map(TAGS.map((t) => [t.name, t]));

/**
 * Matches one XML-ish element: opening, closing, or self-closing, with
 * attributes. Deliberately not a general XML parser — this mirrors what the
 * stripper does to a pasted prompt, and a pasted prompt is not guaranteed
 * well-formed. Unbalanced tags are expected input, not an error.
 */
const ELEMENT_RE = /<\s*\/?\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?\s*>/g;

/**
 * Bracketed directives — `[pause]`, `[laughs]`, `[[slnc 500]]`. Common in
 * hand-rolled and non-XML markup. Stripped, never advised on, because the
 * intended meaning is not recoverable from the token.
 */
const BRACKET_RE = /\[\[[^\]]*\]\]|\[[a-zA-Z][^\]]*\]/g;

/**
 * Curly directives — `{pause}`, `{emphasis}`. Same reasoning as brackets.
 * Intentionally does not match `{{template}}` placeholders, which belong to the
 * caller's templating layer and are none of our business.
 */
const CURLY_RE = /\{(?!\{)[a-zA-Z][^}]*\}/g;

/**
 * Strip markup and account for every character removed.
 *
 * Returns the analysis both sides render:
 *   text      — the input, unchanged
 *   clean     — what would actually be synthesized
 *   submitted — input character count
 *   billed    — projected billable count (clean length)
 *   stripped  — inventory of what was removed, in document order
 *
 * `billed` here is a PROJECTION from the mirror. The authority is
 * `SpeechMetadata.billable_character_count`. The UI must label which one it is
 * showing — PRD §5.4 requires the receipt to say explicitly when it cannot read
 * the API's number.
 */
export function analyze(text) {
  if (typeof text !== "string") {
    throw new TypeError("analyze() requires a string");
  }

  const found = [];

  const collect = (re, classify) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const entry = classify(m);
      if (entry) found.push({ ...entry, start: m.index, raw: m[0] });
      // Zero-length matches cannot happen with these patterns, but guard anyway
      // so a future pattern edit can't hang the loop.
      if (m[0].length === 0) re.lastIndex += 1;
    }
  };

  collect(ELEMENT_RE, (m) => {
    const name = m[1].toLowerCase();
    const known = BY_NAME.get(name);
    return {
      name,
      source: known ? known.source : "unknown",
      label: known ? known.label : "Unrecognized tag",
      advice: known ? known.advice : null,
      known: Boolean(known),
    };
  });

  collect(BRACKET_RE, () => ({
    name: "bracket",
    source: "bracketed-directive",
    label: "Bracketed directive",
    advice: null,
    known: true,
  }));

  collect(CURLY_RE, () => ({
    name: "curly",
    source: "curly-directive",
    label: "Curly directive",
    advice: null,
    known: true,
  }));

  found.sort((a, b) => a.start - b.start);

  // Remove by recorded span rather than re-running replace(), so that the
  // character accounting and the produced text cannot disagree. Overlapping
  // matches are impossible across these patterns, but a later match starting
  // inside an earlier one would be skipped rather than double-counted.
  let clean = "";
  let cursor = 0;
  const stripped = [];
  for (const entry of found) {
    if (entry.start < cursor) continue; // contained in a previous match
    clean += text.slice(cursor, entry.start);
    cursor = entry.start + entry.raw.length;
    stripped.push(entry);
  }
  clean += text.slice(cursor);

  return {
    text,
    clean,
    submitted: text.length,
    billed: clean.length,
    stripped,
  };
}

/**
 * Compare the mirror's inventory against the server's reported `stripped[]`.
 * PRD §5.2/§5.4: disagreement is surfaced, not hidden.
 *
 * Returns `{ agrees, reason }`. `reason` is null when they agree.
 */
export function compareWithServer(mirror, serverStripped) {
  if (!Array.isArray(serverStripped)) {
    return { agrees: false, reason: "server reported no stripped inventory" };
  }
  if (serverStripped.length !== mirror.stripped.length) {
    return {
      agrees: false,
      reason: `mirror found ${mirror.stripped.length} span(s), server reported ${serverStripped.length}`,
    };
  }
  const mineRaw = mirror.stripped.map((s) => s.raw);
  const theirsRaw = serverStripped.map((s) => (s && typeof s.raw === "string" ? s.raw : ""));
  for (let i = 0; i < mineRaw.length; i += 1) {
    if (mineRaw[i] !== theirsRaw[i]) {
      return { agrees: false, reason: `span ${i + 1} differs from the server's` };
    }
  }
  return { agrees: true, reason: null };
}

/** Exposed for tests and for the UI's tag legend. */
export const inventory = TAGS.map((t) => ({ ...t }));
export const elementNames = [...ELEMENT_NAMES];
