import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ADMISSION_PROGRAMS, SHARED_ADMISSION_DEFAULT_POLICY, SHARED_ADMISSION_PROTOCOL,
  SHARED_ADMISSION_SCHEMA_VERSION, canonicalAdmissionRepoKey, isSafeReserve,
  type AdmissionAcquire, type AdmissionConfirm, type AdmissionHolder, type AdmissionReleaseOutcome,
  type AdmissionRefusal, type AdmissionRequest, type AdmissionVerifyOutcome,
  type SharedAdmissionLedgerPort, type SharedAdmissionPolicy,
} from '@ducky/contracts';
import type { MemoryObserver } from './account-memory.js';

/**
 * The host-local shared admission ledger (ADR 0031).
 *
 * A SEPARATE SQLite file, owned by neither coordinator database nor by Agent
 * Flow's state. SQLite's own file locking is what makes admission atomic across
 * processes and programs, and it is released when a process dies, so a crashed
 * holder can never wedge the lock (it can only leave a HOLD, see below).
 *
 *   journal_mode = DELETE   rollback journal: no -shm/-wal, readable by any SQLite
 *                           (the Python companion links a different SQLite build)
 *   synchronous  = FULL     a committed admission survives power loss
 *   BEGIN IMMEDIATE         every admission decision takes the write lock first,
 *                           then reads the ledger and the account memory, then writes
 *   busy_timeout = 5000     bounded wait; a timeout is a refusal, never a bypass
 *
 * The invariants are in the schema (unique indexes and triggers), not only in
 * this code, so a participant with a bug is still constrained.
 *
 * A confirmed hold NEVER expires: not by time, not because a PID is gone, not
 * because the holder's manager died or its local record is absent. Silence is not
 * quiescence. Only `pending` (never confirmed) holds time out, and that is safe
 * only because every caller confirms BEFORE it launches anything.
 */

export const LEDGER_USER_VERSION = SHARED_ADMISSION_SCHEMA_VERSION;
export const LEDGER_BUSY_TIMEOUT_MS = 5000;

export const LEDGER_SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE policy (
  id                         INTEGER PRIMARY KEY CHECK (id = 1),
  global_cap                 INTEGER NOT NULL CHECK (global_cap BETWEEN 1 AND 4),
  repo_cap                   INTEGER NOT NULL CHECK (repo_cap = 1),
  ducky_exclusive            INTEGER NOT NULL CHECK (ducky_exclusive = 1),
  ceiling_bytes              INTEGER NOT NULL CHECK (ceiling_bytes > 0),
  notification_reserve_bytes INTEGER NOT NULL CHECK (notification_reserve_bytes >= 0),
  pending_ttl_seconds        INTEGER NOT NULL CHECK (pending_ttl_seconds BETWEEN 5 AND 3600)
);

-- One row per outstanding hold. The fence is a monotonically increasing integer
-- that is NEVER reused (AUTOINCREMENT), so a release for an old generation can
-- never free a newer one, and "issued but no longer present" is provable from
-- the sequence alone without keeping a tombstone per release.
CREATE TABLE entries (
  fence              INTEGER PRIMARY KEY AUTOINCREMENT,
  program            TEXT NOT NULL CHECK (program IN ('ducky','agent-flow')),
  instance_id        TEXT NOT NULL CHECK (length(instance_id) BETWEEN 8 AND 80),
  job_ref            TEXT NOT NULL CHECK (length(job_ref) BETWEEN 1 AND 200),
  repo_key           TEXT NOT NULL CHECK (length(repo_key) BETWEEN 3 AND 140 AND repo_key = lower(repo_key)),
  reserve_bytes      INTEGER NOT NULL CHECK (reserve_bytes > 0),
  state              TEXT NOT NULL CHECK (state IN ('pending','confirmed')),
  acquired_at        INTEGER NOT NULL,
  pending_expires_at INTEGER,
  confirmed_at       INTEGER,
  CHECK ((state = 'pending' AND pending_expires_at IS NOT NULL AND confirmed_at IS NULL)
      OR (state = 'confirmed' AND confirmed_at IS NOT NULL)),
  UNIQUE (repo_key),
  UNIQUE (program, instance_id, job_ref)
);

