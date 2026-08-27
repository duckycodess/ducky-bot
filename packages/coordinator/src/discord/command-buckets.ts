import { COMMAND_BUCKETS, DuckyError } from '@ducky/contracts';

export type BucketName = keyof typeof COMMAND_BUCKETS;

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Per-user token buckets for the Discord surfaces.
 *
 * These surfaces are owner-only, so this is accident containment and
 * self-protection -- not an authorization control. It keeps a stuck client or a
 * fat-fingered loop from doing unbounded work.
 */
export class CommandBuckets {
  readonly #windows = new Map<string, Window>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  check(bucket: BucketName, userId: string): void {
    const spec = COMMAND_BUCKETS[bucket];
    const key = `${bucket}:${userId}`;
    const t = this.now();
    const w = this.#windows.get(key);
    if (!w || w.resetAt <= t) {
      this.#windows.set(key, { count: 1, resetAt: t + spec.windowMs });
      return;
    }
    if (w.count >= spec.max) {
      const seconds = Math.ceil((w.resetAt - t) / 1000);
      throw new DuckyError(
        'rate_limited',
        `Too many requests — try again in ${seconds}s.`,
      );
    }
    w.count += 1;
  }

  reset(): void {
    this.#windows.clear();
  }
}

/** Bounded budget for attachment downloads, independent of the command bucket. */
export class HourlyBudget {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(userId: string): void {
    const t = this.now();
    const cutoff = t - 3_600_000;
    const hits = (this.#hits.get(userId) ?? []).filter((h) => h > cutoff);
    if (hits.length >= this.max) {
      throw new DuckyError('rate_limited', 'Attachment limit reached for this hour.');
    }
    hits.push(t);
    this.#hits.set(userId, hits);
  }
}
