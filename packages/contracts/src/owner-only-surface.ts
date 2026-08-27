/**
 * Every privileged Discord surface. Registration and routing both read this
 * list, and a test asserts the registered handler set equals this manifest plus
 * exactly one conversational route -- so a new command cannot silently become
 * reachable by a non-owner.
 *
 * Captures, inbox, schedules, jobs and repository data are private personal
 * data: the chat whitelist never reaches any of them.
 */
export const OWNER_ONLY_COMMANDS = [
  'capture',
  'inbox',
  'schedule',
  'job',
  'jobs',
  'repo',
  'status',
] as const;
export type OwnerOnlyCommand = (typeof OWNER_ONLY_COMMANDS)[number];

export const OWNER_ONLY_INTERACTION_KINDS = [
  'inbox_done',
  'inbox_archive',
  'inbox_delete',
  'sched_confirm',
  'sched_discard',
  'sched_edit',
  'job_answer',
  'job_cleanup',
  'approve',
  'reject',
] as const;
export type OwnerOnlyInteractionKind = (typeof OWNER_ONLY_INTERACTION_KINDS)[number];

/** The single non-privileged route. Conversation only; no tool access. */
export const CONVERSATIONAL_ROUTE = 'conversation' as const;

export const isOwnerOnlyCommand = (n: string): n is OwnerOnlyCommand =>
  (OWNER_ONLY_COMMANDS as readonly string[]).includes(n);

export const isOwnerOnlyInteractionKind = (n: string): n is OwnerOnlyInteractionKind =>
  (OWNER_ONLY_INTERACTION_KINDS as readonly string[]).includes(n);
