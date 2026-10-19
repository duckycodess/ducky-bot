import { controlId } from '../src/discord/message.js';
import { describe, expect, it } from 'vitest';
import {
  OWNER_ONLY_COMMANDS, OWNER_ONLY_INTERACTION_KINDS, SHARED_READABLE_ROUTES,
  isSharedReadableRoute,
} from '@ducky/contracts';
import { ComponentSigner } from '../src/security/component-signing.js';
import { commandPayload } from '../src/discord/register-commands.js';
import { CHAT, OWNER, implementedResult, makeHarness, secret, replyText } from './helpers.js';

const flat = (m: unknown): string => JSON.stringify(m);

describe('command routing', () => {
  const boot = async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    return h;
  };

  it('captures without echoing the content back', async () => {
    const h = await boot();
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'capture', userId: OWNER, options: { text: 'remember the milk' },
    });
    expect(replyText(reply)).toMatch(/^Captured/);
    expect(flat(reply)).not.toContain('remember the milk');
    expect(h.app.captures.list(h.owner)).toHaveLength(1);
    h.close();
  });

  it('lists the inbox with signed, owner-bound controls', async () => {
    const h = await boot();
    h.app.captures.create(h.owner, 'a note');
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'inbox', userId: OWNER, options: {},
    });
    const ids = reply?.rows?.[0]?.buttons.map(controlId) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(100);
    h.close();
  });

  it('refuses a component id signed for a different user', async () => {
    const h = await boot();
    const capture = h.app.captures.create(h.owner, 'a note');
    const foreign = new ComponentSigner(secret());
    const forged = foreign.sign({ kind: 'inbox_done', entityId: capture.id, actorUserId: OWNER });
    const reply = await h.transport.dispatch({ kind: 'component', customId: forged, userId: OWNER });
    expect(replyText(reply)).toMatch(/no longer valid/);
    expect(h.app.captures.list(h.owner)[0]?.status).toBe('open');
    h.close();
  });

  it('previews a schedule without saving, then saves on confirm', async () => {
    const h = await boot();
    const preview = await h.transport.dispatch({
      kind: 'command', name: 'schedule', userId: OWNER,
      options: { text: '2026-09-01 09:00 | Standup | Room 3' },
    });
    expect(flat(preview)).toContain('Nothing is saved yet');
    expect(h.store.schedules.count()).toBe(0);

    const confirmId = controlId(preview?.rows?.[0]?.buttons[0]);
    const confirmed = await h.transport.dispatch({
      kind: 'component', customId: confirmId, userId: OWNER,
    });
    expect(replyText(confirmed)).toMatch(/Saved 1/);
    expect(h.store.schedules.count()).toBe(1);
    h.close();
  });

  it('tells the owner plainly when nothing parsed', async () => {
    const h = await boot();
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'schedule', userId: OWNER, options: { text: 'lunch sometime' },
    });
    expect(replyText(reply)).toMatch(/No schedule entries found/);
    expect(reply?.embeds).toBeUndefined();
    h.close();
  });

  it('submits, reports and cancels a job', async () => {
    const h = await boot();
    const submitted = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'submit', userId: OWNER,
      options: { repo: 'demo', task: 'do the thing' },
    });
    const publicId = /`(j[0-9a-z]{5})`/.exec(submitted?.content ?? '')?.[1] ?? '';
    expect(publicId).not.toBe('');

    const status = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'status', userId: OWNER, options: { id: publicId },
    });
    expect(flat(status)).toContain(publicId);

    const cancelled = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'cancel', userId: OWNER, options: { id: publicId },
    });
    expect(replyText(cancelled)).toMatch(/cancelled/i);
    h.close();
  });

  it('offers an Answer control while a job waits for the owner', async () => {
    const h = await boot();
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = h.app.jobs.claim(h.executorId, 'k1')!;
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'which db?', proposedActions: [] }),
      400,
    );
    const status = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'status', userId: OWNER, options: { id: job.publicId },
    });
    expect(flat(status)).toContain('Answer');

    const answered = await h.transport.dispatch({
      kind: 'command', name: 'job', subcommand: 'answer', userId: OWNER,
      options: { id: job.publicId, answer: 'sqlite' },
    });
    expect(replyText(answered)).toMatch(/queued/);
    h.close();
  });

  it('reports which providers are live, and marks mock conversation', async () => {
    const h = await boot();
    const status = await h.transport.dispatch({
      kind: 'command', name: 'status', userId: OWNER, options: {},
    });
    const text = flat(status);
    expect(text).toContain('mock');
    expect(text).toContain('experimental');
    expect(text).toContain('recorded, not executed');

    const chat = await h.transport.dispatch({
      kind: 'message', userId: CHAT, text: 'hi', threadKey: 't',
    });
    // A stand-in reply keeps its marker wherever it is rendered.
    expect(replyText(chat).startsWith('[mock] ')).toBe(true);
    h.close();
  });

  it('answers an unknown command without leaking anything', async () => {
    const h = await boot();
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'nope', userId: OWNER, options: {},
    });
    expect(replyText(reply)).toBe('Unknown command.');
    h.close();
  });

  it('enforces per-user command budgets', async () => {
    const h = await boot();
    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      const reply = await h.transport.dispatch({
        kind: 'command', name: 'capture', userId: OWNER, options: { text: `note ${i}` },
      });
      if (/Too many requests/.test(reply?.content ?? '')) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    h.close();
  });
});

