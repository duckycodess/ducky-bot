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
 * When the selected profile is signed in, it records a successful REPLY as a
 * type-only shape. When it is not signed in, it records the failure class and
 * leaves the reply fixture absent. A partial contract is never treated as a
 * successful integration, and a reply fixture never contains model text.
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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'packages/adapters/src/openclaw/openclaw.fixtures');
const HOME = os.homedir();

/** The pinned local install, preferred over anything on PATH. */
const PINNED = path.join(HOME, '.local/opt/ducky-openclaw/node_modules/.bin/openclaw');

/**
 * BLOCKERS. Everything that makes this run not a complete recording of the
 * contract Ducky depends on, and the only thing that decides the exit code.
 */
const gaps = [];

/**
 * OBSERVATIONS that are not blockers.
 *
 * The distinction is load-bearing and it was wrong once. The session-deletion
 * surface pushed a line here on BOTH branches -- found and not found -- which
 * made `gaps.length === 0` unreachable and so made exit 0 impossible. The
 * probe would have reported "RECORDED, PARTIAL" with the full contract
 * recorded, and the consequences it then printed (provider unverified,
 * conversation refuses) would have been false.
 *
 * A probe that cannot succeed is not a certifier, and one that prints
 * consequences that are not true is worse than one that prints nothing. So:
 * deletion findings are notes, they never touch the exit code, and they carry
 * their own precise consequence.
 */
const notes = [];

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

/**
 * A value's SHAPE, with every leaf replaced by its type.
 *
 * The recursion is what makes the reply envelope safe to commit: a string
 * never survives it, so the model's actual answer cannot reach a fixture.
 * Arrays collapse to one merged item shape plus a count -- ten payloads have
 * one shape, and recording ten copies would only add ten chances to leak.
 */
function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const merged = {};
    for (const item of v) {
      const s = shapeOf(item);
      if (typeof s === 'string') merged['*'] = s;
      else for (const [k, val] of Object.entries(s)) merged[k] = val;
    }
    return { '[]': v.length === 0 ? 'empty' : merged, length: String(v.length) };
  }
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = shapeOf(val);
    return o;
  }
  return typeof v;
}

/** Flag names only, from a `--help` block. Never an example value. */
const flagsOf = (help) =>
  [...new Set((redact(help).match(/(?:^|\s)(--[a-z][a-z0-9-]*)/g) ?? []).map((f) => f.trim()))].sort();

/** Subcommand names that would, in principle, remove something. */
export const DELETION_VERBS = Object.freeze([
  'delete', 'remove', 'clear', 'forget', 'reset', 'purge', 'rm',
]);

/**
 * Verbs this repository refuses to construct in ANY argv, whatever a CLI
 * offers.
 *
 * Mirrors `ALWAYS_FORBIDDEN_COMMAND_VERBS` in `@ducky/contracts`. The list is
 * not going to be relaxed to make a deletion possible, so a surface that needs
 * one of these is unusable here by POLICY rather than by capability, and
 * saying which of the two it is matters to whoever reads the report.
 */
export const ARGV_FORBIDDEN_VERBS = Object.freeze([
  'reset', 'purge', 'rm', 'destroy', 'drop',
]);

/**
 * What the recorded deletion surface means, as a NOTE rather than a blocker.
 *
 * Pure, exported and unit-tested, because the classification is the part that
 * was wrong: both branches used to push a BLOCKER, which made a clean run
 * impossible and made the probe print consequences that were not true.
 *
 * Every outcome here leaves `RECORDED_SESSION_DELETION` null, because none of
 * them is evidence that a deletion WORKS -- a command name is not a command
 * that was run, and a command that was run is not a readback proving the
 * session is gone. The three cases differ in what the owner would have to do
 * next, which is the only reason to tell them apart at all.
 */
