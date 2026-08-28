import {
  DeterministicScheduleExtractor, FileCredentialStore, GhCliReader, HerdrCli,
  MemoryCredentialStore, MockConversationProvider, HttpOpenClawProvider,
  assertPrivateGatewayUrl,
  UnavailableDependencyChecker,
  type ConversationProvider, type DependencyChecker, type ExecutorCredentialStore,
  type GitHubReader, type ScheduleExtractionProvider,
} from '@ducky/adapters';
import { DuckyError } from '@ducky/contracts';
import { createStore, openDatabase, runMigrations, type Store } from '@ducky/persistence';
import {
  loadEnv, cdnHosts, readReposFile, resolveOwnerTimeZone, resolvePaths, resolveProfileSecrets,
  resolveSharedChannelIds,
  type Env, type ProfileSecrets, type ResolvedPaths,
} from './config.js';
import { commandScopeFor, resolveDiscordProfile, type DiscordProfileConfig } from './discord/profile-config.js';
import { Authorizer, loadAuthzConfig } from './security/authz.js';
import { ComponentSigner } from './security/component-signing.js';
import { RepoAllowlist } from './domain/allowlist.js';
import { CapturesService } from './domain/captures.service.js';
import { PendingScheduleStore } from './domain/pending-schedules.js';
import { SchedulesService } from './domain/schedules.service.js';
import { JobsService } from './domain/jobs.service.js';
import { ApprovalsService } from './domain/approvals.service.js';
import { DeferredActionPerformer } from './domain/action-performer.js';
import { GitHubService } from './domain/github.service.js';
import { Reconciler } from './domain/reconciler.js';
import { JobNotifier } from './domain/notifications.service.js';
import { SharedJobsService } from './domain/shared-jobs.service.js';
import { SharedChannelPolicy } from './domain/shared-visibility.js';
import { ConfiguredOwnerClock, type OwnerClock } from './domain/owner-clock.js';
import { TasksService } from './domain/tasks.service.js';
import { RemindersService } from './domain/reminders.service.js';
import { BriefingService } from './domain/briefing.service.js';
import { ReminderNotifier } from './domain/reminder-notifications.service.js';
import { DependencyResolver } from './domain/dependency-resolver.js';
import { DuckyRouter } from './discord/router.js';
import { MockDiscordTransport } from './discord/mock.transport.js';
import { DiscordJsTransport } from './discord/discordjs.transport.js';
import { fetchTextAttachment } from './discord/attachments.js';
import {
  attachmentAvailability, type ConversationAttachmentConfig,
} from './discord/conversation-attachments.js';
import { HourlyBudget } from './discord/command-buckets.js';
import type { DiscordSink, DiscordTransport } from './discord/transport.js';
import { toDiscordPayload } from './discord/payload.js';
import type { ProviderStatus } from './discord/presenters.js';

export interface AppOverrides {
  readonly store?: Store;
  readonly credentials?: ExecutorCredentialStore;
  readonly conversation?: ConversationProvider;
  readonly github?: GitHubReader;
  readonly extractor?: ScheduleExtractionProvider;
  readonly transport?: DiscordTransport;
  readonly allowlistJson?: string;
  readonly herdrVerified?: boolean;
  /**
   * Injected clock for the daily assistant. Tests drive reminder
   * materialization, due dates and briefing day boundaries through this
   * instead of waiting for real time to pass.
   */
  readonly clock?: OwnerClock;
  /**
   * Injected `fetch` for the conversation-attachment download. Tests use it to
   * exercise the byte path without a network; nothing in production supplies
   * it, so the global `fetch` is what actually runs.
   */
  readonly conversationFetch?: typeof fetch;
  /**
   * Answers "is this dependency ready yet?". Omitted in production, which
   * gets `UnavailableDependencyChecker` -- a checker that only ever answers
   * `pending`, so no job is ever resumed on the strength of a check that did
   * not happen.
   */
  readonly dependencyChecker?: DependencyChecker;
}

