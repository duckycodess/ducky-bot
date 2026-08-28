import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORGET_TARGETS, OWNER_ONLY_COMMANDS, OWNER_ONLY_INTERACTION_KINDS, SHARED_READABLE_ROUTES,
  isDuckyError, isSharedReadableRoute,
} from '@ducky/contracts';
import { nowIso } from '@ducky/persistence';
import { makeHarness } from './helpers.js';

/**
 * The owner's deletion controls.
 *
 * Deletion is irreversible, so most of what follows is about scope: that the
 * command can only ever name ONE entity, that a stranger cannot reach it, and
 * that an id which does not belong to the owner is answered exactly like one
 * that does not exist.
 */
const iso = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();

function seedJob(
  h: ReturnType<typeof makeHarness>,
  id: string,
  opts: { owner?: string; state?: string } = {},
): string {
  const at = iso(1);
  h.store.db.prepare(
    `INSERT INTO jobs (id, public_id, discord_user_id, repo_slug, task, context, bootstrap,
       state, max_attempts, max_owner_input_rounds, created_at, updated_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, `p-${id}`, opts.owner ?? h.owner.discordUserId, 'demo', 'secret task text', null, 0,
    opts.state ?? 'completed', 3, 3, at, at, opts.state === 'running' ? null : at,
  );
  h.store.db.prepare(
    `INSERT INTO job_events (job_id, seq, kind, message_redacted, created_at) VALUES (?,?,?,?,?)`,
  ).run(id, 1, 'submitted', 'queued', at);
  return `p-${id}`;
}

describe('/forget job', () => {
  it('deletes one job and its child rows', () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1');

    const out = h.app.forget.forgetJob(h.owner, publicId);
    expect(out.deleted).toBe(true);
    expect(out.rowsDeleted).toBeGreaterThan(1);
    expect((h.store.db.prepare('SELECT count(*) c FROM jobs').get() as { c: number }).c).toBe(0);
    expect((h.store.db.prepare('SELECT count(*) c FROM job_events').get() as { c: number }).c).toBe(0);
    h.close();
  });

  it('deletes ONLY the named job', () => {
    const h = makeHarness();
    const keep = seedJob(h, 'keep');
    const go = seedJob(h, 'go');
    h.app.forget.forgetJob(h.owner, go);

    expect(h.store.jobs.byPublicId(keep)).toBeDefined();
    expect(h.store.jobs.byPublicId(go)).toBeUndefined();
    h.close();
  });

  it('refuses a chat user and a stranger at the SERVICE layer', () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1');

    for (const actor of [h.chat, h.stranger]) {
      const err = (() => {
        try {
          h.app.forget.forgetJob(actor, publicId);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(isDuckyError(err) && err.code).toBe('unauthorized');
    }
    // Nothing was deleted by either attempt.
    expect(h.store.jobs.byPublicId(publicId)).toBeDefined();
    h.close();
  });

  it('answers an unknown id and somebody else s id identically', () => {
    const h = makeHarness();
    const foreign = seedJob(h, 'foreign', { owner: '999000000000000999' });

    const unknown = h.app.forget.forgetJob(h.owner, 'p-nope');
    const other = h.app.forget.forgetJob(h.owner, foreign);

    expect(unknown.refusal).toBe('unknown_job');
    expect(other.refusal).toBe('unknown_job');
    expect(other.message).toBe(unknown.message);
    // And the foreign job is still there.
    expect(h.store.jobs.byPublicId(foreign)).toBeDefined();
    h.close();
  });

  it('refuses a job that has not finished', () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1', { state: 'running' });
    const out = h.app.forget.forgetJob(h.owner, publicId);
    expect(out.deleted).toBe(false);
    expect(out.refusal).toBe('job_still_running');
    h.close();
  });

  it('refuses a job whose workspace is still open, and says why', () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1');
    h.store.db.prepare(
      `INSERT INTO herdr_workspaces (workspace_id, repo_slug, job_id, label, mode, agent_name, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('w1', 'demo', 'j1', 'ducky-mgd:demo', 'worktree', 'ducky-pi-demo', nowIso());

    const out = h.app.forget.forgetJob(h.owner, publicId);
    expect(out.refusal).toBe('workspace_open');
    expect(out.message).toMatch(/may contain work/i);
    h.close();
  });

  it('refuses an empty id rather than guessing', () => {
    const h = makeHarness();
    expect(() => h.app.forget.forgetJob(h.owner, '   ')).toThrow(/Which job/i);
    h.close();
  });

  it('records the deletion with COUNTS and never the content', () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1');
    h.app.forget.forgetJob(h.owner, publicId);

    const rows = h.store.auditLog.recent(20).filter((r) => r.event === 'data.deleted');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('ok');
    expect(rows[0]!.subjectRef).toBe(publicId);
    expect(rows[0]!.actorRef).toBe('owner');
    expect(rows[0]!.detail).toMatch(/child rows \d+/);
    // The task text must not survive in the record of its own deletion.
    expect(rows[0]!.detail).not.toContain('secret task text');
    h.close();
  });

  it('records a refusal too', () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1', { state: 'running' });
    h.app.forget.forgetJob(h.owner, publicId);
    const rows = h.store.auditLog.recent(20).filter((r) => r.event === 'data.deleted');
    expect(rows[0]!.outcome).toBe('refused');
    h.close();
  });

  it('leaves no foreign key violation', () => {
    const h = makeHarness();
    h.app.forget.forgetJob(h.owner, seedJob(h, 'j1'));
    expect(h.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    h.close();
  });
});

