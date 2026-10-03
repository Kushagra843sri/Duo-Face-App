import type { NextFunction, Response } from 'express';

import type { AuthenticatedRequest } from '../types/auth';

/**
 * Fixed-window counter shared by the HTTP middleware and the realtime
 * gateway. In-memory (per server instance).
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { resetAt: number; count: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Counts one hit for `key`. */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const current = this.now();
    // Opportunistic cleanup keeps the map bounded to recently-active keys.
    if (this.windows.size > 1000) {
      for (const [k, w] of this.windows) if (w.resetAt <= current) this.windows.delete(k);
    }

    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= current) {
      entry = { resetAt: current + this.windowMs, count: 0 };
      this.windows.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= this.max, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - current) / 1000)) };
  }
}

interface Options {
  windowMs: number;
  max: number;
  /** Must derive from the server-verified identity, never client input. */
  keyFor: (req: AuthenticatedRequest) => string | undefined;
  now?: () => number;
  message?: string;
}

/**
 * Deliberately small fixed-window limiter (no dependency, no gateway).
 * In-memory, so the limit is per server instance: across N instances the
 * effective ceiling is N x max. Good enough to stop a pathological client
 * flooding Redis; a Redis-backed limiter can replace it later.
 */
export function createRateLimiter({ windowMs, max, keyFor, now = Date.now, message = 'Too many location updates. Slow down.' }: Options) {
  const limiter = new FixedWindowLimiter(windowMs, max, now);

  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const key = keyFor(req);
    if (!key) {
      next();
      return;
    }

    const result = limiter.hit(key);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({ error: 'rate_limited', message });
      return;
    }
    next();
  };
}
