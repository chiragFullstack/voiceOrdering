/**
 * Fixed-window rate limiting, per client.
 *
 * Cheap protection against a runaway client or a scripted flood. It is
 * per-process and in-memory, matching the session store: good enough for a
 * single-instance deployment, and the obvious thing to move to Redis if this
 * ever runs on more than one box.
 */

import { config } from './config';

interface Window {
  count: number;
  resetAt: number;
}

const GLOBAL_KEY = Symbol.for('smash-and-go.rate-limiter');

function getWindows(): Map<string, Window> {
  const container = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Map<string, Window> };
  container[GLOBAL_KEY] ??= new Map();
  return container[GLOBAL_KEY];
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly limit: number;
}

export function checkRateLimit(clientKey: string): RateLimitVerdict {
  const windows = getWindows();
  const now = Date.now();
  const limit = config.rateLimitMaxRequests;
  const windowMillis = config.rateLimitWindowSeconds * 1000;

  // Opportunistic cleanup keeps the map bounded without a second timer.
  if (windows.size > 10_000) {
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
  }

  const existing = windows.get(clientKey);
  if (!existing || existing.resetAt <= now) {
    windows.set(clientKey, { count: 1, resetAt: now + windowMillis });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0, limit };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      limit,
    };
  }

  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0, limit };
}

/**
 * Best-effort client identity.
 *
 * Proxy headers are attacker-controlled, so this is a throttling key only — it
 * is never used for authorisation, and nothing in this app is authorised by IP.
 */
export function clientKeyFromRequest(request: Request): string {
  try {
    const forwarded = request.headers.get('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    return first || request.headers.get('x-real-ip') || 'unknown';
  } catch {
    // No readable headers means no per-client identity; throttle as one bucket.
    return 'unknown';
  }
}
