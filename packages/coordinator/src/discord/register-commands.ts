import { DUCKY_PROFILES, OWNER_ONLY_COMMANDS, PROFILE_ENV } from '@ducky/contracts';
import { commandScopeFor, resolveDiscordProfile } from './profile-config.js';

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
  ] },
  { name: 'repo', description: 'Read-only repository status (owner only)', options: [{ name: 'slug', type: 3, required: true, description: 'Repository slug' }] },
  { name: 'status', description: 'Show which providers are live (owner only)' },
];

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
    process.stderr.write(`${(err as Error).message}\n`);
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
  } else {
    process.stdout.write(`${JSON.stringify(commandPayload(), null, 2)}\n`);
    process.stdout.write(
      '\nDry run. This wrote nothing to Discord.\n' +
        `Registering is an external write: re-run with --apply --profile <${DUCKY_PROFILES.join('|')}>, ` +
        'and only deliberately.\n',
    );
  }
}
