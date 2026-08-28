import { DUCKY_PROFILES, OWNER_ONLY_COMMANDS, PROFILE_ENV } from '@ducky/contracts';
import { commandScopeFor, resolveDiscordProfile } from './profile-config.js';
import { redact } from '@ducky/adapters';

/**
 * Prints the slash-command definitions.
 *
 * Registering commands is a write to Discord, so it never happens at boot. Run
 * this deliberately with a token present. Without `--apply` it only prints the
 * payload, which is what CI and a dry run should do.
 */
const COMMANDS = [
  { name: 'capture', description: 'Save a short note (owner only)', options: [{ name: 'text', type: 3, required: true, description: 'What to capture' }] },
  { name: 'inbox', description: 'List captures (owner only)', options: [{ name: 'status', type: 3, required: false, description: 'open | done | archived | all' }] },
  { name: 'schedule', description: 'Preview and confirm schedule entries (owner only)', options: [
    { name: 'text', type: 3, required: false, description: 'Schedule text' },
    { name: 'file', type: 11, required: false, description: 'A .txt or .csv file' },
  ] },
  { name: 'jobs', description: 'Recent coding jobs (owner only)' },
  { name: 'job', description: 'Coding job control (owner only)', options: [
    { name: 'submit', type: 1, description: 'Submit a coding job', options: [
      { name: 'repo', type: 3, required: true, description: 'Allowlisted repository slug' },
      { name: 'task', type: 3, required: true, description: 'What to do' },
      { name: 'context', type: 3, required: false, description: 'Extra context' },
      { name: 'bootstrap', type: 5, required: false, description: 'Greenfield bootstrap' },
    ] },
    { name: 'status', type: 1, description: 'Show a job', options: [{ name: 'id', type: 3, required: true, description: 'Job id' }] },
    { name: 'cancel', type: 1, description: 'Cancel a job', options: [{ name: 'id', type: 3, required: true, description: 'Job id' }] },
    { name: 'answer', type: 1, description: 'Answer a job question', options: [
      { name: 'id', type: 3, required: true, description: 'Job id' },
      { name: 'answer', type: 3, required: true, description: 'Your answer' },
    ] },
    { name: 'cleanup', type: 1, description: 'Release an orphaned repository reservation', options: [
      { name: 'id', type: 3, required: true, description: 'Job id' },
      { name: 'force', type: 5, required: false, description: 'Force release' },
    ] },
    { name: 'execute', type: 1, description: 'Execute one approved action', options: [
      { name: 'id', type: 3, required: true, description: 'Approval id from job details' },
    ] },
  ] },
  { name: 'repo', description: 'Read-only repository status (owner only)', options: [{ name: 'slug', type: 3, required: true, description: 'Repository slug' }] },
  { name: 'status', description: 'Show which providers are live (owner only)' },
  { name: 'watch', description: 'Watch an allowlisted GitHub repository (owner only)', options: [
    { name: 'add', type: 1, description: 'Start a read-only repository watch', options: [
      { name: 'repo', type: 3, required: true, description: 'Allowlisted GitHub repository slug' },
      { name: 'every', type: 4, required: false, description: 'Minutes between checks (15-1440)' },
    ] },
    { name: 'list', type: 1, description: 'List active repository watches', options: [
      { name: 'filter', type: 3, required: false, description: 'active | all', choices: [
        { name: 'active', value: 'active' }, { name: 'all', value: 'all' },
      ] },
    ] },
    { name: 'remove', type: 1, description: 'Cancel a repository watch', options: [
      { name: 'id', type: 3, required: true, description: 'Watch id' },
    ] },
  ] },
  /**
   * Deleting the owner's own data. Deliberately narrow: `target` has exactly two
   * choices and `job` needs an explicit id, so there is no shape of this command
   * that means "delete everything".
   */
  { name: 'forget', description: 'Delete data Ducky holds about one job (owner only)', options: [
    { name: 'target', type: 3, required: true, description: 'what kind of record to delete', choices: [
      { name: 'job', value: 'job' },
      { name: 'conversation', value: 'conversation' },
      { name: 'capture', value: 'capture' },
      { name: 'task', value: 'task' },
      { name: 'reminder', value: 'reminder' },
      { name: 'schedule', value: 'schedule' },
    ] },
    { name: 'id', type: 3, required: false, description: 'The id shown when you list them. Omit to list your records.' },
  ] },
  { name: 'task', description: 'Your tasks (owner only)', options: [
    { name: 'add', type: 1, description: 'Add a task', options: [
      { name: 'title', type: 3, required: true, description: 'What needs doing' },
      { name: 'due', type: 3, required: false, description: 'e.g. tomorrow 09:00, in 2h, 2026-09-01' },
      { name: 'priority', type: 3, required: false, description: 'low | normal | high', choices: [
        { name: 'low', value: 'low' },
        { name: 'normal', value: 'normal' },
        { name: 'high', value: 'high' },
      ] },
    ] },
    { name: 'list', type: 1, description: 'List tasks', options: [
      { name: 'filter', type: 3, required: false, description: 'open | today | overdue | done | cancelled | all', choices: [
        { name: 'open', value: 'open' },
        { name: 'today', value: 'today' },
        { name: 'overdue', value: 'overdue' },
        { name: 'done', value: 'done' },
        { name: 'cancelled', value: 'cancelled' },
        { name: 'all', value: 'all' },
      ] },
    ] },
    { name: 'done', type: 1, description: 'Mark a task done', options: [
      { name: 'id', type: 3, required: true, description: 'Task id' },
    ] },
    { name: 'cancel', type: 1, description: 'Cancel a task', options: [
      { name: 'id', type: 3, required: true, description: 'Task id' },
    ] },
  ] },
  { name: 'reminder', description: 'Reminders delivered to your DM (owner only)', options: [
    { name: 'add', type: 1, description: 'Set a reminder', options: [
      { name: 'text', type: 3, required: true, description: 'What to remind you about' },
      { name: 'at', type: 3, required: true, description: 'e.g. in 30m, 18:00, tomorrow 09:00' },
      { name: 'every', type: 3, required: false, description: 'Repeat interval, e.g. 30m, 2h, 1d' },
      { name: 'count', type: 4, required: false, description: 'How many times in total (needs every)' },
    ] },
    { name: 'list', type: 1, description: 'List reminders', options: [
      { name: 'filter', type: 3, required: false, description: 'scheduled | all', choices: [
        { name: 'scheduled', value: 'scheduled' },
        { name: 'all', value: 'all' },
      ] },
    ] },
    { name: 'cancel', type: 1, description: 'Cancel a reminder', options: [
      { name: 'id', type: 3, required: true, description: 'Reminder id' },
    ] },
  ] },
  { name: 'briefing', description: 'Summary of your stored tasks, reminders and schedule (owner only)', options: [
    { name: 'when', type: 3, required: false, description: 'morning | evening | today', choices: [
      { name: 'morning', value: 'morning' },
      { name: 'evening', value: 'evening' },
      { name: 'today', value: 'today' },
    ] },
  ] },
];

