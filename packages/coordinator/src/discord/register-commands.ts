import { OWNER_ONLY_COMMANDS } from '@ducky/contracts';

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

if (process.argv[1]?.endsWith('register-commands.ts') || process.argv[1]?.endsWith('register-commands.js')) {
  process.stdout.write(`${JSON.stringify(commandPayload(), null, 2)}\n`);
  process.stdout.write(
    '\nDry run only. Registering with Discord is a deliberate, separate step.\n',
  );
}
