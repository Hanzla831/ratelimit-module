/**
 * Rate limiting domain model.
 *
 * Two algorithms are provided because they answer different questions. A token
 * bucket allows a burst and then a sustained rate — right for an API a client
 * polls unevenly. A sliding window enforces "no more than N in any T", with no
 * burst allowance — right for login attempts, where the whole point is to deny
 * the burst.
 */

export type Algorithm = 'token-bucket' | 'sliding-window';

export interface RateLimitRule {
  /** Identifies the rule in headers and logs. */
  name: string;
  algorithm?: Algorithm;
  /** Requests permitted per window. */
  limit: number;
  windowMs: number;
  /**
   * Token-bucket only: how far above the sustained rate a client may burst.
   * Defaults to `limit`, which allows a full window's worth at once.
   */
  burst?: number;
}

/** Named tiers, so a paid plan is a lookup rather than a branch in a handler. */
export interface RateLimitTier {
  name: string;
  rules: RateLimitRule[];
}

export interface ConsumeRequest {
  /** Already-scoped identity: IP, user id, API key. */
  key: string;
  /**
   * How much of the budget this request spends. A search that fans out to
   * five upstream calls should not cost the same as a health check.
   */
  cost?: number;
  now?: Date;
}

export interface RateLimitDecision {
  allowed: boolean;
  rule: string;
  limit: number;
  /** Budget left after this request; never negative in the response. */
  remaining: number;
  /** When the budget fully replenishes. */
  resetAt: Date;
  /** Only set when denied — how long to wait before retrying. */
  retryAfterMs: number | null;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export const DEFAULT_ALGORITHM: Algorithm = 'sliding-window';
