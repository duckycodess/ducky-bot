import { describe, expect, it } from 'vitest';
import { ScriptedDependencyChecker, UnavailableDependencyChecker } from '@ducky/adapters';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { DependencyResolver } from '../src/domain/dependency-resolver.js';
import { OWNER, dependencyResult, makeHarness } from './helpers.js';

const MINUTE = 60_000;

/**
 * Drives a job to `waiting_on_dependency` the way it actually happens: a real
 * claim, then a real result submitted over the service.
 */
const waitingJob = async (
  h: ReturnType<typeof makeHarness>,
  over: Record<string, unknown> = {},
) => {
  h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
  const claim = h.app.jobs.claim(h.executorId, `k${Math.random()}`)!;
  h.app.jobs.submitResult(h.executorId, claim.jobId, claim.leaseId, dependencyResult(over), 400);
  return h.store.jobs.byId(claim.jobId)!;
};

/** A resolver over the harness's store with an injected clock and checker. */
const resolverFor = (
  h: ReturnType<typeof makeHarness>,
  checker: ScriptedDependencyChecker | UnavailableDependencyChecker,
  clock: { ms: number },
) =>
  new DependencyResolver({
    store: h.store,
    checker,
    now: () => new Date(clock.ms),
  });

describe('recording a dependency', () => {
  it('parks the job, releases the lease and RETAINS the repository reservation', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);

    expect(job.state).toBe('waiting_on_dependency');
    // No lease: nothing is being written, so the expiry sweep must not see it.
    expect(job.leaseId).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
    expect(h.store.jobs.expiredLeases('2099-01-01T00:00:00.000Z')).toHaveLength(0);
    // The reservation is what keeps another job off the repository.
    const reservation = h.store.jobs.reservation('demo');
    expect(reservation?.jobId).toBe(job.id);
    expect(reservation?.reason).toBe('active_job');
    // And the work phase is cleared, because nothing is in progress.
    expect(job.workPhase).toBeNull();
    h.close();
  });

  it('writes the dependency in the same transaction as the transition', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);
    const dep = h.store.dependencies.openForJob(job.id)!;
    expect(dep.type).toBe('ci_run');
    expect(dep.description).toBe('the upstream build to go green');
    expect(dep.externalKey).toBe('run-1234');
    expect(dep.maxChecks).toBe(3);
    expect(dep.checksMade).toBe(0);
    expect(dep.nextCheckAt).not.toBeNull();
    h.close();
  });

  it('REFUSES a schedule outside the ceilings rather than quietly clamping it', async () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
    const claim = h.app.jobs.claim(h.executorId, 'k-huge')!;

    for (const dependency of [
      { nextCheckInSeconds: 1 },                 // below the floor
      { maxChecks: 100_000 },                    // above the check ceiling
      { deadlineInSeconds: 99_999_999 },         // beyond the wall-clock ceiling
      { type: 'deploy_wait' },                   // not a known type
    ]) {
      expect(() =>
        h.app.jobs.submitResult(
          h.executorId, claim.jobId, claim.leaseId, dependencyResult({ dependency }), 400,
        ),
      ).toThrow(/did not match the result contract/);
    }

    // Nothing was written: the job is still running under its own lease, so a
    // rejected result cannot strand it or its repository.
    const after = h.store.jobs.byId(claim.jobId)!;
    expect(after.state).toBe('running');
    expect(after.leaseId).toBe(claim.leaseId);
    expect(h.store.dependencies.forJob(claim.jobId)).toHaveLength(0);
    h.close();
  });

  it('applies defaults when the executor gives only the essentials', async () => {
    const h = makeHarness();
    h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
    const claim = h.app.jobs.claim(h.executorId, 'k-min')!;
    h.app.jobs.submitResult(
      h.executorId, claim.jobId, claim.leaseId,
      dependencyResult({
        dependency: {
          type: 'human_action', description: 'someone to merge the other PR',
          nextCheckInSeconds: undefined, maxChecks: undefined, deadlineInSeconds: undefined,
        },
      }),
      400,
    );
    const dep = h.store.dependencies.openForJob(claim.jobId)!;
    expect(dep.maxChecks).toBe(24);
    expect(dep.deadlineAt > dep.createdAt).toBe(true);
    h.close();
  });

  it('is visible in the owner’s private job detail and nowhere else', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);
    const detail = h.app.jobs.detail(h.owner, job.publicId);
    expect(detail.dependencies).toHaveLength(1);
    expect(detail.dependencies[0]?.description).toBe('the upstream build to go green');
    h.close();
  });
});

