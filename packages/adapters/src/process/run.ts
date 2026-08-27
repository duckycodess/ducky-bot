import { execFile } from 'node:child_process';
import { SUBPROCESS_CONCURRENCY, SUBPROCESS_MAX_BUFFER } from '@ducky/contracts';

export interface RunOptions {
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBuffer?: number;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Counting semaphore; keeps host load bounded under fan-out. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }

  get inFlight(): number {
    return this.active;
  }
}

const pool = new Semaphore(SUBPROCESS_CONCURRENCY);

export const subprocessInFlight = (): number => pool.inFlight;

/**
 * The ONLY way this codebase spawns a process.
 *
 * execFile with an argv array: there is no shell, so no quoting or
 * interpolation bug can turn untrusted text into a command. A non-array `args`
 * is a programming error and throws rather than being coerced.
 */
export async function runArgv(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  if (!Array.isArray(args)) {
    throw new TypeError('runArgv requires an argv array; shell strings are not supported');
  }
  if (args.some((a) => typeof a !== 'string')) {
    throw new TypeError('runArgv argv entries must all be strings');
  }
  if (typeof command !== 'string' || command.length === 0 || /[\s;|&><$`]/.test(command)) {
    throw new TypeError('runArgv requires a bare command name');
  }

  const release = await pool.acquire();
  try {
    return await new Promise<RunResult>((resolve) => {
      execFile(
        command,
        args as string[],
        {
          timeout: options.timeoutMs,
          cwd: options.cwd,
          env: options.env,
          maxBuffer: options.maxBuffer ?? SUBPROCESS_MAX_BUFFER,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const raw = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
          const code = raw == null ? 0 : typeof raw.code === 'number' ? raw.code : 1;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    });
  } finally {
    release();
  }
}
