import {
  CONVERSATIONAL_ROUTE, DuckyError, JobAnswerInputSchema, JobSubmitInputSchema,
  OWNER_ONLY_COMMANDS, OWNER_ONLY_INTERACTION_KINDS, SHARED_READABLE_ROUTES,
  isDuckyError, isSharedReadableRoute,
  type CaptureState, type OwnerOnlyCommand, type OwnerOnlyInteractionKind,
} from '@ducky/contracts';
import type { ConversationProvider } from '@ducky/adapters';
import type { ActorContext, Authorizer } from '../security/authz.js';
import type { ComponentSigner } from '../security/component-signing.js';
import type { CapturesService } from '../domain/captures.service.js';
import type { SchedulesService } from '../domain/schedules.service.js';
import type { JobsService } from '../domain/jobs.service.js';
import type { ApprovalsService } from '../domain/approvals.service.js';
import type { GitHubService } from '../domain/github.service.js';
import type { SharedJobsService } from '../domain/shared-jobs.service.js';
import { SharedChannelPolicy } from '../domain/shared-visibility.js';
import type { OutboundMessage, OutboundRow } from './message.js';
import type { Incoming } from './transport.js';
import { CommandBuckets } from './command-buckets.js';
import * as present from './presenters.js';
import * as shared from './shared-presenters.js';

export interface RouterDeps {
  readonly authz: Authorizer;
  readonly signer: ComponentSigner;
  readonly captures: CapturesService;
  readonly schedules: SchedulesService;
  readonly jobs: JobsService;
  readonly approvals: ApprovalsService;
  readonly github: GitHubService;
  readonly conversation: ConversationProvider;
  readonly status: () => present.ProviderStatus;
  readonly buckets?: CommandBuckets;
  /**
   * Shared-channel visibility. BOTH must be supplied for any shared read to
   * happen; omitting either leaves every request on the private, owner-only
   * path. Failing closed is deliberate -- an incompletely wired router must
   * lose visibility, never publish.
   */
  readonly sharedPolicy?: SharedChannelPolicy;
  readonly sharedJobs?: SharedJobsService;
  /** Supplied by the transport so /schedule can accept a text attachment. */
  readonly readAttachment?: (a: NonNullable<Extract<Incoming, { kind: 'command' }>['attachment']>) => Promise<string>;
}

type CommandHandler = (actor: ActorContext, e: Extract<Incoming, { kind: 'command' }>) => Promise<OutboundMessage>;
type ComponentHandler = (actor: ActorContext, entityId: string, values?: Record<string, string>) => Promise<OutboundMessage>;

/**
 * Routes Discord events.
 *
 * Every command and every component kind here is owner-only and re-checked in
 * the service layer as well. The registered sets are asserted against
 * OWNER_ONLY_COMMANDS / OWNER_ONLY_INTERACTION_KINDS at construction, so a new
 * handler cannot quietly become reachable by a non-owner, and the only
 * non-privileged path is plain conversation.
 */
export class DuckyRouter {
  private readonly commands = new Map<string, CommandHandler>();
  private readonly components = new Map<string, ComponentHandler>();
  private readonly buckets: CommandBuckets;
  private readonly sharedPolicy: SharedChannelPolicy;

  constructor(private readonly deps: RouterDeps) {
    this.buckets = deps.buckets ?? new CommandBuckets();
    // An empty policy answers false to everything, so an unwired router is a
    // fully private one. `handleSharedRead` additionally requires
    // `deps.sharedJobs`, so both halves must be present for anything to be
    // shared.
    this.sharedPolicy = deps.sharedPolicy ?? new SharedChannelPolicy();
    this.registerCommands();
    this.registerComponents();
    this.assertSurfaceMatchesManifest();
  }

  registeredCommands(): string[] {
    return [...this.commands.keys()].sort();
  }

  registeredComponentKinds(): string[] {
    return [...this.components.keys()].sort();
  }