export interface App {
  readonly env: Env;
  readonly paths: ResolvedPaths;
  readonly discordProfile: DiscordProfileConfig;
  readonly store: Store;
  readonly authz: Authorizer;
  readonly signer: ComponentSigner;
  readonly allowlist: RepoAllowlist;
  readonly captures: CapturesService;
  readonly schedules: SchedulesService;
  readonly jobs: JobsService;
  readonly approvals: ApprovalsService;
  readonly github: GitHubService;
  readonly reconciler: Reconciler;
  readonly notifier: JobNotifier;
  readonly clock: OwnerClock;
  readonly tasks: TasksService;
  readonly reminders: RemindersService;
  readonly briefing: BriefingService;
  readonly reminderNotifier: ReminderNotifier;
  readonly dependencies: DependencyResolver;
  /** Reported by /status and asserted by tests; off by default. */
  readonly conversationAttachments: ConversationAttachmentConfig;
  readonly sharedPolicy: SharedChannelPolicy;
  readonly sharedJobs: SharedJobsService;
  readonly router: DuckyRouter;
  readonly transport: DiscordTransport;
  readonly credentials: ExecutorCredentialStore;
  readonly conversation: ConversationProvider;
  readonly status: () => ProviderStatus;
  close(): void;
}

/**
 * Composition root. Every provider is chosen here and reported through
 * /status, so the owner can always see which parts are real.
 */
