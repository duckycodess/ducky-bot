import {
  BRIEFING_PROVENANCE, INTENT_PROPOSAL_TTL_MS,
  detectIntent, isAffirmation, isRefusal, isWriteIntent, zonedDateKey, zonedParts,
  type DetectedIntent, type IntentKind,
} from '@ducky/contracts';
import type { ActorContext } from '../security/authz.js';
import type { CapturesService } from './captures.service.js';
import type { TasksService } from './tasks.service.js';
import type { RemindersService } from './reminders.service.js';
import type { BriefingService } from './briefing.service.js';
import type { OwnerClock } from './owner-clock.js';
import { buildStudyPlan, requestedStudyMinutes, suggestMeal } from './local-helpers.js';
import { briefingMessage } from '../discord/assistant-presenters.js';
import type { OutboundMessage } from '../discord/message.js';
import type { ChannelRole } from '@ducky/contracts';

/**
 * Which deterministic rules may fire in which channel.
 *
 * NARROWING only. A DM or an unconfigured channel has no role and every rule is
 * live, exactly as before -- so nothing an owner relies on today stops working
 * because they configured a channel for something else.
 *
 * A role channel is a statement about what that channel is FOR:
 *
 * - `task`: the personal-record writes and the reads that describe them. A
 *   coding job is not a note.
 * - `coding`: coding jobs, and nothing else. A stray "i need to renew the
 *   domain" in the coding channel means nothing rather than a task.
 * - `briefing`: reads only. It is where output is DELIVERED; a channel that
 *   writes because somebody typed into it would be a surprise.
 * - `gpt`: handled earlier and never reaches here.
 */
function allowedInRole(kind: IntentKind, role: ChannelRole | undefined): boolean {
  if (role === undefined) return true;
  switch (role) {
    case 'task':
      return kind !== 'job_submit';
    case 'coding':
      return kind === 'job_submit';
    case 'briefing':
      return !isWriteIntent(kind);
    case 'gpt':
      return false;
  }
}

export interface IntentsServiceDeps {
  readonly clock: OwnerClock;
  readonly tasks: TasksService;
  readonly reminders: RemindersService;
  readonly captures: CapturesService;
  readonly briefing: BriefingService;
  /** The configured owner. Frozen config, never a stored row. */
  readonly ownerId: string;
  /**
   * Submits a confirmed coding job through the SAME path `/job submit` uses.
   *
   * A function rather than the service, so this cannot reach anything else on
   * it: an inferred intent must be able to submit a job and nothing more --
   * not cancel one, not answer one, not approve an action.
   */
  readonly submitJob?: (
    actor: ActorContext,
    input: { repoSlug: string; task: string },
  ) => { publicId: string };
  /**
   * Whether a repository slug is one the owner configured, WITHOUT saying
   * anything about it if it is not.
   *
   * Checked before a job is proposed, so the owner is told immediately rather
   * than confirming something that would be refused a moment later.
   */
  readonly repoExists?: (slug: string) => boolean;
}

interface Pending {
  readonly intent: DetectedIntent;
  readonly expiresAtMs: number;
}

/**
 * Deterministic-first natural language, on the route that already exists.
 *
 * WHAT IT IS. A fixed rule table (`detectIntent`) over the owner's own message,
 * with two outcomes: a READ answered immediately from stored records or a local
 * table, or a WRITE proposed and applied only after the owner says yes. Nothing
 * here consults a provider, so none of it waits on 2D — and none of it can
 * generate a sentence either.
 *
 * WHY IT IS NOT A COMMAND. `/meal`, `/study` and a natural-language capture
 * would each be a new entry on the owner-only manifest, and `AGENTS.md` forbids
 * widening that surface. Conversation is an existing permitted route; the owner
 * gate is the same one a conversation ATTACHMENT already uses. No command, no
 * interaction kind, no manifest change.
 *
 * WHY CONFIRMATION IS A MESSAGE, NOT A BUTTON. A signed one-press control would
 * be a new interaction kind — the same constraint. So the confirmation is the
 * owner's own next message, which is also the strongest form: nothing is stored
 * until they type it.
 *
 * THE RULES ABOUT WRITES, stated because they are the whole risk:
 *
 * - An inferred write is NEVER applied on the strength of the inference.
 * - One pending proposal per (user, thread). A queue would let "yes" apply
 *   something the owner had stopped thinking about.
 * - Proposals expire (`INTENT_PROPOSAL_TTL_MS`), because intent is about now.
 * - A non-owner never reaches any of this: their message goes to conversation
 *   exactly as it did before.
 */