  /** Fails at construction if the surface drifts from the manifest. */
  private assertSurfaceMatchesManifest(): void {
    const cmds = new Set(this.commands.keys());
    for (const c of OWNER_ONLY_COMMANDS) {
      if (!cmds.delete(c)) throw new Error(`owner-only command not registered: ${c}`);
    }
    if (cmds.size > 0) {
      throw new Error(`command outside OWNER_ONLY_COMMANDS: ${[...cmds].join(', ')}`);
    }
    const kinds = new Set(this.components.keys());
    for (const k of OWNER_ONLY_INTERACTION_KINDS) {
      if (!kinds.delete(k)) throw new Error(`owner-only interaction not registered: ${k}`);
    }
    if (kinds.size > 0) {
      throw new Error(`interaction outside OWNER_ONLY_INTERACTION_KINDS: ${[...kinds].join(', ')}`);
    }
    this.assertSharedSurfaceIsReadOnly();
  }

  /**
   * The shared surface may only ever name commands that exist, and may never
   * name an interaction kind.
   *
   * Every registered command is already asserted to be in
   * OWNER_ONLY_COMMANDS above, so a shared route naming a registered command
   * is by construction a *narrowed view* of an owner-only command rather than
   * a new, unlisted surface. Interaction kinds are excluded outright: a
   * component is a signed control, and no control belongs in a channel other
   * people can read.
   */
  private assertSharedSurfaceIsReadOnly(): void {
    for (const route of SHARED_READABLE_ROUTES) {
      if (!this.commands.has(route.command)) {
        throw new Error(`shared route names an unregistered command: ${route.command}`);
      }
      if (this.components.has(route.command)) {
        throw new Error(`shared route names an interaction kind: ${route.command}`);
      }
    }
    for (const kind of OWNER_ONLY_INTERACTION_KINDS) {
      if (isSharedReadableRoute(kind)) {
        throw new Error(`interaction kind is shared-readable: ${kind}`);
      }
    }
  }

  async handle(event: Incoming): Promise<OutboundMessage | undefined> {
    const actor = this.deps.authz.actor(event.userId);
    try {
      switch (event.kind) {
        case 'command':
          return await this.handleCommand(actor, event);
        case 'component':
          return await this.handleComponent(actor, event.customId, event.values);
        case 'message':
          return await this.handleMessage(actor, event.text, event.threadKey);
      }
    } catch (err) {
      return errorReply(err);
    }
  }

  private async handleCommand(
    actor: ActorContext,
    event: Extract<Incoming, { kind: 'command' }>,
  ): Promise<OutboundMessage> {
    const handler = this.commands.get(event.name);
    // Unknown commands are refused before any authorization detail leaks.
    if (!handler) return { content: 'Unknown command.', ephemeral: true };

    // A configured shared channel serves the shared projection for the two
    // read routes -- to EVERYONE there, the owner included. Giving the owner
    // the private view here instead would put task text, questions and signed
    // controls into a channel other people can read, which is precisely the
    // accident this branch exists to prevent. The owner reads the private
    // view in a DM.
    if (this.sharedPolicy.isSharedRequest(event.context)) {
      const projected = await this.handleSharedRead(actor, event);
      if (projected) return projected;
    }

    // Owner-only at the router AND again inside every service method.
    this.deps.authz.requireOwner(actor);
    return handler(actor, event);
  }

  /**
   * The shared-channel read path.
   *
   * Returns undefined for anything that is not a shared-readable route, which
   * falls through to the normal owner-only path: a non-owner is refused
   * exactly as they are anywhere else, and the owner keeps full control from
   * the channel with an ephemeral reply. That is what keeps writes owner-only
   * while still letting the owner submit a job from the channel it should be
   * reported in.
   *
   * It never calls `jobs.list` or `jobs.detail`. The projection service is
   * the only thing it can reach, so there is no code path from here to a
   * private field.
   */
  private async handleSharedRead(
    actor: ActorContext,
    event: Extract<Incoming, { kind: 'command' }>,
  ): Promise<OutboundMessage | undefined> {
    const sharedJobs = this.deps.sharedJobs;
    if (!sharedJobs) return undefined;
    if (!isSharedReadableRoute(event.name, event.subcommand)) return undefined;

    // Rate limited like any other read, keyed by the requesting user, so a
    // shared channel cannot be used to hammer the database.
    this.buckets.check('jobRead', actor.discordUserId);

    if (event.name === 'jobs') return shared.sharedJobsList(sharedJobs.list());
    return shared.sharedJobDetail(sharedJobs.detail(String(event.options['id'] ?? '')));
  }

