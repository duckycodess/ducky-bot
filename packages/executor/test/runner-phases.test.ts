import { describe, expect, it, vi } from 'vitest';
import type { JobHeartbeatRequest, JobWorkPhase } from '@ducky/contracts';
import { DuckyError } from '@ducky/contracts';
import type { PhaseReader } from '@ducky/adapters';
import { JobSupervisor } from '../src/supervisor.js';

/**
 * Phase reporting has to be OBSERVABLE, not merely stored.
 *
 * Before this existed, no executor code path ever sent `progress.phase` at all,
 * so a live job sat at `preparing` from claim to terminal state while the
 * README claimed phases were "driven by the executor's own progress reports".
 * And a phase that only rode the 30-second lease beat is useless on a short
 * turn, so a report schedules a coalesced extra beat.
 */
interface Beat {
  phase: JobWorkPhase | undefined;
}

function harness(opts: {
  accept?: (phase: JobWorkPhase | undefined) => JobWorkPhase | null;
  refuse?: JobWorkPhase[];
  failWith?: Error;
} = {}) {
  const beats: Beat[] = [];
  let accepted: JobWorkPhase | null = null;
  const client = {
    jobHeartbeat: vi.fn(async (_jobId: string, body: JobHeartbeatRequest) => {
      const phase = body.progress?.phase;
      beats.push({ phase });
      if (opts.failWith) throw opts.failWith;
      if (phase !== undefined && opts.refuse?.includes(phase)) {
        throw new DuckyError('invalid_transition', 'refused');
      }
      if (phase !== undefined) accepted = phase;
      return {
        cancelRequested: false,
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        workPhase: accepted,
      };
    }),
  };
  return { beats, client };
}

const supervisorFor = (client: unknown, over: Record<string, unknown> = {}) =>
  new JobSupervisor({
    client: client as never,
    jobId: 'job-1',
    leaseId: 'lease-1',
    // Long enough that nothing here is the regular beat firing by accident.
    intervalMs: 60_000,
    phaseDebounceMs: 5,
    ...over,
  } as never);

describe('phase reporting', () => {
  it('sends a reported phase without waiting for the regular lease beat', async () => {
    const { beats, client } = harness();
    const s = supervisorFor(client);
    s.start();
    await vi.waitFor(() => expect(beats.length).toBeGreaterThan(0));
    beats.length = 0;

    s.reportPhase('planning');
    await vi.waitFor(() => expect(beats.map((b) => b.phase)).toContain('planning'));
    s.stop();
  });

  it('reports back the phase the coordinator ACCEPTED, not the one hoped for', async () => {
    const { client } = harness();
    const s = supervisorFor(client);
    s.start();
    s.reportPhase('planning');
    await vi.waitFor(() => expect(s.acceptedPhase).toBe('planning'));
    s.stop();
  });

  it('coalesces a burst of reports into a single request', async () => {
    const { beats, client } = harness();
    const s = supervisorFor(client, { phaseDebounceMs: 25 });
    s.start();
    await vi.waitFor(() => expect(beats.length).toBeGreaterThan(0));
    beats.length = 0;

    // Legal chain, all inside one debounce window. Only the last survives.
    s.reportPhase('planning');
    s.reportPhase('planning');
    s.reportPhase('planning');
    await vi.waitFor(() => expect(beats.length).toBe(1));
    expect(beats[0]!.phase).toBe('planning');
    s.stop();
  });

  it('never resends a phase the coordinator refused', async () => {
    const { beats, client } = harness({ refuse: ['verifying'] });
    const s = supervisorFor(client);
    s.start();
    await vi.waitFor(() => expect(beats.length).toBeGreaterThan(0));

    s.reportPhase('verifying');
    await vi.waitFor(() => expect(beats.filter((b) => b.phase === 'verifying').length).toBe(1));
    // Give the loop room to retry if it were going to.
    await new Promise((r) => setTimeout(r, 60));
    expect(beats.filter((b) => b.phase === 'verifying').length).toBe(1);
    s.stop();
  });

  it('stays quiet about an edge the shared machine would refuse anyway', async () => {
    const { beats, client } = harness();
    const s = supervisorFor(client);
    s.start();
    s.reportPhase('planning');
    await vi.waitFor(() => expect(s.acceptedPhase).toBe('planning'));
    beats.length = 0;

    // planning -> verifying is not a legal edge; nothing should be sent.
    s.reportPhase('verifying');
    await new Promise((r) => setTimeout(r, 40));
    expect(beats.filter((b) => b.phase !== undefined)).toEqual([]);
    s.stop();
  });

  it('a transport failure does not clear the pending phase, so it retries', async () => {
    let calls = 0;
    const sent: (JobWorkPhase | undefined)[] = [];
    const client = {
      jobHeartbeat: vi.fn(async (_id: string, body: JobHeartbeatRequest) => {
        calls += 1;
        sent.push(body.progress?.phase);
        if (calls === 1) throw new Error('network blip');
        return {
          cancelRequested: false,
          leaseExpiresAt: new Date().toISOString(),
          workPhase: body.progress?.phase ?? null,
        };
      }),
    };
    const s = supervisorFor(client, { intervalMs: 20, phaseDebounceMs: 5 });
    s.start();
    s.reportPhase('planning');
    await vi.waitFor(() => expect(s.acceptedPhase).toBe('planning'), { timeout: 2000 });
    expect(sent.filter((p) => p === 'planning').length).toBeGreaterThan(1);
    s.stop();
  });

  it('still renews the lease when there is no phase to report', async () => {
    const { beats, client } = harness();
    const s = supervisorFor(client, { intervalMs: 15 });
    s.start();
    await vi.waitFor(() => expect(beats.length).toBeGreaterThan(1), { timeout: 2000 });
    expect(beats.every((b) => b.phase === undefined)).toBe(true);
    s.stop();
  });

  it('picks up a phase Pi wrote for itself and reports it', async () => {
    const { beats, client } = harness();
    const phaseReader: PhaseReader = { read: async () => 'implementing', clear: async () => {} };
    const s = supervisorFor(client, { intervalMs: 15, phaseReader });
    s.watchWorkspace('/somewhere');
    s.start();
    await vi.waitFor(() => expect(beats.map((b) => b.phase)).toContain('implementing'), {
      timeout: 2000,
    });
    s.stop();
  });

  it('does not look for a phase file before a workspace exists', async () => {
    let reads = 0;
    const phaseReader: PhaseReader = {
      read: async () => { reads += 1; return 'implementing'; },
      clear: async () => {},
    };
    const { client } = harness();
    const s = supervisorFor(client, { intervalMs: 15, phaseReader });
    s.start();
    await new Promise((r) => setTimeout(r, 60));
    s.stop();
    expect(reads).toBe(0);
  });

  it('a throwing phase reader never disturbs the lease beat', async () => {
    const { beats, client } = harness();
    const phaseReader: PhaseReader = {
      read: async () => { throw new Error('disk gone'); },
      clear: async () => {},
    };
    const s = supervisorFor(client, { intervalMs: 15, phaseReader });
    s.watchWorkspace('/somewhere');
    s.start();
    await vi.waitFor(() => expect(beats.length).toBeGreaterThan(1), { timeout: 2000 });
    s.stop();
  });

  it('reports nothing once stopped', async () => {
    const { beats, client } = harness();
    const s = supervisorFor(client);
    s.start();
    await vi.waitFor(() => expect(beats.length).toBeGreaterThan(0));
    s.stop();
    beats.length = 0;
    s.reportPhase('planning');
    await new Promise((r) => setTimeout(r, 40));
    expect(beats).toEqual([]);
  });
});