describe('command registration', () => {
  it('defines every owner-only command and never registers at boot', () => {
    const payload = commandPayload() as { name: string }[];
    // Derived from the manifest rather than restated: a new owner-only
    // command must be DEFINED here as well as routed, and neither list may
    // grow a name the other does not have.
    expect(payload.map((c) => c.name).sort()).toEqual([...OWNER_ONLY_COMMANDS].sort());
  });
});

describe('the owner controls for imported parity state add no command and no interaction kind', () => {
  type Opt = { name: string; type: number; required?: boolean; choices?: { value: string }[]; options?: Opt[] };
  const command = (name: string) => (commandPayload() as { name: string; options?: Opt[] }[]).find((c) => c.name === name)!;

  it('/watch gains one subcommand with an explicit on/off choice, and /schedule one optional string', () => {
    const watch = command('watch').options!;
    expect(watch.map((o) => o.name)).toEqual(['add', 'list', 'remove', 'monitoring']);
    const monitoring = watch.find((o) => o.name === 'monitoring')!;
    expect(monitoring.type).toBe(1);
    expect(monitoring.options).toEqual([expect.objectContaining({
      name: 'state', type: 3, required: true, choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }],
    })]);
    const schedule = command('schedule').options!;
    expect(schedule.map((o) => [o.name, o.type, o.required])).toEqual([
      ['text', 3, false], ['file', 11, false], ['rollback', 3, false],
    ]);
    // No subcommand on /schedule: the text and file flow keeps its shape.
    expect(schedule.some((o) => o.type === 1)).toBe(false);
  });

  it('leaves both manifests exactly as they were', () => {
    expect([...OWNER_ONLY_COMMANDS]).toHaveLength(12);
    expect(OWNER_ONLY_INTERACTION_KINDS as readonly string[]).not.toContain('schedule_rollback');
    expect(OWNER_ONLY_INTERACTION_KINDS as readonly string[]).not.toContain('watch_monitoring');
    expect(SHARED_READABLE_ROUTES.map((r) => `${r.command}/${r.subcommand ?? ''}`)).toEqual(['jobs/', 'job/status']);
    expect(isSharedReadableRoute('watch', 'monitoring')).toBe(false);
    expect(isSharedReadableRoute('schedule')).toBe(false);
  });
});