  private async handleComponent(
    actor: ActorContext,
    customId: string,
    values?: Record<string, string>,
  ): Promise<OutboundMessage> {
    this.deps.authz.requireOwner(actor);
    const verified = this.deps.signer.verify(customId, actor.discordUserId);
    if (!verified) return { content: 'That control is no longer valid.', ephemeral: true };
    const handler = this.components.get(verified.kind);
    if (!handler) return { content: 'That control is no longer valid.', ephemeral: true };
    this.buckets.check('interaction', actor.discordUserId);
    return handler(actor, verified.entityId, values);
  }

  /** The single non-privileged route: conversation, with no tool access. */
  private async handleMessage(
    actor: ActorContext,
    text: string,
    threadKey: string,
  ): Promise<OutboundMessage> {
    this.deps.authz.requireConversational(actor);
    const reply = await this.deps.conversation.reply({
      userId: actor.discordUserId,
      text,
      threadKey,
    });
    // A stand-in reply is always visibly marked so it cannot be mistaken for a
    // real assistant answer.
    return { content: reply.mock ? `[mock] ${reply.text}` : reply.text, ephemeral: false };
  }

  // ------------------------------------------------------------- commands --

  private registerCommands(): void {
    const d = this.deps;

    this.commands.set('capture', async (actor, e) => {
      this.buckets.check('capture', actor.discordUserId);
      const row = d.captures.create(actor, String(e.options['text'] ?? ''));
      return present.captureAck(row);
    });

    this.commands.set('inbox', async (actor, e) => {
      this.buckets.check('jobRead', actor.discordUserId);
      const status = (e.options['status'] as CaptureState | 'all' | undefined) ?? 'open';
      const rows = d.captures.list(actor, status);
      const buttons: OutboundRow[] = rows.slice(0, 5).map((r) => ({
        buttons: (['inbox_done', 'inbox_archive', 'inbox_delete'] as const).map((kind) => ({
          customId: d.signer.sign({ kind, entityId: r.id, actorUserId: actor.discordUserId }),
          label: `${kind.split('_')[1]} ${r.id.slice(0, 4)}`,
          style: kind === 'inbox_delete' ? ('danger' as const) : ('secondary' as const),
        })),
      }));
      return present.inboxList(rows, buttons);
    });

    this.commands.set('schedule', async (actor, e) => {
      this.buckets.check('schedule', actor.discordUserId);
      let text = String(e.options['text'] ?? '');
      let kind: 'text' | 'file' = 'text';
      if (e.attachment) {
        if (!d.readAttachment) {
          throw new DuckyError('attachment_rejected', 'Attachments are not enabled here.');
        }
        text = await d.readAttachment(e.attachment);
        kind = 'file';
      }
      if (text.trim() === '') {
        return { content: 'Send the schedule as text, or attach a .txt or .csv file.', ephemeral: true };
      }
      const outcome = await d.schedules.preview(actor, { kind, text });
      if (outcome.kind === 'empty') {
        return {
          content: 'No schedule entries found in that. Nothing was saved.',
          ephemeral: true,
        };
      }
      const rows: OutboundRow[] = [
        {
          buttons: [
            {
              customId: d.signer.sign({
                kind: 'sched_confirm',
                entityId: outcome.draft.draftId,
                actorUserId: actor.discordUserId,
              }),
              label: `Confirm ${outcome.draft.entries.length}`,
              style: 'success',
            },
            {
              customId: d.signer.sign({
                kind: 'sched_edit',
                entityId: outcome.draft.draftId,
                actorUserId: actor.discordUserId,
              }),
              label: 'Correct',
              style: 'primary',
            },
            {
              customId: d.signer.sign({
                kind: 'sched_discard',
                entityId: outcome.draft.draftId,
                actorUserId: actor.discordUserId,
              }),
              label: 'Discard',
              style: 'secondary',
            },
          ],
        },
      ];
      return present.schedulePreview(outcome.draft, rows);
    });

    this.commands.set('jobs', async (actor) => {
      this.buckets.check('jobRead', actor.discordUserId);
      return present.jobsList(d.jobs.list(actor));
    });

    this.commands.set('job', async (actor, e) => {
      const sub = e.subcommand ?? 'status';
      switch (sub) {
        case 'submit': {
          this.buckets.check('jobSubmit', actor.discordUserId);
          const input = JobSubmitInputSchema.parse({
            repoSlug: String(e.options['repo'] ?? ''),
            task: String(e.options['task'] ?? ''),
            ...(e.options['context'] === undefined ? {} : { context: String(e.options['context']) }),
            bootstrap: e.options['bootstrap'] === true,
          });
          // Recorded only when this really is a configured shared channel, so
          // the column can never hold an id that was not shared at write time.
          const sharedChannelId = this.sharedPolicy.isSharedRequest(e.context)
            ? e.context?.channelId
            : undefined;
          const job = d.jobs.submit(actor, input, { sharedChannelId });
          return {
            content: `Job \`${job.publicId}\` created for \`${job.repoSlug}\` (${job.state.replace(/_/g, ' ')}).`,
            ephemeral: true,
          };
        }
        case 'cancel': {
          this.buckets.check('jobRead', actor.discordUserId);
          const r = d.jobs.requestCancel(actor, String(e.options['id'] ?? ''));
          return { content: `${r.note} (state: ${r.state})`, ephemeral: true };
        }
        case 'answer': {
          this.buckets.check('jobRead', actor.discordUserId);
          const input = JobAnswerInputSchema.parse({
            publicId: String(e.options['id'] ?? ''),
            answer: String(e.options['answer'] ?? ''),
          });
          const r = d.jobs.submitOwnerInput(actor, input.publicId, input.answer);
          return { content: `${r.note} (state: ${r.state})`, ephemeral: true };
        }
        case 'cleanup': {
          this.buckets.check('jobRead', actor.discordUserId);
          const r = d.jobs.cleanup(actor, String(e.options['id'] ?? ''), e.options['force'] === true);
          return { content: r.note, ephemeral: true };
        }
        default: {
          this.buckets.check('jobRead', actor.discordUserId);
          const detail = d.jobs.detail(actor, String(e.options['id'] ?? ''));
          const rows: OutboundRow[] = [];
          const pending = detail.approvals.filter((a) => a.state === 'pending');
          if (pending.length > 0) {
            rows.push(
              ...pending.slice(0, 4).map((a) => ({
                buttons: (['approve', 'reject'] as const).map((kind) => ({
                  customId: d.signer.sign({ kind, entityId: a.id, actorUserId: actor.discordUserId }),
                  label: `${kind} #${a.actionIndex + 1}`,
                  style: kind === 'approve' ? ('success' as const) : ('danger' as const),
                })),
              })),
            );
          }
          if (detail.job.state === 'needs_owner_input') {
            rows.push({
              buttons: [
                {
                  customId: d.signer.sign({
                    kind: 'job_answer',
                    entityId: detail.job.publicId,
                    actorUserId: actor.discordUserId,
                  }),
                  label: 'Answer',
                  style: 'primary',
                },
              ],
            });
          }
          const reservation = undefined;
          void reservation;
          return present.jobDetail(
            detail.job,
            detail.events,
            detail.approvals,
            detail.result?.summaryRedacted ?? null,
            rows,
          );
        }
      }
    });

    this.commands.set('repo', async (actor, e) => {
      this.buckets.check('jobRead', actor.discordUserId);
      const summary = await d.github.repoStatus(actor, String(e.options['slug'] ?? ''));
      return present.repoStatus(summary);
    });

    this.commands.set('status', async (actor) => {
      this.buckets.check('jobRead', actor.discordUserId);
      d.authz.requireOwner(actor);
      return present.statusEmbed(d.status());
    });
  }

