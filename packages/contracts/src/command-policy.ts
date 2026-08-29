/**
 * One place that says what a command DOES, so nothing has to be inferred from
 * an argv table at a call site.
 *
 * Phase 1 already had the important property -- a frozen argv table per
 * integration and no shell anywhere -- but "is this table safe?" was a fact
 * you established by reading it. This module makes it a fact you can assert:
 * every command surface classifies its operations here, and a test can then
 * check that no surface reachable today is anything but read-only or a
 * contained local mutation.
 */

export const COMMAND_CLASSES = [
  /** Reads state and changes nothing, anywhere. */
  'read_only',
  /**
   * Changes something on THIS host, inside a path the operator already
   * allowlisted. A worktree checkout, a local branch.
   */
  'local_mutation',
  /**
   * Changes something outside this host, or something other people can see:
   * a push, a pull request, a deployment, a cloud resource.
   */
  'external_mutation',
  /**
   * Destructive, hard to reverse, or capable of destroying work that was never
   * committed. Never reachable, in any phase, from any table here.
   */
  'high_risk',
] as const;

export type CommandClass = (typeof COMMAND_CLASSES)[number];

export const COMMAND_CLASS_RANK = {
  read_only: 0,
  local_mutation: 1,
  external_mutation: 2,
  high_risk: 3,
} as const satisfies Record<CommandClass, number>;

/**
 * The highest class any command surface may be classified as in this phase.
 *
 * External mutation stops at the approval gate and its performer is
 * deliberately not implemented (ADR 0006), so nothing in the running system
 * may sit above a local mutation. A test asserts every classified operation
 * against this.
 */
export const MAX_ALLOWED_COMMAND_CLASS: CommandClass = 'local_mutation';

export const exceedsAllowedClass = (c: CommandClass): boolean =>
  COMMAND_CLASS_RANK[c] > COMMAND_CLASS_RANK[MAX_ALLOWED_COMMAND_CLASS];

export interface CommandPolicyEntry {
  /** The binary, as invoked. Never a shell string. */
  readonly bin: string;
  /** The subcommand path that identifies the operation, e.g. `['pr','list']`. */
  readonly verb: readonly string[];
  readonly cls: CommandClass;
  /** Why it is classified this way. Read by a human, not by code. */
  readonly note: string;
}

/**
 * Verbs that are never allowed to appear in ANY classified argv, whatever the
 * surrounding table claims.
 *
 * This is a belt-and-braces list, not the primary control -- the primary
 * control is that argv tables are frozen and take no caller input. It exists
 * so that adding a plausible-looking entry to a table trips a test rather than
 * shipping.
 */
export const FORBIDDEN_COMMAND_VERBS = [
  // Destroys uncommitted work or rewrites history.
  'reset', 'clean', 'prune', 'gc', 'filter-branch', 'filter-repo', 'amend',
  // Publishes, or changes something other people see. These remain forbidden
  // to the normal local-only caller; an approved-action caller may opt into
  // the external-mutation class, but still cannot opt into high-risk verbs.
  'push', 'publish', 'deploy', 'release',
  // Removes things.
  'rm', 'destroy', 'purge', 'drop',
  // Arbitrary execution or credential handling.
  'exec', 'eval', 'sh', 'bash', 'auth', 'login', 'token', 'credential',
] as const;

/** Verbs that remain forbidden even for an explicitly approved write. */
const ALWAYS_FORBIDDEN_COMMAND_VERBS = [
  'reset', 'clean', 'prune', 'gc', 'filter-branch', 'filter-repo', 'amend',
  'rm', 'destroy', 'purge', 'drop', 'exec', 'eval', 'sh', 'bash',
  'auth', 'login', 'token', 'credential',
] as const;

/** A `--flag` is not a verb; only bare words are checked. */
const isVerbWord = (s: string): boolean => /^[a-z][a-z0-9-]*$/.test(s);

export function findForbiddenVerb(
  argv: readonly string[],
  options: { readonly allowExternalMutation?: boolean } = {},
): string | undefined {
  const forbidden = options.allowExternalMutation
    ? ALWAYS_FORBIDDEN_COMMAND_VERBS
    : FORBIDDEN_COMMAND_VERBS;
  return argv.find((a) => isVerbWord(a) && (forbidden as readonly string[]).includes(a));
}

/** Force and hook-bypass flags are never accepted, including after approval. */
const FORBIDDEN_COMMAND_FLAGS = [
  '--force', '--force-with-lease', '--no-verify', '--amend', '-f',
] as const;

export function findForbiddenFlag(argv: readonly string[]): string | undefined {
  return argv.find((a) => (FORBIDDEN_COMMAND_FLAGS as readonly string[]).includes(a));
}

/**
 * Every command surface this system can reach, classified.
 *
 * `verb` is the identifying prefix, not the whole argv: the rest is repository
 * references and `--json` selectors that the individual tables already
 * constrain. A surface that is not listed here is not reachable, because there
 * is no dynamic command construction anywhere -- `runArgv` refuses a shell
 * string and every caller passes a frozen table entry.
 */
