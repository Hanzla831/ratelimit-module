import { beforeEach, describe, expect, it } from 'vitest';
import { slidingWindow, tokenBucket } from '../src/algorithms.js';
import { InMemoryCounterStore } from '../src/store.js';
import type { Clock, RateLimitRule } from '../src/types.js';

function testClock(start = new Date(Date.UTC(2026, 0, 15, 12, 0, 0))) {
  let current = start;
  const clock: Clock = () => current;
  return {
    clock,
    advance: (ms: number) => void (current = new Date(current.getTime() + ms)),
    now: () => current,
  };
}

describe('sliding window', () => {
  const rule: RateLimitRule = { name: 'test', limit: 5, windowMs: 60_000 };
  let time: ReturnType<typeof testClock>;
  let store: InMemoryCounterStore;

  beforeEach(() => {
    time = testClock();
    store = new InMemoryCounterStore(time.clock);
  });

  const hit = (cost = 1) => slidingWindow(store, rule, 'k', cost, time.now());

  it('allows requests up to the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      const decision = await hit();
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(4 - i);
    }
  });

  it('denies once the limit is reached', async () => {
    for (let i = 0; i < 5; i += 1) await hit();

    const denied = await hit();
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('does not charge rejected requests', async () => {
    for (let i = 0; i < 5; i += 1) await hit();
    const before = await store.get(`k:${Math.floor(time.now().getTime() / 60_000) * 60_000}`);

    await hit();
    const after = await store.get(`k:${Math.floor(time.now().getTime() / 60_000) * 60_000}`);

    // Counting rejections would let a client extend its own lockout forever.
    expect(after).toBe(before);
  });

  it('smooths the window boundary instead of allowing a double burst', async () => {
    // Fill the window right at its end.
    time.advance(59_000);
    for (let i = 0; i < 5; i += 1) await hit();

    // One second later a fixed-window counter would reset and allow five more.
    time.advance(1_500);
    const decision = await hit();
    expect(decision.allowed).toBe(false);
  });

  it('recovers once the previous window has fully rolled off', async () => {
    for (let i = 0; i < 5; i += 1) await hit();
    time.advance(120_000);
    expect((await hit()).allowed).toBe(true);
  });

  it('honours request cost', async () => {
    expect((await hit(3)).allowed).toBe(true);
    expect((await hit(3)).allowed).toBe(false); // 3 + 3 > 5
  });
});

describe('token bucket', () => {
  const rule: RateLimitRule = {
    name: 'burst',
    algorithm: 'token-bucket',
    limit: 10,
    windowMs: 1_000,
    burst: 10,
  };
  let time: ReturnType<typeof testClock>;
  let store: InMemoryCounterStore;

  beforeEach(() => {
    time = testClock();
    store = new InMemoryCounterStore(time.clock);
  });

  const hit = (cost = 1) => tokenBucket(store, rule, 'k', cost, time.now());

  it('allows a full burst from a fresh bucket', async () => {
    for (let i = 0; i < 10; i += 1) expect((await hit()).allowed).toBe(true);
    expect((await hit()).allowed).toBe(false);
  });

  it('refills continuously rather than in steps', async () => {
    for (let i = 0; i < 10; i += 1) await hit();

    // 10 per second means one token every 100ms — no need to wait a window.
    time.advance(300);
    const decision = await hit();
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBeGreaterThanOrEqual(1);
  });

  it('never exceeds its capacity after a long idle period', async () => {
    await hit();
    time.advance(3600_000);

    let allowed = 0;
    for (let i = 0; i < 20; i += 1) if ((await hit()).allowed) allowed += 1;
    expect(allowed).toBe(10);
  });

  it('reports exactly how long until enough tokens exist', async () => {
    for (let i = 0; i < 10; i += 1) await hit();

    const denied = await hit();
    expect(denied.allowed).toBe(false);
    // One token at 10/second = 100ms, far more useful than "wait a window".
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(100);
  });

  it('charges a weighted request correctly', async () => {
    expect((await hit(7)).allowed).toBe(true);
    expect((await hit(7)).allowed).toBe(false);
    expect((await hit(3)).allowed).toBe(true);
  });

  it('allows a burst above the sustained rate', async () => {
    const bursty: RateLimitRule = {
      name: 'b',
      algorithm: 'token-bucket',
      limit: 10,
      windowMs: 1_000,
      burst: 25,
    };
    let allowed = 0;
    for (let i = 0; i < 30; i += 1) {
      if ((await tokenBucket(store, bursty, 'k2', 1, time.now())).allowed) allowed += 1;
    }
    expect(allowed).toBe(25);
  });
});

describe('counter store', () => {
  it('expires entries rather than growing forever', async () => {
    const time = testClock();
    const store = new InMemoryCounterStore(time.clock);

    await store.increment('a', 1, 1_000);
    expect(await store.get('a')).toBe(1);

    time.advance(1_001);
    expect(await store.get('a')).toBe(0);
  });

  it('does not extend the TTL on every hit', async () => {
    const time = testClock();
    const store = new InMemoryCounterStore(time.clock);

    await store.increment('a', 1, 1_000);
    time.advance(600);
    await store.increment('a', 1, 1_000);
    time.advance(500);

    // A steady stream of requests must not keep a window alive indefinitely.
    expect(await store.get('a')).toBe(0);
  });

  it('sweeps expired entries', async () => {
    const time = testClock();
    const store = new InMemoryCounterStore(time.clock);

    await store.increment('a', 1, 500);
    await store.increment('b', 1, 5_000);
    time.advance(1_000);

    expect(await store.sweep()).toBe(1);
    expect(store.size).toBe(1);
  });
});
