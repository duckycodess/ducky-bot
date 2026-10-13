import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockFrontDoor, NO_ATTACHMENT_CAPABILITY, NO_SESSION_DELETION,
  type ConversationCapabilities, type ConversationInput, type ConversationProvider,
  type ConversationReply,
} from '@ducky/adapters';
import { makeHarness, OWNER, replyText } from './helpers.js';

class RecordingProvider implements ConversationProvider {
  readonly name = 'recording';
  readonly verified = true;
  readonly capabilities: ConversationCapabilities = { attachments: NO_ATTACHMENT_CAPABILITY, sessionDeletion: NO_SESSION_DELETION('test stand-in') };
  readonly turns: ConversationInput[] = [];
  async reply(input: ConversationInput): Promise<ConversationReply> {
    this.turns.push(input);
    return { text: 'Q1 - what is the smallest version of this?', mock: false };
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A skills directory shaped the way the installed ones actually are. */
const skillsDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ducky-skills-'));
  temps.push(dir);
  return dir;
};

const writeSkill = (root: string, name: string, body: string): string => {
  mkdirSync(path.join(root, name), { recursive: true });
  const file = path.join(root, name, 'SKILL.md');
  writeFileSync(file, body);
  return file;
};

const boot = async (grillSkillPath?: string) => {
  const door = new MockFrontDoor();
  const provider = new RecordingProvider();
  const h = makeHarness({
    frontDoor: door,
    conversation: provider,
    env: {
      DUCKY_DEV_SKILL_BRIDGE_ENABLED: '1',
      DUCKY_DEV_WORKFLOW_HELPER: '/tmp/not-spawned/workflow.py',
      DUCKY_DEV_WORKFLOW_MUTATION_ENABLED: '1',
      ...(grillSkillPath ? { DUCKY_DEV_WORKFLOW_GRILL_SKILL: grillSkillPath } : {}),
    },
  });
  await h.transport.start((e) => h.app.router.handle(e));
  return { h, door, provider };
};

const grill = (h: Awaited<ReturnType<typeof boot>>['h']) =>
  h.transport.dispatch({
    kind: 'message', userId: OWNER, text: '$grill-me the retry policy', threadKey: 'dm-1',
  });

/**
 * The acceptance criterion is that `$grill-me` LOADS THE INSTALLED SKILL.
 *
 * An interview Ducky improvised because the file was missing is not that
 * skill, and it is the worse failure of the two: the owner believes they are
 * being grilled by the method they chose, and they are not.
 */
describe('$grill-me refuses without the installed skill', () => {
  it('refuses when no skill path is configured, and reads nothing', async () => {
    const { h, door, provider } = await boot();
    const reply = await grill(h);

    expect(replyText(reply)).toMatch(/installed grilling skill/i);
    expect(replyText(reply)).toMatch(/nothing was read/i);
    expect(provider.turns).toHaveLength(0);
    expect(door.calls).toHaveLength(0);
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.grilling ?? false).toBe(false);
    h.close();
  });

  it('refuses when the configured file is absent', async () => {
    const { h, provider } = await boot(path.join(skillsDir(), 'nope', 'SKILL.md'));
    const reply = await grill(h);
    expect(replyText(reply)).toMatch(/could not be read|not installed/i);
    expect(provider.turns).toHaveLength(0);
    h.close();
  });

  it('refuses an empty file rather than handing the model nothing', async () => {
    const root = skillsDir();
    const { h, provider } = await boot(writeSkill(root, 'grilling', '   \n'));
    const reply = await grill(h);
    expect(replyText(reply)).toMatch(/installed grilling skill/i);
    expect(provider.turns).toHaveLength(0);
    h.close();
  });

  it('refuses an oversized file rather than silently sending no method', async () => {
    const root = skillsDir();
    const file = writeSkill(root, 'grilling', 'x'.repeat(64 * 1024));
    const { h, provider } = await boot(file);
    const reply = await grill(h);
    expect(replyText(reply)).toMatch(/too large|installed grilling skill/i);
    expect(provider.turns).toHaveLength(0);
    h.close();
  });

  it('refuses an unreadable file', async () => {
    const root = skillsDir();
    const file = writeSkill(root, 'grilling', 'the method');
    chmodSync(file, 0o000);
    const { h, provider } = await boot(file);
    const reply = await grill(h);
    expect(replyText(reply)).toMatch(/could not be read|not installed/i);
    expect(provider.turns).toHaveLength(0);
    chmodSync(file, 0o600);
    h.close();
  });
});

describe('$grill-me follows the installed skill\'s own redirect', () => {
  /**
   * `grill-me/SKILL.md` as installed is a 157-byte POINTER whose whole body is
   * `Call the Skill tool with "grilling".` -- the method lives in
   * `grilling/SKILL.md` beside it. Configuring the obvious path and handing
   * the model that pointer would be the same failure as handing it nothing:
   * it would invent the interview.
   */
  it('resolves a one-hop redirect to the skill that carries the method', async () => {
    const root = skillsDir();
    writeSkill(root, 'grilling', 'UPSTREAM GRILL METHOD: work the design tree in rounds.');
    const stub = writeSkill(
      root,
      'grill-me',
      '---\nname: grill-me\ndescription: A relentless interview.\n---\n\n' +
        'Call the Skill tool with "grilling".\n',
    );

    const { h, provider } = await boot(stub);
    await grill(h);

    const instructions = (provider.turns.at(-1)?.instructions ?? []).join('\n');
    expect(instructions).toContain('UPSTREAM GRILL METHOD');
    // The pointer itself is not the method and must not be sent as one.
    expect(instructions).not.toContain('Call the Skill tool');
    h.close();
  });

  it('refuses when the redirect target is not installed', async () => {
    const root = skillsDir();
    const stub = writeSkill(
      root, 'grill-me', '---\nname: grill-me\n---\n\nCall the Skill tool with "grilling".\n',
    );
    const { h, provider } = await boot(stub);
    const reply = await grill(h);

    expect(replyText(reply)).toMatch(/could not be read|not installed/i);
    expect(provider.turns).toHaveLength(0);
    h.close();
  });

  it('follows only ONE hop, so a loop cannot hang the command', async () => {
    const root = skillsDir();
    writeSkill(root, 'a', 'Call the Skill tool with "b".\n');
    const start = writeSkill(root, 'b', 'Call the Skill tool with "a".\n');
    const { h, provider } = await boot(start);
    const reply = await grill(h);

    expect(replyText(reply)).toMatch(/installed grilling skill|could not be read/i);
    expect(provider.turns).toHaveLength(0);
    h.close();
  });
});

describe('a usable installed skill still works', () => {
  it('hands the model the method and opens the interview', async () => {
    const root = skillsDir();
    const file = writeSkill(root, 'grilling', 'UPSTREAM GRILL METHOD: rounds on a design tree.');
    const { h, provider } = await boot(file);
    await grill(h);

    const instructions = (provider.turns.at(-1)?.instructions ?? []).join('\n');
    expect(instructions).toContain('UPSTREAM GRILL METHOD');
    expect(h.store.agentThreads.get(OWNER, 'dm-1')?.grilling).toBe(true);
    h.close();
  });
});