export const COMMAND_POLICY: readonly CommandPolicyEntry[] = Object.freeze([
  // -- gh, read-only inspection (packages/adapters/src/github/gh-cli.ts) -----
  { bin: 'gh', verb: ['repo', 'view'], cls: 'read_only', note: 'Repository metadata only.' },
  { bin: 'gh', verb: ['pr', 'list'], cls: 'read_only', note: 'Open pull requests.' },
  { bin: 'gh', verb: ['pr', 'view'], cls: 'read_only', note: 'One pull request.' },
  { bin: 'gh', verb: ['pr', 'checks'], cls: 'read_only', note: 'Check results for one PR.' },
  { bin: 'gh', verb: ['run', 'list'], cls: 'read_only', note: 'Workflow run history.' },
  { bin: 'gh', verb: ['issue', 'list'], cls: 'read_only', note: 'Open issues.' },
  {
    bin: 'gh', verb: ['pr', 'create'], cls: 'external_mutation',
    note: 'Creates a pull request; only the approved-action path may run it.',
  },

  // -- git, executor workspace resolution (packages/executor/src/workspace.ts)
  //
  // Every entry is READ-ONLY, and that is the whole point: workspace
  // resolution decides whether a job may proceed and never itself changes the
  // repository. Destructive verbs remain forbidden; external writes such as
  // push are classified below but require an explicitly approved caller.
  { bin: 'git', verb: ['rev-parse'], cls: 'read_only', note: 'Resolves a ref; writes nothing.' },
  { bin: 'git', verb: ['symbolic-ref'], cls: 'read_only', note: 'Reads a symbolic ref; --quiet, no write form used.' },
  { bin: 'git', verb: ['status'], cls: 'read_only', note: 'Working tree state.' },
  { bin: 'git', verb: ['diff'], cls: 'read_only', note: 'Changed-file or diff-summary inspection.' },
  { bin: 'git', verb: ['branch', '--show-current'], cls: 'read_only', note: 'Current branch inspection.' },
  { bin: 'git', verb: ['remote', 'get-url'], cls: 'read_only', note: 'Configured remote inspection.' },
  { bin: 'git', verb: ['add'], cls: 'local_mutation', note: 'Stages only explicitly approved repository-relative files.' },
  { bin: 'git', verb: ['commit'], cls: 'local_mutation', note: 'Creates a local commit from an approved proposal.' },
  { bin: 'git', verb: ['push'], cls: 'external_mutation', note: 'Publishes a branch; only the approved-action path may run it.' },
  { bin: 'git', verb: ['stash', 'list'], cls: 'read_only', note: 'Lists stashes; never applies, pops or drops one.' },
  { bin: 'git', verb: ['worktree', 'list'], cls: 'read_only', note: 'Lists worktrees; never adds or removes one.' },

  // -- herdr, orchestration (packages/adapters/src/herdr/herdr-cli.ts) -------
  { bin: 'herdr', verb: ['agent', 'list'], cls: 'read_only', note: 'Agent inventory.' },
  { bin: 'herdr', verb: ['agent', 'get'], cls: 'read_only', note: 'One agent record; changes nothing.' },
  {
    bin: 'herdr', verb: ['agent', 'read'], cls: 'read_only',
    note: 'Reads an agent pane snapshot. The readiness observation; never sends input.',
  },
  {
    bin: 'herdr', verb: ['agent', 'wait'], cls: 'read_only',
    note: 'Blocks until an agent reports one of the requested states. Observation only.',
  },
  { bin: 'herdr', verb: ['workspace', 'list'], cls: 'read_only', note: 'Workspace inventory.' },
  {
    bin: 'herdr', verb: ['workspace', 'create'], cls: 'local_mutation',
    note: 'Creates a Ducky-labelled workspace on this host only.',
  },
  {
    bin: 'herdr', verb: ['workspace', 'report-metadata'], cls: 'local_mutation',
    note: 'Annotates a workspace Ducky already owns.',
  },
  {
    bin: 'herdr', verb: ['worktree', 'create'], cls: 'local_mutation',
    note: 'Checks out a linked worktree under a Herdr-managed path.',
  },
  {
    bin: 'herdr', verb: ['pane', 'split'], cls: 'local_mutation',
    note: 'Opens a pane in a Ducky-owned workspace.',
  },
  {
    bin: 'herdr', verb: ['agent', 'start'], cls: 'local_mutation',
    note: 'Starts a Ducky-owned agent. Unverified on this host; the orchestrator reports experimental.',
  },
  {
    bin: 'herdr', verb: ['agent', 'prompt'], cls: 'local_mutation',
    note: 'Sends a prompt to a Ducky-owned agent. Unverified on this host.',
  },
  {
    bin: 'herdr', verb: ['workspace', 'close'], cls: 'local_mutation',
    note: 'Closes a workspace whose id is recorded in herdr_workspaces and holds no reservation.',
  },
  {
    bin: 'herdr', verb: ['worktree', 'remove'], cls: 'local_mutation',
    note:
      'Removes a Ducky-created linked worktree. NEVER forced: `--force` is a forbidden flag, so ' +
      'a dirty checkout holding uncommitted work is refused here rather than deleted.',
  },

  // -- openclaw, one conversational turn (packages/adapters/src/openclaw) ----
  //
  // Classified BEFORE the provider that uses it exists, because an
  // unclassified binary is refused before it spawns and the refusal would
  // otherwise surface as a mystery at the owner's first message.
  //
  // `local_mutation`, not `read_only`, and the distinction is real: a turn
  // writes a session record into OpenClaw's own store on this host. It is not
  // `external_mutation` either -- the reply comes back to Ducky and goes
  // nowhere else. `--deliver` is what would make it external, by sending agent
  // output into a chat channel, and the adapter never constructs it.
  {
    bin: 'openclaw', verb: ['agent'], cls: 'local_mutation',
    note:
      'One agent turn. Writes a session record in OpenClaw\'s local store and returns the reply ' +
      'to Ducky. NEVER built with --deliver, which would post the reply into a chat channel.',
  },
  {
    bin: 'openclaw', verb: ['models', 'status'], cls: 'read_only',
    note: 'Reports which model and auth profile are configured. Reads no credential value.',
  },
]);

