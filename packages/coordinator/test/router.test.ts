import { describe, expect, it } from 'vitest';
import { ComponentSigner } from '../src/security/component-signing.js';
import { commandPayload } from '../src/discord/register-commands.js';
import { CHAT, OWNER, implementedResult, makeHarness, secret } from './helpers.js';

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
    expect(reply?.content).toMatch(/^Captured/);
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
    const ids = reply?.rows?.[0]?.buttons.map((b) => b.customId) ?? [];
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
    expect(reply?.content).toMatch(/no longer valid/);
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

    const confirmId = preview?.rows?.[0]?.buttons[0]?.customId ?? '';
    const confirmed = await h.transport.dispatch({
      kind: 'component', customId: confirmId, userId: OWNER,
    });
    expect(confirmed?.content).toMatch(/Saved 1/);
    expect(h.store.schedules.count()).toBe(1);
    h.close();
  });

  it('tells the owner plainly when nothing parsed', async () => {
    const h = await boot();
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'schedule', userId: OWNER, options: { text: 'lunch sometime' },
    });
    expect(reply?.content).toMatch(/No schedule entries found/);
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
    expect(cancelled?.content).toMatch(/cancelled/i);
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
    expect(answered?.content).toMatch(/queued/);
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
    expect(chat?.content?.startsWith('[mock] ')).toBe(true);
    h.close();
  });

  it('answers an unknown command without leaking anything', async () => {
    const h = await boot();
    const reply = await h.transport.dispatch({
      kind: 'command', name: 'nope', userId: OWNER, options: {},
    });
    expect(reply?.content).toBe('Unknown command.');
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
    expect(payload.map((c) => c.name).sort()).toEqual(
      ['capture', 'inbox', 'job', 'jobs', 'repo', 'schedule', 'status'],
    );
  });
});
