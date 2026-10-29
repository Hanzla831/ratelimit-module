import type { CounterStore } from './store.js';
import type { RateLimitDecision, RateLimitRule } from './types.js';

/**
 * Sliding-window counter.
 *
 * A naive fixed window lets a client send `limit` requests at 00:59 and
 * another `limit` at 01:00 — double the intended rate across two seconds. This
 * weights the previous window by how much of it still overlaps the current
 * one, which smooths that boundary at the cost of a small approximation.
 *
 *   estimate = previous * (overlap / windowMs) + current
 */
export async function slidingWindow(
  store: CounterStore,
  rule: RateLimitRule,
  key: string,
  cost: number,
  now: Date,
): Promise<RateLimitDecision> {
  const windowStart = Math.floor(now.getTime() / rule.windowMs) * rule.windowMs;
  const currentKey = `${key}:${windowStart}`;
  const previousKey = `${key}:${windowStart - rule.windowMs}`;

  const elapsed = now.getTime() - windowStart;
  const overlap = 1 - elapsed / rule.windowMs;

  const previous = await store.get(previousKey, now);
  const current = await store.get(currentKey, now);
  const estimate = previous * overlap + current;

  const resetAt = new Date(windowStart + rule.windowMs);

  if (estimate + cost > rule.limit) {
    return {
      allowed: false,
      rule: rule.name,
      limit: rule.limit,
      remaining: Math.max(0, Math.floor(rule.limit - estimate)),
      resetAt,
      retryAfterMs: Math.max(0, resetAt.getTime() - now.getTime()),
    };
  }

  // Only a permitted request consumes budget. Counting rejected ones would let
  // a client that keeps hammering extend its own lockout indefinitely.
  const total = await store.increment(currentKey, cost, rule.windowMs * 2, now);

  return {
    allowed: true,
    rule: rule.name,
    limit: rule.limit,
    remaining: Math.max(0, Math.floor(rule.limit - (previous * overlap + total))),
    resetAt,
    retryAfterMs: null,
  };
}

/**
 * Token bucket.
 *
 * Tokens refill continuously at `limit / windowMs` and the bucket holds at
 * most `burst`. A client that has been idle may spend the whole bucket at
 * once, then settles to the sustained rate — which is what makes it suitable
 * for APIs with naturally uneven traffic.
 */
export async function tokenBucket(
  store: CounterStore,
  rule: RateLimitRule,
  key: string,
  cost: number,
  now: Date,
): Promise<RateLimitDecision> {
  const capacity = rule.burst ?? rule.limit;
  const ratePerMs = rule.limit / rule.windowMs;

  const existing = await store.getBucket(key, now);
  let tokens = existing ? existing.tokens : capacity;

  if (existing) {
    const elapsed = Math.max(0, now.getTime() - existing.refilledAt.getTime());
    tokens = Math.min(capacity, tokens + elapsed * ratePerMs);
  }

  // Time until the bucket is full again, for the reset hint.
  const resetAt = new Date(now.getTime() + Math.ceil((capacity - tokens) / ratePerMs));

  if (tokens < cost) {
    const deficit = cost - tokens;
    return {
      allowed: false,
      rule: rule.name,
      limit: capacity,
      remaining: Math.floor(tokens),
      resetAt,
      // Exactly how long until enough tokens exist — more useful to a client
      // than "wait for the window to end".
      retryAfterMs: Math.ceil(deficit / ratePerMs),
    };
  }

  const left = tokens - cost;
  await store.setBucket(key, left, now, rule.windowMs * 2);

  return {
    allowed: true,
    rule: rule.name,
    limit: capacity,
    remaining: Math.floor(left),
    resetAt,
    retryAfterMs: null,
  };
}
