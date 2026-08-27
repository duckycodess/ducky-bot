import { describe, expect, it } from 'vitest';
import { PROFILE_ENV } from '@ducky/contracts';
import { commandScopeFor, resolveDiscordProfile } from '../src/discord/profile-config.js';
import { resolvePaths, resolveProfileSecrets, loadEnv, resolveCliPaths } from '../src/config.js';
import { makeHarness, OWNER, secret } from './helpers.js';

const DEV_TOKEN = 'dev-placeholder-token';
const PROD_TOKEN = 'prod-placeholder-token';
const APP = '100000000000000011';
const GUILD = '100000000000000012';

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OWNER_DISCORD_USER_ID: OWNER,
    DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(),
    DUCKY_PROD_COMPONENT_SIGNING_KEY: secret(),
    DUCKY_EXECUTOR_CREDENTIALS: '{"version":1,"executors":[]}',
    ...over,
  }) as NodeJS.ProcessEnv;

describe('Discord profile isolation', () => {
  it('reads only its own credentials, never the other profile’s', () => {
    // Production credentials present, development selected: dev must NOT see them.
    const dev = resolveDiscordProfile(
      'development',
      env({ DISCORD_PROD_TOKEN: PROD_TOKEN, DISCORD_PROD_APP_ID: APP }),
    );
    expect(dev.token).toBeUndefined();
    expect(dev.appId).toBeUndefined();

    // And the reverse, which is the dangerous direction.
    expect(() =>
      resolveDiscordProfile(
        'production',
        env({ DISCORD_DEV_TOKEN: DEV_TOKEN, DISCORD_DEV_APP_ID: APP, DISCORD_DEV_GUILD_ID: GUILD }),
      ),
    ).toThrow(/DISCORD_PROD_TOKEN is required/);
  });

  it('lets development run token-less on the mock', () => {
    const dev = resolveDiscordProfile('development', env());
    expect(dev.token).toBeUndefined();
    expect(dev.profile).toBe('development');
  });

  it('fails closed for production without its own token', () => {
    expect(() => resolveDiscordProfile('production', env())).toThrow(
      /never falls back to the development bot/,
    );
  });

  it('requires an application id alongside any token', () => {
    expect(() => resolveDiscordProfile('development', env({ DISCORD_DEV_TOKEN: DEV_TOKEN }))).toThrow(
      /DISCORD_DEV_APP_ID is required/,
    );
  });

  it('requires a guild for a token-bearing development profile', () => {
    expect(() =>
      resolveDiscordProfile('development', env({ DISCORD_DEV_TOKEN: DEV_TOKEN, DISCORD_DEV_APP_ID: APP })),
    ).toThrow(/DISCORD_DEV_GUILD_ID is required/);
  });

  it('rejects an unknown profile and a malformed snowflake', () => {
    expect(() => resolveDiscordProfile('staging', env())).toThrow(/must be one of/);
    expect(() =>
      resolveDiscordProfile('development', env({ DISCORD_DEV_TOKEN: DEV_TOKEN, DISCORD_DEV_APP_ID: 'nope' })),
    ).toThrow(/snowflake/);
  });

  it('names distinct environment variables per profile', () => {
    expect(PROFILE_ENV.development.token).not.toBe(PROFILE_ENV.production.token);
    expect(PROFILE_ENV.development.appId).not.toBe(PROFILE_ENV.production.appId);
    expect(PROFILE_ENV.development.guildId).not.toBe(PROFILE_ENV.production.guildId);
  });
});

