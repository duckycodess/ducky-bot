import path from 'node:path';
import { DuckyError } from './errors.js';
import { MAX_PATH_LEN } from './limits.js';

/**
 * True only for a plain, repository-relative POSIX path.
 * Rejects absolute paths, drive letters, UNC, `..`, `~`, NUL, backslashes,
 * and anything that does not normalize back to itself.
 */
export function isRepoRelativePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > MAX_PATH_LEN) return false;
  if (p.includes('\0')) return false;
  if (p.includes('\\')) return false;
  if (p.startsWith('/')) return false;
  if (p.startsWith('~')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p.startsWith('//')) return false;
  const segments = p.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return false;
  if (path.posix.normalize(p) !== p) return false;
  return true;
}

export function assertRepoRelativePath(p: unknown): asserts p is string {
  if (!isRepoRelativePath(p)) {
    throw new DuckyError('result_rejected', 'A reported file path was not repository-relative.');
  }
}
