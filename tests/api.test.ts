import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { InMemoryCounterStore } from '../src/store.js';
import type { Clock } from '../src/types.js';

function build(start = new Date(Date.UTC(2026, 0, 15, 12, 0, 0))) {
  let current = start;
  const clock: Clock = () => current;
  const store = new InMemoryCounterStore(clock);
  return {
    ...createApp({ store, clock }),
    advance: (ms: number) => void (current = new Date(current.getTime() + ms)),
  };
}

describe('rate limit headers', () => {
  it('reports the budget on successful responses', async () => {
    const { app } = build();
    const response = await request(app).get('/api/items').set('x-api-key', 'k1').expect(200);

    // Visible before a 429, so a well-behaved client can slow down in time.
    expect(response.headers['ratelimit-limit']).toBeDefined();
    expect(Number(response.headers['ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
    expect(response.headers['ratelimit-reset']).toBeDefined();
    expect(response.headers['ratelimit-policy']).toContain(';w=');
  });

  it('decrements remaining across requests', async () => {
    const { app } = build();
    const first = await request(app).get('/api/items').set('x-api-key', 'k2').expect(200);
    const second = await request(app).get('/api/items').set('x-api-key', 'k2').expect(200);

    expect(Number(second.headers['ratelimit-remaining'])).toBeLessThan(
      Number(first.headers['ratelimit-remaining']),
    );
  });
});

describe('throttling', () => {
  it('returns 429 with Retry-After once the burst is spent', async () => {
    const { app } = build();
    for (let i = 0; i < 15; i += 1) {
      await request(app).get('/api/items').set('x-api-key', 'burst');
    }

    const limited = await request(app).get('/api/items').set('x-api-key', 'burst').expect(429);
    expect(limited.body.error.code).toBe('rate_limited');
    // Never 0 — that would tell the client to retry immediately.
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('isolates one API key from another', async () => {
    const { app } = build();
    for (let i = 0; i < 15; i += 1) {
      await request(app).get('/api/items').set('x-api-key', 'noisy');
    }

    await request(app).get('/api/items').set('x-api-key', 'noisy').expect(429);
    await request(app).get('/api/items').set('x-api-key', 'quiet').expect(200);
  });

  it('gives a pro caller a larger budget', async () => {
    const { app } = build();
    for (let i = 0; i < 15; i += 1) {
      await request(app).get('/api/items').set('x-api-key', 'pro-user').set('x-plan', 'pro');
    }
    await request(app)
      .get('/api/items')
      .set('x-api-key', 'pro-user')
      .set('x-plan', 'pro')
      .expect(200);
  });

  it('charges a search more than a cheap read', async () => {
    const { app } = build();
    // Cost 5 each, so the 15-token burst is gone in three requests.
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/api/search?q=x').set('x-api-key', 'searcher');
    }
    await request(app).get('/api/search?q=x').set('x-api-key', 'searcher').expect(429);
  });

  it('skips the status endpoint entirely', async () => {
    const { app } = build();
    for (let i = 0; i < 40; i += 1) {
      await request(app).get('/api/status').set('x-api-key', 'watcher').expect(200);
    }
  });

  it('recovers as the bucket refills', async () => {
    const { app, advance } = build();
    for (let i = 0; i < 16; i += 1) await request(app).get('/api/items').set('x-api-key', 'r');
    await request(app).get('/api/items').set('x-api-key', 'r').expect(429);

    advance(1_000); // 10 tokens per second
    await request(app).get('/api/items').set('x-api-key', 'r').expect(200);
  });
});

describe('login protection', () => {
  it('locks out after five attempts on the same account', async () => {
    const { app } = build();
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/login').send({ email: 'victim@example.com' }).expect(200);
    }
    await request(app).post('/login').send({ email: 'victim@example.com' }).expect(429);
  });

  it('does not lock out a different account from the same IP', async () => {
    const { app } = build();
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/login').send({ email: 'victim@example.com' });
    }
    // Keyed on IP *and* account, so one attacker cannot lock out everyone
    // behind a shared NAT.
    await request(app).post('/login').send({ email: 'someone@example.com' }).expect(200);
  });
});

describe('health', () => {
  it('lists configured tiers', async () => {
    const { app } = build();
    const response = await request(app).get('/health').expect(200);
    expect(response.body.tiers).toEqual(['free', 'pro']);
  });

  it('404s an unknown endpoint', async () => {
    await request(build().app).get('/nope').expect(404);
  });
});
