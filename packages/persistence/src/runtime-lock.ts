import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { RUNTIME_LOCK_STALE_MS } from '@ducky/contracts';
import type { Db } from './db.js';
import { withTransaction } from './db.js';

export type RuntimeHolder = 'coordinator' | 'importer';

export interface RuntimeLockOptions {
  /** Injected so a test can move time and declare which processes are alive. */
  readonly nowMs?: () => number;
  readonly pid?: number;
  readonly host?: string;
  readonly isPidAlive?: (pid: number) => boolean;
}

export type RuntimeLockOutcome =
  | { readonly ok: true; readonly handle: RuntimeLockHandle }
  | { readonly ok: false; readonly heldBy: RuntimeHolder };

/**
 * A process-liveness lock shared by the coordinator and the importer.
 *
 * `BEGIN IMMEDIATE` stops two writers from overlapping inside one transaction;
 * it does nothing to stop a live WAL coordinator from writing a moment after an
 * import commits, and an operator typing "I stopped it" proves nothing. This is
 * the mechanical answer: one row, naming who may write this database right now.
 *
 * A holder is LIVE when, on the same host, its process still exists; from
 * another host, when its heartbeat is fresh. A crashed holder is therefore
 * recovered at once on the same machine and within `RUNTIME_LOCK_STALE_MS`
 * elsewhere, rather than blocking everything until somebody deletes a row.
 */
export class RuntimeLockHandle {
  private released = false;

  constructor(
    private readonly db: Db,
    readonly holder: RuntimeHolder,
    private readonly token: string,
    private readonly nowMs: () => number,
  ) {}

  /** Refreshes the heartbeat. False means the lock was taken over: stop writing. */
  heartbeat(): boolean {
    if (this.released) return false;
    const info = this.db
      .prepare('UPDATE runtime_lock SET heartbeat_at = ? WHERE id = 1 AND token = ?')
      .run(new Date(this.nowMs()).toISOString(), this.token);
    return Number(info.changes) === 1;
  }

  /** Whether this handle still owns the row. */
  held(): boolean {
    if (this.released) return false;
    const r = this.db.prepare('SELECT token FROM runtime_lock WHERE id = 1').get() as
      | { token: string }
      | undefined;
    return r?.token === this.token;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.db.prepare('DELETE FROM runtime_lock WHERE id = 1 AND token = ?').run(this.token);
  }
}

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and is somebody else's: alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function acquireRuntimeLock(
  db: Db,
  holder: RuntimeHolder,
  opts: RuntimeLockOptions = {},
): RuntimeLockOutcome {
  const nowMs = opts.nowMs ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? hostname();
  const alive = opts.isPidAlive ?? defaultAlive;
  const token = randomUUID();
  const now = new Date(nowMs()).toISOString();

  return withTransaction(db, (): RuntimeLockOutcome => {
    const row = db.prepare('SELECT * FROM runtime_lock WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    if (row) {
      const live =
        String(row['host']) === host
          ? alive(Number(row['pid']))
          : nowMs() - Date.parse(String(row['heartbeat_at'])) <= RUNTIME_LOCK_STALE_MS;
      if (live && Number(row['pid']) !== pid) {
        return { ok: false, heldBy: String(row['holder']) as RuntimeHolder };
      }
      db.prepare('DELETE FROM runtime_lock WHERE id = 1').run();
    }
    db.prepare(
      `INSERT INTO runtime_lock (id, holder, pid, host, token, acquired_at, heartbeat_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
    ).run(holder, pid, host, token, now, now);
    return { ok: true, handle: new RuntimeLockHandle(db, holder, token, nowMs) };
  });
}
