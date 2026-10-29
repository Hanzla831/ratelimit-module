import { describe, expect, it } from 'vitest';
import { RateLimiter, ipKey } from '../src/limiter.js';
import { InMemoryCounterStore, type CounterStore } from '../src/store.js';
import type { Clock, RateLimitRule } from '../src/types.js';

function testClock(start = new Date(Date.UTC(2026, 0, 15, 12, 0, 0))) {
  let current = start;
  const clock: Clock = () => current;
  return { clock, advance: (ms: number) => void (current = new Date(current.getTime() + ms)) };
}

const rule: RateLimitRule = { name: 'r', limit: 3, windowMs: 60_000 };

describe('rule isolation', () => {
  it('keeps separate counters per key', async () => {
    const limiter = new RateLimiter({ clock: testClock().clock });

    for (let i = 0; i < 3; i += 1) await limiter.consume(rule, { key: 'alice' });
    expect((await limiter.consume(rule, { key: 'alice' })).allowed).toBe(false);
    // One client exhausting its budget must not affect another.
    expect((await limiter.consume(rule, { key: 'bob' })).allowed).toBe(true);
  });

  it('keeps separate counters per rule', async () => {
    const limiter = new RateLimiter({ clock: testClock().clock });
    const other: RateLimitRule = { name: 'other', limit: 3, windowMs: 60_000 };

    for (let i = 0; i < 3; i += 1) await limiter.consume(rule, { key: 'k' });
    // "10 per second" and "1000 per hour" must not share one counter.
    expect((await limiter.consume(other, { key: 'k' })).allowed).toBe(true);
  });

  it('resets a key on demand', async () => {
    const limiter = new RateLimiter({ clock: testClock().clock });
    for (let i = 0; i < 3; i += 1) await limiter.consume(rule, { key: 'k' });

    await limiter.reset(rule, 'k');
    expect((await limiter.consume(rule, { key: 'k' })).allowed).toBe(true);
  });
});

describe('allowlist', () => {
  it('bypasses limiting entirely', async () => {
    const limiter = new RateLimiter({ clock: testClock().clock, allowlist: ['monitor'] });

    for (let i = 0; i < 50; i += 1) {
      expect((await limiter.consume(rule, { key: 'monitor' })).allowed).toBe(true);
    }
  });
});

describe('tiers', () => {
  const limiter = () =>
    new RateLimiter({ clock: testClock().clock })
      .tier({
        name: 'free',
        rules: [
          { name: 'free-second', algorithm: 'token-bucket', limit: 2, windowMs: 1_000, burst: 2 },
          { name: 'free-hour', limit: 100, windowMs: 3600_000 },
        ],
      })
      .tier({ name: 'pro', rules: [{ name: 'pro-second', limit: 50, windowMs: 1_000 }] });

  it('applies every rule in the tier', async () => {
    const rl = limiter();
    expect((await rl.consumeTier('free', { key: 'k' })).allowed).toBe(true);
    expect((await rl.consumeTier('free', { key: 'k' })).allowed).toBe(true);
    // The per-second rule bites long before the hourly one.
    expect((await rl.consumeTier('free', { key: 'k' })).allowed).toBe(false);
  });

  it('reports the rule closest to exhaustion', async () => {
    const decision = await limiter().consumeTier('free', { key: 'k' });
    // The hourly rule has 99 left; the per-second one has 1, so that is what
    // the client needs to see in its headers.
    expect(decision.rule).toBe('free-second');
  });

  it('gives different tiers different budgets', async () => {
    const rl = limiter();
    for (let i = 0; i < 5; i += 1) await rl.consumeTier('free', { key: 'k' });
    expect((await rl.consumeTier('pro', { key: 'k' })).allowed).toBe(true);
  });

  it('allows everything for an unknown tier', async () => {
    expect((await limiter().consumeTier('enterprise', { key: 'k' })).allowed).toBe(true);
  });

  it('exposes registered tiers', () => {
    expect(limiter().getTier('free')?.rules).toHaveLength(2);
    expect(limiter().getTier('nope')).toBeNull();
  });
});

describe('store failure policy', () => {
  const brokenStore: CounterStore = {
    increment: async () => {
      throw new Error('redis down');
    },
    get: async () => {
      throw new Error('redis down');
    },
    getBucket: async () => {
      throw new Error('redis down');
    },
    setBucket: async () => {
      throw new Error('redis down');
    },
    reset: async () => {},
    sweep: async () => 0,
  };

  it('fails open by default so an outage does not take the API down', async () => {
    const limiter = new RateLimiter({ store: brokenStore, clock: testClock().clock });
    expect((await limiter.consume(rule, { key: 'k' })).allowed).toBe(true);
  });

  it('fails closed when the limiter is a security control', async () => {
    // For login or payments, failing open is an invitation.
    const limiter = new RateLimiter({
      store: brokenStore,
      clock: testClock().clock,
      onStoreError: 'closed',
    });
    const decision = await limiter.consume(rule, { key: 'k' });
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(rule.windowMs);
  });
});

describe('ipKey', () => {
  it('passes IPv4 through', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('unwraps IPv4-mapped IPv6', () => {
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('truncates IPv6 to its /64 prefix', () => {
    // A single subscriber is routinely handed a whole /64; limiting on the
    // full address lets one client rotate through billions of them.
    expect(ipKey('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe('2001:db8:1234:5678::/64');
    expect(ipKey('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1234:5678::/64');
  });

  it('handles a missing address', () => {
    expect(ipKey(undefined)).toBe('unknown');
  });
});

describe('cost weighting', () => {
  it('charges expensive requests more', async () => {
    const limiter = new RateLimiter({ clock: testClock().clock });
    const budget: RateLimitRule = { name: 'c', limit: 10, windowMs: 60_000 };

    expect((await limiter.consume(budget, { key: 'k', cost: 5 })).allowed).toBe(true);
    expect((await limiter.consume(budget, { key: 'k', cost: 5 })).allowed).toBe(true);
    expect((await limiter.consume(budget, { key: 'k', cost: 1 })).allowed).toBe(false);
  });
});