/**
 * A human-readable inventory of the surface, for the smoke checklist.
 *
 * OFFLINE and read-only: it contacts nothing. It exists because "are all the
 * commands registered?" is really two questions -- what this build DEFINES, and
 * what Discord currently HAS -- and only the first can be answered without a
 * write token. Answering the first honestly, and saying that it is only the
 * first, beats implying both.
 */
export function commandInventory(): string[] {
  return COMMANDS.map((c) => {
    const subs = (c.options ?? []).filter((o) => o.type === 1).map((o) => o.name);
    const opts = (c.options ?? []).filter((o) => o.type !== 1).map((o) => o.name);
    const detail = subs.length > 0
      ? `subcommands: ${subs.join(', ')}`
      : opts.length > 0
        ? `options: ${opts.join(', ')}`
        : 'no options';
    return `/${c.name} — ${detail}`;
  });
}

export function commandPayload(): unknown[] {
  const names = new Set(COMMANDS.map((c) => c.name));
  for (const c of OWNER_ONLY_COMMANDS) {
    if (!names.has(c)) throw new Error(`missing command definition: ${c}`);
  }
  return COMMANDS;
}

/**
 * Registers the commands with Discord. This is a WRITE to an external service,
 * so it never happens at boot, never without `--apply`, and never without an
 * explicitly named profile -- registering the wrong bot is not something to
 * infer from an ambient default.
 *
 * Development registers guild-scoped (commands appear immediately).
 * Production registers globally unless its own guild is configured; it never
 * borrows the development guild.
 */
async function apply(profileArg: string | undefined): Promise<void> {
  if (!profileArg) {
    process.stderr.write(
      `--apply requires --profile <${DUCKY_PROFILES.join('|')}>. ` +
        'Refusing to guess which bot to register.\n',
    );
    process.exit(1);
  }

  let config;
  try {
    config = resolveDiscordProfile(profileArg, process.env);
  } catch (err) {
    process.stderr.write(`${redact((err as Error).message)}\n`);
    process.exit(1);
  }

  const names = PROFILE_ENV[config.profile];
  if (!config.token || !config.appId) {
    process.stderr.write(`${names.token} and ${names.appId} are both required.\n`);
    process.exit(1);
  }

  const scope = commandScopeFor(config);
  const url =
    scope.kind === 'guild'
      ? `https://discord.com/api/v10/applications/${config.appId}/guilds/${scope.guildId}/commands`
      : `https://discord.com/api/v10/applications/${config.appId}/commands`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { authorization: `Bot ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(commandPayload()),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    // The body can echo request detail; print the status only.
    process.stderr.write(`Discord rejected the registration (HTTP ${res.status}).\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Registered ${commandPayload().length} commands for the ${config.profile} bot ` +
      `(${scope.kind === 'guild' ? `guild ${scope.guildId}` : 'global'}).\n`,
  );
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const invokedDirectly =
  process.argv[1]?.endsWith('register-commands.ts') ||
  process.argv[1]?.endsWith('register-commands.js');

if (invokedDirectly) {
  if (process.argv.includes('--apply')) {
    void apply(flag('profile'));
  } else if (process.argv.includes('--list')) {
    // The inventory, for the smoke checklist. Writes nothing, contacts nothing.
    process.stdout.write(`${commandInventory().join('\n')}\n`);
    process.stdout.write(
      `\n${commandPayload().length} command(s) DEFINED by this build, and every entry on ` +
        'OWNER_ONLY_COMMANDS has a definition (asserted here and by a test).\n' +
        'What Discord currently HAS is a different question, and needs a token: this command ' +
        'does not ask.\n',
    );
  } else {
    process.stdout.write(`${JSON.stringify(commandPayload(), null, 2)}\n`);
    process.stdout.write(
      '\nDry run. This wrote nothing to Discord.\n' +
        `Registering is an external write: re-run with --apply --profile <${DUCKY_PROFILES.join('|')}>, ` +
        'and only deliberately.\n',
    );
  }
}
