# Rate Limiting & Throttling

Request throttling for Node.js / TypeScript: token-bucket and sliding-window
algorithms, tiered quotas, cost-weighted requests, a pluggable counter store,
standard draft-7 headers, and an explicit fail-open/fail-closed policy.

The limiter has no HTTP dependency — only `middleware.ts` and `app.ts` import
Express — so the same budgets can guard a queue consumer or an outbound API
client.

```
src/
  types.ts        Rules, tiers, decisions
  store.ts        Counter storage boundary (+ in-memory implementation)
  algorithms.ts   Sliding window and token bucket
  limiter.ts      Rule resolution, tiers, allowlist, failure policy
  middleware.ts   Express guard and draft-7 headers
  app.ts          Worked wiring: login limit, tiered API, cost weighting
```

## Two algorithms, because they answer different questions

**Token bucket** allows a burst then settles to a sustained rate — right for an
API that clients poll unevenly. Tokens refill continuously, so a client that
has been idle can spend the whole bucket at once.

**Sliding window** enforces "no more than N in any T" with no burst allowance —
right for login attempts, where the burst is precisely what you want to deny.

A naive fixed window lets a client send `limit` requests at 00:59 and another
`limit` at 01:00 — double the intended rate across two seconds. The sliding
window weights the previous window by how much of it still overlaps:

```
estimate = previous × (overlap ÷ windowMs) + current
```

## Decisions worth explaining

**Rejected requests are not charged.** Counting them would let a client that
keeps hammering extend its own lockout indefinitely.

**`Retry-After` is never 0.** A zero tells the client to retry immediately,
which defeats the purpose. The token bucket computes exactly how long until
enough tokens exist — far more useful than "wait for the window to end".

**Headers are sent on success too, not only on 429.** A well-behaved client
should be able to slow down *before* it is rejected, and it can only do that if
the remaining budget is visible while things are still fine.

**The rule name is part of the storage key.** Two rules on one identity —
"10 per second" and "1000 per hour" — keep independent counters instead of
silently sharing one. A tier evaluates all its rules and reports the one
closest to exhaustion, so the headers describe the constraint that bites first.

**Fail-open vs fail-closed is a per-limiter decision.** When the counter store
is down, a general API should keep serving (a Redis blip must not take the
product down), but a login or payment endpoint should reject — there the
limiter is a security control and failing open is an invitation.

**IPv6 is truncated to its /64 prefix.** A single subscriber is routinely
handed a whole /64, so limiting on the full address lets one client rotate
through billions of addresses and bypass the limit entirely.

**Login is keyed on IP *and* account.** Keying on IP alone lets one attacker
behind a shared NAT lock out every user; keying on account alone lets a
botnet grind one account from thousands of addresses.

**Cost weighting.** A search that fans out to five upstream calls can charge
five units while a health check charges one, instead of pretending all requests
are equally expensive.

**The TTL is set once per window, not extended on every hit.** Otherwise a
steady stream of requests keeps a window alive forever and the limit never
resets.

## Running it

```bash
npm test        # 43 tests
npm run typecheck
```

Time is injected (`Clock`), so window boundaries, bucket refill and lockout
expiry are all tested with a fake clock — no sleeping, no flakes.

## Going to production

The in-memory store is per-process, which means behind N replicas the effective
limit is N× what you configured — the single most common rate-limiting bug in
production. The interface is shaped to port straight onto Redis:

| Interface | Redis |
|---|---|
| `increment` | `INCRBY` + `PEXPIRE` |
| `get` | `GET` |
| `getBucket` / `setBucket` | `HGETALL` / `HSET` |
| `reset` | `DEL` |

For strict correctness under concurrency, move the read-modify-write in
`tokenBucket` into a Lua script so the refill and the spend are atomic.
