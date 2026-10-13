import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhCliReader } from '../src/github/gh-cli.js';

const REF = { owner: 'acme', repo: 'demo' };

/** A stand-in `gh` that prints what it is told and exits as told. */
function fakeGh(stdout: string, stderr: string, code: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
  const bin = path.join(dir, 'gh');
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s' '${stdout.replace(/'/g, "'\\''")}'\nprintf '%s' '${stderr.replace(/'/g, "'\\''")}' >&2\nexit ${code}\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('reading the checks of one pull request', () => {
  const list = '[{"name":"ci/x","state":"FAILURE","bucket":"fail","link":"https://ci.example/1","workflow":"","startedAt":"2026-10-01T00:00:00Z","completedAt":"2026-10-01T00:01:00Z"}]';

  it('parses a normal answer', async () => {
    const reader = new GhCliReader(fakeGh(list, '', 0));
    expect(await reader.feedPrChecks(REF, 7)).toHaveLength(1);
  });

  it('trusts a non-zero exit (pending is 8) only when stdout is the JSON list', async () => {
    expect(await new GhCliReader(fakeGh(list, '', 8)).feedPrChecks(REF, 7)).toHaveLength(1);
    expect(await new GhCliReader(fakeGh(list, '', 1)).feedPrChecks(REF, 7)).toHaveLength(1);
  });

  it('answers an empty list for a pull request with no checks, as gh does', async () => {
    const reader = new GhCliReader(fakeGh('', "no checks reported on the 'feature' branch", 1));
    expect(await reader.feedPrChecks(REF, 7)).toEqual([]);
  });

  it('still fails on a real failure, without echoing stderr raw', async () => {
    const reader = new GhCliReader(fakeGh('', 'HTTP 502 token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 1));
    await expect(reader.feedPrChecks(REF, 7)).rejects.toThrow(/GitHub lookup failed/);
    await expect(reader.feedPrChecks(REF, 7)).rejects.not.toThrow(/ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  });

  it('refuses an invalid pull request number or repository before spawning anything', async () => {
    const reader = new GhCliReader('/nonexistent/gh');
    await expect(reader.feedPrChecks(REF, 0)).rejects.toThrow(/not valid/);
    await expect(reader.feedPrChecks(REF, 1.5)).rejects.toThrow(/not valid/);
    await expect(reader.feedPrChecks({ owner: 'a;b', repo: 'x' }, 1)).rejects.toThrow(/not configured/);
  });
});
