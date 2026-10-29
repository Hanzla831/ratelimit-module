import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKey, type RateLimiter } from './limiter.js';
import type { RateLimitDecision, RateLimitRule } from './types.js';

export interface RateLimitMiddlewareOptions {
  rule?: RateLimitRule;
  /** Named tier; takes precedence over `rule` when both are given. */
  tier?: string | ((req: Request) => string);
  /** Defaults to the client IP, normalised to a /64 for IPv6. */
  keyGenerator?: (req: Request) => string;
  /** Per-request weight, so an expensive endpoint can cost more. */
  cost?: number | ((req: Request) => number);
  /** Skip entirely — health checks, internal traffic. */
  skip?: (req: Request) => boolean;
  onLimited?: (req: Request, decision: RateLimitDecision) => void;
}

/**
 * Standard draft-7 headers.
 *
 * Sent on allowed responses too, not only on rejections: a well-behaved client
 * should be able to slow down *before* it gets a 429, and it can only do that
 * if the remaining budget is visible while things are still fine.
 */
function setHeaders(res: Response, decision: RateLimitDecision): void {
  const resetSeconds = Math.max(0, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1000));
  res.setHeader('RateLimit-Limit', String(decision.limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, decision.remaining)));
  res.setHeader('RateLimit-Reset', String(resetSeconds));
  res.setHeader('RateLimit-Policy', `${decision.limit};w=${resetSeconds}`);
}

export function rateLimit(
  limiter: RateLimiter,
  options: RateLimitMiddlewareOptions,
): RequestHandler {
  const resolveKey = options.keyGenerator ?? ((req: Request) => ipKey(req.ip));

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (options.skip?.(req)) return next();

      const key = resolveKey(req);
      const cost = typeof options.cost === 'function' ? options.cost(req) : (options.cost ?? 1);
      const tier = typeof options.tier === 'function' ? options.tier(req) : options.tier;

      const decision = tier
        ? await limiter.consumeTier(tier, { key, cost })
        : await limiter.consume(options.rule!, { key, cost });

      setHeaders(res, decision);

      if (!decision.allowed) {
        options.onLimited?.(req, decision);

        // Retry-After is in seconds and must be at least 1: a value of 0 tells
        // the client to retry immediately, which is the opposite of the point.
        const retryAfterSeconds = Math.max(1, Math.ceil((decision.retryAfterMs ?? 0) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(429).json({
          error: {
            code: 'rate_limited',
            message: 'Too many requests',
            rule: decision.rule,
            retryAfterSeconds,
          },
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
