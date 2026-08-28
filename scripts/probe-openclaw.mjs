#!/usr/bin/env node
/**
 * PROBE C -- records the real OpenClaw contract, as far as this host can.
 *
 * OpenClaw IS now installed on this host: pinned, and into a dedicated local
 * prefix rather than globally --
 * `~/.local/opt/ducky-openclaw/node_modules/.bin/openclaw`. Nothing about it is
 * on `PATH`, so this script looks for the pinned binary first and falls back to
 * `PATH` for an operator who installed it elsewhere.
 *
 * WHAT IT RECORDS, and what it deliberately cannot:
 *
 * - the CLI version and the top-level command surface;
 * - the `agent` REQUEST contract -- the flags Ducky would build an argv from,
 *   which is the half a caller controls;
 * - the auth model, by running a turn and recording HOW it fails;
 * - session semantics (`--session-key agent:<id>:<key>`);
 * - the gateway transport, bind modes and auth modes;
 * - whether an agent turn accepts an ATTACHMENT at all.
 *
 * It cannot record a successful REPLY, because an agent turn needs model
 * provider credentials that are not configured on this host. That is the exact
 * blocker, and it is why `RECORDED_CONTRACT_VERSION` stays null: half a contract
 * is not a contract, and inventing the reply shape is precisely what this file
 * exists to refuse.
 *
 * SAFETY
 * - Read-only against OpenClaw's own state, and everything runs under the
 *   `--dev` profile so nothing touches a real configuration.
 * - It never runs `onboard`, `configure`, `channels add` or `pairing`: no
 *   channel is connected, no account is paired, nothing is sent anywhere.
 * - It never passes `--deliver`, so no agent output could reach a chat channel.
 * - It captures configuration KEY NAMES and the auth error CLASS only, never a
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

/** The pinned local install, preferred over anything on PATH. */
const PINNED = path.join(HOME, '.local/opt/ducky-openclaw/node_modules/.bin/openclaw');

