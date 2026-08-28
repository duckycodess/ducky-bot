import type { SharedJobProjection } from '@ducky/contracts';
import type { OutboundEmbed, OutboundEmbedField, OutboundMessage } from './message.js';

/**
 * Rendering for the shared, non-owner surface.
 *
 * A separate module from `presenters.ts` on purpose, and every function here
 * accepts `SharedJobProjection` and nothing else. A `JobRow`, an `ApprovalRow`
 * or a result snapshot is a type error at the call site rather than a review
 * question, so the safe shape cannot be bypassed by someone reaching for a
 * richer object that happens to be in scope.
 *
 * Nothing here ever emits `rows`. Controls are signed to the owner and belong
 * in a DM; a button in a shared channel would invite clicks that can only
 * ever be refused, and would put a signed handle where anyone can read it.
 *
 * Everything here is `ephemeral: false` -- visibility is the entire point of
 * this surface, and it is the ONLY place in the codebase that deliberately
 * chooses a non-ephemeral command reply.
 */

const stamp = (iso: string): string => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');

export function sharedJobsList(jobs: readonly SharedJobProjection[]): OutboundMessage {
  if (jobs.length === 0) {
    return { content: 'No development jobs to show yet.', ephemeral: false };
  }
  const embed: OutboundEmbed = {
    title: `Development jobs (${jobs.length})`,
    description: 'Shared status only. Task details stay private to the owner.',
    fields: jobs.map((j) => ({
      name: `${j.publicId} · ${j.label}`,
      value: `${j.repoSlug}\n${j.nextStep}`,
    })),
    footer: 'Use /job status id:<id> here for one job.',
  };
  return { embeds: [embed], ephemeral: false };
}

export function sharedJobDetail(job: SharedJobProjection): OutboundMessage {
  return { embeds: [detailEmbed(job)], ephemeral: false };
}

/**
 * The proactive channel post. Same projection and same embed as the
 * interactive shared reply, so what the channel is told on its own matches
 * exactly what it is told when asked.
 */
export function sharedJobNotification(job: SharedJobProjection): OutboundMessage {
  return { embeds: [detailEmbed(job)], ephemeral: false };
}

function detailEmbed(job: SharedJobProjection): OutboundEmbed {
  const fields: OutboundEmbedField[] = [
    { name: 'Repository', value: job.repoSlug, inline: true },
    { name: 'State', value: job.label, inline: true },
    { name: 'What happens next', value: job.nextStep },
  ];
  if (job.resultVerdict) fields.push({ name: 'Verdict', value: job.resultVerdict, inline: true });
  if (job.resultSummary) fields.push({ name: 'Summary', value: job.resultSummary });
  fields.push({
    name: job.finishedAt ? 'Finished' : 'Updated',
    value: stamp(job.finishedAt ?? job.updatedAt),
    inline: true,
  });
  return {
    title: `Job ${job.publicId}`,
    fields,
    footer: 'Shared view. The task, questions and controls are owner-only.',
  };
}
