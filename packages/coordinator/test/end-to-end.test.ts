import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MockPiOrchestrator, exampleImplementedResult } from '@ducky/adapters';
import type { JobResultFile } from '@ducky/contracts';
import { CoordinatorClient, ExecutorLoop } from '@ducky/executor';
import { buildServer } from '../src/http/server.js';
import { makeHarness, secret } from './helpers.js';

let server: FastifyInstance | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function initRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-e2e-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  writeFileSync(path.join(dir, 'README.md'), '# e2e\n');
  execFileSync('git', ['add', '.'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });
  return dir;
}

/**
 * Coordinator and executor as separate processes-in-spirit: a real HTTP server
 * on a real port, and the real signing client on the other end. Only the
 * Herdr/Pi orchestrator is mocked.
 */
async function bootPair(repoPath: string) {
  const h = makeHarness({
    env: { DUCKY_REPOS_FILE: 'unused' },
  });
  // point the allowlisted repo at a real git checkout
  h.store.repos.upsert({
    slug: 'demo', absolutePath: repoPath, defaultBranch: 'main', githubOwner: null,
    githubRepo: null, allowWorktree: true, allowBootstrap: true,
    bootstrapAllowedEntries: ['.git'], enabled: true,
  });
  (h.app.allowlist as unknown as { bySlug: Map<string, { absolutePath: string }> }).bySlug.get(
    'demo',
  )!.absolutePath = repoPath;

  server = await buildServer({ store: h.store, jobs: h.app.jobs, credentials: h.app.credentials });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.addresses()[0]!;

  const client = new CoordinatorClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    executorId: h.executorId,
    keyId: h.keyId,
    bearerToken: h.bearer,
    hmacSecret: h.hmac,
  });
  return { h, client };
}

describe('coordinator and executor end to end', () => {
  it('carries a job from submission to a recorded, approvable result', async () => {
    const repoPath = initRepo();
    const { h, client } = await bootPair(repoPath);

    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'add a feature', bootstrap: false });

    const orchestrator = new MockPiOrchestrator(() =>
      exampleImplementedResult('added the feature'),
    );
    const loop = new ExecutorLoop({ client, orchestrator, pollWaitMs: 0, version: '0.1.0' });

    await client.heartbeat({ version: '0.1.0', capabilities: [], activeJobIds: [] });
    expect(await loop.runOnce()).toBe('claimed');

    const after = h.store.jobs.byId(job.id)!;
    expect(after.state).toBe('completed');
    expect(h.store.results.byJobId(job.id)?.summaryRedacted).toBe('added the feature');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();

    // the brief that reached Pi carried the boundaries, not raw credentials
    expect(orchestrator.runs[0]?.brief).toContain('Do NOT commit, push');
    expect(orchestrator.runs[0]?.mode).toBe('worktree');
    h.close();
  });

  it('routes a proposed action into an owner approval that is never executed', async () => {
    const repoPath = initRepo();
    const { h, client } = await bootPair(repoPath);
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'ship it', bootstrap: false });

    const withAction: JobResultFile = {
      ...exampleImplementedResult('ready to commit'),
      verdict: 'implemented',
      proposedActions: [
        {
          kind: 'git_commit',
          description: 'commit',
          details: { message: 'feat: x', files: ['src/example.ts'] },
        },
      ],
    };
    const orchestrator = new MockPiOrchestrator(() => withAction);
    const loop = new ExecutorLoop({ client, orchestrator, pollWaitMs: 0, version: '0.1.0' });
    await loop.runOnce();

    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_approval');
    const approval = h.store.approvals.forJob(job.id)[0]!;
    const outcome = h.app.approvals.decide(h.owner, approval.id, 'approved');
    expect(outcome.note).toMatch(/does not execute/i);
    expect(h.store.jobs.byId(job.id)?.state).toBe('completed');
    h.close();
  });

  it('pauses for an owner answer, then continues under the same reservation', async () => {
    const repoPath = initRepo();
    const { h, client } = await bootPair(repoPath);
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'ambiguous', bootstrap: false });

    const askFirst: JobResultFile = {
      ...exampleImplementedResult('need a decision'),
      verdict: 'needs_owner_input',
      question: 'postgres or sqlite?',
      proposedActions: [],
    };
    let round = 0;
    const orchestrator = new MockPiOrchestrator(() => {
      round += 1;
      return round === 1 ? askFirst : exampleImplementedResult('used sqlite');
    });
    const loop = new ExecutorLoop({ client, orchestrator, pollWaitMs: 0, version: '0.1.0' });

    await loop.runOnce();
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_owner_input');
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(job.id);

    h.app.jobs.submitOwnerInput(h.owner, job.publicId, 'sqlite');
    await loop.runOnce();

    expect(h.store.jobs.byId(job.id)?.state).toBe('completed');
    expect(orchestrator.runs[1]?.brief).toContain('sqlite');
    h.close();
  });

  it('reports a rejected workspace instead of running anywhere unexpected', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-e2e-dirty-'));
    writeFileSync(path.join(dir, 'precious.txt'), 'do not touch\n');
    const { h, client } = await bootPair(dir);
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'bootstrap me', bootstrap: true });

    const orchestrator = new MockPiOrchestrator();
    const loop = new ExecutorLoop({ client, orchestrator, pollWaitMs: 0, version: '0.1.0' });
    await loop.runOnce();

    expect(h.store.jobs.byId(job.id)?.state).toBe('failed');
    expect(h.store.jobs.transitions(job.id).at(-1)?.reason).toBe('workspace_rejected');
    expect(orchestrator.runs).toHaveLength(0);
    h.close();
  });

  it('rejects an executor whose credential was revoked', async () => {
    const repoPath = initRepo();
    const { h, client } = await bootPair(repoPath);
    h.store.executors.revokeCredential(h.keyId);
    await expect(
      client.heartbeat({ version: '0.1.0', capabilities: [], activeJobIds: [] }),
    ).rejects.toThrow(/rejected our credentials/);
    h.close();
  });

  it('rejects a client signing with the wrong secret', async () => {
    const repoPath = initRepo();
    const { h } = await bootPair(repoPath);
    const address = server!.addresses()[0]!;
    const bad = new CoordinatorClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      executorId: h.executorId,
      keyId: h.keyId,
      bearerToken: h.bearer,
      hmacSecret: secret(),
    });
    await expect(bad.heartbeat({ version: '0.1.0', capabilities: [], activeJobIds: [] })).rejects.toThrow(
      /rejected our credentials/,
    );
    h.close();
  });
});