export function classifyDeletionSurface({ named, usable }) {
  if (named.length === 0) {
    return (
      'session deletion: OpenClaw names no deletion subcommand under `sessions`, ' +
      '`transcripts` or `memory`. Nothing to verify, and nothing to do about it. ' +
      'RECORDED_SESSION_DELETION stays null and `/forget conversation` reports provider ' +
      'deletion as PARTIAL, rotating the session epoch so stale context cannot return.'
    );
  }
  if (usable.length === 0) {
    return (
      `session deletion: the only candidates (${named.join(', ')}) use verbs this ` +
      'repository never builds an argv from, so they are unusable by POLICY rather than ' +
      'by capability. Relaxing ALWAYS_FORBIDDEN_COMMAND_VERBS is not on the table. ' +
      'RECORDED_SESSION_DELETION stays null and `/forget conversation` reports PARTIAL.'
    );
  }
  return (
    `session deletion: a usable candidate exists (${usable.join(', ')}) and has NOT been ` +
    'exercised. Recording a command NAME is not evidence it works, so this changes nothing ' +
    'on its own: RECORDED_SESSION_DELETION stays null until a narrow deletion AND an ' +
    'independent readback proving the session is gone have both been observed, against a ' +
    'session this probe created for the purpose. Until then `/forget conversation` reports ' +
    'PARTIAL and rotates the session epoch.'
  );
}

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

  // ---- the TOOL POLICY, which decides what a turn can reach ---------------
  //
  // Ducky documents conversation as a route with no tool access. That was true
  // of Ducky and not of the agent: `tools.profile` decides what a turn may
  // reach, and the docs are explicit that UNSET means `full` -- filesystem,
  // runtime and web. On this host the key was absent entirely.
  //
  // Recorded here because a security property that nothing re-reads is a
  // property that drifts.
  const readPath = async (dotPath) => {
    const r = await run(bin, ['--dev', '--no-color', 'config', 'get', dotPath]);
    const out = redact(`${r.stdout}${r.stderr}`).trim();
    return /config path not found/i.test(out) || out === '' ? null : out;
  };
  const toolProfile = await readPath('tools.profile');
  const toolDeny = await readPath('tools.deny');
  // Scopes that could GRANT a tool to the ducky agent. The global profile
  // being `minimal` proves nothing while one of these can override it.
  const overrideScopes = {};
  for (const dotPath of [
    'agents.list', 'agents.defaults.tools', 'tools.byProvider',
    'tools.toolsBySender', 'tools.allow', 'tools.alsoAllow', 'tools.elevated',
  ]) {
    overrideScopes[dotPath] = (await readPath(dotPath)) !== null;
  }
  const anyOverride = Object.values(overrideScopes).some(Boolean);
  const profileIsMinimal = (toolProfile ?? '').replace(/["']/g, '').trim() === 'minimal';
  const deniesSessionStatus = /session_status/.test(toolDeny ?? '');

  // ---- a real turn, observed rather than described -------------------------
  //
  // In the isolated dev profile, with no channel delivery. Before a model
  // provider was configured this FAILED, and how it failed was the fact worth
  // recording. Now it succeeds, and the reply envelope is the other half of the
  // contract.
  //
  // The argv is built ONCE, here, and recorded alongside the outcome. That is
  // what lets a test assert the shipped adapter builds the same call: an
  // adapter written against a reply envelope that arrived from some OTHER
  // invocation would be pinned to evidence it did not produce.
  // The message body goes in a FILE, not in argv, and that is a safety
  // requirement rather than a style choice. `checkCommandAllowed` scans every
  // argv element for forbidden verbs, so an ordinary owner question containing
  // "push", "login" or "auth" would be refused before it ever reached the
  // subprocess. `--message-file` keeps the owner's words out of the command
  // line entirely.
  //
  // The probe therefore exercises the invocation Ducky ACTUALLY builds. A
  // recording of `--message` would have pinned the contract to a call the
  // adapter never makes.
  const PROBE_MESSAGE = 'reply with the single word pong';
  const messageFile = path.join(os.tmpdir(), `ducky-openclaw-probe-${process.pid}.txt`);
  writeFileSync(messageFile, PROBE_MESSAGE, { mode: 0o600 });
  const turnArgv = [
    '--dev', '--no-color', 'agent', '--local', '--json',
    // The SAME agent id the provider targets.
    //
    // This used to be `agent:probe:...`, which measured a DIFFERENT agent:
    // per-agent tool profiles exist, so a tool count recorded against `probe`
    // proved nothing about the agent Ducky actually talks to. The key shape
    // matches `GatewayOpenClawProvider.sessionKeyFor` -- `agent:ducky:<32 hex>`
    // -- with a fixed all-zero digest so a probe run never lands in a real
    // conversation's session.
    '--session-key', `agent:ducky:${'0'.repeat(32)}`,
    '--message-file', messageFile,
  ];
  let turn;
  try {
    turn = await run(bin, turnArgv, { timeout: 90_000 });
  } finally {
    rmSync(messageFile, { force: true });
  }
  const stderr = redact(turn.stderr);
  const authError = /(\w*AuthError)/.exec(stderr)?.[1] ?? null;
  record('agent-turn-attempt', {
    _note:
      'A REAL turn attempt. Records the SHAPE of the outcome only: no reply text, ' +
      'no credential, no absolute path.',
    /**
     * The exact call that produced the recorded reply, with the message BODY
     * replaced. Flags and their fixed values are contract; the prompt is not.
     *
     * `--local` is part of it and is not incidental: that is the invocation
     * that was actually exercised, so it is the invocation the adapter builds.
     * A gateway-backed run is a different code path and has not been observed.
     */
    requestArgv: turnArgv.map((a) => (a === messageFile ? '<message-file>' : a)),
    /** Asserted here so a drift trips the probe, not just a reader. */
    neverDelivers: !turnArgv.includes('--deliver'),
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
    const envelope = JSON.parse(turn.stdout);
    /**
     * How many tools the model was ACTUALLY handed on this turn.
     *
     * The decisive number, and the reason this is evidence rather than a
     * reading of the documentation: it answers whether `--local` honours
     * `tools.profile` at all. Recorded before the policy it was 31; with
     * `minimal` plus a `session_status` deny it is 0, from the same
     * invocation.
     */
    const toolsExposed =
      envelope?.meta?.systemPromptReport?.tools?.entries?.length ?? null;

    record('tool-policy', {
      _note:
        'The effective OpenClaw tool policy, and what the model was actually given. ' +
        'Names and counts only; no tool schema and no config value beyond the profile name.',
      profile: toolProfile,
      /** Which agent the tool count below was measured against. */
      measuredAgentId: 'ducky',
      denyIncludesSessionStatus: deniesSessionStatus,
      profileIsMinimal,
      /** Presence only, never the value: an override is a yes/no question. */
      overrideScopesConfigured: overrideScopes,
      anyOverrideScopeConfigured: anyOverride,
      /** 0 is the only acceptable number for a text-only conversation route. */
      toolsExposedToModel: toolsExposed,
      textOnly:
        profileIsMinimal && deniesSessionStatus && toolsExposed === 0 && !anyOverride,
      _evidence:
        'Recorded at 31 tools with no profile set; 0 under minimal + deny. Same --local ' +
        'invocation both times, which is what proves --local honours the policy.',
    });

    if (!(profileIsMinimal && deniesSessionStatus && toolsExposed === 0 && !anyOverride)) {
      gaps.push(
        `the agent turn is NOT provably text-only (profile=${toolProfile ?? 'unset'}, ` +
          `tools exposed=${toolsExposed ?? 'unknown'}, override scopes=${anyOverride}). ` +
          'An unset profile means `full`, and a per-agent scope can override it.',
      );
    }
    record('agent-turn-reply', {
      _note:
        'A SUCCESSFUL reply envelope, recorded as SHAPE ONLY: every leaf is replaced by its ' +
        'TYPE. The agent answered a real prompt, so its text is the model\'s output and this ' +
        'file must not contain it -- but a parser cannot be written against a list of ' +
        'top-level key names either, which is what this recorded before.',
      keys: Object.keys(envelope).sort(),
      shape: shapeOf(envelope),
      /**
       * The three the port depends on, called out so a drift is loud rather
       * than buried in a shape tree.
       */
      hasPayloads: Array.isArray(envelope.payloads),
      payloadCount: Array.isArray(envelope.payloads) ? envelope.payloads.length : 0,
      firstPayloadKeys: Array.isArray(envelope.payloads) && envelope.payloads[0]
        ? Object.keys(envelope.payloads[0]).sort()
        : [],
      /** Present only with --deliver, which Ducky never passes. Expect false. */
      hasDeliveryStatus: Object.hasOwn(envelope, 'deliveryStatus'),
      /** `in_flight` when a run for this session is already active. */
      status: typeof envelope.status === 'string' ? envelope.status : null,
    });
  } else {
    gaps.push(
      'no successful agent turn: the reply envelope is unrecorded because the ' +
        `agent invocation failed${authError ? ` (${authError})` : ''}`,
    );
  }

  // ---- the SESSION-DELETION surface, names only ---------------------------
  //
  // /forget deletes Ducky's own conversation turns and cannot reach OpenClaw's
  // session transcript (ADR 0024). Whether it ever could is a question about
  // THIS surface, and the first half of answering it is recording what the
  // surface is -- subcommand and flag NAMES, from `--help`, with no session id
  // and no session value ever read.
  //
  // Every command here is `--help` and nothing else. The probe does not list
  // sessions, does not read a transcript, and above all does not DELETE one:
  // a probe that deleted something to find out whether it could delete things
  // would be the worst possible way to learn it.
  //
  // Recording this does not authorize deletion. Deletion stays unsupported
  // until a NARROW command and an INDEPENDENT readback have both been
  // observed, and `RECORDED_SESSION_DELETION` is the constant that says so.
  const deletionSurfaces = {};
  for (const [name, argv] of [
    ['sessions', ['sessions', '--help']],
    ['transcripts', ['transcripts', '--help']],
    ['memory', ['memory', '--help']],
  ]) {
    const out = await run(bin, argv);
    const text = redact(out.stdout);
    deletionSurfaces[name] = {
      exitCode: out.code,
      present: out.code === 0,
      flags: flagsOf(out.stdout),
      // Subcommand names only, read the same way the top-level list is.
      subcommands: [
        ...new Set(
          (text.match(/^ {2}([a-z][a-z0-9-]*)(?: \*)?\s{2,}\S/gm) ?? [])
            .map((m) => m.trim().split(/\s/)[0]),
        ),
      ].sort(),
    };
  }

  const named = Object.entries(deletionSurfaces).flatMap(([surface, info]) =>
    info.subcommands.filter((c) => DELETION_VERBS.includes(c)).map((c) => `${surface} ${c}`),
  );
  const usable = named.filter((n) => !ARGV_FORBIDDEN_VERBS.includes(n.split(' ')[1]));

  record('session-deletion-surface', {
    _note:
      'Which OpenClaw commands could, in principle, remove a session. NAMES ONLY -- no ' +
      'session id, no transcript, no value. Nothing was deleted to record this, and ' +
      'recording it does not authorize deletion: that needs a verified narrow command AND ' +
      'an independent readback proving the session is gone.',
    surfaces: deletionSurfaces,
    deletionVerbsNamed: named,
    /** Named, minus the verbs this repository refuses to build an argv from. */
    deletionVerbsUsableUnderArgvPolicy: usable,
    readbackCommandNamed:
      (deletionSurfaces.sessions?.subcommands ?? []).some((c) => ['list', 'show', 'get'].includes(c)),
    verifiedDeletion: false,
    verifiedReadback: false,
  });

  notes.push(classifyDeletionSurface({ named, usable }));

  // ---- configuration locations, names only --------------------------------
  const configDirs = ['.openclaw', '.openclaw-dev', '.config/openclaw'].map((d) => path.join(HOME, d));
  record('config-locations', {
    _note: 'Existence and directory NAMES only. No value is ever read or recorded.',
    directories: configDirs.map((d) => ({ path: d.split(HOME).join('~'), exists: existsSync(d) })),
  });

  process.stdout.write('\n');

  /**
   * Notes print on BOTH paths and never decide the exit code.
   *
   * They describe things worth knowing that are not blockers -- the
   * session-deletion surface is the only one today. Folding them into `gaps`
   * is precisely the bug this separation fixes: it made exit 0 unreachable and
   * made the blocker consequences below print when they were false.
   */
  if (notes.length > 0) {
    process.stdout.write(
      ['Observations (NOT blockers; the exit code ignores these):',
        ...notes.map((n) => `  * ${n}`), ''].join('\n') + '\n',
    );
  }

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
      'Session deletion is NOT one of these consequences. It is reported above as an',
      'observation, it stays unsupported whether or not this run is complete, and it',
      'has never affected the exit code.',
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

/**
 * Only run when invoked directly.
 *
 * Without this, importing the module to unit-test `classifyDeletionSurface`
 * would start a real probe as a side effect of loading the file -- which is
 * the same trap `probe-live-job.ts` guards against, for the same reason.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`openclaw probe failed: ${redact(err.message)}\n`);
    process.exit(1);
  });
}