describe('secrets are profile-scoped, never shared', () => {
  it('refuses a production profile that only has the shared signing key', () => {
    expect(() =>
      resolveProfileSecrets(
        loadEnv({
          OWNER_DISCORD_USER_ID: OWNER,
          DUCKY_PROFILE: 'production',
          DUCKY_COMPONENT_SIGNING_KEY: secret(),
          DISCORD_PROD_TOKEN: PROD_TOKEN,
          DISCORD_PROD_APP_ID: APP,
        } as NodeJS.ProcessEnv),
      ),
    ).toThrow(/never shares the development key/);
  });

  it('refuses a production profile holding only the development key', () => {
    expect(() =>
      resolveProfileSecrets(
        loadEnv({
          OWNER_DISCORD_USER_ID: OWNER,
          DUCKY_PROFILE: 'production',
          DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(),
        } as NodeJS.ProcessEnv),
      ),
    ).toThrow(/DUCKY_PROD_COMPONENT_SIGNING_KEY is required/);
  });

  it('never lets production inherit a shared or development credential file', () => {
    const secrets = resolveProfileSecrets(
      loadEnv(
        env({
          DUCKY_PROFILE: 'production',
          DUCKY_EXECUTOR_CREDENTIALS_FILE: '/shared/creds.json',
          DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE: '/dev/creds.json',
        }),
      ),
    );
    expect(secrets.credentialsFile).toBeUndefined();
    // Inline credentials are a development convenience only.
    expect(secrets.inlineCredentials).toBeUndefined();
  });

  it('uses each profile’s own credential file when configured', () => {
    const dev = resolveProfileSecrets(
      loadEnv(env({ DUCKY_PROFILE: 'development', DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE: '/dev.json' })),
    );
    const prod = resolveProfileSecrets(
      loadEnv(env({ DUCKY_PROFILE: 'production', DUCKY_PROD_EXECUTOR_CREDENTIALS_FILE: '/prod.json' })),
    );
    expect(dev.credentialsFile).toBe('/dev.json');
    expect(prod.credentialsFile).toBe('/prod.json');
  });

  it('gives the two profiles different signing keys', () => {
    const shared = env();
    const dev = resolveProfileSecrets(loadEnv({ ...shared, DUCKY_PROFILE: 'development' }));
    const prod = resolveProfileSecrets(loadEnv({ ...shared, DUCKY_PROFILE: 'production' }));
    expect(dev.componentSigningKey).not.toBe(prod.componentSigningKey);
  });

  it('still lets a single-profile development box use the shared names', () => {
    const secrets = resolveProfileSecrets(
      loadEnv({
        OWNER_DISCORD_USER_ID: OWNER,
        DUCKY_PROFILE: 'development',
        DUCKY_COMPONENT_SIGNING_KEY: secret(),
      } as NodeJS.ProcessEnv),
    );
    expect(secrets.componentSigningKey).toBeTruthy();
  });

  it('names distinct secret variables per profile', () => {
    expect(PROFILE_ENV.development.componentKey).not.toBe(PROFILE_ENV.production.componentKey);
    expect(PROFILE_ENV.development.credentialsFile).not.toBe(PROFILE_ENV.production.credentialsFile);
  });
});

describe('command registration scope', () => {
  it('scopes development to its configured guild for fast iteration', () => {
    const dev = resolveDiscordProfile(
      'development',
      env({ DISCORD_DEV_TOKEN: DEV_TOKEN, DISCORD_DEV_APP_ID: APP, DISCORD_DEV_GUILD_ID: GUILD }),
    );
    expect(commandScopeFor(dev)).toEqual({ kind: 'guild', guildId: GUILD });
  });

  it('registers production globally by default', () => {
    const prod = resolveDiscordProfile(
      'production',
      env({ DISCORD_PROD_TOKEN: PROD_TOKEN, DISCORD_PROD_APP_ID: APP }),
    );
    expect(commandScopeFor(prod)).toEqual({ kind: 'global' });
  });

  it('never borrows the development guild for production', () => {
    const prod = resolveDiscordProfile(
      'production',
      env({
        DISCORD_PROD_TOKEN: PROD_TOKEN,
        DISCORD_PROD_APP_ID: APP,
        DISCORD_DEV_GUILD_ID: GUILD,
      }),
    );
    // The dev guild is set, yet production stays global.
    expect(commandScopeFor(prod)).toEqual({ kind: 'global' });
  });

  it('honours an explicitly configured production guild', () => {
    const other = '100000000000000013';
    const prod = resolveDiscordProfile(
      'production',
      env({ DISCORD_PROD_TOKEN: PROD_TOKEN, DISCORD_PROD_APP_ID: APP, DISCORD_PROD_GUILD_ID: other }),
    );
    expect(commandScopeFor(prod)).toEqual({ kind: 'guild', guildId: other });
  });
});

describe('operational isolation between profiles', () => {
  it('defaults to distinct databases, ports, repo files and labels', () => {
    const dev = resolvePaths(loadEnv(env({ DUCKY_PROFILE: 'development' })));
    const prod = resolvePaths(loadEnv(env({ DUCKY_PROFILE: 'production' })));

    expect(dev.dbPath).not.toBe(prod.dbPath);
    expect(dev.httpPort).not.toBe(prod.httpPort);
    expect(dev.reposFile).not.toBe(prod.reposFile);
    expect(dev.instanceLabel).toBe('ducky-development');
    expect(prod.instanceLabel).toBe('ducky-production');
  });

  it('lets an explicit value override a per-profile default', () => {
    const paths = resolvePaths(
      loadEnv(
        env({
          DUCKY_PROFILE: 'production',
          DUCKY_DB_PATH: '/var/lib/ducky/custom.db',
          DUCKY_HTTP_PORT: '9999',
          DUCKY_INSTANCE_LABEL: 'ducky-prod-vm',
        }),
      ),
    );
    expect(paths.dbPath).toBe('/var/lib/ducky/custom.db');
    expect(paths.httpPort).toBe(9999);
    expect(paths.instanceLabel).toBe('ducky-prod-vm');
  });

  it('gives each profile its own credential file default', () => {
    const dev = resolvePaths(loadEnv(env({ DUCKY_PROFILE: 'development' })));
    const prod = resolvePaths(loadEnv(env({ DUCKY_PROFILE: 'production' })));
    expect(dev.credentialsFile).not.toBe(prod.credentialsFile);
  });

  it('reports the active profile in status, without leaking the token', () => {
    const h = makeHarness({ env: { DUCKY_PROFILE: 'development' } });
    const status = h.app.status();
    expect(status.profile).toContain('development');
    expect(JSON.stringify(status)).not.toContain(DEV_TOKEN);
    expect(JSON.stringify(status)).not.toContain(PROD_TOKEN);
    h.close();
  });
});

