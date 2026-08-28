#!/usr/bin/env node
/**
 * PROBE C -- records the real OpenClaw contract, when there is one to record.
 *
 * OpenClaw is NOT installed on this host: not on PATH, not in the global npm
 * tree, and no configuration directory exists. The npm registry (read-only)
 * reports `openclaw@2026.7.1-2`, bin `openclaw`, engines accepting this Node
 * version. That is the whole of what could be established without installing
 * it, and installing it is a host-wide environment mutation that needs its own
 * approval -- so this script exists, is committed, and REFUSES to guess.
 *
 * It records nothing invented. Until it has run, `HttpOpenClawProvider.reply()`
 * throws, `openclaw-contract.test.ts` skips, and /status says unverified.
 *
 * SAFETY
 * - Reads only. It never installs, never starts a service, never writes config.
 * - Captures configuration KEY NAMES and the auth header NAME only, never a
 *   value. A recorded fixture that contained a token would be worse than no
 *   fixture at all.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'packages/adapters/src/openclaw/openclaw.fixtures');
const HOME = os.homedir();

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }),
    );
  });

/** Never write a host path, a token, or anything that looks like either. */
const redact = (text) =>
  String(text)
    .split(HOME).join('~')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED:guid]')
    .replace(/\b(sk|pk|api|key|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, '[REDACTED:secretish]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]');

async function main() {
  const which = await run('sh', ['-c', 'command -v openclaw || true']);
  if (which.stdout.trim() === '') {
    process.stderr.write(
      [
        'openclaw is not installed on this host, so there is no contract to record.',
        '',
        'This is the BLOCKER, stated plainly rather than worked around:',
        '  * `HttpOpenClawProvider.reply()` throws and no API is guessed.',
        '  * `openclaw-contract.test.ts` skips, so nothing passes on a fiction.',
        '  * /status reports the provider unverified.',
        '  * DUCKY_CONVERSATION_PROVIDER=disabled is the honest production mode.',
        '',
        'Installing it (`npm i -g openclaw`) is a host-wide environment mutation and',
        'needs its own approval. See docs/integrations/openclaw.md.',
      ].join('\n') + '\n',
    );
    process.exit(2);
  }

  mkdirSync(FIXTURES, { recursive: true });
  const record = (name, body) => {
    writeFileSync(path.join(FIXTURES, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
    process.stdout.write(`recorded ${name}.json\n`);
  };

  const version = await run('openclaw', ['--version']);
  const help = await run('openclaw', ['--help']);
  record('cli', {
    _note: 'Recorded by scripts/probe-openclaw.mjs. Redacted; no value is captured.',
    version: redact(version.stdout.trim()),
    helpExitCode: help.code,
    help: redact(help.stdout).slice(0, 8_000),
  });

  // Configuration KEY NAMES only. A value here would be a credential.
  const configDirs = ['.openclaw', '.config/openclaw'].map((d) => path.join(HOME, d));
  record('config-locations', {
    _note: 'Existence and key NAMES only. No value is ever read or recorded.',
    directories: configDirs.map((d) => ({ path: d.split(HOME).join('~'), exists: existsSync(d) })),
  });

  process.stdout.write(
    [
      '',
      'CLI surface recorded. Still REQUIRED before the provider may report verified:',
      '  1. bind a gateway to loopback and record the request/response bodies;',
      '  2. record the auth model -- the header NAME only, never a value;',
      '  3. record the timeout and streaming behaviour;',
      '  4. record session/thread semantics;',
      '  5. record the declared attachment MIME list and size ceiling.',
      '',
      'Flipping `verified` to true ALSO opens the 2C attachment gate, so step 5 is',
      'not optional. Pin zod schemas against these fixtures first.',
    ].join('\n') + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`openclaw probe failed: ${redact(err.message)}\n`);
  process.exit(1);
});
