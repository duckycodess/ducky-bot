import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckyError } from '@ducky/contracts';

const STALE_AFTER_MS = 10 * 60_000;

export interface WriterLock {
  release(): void;
}

function lockDir(): string {
  const base = process.env['XDG_STATE_HOME'] ?? path.join(os.homedir(), '.local', 'state');
  const dir = path.join(base, 'ducky', 'locks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Host-side half of the single-writer guarantee.
 *
 * Held only while a Pi turn is actually running -- it is released before the
 * executor reports `needs_owner_input`, which is what makes that state
 * genuinely quiescent and safe to cancel. The coordinator's per-repo
 * reservation is the guarantee that spans the whole job.
 */
export function acquireWriterLock(repoSlug: string, now = Date.now): WriterLock {
  const file = path.join(lockDir(), `${repoSlug}.lock`);

  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; at: number };
      const alive = isAlive(raw.pid);
      if (alive && now() - raw.at < STALE_AFTER_MS) {
        throw new DuckyError(
          'rate_limited',
          `Another writer already holds \`${repoSlug}\` on this host.`,
        );
      }
      rmSync(file, { force: true });
    } catch (err) {
      if (err instanceof DuckyError) throw err;
      rmSync(file, { force: true });
    }
  }

  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch {
    throw new DuckyError('rate_limited', `Another writer already holds \`${repoSlug}\` on this host.`);
  }
  closeSync(fd);
  writeFileSync(file, JSON.stringify({ pid: process.pid, at: now() }), { mode: 0o600 });

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      rmSync(file, { force: true });
    },
  };
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
