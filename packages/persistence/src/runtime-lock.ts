import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  /**
   * This machine's boot identity, or undefined when it cannot be read. An
   * explicit `undefined` means "unknown" and is honoured as such.
   */
  readonly bootId?: string | undefined;
  /** When process `pid` started (an opaque token), or undefined when unknowable. */
  readonly startOf?: (pid: number) => string | undefined;
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
 * ## What "live" means
 *
 * A pid is not an identity. A pid can be reused after the holder died, and a
 * reboot starts the whole table over, so the row also records the BOOT and the
 * process's own START time. On the same host a holder is live only when that
 * boot is still the current one AND the pid exists AND that pid still began when
 * the holder began. From another host, whose pids and boots mean nothing here,
 * it is live while its heartbeat is fresh.
 *
 * A live holder is never replaced, by anybody: not by an equal pid on another
 * host, not by a second handle in this very process (there is deliberately no
 * re-entrant path, because "it is me" is what a second coordinator in the same
 * process would say while the first is still writing). A row left by a previous
 * boot, or by a process that has since been replaced by one with the same pid,
 * is recovered at once, including when it is this process's own pid.
 *
 * Where the platform cannot give a boot or a start time they are recorded as
 * unknown and the comparison falls back to "the pid exists", which can keep a
 * dead holder alive until its pid is free again. That residual risk is
 * deliberate: it refuses to import, it never allows two writers.
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

/** Linux: the kernel's per-boot random id. Other platforms: unknown. */
export function readBootId(): string | undefined {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return id === '' ? undefined : id;
  } catch {
    return undefined;
  }
}

/**
 * Linux: field 22 of /proc/<pid>/stat, the process's start time in clock ticks
 * since boot. It is read from after the LAST ')' because the command name, in
 * parentheses, may itself contain spaces and parentheses.
 */
export function readProcessStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] === undefined || rest[19] === '' ? undefined : rest[19];
  } catch {
    return undefined;
  }
}

export function acquireRuntimeLock(
  db: Db,
  holder: RuntimeHolder,
  opts: RuntimeLockOptions = {},
): RuntimeLockOutcome {
  const nowMs = opts.nowMs ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? hostname();
  const alive = opts.isPidAlive ?? defaultAlive;
  const bootId = 'bootId' in opts ? opts.bootId : readBootId();
  const startOf = opts.startOf ?? readProcessStart;
  const token = randomUUID();
  const now = new Date(nowMs()).toISOString();

  return withTransaction(db, (): RuntimeLockOutcome => {
    const row = db.prepare('SELECT * FROM runtime_lock WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    if (row) {
      let live: boolean;
      if (String(row['host']) !== host) {
        live = nowMs() - Date.parse(String(row['heartbeat_at'])) <= RUNTIME_LOCK_STALE_MS;
      } else {
        const rowBoot = row['boot_id'] == null ? undefined : String(row['boot_id']);
        const rowStart = row['proc_start'] == null ? undefined : String(row['proc_start']);
        const holderPid = Number(row['pid']);
        if (rowBoot !== undefined && bootId !== undefined && rowBoot !== bootId) {
          live = false; // left by an earlier boot: every pid in it means nothing now
        } else if (!alive(holderPid)) {
          live = false;
        } else {
          const nowStart = startOf(holderPid);
          // A pid that exists but began at a different time is someone else.
          live = !(rowStart !== undefined && nowStart !== undefined && rowStart !== nowStart);
        }
      }
      if (live) return { ok: false, heldBy: String(row['holder']) as RuntimeHolder };
      db.prepare('DELETE FROM runtime_lock WHERE id = 1').run();
    }
    db.prepare(
      `INSERT INTO runtime_lock
         (id, holder, pid, host, token, boot_id, proc_start, acquired_at, heartbeat_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(holder, pid, host, token, bootId ?? null, startOf(pid) ?? null, now, now);
    return { ok: true, handle: new RuntimeLockHandle(db, holder, token, nowMs) };
  });
}
