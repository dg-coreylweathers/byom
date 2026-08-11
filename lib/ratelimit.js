/**
 * Rate limiting, concurrency, and client identification.
 *
 * PRD §5.4 requires four things this module owns:
 *   - rate limiting
 *   - a concurrency cap
 *   - REJECTED REQUESTS DO NOT CONSUME A RATE-LIMIT SLOT
 *   - `TRUSTED_PROXY_HOPS`, `GLOBAL_PER_MINUTE`, `GLOBAL_PER_DAY` configurable via
 *     env, not hardcoded
 *
 * The third one drives the API shape. `check()` inspects without consuming and
 * `consume()` records separately, so the caller must validate the request before
 * spending a slot. A single combined `tryAcquire()` would make the required
 * behaviour easy to get wrong by accident — a malformed request would burn quota
 * and a developer debugging their own paste would rate-limit themselves out.
 */

/**
 * Placeholder values, per the build rule for decisions that depend on something
 * outside this repo. Deliberately conservative — the real numbers belong with the
 * spend cap in FLAGS.md F-002. Every one is env-overridable.
 */
const DEFAULTS = {
  GLOBAL_PER_MINUTE: 20,
  GLOBAL_PER_DAY: 500,
  PER_IP_PER_MINUTE: 5,
  MAX_CONCURRENT: 2,
  TRUSTED_PROXY_HOPS: 0,
};

function intFromEnv(env, key) {
  const raw = env[key];
  if (raw === undefined || raw === "") return DEFAULTS[key];
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function configFromEnv(env = process.env) {
  return {
    globalPerMinute: intFromEnv(env, "GLOBAL_PER_MINUTE"),
    globalPerDay: intFromEnv(env, "GLOBAL_PER_DAY"),
    perIpPerMinute: intFromEnv(env, "PER_IP_PER_MINUTE"),
    maxConcurrent: intFromEnv(env, "MAX_CONCURRENT"),
    trustedProxyHops: intFromEnv(env, "TRUSTED_PROXY_HOPS"),
  };
}

/**
 * Identify the client.
 *
 * `X-Forwarded-For` is only consulted for as many hops as we have been told to
 * trust. With the default of 0 the header is ignored entirely and the socket
 * address wins — so an unconfigured deploy cannot be spoofed into per-IP limits
 * by a forged header. Behind Fly.io this needs to be set to 1.
 */
export function clientId(req, trustedProxyHops) {
  const socketAddr = (req.socket && req.socket.remoteAddress) || "unknown";
  if (trustedProxyHops <= 0) return socketAddr;

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff !== "string" || xff.length === 0) return socketAddr;

  const chain = xff.split(",").map((s) => s.trim()).filter(Boolean);
  if (chain.length === 0) return socketAddr;

  // Count back from the right: the rightmost entries were appended by proxies we
  // trust. The one just left of them is the furthest we can believe.
  const idx = chain.length - trustedProxyHops;
  return chain[Math.max(0, Math.min(idx, chain.length - 1))] || socketAddr;
}

/**
 * Fixed-window counters. A sliding window would be better behaved at the
 * boundary; a fixed window is what a single-process diagnostic with a
 * double-digit per-minute cap actually needs, and it has no unbounded state.
 *
 * `now` is injected so tests can advance time without sleeping.
 */
export class Limiter {
  constructor(config, now = () => Date.now()) {
    this.config = config;
    this.now = now;
    this.minuteWindow = { start: 0, count: 0 };
    this.dayWindow = { start: 0, count: 0 };
    this.perIp = new Map(); // id -> { start, count }
    this.inFlight = 0;
  }

  #roll(window, spanMs) {
    const t = this.now();
    if (t - window.start >= spanMs) {
      window.start = t;
      window.count = 0;
    }
    return window;
  }

  #ipWindow(id) {
    let w = this.perIp.get(id);
    if (!w) {
      w = { start: 0, count: 0 };
      this.perIp.set(id, w);
    }
    return this.#roll(w, 60_000);
  }

  /** Drop per-IP windows that have aged out, so the Map cannot grow without bound. */
  #sweep() {
    const t = this.now();
    for (const [id, w] of this.perIp) {
      if (t - w.start >= 120_000) this.perIp.delete(id);
    }
  }

  /**
   * Inspect without consuming. Returns `{ ok, reason, retryAfterSec }`.
   * Concurrency is checked here too, so a caller can reject before doing work.
   */
  check(id) {
    if (this.inFlight >= this.config.maxConcurrent) {
      return { ok: false, reason: "too many concurrent syntheses", retryAfterSec: 5 };
    }
    const minute = this.#roll(this.minuteWindow, 60_000);
    if (minute.count >= this.config.globalPerMinute) {
      const wait = Math.ceil((60_000 - (this.now() - minute.start)) / 1000);
      return { ok: false, reason: "global per-minute limit reached", retryAfterSec: Math.max(1, wait) };
    }
    const day = this.#roll(this.dayWindow, 86_400_000);
    if (day.count >= this.config.globalPerDay) {
      return { ok: false, reason: "global daily limit reached", retryAfterSec: 3600 };
    }
    const ip = this.#ipWindow(id);
    if (ip.count >= this.config.perIpPerMinute) {
      const wait = Math.ceil((60_000 - (this.now() - ip.start)) / 1000);
      return { ok: false, reason: "per-client limit reached", retryAfterSec: Math.max(1, wait) };
    }
    return { ok: true, reason: null, retryAfterSec: 0 };
  }

  /**
   * Spend a slot. Call ONLY after the request has been validated and accepted —
   * this is the half of the API that PRD §5.4's "rejected requests do not consume
   * a rate-limit slot" depends on.
   */
  consume(id) {
    this.#roll(this.minuteWindow, 60_000).count += 1;
    this.#roll(this.dayWindow, 86_400_000).count += 1;
    this.#ipWindow(id).count += 1;
    this.#sweep();
  }

  /** Concurrency is acquired and released around the synthesis itself. */
  acquire() {
    this.inFlight += 1;
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** Snapshot for `/api/config`. Counts only — never any request content. */
  snapshot() {
    return {
      inFlight: this.inFlight,
      minuteCount: this.minuteWindow.count,
      dayCount: this.dayWindow.count,
    };
  }
}