CREATE TRIGGER entries_admit BEFORE INSERT ON entries
BEGIN
  SELECT RAISE(ABORT, 'global_cap')
   WHERE (SELECT count(*) FROM entries) >= (SELECT global_cap FROM policy WHERE id = 1);
  SELECT RAISE(ABORT, 'ducky_exclusive')
   WHERE NEW.program = 'ducky' AND EXISTS (SELECT 1 FROM entries);
  SELECT RAISE(ABORT, 'ducky_present')
   WHERE EXISTS (SELECT 1 FROM entries WHERE program = 'ducky');
  SELECT RAISE(ABORT, 'reserve_budget')
   WHERE (SELECT coalesce(sum(reserve_bytes), 0) FROM entries) + NEW.reserve_bytes
       + (SELECT notification_reserve_bytes FROM policy WHERE id = 1)
       > (SELECT ceiling_bytes FROM policy WHERE id = 1);
END;

-- Identity and reservation are fixed at insert; the only change a row may undergo
-- is pending -> confirmed. A hold is never edited into another holder's.
CREATE TRIGGER entries_identity_fixed
BEFORE UPDATE OF fence, program, instance_id, job_ref, repo_key, reserve_bytes, acquired_at ON entries
BEGIN SELECT RAISE(ABORT, 'identity_fixed'); END;

CREATE TRIGGER entries_state_forward
BEFORE UPDATE OF state ON entries
WHEN NOT (OLD.state = 'pending' AND NEW.state = 'confirmed')
BEGIN SELECT RAISE(ABORT, 'state_forward_only'); END;