describe('the new task controls are privileged, and only that', () => {
  it('is on the owner-only interaction manifest, every one of them', () => {
    for (const kind of ['task_edit', 'task_snooze', 'bulk_save', 'bulk_edit', 'bulk_discard']) {
      expect(OWNER_ONLY_INTERACTION_KINDS as readonly string[], kind).toContain(kind);
    }
  });

  it('is never shared-readable: a card in a channel grants nobody anything', () => {
    for (const kind of OWNER_ONLY_INTERACTION_KINDS) {
      expect(isSharedReadableRoute(kind), kind).toBe(false);
    }
    // And the shared surface still names exactly the two READS it always did.
    expect(SHARED_READABLE_ROUTES.map((r) => `${r.command}/${r.subcommand ?? ''}`)).toEqual([
      'jobs/', 'job/status',
    ]);
  });

  it('adds no slash command: the command manifest is unchanged', () => {
    const h = makeHarness();
    expect(h.app.router.registeredCommands()).toEqual([...OWNER_ONLY_COMMANDS].sort());
    h.close();
  });

  it('registers every one of them in the router', () => {
    const h = makeHarness();
    const kinds = h.app.router.registeredComponentKinds();
    for (const kind of ['task_edit', 'task_snooze', 'bulk_save', 'bulk_edit', 'bulk_discard']) {
      expect(kinds, kind).toContain(kind);
    }
    h.close();
  });
});

describe('schedule corrections', () => {
  const SCHEDULE = '2026-09-01 09:00 | Standup | Room 3';

  const boot = async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    return h;
  };

  const previewIds = async (h: Awaited<ReturnType<typeof boot>>) => {
    const preview = await h.transport.dispatch({
      kind: 'command', name: 'schedule', userId: OWNER, options: { text: SCHEDULE },
    });
    const buttons = preview?.rows?.[0]?.buttons ?? [];
    return {
      confirm: controlId(buttons.find((b) => /Confirm/.test(b.label))),
      edit: controlId(buttons.find((b) => /Correct/.test(b.label))),
    };
  };

  it('offers a correction control on the preview', async () => {
    const h = await boot();
    const ids = await previewIds(h);
    expect(ids.edit).toBeDefined();
    expect(ids.confirm).toBeDefined();
    h.close();
  });

  it('pre-fills the current entries when the modal is opened', async () => {
    const h = await boot();
    const ids = await previewIds(h);
    const opened = await h.transport.dispatch({
      kind: 'component', customId: ids.edit, userId: OWNER,
    });
    expect(replyText(opened)).toContain('Standup');
    expect(h.store.schedules.count()).toBe(0);
    h.close();
  });

  it('re-parses a correction and still saves nothing until confirmed', async () => {
    const h = await boot();
    const ids = await previewIds(h);

    const corrected = await h.transport.dispatch({
      kind: 'component',
      customId: ids.edit,
      userId: OWNER,
      values: { entries: '2026-09-02 10:00 | Daily standup | Room 9' },
    });
    expect(flat(corrected)).toContain('Daily standup');
    expect(h.store.schedules.count()).toBe(0);

    await h.transport.dispatch({ kind: 'component', customId: ids.confirm, userId: OWNER });
    const saved = h.app.schedules.list(h.app.authz.actor(OWNER));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.title).toBe('Daily standup');
    h.close();
  });

  it('reports plainly when a correction parses to nothing', async () => {
    const h = await boot();
    const ids = await previewIds(h);
    const out = await h.transport.dispatch({
      kind: 'component', customId: ids.edit, userId: OWNER, values: { entries: 'nonsense' },
    });
    expect(replyText(out)).toMatch(/No schedule entries found/);
    expect(h.store.schedules.count()).toBe(0);
    h.close();
  });

  it('refuses a correction from a non-owner', async () => {
    const h = await boot();
    const ids = await previewIds(h);
    const out = await h.transport.dispatch({
      kind: 'component', customId: ids.edit, userId: CHAT, values: { entries: 'x' },
    });
    expect(replyText(out)).toMatch(/not authorized/i);
    h.close();
  });
});

describe('transport selection', () => {
  it('uses the mock transport when no token is configured', () => {
    const h = makeHarness();
    expect(h.app.transport.kind).toBe('mock');
    expect(h.app.status().discord).toMatch(/mock/);
    h.close();
  });

  it('uses the real transport as soon as the selected profile has a token', () => {
    const h = makeHarness(
      {
        env: {
          DISCORD_DEV_TOKEN: 'placeholder-not-a-real-token',
          DISCORD_DEV_APP_ID: '100000000000000009',
          DISCORD_DEV_GUILD_ID: '100000000000000010',
        },
      },
      true,
    );
    expect(h.app.transport.kind).toBe('real');
    expect(h.app.status().discord).toMatch(/real \(development bot, guild commands\)/);
    h.close();
  });
});
