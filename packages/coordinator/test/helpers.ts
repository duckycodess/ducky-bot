import { randomBytes } from 'node:crypto';
import { createStore, openDatabase, runMigrations, type Store } from '@ducky/persistence';
import { MockConversationProvider, MockGitHubReader, keyFingerprint, sha256Hex } from '@ducky/adapters';
import { createApp, type App } from '../src/app.js';
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
  readonly registerExecutor?: boolean;
  readonly github?: MockGitHubReader;
}

export function makeHarness(opts: HarnessOptions = {}, realTransport = false): Harness {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  const store = createStore(db);

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
      allowlistJson: REPOS_JSON,
      conversation: new MockConversationProvider(),
      github: opts.github ?? new MockGitHubReader(),
    },
  );

  if (opts.registerExecutor !== false) {
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
    close: () => db.close(),
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

export const commitAction = (message = 'feat: add a') => ({
  kind: 'git_commit',
  description: 'commit the change',
  details: { message, files: ['src/a.ts'] },
});
