/**
 * Static file serving with path traversal blocked (PRD §5.4).
 *
 * Separated from server.js so the traversal guard is directly testable rather
 * than only reachable through an HTTP request.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".json", "application/json; charset=utf-8"],
]);

/**
 * Resolve a request path to a file inside `root`, or return null.
 *
 * Returns null rather than throwing for anything suspicious, so the caller
 * answers 404 and reveals nothing about the filesystem layout.
 *
 * The guard is containment-based, not pattern-based: decode, resolve, then
 * verify the result is genuinely inside root. Blocklisting `..` misses encoded
 * forms (`%2e%2e`), backslashes, and absolute paths; `path.resolve` plus a prefix
 * check catches all of them because it reasons about the final location.
 */
export function resolveSafe(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }

  // NUL byte truncation guard.
  if (decoded.includes("\0")) return null;

  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, rel);

  // Must be inside root. The separator check prevents `/public-evil` matching
  // a `/public` prefix.
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) return null;

  return target;
}

export async function serveStatic(root, urlPath, res) {
  const file = resolveSafe(root, urlPath);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return true;
  }
  const ext = path.extname(file).toLowerCase();
  if (!TYPES.has(ext)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return true;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES.get(ext),
      "cache-control": "no-store",
    });
    res.end(body);
    return true;
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return true;
  }
}