-- Policy and identity are written once, at init. Changing either is a NEW ledger.
CREATE TRIGGER policy_fixed_u BEFORE UPDATE ON policy BEGIN SELECT RAISE(ABORT, 'policy_fixed'); END;
CREATE TRIGGER policy_fixed_d BEFORE DELETE ON policy BEGIN SELECT RAISE(ABORT, 'policy_fixed'); END;
CREATE TRIGGER meta_fixed_u BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'meta_fixed'); END;
CREATE TRIGGER meta_fixed_d BEFORE DELETE ON meta BEGIN SELECT RAISE(ABORT, 'meta_fixed'); END;
`;

/** The trigger and table names a participant must find before it trusts a ledger. */
export const LEDGER_REQUIRED_OBJECTS = [
  'meta', 'policy', 'entries', 'entries_admit', 'entries_identity_fixed',
  'entries_state_forward', 'policy_fixed_u', 'policy_fixed_d', 'meta_fixed_u', 'meta_fixed_d',
] as const;

export const policyDigest = (p: SharedAdmissionPolicy): string =>
  createHash('sha256')
    .update(
      [
        `${SHARED_ADMISSION_PROTOCOL}/${SHARED_ADMISSION_SCHEMA_VERSION}`,
        `global=${p.globalCap}`, `repo=${p.repoCap}`, `exclusive=${p.duckyExclusive ? 1 : 0}`,
        `ceiling=${p.ceilingBytes}`, `notify=${p.notificationReserveBytes}`,
        `ttl=${p.pendingTtlSeconds}`,
      ].join('|'),
    )
    .digest('hex');

/** Roots a cleanup timer, a reboot or a tmpfs may remove. */
export const defaultLedgerForbiddenRoots = (env: NodeJS.ProcessEnv = process.env): string[] =>
  ['/tmp', '/var/tmp', '/dev/shm', '/run', env['TMPDIR'], env['XDG_RUNTIME_DIR']].filter(
    (p): p is string => typeof p === 'string' && p.startsWith('/'),
  );

const within = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export class LedgerPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerPathError';
  }
}

export interface LedgerLocation {
  readonly path: string;
  readonly uid?: number;
  /** Replaces the default forbidden roots. Tests pass `[]` for a scratch directory. */
  readonly forbiddenRoots?: readonly string[];
}

/**
 * The ledger is a security-relevant shared file: absolute, no symlink anywhere in
 * the path, a real directory and file owned by this user and closed to everyone
 * else, a single link, and not under a root something else may clean.
 */
function assertTrustedPath(loc: LedgerLocation, expectFile: boolean): void {
  const uid = loc.uid ?? process.getuid?.() ?? -1;
  const file = loc.path;
  if (!path.isAbsolute(file) || file !== path.normalize(file)) {
    throw new LedgerPathError('the ledger path must be absolute and normalized');
  }
  for (const root of loc.forbiddenRoots ?? defaultLedgerForbiddenRoots()) {
    if (within(root, file)) throw new LedgerPathError('the ledger path is under a temporary or runtime root');
  }
  // No symlink in ANY component.
  let cursor = path.parse(file).root;
  for (const part of file.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      if (!expectFile && cursor === file) return;
      throw new LedgerPathError('a component of the ledger path is missing');
    }
    if (st.isSymbolicLink()) throw new LedgerPathError('the ledger path contains a symlink');
  }
  const dir = lstatSync(path.dirname(file));
  if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077) !== 0) {
    throw new LedgerPathError('the ledger directory must be owned by this user and mode 0700');
  }
  if (!expectFile) return;
  const st = lstatSync(file);
  if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0 || st.nlink !== 1) {
    throw new LedgerPathError('the ledger file must be a single-link regular file, owned by this user, mode 0600');
  }
}

const sqlErr = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isBusy = (err: unknown): boolean => /locked|busy/i.test(sqlErr(err));

export interface InitLedgerOptions extends LedgerLocation {
  readonly policy?: Partial<SharedAdmissionPolicy>;
  readonly ledgerId?: string;
  readonly now?: () => number;
}

/**
 * Creates a NEW ledger and refuses if anything exists at the path. Never called by
 * a runtime: only the explicit `pnpm shared-admission init`. The file is built
 * under a temporary name, fully written and synced, then linked into place with a
 * no-clobber `link`, so a half-built ledger can never be mistaken for a real one
 * and an existing ledger can never be replaced.
 */
export function initLedger(opts: InitLedgerOptions): { ledgerId: string; policyDigest: string } {
  const policy: SharedAdmissionPolicy = {
    ...SHARED_ADMISSION_DEFAULT_POLICY,
    ...opts.policy,
  } as SharedAdmissionPolicy;
  const dir = path.dirname(opts.path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertTrustedPath(opts, false);
  try {
    lstatSync(opts.path);
    throw new LedgerPathError('a file already exists at the ledger path; a ledger is never re-initialized');
  } catch (err) {
    if (err instanceof LedgerPathError) throw err;
  }
  const ledgerId = opts.ledgerId ?? randomUUID();
  const tmp = `${opts.path}.init-${randomBytes(6).toString('hex')}`;
  closeSync(openSync(tmp, 'wx', 0o600));
  try {
    const db = new DatabaseSync(tmp);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('BEGIN IMMEDIATE');
      db.exec(LEDGER_SCHEMA_SQL);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('protocol', SHARED_ADMISSION_PROTOCOL);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SHARED_ADMISSION_SCHEMA_VERSION));
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('ledger_id', ledgerId);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('policy_digest', policyDigest(policy));
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('created_at', String((opts.now ?? Date.now)()));
      db.prepare(
        `INSERT INTO policy (id, global_cap, repo_cap, ducky_exclusive, ceiling_bytes,
                             notification_reserve_bytes, pending_ttl_seconds)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
      ).run(
        policy.globalCap, policy.repoCap, policy.duckyExclusive ? 1 : 0, policy.ceilingBytes,
        policy.notificationReserveBytes, policy.pendingTtlSeconds,
      );
      db.exec('COMMIT');
      db.exec(`PRAGMA user_version = ${LEDGER_USER_VERSION}`);
    } finally {
      db.close();
    }
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(tmp, opts.path); // EEXIST if somebody else got there first: never clobbers
  } finally {
    try { unlinkSync(tmp); } catch { /* the link, if made, stands on its own */ }
  }
  const dfd = openSync(dir, 'r');
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  return { ledgerId, policyDigest: policyDigest(policy) };
}

export interface SharedLedgerOptions extends LedgerLocation {
  /** The identity this participant pinned. A different ledger is refused, never adopted. */
  readonly expectedLedgerId: string;
  /** The policy this participant pinned. Optional only for read-only inspection. */
  readonly expectedPolicyDigest?: string;
  /** Takes one account-memory reading; called ONLY while the admission lock is held. */
  readonly observe: MemoryObserver;
  readonly now?: () => number;
}

interface EntryRow {
  fence: number;
  program: string;
  instance_id: string;
  job_ref: string;
  repo_key: string;
  reserve_bytes: number;
  state: 'pending' | 'confirmed';
  pending_expires_at: number | null;
}

export interface LedgerEntrySnapshot {
  readonly fence: number;
  readonly program: string;
  readonly instanceId: string;
  readonly jobRef: string;
  readonly repoKey: string;
  readonly reserveBytes: number;
  readonly state: 'pending' | 'confirmed';
  readonly pendingExpiresAt: number | null;
}

type Checked =
  | { ok: true; ledgerId: string; digest: string; policy: SharedAdmissionPolicy }
  | { ok: false; reason: AdmissionRefusal; detail?: string };

