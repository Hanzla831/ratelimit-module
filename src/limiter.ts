import { slidingWindow, tokenBucket } from './algorithms.js';
import { InMemoryCounterStore, type CounterStore } from './store.js';
import {
  DEFAULT_ALGORITHM,
  systemClock,
  type Clock,
  type ConsumeRequest,
  type RateLimitDecision,
  type RateLimitRule,
  type RateLimitTier,
} from './types.js';

export interface RateLimiterOptions {
  store?: CounterStore;
  clock?: Clock;
  /**
   * What to do when the store itself fails.
   *
   * `open` keeps serving traffic — correct for a general API, where a Redis
   * blip should not take the product down. `closed` rejects — correct for
   * login or payment endpoints, where the limiter is a security control and
   * failing open is an invitation.
   */
  onStoreError?: 'open' | 'closed';
  /** Keys that bypass limiting entirely: health checks, internal callers. */
  allowlist?: readonly string[];
}

export class RateLimiter {
  private readonly store: CounterStore;
  private readonly clock: Clock;
  private readonly onStoreError: 'open' | 'closed';
  private readonly allowlist: Set<string>;
  private readonly tiers = new Map<string, RateLimitTier>();

  constructor(options: RateLimiterOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.store = options.store ?? new InMemoryCounterStore(this.clock);
    this.onStoreError = options.onStoreError ?? 'open';
    this.allowlist = new Set(options.allowlist ?? []);
  }

  /** Registers a named tier, e.g. `free` or `pro`. */
  tier(tier: RateLimitTier): this {
    this.tiers.set(tier.name, tier);
    return this;
  }

  getTier(name: string): RateLimitTier | null {
    return this.tiers.get(name) ?? null;
  }

  /**
   * Applies one rule.
   *
   * The rule name is part of the storage key, so two rules on the same
   * identity ("10 per second" and "1000 per hour") keep independent counters
   * instead of silently sharing one.
   */
  async consume(rule: RateLimitRule, request: ConsumeRequest): Promise<RateLimitDecision> {
    const now = request.now ?? this.clock();
    const cost = request.cost ?? 1;

    if (this.allowlist.has(request.key)) {
      return {
        allowed: true,
        rule: rule.name,
        limit: rule.limit,
        remaining: rule.limit,
        resetAt: new Date(now.getTime() + rule.windowMs),
        retryAfterMs: null,
      };
    }

    const key = `rl:${rule.name}:${request.key}`;
    const algorithm = rule.algorithm ?? DEFAULT_ALGORITHM;

    try {
      return algorithm === 'token-bucket'
        ? await tokenBucket(this.store, rule, key, cost, now)
        : await slidingWindow(this.store, rule, key, cost, now);
    } catch {
      return {
        allowed: this.onStoreError === 'open',
        rule: rule.name,
        limit: rule.limit,
        remaining: 0,
        resetAt: new Date(now.getTime() + rule.windowMs),
        retryAfterMs: this.onStoreError === 'closed' ? rule.windowMs : null,
      };
    }
  }

  /**
   * Applies every rule in a tier.
   *
   * All rules are evaluated rather than stopping at the first denial, so the
   * returned decision is the *most restrictive* one and the headers describe
   * the limit the client actually hit.
   */
  async consumeTier(tierName: string, request: ConsumeRequest): Promise<RateLimitDecision> {
    const tier = this.tiers.get(tierName);
    if (!tier || tier.rules.length === 0) {
      const now = request.now ?? this.clock();
      return {
        allowed: true,
        rule: 'none',
        limit: Number.POSITIVE_INFINITY,
        remaining: Number.POSITIVE_INFINITY,
        resetAt: now,
        retryAfterMs: null,
      };
    }

    const decisions = await Promise.all(
      tier.rules.map((rule) => this.consume(rule, request)),
    );

    const denied = decisions.find((decision) => !decision.allowed);
    if (denied) return denied;

    // Report the rule closest to exhaustion, so a client watching the headers
    // sees the constraint that will actually bite first.
    return decisions.reduce((tightest, decision) =>
      decision.remaining < tightest.remaining ? decision : tightest,
    );
  }

  /**
   * Clears a key budget — for support unblocking a customer, or tests.
   *
   * Takes the whole rule rather than just its name because the two algorithms
   * store differently: a token bucket lives at the base key, while a sliding
   * window is split across per-window keys that have to be computed. Deleting
   * only the base key would silently leave a client still throttled.
   */
  async reset(rule: RateLimitRule, key: string): Promise<void> {
    const base = `rl:${rule.name}:${key}`;
    const windowStart =
      Math.floor(this.clock().getTime() / rule.windowMs) * rule.windowMs;

    await Promise.all([
      this.store.reset(base),
      this.store.reset(`${base}:${windowStart}`),
      this.store.reset(`${base}:${windowStart - rule.windowMs}`),
    ]);
  }
}

/**
 * Normalises an IP into a limiting key.
 *
 * IPv6 is truncated to its /64 prefix: a single subscriber is routinely handed
 * a whole /64, so limiting on the full address lets one client rotate through
 * billions of addresses and bypass the limit entirely.
 */
export function ipKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!address.includes(':')) return address;

  const groups = address.split(':');
  return groups.slice(0, 4).join(':') + '::/64';
}
