import { DuckyError, RUNTIME_LOCK_HEARTBEAT_MS } from '@ducky/contracts';
import { acquireRuntimeLock, type Db, type RuntimeLockHandle } from '@ducky/persistence';

/**
 * Takes the coordinator's place as THE writer of this database.
 *
 * The importer takes the same lock, and it cannot while this process holds it,
 * which is what makes "stop the coordinator before importing" something the
 * machine enforces rather than something an operator asserts. A coordinator in
 * turn refuses to start while an import is in progress, or while another
 * coordinator is live on the same database.
 *
 * Throws, so a start-up that cannot be the sole writer fails loudly at boot
 * instead of two writers discovering each other later.
 */
export function takeCoordinatorLock(db: Db): RuntimeLockHandle {
  const out = acquireRuntimeLock(db, 'coordinator');
  if (!out.ok) {
    throw new DuckyError(
      'invalid_input',
      `A live ${out.heldBy} is already writing this database. Stop it first; two writers are never safe.`,
    );
  }
  // A previous coordinator that died in the middle of a deletion left its cause row
  // behind. Holding the lock, nobody is deleting, so any row here is stale and would
  // mislabel the next deletion that reaches a tombstone trigger. Clear it.
  db.prepare('DELETE FROM deletion_context').run();
  return out.handle;
}

export interface HeartbeatTimers {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

/**
 * Keeps the lock fresh on a timer of its OWN.
 *
 * The reconcile interval is operator-configurable and can be set longer than the
 * lock's stale window, which would let a perfectly healthy coordinator lose its
 * lock between two reconciles; the heartbeat period is fixed and short instead.
 * When a beat finds the lock has been taken over, `onLost` runs once and the
 * timer stops: this process is no longer the writer and must not go on as one.
 * Returns a function that stops the timer.
 */
export function startLockHeartbeat(
  handle: RuntimeLockHandle,
  onLost: () => void,
  timers: HeartbeatTimers = {
    set: (fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref();
      return t;
    },
    clear: (h) => clearInterval(h as NodeJS.Timeout),
  },
  everyMs: number = RUNTIME_LOCK_HEARTBEAT_MS,
): () => void {
  let stopped = false;
  const timer = timers.set(() => {
    if (stopped) return;
    let alive = false;
    try {
      alive = handle.heartbeat();
    } catch {
      alive = false;
    }
    if (!alive) {
      stopped = true;
      timers.clear(timer);
      onLost();
    }
  }, everyMs);
  return () => {
    stopped = true;
    timers.clear(timer);
  };
}
