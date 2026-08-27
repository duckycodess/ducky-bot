import os from 'node:os';
import path from 'node:path';

/**
 * Herdr reports paths with a leading `~`, as the recorded live fixtures show:
 *
 *   "path": "~/.herdr/worktrees/<repo>/<branch>"
 *
 * The coordinator requires an absolute, normalized path before it will record a
 * workspace, so a raw Herdr path would be rejected and a real worktree job
 * would fail before its agent ever started.
 *
 * Expansion happens here, at the adapter boundary, against the EXECUTOR's own
 * home directory -- the only process that can resolve it correctly. The
 * expanded path stays executor-side and coordinator-side bookkeeping; it is
 * never surfaced to Discord.
 */
export function expandHerdrPath(reported: string, homeDir: string = os.homedir()): string {
  if (reported === '~') return path.normalize(homeDir);
  const expanded = reported.startsWith('~/') ? path.join(homeDir, reported.slice(2)) : reported;
  return path.normalize(expanded);
}
