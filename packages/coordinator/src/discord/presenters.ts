import type { ApprovalRow, CaptureRow, DependencyRow, JobRow } from '@ducky/persistence';
import {
  DEPENDENCY_STATE_LABEL, DEPENDENCY_TYPE_LABEL,
  ownerDetailedLabel, ownerNextStep, ownerStateLabel, type RepoStatusSummary,
} from '@ducky/contracts';
import type { OutboundEmbed, OutboundEmbedField, OutboundMessage, OutboundRow } from './message.js';
import type { PendingDraft } from '../domain/pending-schedules.js';

const short = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function captureAck(row: CaptureRow): OutboundMessage {
  // Deliberately does not echo the content back into the channel.
  return { content: `Captured \`${row.id.slice(0, 8)}\`.`, ephemeral: true };
}

export function inboxList(rows: readonly CaptureRow[], buttons: OutboundRow[]): OutboundMessage {
  if (rows.length === 0) return { content: 'Inbox is empty.', ephemeral: true };
  const embed: OutboundEmbed = {
    title: `Inbox (${rows.length})`,
    fields: rows.map((r) => ({
      name: `${r.status} · ${r.id.slice(0, 8)}`,
      value: short(r.content, 200),
    })),
  };
  return { embeds: [embed], rows: buttons, ephemeral: true };
}

export function schedulePreview(draft: PendingDraft, rows: OutboundRow[]): OutboundMessage {
  const embed: OutboundEmbed = {
    title: `Schedule preview — ${draft.entries.length} entr${draft.entries.length === 1 ? 'y' : 'ies'}`,
    description: 'Nothing is saved yet. Review, then confirm.',
    fields: draft.entries.slice(0, 20).map((e, i) => ({
      name: `${i + 1}. ${short(e.title, 80)}`,
      value: [e.startsAt, e.endsAt ? `→ ${e.endsAt}` : null, e.location ? `@ ${e.location}` : null]
        .filter(Boolean)
        .join(' '),
    })),
    footer: 'Preview expires in 30 minutes and is never stored before you confirm.',
  };
  return { embeds: [embed], rows, ephemeral: true };
}

/**
 * The owner's private list.
 *
 * States are shown as the plain-language label rather than the raw
 * identifier, and each row says what happens next, so "needs_owner_input"
 * never has to be decoded into "it is waiting for me". The persisted state
 * machine is untouched -- this is wording, not behaviour.
 */
export function jobsList(rows: readonly JobRow[]): OutboundMessage {
  if (rows.length === 0) return { content: 'No jobs yet.', ephemeral: true };
  const embed: OutboundEmbed = {
    title: 'Recent jobs',
    fields: rows.map((j) => ({
      // The work phase refines the label for a running job and is absent
      // everywhere else, so a paused or finished job reads exactly as it did
      // in Phase 1.
      name: `${j.publicId} · ${ownerDetailedLabel(j.state, j.workPhase)}`,
      value: `${j.repoSlug} — ${short(j.task, 120)}\n-# ${ownerNextStep(j.state)}`,
    })),
  };
  return { embeds: [embed], ephemeral: true };
}

/**
 * The owner's private job view.
 *
 * `dependencies` is PRIVATE, like everything else here: it says what the work
 * is blocked on and how many times we have looked, which is detail about the
 * job. The shared projection has no field that could carry it and no shared
 * route reaches this presenter.
 */
