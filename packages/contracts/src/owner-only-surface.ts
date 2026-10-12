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
  /**
   * Deleting the owner's own data. A WRITE, and the most consequential one, so
   * it belongs on this manifest and must never appear in
   * `SHARED_READABLE_ROUTES`.
   */
  'forget',
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
  /** The confirm step of `/forget job`. Signed and bound to the owner. */
  'forget_confirm',
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

/**
 * The conversational controls, and the ONLY interaction kinds a non-owner may
 * ever press.
 *
 * Declared as a POSITIVE manifest beside `OWNER_ONLY_INTERACTION_KINDS` rather
 * than as "whatever is not owner-only", because the two lists together are
 * what the router asserts its registered component surface against. A new
 * handler must therefore be added to one of them deliberately; it cannot
 * become reachable by a non-owner through an omission.
 *
 * Both act on a CONVERSATION the presser is already a participant in, and
 * neither can reach a record, a job, a repository or a provider credential:
 *
 * - `conv_branch` starts a separate visible thread seeded only with the one
 *   anchor the presser explicitly selected;
 * - `conv_compact` replaces the presser's own prompt context with a summary.
 *
 * Visibility is still not authorization. A press is re-checked three ways on
 * the way in: the signature is bound to the presser, the actor must be
 * conversationally authorized by the frozen `Authorizer`, and they must
 * already be a recorded participant of the thread the control names. Seeing a
 * control in scrollback is not permission to press it.
 */
export const CONVERSATIONAL_INTERACTION_KINDS = ['conv_branch', 'conv_compact'] as const;
export type ConversationalInteractionKind = (typeof CONVERSATIONAL_INTERACTION_KINDS)[number];

export const isConversationalInteractionKind = (n: string): n is ConversationalInteractionKind =>
  (CONVERSATIONAL_INTERACTION_KINDS as readonly string[]).includes(n);

/**
 * Every interaction kind this build registers, owner-only and conversational
 * together.
 *
 * The router asserts its registered set equals exactly this union, so the two
 * manifests cannot overlap and nothing can be registered that appears on
 * neither.
 */
export const ALL_INTERACTION_KINDS: readonly string[] = Object.freeze([
  ...OWNER_ONLY_INTERACTION_KINDS,
  ...CONVERSATIONAL_INTERACTION_KINDS,
]);
