import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import type { ZodType } from 'zod';

/**
 * The executor's durable local state: a directory of small, strictly validated
 * JSON records, written atomically.
 *
 * This is NEW persistence. Until now the executor held nothing on disk but the
 * host writer lock, so anything it knew was lost with the process. What belongs
 * here is exactly what must survive a crash to keep a hold honest -- ids,
 * digests and enums -- and nothing else: no terminal text, no provider state, no
 * secret, no local clock.
 *
 * What it promises, and refuses:
 * - **Explicit path.** There is no default and no fallback derived from the
 *   executor id, which two profiles can share. The caller names the directory.
 * - **Not where cleanup reaches.** A path under a temp directory, the runtime
 *   directory or `/run` is refused: anything those sweeps touch can disappear
 *   while a pause is still owed.
 * - **Owned and private.** Every directory is a real directory (no symlink in the
 *   chain), owned by this uid, mode 0700; every file is regular, owned by this
 *   uid, mode 0600.
 * - **Atomic.** A record is written to a temp file, fsynced, renamed over its
 *   name, and the directory is fsynced. A reader sees the whole old record or the
 *   whole new one.
 * - **Fail closed.** A record that is corrupt, oversized, of the wrong shape or
 *   of the wrong ownership is reported as untrusted. It is never deleted, never
 *   repaired and never aged out; whoever called decides to hold.
 */
export type StateFsOps = Pick<
  typeof nodeFs,
  | 'mkdirSync' | 'lstatSync' | 'openSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'renameSync'
  | 'unlinkSync' | 'readFileSync' | 'readdirSync' | 'realpathSync'
>;

export const MAX_RECORD_BYTES = 8 * 1024;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}\.json$/;
const TEMP_RE = /^\.[A-Za-z0-9_-]{1,64}\.json\.[0-9a-f]{16}\.tmp$/;

/** Roots whose contents a cleanup timer, a reboot or a tmpfs may remove. */
export const defaultForbiddenRoots = (env: NodeJS.ProcessEnv = process.env): string[] =>
  ['/tmp', '/var/tmp', '/dev/shm', '/run', env['TMPDIR'], env['XDG_RUNTIME_DIR']].filter(
    (p): p is string => typeof p === 'string' && p.startsWith('/'),
  );

export class StateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateStoreError';
  }
}

export type StateRead<T> =
  | { readonly kind: 'absent' }
  | { readonly kind: 'untrusted'; readonly reason: string }
  | { readonly kind: 'ok'; readonly value: T };

export interface StateListing<T> {
  readonly records: { readonly name: string; readonly value: T }[];
  /** Entries that could not be trusted, as reasons. Never deleted. */
  readonly untrusted: string[];
}

const within = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export interface OpenStateOptions {
  readonly uid: number;
  readonly fsOps?: StateFsOps;
  /** Replaces the default forbidden roots. Tests pass `[]` to use a scratch directory. */
  readonly forbiddenRoots?: readonly string[];
}

/** One directory of records. */
export class StateDir {
  private constructor(
    readonly dir: string,
    private readonly uid: number,
    private readonly fs: StateFsOps,
    private readonly maxRecords: number,
  ) {}

