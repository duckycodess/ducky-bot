import { describe, expect, it } from 'vitest';
import { loadEnv, resolveWatchConfig } from '../src/config.js';
import { OWNER, secret } from './helpers.js';

const env = (over: Record<string, string | undefined> = {}) =>
  loadEnv({
    OWNER_DISCORD_USER_ID: OWNER,
    DUCKY_PROFILE: 'development',
    DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(),
    DUCKY_PROD_COMPONENT_SIGNING_KEY: secret(),
    DUCKY_EXECUTOR_CREDENTIALS: '{"version":1,"executors":[]}',
    ...over,
  } as NodeJS.ProcessEnv);

describe('the frozen configuration of notification-only watching', () => {
  it('is entirely off by default', () => {
    const c = resolveWatchConfig(env());
    expect(c).toMatchObject({ readerEnabled: false, discovery: false, account: null, includeForks: false, includeArchived: false });
    expect([...c.relationships].sort()).toEqual(['collaborator', 'organization', 'owner']);
  });

  it('refuses discovery without the reader or without the account that is the owner', () => {
    expect(() => resolveWatchConfig(env({ DUCKY_ASSISTANT_WATCH_DISCOVERY_ENABLED: 'true' }))).toThrow(/READER_ENABLED/);
    expect(() => resolveWatchConfig(env({
      DUCKY_ASSISTANT_WATCH_DISCOVERY_ENABLED: 'true', DUCKY_ASSISTANT_WATCH_READER_ENABLED: 'true',
    }))).toThrow(/ACCOUNT/);
  });

  it('refuses a malformed account, an unknown relationship and an empty scope', () => {
    expect(() => resolveWatchConfig(env({ DUCKY_ASSISTANT_WATCH_ACCOUNT: 'not a login!' }))).toThrow(/login/);
    expect(() => resolveWatchConfig(env({ DUCKY_ASSISTANT_WATCH_RELATIONSHIPS: 'owner,everyone' }))).toThrow(/unknown/);
    expect(() => resolveWatchConfig(env({
      DUCKY_ASSISTANT_WATCH_DISCOVERY_ENABLED: 'true', DUCKY_ASSISTANT_WATCH_READER_ENABLED: 'true',
      DUCKY_ASSISTANT_WATCH_ACCOUNT: 'me', DUCKY_ASSISTANT_WATCH_RELATIONSHIPS: ' , ',
    }))).toThrow(/relationship/);
  });

  it('resolves a complete discovery configuration', () => {
    const c = resolveWatchConfig(env({
      DUCKY_ASSISTANT_WATCH_DISCOVERY_ENABLED: 'true', DUCKY_ASSISTANT_WATCH_READER_ENABLED: 'true',
      DUCKY_ASSISTANT_WATCH_ACCOUNT: 'me', DUCKY_ASSISTANT_WATCH_RELATIONSHIPS: 'owner,organization',
      DUCKY_ASSISTANT_WATCH_INCLUDE_FORKS: 'true',
    }));
    expect(c).toMatchObject({ readerEnabled: true, discovery: true, account: 'me', includeForks: true, includeArchived: false });
    expect([...c.relationships].sort()).toEqual(['organization', 'owner']);
  });
});
