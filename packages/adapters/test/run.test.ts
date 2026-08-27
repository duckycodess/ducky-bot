import { describe, expect, it } from 'vitest';
import { runArgv } from '../src/process/run.js';

describe('runArgv', () => {
  it('executes with an argv array and captures output', async () => {
    const res = await runArgv('node', ['-e', 'process.stdout.write("hi")'], { timeoutMs: 10_000 });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('hi');
  });

  it('refuses a shell string as argv', async () => {
    // @ts-expect-error deliberately wrong type
    await expect(runArgv('node', '-e "1"', { timeoutMs: 1000 })).rejects.toThrow(TypeError);
  });

  it('refuses non-string argv entries', async () => {
    // @ts-expect-error deliberately wrong type
    await expect(runArgv('node', ['-e', 42], { timeoutMs: 1000 })).rejects.toThrow(TypeError);
  });

  it('refuses a command name containing shell metacharacters', async () => {
    await expect(runArgv('node -e 1', [], { timeoutMs: 1000 })).rejects.toThrow(TypeError);
    await expect(runArgv('echo; rm -rf /', [], { timeoutMs: 1000 })).rejects.toThrow(TypeError);
  });

  it('does not interpret metacharacters inside arguments', async () => {
    const res = await runArgv(
      'node',
      ['-e', 'process.stdout.write(process.argv[1])', '; rm -rf /'],
      { timeoutMs: 10_000 },
    );
    expect(res.stdout).toBe('; rm -rf /');
  });

  it('reports a non-zero exit code instead of throwing', async () => {
    const res = await runArgv('node', ['-e', 'process.exit(3)'], { timeoutMs: 10_000 });
    expect(res.code).toBe(3);
  });
});