describe('resuming when the dependency becomes ready', () => {
  it('requeues the job and keeps its repository reservation', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);
    const clock = { ms: Date.now() + 10 * MINUTE };
    const checker = new ScriptedDependencyChecker([{ status: 'ready', detail: 'build green' }]);

    const result = await resolverFor(h, checker, clock).tick();
    expect(result).toMatchObject({ checked: 1, resumed: 1, failed: 0, handedToOwner: 0 });

    const after = h.store.jobs.byId(job.id)!;
    expect(after.state).toBe('queued');
    // It re-claims its OWN repository ahead of anything queued behind it.
    expect(h.store.jobs.reservation('demo')?.jobId).toBe(job.id);
    expect(h.store.dependencies.byId(h.store.dependencies.forJob(job.id)[0]!.id)?.state).toBe('ready');
    h.close();
  });

  it('lets a resumed job actually be claimed again', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);
    const clock = { ms: Date.now() + 10 * MINUTE };
    await resolverFor(h, new ScriptedDependencyChecker([{ status: 'ready' }]), clock).tick();

    const reclaim = h.app.jobs.claim(h.executorId, 'k-again');
    expect(reclaim?.jobId).toBe(job.id);
    expect(h.store.jobs.byId(job.id)?.state).toBe('running');
    // A fresh claim starts the engineering loop again.
    expect(h.store.jobs.byId(job.id)?.workPhase).toBe('preparing');
    h.close();
  });

  it('does NOT believe a `ready` from an unverified checker', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);
    const clock = { ms: Date.now() + 10 * MINUTE };
    // Same script, but the checker admits it has never been exercised.
    const checker = new ScriptedDependencyChecker([{ status: 'ready' }], { status: 'pending' }, false);

    const result = await resolverFor(h, checker, clock).tick();
    expect(result.resumed).toBe(0);
    expect(result.rescheduled).toBe(1);
    expect(h.store.jobs.byId(job.id)?.state).toBe('waiting_on_dependency');
    h.close();
  });
});

describe('failing when the dependency will not be satisfied', () => {
  it('fails the job and releases the repository', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);
    const clock = { ms: Date.now() + 10 * MINUTE };
    const checker = new ScriptedDependencyChecker([{ status: 'failed', detail: 'build cancelled' }]);

    const result = await resolverFor(h, checker, clock).tick();
    expect(result.failed).toBe(1);
    expect(h.store.jobs.byId(job.id)?.state).toBe('failed');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();
    h.close();
  });
});

