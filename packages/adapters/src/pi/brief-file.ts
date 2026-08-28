import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const BRIEF_RELATIVE_PATH = path.join('.ducky', 'brief.md');

/**
 * Hands the brief over as a FILE rather than as pasted terminal text.
 *
 * `herdr agent prompt` pastes the text into the pane and submits it. That works
 * for a short prompt and fails for a long one: measured on this host, a
 * 1.5 KB / 30-line brief submitted fine, and a 3.3 KB / 66-line brief was left
 * sitting UNSENT in Pi's input buffer -- the agent stayed `idle`, Herdr
 * reported `agent_prompt_stalled`, and the job failed with the work never
 * started. Herdr's own skill file sanctions exactly this fallback for content
 * too large to paste.
 *
 * Writing it also means the brief never crosses a terminal at all, so no
 * amount of it can be reinterpreted as control characters or key presses.
 */
export interface BriefWriter {
  /** Writes the brief and returns the repository-relative path to it. */
  write(workspacePath: string, brief: string): Promise<string>;
}

export class FileBriefWriter implements BriefWriter {
  async write(workspacePath: string, brief: string): Promise<string> {
    const dir = path.join(workspacePath, path.dirname(BRIEF_RELATIVE_PATH));
    const file = path.join(workspacePath, BRIEF_RELATIVE_PATH);

    // `mode` on mkdir/writeFile applies ONLY on creation, and it is masked by
    // the process umask even then. A second round therefore reused whatever
    // permissions already existed -- and `.ducky/` is created by Pi as well as
    // by us, so "already existed" can mean 0755/0644. chmod unconditionally, so
    // owner-only is true after every write rather than only the first.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);

    // Written to a temp file in the same directory and renamed, so a reader
    // never sees a half-written brief and never sees it at wider permissions
    // than 0600.
    //
    // Created with `wx` -- EXCLUSIVE -- and a random suffix, so the open fails
    // rather than following anything that is already at that path. A predictable
    // `.tmp-<pid>` name that already existed as a symlink would have been
    // followed, and the write would have landed wherever it pointed, at 0600 on
    // the wrong file. The workspace is Ducky-managed but a Pi agent also writes
    // in it, so "nothing else creates that name" is not a property to rely on.
    const tmp = `${file}.tmp-${randomBytes(8).toString('hex')}`;
    let handle;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(brief);
      // Explicit, because the `mode` above is masked by the umask.
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;

      // `rename` does not follow a symlink at the destination -- it REPLACES
      // it -- so a decoy planted at `brief.md` is removed rather than written
      // through.
      await rename(tmp, file);
    } catch (err) {
      // The temp file holds the owner's task text, so it is removed on EVERY
      // failure -- a failed write, a failed chmod or a failed rename alike.
      // Previously only the rename path cleaned up.
      await handle?.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw err;
    }
    return BRIEF_RELATIVE_PATH;
  }
}

/**
 * The single short line that IS pasted.
 *
 * Deliberately one line and no code fences: it has to survive a bracketed
 * paste with certainty, which is the whole point. It must also not invite a
 * reply-and-stop -- the turn has to do the work, so it says so.
 */
export const briefPointerPrompt = (relativePath: string): string =>
  `Your instructions for this job are in ./${relativePath.split(path.sep).join('/')} — ` +
  'read that file now and carry out everything it specifies, including writing the ' +
  'result file it describes. Do not reply until the work is done.';

/**
 * Test double, kept beside the real writer the way `herdr.mock.ts` and
 * `pi.mock.ts` are. Records the brief instead of writing it, so a suite can
 * drive the orchestrator against synthetic workspace paths.
 */
export class MemoryBriefWriter implements BriefWriter {
  written: { workspacePath: string; brief: string }[] = [];

  async write(workspacePath: string, brief: string): Promise<string> {
    this.written.push({ workspacePath, brief });
    return BRIEF_RELATIVE_PATH;
  }
}
