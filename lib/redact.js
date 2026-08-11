/**
 * Outbound error-message scrubbing.
 *
 * Exists because a test caught a real leak: the 502 handler interpolated the
 * upstream error message verbatim, and an upstream failure can legitimately carry
 * the credential — an auth error that echoes the token, or a transport error that
 * includes a URL with the key in a query parameter.
 *
 * "The key never leaves the server" has to hold on the error path too, and the
 * error path is the one nobody exercises by hand. So this is applied to every
 * message that crosses the boundary rather than only where a leak is expected.
 */

const REDACTED = "[redacted]";

/**
 * Credential-shaped patterns, scrubbed even when the value is not the key we
 * hold. An upstream error can carry a request-scoped token we never had.
 */
const PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bToken\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(?:api[-_]?key|access[-_]?token|secret)["'\s:=]+[A-Za-z0-9._~+/-]{8,}=*/gi,
  // Key material in a URL query string.
  /([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi,
];

/**
 * Scrub `secrets` (exact values) and credential-shaped patterns from `message`.
 *
 * Exact secrets are removed first and unconditionally — pattern matching is a
 * backstop, not the primary defence, because a key that does not look
 * credential-shaped still must not escape.
 */
export function redact(message, secrets = []) {
  let out = typeof message === "string" ? message : String(message ?? "");

  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    // Split/join rather than a built regex: the secret is untrusted input and
    // must not be interpreted as a pattern.
    out = out.split(secret).join(REDACTED);
  }

  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix) => (prefix ? `${prefix}${REDACTED}` : REDACTED));
  }

  return out;
}

/**
 * Build a client-safe message for a failed synthesis.
 *
 * Length-capped so a pathological upstream message cannot be used to push
 * unbounded content through the error channel.
 */
export function safeErrorMessage(err, secrets = []) {
  const raw = err && err.message ? err.message : "unknown error";
  const scrubbed = redact(raw, secrets);
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed;
}