export function jobDetail(
  job: JobRow,
  events: { kind: string; message: string }[],
  approvals: readonly ApprovalRow[],
  summary: string | null,
  rows: OutboundRow[],
  dependencies: readonly DependencyRow[] = [],
): OutboundMessage {
  const fields: OutboundEmbedField[] = [
    { name: 'Repository', value: job.repoSlug, inline: true },
    { name: 'State', value: ownerDetailedLabel(job.state, job.workPhase), inline: true },
    { name: 'What happens next', value: ownerNextStep(job.state) },
    { name: 'Task', value: short(job.task, 500) },
  ];
  const waiting = dependencies.find((d) => d.state === 'waiting');
  if (waiting) {
    fields.push({
      name: 'Waiting on',
      value:
        `${DEPENDENCY_TYPE_LABEL[waiting.type]} — ${short(waiting.description, 200)}\n` +
        `-# checked ${waiting.checksMade} of ${waiting.maxChecks} times` +
        (waiting.nextCheckAt ? `, next check ${waiting.nextCheckAt}` : '') +
        (waiting.lastDetail ? `\n-# ${short(waiting.lastDetail, 150)}` : ''),
    });
  } else if (dependencies.length > 0) {
    const last = dependencies[dependencies.length - 1]!;
    fields.push({
      name: 'Last dependency',
      value: `${DEPENDENCY_STATE_LABEL[last.state]} — ${short(last.description, 200)}`,
    });
  }
  if (summary) fields.push({ name: 'Result', value: short(summary, 900) });
  if (job.retainedWorkspaceId) {
    fields.push({ name: 'Retained workspace', value: job.retainedWorkspaceId });
  }
  if (approvals.length > 0) {
    fields.push({
      name: 'Proposed actions',
      value: approvals.map((a) => `• ${a.actionKind} — ${a.state}: ${short(a.description, 100)}`).join('\n'),
    });
  }
  if (events.length > 0) {
    fields.push({
      name: 'Recent activity',
      value: events.slice(0, 5).map((e) => `• ${e.kind}: ${short(e.message, 120)}`).join('\n'),
    });
  }
  return { embeds: [{ title: `Job ${job.publicId}`, fields }], rows, ephemeral: true };
}

export function repoStatus(s: RepoStatusSummary): OutboundMessage {
  const fields: OutboundEmbedField[] = [
    { name: 'Default branch', value: s.defaultBranch ?? 'unknown', inline: true },
    { name: 'Open PRs', value: String(s.openPrCount), inline: true },
  ];
  if (s.latestPr) {
    fields.push({
      name: `Latest PR #${s.latestPr.number}`,
      value: `${short(s.latestPr.title, 150)}\nstate: ${s.latestPr.state} · checks: ${s.latestPr.checks}`,
    });
  }
  return {
    embeds: [{ title: `${s.slug} — ${s.repoName}`, fields, footer: 'Read-only inspection.' }],
    ephemeral: true,
  };
}

export interface ProviderStatus {
  readonly profile: string;
  readonly discord: string;
  readonly conversation: string;
  /** Whether the conversation provider may be handed files, and why not. */
  readonly conversationAttachments: string;
  readonly orchestrator: string;
  readonly scheduleExtraction: string;
  readonly actions: string;
  readonly executors: string;
  readonly sharedChannels: string;
  /** The configured owner timezone every assistant readback is rendered in. */
  readonly ownerTimezone: string;
  /** Whether anything can actually confirm a dependency, and what happens if not. */
  readonly dependencyChecker: string;
}

/** Always visible, so the owner is never guessing which providers are real. */
export function statusEmbed(p: ProviderStatus): OutboundMessage {
  return {
    embeds: [
      {
        title: 'Ducky status',
        fields: [
          { name: 'Profile', value: p.profile, inline: true },
          { name: 'Discord', value: p.discord, inline: true },
          { name: 'Conversation', value: p.conversation, inline: true },
          { name: 'Chat attachments', value: p.conversationAttachments, inline: true },
          { name: 'Orchestrator', value: p.orchestrator, inline: true },
          { name: 'Schedule extraction', value: p.scheduleExtraction, inline: true },
          { name: 'Approved actions', value: p.actions, inline: true },
          { name: 'Executors', value: p.executors, inline: true },
          { name: 'Your timezone', value: p.ownerTimezone, inline: true },
          { name: 'Dependency checks', value: p.dependencyChecker },
          { name: 'Shared visibility', value: p.sharedChannels },
        ],
      },
    ],
    ephemeral: true,
  };
}