export class IntentsService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: IntentsServiceDeps) {}

  private key(actor: ActorContext, threadKey: string): string {
    return `${actor.discordUserId}:${threadKey}`;
  }

  /**
   * Handles one message, or declines to.
   *
   * `undefined` means "this is ordinary conversation" and the caller falls
   * through to the provider — which is the answer for almost every message.
   */
  handle(
    actor: ActorContext,
    threadKey: string,
    text: string,
    /**
     * The role of the channel this arrived in, when it is one of the owner's
     * configured assistant channels.
     *
     * Used to NARROW what may fire, never to widen it. A DM and an
     * unconfigured channel pass `undefined` and behave exactly as they always
     * have: every rule is live. A role channel is a statement about what that
     * channel is FOR, so a coding proposal does not appear in the briefing
     * channel and a `gpt` channel is left alone entirely.
     */
    role?: ChannelRole,
  ): OutboundMessage | undefined {
    // Owner-only in full. A whitelist user's message is conversation, exactly as
    // it was before: they cannot write the owner's data and they do not get the
    // owner's helpers.
    if (actor.discordUserId !== this.deps.ownerId) return undefined;

    // The GPT channel is for talking to the model. Deterministic rules would
    // intercept ordinary sentences there, which is the opposite of what the
    // channel is for -- including a pending "yes", which belongs to whichever
    // channel proposed it.
    if (role === 'gpt') return undefined;

    const answer = this.resolvePending(actor, threadKey, text);
    if (answer) return answer;

    const intent = detectIntent(text);
    if (!intent) return undefined;
    if (!allowedInRole(intent.kind, role)) return undefined;

    if (isWriteIntent(intent.kind)) return this.propose(actor, threadKey, intent);
    return this.answerRead(actor, intent, text);
  }

  /** Drops anything expired. Called on every use; there is no timer. */
  private resolvePending(
    actor: ActorContext,
    threadKey: string,
    text: string,
  ): OutboundMessage | undefined {
    const key = this.key(actor, threadKey);
    const held = this.pending.get(key);
    if (!held) return undefined;
    if (held.expiresAtMs <= this.deps.clock.nowMs()) {
      this.pending.delete(key);
      return undefined;
    }
    if (isRefusal(text)) {
      this.pending.delete(key);
      return { content: 'Dropped it. Nothing was saved.', ephemeral: false };
    }
    if (!isAffirmation(text)) return undefined;

    this.pending.delete(key);
    return this.apply(actor, held.intent);
  }

  private propose(
    actor: ActorContext,
    threadKey: string,
    intent: DetectedIntent,
  ): OutboundMessage | undefined {
    if (intent.kind === 'job_submit') {
      // No performer wired, so there is nothing to propose. Silence rather than
      // an offer that could not be kept.
      if (!this.deps.submitJob || !this.deps.repoExists) return undefined;
      const repo = intent.repo ?? '';
      if (!this.deps.repoExists(repo)) {
        // Named, but not a repository the owner configured. Refused HERE, so
        // the owner is not asked to confirm something that would fail -- and
        // the message says only that it is not configured, never what is.
        return {
          content:
            `\`${repo}\` is not a configured repository, so there is nothing to submit. ` +
            'Check `/repo status <slug>` for one that is.',
          ephemeral: false,
        };
      }
    }
    // Replaces any earlier proposal: one per thread, so a "yes" can only ever
    // mean the thing that was just described.
    this.pending.set(this.key(actor, threadKey), {
      intent,
      expiresAtMs: this.deps.clock.nowMs() + INTENT_PROPOSAL_TTL_MS,
    });

    const described = describe(intent);
    return {
      content:
        `${described}\n\nNothing is saved yet — reply **yes** to confirm, or **no** to drop it. ` +
        'You can also use the slash command directly.',
      ephemeral: false,
    };
  }

  /**
   * Applies a confirmed write through the SAME service the slash command uses.
   *
   * No second write path: `/task add` and a confirmed "i need to…" end up in one
   * place, with one validation and one set of bounds.
   */
  private apply(actor: ActorContext, intent: DetectedIntent): OutboundMessage {
    try {
      switch (intent.kind) {
        case 'task_add': {
          const row = this.deps.tasks.add(actor, {
            title: intent.subject,
            ...(intent.when !== undefined ? { due: intent.when } : {}),
          });
          return { content: `Task \`${row.publicId}\` saved.`, ephemeral: false };
        }
        case 'reminder_add': {
          const row = this.deps.reminders.add(actor, {
            text: intent.subject,
            at: intent.when ?? '',
            ...(intent.every !== undefined ? { every: intent.every, count: 5 } : {}),
          });
          return { content: `Reminder \`${row.publicId}\` set.`, ephemeral: false };
        }
        case 'capture': {
          const row = this.deps.captures.create(actor, intent.subject);
          return { content: `Captured \`${row.id.slice(0, 8)}\`.`, ephemeral: false };
        }
        case 'job_submit': {
          /**
           * Through `JobsService.submit`, exactly as `/job submit` does.
           *
           * So every gate stays where it is and none of them is bypassed: the
           * owner check, the allowlist, `allowJobs`, placements, the repository
           * reservation, and the approval gate for anything the job later
           * proposes. A confirmed sentence and a typed command reach the same
           * code.
           */
          if (!this.deps.submitJob) return { content: 'Nothing to confirm.', ephemeral: false };
          const job = this.deps.submitJob(actor, {
            repoSlug: intent.repo ?? '',
            task: intent.subject,
          });
          return {
            content:
              `Job \`${job.publicId}\` submitted. Track it with \`/job status ${job.publicId}\`.`,
            ephemeral: false,
          };
        }
        default:
          return { content: 'Nothing to confirm.', ephemeral: false };
      }
    } catch (err) {
      // The service refused -- a bad time, an over-long title. Report it as the
      // refusal it is rather than pretending something was saved.
      const message = err instanceof Error ? err.message : 'That could not be saved.';
      return { content: `Not saved: ${message}`, ephemeral: false };
    }
  }

  /** Reads. Assembled from stored records or a fixed local table, never generated. */
  private answerRead(
    actor: ActorContext,
    intent: DetectedIntent,
    text: string,
  ): OutboundMessage {
    const nowMs = this.deps.clock.nowMs();
    const tz = this.deps.clock.timeZone;

    if (intent.kind === 'briefing') {
      // The same assembly `/briefing` uses, and the same provenance line.
      const hour = zonedParts(nowMs, tz).hour;
      return briefingMessage(this.deps.briefing.build(actor, hour < 15 ? 'morning' : 'evening'));
    }

    if (intent.kind === 'meal') {
      const s = suggestMeal({
        text,
        hour: zonedParts(nowMs, tz).hour,
        dayKey: zonedDateKey(nowMs, tz),
      });
      const lines = s.picks.map((d) => `• **${d.name}** — ${d.needs} (about ${d.minutes} min)`);
      const notes: string[] = [];
      if (s.applied.length > 0) notes.push(`Applied: ${s.applied.join(', ')}.`);
      if (s.narrowed) notes.push('Nothing in the list matched that, so here is the unfiltered set.');
      return {
        content: [
          `For ${s.meal}:`,
          ...lines,
          '',
          ...notes,
          '-# Picked from a short fixed list in Ducky\'s own source. Nothing here is generated, ' +
            'and it is not a complete set of Filipino dishes.',
        ].join('\n'),
        ephemeral: false,
      };
    }

    // study
    const plan = buildStudyPlan(intent.subject || 'your topic', requestedStudyMinutes(text));
    return {
      content: [
        `**${plan.totalMinutes} minutes on ${plan.topic}**`,
        ...plan.blocks.map((b) => `• ${b.minutes} min — ${b.label}`),
        '',
        '-# A fixed schedule with your own topic in it. Ducky knows nothing about the subject, ' +
          'has read nothing, and kept nothing.',
      ].join('\n'),
      ephemeral: false,
    };
  }

  /** Test and diagnostics helper: whether a proposal is outstanding. */
  hasPending(actor: ActorContext, threadKey: string): boolean {
    const held = this.pending.get(this.key(actor, threadKey));
    return held !== undefined && held.expiresAtMs > this.deps.clock.nowMs();
  }
}

function describe(intent: DetectedIntent): string {
  switch (intent.kind) {
    case 'task_add':
      return `That looks like a task: **${intent.subject}**${intent.when ? ` (due ${intent.when})` : ''}.`;
    case 'reminder_add':
      return `That looks like a reminder: **${intent.subject}** at ${intent.when}${
        intent.every ? `, repeating every ${intent.every}` : ''
      }.`;
    default:
      return `That looks like something to capture: **${intent.subject}**.`;
  }
}

export { BRIEFING_PROVENANCE };