describe('blank env-file assignments behave as unset', () => {
  it('falls through to the profile default when DUCKY_DB_PATH is blank', () => {
    const withBlank = resolvePaths(loadEnv(env({ DUCKY_PROFILE: 'production', DUCKY_DB_PATH: '' })));
    const withUnset = resolvePaths(loadEnv(env({ DUCKY_PROFILE: 'production' })));
    expect(withBlank.dbPath).toBe(withUnset.dbPath);
    expect(withBlank.dbPath).not.toBe('');
  });

  it('falls through to the profile default when the credential file var is blank', () => {
    const withBlank = resolveProfileSecrets(
      loadEnv(env({ DUCKY_PROFILE: 'development', DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE: '' })),
    );
    expect(withBlank.credentialsFile).toBeUndefined();
  });

  it('does not let a blank DUCKY_HTTP_PORT crash instead of falling through', () => {
    const paths = resolvePaths(loadEnv(env({ DUCKY_PROFILE: 'development', DUCKY_HTTP_PORT: '' })));
    expect(paths.httpPort).toBe(8787);
  });

  it('still fails on a genuinely missing required field', () => {
    expect(() => loadEnv({ OWNER_DISCORD_USER_ID: '' } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('resolveCliPaths (migrate / credentials CLIs)', () => {
  it('honours the selected profile default for both db and credentials file', () => {
    const dev = resolveCliPaths({ DUCKY_PROFILE: 'development' } as NodeJS.ProcessEnv);
    const prod = resolveCliPaths({ DUCKY_PROFILE: 'production' } as NodeJS.ProcessEnv);
    expect(dev.dbPath).not.toBe(prod.dbPath);
    expect(dev.credentialsFile).not.toBe(prod.credentialsFile);
    expect(dev.dbPath).toBe(resolvePaths(loadEnv(env({ DUCKY_PROFILE: 'development' }))).dbPath);
    expect(prod.dbPath).toBe(resolvePaths(loadEnv(env({ DUCKY_PROFILE: 'production' }))).dbPath);
  });

  it('defaults to development when DUCKY_PROFILE is unset or blank', () => {
    const unset = resolveCliPaths({} as NodeJS.ProcessEnv);
    const blank = resolveCliPaths({ DUCKY_PROFILE: '' } as NodeJS.ProcessEnv);
    const dev = resolveCliPaths({ DUCKY_PROFILE: 'development' } as NodeJS.ProcessEnv);
    expect(unset).toEqual(dev);
    expect(blank).toEqual(dev);
  });

  it('rejects an unknown profile', () => {
    expect(() => resolveCliPaths({ DUCKY_PROFILE: 'staging' } as NodeJS.ProcessEnv)).toThrow(
      /must be one of/,
    );
  });

  it('lets an explicit DUCKY_DB_PATH override the profile default', () => {
    const out = resolveCliPaths({
      DUCKY_PROFILE: 'production',
      DUCKY_DB_PATH: '/var/lib/ducky/custom.db',
    } as NodeJS.ProcessEnv);
    expect(out.dbPath).toBe('/var/lib/ducky/custom.db');
  });

  it('treats a blank DUCKY_DB_PATH as unset, not as an empty path', () => {
    const blank = resolveCliPaths({ DUCKY_PROFILE: 'production', DUCKY_DB_PATH: '' } as NodeJS.ProcessEnv);
    const unset = resolveCliPaths({ DUCKY_PROFILE: 'production' } as NodeJS.ProcessEnv);
    expect(blank.dbPath).toBe(unset.dbPath);
  });

  it('production never inherits the shared (development) credentials file variable', () => {
    const out = resolveCliPaths({
      DUCKY_PROFILE: 'production',
      DUCKY_EXECUTOR_CREDENTIALS_FILE: '/shared/creds.json',
    } as NodeJS.ProcessEnv);
    expect(out.credentialsFile).not.toBe('/shared/creds.json');
  });

  it('prefers a profile-scoped credentials file over the shared one', () => {
    const out = resolveCliPaths({
      DUCKY_PROFILE: 'development',
      DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE: '/dev.json',
      DUCKY_EXECUTOR_CREDENTIALS_FILE: '/shared.json',
    } as NodeJS.ProcessEnv);
    expect(out.credentialsFile).toBe('/dev.json');
  });
});
