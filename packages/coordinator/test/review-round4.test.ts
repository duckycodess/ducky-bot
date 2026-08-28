import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHerdrPath } from '@ducky/adapters';
import { commitAction, implementedResult, makeHarness, OWNER, secret } from './helpers.js';

const claimOne = (h: ReturnType<typeof makeHarness>, key = 'k1') => {
  const c = h.app.jobs.claim(h.executorId, key);
  if (!c) throw new Error('claim failed');
  return c;
};

describe('a real Herdr worktree path is accepted at registration', () => {
  it('accepts the expanded form of the path the live fixture reports', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);

    // Exactly what `herdr worktree create` returned on this host, expanded by
    // the adapter the way the executor now does.
    const reported = '~/.herdr/worktrees/ducky-demo/ducky-job-jabcde';
    const expanded = expandHerdrPath(reported, '/home/someone');

    expect(() =>
      h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, {
        workspaceId: 'wK',
        label: 'ducky-mgd:demo',
        mode: 'worktree',
        agentName: 'ducky-pi-demo',
        workspacePath: expanded,
      }),
    ).not.toThrow();
    expect(h.store.herdrWorkspaces.byWorkspaceId('wK')?.workspacePath).toBe(expanded);
    h.close();
  });

  it('still rejects the raw unexpanded path, which is why expansion is needed', () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    expect(() =>
      h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, {
        workspaceId: 'wK',
        label: 'ducky-mgd:demo',
        mode: 'worktree',
        agentName: 'ducky-pi-demo',
        workspacePath: '~/.herdr/worktrees/ducky-demo/ducky-job-jabcde',
      }),
    ).toThrow(/normalized absolute path/);
    h.close();
  });

  it('never lets a workspace path reach Discord', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, {
      workspaceId: 'wK',
      label: 'ducky-mgd:demo',
      mode: 'worktree',
      agentName: 'ducky-pi-demo',
      workspacePath: '/home/someone/.herdr/worktrees/ducky-demo/ducky-job-jabcde',
    });

    const reply = await h.transport.dispatch({
      kind: 'command',
      name: 'job',
      subcommand: 'status',
      userId: OWNER,
      options: { id: job.publicId },
    });
    const shown = JSON.stringify(reply);
    expect(shown).not.toContain('.herdr/worktrees');
    expect(shown).not.toContain('/home/someone');
    h.close();
  });
});

describe('production uses its own default credential file', () => {
  const strongCredentials = () =>
    JSON.stringify({
      version: 1,
      executors: [
        {
          executorId: 'wsl-prod',
          keyId: 'k1',
          bearerToken: randomBytes(32).toString('base64url'),
          hmacSecret: randomBytes(32).toString('base64url'),
          state: 'active',
        },
      ],
    });

  const writeCredentialFile = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-prodcreds-'));
    const file = path.join(dir, 'executor-credentials-production.json');
    writeFileSync(file, strongCredentials(), { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  };

  it('opens the profile default rather than refusing to start', () => {
    // A safe temp stand-in for /etc/ducky/executor-credentials-production.json.
    const file = writeCredentialFile();
    const h = makeHarness({
      env: {
        DUCKY_PROFILE: 'production',
        DUCKY_PROD_COMPONENT_SIGNING_KEY: secret(),
        DISCORD_PROD_TOKEN: 'prod-placeholder-token',
        DISCORD_PROD_APP_ID: '100000000000000021',
        DUCKY_PROD_EXECUTOR_CREDENTIALS_FILE: file,
        DUCKY_EXECUTOR_CREDENTIALS: undefined,
        // Production must now choose a conversational backend explicitly, so a
        // successful production boot has to state one. `disabled` is the honest
        // choice while no provider is verified; `mock` is refused outright.
        DUCKY_CONVERSATION_PROVIDER: 'disabled',
      },
    });
    expect(h.app.credentials.listActive().map((c) => c.keyId)).toContain('k1');
    h.close();
  });

  it('never inherits a shared or development credential file', () => {
    const shared = writeCredentialFile();
    expect(() =>
      makeHarness({
        env: {
          DUCKY_PROFILE: 'production',
          DUCKY_PROD_COMPONENT_SIGNING_KEY: secret(),
          DISCORD_PROD_TOKEN: 'prod-placeholder-token',
          DISCORD_PROD_APP_ID: '100000000000000021',
          // Only shared/dev variables are set; production must not use them.
          DUCKY_EXECUTOR_CREDENTIALS_FILE: shared,
          DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE: shared,
          DUCKY_EXECUTOR_CREDENTIALS: undefined,
        },
      }),
      // It falls through to its OWN default path, which does not exist here.
    ).toThrow();
  });
});

describe('a workspace is only closed for a completed job', () => {
  const registered = (h: ReturnType<typeof makeHarness>) => {
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'a', bootstrap: false });
    const c = claimOne(h);
    h.app.jobs.registerWorkspace(h.executorId, c.jobId, c.leaseId, {
      workspaceId: 'wX',
      label: 'ducky-mgd:demo',
      mode: 'direct',
      agentName: 'ducky-pi-demo',
      workspacePath: '/tmp/ducky-demo',
    });
    return { job, claim: c };
  };

  it('refuses while the job is still running', () => {
    const h = makeHarness();
    const { job } = registered(h);
    expect(h.store.jobs.byId(job.id)?.state).toBe('running');
    expect(() => h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wX')).toThrow(
      /only a completed job/,
    );
    expect(h.store.herdrWorkspaces.byWorkspaceId('wX')?.closedAt).toBeNull();
    h.close();
  });

  it('refuses for a failed job, whose workspace is retained on purpose', () => {
    const h = makeHarness();
    const { job, claim } = registered(h);
    h.app.jobs.reportFailure(h.executorId, claim.jobId, claim.leaseId, 'no_result', {});
    expect(h.store.jobs.byId(job.id)?.state).toBe('failed');
    expect(() => h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wX')).toThrow(
      /only a completed job/,
    );
    h.close();
  });

  it('refuses while approvals are pending', () => {
    const h = makeHarness();
    const { job, claim } = registered(h);
    h.app.jobs.submitResult(
      h.executorId,
      claim.jobId,
      claim.leaseId,
      implementedResult({ proposedActions: [commitAction()] }),
      900,
    );
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_approval');
    expect(() => h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wX')).toThrow(
      /only a completed job/,
    );
    h.close();
  });

  it('refuses while the job waits on the owner', () => {
    const h = makeHarness();
    const { job, claim } = registered(h);
    h.app.jobs.submitResult(
      h.executorId,
      claim.jobId,
      claim.leaseId,
      implementedResult({ verdict: 'needs_owner_input', question: 'q?', proposedActions: [] }),
      400,
    );
    expect(() => h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wX')).toThrow(
      /only a completed job/,
    );
    h.close();
  });

  it('accepts once the job completed, and stays idempotent afterwards', () => {
    const h = makeHarness();
    const { job, claim } = registered(h);
    h.app.jobs.submitResult(h.executorId, claim.jobId, claim.leaseId, implementedResult(), 500);
    expect(h.store.jobs.byId(job.id)?.state).toBe('completed');

    expect(h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wX').closed).toBe(true);
    expect(h.store.herdrWorkspaces.byWorkspaceId('wX')?.closedAt).not.toBeNull();
    // A retry after the row is closed still succeeds.
    expect(h.app.jobs.markWorkspaceClosed(h.executorId, job.id, 'wX').closed).toBe(true);
    h.close();
  });
});
