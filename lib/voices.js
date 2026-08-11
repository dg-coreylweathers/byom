/**
 * Voice allow-list.
 *
 * PRD §5.3/§5.4: `flux-marcus-en` has reported defects — exclude it from the
 * voice list AND reject it server-side even on a hand-crafted request. Default is
 * `flux-rufus-en`.
 *
 * SDK_WATCH W-003: this list is maintained here rather than derived from the
 * SDK's `flux-*` enum on purpose. Deriving from the enum would silently re-admit
 * marcus the moment the generated types are refreshed. The exclusion has to be
 * load-bearing, not incidental.
 */

/** The shipping catalog, per `@deepgram/sdk` v5.7.0 `src/api/types/Deepgram.ts`. */
export const SHIPPING_CATALOG = [
  "flux-alexis-en",
  "flux-bruce-en",
  "flux-cole-en",
  "flux-drew-en",
  "flux-haley-en",
  "flux-heather-en",
  "flux-jack-en",
  "flux-marcus-en",
  "flux-priya-en",
  "flux-renee-en",
  "flux-rufus-en",
  "flux-sharon-en",
];

/**
 * Excluded with cause. Kept as data so the rejection can explain itself and so a
 * test can assert the reason is present, not just the exclusion.
 */
export const EXCLUDED = new Map([
  ["flux-marcus-en", "reported defects at launch; excluded from this tool"],
]);

export const DEFAULT_VOICE = "flux-rufus-en";

/** What the UI is allowed to offer. */
export const ALLOWED = SHIPPING_CATALOG.filter((v) => !EXCLUDED.has(v));

/**
 * Server-side gate. Returns `{ ok, voice, error }`.
 *
 * Rejects excluded voices and anything not in the shipping catalog. A voice that
 * is merely unknown and a voice that is known-defective get different messages,
 * because a developer hitting the second one deserves to know it was deliberate.
 */
export function resolveVoice(requested) {
  if (requested === undefined || requested === null || requested === "") {
    return { ok: true, voice: DEFAULT_VOICE, error: null };
  }
  if (typeof requested !== "string") {
    return { ok: false, voice: null, error: "voice must be a string" };
  }
  const v = requested.trim().toLowerCase();
  if (EXCLUDED.has(v)) {
    return { ok: false, voice: null, error: `${v} is excluded: ${EXCLUDED.get(v)}` };
  }
  if (!ALLOWED.includes(v)) {
    return { ok: false, voice: null, error: `unknown voice: ${v}` };
  }
  return { ok: true, voice: v, error: null };
}