class Refuse extends Error {
  constructor(readonly reason: AdmissionRefusal, readonly detail?: string) {
    super(reason);
  }
}

export class SharedLedger implements SharedAdmissionLedgerPort {
  private readonly now: () => number;

  constructor(private readonly opts: SharedLedgerOptions) {
    this.now = opts.now ?? Date.now;
  }

  // ---------------------------------------------------------------- open ----

  /** Opens the existing, trusted file or throws a Refuse. Never creates one. */
  private open(): DatabaseSync {
    try {
      assertTrustedPath(this.opts, true);
    } catch (err) {
      throw new Refuse('unavailable', err instanceof Error ? err.message : 'untrusted ledger path');
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.opts.path);
    } catch (err) {
      throw new Refuse(isBusy(err) ? 'busy' : 'unavailable', 'the ledger could not be opened');
    }
    try {
      db.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
      db.exec('PRAGMA synchronous = FULL');
      const mode = String((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode);
      if (mode !== 'delete') throw new Refuse('ledger_mismatch', 'the ledger is not in rollback-journal mode');
      const uv = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (uv !== LEDGER_USER_VERSION) throw new Refuse('ledger_mismatch', 'unsupported ledger schema version');
      return db;
    } catch (err) {
      db.close();
      throw err instanceof Refuse ? err : new Refuse(isBusy(err) ? 'busy' : 'unavailable', 'the ledger could not be read');
    }
  }

  /** Identity, schema objects and policy, read INSIDE the caller's transaction. */
  private verifyIdentity(db: DatabaseSync): Checked {
    const names = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','trigger')`).all() as { name: string }[])
        .map((r) => r.name),
    );
    for (const required of LEDGER_REQUIRED_OBJECTS) {
      if (!names.has(required)) return { ok: false, reason: 'ledger_mismatch', detail: `missing ${required}` };
    }
    const meta = new Map(
      (db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
    );
    if (meta.get('protocol') !== SHARED_ADMISSION_PROTOCOL
        || meta.get('schema_version') !== String(SHARED_ADMISSION_SCHEMA_VERSION)) {
      return { ok: false, reason: 'ledger_mismatch', detail: 'not a protocol-1 ledger' };
    }
    const ledgerId = meta.get('ledger_id') ?? '';
    if (ledgerId !== this.opts.expectedLedgerId) {
      return { ok: false, reason: 'ledger_mismatch', detail: 'ledger identity differs from the pinned one' };
    }
    const row = db.prepare('SELECT * FROM policy WHERE id = 1').get() as Record<string, number> | undefined;
    if (!row) return { ok: false, reason: 'ledger_mismatch', detail: 'no policy row' };
    const policy: SharedAdmissionPolicy = {
      globalCap: Number(row['global_cap']),
      repoCap: 1,
      duckyExclusive: true,
      ceilingBytes: Number(row['ceiling_bytes']),
      notificationReserveBytes: Number(row['notification_reserve_bytes']),
      pendingTtlSeconds: Number(row['pending_ttl_seconds']),
    };
    const digest = policyDigest(policy);
    if (digest !== meta.get('policy_digest')) {
      return { ok: false, reason: 'policy_mismatch', detail: 'policy row differs from its recorded digest' };
    }
    if (this.opts.expectedPolicyDigest !== undefined && digest !== this.opts.expectedPolicyDigest) {
      return { ok: false, reason: 'policy_mismatch', detail: 'policy differs from the pinned one' };
    }
    return { ok: true, ledgerId, digest, policy };
  }

