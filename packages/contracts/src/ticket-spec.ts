/**
 * The canonical ticket contract, as a TYPE ONLY.
 *
 * WHAT THIS IS NOT. It is not a second validator and it is not a copy of the
 * installed schema. The installed front door owns `ticket-spec.schema.json`
 * and owns `validate`; this file exists so TypeScript can describe the object
 * Ducky builds before handing it over, and so a malformed one fails here
 * rather than as an opaque subprocess error.
 *
 * The authority order is explicit and is asserted by a test: the installed
 * validator decides. `preflightTicketSpec` below only catches the shapes we
 * can refuse without spending a subprocess, and it NEVER accepts anything the
 * installed validator would reject -- it is strictly a cheaper refusal, never
 * a substitute approval.
 */

export const TICKET_SPEC_SCHEMA = 'ticket-spec/v1' as const;

export const TICKET_SOURCE_MODES = [
  'description', 'conversation', 'existing_issue', 'legacy',
] as const;
export type TicketSourceMode = (typeof TICKET_SOURCE_MODES)[number];

export const TICKET_REFERENCE_KINDS = ['file', 'url', 'issue', 'note'] as const;
export type TicketReferenceKind = (typeof TICKET_REFERENCE_KINDS)[number];

export interface TicketReference {
  readonly kind: TicketReferenceKind;
  readonly value: string;
  readonly verified: boolean;
}

export interface TicketDependency {
  readonly repository: string;
  readonly issue: number;
  readonly evidence: {
    readonly source: 'user_decision' | 'repository_spec';
    readonly locator: string;
  };
}

export interface TicketSpec {
  readonly schema: typeof TICKET_SPEC_SCHEMA;
  /** One UUID per LOGICAL publication, reused on every retry. */
  readonly id: string;
  readonly repository: string;
  readonly title: string;
  readonly goal: string;
  readonly context: readonly string[];
  readonly scope: readonly string[];
  readonly non_goals: readonly string[];
  readonly acceptance_criteria: readonly string[];
  readonly constraints: readonly string[];
  readonly dependencies: readonly TicketDependency[];
  readonly references: readonly TicketReference[];
  readonly verification: readonly string[];
  readonly risks: readonly string[];
  readonly open_questions: readonly string[];
  readonly source: {
    readonly mode: TicketSourceMode;
    readonly summary: string;
    readonly decisions: readonly string[];
  };
}

export const TICKET_TITLE_MAX = 240;
/** `owner/name`, the only repository form the installed contract accepts. */
export const TICKET_REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;

export const isTicketRepository = (s: string): boolean =>
  typeof s === 'string' && s.length <= 140 && TICKET_REPOSITORY_RE.test(s);

/**
 * The cheap refusals, in one place.
 *
 * Returns a reason, or undefined when nothing OBVIOUSLY wrong was found --
 * which is not the same as "valid". The installed validator still runs and is
 * still what decides.
 */
export function preflightTicketSpec(spec: TicketSpec): string | undefined {
  if (spec.schema !== TICKET_SPEC_SCHEMA) return 'the spec is not ticket-spec/v1';
  if (!isTicketRepository(spec.repository)) return 'the repository is not owner/name';
  const title = spec.title ?? '';
  if (title.trim() === '') return 'the ticket has no title';
  if (title.length > TICKET_TITLE_MAX) return 'the ticket title is too long';
  if (/[\r\n]/.test(title)) return 'a ticket title must be one line';
  if (spec.goal.trim() === '') return 'the ticket has no goal';
  if (spec.scope.length === 0) return 'the ticket has no scope';
  if (spec.acceptance_criteria.length === 0) return 'the ticket has no acceptance criteria';
  if (spec.verification.length === 0) return 'the ticket has no verification steps';
  if (spec.open_questions.length > 0) {
    // The installed publisher refuses this too. Catching it here means the
    // owner is told WHICH decision is open rather than reading a subprocess
    // error.
    return `unresolved decisions: ${spec.open_questions.join('; ')}`;
  }
  return undefined;
}
