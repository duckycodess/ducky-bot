/**
 * Every privileged Discord surface. Registration and routing both read this
 * list, and a test asserts the registered handler set equals this manifest plus
 * exactly one conversational route -- so a new command cannot silently become
 * reachable by a non-owner.
 *
 * Captures, inbox, schedules, tasks, reminders, briefings, jobs and repository
 * data are private personal data: the chat whitelist never reaches any of
 * them.
 */
export const OWNER_ONLY_COMMANDS = [
  'capture',
  'inbox',
  'schedule',
  'job',
  'jobs',
  'repo',
  'status',
  // The daily assistant (milestone 2B). Tasks, reminders and briefings are
  // personal data in the same class as captures and schedules: they are
  // owner-only in full, and no shared route names any of them.
  'task',
  'reminder',
  'briefing',
  'watch',
] as const;
export type OwnerOnlyCommand = (typeof OWNER_ONLY_COMMANDS)[number];

export const OWNER_ONLY_INTERACTION_KINDS = [
  'inbox_done',
  'inbox_archive',
  'inbox_delete',
  'inbox_task',
  'sched_confirm',
  'sched_discard',
  'sched_edit',
  'job_answer',
  'job_cleanup',
  'approve',
  'reject',
  'approval_details',
  'execute_approval',
  'task_done',
  'task_cancel',
  'reminder_cancel',
  'watch_cancel',
] as const;
export type OwnerOnlyInteractionKind = (typeof OWNER_ONLY_INTERACTION_KINDS)[number];

/** The single non-privileged route. Conversation only; no tool access. */
export const CONVERSATIONAL_ROUTE = 'conversation' as const;

export const isOwnerOnlyCommand = (n: string): n is OwnerOnlyCommand =>
  (OWNER_ONLY_COMMANDS as readonly string[]).includes(n);

export const isOwnerOnlyInteractionKind = (n: string): n is OwnerOnlyInteractionKind =>
  (OWNER_ONLY_INTERACTION_KINDS as readonly string[]).includes(n);

/**
 * The ONLY routes that answer a non-owner, and the only ones whose reply is
 * deliberately visible rather than ephemeral.
 *
 * They are reachable exclusively from a channel named in the profile's
 * `SHARED_CHANNEL_IDS` configuration, and they are served by a separate
 * projection service -- never by the owner-facing list/detail methods -- so
 * the safe shape is produced rather than filtered.
 *
 * Both are READS. Adding a write here would let a non-owner change state, so
 * the router asserts at construction that every shared route names a command
 * that exists and that no interaction kind is shared-readable: controls are
 * signed to the owner and never appear in shared output at all.
 */
export const SHARED_READABLE_ROUTES = [
  { command: 'jobs', subcommand: undefined },
  { command: 'job', subcommand: 'status' },
] as const satisfies readonly { command: OwnerOnlyCommand; subcommand: string | undefined }[];

export type SharedReadableRoute = (typeof SHARED_READABLE_ROUTES)[number];

/**
 * `/job` with no subcommand defaults to `status` in the router, so it is
 * accepted here too -- otherwise the shared path and the private path would
 * disagree about what a bare `/job` means.
 */
export const isSharedReadableRoute = (command: string, subcommand?: string): boolean =>
  SHARED_READABLE_ROUTES.some(
    (r) =>
      r.command === command &&
      (r.subcommand === undefined
        ? subcommand === undefined
        : subcommand === r.subcommand || (r.command === 'job' && subcommand === undefined)),
  );