export function createApp(
  envSource: NodeJS.ProcessEnv = process.env,
  overrides: AppOverrides = {},
): App {
  const env = loadEnv(envSource);
  const paths = resolvePaths(env);
  // Fails closed for production without its own credentials, and never reads
  // the other profile's variables.
  const discordProfile = resolveDiscordProfile(env.DUCKY_PROFILE, envSource);

  // Secrets for THIS profile only. Production never falls back to a shared or
  // development value.
  const secrets = resolveProfileSecrets(env);

  const store = overrides.store ?? createStoreFromEnv(env, paths);
  const authz = new Authorizer(loadAuthzConfig(env));
  const signer = new ComponentSigner(secrets.componentSigningKey);

  const allowlist = RepoAllowlist.fromJson(
    overrides.allowlistJson ?? readReposFile(paths.reposFile),
  );
  for (const row of allowlist.toRepoRows()) store.repos.upsert(row);

  // Audit only -- never consulted for authorization.
  store.audit.observe(authz.ownerId, 'owner');
  for (const id of authz.allConfiguredIds().slice(1)) store.audit.observe(id, 'chat');
  store.audit.revokeMissing(authz.allConfiguredIds());

  const credentials = overrides.credentials ?? credentialStoreFor(env, paths, secrets);
  const conversation = overrides.conversation ?? conversationFromEnv(env);
  const extractor = overrides.extractor ?? new DeterministicScheduleExtractor();
  const githubReader = overrides.github ?? new GhCliReader();

  // One clock and one timezone for the whole assistant, validated here so a
  // bad DUCKY_OWNER_TIMEZONE fails at boot rather than at the first briefing.
  const clock = overrides.clock ?? new ConfiguredOwnerClock(resolveOwnerTimeZone(env));

  const pending = new PendingScheduleStore();
  const captures = new CapturesService(store, authz);
  const schedules = new SchedulesService({ store, authz, pending, extractor });
  const jobs = new JobsService({ store, authz, allowlist });
  const approvals = new ApprovalsService({ store, authz, performer: new DeferredActionPerformer() });
  const github = new GitHubService(authz, allowlist, githubReader);
  const tasks = new TasksService({ store, authz, clock });
  const reminders = new RemindersService({ store, authz, clock });
  const briefing = new BriefingService({ store, authz, clock });
  const reconciler = new Reconciler({ store, approvals, pending });

  // No real checker ships. The default answers `pending` for everything, so a
  // dependency wait runs out its bounded budget and goes to the owner rather
  // than being declared ready by something that never looked.
  const dependencyChecker = overrides.dependencyChecker ?? new UnavailableDependencyChecker();
  const dependencies = new DependencyResolver({ store, checker: dependencyChecker });

  // Opt-in, profile-scoped, and empty by default: with nothing configured the
  // shared surface does not exist at all.
  const sharedPolicy = new SharedChannelPolicy(resolveSharedChannelIds(env));
  const sharedJobs = new SharedJobsService({ store, allowlist });

  const transport = overrides.transport ?? transportForProfile(discordProfile);
  const notifier = new JobNotifier({
    store, transport, ownerId: authz.ownerId, signer, sharedPolicy, sharedJobs,
  });
  // Reminders go to the owner's DM and nowhere else: no shared policy, no
  // shared projection service, no channel branch to configure wrongly.
  const reminderNotifier = new ReminderNotifier({
    store, transport, ownerId: authz.ownerId, clock,
  });
  const attachmentBudget = new HourlyBudget(env.SCHEDULE_ATTACHMENTS_PER_HOUR);
  const conversationAttachmentBudget = new HourlyBudget(env.CONVERSATION_ATTACHMENTS_PER_HOUR);
  const hosts = cdnHosts(env);

  /**
   * Conversation attachments are off unless the operator says otherwise, and
   * even then the router still requires the provider to be verified AND
   * attachment-capable. Every host in the allowlist is the SAME
   * `DISCORD_CDN_HOSTS` the schedule surface uses -- one list, one place to
   * get wrong.
   */
  const conversationAttachments: ConversationAttachmentConfig = {
    enabled: env.CONVERSATION_ATTACHMENTS_ENABLED,
    allowedHosts: hosts,
    maxBytes: env.CONVERSATION_MAX_ATTACHMENT_BYTES,
    ...(overrides.conversationFetch ? { fetchImpl: overrides.conversationFetch } : {}),
  };

  const scope = discordProfile.token ? commandScopeFor(discordProfile) : undefined;
  const status = (): ProviderStatus => ({
    profile: `${discordProfile.profile} (${paths.instanceLabel})`,
    discord:
      transport.kind === 'real'
        ? `real (${discordProfile.profile} bot, ${scope?.kind === 'guild' ? 'guild' : 'global'} commands)`
        : `mock (no ${discordProfile.profile} token)`,
    conversation: conversation.verified ? conversation.name : `${conversation.name} (unverified)`,
    conversationAttachments: attachmentAvailability(conversation, conversationAttachments),
    orchestrator: overrides.herdrVerified ? 'herdr-pi (verified)' : 'herdr-pi (experimental)',
    scheduleExtraction: `${extractor.name} (binary: ${
      extractor.supportsBinary && env.SCHEDULE_BINARY_EXTRACTION_ENABLED ? 'enabled' : 'disabled'
    })`,
    ownerTimezone: clock.timeZone,
    dependencyChecker: dependencies.checkerVerified
      ? `${dependencies.checkerName} (verified)`
      : `${dependencies.checkerName} — dependency waits end at your desk, never auto-resumed`,
    sharedChannels: sharedPolicy.enabled
      ? `${sharedPolicy.configuredChannelIds.length} shared channel(s): job status is visible there`
      : 'none (all job information is owner-only)',
    actions: 'recorded, not executed (Phase 1)',
    executors: String(store.executors.listExecutors().filter((e) => e.state === 'active').length),
  });

  const router = new DuckyRouter({
    authz,
    signer,
    captures,
    schedules,
    jobs,
    approvals,
    github,
    tasks,
    reminders,
    briefing,
    conversation,
    status,
    sharedPolicy,
    sharedJobs,
    readAttachment: async (a) => {
      attachmentBudget.check(authz.ownerId);
      const { text } = await fetchTextAttachment(a, {
        binaryExtractionEnabled:
          env.SCHEDULE_BINARY_EXTRACTION_ENABLED && extractor.supportsBinary,
        allowedHosts: hosts,
        maxBytes: env.SCHEDULE_MAX_ATTACHMENT_BYTES,
      });
      return text;
    },
    conversationAttachments,
    chargeConversationAttachment: (userId) => conversationAttachmentBudget.check(userId),
  });

  return {
    env, paths, discordProfile, store, authz, signer, allowlist, captures, schedules, jobs,
    approvals, github, reconciler, notifier, sharedPolicy, sharedJobs, router, transport,
    credentials, conversation, status,
    clock, tasks, reminders, briefing, reminderNotifier, conversationAttachments, dependencies,
    close: () => store.db.close(),
  };
}

