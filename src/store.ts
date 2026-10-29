import { systemClock, type Clock } from './types.js';

/**
 * Counter storage.
 *
 * The in-memory implementation is per-process, which means behind N replicas
 * the effective limit is N times what was configured. That is the single most
 * common rate-limiting bug in production, so the interface is deliberately
 * shaped to port directly onto Redis: `increment` maps to `INCRBY` plus
 * `PEXPIRE`, `getBucket`/`setBucket` to a hash.
 */
export interface CounterStore {
  /** Atomically adds `amount` and returns the new total for the window. */
  increment(key: string, amount: number, ttlMs: number, now?: Date): Promise<number>;
  /** Reads a window total without changing it. */
  get(key: string, now?: Date): Promise<number>;
  /** Token-bucket state: remaining tokens and when they were last refilled. */
  getBucket(key: string, now?: Date): Promise<{ tokens: number; refilledAt: Date } | null>;
  setBucket(key: string, tokens: number, refilledAt: Date, ttlMs: number): Promise<void>;
  reset(key: string): Promise<void>;
  /** Clears expired entries; the real stores do this themselves. */
  sweep(now?: Date): Promise<number>;
}

interface Entry {
  value: number;
  refilledAt?: Date;
  expiresAt: number;
}

export class InMemoryCounterStore implements CounterStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly clock: Clock = systemClock) {}

  async increment(key: string, amount: number, ttlMs: number, now = this.clock()): Promise<number> {
    const existing = this.live(key, now);
    const value = (existing?.value ?? 0) + amount;

    this.entries.set(key, {
      value,
      // The TTL is set once per window, not extended on every hit — otherwise
      // a steady stream of requests would keep a window alive forever and the
      // limit would never reset.
      expiresAt: existing?.expiresAt ?? now.getTime() + ttlMs,
    });
    return value;
  }

  async get(key: string, now = this.clock()): Promise<number> {
    return this.live(key, now)?.value ?? 0;
  }

  async getBucket(key: string, now = this.clock()): Promise<{ tokens: number; refilledAt: Date } | null> {
    const entry = this.live(key, now);
    if (!entry?.refilledAt) return null;
    return { tokens: entry.value, refilledAt: entry.refilledAt };
  }

  async setBucket(key: string, tokens: number, refilledAt: Date, ttlMs: number): Promise<void> {
    this.entries.set(key, {
      value: tokens,
      refilledAt,
      expiresAt: refilledAt.getTime() + ttlMs,
    });
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async sweep(now = this.clock()): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now.getTime()) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  private live(key: string, now: Date): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now.getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
