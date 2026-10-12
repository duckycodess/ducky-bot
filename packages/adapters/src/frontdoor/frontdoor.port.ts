import type { TicketSpec } from '@ducky/contracts';

/**
 * The installed Agent Flow front door, as a PORT.
 *
 * WHY A PORT AND NOT A REIMPLEMENTATION. The owner's workflow already has one
 * publisher, one canonical schema, one label policy and one Beads graph, and
 * they live in a private, user-installed program. Ducky is public source. So
 * Ducky calls that program and reads its answer; it does not create GitHub
 * issues, does not apply labels, and does not know what a Beads edge is. A
 * second pipeline would be a second thing to keep in step, and the one that
 * drifted would be the one nobody was watching.
 *
 * WHAT CROSSES THIS BOUNDARY. Structured fields only. The helper's raw stdout
 * is parsed here and discarded here: nothing downstream of this port ever sees
 * it, nothing stores it, and nothing logs it. A helper can print a path, a
 * remote URL or a `gh` diagnostic, and none of those belong in a Discord
 * message or in SQLite.
 */

/** Why the bridge cannot run, when it cannot. */
export type FrontDoorUnavailableReason =
  | 'disabled'
  | 'not_configured'
  | 'missing_program'
  | 'mutation_not_enabled';

export interface FrontDoorAvailability {
  readonly usable: boolean;
  readonly reason?: FrontDoorUnavailableReason;
  /** One owner-facing sentence. Never a path, never a command line. */
  readonly detail: string;
  /** Whether publication and onboarding (external mutation) are opted in. */
  readonly mutationEnabled: boolean;
}

/**
 * What a repository scan reports.
 *
 * Deliberately NARROW. The helper's inventory carries absolute paths, the
 * full signal file list and dispatcher registration internals; a Discord card
 * needs none of that. `root` is kept because the bridge must pass the same
 * checkout back on the next call, and it is never rendered.
 */
export interface FrontDoorInspection {
  /** The checkout root, for internal reuse only. NEVER sent to Discord. */
  readonly root: string;
  /** `owner/name`, when the helper could determine it. */
  readonly repository: string | undefined;
  /** Present when the helper could not name the repository. */
  readonly repositoryError: string | undefined;
  readonly dirty: boolean;
  /** Whether the dispatcher already has an enabled registration for this repo. */
  readonly registered: boolean;
  readonly registrationEnabled: boolean;
  /** Whether a worker currently owns a checkout here. */
  readonly activeJobs: number;
  /** Counts only. The file list itself is an inventory of somebody's machine. */
  readonly signalCount: number;
  readonly hasWorkflowContract: boolean;
  readonly beads: boolean;
}

export interface FrontDoorValidation {
  readonly ok: boolean;
  /** The canonical id the helper echoed back, when it accepted the spec. */
  readonly id: string | undefined;
  readonly error: string | undefined;
}

/**
 * The publisher's answer, field for field.
 *
 * `queued` is the single most important field in this file and it means
 * exactly one thing: the exact `agent:ready` label was applied AND read back
 * on the issue. It is not a claim that a dispatcher consumed it, and there is
 * deliberately no field here that could be mistaken for one -- `started` comes
 * back from the helper and is carried through unchanged precisely so that a
 * presenter cannot invent it.
 */
export interface FrontDoorPublication {
  readonly ok: boolean;
  readonly repository: string;
  readonly issue: number | undefined;
  readonly url: string | undefined;
  readonly created: boolean;
  readonly queued: boolean;
  readonly queueVerified: boolean;
  readonly started: boolean;
  readonly alreadyAuthorized: boolean;
  readonly classificationLabels: readonly string[];
  readonly classificationVerified: boolean;
  readonly error: string | undefined;
}

export interface FrontDoorOnboarding {
  readonly ok: boolean;
  readonly repository: string | undefined;
  readonly root: string;
  /** Repository-relative file names the helper reports it changed. */
  readonly changed: readonly string[];
  readonly registered: boolean;
  readonly labelsCreated: readonly string[];
  /** The dispatcher's own reported state. Observed, never asserted. */
  readonly dispatcher: string | undefined;
  readonly error: string | undefined;
}

export interface FrontDoorPort {
  /** A stable name for `/status` and the boot diagnostics. */
  readonly name: string;
  availability(): FrontDoorAvailability;
  /** Read-only. `network` additionally reads GitHub metadata and labels. */
  inspect(input: {
    path?: string;
    repository?: string;
    network?: boolean;
  }): Promise<FrontDoorInspection>;
  /** Read-only. The installed schema is the authority, not Ducky. */
  validate(spec: TicketSpec): Promise<FrontDoorValidation>;
  /** External mutation. Creates or enriches a GitHub issue. */
  publish(input: {
    spec: TicketSpec;
    ready: boolean;
    path?: string;
    issue?: number;
    labels?: readonly string[];
  }): Promise<FrontDoorPublication>;
  /** External mutation. Onboards a repository; starts nothing. */
  agentize(input: {
    path?: string;
    repository?: string;
    localOnly?: boolean;
  }): Promise<FrontDoorOnboarding>;
}