function createStoreFromEnv(env: Env, paths: ResolvedPaths): Store {
  const db = openDatabase({ location: paths.dbPath });
  runMigrations(db);
  return createStore(db);
}

/**
 * The credential file is profile-scoped, so a development coordinator can never
 * load production executor credentials by inheriting a shared variable.
 */
function credentialStoreFor(
  env: Env,
  paths: ResolvedPaths,
  secrets: ProfileSecrets,
): ExecutorCredentialStore {
  // An explicitly configured, profile-scoped file always wins.
  if (secrets.credentialsFile) return new FileCredentialStore(secrets.credentialsFile);
  if (secrets.inlineCredentials) {
    return new MemoryCredentialStore(secrets.inlineCredentials, env.NODE_ENV);
  }
  // Otherwise the PROFILE'S OWN default path -- which resolvePaths already
  // computed per profile. Production reaches its own default here; what it
  // must never do is inherit a shared or development value, and
  // resolveProfileSecrets has already refused to hand it one.
  return new FileCredentialStore(paths.credentialsFile);
}

/**
 * The SELECTED profile's token chooses the gateway. Development without a
 * token runs on the mock; production without one never gets this far, because
 * profile resolution already failed closed.
 *
 * Nothing falls back to the mock when a token is present -- that would
 * silently drop real traffic -- and nothing reads the other profile's token.
 */
function transportForProfile(config: DiscordProfileConfig): DiscordTransport {
  if (!config.token) return new MockDiscordTransport();
  return new DiscordJsTransport(config.token, channelAwareSink);
}

/**
 * Delivers a proactive message to either a user's DM or a channel.
 *
 * The message arrives here ALREADY sanitized -- `DiscordJsTransport.send`
 * calls `sanitizeOutbound` before any sink is consulted -- so both branches
 * are past the egress choke point and neither can reintroduce raw text.
 *
 * `ephemeral` is forced false on both: a proactive message has no interaction
 * token to be ephemeral against. For the channel branch that is also the
 * intent -- it is meant to be seen.
 *
 * The client is typed STRUCTURALLY rather than against discord.js, because
 * this module must not import it (asserted by a test).
 */
export function channelAwareSink(client: unknown): DiscordSink {
  const c = client as {
    users?: { fetch(id: string): Promise<{ send(payload: unknown): Promise<unknown> }> };
    channels?: { fetch(id: string): Promise<unknown> };
  };

  return {
    deliver: async (target, message) => {
      const payload = toDiscordPayload({ ...message, ephemeral: false });

      if (target.kind === 'channel') {
        if (!c.channels) throw new DuckyError('not_found', 'The Discord client is not connected.');
        const channel = (await c.channels.fetch(target.channelId)) as
          | { isTextBased?: () => boolean; send?: (p: unknown) => Promise<unknown> }
          | null;
        // A missing, non-text or unsendable channel fails LOUDLY rather than
        // silently dropping the update: the notifier then leaves that
        // transition pending and retries it on the next sweep.
        if (!channel || channel.isTextBased?.() === false || typeof channel.send !== 'function') {
          throw new DuckyError('not_found', 'That shared channel cannot receive messages.');
        }
        await channel.send(payload);
        return;
      }

      if (!c.users) throw new DuckyError('not_found', 'The Discord client is not connected.');
      const user = await c.users.fetch(target.userId);
      await user.send(payload);
    },
  };
}

function conversationFromEnv(env: Env): ConversationProvider {
  if (!env.OPENCLAW_BASE_URL) return new MockConversationProvider();
  // Fails loudly at startup rather than quietly exposing the gateway.
  assertPrivateGatewayUrl(env.OPENCLAW_BASE_URL);
  return new HttpOpenClawProvider(env.OPENCLAW_BASE_URL);
}

export { HerdrCli };
