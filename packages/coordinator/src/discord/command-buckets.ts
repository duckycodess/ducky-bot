import { COMMAND_BUCKETS, DuckyError } from '@ducky/contracts';

export type BucketName = keyof typeof COMMAND_BUCKETS;

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Notified when a bucket is exhausted. Fire-and-forget: a rate limit still
 * applies whether or not anybody wrote it down.
 */
export type BucketExhaustedSink = (info: { bucket: BucketName }) => void;

/**
 * Per-user token buckets for the Discord surfaces.
 *
 * **Accident containment, never an authorization control.** Authorization has
 * already happened by the time anything is charged here; a limit keeps a stuck
 * client, a fat-fingered loop or a redelivery storm from doing unbounded work.
 *
 * Most of these surfaces are owner-only and this comment used to say all of
 * them were. That stopped being true: `interaction` is shared with the
 * conversational controls and `threadCreate` is charged for whoever's message
 * opened the thread, so the configured chat user reaches both. Each bucket now
 * declares `ownerOnly` in `COMMAND_BUCKETS`, and the audit sink reads it rather
 * than assuming.
 *
 * Buckets are keyed per USER, so one person exhausting a shared bucket never
 * refuses anybody else.
 */
export class CommandBuckets {
  readonly #windows = new Map<string, Window>();
  #onExhausted: BucketExhaustedSink | undefined;

  constructor(
    private readonly now: () => number = () => Date.now(),
    onExhausted?: BucketExhaustedSink,
  ) {
    this.#onExhausted = onExhausted;
  }

  /** Attached after construction, since the store is built later. */
  onExhausted(sink: BucketExhaustedSink): void {
    this.#onExhausted = sink;
  }

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
      /**
       * The BUCKET is recorded, never the user id.
       *
       * The old reason was "these surfaces are owner-only, so the id adds
       * nothing", and that reason has expired for the two shared buckets. The
       * decision has not: a Discord id in a long-lived table is personal data,
       * the audit log records ROLES and ROUTES everywhere else for exactly
       * that reason, and "somebody hit the thread limit" is the fact an
       * operator acts on. What changed is the attribution -- a shared bucket
       * is no longer recorded as the owner's doing. See `ownerOnly`.
       */
      try {
        this.#onExhausted?.({ bucket });
      } catch {
        /* a record is never worth failing the limit */
      }
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