  // ----------------------------------------------------------- components --

  private registerComponents(): void {
    const d = this.deps;

    const setStatus = (status: CaptureState): ComponentHandler => async (actor, entityId) => {
      d.captures.setStatus(actor, entityId, status);
      return { content: `Marked ${status}.`, ephemeral: true };
    };

    this.components.set('inbox_done', setStatus('done'));
    this.components.set('inbox_archive', setStatus('archived'));
    this.components.set('inbox_delete', async (actor, entityId) => {
      d.captures.delete(actor, entityId);
      return { content: 'Deleted.', ephemeral: true };
    });

    this.components.set('sched_confirm', async (actor, entityId) => {
      const { saved } = d.schedules.confirm(actor, entityId);
      return { content: `Saved ${saved} schedule entr${saved === 1 ? 'y' : 'ies'}.`, ephemeral: true };
    });
    /**
     * The button opens a modal (handled in the transport); the submission
     * arrives here with the edited text. One entry per line, in the same shape
     * the extractor emits, so a correction is a re-parse rather than a
     * free-form edit that could smuggle anything past validation.
     */
    this.components.set('sched_edit', async (actor, entityId, values) => {
      const raw = values?.['entries'];
      if (!raw) {
        const draft = d.schedules.pendingDraft(actor, entityId);
        if (!draft) {
          return {
            content: 'This schedule preview expired. Send it again.',
            ephemeral: true,
          };
        }
        return {
          content:
            'Edit the entries and submit again, one per line:\n```\n' +
            draft.entries
              .map((e) =>
                [e.startsAt, e.title, e.location ?? '', e.notes ?? '']
                  .join(' | ')
                  .replace(/\s*\|\s*$/, ''),
              )
              .join('\n') +
            '\n```',
          ephemeral: true,
        };
      }
      const corrected = await d.schedules.correctFromText(actor, entityId, raw);
      if (corrected.entries.length === 0) {
        return { content: 'No schedule entries found in that. Nothing was saved.', ephemeral: true };
      }
      const rows: OutboundRow[] = [
        {
          buttons: [
            {
              customId: d.signer.sign({
                kind: 'sched_confirm',
                entityId,
                actorUserId: actor.discordUserId,
              }),
              label: `Confirm ${corrected.entries.length}`,
              style: 'success',
            },
            {
              customId: d.signer.sign({
                kind: 'sched_edit',
                entityId,
                actorUserId: actor.discordUserId,
              }),
              label: 'Correct',
              style: 'primary',
            },
          ],
        },
      ];
      return present.schedulePreview(corrected, rows);
    });

    this.components.set('sched_discard', async (actor, entityId) => {
      d.schedules.discard(actor, entityId);
      return { content: 'Discarded. Nothing was saved.', ephemeral: true };
    });

    this.components.set('job_answer', async (actor, entityId, values) => {
      const answer = values?.['answer'];
      if (!answer) {
        return { content: `Use \`/job answer id:${entityId} answer:<your answer>\`.`, ephemeral: true };
      }
      const parsed = JobAnswerInputSchema.parse({ publicId: entityId, answer });
      const r = d.jobs.submitOwnerInput(actor, parsed.publicId, parsed.answer);
      return { content: `${r.note} (state: ${r.state})`, ephemeral: true };
    });

    this.components.set('job_cleanup', async (actor, entityId) => {
      const r = d.jobs.cleanup(actor, entityId, false);
      return { content: r.note, ephemeral: true };
    });

    this.components.set('approve', async (actor, entityId) => {
      const outcome = d.approvals.decide(actor, entityId, 'approved');
      return { content: `${outcome.note} Job is now ${outcome.jobState}.`, ephemeral: true };
    });
    this.components.set('reject', async (actor, entityId) => {
      const outcome = d.approvals.decide(actor, entityId, 'rejected');
      return { content: `${outcome.note} Job is now ${outcome.jobState}.`, ephemeral: true };
    });
  }
}

export const CONVERSATION_ROUTE_NAME = CONVERSATIONAL_ROUTE;

function errorReply(err: unknown): OutboundMessage {
  if (isDuckyError(err)) return { content: err.ownerMessage, ephemeral: true };
  if (err instanceof Error && err.name === 'ZodError') {
    return { content: 'That input was not valid.', ephemeral: true };
  }
  return { content: 'Something went wrong handling that.', ephemeral: true };
}

export type { OwnerOnlyCommand, OwnerOnlyInteractionKind };
