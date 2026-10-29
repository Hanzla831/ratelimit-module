/**
 * Public surface of the rate limiting module.
 *
 * The limiter and its algorithms have no HTTP dependency; only middleware.ts
 * and app.ts import Express, so the same budgets can guard a queue consumer
 * or an outbound API client.
 */
export * from './types.js';
export { InMemoryCounterStore, type CounterStore } from './store.js';
export { slidingWindow, tokenBucket } from './algorithms.js';
export { RateLimiter, ipKey, type RateLimiterOptions } from './limiter.js';
export { rateLimit, type RateLimitMiddlewareOptions } from './middleware.js';
export { createApp, DEFAULT_TIERS, LOGIN_RULE, type AppDependencies, type BuiltApp } from './app.js';
