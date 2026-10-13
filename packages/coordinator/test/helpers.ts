import { randomBytes } from 'node:crypto';
import { createStore, openDatabase, runMigrations, type Store } from '@ducky/persistence';
import {
  MockConversationProvider, MockGitHubReader, keyFingerprint, sha256Hex,
  type ConversationProvider, type DependencyChecker, type FrontDoorPort, type GitHubReader,
  type WeatherPort,
} from '@ducky/adapters';
import type { AssistantWatchReader } from '../src/domain/assistant-watch.reader.js';
import { createApp, type App } from '../src/app.js';
import type { ActionPerformer } from '../src/domain/action-performer.js';
import { ConfiguredOwnerClock } from '../src/domain/owner-clock.js';
import { MockDiscordTransport } from '../src/discord/mock.transport.js';
import type { ActorContext } from '../src/security/authz.js';

export const OWNER = '100000000000000001';
export const CHAT = '100000000000000002';
export const STRANGER = '100000000000000003';

export const secret = (): string => randomBytes(32).toString('base64url');

export const REPOS_JSON = JSON.stringify({
  version: 1,
  repos: [
    {
      slug: 'demo',
      absolutePath: '/tmp/ducky-demo',
      defaultBranch: 'main',
      github: { owner: 'acme', repo: 'demo' },
      allowWorktree: true,
      allowBootstrap: true,
      bootstrapAllowedEntries: ['.git'],
      enabled: true,
    },
    {
      slug: 'other',
      absolutePath: '/tmp/ducky-other',
      defaultBranch: 'main',
      github: null,
      allowWorktree: true,
      allowBootstrap: false,
      bootstrapAllowedEntries: ['.git'],
      enabled: true,
    },
    {
      slug: 'disabled',
      absolutePath: '/tmp/ducky-disabled',
      defaultBranch: null,
      github: null,
      allowWorktree: true,
      allowBootstrap: false,
      bootstrapAllowedEntries: ['.git'],
      enabled: false,
    },
  ],
});

export interface Harness {
  readonly app: App;
  readonly store: Store;
  readonly transport: MockDiscordTransport;
  readonly owner: ActorContext;
  readonly chat: ActorContext;
  readonly stranger: ActorContext;
  readonly executorId: string;
  readonly keyId: string;
  readonly bearer: string;
  readonly hmac: string;
  close(): void;
}

export interface HarnessOptions {
  readonly env?: Record<string, string | undefined>;
  /** Replaces the default three-repo allowlist; used by the placement tests. */
  readonly allowlistJson?: string;
  readonly registerExecutor?: boolean;
  readonly github?: GitHubReader;
  /** The typed notification reader. Omitted means the shipped one, which observes nothing. */
  readonly assistantWatchReader?: AssistantWatchReader;
  /** The forecast. Omitted means Open-Meteo, which only runs if a location is configured. */
  readonly weather?: WeatherPort;
  /**
   * Drives the daily assistant's clock. Reminder materialization, due dates
   * and briefing day boundaries are all read through this, so a test can move
   * time without waiting for it.
   */
  readonly clock?: TestClock;
  /** Replaces the conversation provider; used by the attachment tests. */
  readonly conversation?: ConversationProvider;
  /** Injected download `fetch` for conversation attachments. */
  readonly conversationFetch?: typeof fetch;
  /** Answers dependency checks. Omitted means the shipped never-ready default. */
  readonly dependencyChecker?: DependencyChecker;
  /** Replaces the approved-action performer in service-level tests. */
  readonly actionPerformer?: ActionPerformer;
  /**
   * Replaces the installed workflow helper.
   *
   * There is no default: the real helper creates GitHub issues, so a test
   * that did not supply one must get `DisabledFrontDoor` and prove the
   * refusal rather than quietly reaching a network.
   */
  readonly frontDoor?: FrontDoorPort;
  /**
   * An existing store to build this app over.
   *
   * What a coordinator RESTART looks like from the outside: a new app, new
   * services, new in-memory everything, over the same rows. Without it a test
   * can only ever assert that state survives within one process, which is not
   * the property durable state is for.
   */
  readonly store?: Store;
}

/**
 * A hand-wound clock in a chosen timezone.
 *
 * `advance` is what makes the missed-reminder policy testable: a long outage
 * is one call, not a wait.
 */
export class TestClock extends ConfiguredOwnerClock {
  #ms: number;