  /** Creates (if needed) and verifies the directory; throws `StateStoreError` on any doubt. */
  static open(dir: string, opts: OpenStateOptions & { maxRecords: number }): StateDir {
    const fs = opts.fsOps ?? nodeFs;
    if (!path.isAbsolute(dir) || path.resolve(dir) !== dir) {
      throw new StateStoreError('The state directory must be an absolute, normalised path.');
    }
    for (const root of opts.forbiddenRoots ?? defaultForbiddenRoots()) {
      if (within(path.resolve(root), dir)) {
        throw new StateStoreError(
          'The state directory must not be under a temporary or runtime directory that cleanup can remove.',
        );
      }
    }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(dir) !== dir) {
        throw new StateStoreError('The state directory path must not pass through a symbolic link.');
      }
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        throw new StateStoreError('The state directory is not a real directory.');
      }
      if (st.uid !== opts.uid) throw new StateStoreError('The state directory is not owned by this user.');
      if ((st.mode & 0o077) !== 0) throw new StateStoreError('The state directory must be mode 0700.');
    } catch (err) {
      if (err instanceof StateStoreError) throw err;
      throw new StateStoreError('The state directory could not be created or verified.');
    }
    return new StateDir(dir, opts.uid, fs, opts.maxRecords);
  }

  private file(name: string): string {
    if (!NAME_RE.test(name)) throw new StateStoreError('Invalid record name.');
    return path.join(this.dir, name);
  }

  private syncDir(): void {
    const fd = this.fs.openSync(this.dir, 'r');
    try {
      this.fs.fsyncSync(fd);
    } finally {
      this.fs.closeSync(fd);
    }
  }

  /** Atomic and durable when it returns; throws `StateStoreError` and leaves the old record intact otherwise. */
  write(name: string, value: unknown): void {
    const final = this.file(name);
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    if (body.length > MAX_RECORD_BYTES) throw new StateStoreError('Record too large.');
    if (!nodeFsExists(this.fs, final) && this.count() >= this.maxRecords) {
      throw new StateStoreError('The state directory holds too many records.');
    }
    const temp = path.join(this.dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(temp, 'wx', 0o600);
      this.fs.writeSync(fd, body);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temp, final);
      this.syncDir();
    } catch {
      if (fd !== undefined) {
        try { this.fs.closeSync(fd); } catch { /* already failing */ }
      }
      try { this.fs.unlinkSync(temp); } catch { /* may not exist */ }
      throw new StateStoreError('A record could not be written durably.');
    }
  }

  read<T>(name: string, schema: ZodType<T>): StateRead<T> {
    const final = this.file(name);
    let st;
    try {
      st = this.fs.lstatSync(final);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
      return { kind: 'untrusted', reason: 'unreadable' };
    }
    if (!st.isFile() || st.isSymbolicLink()) return { kind: 'untrusted', reason: 'not a regular file' };
    if (st.uid !== this.uid) return { kind: 'untrusted', reason: 'foreign owner' };
    if ((st.mode & 0o077) !== 0) return { kind: 'untrusted', reason: 'permissive mode' };
    if (st.size > MAX_RECORD_BYTES) return { kind: 'untrusted', reason: 'oversized' };
    let raw: string;
    try {
      raw = this.fs.readFileSync(final, 'utf8');
    } catch {
      return { kind: 'untrusted', reason: 'unreadable' };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { kind: 'untrusted', reason: 'malformed' };
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { kind: 'ok', value: parsed.data } : { kind: 'untrusted', reason: 'wrong shape' };
  }

  /**
   * Every record, plus the reasons for anything untrusted. A leftover TEMP file
   * of ours (a write that died before its rename) is removed: it is never
   * evidence, because only the rename publishes a record.
   */
  list<T>(schema: ZodType<T>): StateListing<T> {
    const records: { name: string; value: T }[] = [];
    const untrusted: string[] = [];
    let names: string[];
    try {
      names = this.fs.readdirSync(this.dir);
    } catch {
      return { records, untrusted: ['the directory could not be listed'] };
    }
    let jsonCount = 0;
    for (const name of names) {
      if (TEMP_RE.test(name)) {
        try { this.fs.unlinkSync(path.join(this.dir, name)); } catch { /* harmless */ }
        continue;
      }
      if (!NAME_RE.test(name)) {
        untrusted.push(`unexpected entry`);
        continue;
      }
      jsonCount += 1;
      const r = this.read(name, schema);
      if (r.kind === 'ok') records.push({ name, value: r.value });
      else if (r.kind === 'untrusted') untrusted.push(`${name}: ${r.reason}`);
    }
    if (jsonCount > this.maxRecords) untrusted.push('too many records');
    return { records, untrusted };
  }

  private count(): number {
    try {
      return this.fs.readdirSync(this.dir).filter((n) => NAME_RE.test(n)).length;
    } catch {
      return this.maxRecords;
    }
  }

  /** Durable when it returns. A missing record is not an error. */
  remove(name: string): void {
    const final = this.file(name);
    try {
      this.fs.unlinkSync(final);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StateStoreError('A record could not be removed.');
      }
    }
    try {
      this.syncDir();
    } catch {
      throw new StateStoreError('A removal could not be made durable.');
    }
  }
}

function nodeFsExists(fs: StateFsOps, file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}
