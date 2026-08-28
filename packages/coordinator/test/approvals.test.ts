import { describe, expect, it } from 'vitest';
import { DeferredActionPerformer } from '../src/domain/action-performer.js';
import { commitAction, implementedResult, makeHarness, OWNER, STRANGER } from './helpers.js';

const withActions = (h: ReturnType<typeof makeHarness>, n: number) => {
  const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
  const c = h.app.jobs.claim(h.executorId, 'k1')!;
  h.app.jobs.submitResult(
    h.executorId, c.jobId, c.leaseId,
    implementedResult({ proposedActions: Array.from({ length: n }, (_, i) => commitAction(`feat: ${i}`)) }),
    2000,
  );
  return { job, approvals: h.store.approvals.forJob(job.id) };
};

describe('per-action approvals', () => {
  it('creates one row per proposed action', () => {
    const h = makeHarness();
    const { job, approvals } = withActions(h, 3);
    expect(approvals).toHaveLength(3);
    expect(approvals.map((a) => a.actionIndex)).toEqual([0, 1, 2]);
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_approval');
    h.close();
  });

  it('keeps the job pending until every action is decided', () => {
    const h = makeHarness();
    const { job, approvals } = withActions(h, 3);
    h.app.approvals.decide(h.owner, approvals[0]!.id, 'approved');
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_approval');
    h.app.approvals.decide(h.owner, approvals[1]!.id, 'rejected');
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_approval');
    const last = h.app.approvals.decide(h.owner, approvals[2]!.id, 'approved');
    expect(last.jobState).toBe('completed');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('actions_decided');
    h.close();
  });

  it('records all-rejected distinctly from approved', () => {
    const h = makeHarness();
    const { job, approvals } = withActions(h, 2);
    for (const a of approvals) h.app.approvals.decide(h.owner, a.id, 'rejected');
    expect(h.store.jobs.byId(job.id)?.state).toBe('completed');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('all_actions_rejected');
    h.close();
  });

  it('is single use: a decided action cannot be decided again', () => {
    const h = makeHarness();
    const { approvals } = withActions(h, 1);
    h.app.approvals.decide(h.owner, approvals[0]!.id, 'approved');
    // Refused either as already-decided or because the job has since settled;
    // both are the same guarantee, that one action is decided exactly once.
    expect(() => h.app.approvals.decide(h.owner, approvals[0]!.id, 'rejected')).toThrow(
      /already|no longer awaiting/i,
    );
    expect(h.store.approvals.byId(approvals[0]!.id)?.state).toBe('approved');
    h.close();
  });

  it('refuses decisions from a non-owner and for another account’s job', () => {
    const h = makeHarness();
    const { job, approvals } = withActions(h, 1);
    expect(() => h.app.approvals.decide(h.chat, approvals[0]!.id, 'approved')).toThrow(/not authorized/i);
    h.store.db.prepare('UPDATE jobs SET discord_user_id = ? WHERE id = ?').run('999', job.id);
    expect(() => h.app.approvals.decide(h.owner, approvals[0]!.id, 'approved')).toThrow(/no longer exists/);
    h.close();
  });

  it('shows exact action details through an owner-bound View Details control', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    const { job, approvals } = withActions(h, 1);
    const approval = approvals[0]!;
    const direct = h.app.approvals.detail(h.owner, approval.id);
    expect(direct.job.publicId).toBe(job.publicId);
    expect(JSON.parse(direct.approval.detailsJson)).toMatchObject({
      message: 'feat: 0', files: ['src/a.ts'],
    });

    const customId = h.app.signer.sign({
      kind: 'approval_details', entityId: approval.id, actorUserId: OWNER,
    });
    const reply = await h.transport.dispatch({
      kind: 'component', customId, userId: OWNER,
    });
    const rendered = JSON.stringify(reply);
    expect(rendered).toContain(job.publicId);
    expect(rendered).toContain('feat: 0');
    expect(rendered).toContain('src/a.ts');
    expect(rendered).toContain('<t:');
    expect(reply?.ephemeral).toBe(true);

    const reused = await h.transport.dispatch({
      kind: 'component', customId, userId: STRANGER,
    });
    expect(reused?.content).toMatch(/not authorized/i);
    h.close();
  });

  it('records the approval but never performs the action in Phase 1', async () => {
    const h = makeHarness();
    const { approvals } = withActions(h, 1);
    const outcome = h.app.approvals.decide(h.owner, approvals[0]!.id, 'approved');
    expect(outcome.approval.state).toBe('approved');
    expect(outcome.note).toMatch(/does not execute/i);

    const performer = new DeferredActionPerformer();
    expect(performer.enabled).toBe(false);
    await expect(performer.perform('git_commit', {})).rejects.toThrow(/not executed in Phase 1/);
    h.close();
  });

  it('exposes no bulk-approve entry point', () => {
    const h = makeHarness();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(h.app.approvals));
    expect(methods).toEqual(expect.arrayContaining(['decide']));
    expect(methods.some((m) => /all|bulk|every/i.test(m) && m !== 'settleJob')).toBe(false);
    h.close();
  });
});