  constructor(startIso: string, timeZone = 'UTC') {
    let self: TestClock;
    super(timeZone, () => self.#ms);
    self = this;
    this.#ms = Date.parse(startIso);
  }

  advance(ms: number): void {
    this.#ms += ms;
  }

  set(iso: string): void {
    this.#ms = Date.parse(iso);
  }
}

export function makeHarness(opts: HarnessOptions = {}, realTransport = false): Harness {
  // A supplied store is reused as-is; its migrations have already run.
  const db = opts.store?.db ?? openDatabase({ location: ':memory:' });
  if (!opts.store) runMigrations(db);
  const store = opts.store ?? createStore(db);

  const executorId = 'exec-a';
  const keyId = 'k1';
  const bearer = secret();
  const hmac = secret();

  const credentialsJson = JSON.stringify({
    version: 1,
    executors: [{ executorId, keyId, bearerToken: bearer, hmacSecret: hmac, state: 'active' }],
  });

  const transport = new MockDiscordTransport();
  const app = createApp(
    {
      NODE_ENV: 'test',
      DUCKY_PROFILE: 'development',
      OWNER_DISCORD_USER_ID: OWNER,
      CHAT_WHITELIST_USER_IDS: CHAT,
      DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(),
      DUCKY_EXECUTOR_CREDENTIALS: credentialsJson,
      DUCKY_DB_PATH: ':memory:',
      DUCKY_REPOS_FILE: 'unused-in-tests',
      ...opts.env,
    } as NodeJS.ProcessEnv,
    {
      store,
      // Omitting the override exercises the real selection path in app.ts.
      ...(realTransport ? {} : { transport }),
      allowlistJson: opts.allowlistJson ?? REPOS_JSON,
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.dependencyChecker ? { dependencyChecker: opts.dependencyChecker } : {}),
      ...(opts.actionPerformer ? { actionPerformer: opts.actionPerformer } : {}),
      ...(opts.frontDoor ? { frontDoor: opts.frontDoor } : {}),
      ...(opts.conversationFetch ? { conversationFetch: opts.conversationFetch } : {}),
      conversation: opts.conversation ?? new MockConversationProvider(),
      github: opts.github ?? new MockGitHubReader(),
      ...(opts.assistantWatchReader ? { assistantWatchReader: opts.assistantWatchReader } : {}),
      ...(opts.weather ? { weather: opts.weather } : {}),
    },
  );

  /**
   * A borrowed store already has its executor registered.
   *
   * Re-issuing the credential would trip the unique key id, which is the
   * schema correctly refusing to mint a second credential for the same key --
   * and a restart does not re-issue credentials either.
   */
  const registerExecutor = opts.registerExecutor ?? opts.store === undefined;
  if (registerExecutor) {
    store.executors.upsertExecutor(executorId, 'test executor');
    store.executors.addCredential({
      executorId,
      keyId,
      bearerVerifier: sha256Hex(bearer),
      hmacKeyFingerprint: keyFingerprint(hmac),
    });
    store.executors.touchExecutor(executorId, '0.1.0');
  }

  return {
    app,
    store,
    transport,
    owner: app.authz.actor(OWNER),
    chat: app.authz.actor(CHAT),
    stranger: app.authz.actor(STRANGER),
    executorId,
    keyId,
    bearer,
    hmac,
    // A borrowed store belongs to the test, which closes it when it is done
    // with every app built over it.
    close: () => {
      if (!opts.store) db.close();
    },
  };
}

export const implementedResult = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  verdict: 'implemented',
  summary: 'made the change',
  changedFiles: ['src/a.ts'],
  review: { performed: true, independent: true, verdict: 'pass', notes: 'reviewed independently' },
  verification: { commands: [{ cmd: 'pnpm test', exitCode: 0, summary: 'green' }], passed: true },
  proposedActions: [],
  ...over,
});

/**
 * A result that reports a dependency. Mirrors `implementedResult`'s shape so a
 * test can submit one through exactly the same path.
 */
export const dependencyResult = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  verdict: 'waiting_on_dependency',
  summary: 'blocked on the release pipeline',
  changedFiles: [],
  review: { performed: false, independent: false, verdict: 'skipped', notes: '' },
  verification: { commands: [], passed: false },
  proposedActions: [],
  dependency: {
    type: 'ci_run',
    description: 'the upstream build to go green',
    externalKey: 'run-1234',
    nextCheckInSeconds: 60,
    maxChecks: 3,
    deadlineInSeconds: 3600,
    ...((over['dependency'] as Record<string, unknown>) ?? {}),
  },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'dependency')),
});

export const commitAction = (message = 'feat: add a') => ({
  kind: 'git_commit',
  description: 'commit the change',
  details: { message, files: ['src/a.ts'] },
});

/**
 * The text of a reply, wherever it lives.
 *
 * A conversational reply is one embed now rather than a bare paragraph, and the
 * text is in the description and NOT duplicated into `content` -- duplicating
 * would double every message and push a long reply past Discord's limits. This
 * reads either shape so a test can assert on what was said without caring how
 * it was rendered.
 */
export const replyText = (
  reply: { content?: string; embeds?: readonly { description?: string }[] } | undefined,
): string => reply?.content ?? reply?.embeds?.[0]?.description ?? '';
