import { describe, expect, it } from 'vitest';
import { MAX_OPEN_TASKS_PER_OWNER, TASK_PREVIEW_TTL_MS } from '@ducky/contracts';
import { CHAT, OWNER, TestClock, makeHarness, replyText } from './helpers.js';

const MANILA = 'Asia/Manila';
/** 2026-10-13 10:00 in Manila: the morning the owner pasted their own list. */
const START = '2026-10-13T02:00:00.000Z';
const PASTE = '1. ENG 30 Letters (October 13 11:59 PM)\n2. Speech 30 Letters (October 15)';

const flat = (m: unknown): string => JSON.stringify(m);

const boot = async () => {
  const clock = new TestClock(START, MANILA);
  const h = makeHarness({ clock });
  await h.transport.start((e) => h.app.router.handle(e));
  return { h, clock };
};

const paste = async (h: Awaited<ReturnType<typeof boot>>['h'], text = PASTE) =>
  h.transport.dispatch({
    kind: 'message', userId: OWNER, text, threadKey: 'dm-1',
  } as never);

const buttonsOf = (reply: { rows?: readonly { buttons: readonly { label: string; customId: string }[] }[] } | undefined) =>
  Object.fromEntries((reply?.rows?.[0]?.buttons ?? []).map((b) => [b.label, b.customId]));