describe('the bounded budget', () => {
  it('reschedules with backoff while budget remains, and never polls forever', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);
    const checker = new ScriptedDependencyChecker([], { status: 'pending' });
    const clock = { ms: Date.now() };
    const resolver = resolverFor(h, checker, clock);

    const depId = h.store.dependencies.openForJob(job.id)!.id;
    let previousInterval = 0;

    // maxChecks is 3: two reschedules, then the budget is spent.
    for (let i = 1; i <= 2; i += 1) {
      clock.ms = Date.parse(h.store.dependencies.byId(depId)!.nextCheckAt!);
      const r = await resolver.tick();
      expect(r.rescheduled, `pass ${i}`).toBe(1);
      const after = h.store.dependencies.byId(depId)!;
      expect(after.checksMade).toBe(i);
      const interval = Date.parse(after.nextCheckAt!) - clock.ms;
      // Backoff grows rather than hammering.
      expect(interval).toBeGreaterThan(previousInterval);
      previousInterval = interval;
    }

    clock.ms = Date.parse(h.store.dependencies.byId(depId)!.nextCheckAt!);
    const last = await resolver.tick();
    expect(last.handedToOwner).toBe(1);
    expect(checker.calls).toHaveLength(3);

    // The budget is spent, so nothing polls it again however far time moves.
    clock.ms += 365 * 24 * 60 * MINUTE;
    expect(await resolver.tick()).toMatchObject({ checked: 0, rescheduled: 0 });
    expect(checker.calls).toHaveLength(3);
    h.close();
  });

  it('hands the job to the OWNER when it gives up, rather than guessing', async () => {
    const h = makeHarness();
    const job = await waitingJob(h, { dependency: { maxChecks: 1 } });
    const clock = { ms: Date.now() + 10 * MINUTE };
    const checker = new ScriptedDependencyChecker([], { status: 'pending' });

    await resolverFor(h, checker, clock).tick();
    const after = h.store.jobs.byId(job.id)!;
    expect(after.state).toBe('needs_owner_input');
    expect(h.store.dependencies.forJob(job.id)[0]?.state).toBe('expired');
    // The owner is told plainly what happened.
    const events = h.store.jobs.events(job.id);
    expect(events.some((e) => e.kind === 'dependency_check_budget_exhausted')).toBe(true);
    h.close();
  });

  it('stops at the wall-clock deadline even with checks left', async () => {
    const h = makeHarness();
    const job = await waitingJob(h, {
      dependency: { maxChecks: 50, nextCheckInSeconds: 60, deadlineInSeconds: 120 },
    });
    const clock = { ms: Date.now() + 10 * MINUTE }; // long past the deadline
    const checker = new ScriptedDependencyChecker([], { status: 'pending' });

    const result = await resolverFor(h, checker, clock).tick();
    expect(result.handedToOwner).toBe(1);
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_owner_input');
    h.close();
  });

  it('spends a check when the checker throws, so a broken one buys no extra retries', async () => {
    const h = makeHarness();
    const job = await waitingJob(h, { dependency: { maxChecks: 1 } });
    const clock = { ms: Date.now() + 10 * MINUTE };
    const checker = new ScriptedDependencyChecker([]);
    checker.throwOnCheck = new Error('checker exploded');

    const result = await resolverFor(h, checker, clock).tick();
    expect(result.handedToOwner).toBe(1);
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_owner_input');
    h.close();
  });

  it('checks at most the batch size in one pass', async () => {
    const h = makeHarness();
    for (const slug of ['demo', 'other']) {
      h.app.jobs.submit(h.owner, { repoSlug: slug, task: 't', bootstrap: false });
    }
    for (const key of ['a', 'b']) {
      const claim = h.app.jobs.claim(h.executorId, key);
      if (claim) {
        h.app.jobs.submitResult(h.executorId, claim.jobId, claim.leaseId, dependencyResult(), 400);
      }
    }
    const clock = { ms: Date.now() + 10 * MINUTE };
    const checker = new ScriptedDependencyChecker([], { status: 'pending' });
    const resolver = new DependencyResolver({
      store: h.store, checker, now: () => new Date(clock.ms), batchSize: 1,
    });
    expect((await resolver.tick()).checked).toBe(1);
    h.close();
  });
});