describe('/forget conversation', () => {
  it('says plainly that nothing is stored while continuity is off', () => {
    // Continuity defaults to off, so this is the shipped behaviour. The wording
    // no longer claims there is no table -- there is one, and ADR 0021 explains
    // why -- it says the honest thing: nothing was stored.
    const h = makeHarness();
    const out = h.app.forget.forgetConversation(h.owner);
    expect(out.turnsDeleted).toBe(0);
    expect(out.message).toMatch(/nothing to forget/i);
    expect(out.message).toMatch(/continuity is off/i);
    h.close();
  });

  it('deletes stored turns and reports the count when there are some', () => {
    const h = makeHarness({ env: { DUCKY_CONVERSATION_MEMORY_ENABLED: 'true' } });
    h.store.conversations.append({
      id: 'turn-1', discordUserId: h.owner.discordUserId, threadKey: 'dm-1',
      role: 'user', content: 'something said', rowCap: 200,
    });

    const out = h.app.forget.forgetConversation(h.owner);

    expect(out.turnsDeleted).toBe(1);
    expect(out.message).toMatch(/Deleted 1 stored conversation turn/);
    h.close();
  });

  it('is owner-only as well', () => {
    const h = makeHarness();
    expect(() => h.app.forget.forgetConversation(h.chat)).toThrow();
    h.close();
  });
});

describe('there is no wipe-all path', () => {
  it('the contract cannot express one', () => {
    expect([...FORGET_TARGETS]).toEqual([
      'job', 'conversation', 'capture', 'task', 'reminder', 'schedule',
    ]);
    // Every one of those names ONE record, or one person's own conversation.
    expect(FORGET_TARGETS as readonly string[]).not.toContain('all');
    expect(FORGET_TARGETS as readonly string[]).not.toContain('everything');
  });

  it('the service exposes no bulk method and no method without an id', () => {
    // Scanned with comments STRIPPED: the prose deliberately says "wipe-all" to
    // explain what this class refuses to be, and that must not read as one.
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'forget.service.ts'),
      'utf8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    for (const forbidden of ['forgetAll', 'deleteAll', 'purge', 'wipe', 'truncate']) {
      expect(code.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
    // Every job deletion goes through the shared guarded path.
    expect(code).toContain('deleteJobUnitGuarded');
  });

  it('every deletion names exactly one job id', () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'forget.service.ts'),
      'utf8',
    );
    // No `IN (`, no loop over ids, no wildcard.
    expect(src).not.toMatch(/for \(const .* of .*jobs/i);
    expect(src).not.toMatch(/listRecent|listByState/);
  });
});

/**
 * The router surface.
 *
 * `/forget` is a WRITE, and the most consequential one, so it must be on the
 * owner-only manifest and must never be shared-readable. The command shows what
 * will go and returns a signed control; only pressing it deletes.
 */
