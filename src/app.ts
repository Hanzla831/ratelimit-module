import express, { type Express, type Request } from 'express';
import { RateLimiter, ipKey } from './limiter.js';
import { InMemoryCounterStore, type CounterStore } from './store.js';
import { rateLimit } from './middleware.js';
import { systemClock, type Clock, type RateLimitRule, type RateLimitTier } from './types.js';

export interface AppDependencies {
  store?: CounterStore;
  clock?: Clock;
  tiers?: readonly RateLimitTier[];
  /** Resolves which tier a caller belongs to; defaults to the `x-plan` header. */
  resolveTier?: (req: Request) => string;
}

export interface BuiltApp {
  app: Express;
  limiter: RateLimiter;
  store: CounterStore;
}

/**
 * Tiers chosen to show both algorithms working together: a token bucket
 * absorbs short bursts, while a sliding window enforces the hourly ceiling.
 */
export const DEFAULT_TIERS: RateLimitTier[] = [
  {
    name: 'free',
    rules: [
      { name: 'free-burst', algorithm: 'token-bucket', limit: 10, windowMs: 1_000, burst: 15 },
      { name: 'free-hourly', algorithm: 'sliding-window', limit: 1_000, windowMs: 3600_000 },
    ],
  },
  {
    name: 'pro',
    rules: [
      { name: 'pro-burst', algorithm: 'token-bucket', limit: 100, windowMs: 1_000, burst: 200 },
      { name: 'pro-hourly', algorithm: 'sliding-window', limit: 50_000, windowMs: 3600_000 },
    ],
  },
];

/**
 * Login uses a sliding window deliberately: a token bucket would permit an
 * opening burst, and the burst is exactly what a credential-stuffing attempt
 * looks like.
 */
export const LOGIN_RULE: RateLimitRule = {
  name: 'login',
  algorithm: 'sliding-window',
  limit: 5,
  windowMs: 15 * 60_000,
};

export function createApp(deps: AppDependencies = {}): BuiltApp {
  const clock = deps.clock ?? systemClock;
  const store = deps.store ?? new InMemoryCounterStore(clock);
  const limiter = new RateLimiter({ store, clock, allowlist: ['127.0.0.1'] });

  for (const tier of deps.tiers ?? DEFAULT_TIERS) limiter.tier(tier);

  const app = express();
  app.disable('x-powered-by');
  // Trusting one hop rather than `true`: otherwise a client can spoof
  // X-Forwarded-For and mint a fresh limiting key per request.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', tiers: (deps.tiers ?? DEFAULT_TIERS).map((tier) => tier.name) });
  });

  // Credential endpoints get their own, far stricter budget, keyed on IP and
  // account together so one attacker cannot lock out every user behind a NAT.
  app.post(
    '/login',
    rateLimit(limiter, {
      rule: LOGIN_RULE,
      keyGenerator: (req) => {
        const email = String((req.body as { email?: string })?.email ?? '').toLowerCase();
        return `${ipKey(req.ip)}:${email}`;
      },
    }),
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  app.use(
    '/api',
    rateLimit(limiter, {
      tier: deps.resolveTier ?? ((req) => req.header('x-plan') ?? 'free'),
      // An API key identifies a caller far better than an IP; fall back to IP
      // only for anonymous traffic.
      keyGenerator: (req) => req.header('x-api-key') ?? ipKey(req.ip),
      // A search fans out to several upstreams, so it should not cost the same
      // as a trivial read.
      cost: (req) => (req.path.startsWith('/search') ? 5 : 1),
      skip: (req) => req.path === '/status',
    }),
    (req, res) => {
      res.json({ ok: true, path: req.path });
    },
  );

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found' } });
  });

  return { app, limiter, store };
}
