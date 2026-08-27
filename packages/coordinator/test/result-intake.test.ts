import { describe, expect, it } from 'vitest';
import { commitAction, implementedResult, makeHarness } from './helpers.js';

const start = (h: ReturnType<typeof makeHarness>) => {
  h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
  const c = h.app.jobs.claim(h.executorId, 'k1');
  if (!c) throw new Error('claim failed');
  return c;
};

const counts = (h: ReturnType<typeof makeHarness>, jobId: string) => ({
  results: h.store.results.countForJob(jobId),
  approvals: h.store.approvals.forJob(jobId).length,
  transitions: h.store.jobs.transitions(jobId).length,
});

describe('result intake validation', () => {
  it('rejects an oversize payload', () => {
    const h = makeHarness();
    const c = start(h);
    expect(() =>
      h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 200_000),
    ).toThrow(/too large/);
    h.close();
  });

  it('rejects a payload that does not match the contract', () => {
    const h = makeHarness();
    const c = start(h);
    for (const bad of [
      { ...implementedResult(), extra: true },
      { ...implementedResult(), verdict: 'nonsense' },
      { ...implementedResult(), summary: 'x'.repeat(5000) },
      { ...implementedResult(), changedFiles: Array.from({ length: 501 }, (_, i) => `src/${i}.ts`) },
      { ...implementedResult(), proposedActions: Array.from({ length: 11 }, () => commitAction()) },
      { ...implementedResult(), proposedActions: [{ kind: 'unknown', description: 'x', details: {} }] },
    ]) {
      expect(() =>
        h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, bad, 500),
      ).toThrow(/result contract|too large/);
    }
    expect(counts(h, c.jobId).results).toBe(0);
    h.close();
  });

  it('rejects unsafe paths and persists nothing', () => {
    const h = makeHarness();
    const c = start(h);
    const before = counts(h, c.jobId);
    for (const p of ['/etc/passwd', '../secrets', '~/x', 'C:\\x', 'src/a\u0000.ts']) {
      expect(() =>
        h.app.jobs.submitResult(
          h.executorId, c.jobId, c.leaseId, implementedResult({ changedFiles: [p] }), 500,
        ),
      ).toThrow();
    }
    expect(() =>
      h.app.jobs.submitResult(
        h.executorId, c.jobId, c.leaseId,
        implementedResult({
          proposedActions: [
            { kind: 'git_commit', description: 'c', details: { message: 'm', files: ['../x'] } },
          ],
        }),
        500,
      ),
    ).toThrow();
    expect(counts(h, c.jobId)).toEqual(before);
    h.close();
  });
});

describe('evidence invariant', () => {
  it('refuses "implemented" without an independent passing review', () => {
    const h = makeHarness();
    const c = start(h);
    const verdict = h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({
        review: { performed: true, independent: false, verdict: 'pass', notes: 'self review' },
      }),
      500,
    );
    expect(verdict).toMatchObject({ kind: 'downgraded', state: 'failed', reason: 'unverified_implementation' });
    expect(h.store.jobs.byId(c.jobId)?.state).toBe('failed');
    h.close();
  });

  it('refuses "implemented" without passing verification', () => {
    const h = makeHarness();
    const c = start(h);
    expect(
      h.app.jobs.submitResult(
        h.executorId, c.jobId, c.leaseId,
        implementedResult({ verification: { commands: [], passed: true } }),
        500,
      ),
    ).toMatchObject({ kind: 'downgraded' });
    h.close();
  });

  it('accepts a properly evidenced result', () => {
    const h = makeHarness();
    const c = start(h);
    expect(h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500))
      .toMatchObject({ kind: 'accepted', state: 'completed' });
    h.close();
  });
});

describe('idempotency and conflicts', () => {
  it('accepts an identical retry without duplicating anything', () => {
    const h = makeHarness();
    const c = start(h);
    const payload = implementedResult({ proposedActions: [commitAction()] });
    const first = h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, payload, 800);
    const after = counts(h, c.jobId);
    const second = h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, payload, 800);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(counts(h, c.jobId)).toEqual(after);
    h.close();
  });

  it('treats a different payload on the same lease as a conflict and changes nothing', () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(h.executorId, c.jobId, c.leaseId, implementedResult(), 500);
    const before = h.store.results.byJobId(c.jobId)!;
    const beforeCounts = counts(h, c.jobId);

    expect(() =>
      h.app.jobs.submitResult(
        h.executorId, c.jobId, c.leaseId, implementedResult({ summary: 'something else' }), 500,
      ),
    ).toThrow(/different result/);

    const after = h.store.results.byJobId(c.jobId)!;
    expect(after.resultSha256).toBe(before.resultSha256);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(counts(h, c.jobId).results).toBe(beforeCounts.results);
    expect(h.store.jobs.events(c.jobId).some((e) => e.kind === 'conflicting_result_payload')).toBe(true);
    h.close();
  });
});

describe('persistence of the accepted result', () => {
  it('keeps the sanitized proposed actions and an immutable snapshot', () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ proposedActions: [commitAction('feat: token ghp_abcdefghijklmnopqrstuvwxyz012345')] }),
      900,
    );
    const row = h.store.results.byJobId(c.jobId)!;
    expect(row.proposedActions).toHaveLength(1);
    expect(JSON.stringify(row.proposedActions)).toContain('[REDACTED:github-token]');
    expect(JSON.stringify(row.snapshot)).not.toContain('ghp_');
    expect(() =>
      h.store.db.prepare(`UPDATE job_results SET summary_redacted = 'x' WHERE job_id = ?`).run(c.jobId),
    ).toThrow(/immutable/);
    h.close();
  });

  it('scrubs secrets out of the summary before anything is stored', () => {
    const h = makeHarness();
    const c = start(h);
    h.app.jobs.submitResult(
      h.executorId, c.jobId, c.leaseId,
      implementedResult({ summary: 'wrote /home/tj/secret with sk-ant-api03-abcdefghijklmnopqrstuvwx' }),
      500,
    );
    const row = h.store.results.byJobId(c.jobId)!;
    expect(row.summaryRedacted).not.toContain('sk-ant-');
    expect(row.summaryRedacted).not.toContain('/home/');
    h.close();
  });
});
