import {
  AGENT_CARD_INTENT_LINES_MAX, AGENT_CARD_LABEL, AGENT_CARD_NEXT, DUCKY_COLORS,
  type AgentCardStatus,
} from '@ducky/contracts';
import type { AgentThreadRow } from '@ducky/persistence';
import type { OutboundEmbedField, OutboundMessage, OutboundRow } from './message.js';

/**
 * The repository-workflow cards.
 *
 * STYLE IS PART OF THE CONTRACT HERE, so it is stated rather than left to
 * taste. The owner asked for compact cards with real controls: no decorative
 * headings, no middle-dot separators, no habitual bolding, no em dashes, and
 * no action words printed in message text pretending to be buttons. A card
 * says what happened, what it means, and offers controls that act.
 *
 * None of these functions reads a host path. `AgentThreadRow.checkoutRoot`
 * exists so a follow-up helper call reaches the same checkout, and a test
 * asserts this module never touches it.
 */

const COLOR_FOR: Record<AgentCardStatus, number> = {
  scanning: DUCKY_COLORS.neutral,
  grilling: DUCKY_COLORS.brand,
  publishing: DUCKY_COLORS.neutral,
  published: DUCKY_COLORS.success,
  // Deliberately NOT `success`. Queued means authorized, and a green card that
  // reads like "done" is exactly the confusion the status words exist to stop.
  queued: DUCKY_COLORS.attention,
  onboarding: DUCKY_COLORS.neutral,
  onboarded: DUCKY_COLORS.success,
  needs_input: DUCKY_COLORS.attention,
  failed: DUCKY_COLORS.failure,
  cancelled: DUCKY_COLORS.neutral,
};

export interface AgentCardControls {
  readonly detailsId?: string;
  readonly cancelId?: string;
  readonly issueUrl?: string;
}

const COMMAND_TITLE: Record<string, string> = {
  '$grill-me': 'Grilling',
  '$ticket': 'Ticket',
  '$agentize': 'Onboarding',
};

/**
 * The one message a run edits as it moves.
 *
 * Every field is derived from stored, parsed values. No helper output, no
 * stderr, no path.
 */
export function agentCard(row: AgentThreadRow, controls: AgentCardControls): OutboundMessage {
  const status = row.runStatus ?? 'failed';
  const fields: OutboundEmbedField[] = [
    { name: 'Repository', value: row.repository ?? 'not chosen', inline: true },
    { name: 'Status', value: AGENT_CARD_LABEL[status], inline: true },
  ];
  if (row.issueNumber !== null) {
    fields.push({ name: 'Issue', value: `#${row.issueNumber}`, inline: true });
  }
  if (row.runDetail) fields.push({ name: 'Detail', value: row.runDetail });
  fields.push({ name: 'What this means', value: AGENT_CARD_NEXT[status] });

  return {
    embeds: [{
      title: `${COMMAND_TITLE[row.runCommand ?? ''] ?? 'Workflow'} ${row.runId ?? ''}`.trim(),
      fields,
      color: COLOR_FOR[status],
    }],
    rows: controlRows(controls),
    // A card is the owner's own status display in their own channel. It is
    // never sent to a shared channel: the bridge refuses to run in one.
    ephemeral: false,
  };
}

/**
 * Real controls, and only the ones that can act.
 *
 * Cancel is absent once a run has finished, because a control that cannot do
 * anything is worse than no control. "View issue" appears only when there IS
 * an issue, and it is a link rather than a signed id.
 */
function controlRows(controls: AgentCardControls): OutboundRow[] {
  const buttons = [
    ...(controls.detailsId
      ? [{ customId: controls.detailsId, label: 'Details', style: 'secondary' as const }]
      : []),
    ...(controls.issueUrl ? [{ url: controls.issueUrl, label: 'View issue' }] : []),
    ...(controls.cancelId
      ? [{ customId: controls.cancelId, label: 'Cancel', style: 'danger' as const }]
      : []),
  ];
  return buttons.length > 0 ? [{ buttons }] : [];
}

