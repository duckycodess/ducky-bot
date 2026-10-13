import { z } from 'zod';

/**
 * The vocabulary of a notification-only watch target (ADR 0030).
 *
 * A target is observed through typed SURFACES, each with its own cursor, and
 * what it observes is a typed EVENT with a stable identity. Neither is a
 * snapshot hash, which is why neither can be reconstructed from the other.
 */

export const WATCH_SURFACES = [
  'commits',
  'pulls',
  'issues',
  'runs',
  'releases',
  'default_branch',
  /** The failing/passing state a workflow recovery is judged against. */
  'ci_state',
] as const;
export type WatchSurface = (typeof WATCH_SURFACES)[number];

/** Surfaces whose cursor is an ISO instant. The others carry a name or a state. */
export const TIME_CURSOR_SURFACES = ['commits', 'pulls', 'issues', 'runs', 'releases'] as const;

export const WATCH_EVENT_KINDS = [
  'commit',
  'pr_opened',
  'pr_updated',
  'pr_merged',
  'pr_closed',
  'review_requested_changes',
  'review_approved',
  'review_commented',
  'review_pending',
  'issue_opened',
  'issue_updated',
  'issue_closed',
  'release',
  'ci_started',
  'ci_failed',
  'ci_recovered',
  'default_branch_change',
] as const;
export type WatchEventKind = (typeof WATCH_EVENT_KINDS)[number];

/** Which surface has to be read to see an event of this kind. */
export const WATCH_EVENT_SURFACE = {
  commit: 'commits',
  pr_opened: 'pulls',
  pr_updated: 'pulls',
  pr_merged: 'pulls',
  pr_closed: 'pulls',
  review_requested_changes: 'pulls',
  review_approved: 'pulls',
  review_commented: 'pulls',
  review_pending: 'pulls',
  issue_opened: 'issues',
  issue_updated: 'issues',
  issue_closed: 'issues',
  release: 'releases',
  ci_started: 'runs',
  ci_failed: 'runs',
  ci_recovered: 'runs',
  default_branch_change: 'default_branch',
} as const satisfies Record<WatchEventKind, WatchSurface>;

/**
 * The only kind that interrupts. Everything else waits for a briefing digest.
 *
 * "Settled" is therefore two separate facts: an event can have been ALERTED (it
 * interrupted once) and, independently, DIGESTED (a briefing carried it).
 */
export const WATCH_ALERT_KINDS: readonly WatchEventKind[] = ['review_requested_changes'];

/**
 * The kinds that are only ever recorded as markers and never shown: the
 * pending-review marker exists to dedupe, not to be read.
 */
export const WATCH_SILENT_KINDS: readonly WatchEventKind[] = ['review_pending'];

export const isWatchSurface = (v: string): v is WatchSurface =>
  (WATCH_SURFACES as readonly string[]).includes(v);
export const isWatchEventKind = (v: string): v is WatchEventKind =>
  (WATCH_EVENT_KINDS as readonly string[]).includes(v);

/**
 * What a reader can actually observe.
 *
 * A real reader declares what its argv shapes can answer; an import whose
 * targets need a kind the reader cannot observe is refused rather than
 * accepted and quietly never watched. A mock in a test can declare everything
 * and prove the engine, which is not evidence of a live bridge.
 */
export interface WatchReaderCapabilities {
  readonly observableKinds: readonly WatchEventKind[];
  /** Whether new repositories can be discovered. Never assumed. */
  readonly discovery: boolean;
}

export const NO_WATCH_CAPABILITIES: WatchReaderCapabilities = Object.freeze({
  observableKinds: [] as readonly WatchEventKind[],
  discovery: false,
});

/** The kinds a target cannot be fully watched without. All of them. */
export const REQUIRED_WATCH_KINDS: readonly WatchEventKind[] = WATCH_EVENT_KINDS.filter(
  (k) => k !== 'review_pending',
);

/** What an event carries. Scrubbed text only: no actor name, no link. */
export const WatchEventPayloadSchema = z.strictObject({
  number: z.number().int().min(0).optional(),
  title: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  branch: z.string().max(255).optional(),
  workflow: z.string().max(120).optional(),
  tag: z.string().max(80).optional(),
  name: z.string().max(200).optional(),
  summary: z.string().max(600).optional(),
  role: z.string().max(60).optional(),
  areas: z.array(z.string().max(60)).max(6).optional(),
  files: z.array(z.string().max(200)).max(25).optional(),
});
export type WatchEventPayload = z.infer<typeof WatchEventPayloadSchema>;

/** `owner/repo`, lowercase, the key two targets are compared by. */
export function watchTargetKey(reference: string): string {
  return reference.trim().toLowerCase();
}
