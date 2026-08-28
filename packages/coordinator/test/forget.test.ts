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
  it('says plainly that nothing is stored', () => {
    const h = makeHarness();
    const out = h.app.forget.forgetConversation(h.owner);
    expect(out.message).toMatch(/nothing to forget/i);
    expect(out.message).toMatch(/no transcript table/i);
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
    expect([...FORGET_TARGETS]).toEqual(['job', 'conversation']);
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

  it('asks for an id rather than guessing one', async () => {
    const h = makeHarness();
    const reply = await dispatch(h, { target: 'job' });
    expect(reply?.content).toMatch(/Which job/i);
    h.close();
  });
});