/**
 * The Details view.
 *
 * Ephemeral, because it is the long form of the owner's own private workflow
 * state. It still contains no path and no raw helper output.
 */
export function agentDetails(row: AgentThreadRow): OutboundMessage {
  const status = row.runStatus ?? 'failed';
  const fields: OutboundEmbedField[] = [
    { name: 'Command', value: row.runCommand ?? 'unknown', inline: true },
    { name: 'Repository', value: row.repository ?? 'not chosen', inline: true },
    { name: 'Status', value: AGENT_CARD_LABEL[status], inline: true },
    {
      name: 'Queue authorization',
      value: row.runQueued
        ? 'agent:ready is applied and was verified on the issue.'
        : row.runReady
          ? 'You asked for it, and it was not applied. Nothing is authorized.'
          : 'Not requested. The issue, if any, is unqueued.',
    },
    {
      name: 'Worker',
      // Stated on every Details view, because this is the question a card
      // cannot answer and the one people assume it has.
      value:
        'Ducky never starts, stops or observes a worker. Queueing authorizes the dispatcher; ' +
        'it is not evidence that anything is running.',
    },
  ];
  if (row.runDetail) fields.push({ name: 'Detail', value: row.runDetail });
  if (row.intentNotes.length > 0) {
    fields.push({
      name: `Settled intent (${row.intentNotes.length} line(s) you typed)`,
      value: row.intentNotes
        .slice(-AGENT_CARD_INTENT_LINES_MAX)
        .map((n) => `- ${n}`)
        .join('\n'),
    });
  }
  return {
    embeds: [{ title: `Run ${row.runId ?? ''}`.trim(), fields, color: COLOR_FOR[status] }],
    ephemeral: true,
  };
}

/**
 * What to say in the thread once a publication lands.
 *
 * A separate message from the card, because a terminal outcome deserves a
 * notification rather than an edit somebody has to scroll back for.
 */
export function publicationReply(
  status: AgentCardStatus,
  url: string | undefined,
): OutboundMessage {
  const line = status === 'queued'
    ? 'Queued. The exact agent:ready label is applied and verified on the issue. ' +
      'That authorizes implementation; it is not evidence that a worker started.'
    : 'Created, and not queued. Send `$ticket --ready` when you want to authorize implementation.';
  return { content: url ? `${line}\n${url}` : line, ephemeral: false };
}

/**
 * What to say when the publisher finished work the owner had already
 * cancelled.
 *
 * Both facts, in one message. The card stays `cancelled` because that is what
 * the owner chose; this says what happened anyway, because an issue that
 * exists and is never mentioned is the same dishonesty pointing the other
 * way.
 */
export function publishedAfterCancel(
  url: string | undefined,
  queued: boolean,
): OutboundMessage {
  const lines = [
    'You cancelled this, and the publisher had already created the issue. Cancelling does not ' +
      'interrupt a publication in flight, so it still exists.',
    queued
      ? 'It also carries the agent:ready label, which authorizes implementation. Remove the ' +
        'label on GitHub if that is not what you want.'
      : 'It is NOT queued, so nothing is authorized.',
  ];
  if (url) lines.push(url);
  return { content: lines.join('\n'), ephemeral: false };
}

/**
 * The repository question.
 *
 * It ASKS rather than guessing, and it lists only repositories the owner
 * configured -- which is an owner-only reply, in a thread the bridge has
 * already established is not a shared channel.
 */
export function chooseRepository(repositories: readonly string[]): OutboundMessage {
  return {
    content: [
      'Which repository? Name it in the command, as in `$ticket acme/demo add a health endpoint`.',
      '',
      ...repositories.slice(0, 10).map((r) => `- \`${r}\``),
      '',
      'Nothing was read or created.',
    ].join('\n'),
    ephemeral: false,
  };
}

/** One honest sentence when the bridge cannot run. Never a path or a flag name. */
export function unavailable(detail: string): OutboundMessage {
  return { content: detail, ephemeral: false };
}
