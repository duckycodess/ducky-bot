import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChannelRolePolicy } from '../src/domain/channel-roles.js';
import { ReplyPersistencePolicy } from '../src/domain/reply-persistence.js';

const OWNER = '100000000000000001';
const OTHER = '100000000000000002';
const ROLE = '900000000000000011';
const GUILD = '800000000000000001';

const policy = new ReplyPersistencePolicy(
  new ChannelRolePolicy({ task: ROLE, gpt: '900000000000000013' }),
  OWNER,
);

const transportSource = (): string =>
  readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'discord', 'discordjs.transport.ts'),
    'utf8',
  );

describe('the gateway intents', () => {
  /**
   * The bug: `Guilds + DirectMessages + MessageContent` was requested, and a
   * message in a guild channel produced no reply at all.
   *
   * `Guilds` carries guild and channel METADATA. It delivers no message.
   * Without `GuildMessages`, `MessageCreate` never fires for a guild channel --
   * so DMs worked, every guild channel was silent, and it looked exactly like a
   * conversation provider that was not answering.
   */
  it('requests GuildMessages, or no guild message is ever delivered', () => {
    const src = transportSource();
    expect(src).toMatch(/GatewayIntentBits\.GuildMessages/);
  });

  it('requests it in the probe too, so the probe tests what the transport does', () => {
    // A probe that connected with fewer intents would prove the wrong thing.
    const src = transportSource();
    const inProbe = src.slice(src.indexOf('probeGatewayConnection'));
    expect(inProbe).toMatch(/GatewayIntentBits\.GuildMessages/);
    expect(inProbe).toMatch(/GatewayIntentBits\.MessageContent/);
  });

  it('stays least-privilege: no presence, members, reactions or voice', () => {
    // GuildMessages is the narrowest addition that makes a guild conversation
    // possible. It must not become a habit of adding intents.
    const src = transportSource();
    for (const forbidden of [
      'GuildPresences', 'GuildMembers', 'GuildMessageReactions',
      'GuildVoiceStates', 'GuildInvites', 'GuildWebhooks',
    ]) {
      expect(src, forbidden).not.toMatch(new RegExp(`GatewayIntentBits\\.${forbidden}`));
    }
  });
});

describe('visibility is decided before the deferral', () => {
  /**
   * The second bug, and the subtler one. `deferReply` fixes whether a reply is
   * ephemeral and `editReply` cannot change it -- so a router that marked a
   * reply persistent AFTER routing changed nothing in Discord. The flag was set
   * faithfully and discarded silently, which looks exactly like the feature
   * working.
   */
  it('defers on the shared policy rather than always ephemeral', () => {
    const src = transportSource();
    // The old shape: an unconditional ephemeral deferral for commands.
    expect(src).not.toMatch(/deferReply\(\{ flags: EPHEMERAL_FLAG \}\);\s*\n\s*\} catch \{\s*\n\s*return; \/\/ already/);
    // The new shape: the decision is asked for first.
    expect(src).toMatch(/this\.persists\?\.\(event\)/);
    expect(src).toMatch(/deferReply\(persistent \? \{\} : \{ flags: EPHEMERAL_FLAG \}\)/);
  });

  it('still defers a COMPONENT press ephemerally', () => {
    // Its visibility would be fixed before the signature is checked, so
    // publishing it would publish the refusal for an invalid control.
    const src = transportSource();
    const component = src.slice(src.indexOf('private async handleComponent'));
    expect(component).toMatch(/deferReply\(\{ flags: EPHEMERAL_FLAG \}\)/);
  });
});

describe('what the shared persistence policy decides', () => {
  const at = (channelId: string, guildId: string | undefined) => ({ channelId, guildId });

  it('persists an owner command in a configured role channel', () => {
    expect(policy.persists({
      userId: OWNER, kind: 'command', context: at(ROLE, GUILD), commandName: 'task',
    })).toBe(true);
  });

  it('never persists for a non-owner, even there', () => {
    expect(policy.persists({
      userId: OTHER, kind: 'command', context: at(ROLE, GUILD), commandName: 'task',
    })).toBe(false);
  });

  it('never persists in an unconfigured guild channel', () => {
    expect(policy.persists({
      userId: OWNER, kind: 'command', context: at('900000000000000077', GUILD), commandName: 'task',
    })).toBe(false);
  });

  it('never persists in a DM, which needs no help being visible', () => {
    expect(policy.persists({
      userId: OWNER, kind: 'command', context: at(ROLE, undefined), commandName: 'task',
    })).toBe(false);
  });

  it('never persists without context at all', () => {
    expect(policy.persists({ userId: OWNER, kind: 'command', context: undefined })).toBe(false);
  });

  it('keeps /forget ephemeral by documented exception', () => {
    expect(policy.persists({
      userId: OWNER, kind: 'command', context: at(ROLE, GUILD), commandName: 'forget',
    })).toBe(false);
  });

  it('keeps a component press ephemeral', () => {
    expect(policy.persists({ userId: OWNER, kind: 'component', context: at(ROLE, GUILD) }))
      .toBe(false);
  });

  it('decides on identity and context only -- never a name, never the text', () => {
    /**
     * The two inputs that must never influence visibility. A Discord channel
     * NAME is not identity and changes freely; reply TEXT deciding its own
     * exposure would let output widen itself.
     */
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'reply-persistence.ts'),
      'utf8',
    );
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');

    // A channel NAME, in any of the shapes one would arrive as.
    for (const forbidden of ['channelName', 'channel_name', '.name']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // The reply's own content. Output must not decide its own exposure.
    for (const forbidden of ['content', 'embeds', 'OutboundMessage']) {
      expect(code, forbidden).not.toContain(forbidden);
    }

    /**
     * `commandName` IS read, and must be: it is how `/forget` stays exempt.
     * It is an identifier from the interaction, not a mutable label, so it is
     * a different kind of input from a channel name.
     */
    expect(code).toContain('commandName');
  });
});