describe('the /forget route', () => {
  const dispatch = async (h: ReturnType<typeof makeHarness>, options: Record<string, unknown>, userId?: string) => {
    await h.transport.start((e) => h.app.router.handle(e));
    return h.transport.dispatch({
      kind: 'command',
      name: 'forget',
      userId: userId ?? h.owner.discordUserId,
      options,
    } as never);
  };

  it('is on the owner-only manifest and is not shared-readable', () => {
    expect([...OWNER_ONLY_COMMANDS]).toContain('forget');
    expect([...OWNER_ONLY_INTERACTION_KINDS]).toContain('forget_confirm');
    for (const route of SHARED_READABLE_ROUTES) {
      expect(route.command).not.toBe('forget');
    }
    expect(isSharedReadableRoute('forget')).toBe(false);
    expect(isSharedReadableRoute('forget', 'job')).toBe(false);
  });

  it('does not delete on the command alone; it offers a signed control', async () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1');

    const reply = await dispatch(h, { target: 'job', id: publicId });
    expect(reply?.content).toMatch(/cannot be undone/i);
    expect(reply?.ephemeral).toBe(true);
    expect(reply?.rows?.[0]?.buttons?.[0]?.style).toBe('danger');
    // Still there: showing is not deleting.
    expect(h.store.jobs.byPublicId(publicId)).toBeDefined();
    h.close();
  });

  it('deletes when the signed control is pressed', async () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1');
    const reply = await dispatch(h, { target: 'job', id: publicId });
    const customId = reply!.rows![0]!.buttons![0]!.customId;

    const confirmed = await h.transport.dispatch({
      kind: 'component', customId, userId: h.owner.discordUserId,
    } as never);
    expect(confirmed?.content).toMatch(/Deleted job/);
    expect(h.store.jobs.byPublicId(publicId)).toBeUndefined();
    h.close();
  });

  it("a stranger cannot reuse the owner's control", async () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1');
    const reply = await dispatch(h, { target: 'job', id: publicId });
    const customId = reply!.rows![0]!.buttons![0]!.customId;

    const stolen = await h.transport.dispatch({
      kind: 'component', customId, userId: h.stranger.discordUserId,
    } as never);
    expect(stolen?.content).not.toMatch(/Deleted job/);
    expect(h.store.jobs.byPublicId(publicId)).toBeDefined();
    h.close();
  });

  it('refuses the command for a non-owner without naming the job', async () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1');
    const reply = await dispatch(h, { target: 'job', id: publicId }, h.stranger.discordUserId);
    expect(reply?.content).not.toContain(publicId);
    expect(h.store.jobs.byPublicId(publicId)).toBeDefined();
    h.close();
  });

  it('answers /forget conversation without a control, since nothing is stored', async () => {
    const h = makeHarness();
    const reply = await dispatch(h, { target: 'conversation' });
    expect(reply?.content).toMatch(/nothing to forget/i);
    expect(reply?.rows ?? []).toHaveLength(0);
    h.close();
  });

  it('lists candidates rather than guessing an id, and deletes nothing', async () => {
    const h = makeHarness();
    const publicId = seedJob(h, 'j1');

    const reply = await dispatch(h, { target: 'job' });

    // A READ: ids to type, no delete buttons -- a row of delete buttons is how
    // somebody removes the wrong thing.
    expect(JSON.stringify(reply?.embeds ?? [])).toContain(publicId);
    expect(reply?.rows ?? []).toHaveLength(0);
    expect(h.store.jobs.byPublicId(publicId)).toBeDefined();
    h.close();
  });

  it('refuses a target it does not know', async () => {
    const h = makeHarness();
    const reply = await dispatch(h, { target: 'everything' });
    expect(reply?.content).toMatch(/Choose one of/);
    h.close();
  });
});

/**
 * Per-record deletion for everything that is not a job.
 *
 * Same rules as a job, minus the guards a job needs: a capture, a task, a
 * reminder and a schedule entry cannot be "live" in a way that makes deletion
 * destructive, so there is nothing to refuse for.
 */