/** Everything that makes this run NOT a complete recording. */
const gaps = [];

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
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
    // ANSI colour from the CLI's diagnostics, which would make a fixture unreadable.
    .replace(/\[[0-9;]*m/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED:guid]')
    .replace(/\b(sk|pk|api|key|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, '[REDACTED:secretish]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]');

/** Flag names only, from a `--help` block. Never an example value. */
const flagsOf = (help) =>
  [...new Set((redact(help).match(/(?:^|\s)(--[a-z][a-z0-9-]*)/g) ?? []).map((f) => f.trim()))].sort();

async function main() {
  const bin = existsSync(PINNED)
    ? PINNED
    : (await run('sh', ['-c', 'command -v openclaw || true'])).stdout.trim();

  if (bin === '') {
    process.stderr.write(
      [
        'openclaw is not installed on this host, so there is no contract to record.',
        '',
        'This is the BLOCKER, stated plainly rather than worked around:',
        '  * the conversation provider throws and no API is guessed;',
        '  * openclaw-contract.test.ts skips, so nothing passes on a fiction;',
        '  * /status reports the provider unverified;',
        '  * DUCKY_CONVERSATION_PROVIDER=disabled is the honest production mode.',
        '',
        'Install it PINNED and LOCAL (never -g), e.g.',
        '  npm i --prefix ~/.local/opt/ducky-openclaw openclaw@<exact version>',
        'See docs/integrations/openclaw.md.',
      ].join('\n') + '\n',
    );
    process.exit(2);
  }

  mkdirSync(FIXTURES, { recursive: true });
  const record = (name, body) => {
    writeFileSync(path.join(FIXTURES, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
    process.stdout.write(`recorded ${name}.json\n`);
  };

  // ---- the CLI itself ------------------------------------------------------
  const version = await run(bin, ['--version']);
  const help = await run(bin, ['--help']);
  // `  name` or `  name *` (the star marks a command with subcommands).
  const commands = [
    ...new Set(
      (redact(help.stdout).match(/^ {2}([a-z][a-z0-9-]*)(?: \*)?\s{2,}\S/gm) ?? [])
        .map((m) => m.trim().split(/\s/)[0]),
    ),
  ].sort();

  record('cli', {
    _note: 'Recorded by scripts/probe-openclaw.mjs. Redacted; no value is captured.',
    installedFrom: bin.startsWith(HOME) ? 'pinned local prefix' : 'PATH',
    version: redact(version.stdout.trim()),
    helpExitCode: help.code,
    commands,
  });

  // ---- the request contract Ducky would build ------------------------------
  const agentHelp = await run(bin, ['agent', '--help']);
  const messageHelp = await run(bin, ['message', 'send', '--help']);
  const agentFlags = flagsOf(agentHelp.stdout);
  record('agent-cli-contract', {
    _note:
      'The REQUEST half of the contract: the flags a caller controls. Flag NAMES only. ' +
      'Ducky would never pass --deliver: that would send agent output into a chat channel.',
    exitCode: agentHelp.code,
    flags: agentFlags,
    /** The three that matter to the port, called out so a drift is obvious. */
    carriesMessage: agentFlags.includes('--message'),
    carriesSessionKey: agentFlags.includes('--session-key'),
    carriesJsonOutput: agentFlags.includes('--json'),
    canDeliverToChannel: agentFlags.includes('--deliver'),
    /**
     * The finding that settles milestone 2C for this provider: an agent TURN
     * takes text only. `message send --media` exists, but that is OUTBOUND to a
     * chat channel, not an attachment on a turn.
     */
    // `--message-file` is deliberately NOT counted: it reads the message BODY
    // from a UTF-8 file, which is text the caller already had. An attachment is
    // a payload of a declared content type, and the turn has no flag for one.
    attachmentInputOnAgentTurn: agentFlags.filter(
      (f) => /media|attach|image|document|photo/.test(f),
    ),
    messageSendHasMedia: flagsOf(messageHelp.stdout).includes('--media'),
  });

  // ---- the transport ------------------------------------------------------
  const gatewayHelp = await run(bin, ['gateway', '--help']);
  const gatewayText = redact(gatewayHelp.stdout);
  record('gateway-contract', {
    _note:
      'OpenClaw is a WebSocket gateway, NOT the HTTP JSON endpoint the first ' +
      'adapter assumed. Recorded so the assumption cannot survive in code.',
    exitCode: gatewayHelp.code,
    flags: flagsOf(gatewayHelp.stdout),
    bindModes: (/Bind mode\s*\n?\s*\(([^)]+)\)/.exec(gatewayText)?.[1] ?? '')
      .split('|').map((s) => s.replace(/["\s]/g, '')).filter(Boolean),
    authModes: (/Gateway auth mode\s*\n?\s*\(([^)]+)\)/.exec(gatewayText)?.[1] ?? '')
      .split('|').map((s) => s.replace(/["\s]/g, '')).filter(Boolean),
    devDefaultUrl: /ws:\/\/127\.0\.0\.1:\d+/.exec(gatewayText)?.[0] ?? null,
  });

  // ---- the auth model, observed rather than described ----------------------
  //
  // A real turn, in the isolated dev profile, with no channel delivery. Without
  // model provider credentials this FAILS, and how it fails is the fact worth
  // recording: it is the exact blocker between here and a verified provider.
  const turn = await run(
    bin,
    [
      '--dev', '--no-color', 'agent', '--local', '--json',
      '--session-key', 'agent:probe:ducky-probe',
      '--message', 'reply with the single word pong',
    ],
    { timeout: 90_000 },
  );
  const stderr = redact(turn.stderr);
  const authError = /(\w*AuthError)/.exec(stderr)?.[1] ?? null;
  record('agent-turn-attempt', {
    _note:
      'A REAL turn attempt. Records the SHAPE of the outcome only: no reply text, ' +
      'no credential, no absolute path.',
    exitCode: turn.code,
    stdoutEmpty: turn.stdout.trim() === '',
    stdoutIsJson: turn.stdout.trim().startsWith('{'),
    diagnosticsOnStderr: stderr.trim() !== '',
    errorClass: authError,
    /** The provider it looked for auth for, which is a configuration fact. */
    providerNamed: /No API key found for provider "([a-z0-9-]+)"/.exec(stderr)?.[1] ?? null,
    remediationOffered: /openclaw --profile dev agents add/.test(stderr),
  });

  if (turn.code === 0 && turn.stdout.trim().startsWith('{')) {
    record('agent-turn-reply', {
      _note: 'Shape only: keys of a SUCCESSFUL reply envelope. No content.',
      keys: Object.keys(JSON.parse(turn.stdout)).sort(),
    });
  } else {
    gaps.push(
      'no successful agent turn: the reply envelope is unrecorded because no model ' +
        `provider credential is configured${authError ? ` (${authError})` : ''}`,
    );
  }

  // ---- configuration locations, names only --------------------------------
  const configDirs = ['.openclaw', '.openclaw-dev', '.config/openclaw'].map((d) => path.join(HOME, d));
  record('config-locations', {
    _note: 'Existence and directory NAMES only. No value is ever read or recorded.',
    directories: configDirs.map((d) => ({ path: d.split(HOME).join('~'), exists: existsSync(d) })),
  });

  process.stdout.write('\n');
  if (gaps.length === 0) {
    process.stdout.write('Full contract recorded. Pin schemas against these fixtures next.\n');
    process.exit(0);
  }

  process.stdout.write(
    [
      'RECORDED, PARTIAL. What is missing, exactly:',
      ...gaps.map((g) => `  * ${g}`),
      '',
      'Consequences, stated rather than worked around:',
      '  * RECORDED_CONTRACT_VERSION stays null;',
      '  * the conversation provider stays unverified and refuses to answer;',
      '  * DUCKY_CONVERSATION_PROVIDER=disabled remains the honest production mode;',
      '  * the 2C attachment gate stays closed -- and an agent turn takes TEXT ONLY,',
      '    so it would stay closed for this provider even with credentials.',
      '',
      'The owner action that would close the gap: configure a model provider for an',
      'OpenClaw agent (`openclaw agents add <id>`), then run this probe again.',
      'Nothing here will do that: it spends money on somebody else\'s account.',
    ].join('\n') + '\n',
  );
  // Exit 2 is "there is a blocker", the same code the absent-install path uses.
  // A partial recording must not read as success.
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`openclaw probe failed: ${redact(err.message)}\n`);
  process.exit(1);
});
