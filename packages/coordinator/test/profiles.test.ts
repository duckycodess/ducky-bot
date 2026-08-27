import { describe, expect, it } from 'vitest';
import { PROFILE_ENV } from '@ducky/contracts';
import { commandScopeFor, resolveDiscordProfile } from '../src/discord/profile-config.js';
import { resolvePaths, loadEnv } from '../src/config.js';
import { makeHarness, OWNER, secret } from './helpers.js';

const DEV_TOKEN = 'dev-placeholder-token';
const PROD_TOKEN = 'prod-placeholder-token';
const APP = '100000000000000011';
const GUILD = '100000000000000012';

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OWNER_DISCORD_USER_ID: OWNER,
    DUCKY_COMPONENT_SIGNING_KEY: secret(),
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

  it('reports the active profile in status, without leaking the token', () => {
    const h = makeHarness({ env: { DUCKY_PROFILE: 'development' } });
    const status = h.app.status();
    expect(status.profile).toContain('development');
    expect(JSON.stringify(status)).not.toContain(DEV_TOKEN);
    expect(JSON.stringify(status)).not.toContain(PROD_TOKEN);
    h.close();
  });
});
