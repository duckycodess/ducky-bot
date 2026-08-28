#!/usr/bin/env node
/**
 * PROBE D -- records what the local `gh` will actually answer for, WITHOUT
 * touching any repository.
 *
 * WHY THIS EXISTS. The watch feature needs more than open-PR titles: commits,
 * reviews, requested changes, checks, workflow runs, merges, issue updates. Each
 * of those is a `--json` field selector, and a selector `gh` does not support is
 * an argv that fails at runtime rather than at review time. Guessing them would
 * be the same mistake the Herdr mocks made.
 *
 * `gh <command> --json` with no value prints the exact set of fields that
 * command supports, and it does so LOCALLY: no repository is named, no network
 * request is made, no token is used. That is the contract this records.
 *
 * WHAT IT CANNOT RECORD. Real response VALUES. That needs a real repository, and
 * no GitHub repository is configured in this host's allowlist (`github: null`),
 * so there is nothing here to point at. Choosing one would mean reaching for
 * somebody's repository on my own initiative, which is exactly the kind of thing
 * this probe exists not to do. The schemas built on this record are therefore
 * TOLERANT -- every added field is optional -- and the watch feature stays
 * "unit-tested only; no live watch has run on this host".
 *
 * SAFETY
 * - Read-only, local, and repo-less. It never names a repository.
 * - No write verb is ever constructed; the recorded field lists are checked
 *   against the frozen argv table by `gh-fields.test.ts`.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'packages/adapters/src/github/gh.fixtures');
const HOME = os.homedir();

const run = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }),
    );
  });

const redact = (t) => String(t).split(HOME).join('~');

/**
 * The field list `gh` prints when `--json` is given no value.
 *
 * It goes to stderr on some versions and stdout on others, so both are read --
 * a contract recorder that depended on which stream a CLI chose would be
 * recording its own assumptions.
 */
const fieldsOf = (res) => {
  const text = redact(`${res.stdout}\n${res.stderr}`);
  const start = text.indexOf('--json`:');
  const body = start >= 0 ? text.slice(start) : text;
  return [...new Set((body.match(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*$/gm) ?? []).map((s) => s.trim()))].sort();
};

/** Exactly the read-only surfaces the watch feature draws on. */
const COMMANDS = [
  ['repo', 'view'],
  ['pr', 'list'],
  ['pr', 'view'],
  ['pr', 'checks'],
  ['run', 'list'],
  ['issue', 'list'],
];

async function main() {
  const version = await run(['--version']);
  if (version.code !== 0) {
    process.stderr.write('gh is not available on this host; nothing recorded.\n');
    process.exit(2);
  }

  mkdirSync(FIXTURES, { recursive: true });

  const surfaces = {};
  for (const argv of COMMANDS) {
    const res = await run([...argv, '--json']);
    const fields = fieldsOf(res);
    surfaces[argv.join(' ')] = { exitCode: res.code, fields };
    process.stdout.write(`${argv.join(' ')}: ${fields.length} field(s)\n`);
  }

  const missing = Object.entries(surfaces).filter(([, s]) => s.fields.length === 0);

  writeFileSync(
    path.join(FIXTURES, 'json-fields.json'),
    `${JSON.stringify(
      {
        _note:
          'Recorded by scripts/probe-gh.mjs. Field NAMES only, printed by gh itself with no ' +
          'repository named and no network request. Response VALUES are not recorded: no ' +
          'GitHub repository is configured in this host allowlist, and picking one would mean ' +
          'reaching for a repository nobody selected.',
        ghVersion: redact(version.stdout.split('\n')[0] ?? '').trim(),
        surfaces,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write('recorded json-fields.json\n');

  if (missing.length > 0) {
    process.stderr.write(
      `no field list could be read for: ${missing.map(([k]) => k).join(', ')}\n` +
        'A recorder that records nothing must not exit 0.\n',
    );
    process.exit(3);
  }
  process.stdout.write(
    '\nField names recorded. Response VALUES remain unrecorded on this host: no GitHub\n' +
      'repository is configured, so the watch feature stays unit-tested only and every\n' +
      'added schema field is optional.\n',
  );
}

main().catch((err) => {
  process.stderr.write(`gh probe failed: ${redact(err.message)}\n`);
  process.exit(1);
});