/**
 * Where the verb starts, once leading global flags are skipped.
 *
 * Some CLIs take their profile selector as a ROOT option, before the
 * subcommand -- `openclaw --dev agent …` is the recorded shape, and pinning
 * Ducky to the wrong OpenClaw profile is not an option. Index-0 matching alone
 * would classify that as unlisted and refuse it.
 *
 * Only BOOLEAN leading flags are skipped, and deliberately so. A flag that
 * takes a separate value (`--profile dev agent …`) leaves `dev` where the verb
 * should be, which matches nothing and is refused. That is the correct
 * direction to fail in: a form this function cannot read confidently is a form
 * it does not clear.
 *
 * The forbidden-verb and forbidden-flag scans are unaffected -- both run over
 * the WHOLE argv, including everything skipped here.
 */
function verbOffset(argv: readonly string[]): number {
  let i = 0;
  while (i < argv.length && argv[i]!.startsWith('-')) i += 1;
  return i;
}

const matchesVerb = (argv: readonly string[], verb: readonly string[]): boolean => {
  const off = verbOffset(argv);
  return verb.every((v, i) => argv[off + i] === v);
};

/**
 * Classifies an argv against the policy, longest match first.
 *
 * Returns undefined for anything unlisted, and an unlisted command is a
 * REFUSAL rather than a default: `assertCommandAllowed` will not let one
 * through, so a new surface has to be classified deliberately.
 */
export function classifyCommand(
  bin: string,
  argv: readonly string[],
): CommandPolicyEntry | undefined {
  return [...COMMAND_POLICY]
    .filter((e) => e.bin === bin && matchesVerb(argv, e.verb))
    .sort((a, b) => b.verb.length - a.verb.length)[0];
}

export interface CommandRefusal {
  readonly reason: 'unclassified' | 'forbidden_verb' | 'class_not_allowed';
  readonly detail: string;
  readonly cls?: CommandClass;
}

/**
 * The single decision point. Returns undefined when the command is allowed,
 * or a structured refusal.
 *
 * Callers use this in addition to their own frozen argv table, not instead of
 * it: the table decides what can be constructed at all, and this decides
 * whether what was constructed is a thing this phase permits to run.
 */
export function checkCommandAllowed(
  bin: string,
  argv: readonly string[],
  maxClass: CommandClass = MAX_ALLOWED_COMMAND_CLASS,
): CommandRefusal | undefined {
  const allowExternalMutation = COMMAND_CLASS_RANK[maxClass] >= COMMAND_CLASS_RANK.external_mutation;
  const forbidden = findForbiddenVerb(argv, { allowExternalMutation });
  if (forbidden !== undefined) {
    return { reason: 'forbidden_verb', detail: `\`${forbidden}\` is never permitted.` };
  }
  const flag = findForbiddenFlag(argv);
  if (flag !== undefined) {
    return { reason: 'forbidden_verb', detail: `\`${flag}\` is never permitted.` };
  }
  const entry = classifyCommand(bin, argv);
  if (!entry) {
    // Named from where the VERB starts, not from argv[0]: with a root flag in
    // front, argv[0] is `--dev` and a refusal that said so would be unhelpful.
    return {
      reason: 'unclassified',
      detail: `\`${bin}\` ${argv[verbOffset(argv)] ?? ''} is not a classified command.`,
    };
  }
  if (COMMAND_CLASS_RANK[entry.cls] > COMMAND_CLASS_RANK[maxClass]) {
    return {
      reason: 'class_not_allowed',
      cls: entry.cls,
      detail: `\`${bin}\` ${entry.verb.join(' ')} is ${entry.cls.replace(/_/g, ' ')} and is not permitted by this caller.`,
    };
  }
  return undefined;
}
