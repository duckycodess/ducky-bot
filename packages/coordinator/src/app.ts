import {
  DeterministicScheduleExtractor, FileCredentialStore, GhCliReader, HerdrCli,
  MemoryCredentialStore, MockConversationProvider, HttpOpenClawProvider,
  assertPrivateGatewayUrl,
  type ConversationProvider, type ExecutorCredentialStore, type GitHubReader,
  type ScheduleExtractionProvider,
} from '@ducky/adapters';
import { DuckyError } from '@ducky/contracts';
import { createStore, openDatabase, runMigrations, type Store } from '@ducky/persistence';
import { loadEnv, cdnHosts, readReposFile, resolvePaths, type Env, type ResolvedPaths } from './config.js';
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
import { DuckyRouter } from './discord/router.js';
import { MockDiscordTransport } from './discord/mock.transport.js';
import { DiscordJsTransport } from './discord/discordjs.transport.js';
import { fetchTextAttachment } from './discord/attachments.js';
import { HourlyBudget } from './discord/command-buckets.js';
import type { DiscordTransport } from './discord/transport.js';
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
}

export interface App {
  readonly env: Env;
  readonly paths: ResolvedPaths;
  readonly discordProfile: DiscordProfileConfig;
  readonly store: Store;
  readonly authz: Authorizer;
  readonly allowlist: RepoAllowlist;
  readonly captures: CapturesService;
  readonly schedules: SchedulesService;
  readonly jobs: JobsService;
  readonly approvals: ApprovalsService;
  readonly github: GitHubService;
  readonly reconciler: Reconciler;
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

  const store = overrides.store ?? createStoreFromEnv(env, paths);
  const authz = new Authorizer(loadAuthzConfig(env));
  const signer = new ComponentSigner(env.DUCKY_COMPONENT_SIGNING_KEY);

  const allowlist = RepoAllowlist.fromJson(
    overrides.allowlistJson ?? readReposFile(paths.reposFile),
  );
  for (const row of allowlist.toRepoRows()) store.repos.upsert(row);

  // Audit only -- never consulted for authorization.
  store.audit.observe(authz.ownerId, 'owner');
  for (const id of authz.allConfiguredIds().slice(1)) store.audit.observe(id, 'chat');
  store.audit.revokeMissing(authz.allConfiguredIds());

  const credentials = overrides.credentials ?? credentialStoreFromEnv(env);
  const conversation = overrides.conversation ?? conversationFromEnv(env);
  const extractor = overrides.extractor ?? new DeterministicScheduleExtractor();
  const githubReader = overrides.github ?? new GhCliReader();

  const pending = new PendingScheduleStore();
  const captures = new CapturesService(store, authz);
  const schedules = new SchedulesService({ store, authz, pending, extractor });
  const jobs = new JobsService({ store, authz, allowlist });
  const approvals = new ApprovalsService({ store, authz, performer: new DeferredActionPerformer() });
  const github = new GitHubService(authz, allowlist, githubReader);
  const reconciler = new Reconciler({ store, approvals, pending });

  const transport = overrides.transport ?? transportForProfile(discordProfile);
  const attachmentBudget = new HourlyBudget(env.SCHEDULE_ATTACHMENTS_PER_HOUR);
  const hosts = cdnHosts(env);

  const scope = discordProfile.token ? commandScopeFor(discordProfile) : undefined;
  const status = (): ProviderStatus => ({
    profile: `${discordProfile.profile} (${paths.instanceLabel})`,
    discord:
      transport.kind === 'real'
        ? `real (${discordProfile.profile} bot, ${scope?.kind === 'guild' ? 'guild' : 'global'} commands)`
        : `mock (no ${discordProfile.profile} token)`,
    conversation: conversation.verified ? conversation.name : `${conversation.name} (unverified)`,
    orchestrator: overrides.herdrVerified ? 'herdr-pi (verified)' : 'herdr-pi (experimental)',
    scheduleExtraction: `${extractor.name} (binary: ${
      extractor.supportsBinary && env.SCHEDULE_BINARY_EXTRACTION_ENABLED ? 'enabled' : 'disabled'
    })`,
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
    conversation,
    status,
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
  });

  return {
    env, paths, discordProfile, store, authz, allowlist, captures, schedules, jobs,
    approvals, github, reconciler, router, transport, credentials, conversation, status,
    close: () => store.db.close(),
  };
}

function createStoreFromEnv(env: Env, paths: ResolvedPaths): Store {
  const db = openDatabase({ location: paths.dbPath });
  runMigrations(db);
  return createStore(db);
}

function credentialStoreFromEnv(env: Env): ExecutorCredentialStore {
  if (env.DUCKY_EXECUTOR_CREDENTIALS_FILE) {
    return new FileCredentialStore(env.DUCKY_EXECUTOR_CREDENTIALS_FILE);
  }
  if (env.DUCKY_EXECUTOR_CREDENTIALS) {
    return new MemoryCredentialStore(env.DUCKY_EXECUTOR_CREDENTIALS, env.NODE_ENV);
  }
  throw new DuckyError(
    'credential_unavailable',
    'Configure DUCKY_EXECUTOR_CREDENTIALS_FILE (or DUCKY_EXECUTOR_CREDENTIALS outside production).',
  );
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
  return new DiscordJsTransport(config.token, (client) => ({
    deliver: async (target, message) => {
      const c = client as {
        users?: { fetch(id: string): Promise<{ send(payload: unknown): Promise<unknown> }> };
      };
      if (!c.users) throw new DuckyError('not_found', 'The Discord client is not connected.');
      const user = await c.users.fetch(target.userId);
      await user.send(toDiscordPayload({ ...message, ephemeral: false }));
    },
  }));
}

function conversationFromEnv(env: Env): ConversationProvider {
  if (!env.OPENCLAW_BASE_URL) return new MockConversationProvider();
  // Fails loudly at startup rather than quietly exposing the gateway.
  assertPrivateGatewayUrl(env.OPENCLAW_BASE_URL);
  return new HttpOpenClawProvider(env.OPENCLAW_BASE_URL);
}

export { HerdrCli };
