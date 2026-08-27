import { describe, expect, it } from 'vitest';
import {
  CONVERSATIONAL_ROUTE, OWNER_ONLY_COMMANDS, OWNER_ONLY_INTERACTION_KINDS,
} from '@ducky/contracts';
import { Authorizer, loadAuthzConfig } from '../src/security/authz.js';
import { CHAT, OWNER, STRANGER, makeHarness, secret } from './helpers.js';

describe('authorization configuration', () => {
  it('requires exactly one owner', () => {
    expect(() => loadAuthzConfig({ OWNER_DISCORD_USER_ID: undefined })).toThrow(/required/);
    expect(() => loadAuthzConfig({ OWNER_DISCORD_USER_ID: '  ' })).toThrow(/required/);
    expect(() => loadAuthzConfig({ OWNER_DISCORD_USER_ID: 'not-a-snowflake' })).toThrow(/snowflake/);
    expect(() => loadAuthzConfig({ OWNER_DISCORD_USER_ID: `${OWNER},${CHAT}` })).toThrow(/exactly one/);
    expect(() => loadAuthzConfig({ OWNER_DISCORD_USER_ID: `${OWNER} ${CHAT}` })).toThrow(/exactly one/);
  });

  it('rejects an overlapping whitelist and malformed ids', () => {
    expect(() =>
      loadAuthzConfig({ OWNER_DISCORD_USER_ID: OWNER, CHAT_WHITELIST_USER_IDS: OWNER }),
    ).toThrow(/not contain the owner/);
    expect(() =>
      loadAuthzConfig({ OWNER_DISCORD_USER_ID: OWNER, CHAT_WHITELIST_USER_IDS: 'abc' }),
    ).toThrow(/invalid id/);
  });

  it('never consults the database, so a stale audit row grants nothing', () => {
    const h = makeHarness();
    // Forge an owner row for a stranger directly in the audit table.
    h.store.audit.observe(STRANGER, 'owner');
    expect(h.app.authz.roleOf(STRANGER)).toBe('none');
    expect(() => h.app.authz.requireOwner(h.app.authz.actor(STRANGER))).toThrow();
    h.close();
  });

  it('revokes immediately when config changes, with no migration', () => {
    const before = new Authorizer(loadAuthzConfig({ OWNER_DISCORD_USER_ID: OWNER }));
    const after = new Authorizer(loadAuthzConfig({ OWNER_DISCORD_USER_ID: CHAT }));
    expect(before.roleOf(OWNER)).toBe('owner');
    expect(after.roleOf(OWNER)).toBe('none');
    expect(after.roleOf(CHAT)).toBe('owner');
  });
});

describe('owner-only surface manifest', () => {
  it('registers exactly the manifest, plus the single conversational route', () => {
    const h = makeHarness();
    expect(h.app.router.registeredCommands()).toEqual([...OWNER_ONLY_COMMANDS].sort());
    expect(h.app.router.registeredComponentKinds()).toEqual([...OWNER_ONLY_INTERACTION_KINDS].sort());
    expect(CONVERSATIONAL_ROUTE).toBe('conversation');
    h.close();
  });

  it('routes conversation for a whitelist user but refuses every command', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));

    const chat = await h.transport.dispatch({
      kind: 'message', userId: CHAT, text: 'hello', threadKey: 't',
    });
    expect(chat?.content).toContain('[mock]');

    for (const name of OWNER_ONLY_COMMANDS) {
      const reply = await h.transport.dispatch({
        kind: 'command', name, userId: CHAT, options: {},
      });
      expect(reply?.content, name).toMatch(/not authorized/i);
    }
    h.close();
  });

  it('refuses conversation from an unknown user entirely', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    const reply = await h.transport.dispatch({
      kind: 'message', userId: STRANGER, text: 'hi', threadKey: 't',
    });
    expect(reply?.content).toMatch(/not authorized/i);
    h.close();
  });

  it('fails fast if the profile’s component signing key is missing or weak', () => {
    expect(() =>
      makeHarness({ env: { DUCKY_DEV_COMPONENT_SIGNING_KEY: 'short' } }),
    ).toThrow(/32 bytes/);
    expect(() => makeHarness({ env: { DUCKY_DEV_COMPONENT_SIGNING_KEY: secret() } })).not.toThrow();
    // Absent entirely is also fatal; there is no unsigned fallback.
    expect(() =>
      makeHarness({
        env: { DUCKY_DEV_COMPONENT_SIGNING_KEY: undefined, DUCKY_COMPONENT_SIGNING_KEY: undefined },
      }),
    ).toThrow(/required/);
  });
});