describe('cancellation and restart', () => {
  it('cancels a waiting job at once and stops the dependency being polled', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);

    const outcome = h.app.jobs.requestCancel(h.owner, job.publicId);
    expect(outcome.state).toBe('cancelled');
    expect(h.store.dependencies.openForJob(job.id)).toBeUndefined();
    expect(h.store.dependencies.forJob(job.id)[0]?.state).toBe('cancelled');
    expect(h.store.jobs.reservation('demo')).toBeUndefined();

    // Even a checker that would say ready cannot resurrect it.
    const clock = { ms: Date.now() + 10 * MINUTE };
    const checker = new ScriptedDependencyChecker([{ status: 'ready' }]);
    expect(await resolverFor(h, checker, clock).tick()).toMatchObject({ checked: 0, resumed: 0 });
    expect(checker.calls).toHaveLength(0);
    expect(h.store.jobs.byId(job.id)?.state).toBe('cancelled');
    h.close();
  });

  it('closes a dependency whose job moved on, rather than checking it forever', async () => {
    const h = makeHarness();
    const job = await waitingJob(h);
    // Simulate the job being resolved by another path between passes.
    h.store.db.prepare(`UPDATE jobs SET state = 'failed' WHERE id = ?`).run(job.id);

    const clock = { ms: Date.now() + 10 * MINUTE };
    const checker = new ScriptedDependencyChecker([{ status: 'ready' }]);
    const result = await resolverFor(h, checker, clock).tick();
    expect(result).toMatchObject({ abandoned: 1, checked: 0 });
    expect(h.store.dependencies.forJob(job.id)[0]?.state).toBe('cancelled');
    h.close();
  });

  it('survives a restart: the cursor is durable and the next pass picks it up', async () => {
    const db = openDatabase({ location: ':memory:' });
    runMigrations(db);
    const store = createStore(db);
    const h = makeHarness({}, false);
    // Use the harness's own store so a job exists, then rebuild the resolver
    // from scratch -- which is exactly what a process restart does.
    const job = await waitingJob(h);
    const clock = { ms: Date.now() + 10 * MINUTE };

    const first = new DependencyResolver({
      store: h.store,
      checker: new ScriptedDependencyChecker([], { status: 'pending' }),
      now: () => new Date(clock.ms),
    });
    await first.tick();
    const afterFirst = h.store.dependencies.openForJob(job.id)!;
    expect(afterFirst.checksMade).toBe(1);

    // A brand-new resolver, with no memory of anything.
    clock.ms = Date.parse(afterFirst.nextCheckAt!);
    const restarted = new DependencyResolver({
      store: h.store,
      checker: new ScriptedDependencyChecker([{ status: 'ready' }]),
      now: () => new Date(clock.ms),
    });
    expect((await restarted.tick()).resumed).toBe(1);
    expect(h.store.jobs.byId(job.id)?.state).toBe('queued');
    store.db.close();
    h.close();
  });

  it('runs one pass at a time, so two overlapping ticks cannot double-spend a check', async () => {
    const h = makeHarness();
    await waitingJob(h);
    const clock = { ms: Date.now() + 10 * MINUTE };
    const checker = new ScriptedDependencyChecker([], { status: 'pending' });
    const resolver = resolverFor(h, checker, clock);

    const [a, b] = await Promise.all([resolver.tick(), resolver.tick()]);
    expect(a).toBe(b);
    expect(checker.calls).toHaveLength(1);
    h.close();
  });
});

describe('the shipped default checker', () => {
  it('never reports ready, so nothing resumes on a check that did not happen', async () => {
    const checker = new UnavailableDependencyChecker();
    expect(checker.verified).toBe(false);
    const outcome = await checker.check({
      dependencyId: 'd', type: 'ci_run', description: 'x', externalKey: null,
      checksMade: 0, maxChecks: 3, deadlineAt: '2030-01-01T00:00:00.000Z',
    });
    expect(outcome.status).toBe('pending');
  });

  it('takes a dependency wait to the owner, which is the honest end state', async () => {
    const h = makeHarness();
    const job = await waitingJob(h, { dependency: { maxChecks: 1 } });
    const clock = { ms: Date.now() + 10 * MINUTE };

    // Exactly what production is wired with.
    await resolverFor(h, new UnavailableDependencyChecker(), clock).tick();
    expect(h.store.jobs.byId(job.id)?.state).toBe('needs_owner_input');
    h.close();
  });

  it('is what the app wires by default, and says so in /status', async () => {
    const h = makeHarness();
    await h.transport.start((e) => h.app.router.handle(e));
    expect(h.app.dependencies.checkerVerified).toBe(false);
    expect(h.app.dependencies.checkerName).toBe('none');

    const reply = await h.transport.dispatch({
      kind: 'command', name: 'status', userId: OWNER, options: {},
    });
    expect(JSON.stringify(reply)).toMatch(/never auto-resumed/);
    h.close();
  });
});