describe('pasting a list into Discord', () => {
  it('previews both of the owner’s own lines and saves nothing yet', async () => {
    const { h } = await boot();
    const reply = await paste(h);

    const body = flat(reply);
    expect(body).toContain('ENG 30 Letters');
    expect(body).toContain('October 13, 11:59 PM');
    expect(body).toContain('Speech 30 Letters');
    expect(body).toContain('October 15');
    expect(body).toContain('Nothing is saved yet');
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('shows no timezone label and no reminder schedule line', async () => {
    const { h } = await boot();
    const body = flat(await paste(h));
    expect(body).not.toMatch(/manila|utc|gmt|\+08/i);
    expect(body).not.toMatch(/reminder: 1 hour/i);
    h.close();
  });

  it('offers real Save, Edit and Discard buttons rather than words to type', async () => {
    const { h } = await boot();
    const labels = Object.keys(buttonsOf(await paste(h)));
    expect(labels).toEqual(['Save tasks', 'Edit', 'Discard']);
    h.close();
  });

  it('saves on Save, with the deadlines it previewed', async () => {
    const { h } = await boot();
    const controls = buttonsOf(await paste(h));
    const saved = await h.transport.dispatch({
      kind: 'component', customId: controls['Save tasks']!, userId: OWNER,
    } as never);

    expect(replyText(saved)).toMatch(/Saved 2 task/);
    const tasks = h.app.tasks.list(h.owner, 'all');
    expect(tasks.map((t) => t.title).sort()).toEqual(['ENG 30 Letters', 'Speech 30 Letters']);
    const eng = tasks.find((t) => t.title.startsWith('ENG'))!;
    expect(eng.dueAllDay).toBe(false);
    expect(eng.dueAt).toBe('2026-10-13T15:59:00.000Z');
    const speech = tasks.find((t) => t.title.startsWith('Speech'))!;
    expect(speech.dueAllDay).toBe(true);
    h.close();
  });

  it('is idempotent: a double press saves the same tasks, not a second set', async () => {
    const { h } = await boot();
    const controls = buttonsOf(await paste(h));
    const first = await h.transport.dispatch({
      kind: 'component', customId: controls['Save tasks']!, userId: OWNER,
    } as never);
    const second = await h.transport.dispatch({
      kind: 'component', customId: controls['Save tasks']!, userId: OWNER,
    } as never);

    expect(replyText(first)).toMatch(/^Saved 2 task/);
    expect(replyText(second)).toMatch(/Already saved/);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(2);
    h.close();
  });

  it('discards without saving, and a later Save on that preview refuses', async () => {
    const { h } = await boot();
    const controls = buttonsOf(await paste(h));
    const discarded = await h.transport.dispatch({
      kind: 'component', customId: controls['Discard']!, userId: OWNER,
    } as never);
    expect(replyText(discarded)).toMatch(/Discarded/);

    const late = await h.transport.dispatch({
      kind: 'component', customId: controls['Save tasks']!, userId: OWNER,
    } as never);
    expect(replyText(late)).toMatch(/discarded/i);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('re-parses an edit through the same grammar and still saves nothing', async () => {
    const { h } = await boot();
    const controls = buttonsOf(await paste(h));
    const corrected = await h.transport.dispatch({
      kind: 'component',
      customId: controls['Edit']!,
      userId: OWNER,
      values: { items: '1. ENG 30 Letters (October 14 11:59 PM)' },
    } as never);

    expect(flat(corrected)).toContain('October 14, 11:59 PM');
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);

    const save = buttonsOf(corrected)['Save tasks']!;
    await h.transport.dispatch({ kind: 'component', customId: save, userId: OWNER } as never);
    const tasks = h.app.tasks.list(h.owner, 'all');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.dueAt).toBe('2026-10-14T15:59:00.000Z');
    h.close();
  });

  it('pre-fills the edit with what it read when no text comes back', async () => {
    const { h } = await boot();
    const controls = buttonsOf(await paste(h));
    const opened = await h.transport.dispatch({
      kind: 'component', customId: controls['Edit']!, userId: OWNER,
    } as never);
    expect(replyText(opened)).toContain('1. ENG 30 Letters (October 13, 11:59 PM)');
    h.close();
  });

  it('asks for clarification instead of guessing an ambiguous date', async () => {
    const { h } = await boot();
    const reply = await paste(h, '1. ENG Letters (10/13)\n2. Speech (October 15)');
    const text = replyText(reply);
    expect(text).toMatch(/Nothing was saved/);
    expect(text).toMatch(/Line 1/);
    expect(text).toMatch(/will not guess/i);
    expect(reply?.rows ?? []).toHaveLength(0);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('leaves ordinary conversation alone', async () => {
    const { h } = await boot();
    const reply = await h.transport.dispatch({
      kind: 'message', userId: OWNER, text: 'what is on today?', threadKey: 'dm-1',
    } as never);
    expect(flat(reply)).not.toContain('Nothing is saved yet');
    h.close();
  });

  it('never reads a quoted list or a notification as tasks', async () => {
    const { h } = await boot();
    const quoted = await h.transport.dispatch({
      kind: 'message',
      userId: OWNER,
      text: '> 1. ENG 30 Letters (October 13 11:59 PM)\n> 2. Speech 30 Letters (October 15)',
      threadKey: 'dm-1',
    } as never);
    expect(flat(quoted)).not.toContain('Nothing is saved yet');
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('refuses a non-owner outright: a pasted list is a WRITE', async () => {
    const { h } = await boot();
    const reply = await h.transport.dispatch({
      kind: 'message', userId: CHAT, text: PASTE, threadKey: 'dm-2',
    } as never);
    // The chat whitelist gets conversation, exactly as before. No preview.
    expect(flat(reply)).not.toContain('Nothing is saved yet');
    expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM task_previews').get()).toEqual({ n: 0 });
    h.close();
  });

  it('refuses a Save control pressed by somebody else', async () => {
    const { h } = await boot();
    const controls = buttonsOf(await paste(h));
    const refused = await h.transport.dispatch({
      kind: 'component', customId: controls['Save tasks']!, userId: CHAT,
    } as never);
    expect(replyText(refused)).toMatch(/not authorized/i);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });
});

describe('a shared channel is closed to pasted lists', () => {
  const SHARED = '900000000000000123';

  const bootShared = async () => {
    const clock = new TestClock(START, MANILA);
    const h = makeHarness({ clock, env: { DUCKY_DEV_SHARED_CHANNEL_IDS: SHARED } });
    await h.transport.start((e) => h.app.router.handle(e));
    return h;
  };

  const inChannel = async (h: Awaited<ReturnType<typeof bootShared>>, channelId: string) =>
    h.transport.dispatch({
      kind: 'message',
      userId: OWNER,
      text: PASTE,
      threadKey: channelId,
      context: { channelId, guildId: '900000000000000001' },
    } as never);

  it('shows no preview, stores nothing and leaves no control there', async () => {
    const h = await bootShared();
    const reply = await inChannel(h, SHARED);

    // Whatever conversation says, it is not a preview: no "nothing is saved
    // yet" card, no Save/Edit/Discard, and nothing written down.
    expect(flat(reply)).not.toContain('Nothing is saved yet');
    expect(reply?.rows ?? []).toHaveLength(0);
    expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM task_previews').get()).toEqual({ n: 0 });
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('still reads a list in an ordinary guild channel, so the guard is narrow', async () => {
    const h = await bootShared();
    const reply = await inChannel(h, '900000000000000999');
    expect(flat(reply)).toContain('Nothing is saved yet');
    expect(reply?.rows?.[0]?.buttons).toHaveLength(3);
    h.close();
  });

  it('still reads a list in a DM', async () => {
    const h = await bootShared();
    const reply = await h.transport.dispatch({
      kind: 'message', userId: OWNER, text: PASTE, threadKey: SHARED,
    } as never);
    // Same id, but no guild: a DM is never a shared channel, and the thread
    // key alone must not be read as one.
    expect(flat(reply)).toContain('Nothing is saved yet');
    h.close();
  });
});

describe('a save is all or nothing', () => {
  it('writes no task and no reminder when the batch would pass the open-task cap', async () => {
    const { h } = await boot();
    const preview = h.app.taskCapture.preview(h.owner, PASTE, 'phone');
    expect(preview.kind).toBe('preview');

    // One short of the ceiling, so a two-item batch cannot fit.
    h.store.db
      .prepare(
        `INSERT INTO tasks (id, public_id, discord_user_id, title, due_at, due_all_day,
           priority, status, created_at, updated_at)
         SELECT 'bulk-' || value, 't' || substr('00000' || value, -5), ?, 'filler', NULL, 0,
                'normal', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
           FROM (WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n
                 WHERE value < ?) SELECT value FROM n)`,
      )
      .run(OWNER, MAX_OPEN_TASKS_PER_OWNER - 1);

    const previewId = preview.kind === 'preview' ? preview.preview.previewId : '';
    expect(() => h.app.taskCapture.save(h.owner, previewId)).toThrow(/Nothing was saved/);
    expect(h.store.tasks.countOpen(OWNER)).toBe(MAX_OPEN_TASKS_PER_OWNER - 1);
    expect(h.store.reminders.countScheduled(OWNER)).toBe(0);

    // And the preview is still there to retry or edit, rather than consumed by
    // a failure the owner did not cause.
    expect(h.app.taskCapture.pendingPreview(h.owner, previewId)?.items).toHaveLength(2);
    h.close();
  });
});

describe('previews are bounded', () => {
  it('expires, and an expired one saves nothing', async () => {
    const { h, clock } = await boot();
    const preview = h.app.taskCapture.preview(h.owner, PASTE, 'phone');
    const previewId = preview.kind === 'preview' ? preview.preview.previewId : '';

    clock.advance(TASK_PREVIEW_TTL_MS + 1000);
    expect(() => h.app.taskCapture.save(h.owner, previewId)).toThrow(/no longer waiting/);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('is swept by the reconciler, so the table is bounded without retention', async () => {
    const { h, clock } = await boot();
    h.app.taskCapture.preview(h.owner, PASTE, 'phone');
    const count = () =>
      (h.store.db.prepare('SELECT COUNT(*) AS n FROM task_previews').get() as { n: number }).n;
    expect(count()).toBe(1);

    clock.advance(TASK_PREVIEW_TTL_MS + 1000);
    // The reconciler runs on the coordinator's existing interval and uses the
    // wall clock, so the row is aged in the database rather than on the clock.
    h.store.db
      .prepare('UPDATE task_previews SET expires_at = ?')
      .run(new Date(Date.now() - 60_000).toISOString());
    expect(h.app.reconciler.run().previewsSwept).toBe(1);
    expect(count()).toBe(0);
    h.close();
  });

  it('keeps no copy of the owner’s text once it is settled', async () => {
    const { h } = await boot();
    const preview = h.app.taskCapture.preview(h.owner, PASTE, 'phone');
    const previewId = preview.kind === 'preview' ? preview.preview.previewId : '';
    h.app.taskCapture.save(h.owner, previewId);

    const row = h.store.db
      .prepare('SELECT items_json, status FROM task_previews WHERE id = ?')
      .get(previewId) as { items_json: string | null; status: string };
    expect(row.status).toBe('saved');
    expect(row.items_json).toBeNull();
    h.close();
  });
});