describe('per-record deletion', () => {
  const press = async (
    h: ReturnType<typeof makeHarness>,
    target: string,
    id: string,
    userId?: string,
  ) => {
    await h.transport.start((e) => h.app.router.handle(e));
    const shown = await h.transport.dispatch({
      kind: 'command', name: 'forget', userId: h.owner.discordUserId,
      options: { target, id },
    } as never);
    const customId = shown?.rows?.[0]?.buttons?.[0]?.customId;
    if (!customId) return { shown, confirmed: undefined };
    const confirmed = await h.transport.dispatch({
      kind: 'component', customId, userId: userId ?? h.owner.discordUserId,
    } as never);
    return { shown, confirmed };
  };

  it('deletes one task the owner named, and nothing else', async () => {
    const h = makeHarness();
    const keep = h.app.tasks.add(h.owner, { title: 'keep me' });
    const doomed = h.app.tasks.add(h.owner, { title: 'delete me' });

    const { shown, confirmed } = await press(h, 'task', doomed.publicId);

    expect(shown?.content).toMatch(/cannot be undone/i);
    expect(confirmed?.content).toMatch(/Deleted that task/);
    expect(h.store.tasks.byPublicId(h.owner.discordUserId, doomed.publicId)).toBeUndefined();
    expect(h.store.tasks.byPublicId(h.owner.discordUserId, keep.publicId)).toBeDefined();
    h.close();
  });

  it('takes a reminder’s occurrence outbox with it, child-first', async () => {
    const h = makeHarness();
    const rem = h.app.reminders.add(h.owner, { text: 'stand up', at: 'tomorrow 09:00' });
    const row = h.store.reminders.byPublicId(h.owner.discordUserId, rem.publicId)!;
    h.store.db
      .prepare(
        `INSERT INTO reminder_occurrences
           (id, reminder_id, occurrence_no, scheduled_for, missed_count, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run('occ-1', row.id, 1, nowIso(), 0, nowIso());

    const { confirmed } = await press(h, 'reminder', rem.publicId);

    expect(confirmed?.content).toMatch(/Deleted that reminder \(2 rows\)/);
    expect(h.store.reminders.byPublicId(h.owner.discordUserId, rem.publicId)).toBeUndefined();
    const left = h.store.db
      .prepare('SELECT count(*) c FROM reminder_occurrences')
      .get() as { c: number };
    expect(left.c).toBe(0);
    h.close();
  });

  it('deletes a capture by the id prefix the inbox already shows', async () => {
    const h = makeHarness();
    const row = h.app.captures.create(h.owner, 'a private thought');

    const { confirmed } = await press(h, 'capture', row.id.slice(0, 8));

    expect(confirmed?.content).toMatch(/Deleted that capture/);
    expect(h.store.captures.get(row.id)).toBeUndefined();
    h.close();
  });

  it('deletes one schedule entry', async () => {
    const h = makeHarness();
    h.store.db
      .prepare(
        `INSERT INTO schedules (id, discord_user_id, title, starts_at, source_kind, confirmed_at, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run('sched-abc12345', h.owner.discordUserId, 'standup', '2026-01-01 09:00', 'text', nowIso(), nowIso());

    const { confirmed } = await press(h, 'schedule', 'sched-ab');

    expect(confirmed?.content).toMatch(/Deleted that schedule entry/);
    const left = h.store.db.prepare('SELECT count(*) c FROM schedules').get() as { c: number };
    expect(left.c).toBe(0);
    h.close();
  });

  it('answers an id that is not the owner’s exactly like one that does not exist', async () => {
    const h = makeHarness();
    // A task belonging to somebody else.
    h.store.tasks.insert({
      id: 'task-other', publicId: 'tzzzzz', discordUserId: h.stranger.discordUserId,
      title: 'not yours', dueAt: null, dueAllDay: false, priority: 'normal',
      createdAt: nowIso(),
    });

    const mine = h.app.forget.previewEntity(h.owner, 'task', 'tzzzzz');
    const absent = h.app.forget.previewEntity(h.owner, 'task', 'tqqqqq');

    expect(mine.found).toBe(false);
    expect(absent.found).toBe(false);
    expect((mine as { message: string }).message).toBe((absent as { message: string }).message);
    h.close();
  });

  it('refuses an ambiguous prefix rather than picking one', async () => {
    const h = makeHarness();
    for (const id of ['dupe1111-a', 'dupe1111-b']) {
      h.store.db
        .prepare(
          `INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at)
           VALUES (?,?,?,'open',?,?)`,
        )
        .run(id, h.owner.discordUserId, 'text', nowIso(), nowIso());
    }

    const preview = h.app.forget.previewEntity(h.owner, 'capture', 'dupe1111');

    expect(preview.found).toBe(false);
    expect((preview as { message: string }).message).toMatch(/More than one/);
    const left = h.store.db.prepare('SELECT count(*) c FROM captures').get() as { c: number };
    expect(left.c).toBe(2);
    h.close();
  });

  it('is owner-only, and a stranger cannot press the owner’s control', async () => {
    const h = makeHarness();
    const task = h.app.tasks.add(h.owner, { title: 'mine' });

    expect(() => h.app.forget.forgetEntity(h.chat, 'task', task.publicId)).toThrow();
    const { confirmed } = await press(h, 'task', task.publicId, h.stranger.discordUserId);
    expect(confirmed?.content).not.toMatch(/Deleted that task/);
    expect(h.store.tasks.byPublicId(h.owner.discordUserId, task.publicId)).toBeDefined();
    h.close();
  });

  it('audits every per-record deletion by count, never by content', async () => {
    const h = makeHarness();
    const task = h.app.tasks.add(h.owner, { title: 'a very distinctive title' });

    h.app.forget.forgetEntity(h.owner, 'task', task.publicId);

    const rows = h.store.db
      .prepare("SELECT subject_ref, detail FROM audit_log WHERE event = 'data.deleted'")
      .all() as { subject_ref: string; detail: string }[];
    expect(rows.some((r) => r.subject_ref === `task:${task.publicId}`)).toBe(true);
    for (const r of rows) {
      expect(r.detail).not.toContain('distinctive');
      expect(r.detail).toMatch(/^rows \d+$/);
    }
    h.close();
  });
});