  private run<T>(write: boolean, fn: (db: DatabaseSync, chk: Extract<Checked, { ok: true }>) => T): T {
    const db = this.open();
    try {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const chk = this.verifyIdentity(db);
        if (!chk.ok) throw new Refuse(chk.reason, chk.detail);
        const out = fn(db, chk);
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* the first error is the interesting one */ }
        throw err;
      }
    } catch (err) {
      if (err instanceof Refuse) throw err;
      throw new Refuse(isBusy(err) ? 'busy' : 'unavailable', 'the ledger transaction failed');
    } finally {
      db.close();
    }
  }

  // ------------------------------------------------------------- queries ----

  private reap(db: DatabaseSync): void {
    db.prepare(`DELETE FROM entries WHERE state = 'pending' AND pending_expires_at <= ?`).run(this.now());
  }

  private highWater(db: DatabaseSync): number {
    const r = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'entries'`).get() as { seq: number } | undefined;
    return r ? Number(r.seq) : 0;
  }

  private static sameHolder(row: EntryRow, h: AdmissionHolder): boolean {
    return row.program === h.program && row.instance_id === h.instanceId && row.job_ref === h.jobRef;
  }

  private static validHolder(h: AdmissionHolder): boolean {
    return (ADMISSION_PROGRAMS as readonly string[]).includes(h?.program)
      && typeof h.instanceId === 'string' && h.instanceId.length >= 8 && h.instanceId.length <= 80
      && typeof h.jobRef === 'string' && h.jobRef.length >= 1 && h.jobRef.length <= 200;
  }

  // ------------------------------------------------------------ the port ----

  check(): ReturnType<SharedAdmissionLedgerPort['check']> {
    try {
      return this.run(false, (_db, chk) => ({ ok: true as const, ledgerId: chk.ledgerId, policyDigest: chk.digest }));
    } catch (err) {
      return err instanceof Refuse
        ? { ok: false, reason: err.reason, ...(err.detail ? { detail: err.detail } : {}) }
        : { ok: false, reason: 'unavailable' };
    }
  }

  acquire(req: AdmissionRequest): AdmissionAcquire {
    if (!SharedLedger.validHolder(req.holder) || canonicalAdmissionRepoKey(req.repoKey) !== req.repoKey
        || !isSafeReserve(req.reserveBytes)
        || (req.resumeFence !== undefined && !Number.isSafeInteger(req.resumeFence))) {
      return { ok: false, reason: 'invalid_request' };
    }
    try {
      return this.run(true, (db, chk): AdmissionAcquire => {
        // Never-confirmed holds past their TTL are gone. Nothing launches before
        // confirm, so this frees capacity no process is using.
        this.reap(db);

        const existing = db
          .prepare('SELECT * FROM entries WHERE program = ? AND instance_id = ? AND job_ref = ?')
          .get(req.holder.program, req.holder.instanceId, req.holder.jobRef) as EntryRow | undefined;
        if (existing) {
          if (existing.repo_key !== req.repoKey || Number(existing.reserve_bytes) !== req.reserveBytes) {
            return { ok: false, reason: 'identity_conflict' };
          }
          // A name alone never adopts a hold: the caller must present the fence.
          if (req.resumeFence !== Number(existing.fence)) return { ok: false, reason: 'identity_held' };
          return { ok: true, fence: Number(existing.fence), state: existing.state, adopted: true };
        }

        const all = db.prepare('SELECT * FROM entries').all() as unknown as EntryRow[];
        if (all.some((e) => e.repo_key === req.repoKey)) return { ok: false, reason: 'repo_held' };
        if (req.holder.program === 'ducky') {
          if (all.length > 0) return { ok: false, reason: 'ducky_exclusive' };
        } else if (all.some((e) => e.program === 'ducky')) {
          return { ok: false, reason: 'ducky_present' };
        }
        if (all.length >= chk.policy.globalCap) return { ok: false, reason: 'global_cap' };

        // The account memory, read NOW, under the lock. Observed use is NOT
        // reduced by the memory the held reservations may already account for:
        // that double counts and is deliberate. Nothing here assumes which
        // process owns which bytes.
        const seen = this.opts.observe();
        if (!seen.ok) return { ok: false, reason: 'observation_failed', detail: seen.detail };
        const effectiveLimit = Math.min(seen.limitBytes, chk.policy.ceilingBytes);
        const available = Math.max(0, effectiveLimit - seen.currentBytes);
        const outstanding = all.reduce((sum, e) => sum + Number(e.reserve_bytes), 0);
        const required = outstanding + req.reserveBytes + chk.policy.notificationReserveBytes;
        if (!Number.isSafeInteger(required) || available < required) {
          return { ok: false, reason: 'insufficient_memory' };
        }

        const at = this.now();
        try {
          const res = db
            .prepare(
              `INSERT INTO entries (program, instance_id, job_ref, repo_key, reserve_bytes, state,
                                    acquired_at, pending_expires_at)
               VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(
              req.holder.program, req.holder.instanceId, req.holder.jobRef, req.repoKey,
              req.reserveBytes, at, at + chk.policy.pendingTtlSeconds * 1000,
            );
          return { ok: true, fence: Number(res.lastInsertRowid), state: 'pending', adopted: false };
        } catch (err) {
          // The schema is the second line: it refuses what a buggy pre-check let through.
          const m = sqlErr(err);
          for (const word of ['global_cap', 'ducky_exclusive', 'ducky_present'] as const) {
            if (m.includes(word)) return { ok: false, reason: word };
          }
          if (m.includes('reserve_budget')) return { ok: false, reason: 'insufficient_memory' };
          if (m.includes('UNIQUE') && m.includes('repo_key')) return { ok: false, reason: 'repo_held' };
          throw err;
        }
      });
    } catch (err) {
      return err instanceof Refuse
        ? { ok: false, reason: err.reason, ...(err.detail ? { detail: err.detail } : {}) }
        : { ok: false, reason: 'unavailable' };
    }
  }

  confirm(fence: number, holder: AdmissionHolder): AdmissionConfirm {
    if (!Number.isSafeInteger(fence) || !SharedLedger.validHolder(holder)) return { ok: false, reason: 'unknown_fence' };
    try {
      return this.run(true, (db): AdmissionConfirm => {
        this.reap(db);
        const row = db.prepare('SELECT * FROM entries WHERE fence = ?').get(fence) as EntryRow | undefined;
        if (!row) return { ok: false, reason: fence > this.highWater(db) ? 'unknown_fence' : 'gone' };
        if (!SharedLedger.sameHolder(row, holder)) return { ok: false, reason: 'not_holder' };
        if (row.state === 'pending') {
          db.prepare(
            `UPDATE entries SET state = 'confirmed', confirmed_at = ?, pending_expires_at = NULL WHERE fence = ?`,
          ).run(this.now(), fence);
        }
        return { ok: true };
      });
    } catch (err) {
      return { ok: false, reason: err instanceof Refuse && err.reason === 'ledger_mismatch' ? 'ledger_mismatch' : 'unavailable' };
    }
  }

  release(fence: number, holder: AdmissionHolder): AdmissionReleaseOutcome {
    if (!Number.isSafeInteger(fence) || !SharedLedger.validHolder(holder)) return 'unknown_fence';
    try {
      return this.run(true, (db): AdmissionReleaseOutcome => {
        this.reap(db);
        const row = db.prepare('SELECT * FROM entries WHERE fence = ?').get(fence) as EntryRow | undefined;
        if (!row) return fence > this.highWater(db) ? 'unknown_fence' : 'gone';
        if (!SharedLedger.sameHolder(row, holder)) return 'not_holder';
        db.prepare('DELETE FROM entries WHERE fence = ?').run(fence);
        return 'released';
      });
    } catch (err) {
      return err instanceof Refuse && err.reason === 'ledger_mismatch' ? 'ledger_mismatch' : 'unavailable';
    }
  }

  verify(fence: number, holder: AdmissionHolder): AdmissionVerifyOutcome {
    if (!Number.isSafeInteger(fence) || !SharedLedger.validHolder(holder)) return 'unknown_fence';
    try {
      return this.run(false, (db): AdmissionVerifyOutcome => {
        const row = db.prepare('SELECT * FROM entries WHERE fence = ?').get(fence) as EntryRow | undefined;
        if (!row) return fence > this.highWater(db) ? 'unknown_fence' : 'gone';
        if (!SharedLedger.sameHolder(row, holder)) return 'not_holder';
        if (row.state === 'confirmed') return 'confirmed';
        // An expired pending hold is gone even before something reaps it.
        return row.pending_expires_at !== null && Number(row.pending_expires_at) <= this.now() ? 'gone' : 'pending';
      });
    } catch (err) {
      return err instanceof Refuse && err.reason === 'ledger_mismatch' ? 'ledger_mismatch' : 'unavailable';
    }
  }

  /** Read-only view for the operator CLI. Holds no secret and no task content. */
  inspect(): { ledgerId: string; policyDigest: string; highWaterFence: number; entries: LedgerEntrySnapshot[] } {
    return this.run(false, (db, chk) => ({
      ledgerId: chk.ledgerId,
      policyDigest: chk.digest,
      highWaterFence: this.highWater(db),
      entries: (db.prepare('SELECT * FROM entries ORDER BY fence').all() as unknown as EntryRow[]).map((e) => ({
        fence: Number(e.fence), program: e.program, instanceId: e.instance_id, jobRef: e.job_ref,
        repoKey: e.repo_key, reserveBytes: Number(e.reserve_bytes), state: e.state,
        pendingExpiresAt: e.pending_expires_at === null ? null : Number(e.pending_expires_at),
      })),
    }));
  }
}
