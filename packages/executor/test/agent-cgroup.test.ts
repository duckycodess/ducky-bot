import { describe, expect, it } from 'vitest';
import type { PaneProcessInfo, PromptGuardTarget } from '@ducky/adapters';
import { createAgentPromptGuard, parseUnifiedCgroup, type ProcFs } from '../src/agent-cgroup.js';

/**
 * The agent's OWN cgroup chain, against a fake /proc and cgroup tree.
 *
 * The shapes echo what was observed read-only on this host -- a pane whose
 * wrapper and agent are both in the foreground group yet sit in DIFFERENT
 * cgroups, under ancestors with different ceilings and different usage -- but
 * nothing here depends on those names. It is interface evidence, not a Pi
 * runtime probe.
 */
const MIB = 1048576;
const GIB = 1024 * MIB;
const UID = 1003;
const PANE = 'wA:p1';
const TARGET: PromptGuardTarget = { agentName: 'ducky-pi-demo', workspaceId: 'wA', paneId: PANE };
const MOUNT = '/sys/fs/cgroup';
const RESERVES = { engineeringBytes: 2 * GIB, providerBytes: 512 * MIB, notificationBytes: 512 * MIB }; // 3 GiB

const enoent = (p: string): Error => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });

class FakeProc implements ProcFs {
  readonly files = new Map<string, string>();
  readonly linked = new Set<string>();
  readonly reads: string[] = [];
  /** Lets a test change what a path says on its Nth read, modelling a race. */
  onRead = new Map<string, (n: number) => string | undefined>();
  private counts = new Map<string, number>();

  async readText(p: string): Promise<string> {
    this.reads.push(p);
    const n = (this.counts.get(p) ?? 0) + 1;
    this.counts.set(p, n);
    const hook = this.onRead.get(p)?.(n);
    if (hook !== undefined) return hook;
    const v = this.files.get(p);
    if (v === undefined) throw enoent(p);
    return v;
  }

  async realpath(p: string): Promise<string> {
    return this.linked.has(p) ? `${p}.real` : p;
  }

  proc(pid: number, o: { pgrp?: number; start?: string; uid?: number[]; cgroup: string; state?: string; comm?: string }): void {
    const comm = o.comm ?? 'pi';
    // A stat line: pid (comm) state ppid pgrp session tty tpgid flags ... starttime is field 22.
    const rest = ['1', String(o.pgrp ?? 500), '500', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', o.start ?? '12345'];
    this.files.set(`/proc/${pid}/stat`, `${pid} (${comm}) ${o.state ?? 'S'} ${rest.join(' ')} 1 2 3\n`);
    const u = (o.uid ?? [UID, UID, UID, UID]).join('\t');
    this.files.set(`/proc/${pid}/status`, `Name:\t${comm}\nUid:\t${u}\nGid:\t1\n`);
    this.files.set(`/proc/${pid}/cgroup`, `${o.cgroup}\n`);
  }

  cgroup(
    p: string,
    o: { current: string | number; max?: string | number; high?: string | number; procs?: number[]; omitMemory?: boolean; partial?: boolean },
  ): void {
    const dir = `${MOUNT}${p}`;
    this.files.set(`${dir}/cgroup.procs`, `${(o.procs ?? []).join('\n')}\n`);
    if (o.omitMemory) return;
    this.files.set(`${dir}/memory.current`, `${o.current}\n`);
    if (!o.partial) this.files.set(`${dir}/memory.max`, `${o.max ?? 'max'}\n`);
    this.files.set(`${dir}/memory.high`, `${o.high ?? 'max'}\n`);
  }

  /** Removes a node's memory files, as on a cgroup where the controller is not enabled. */
  dropMemory(p: string): void {
    for (const f of ['memory.current', 'memory.max', 'memory.high']) this.files.delete(`${MOUNT}${p}/${f}`);
  }

  subtree(p: string, controllers: string): void {
    this.files.set(`${p === '' ? MOUNT : MOUNT + p}/cgroup.subtree_control`, `${controllers}\n`);
  }
}

const info = (over: Partial<PaneProcessInfo> = {}): PaneProcessInfo => ({
  pane_id: PANE,
  shell_pid: 400,
  foreground_process_group_id: 500,
  foreground_processes: [{ pid: 500, name: 'agent' }],
  ...over,
});

const MOUNTINFO = `36 25 0:30 / ${MOUNT} rw,nosuid,nodev,noexec shared:4 - cgroup2 cgroup2 rw,nsdelegate\n`;

/** A tree like the host's: a delegated scope under a slice under the user slice. */
function standard(fp = new FakeProc()): FakeProc {
  fp.files.set('/proc/self/mountinfo', MOUNTINFO);
  fp.proc(500, { cgroup: '0::/user.slice/user-1003.slice/work.slice/agent.scope' });
  fp.cgroup('/user.slice', { current: 30 * GIB });
  fp.cgroup('/user.slice/user-1003.slice', { current: 10 * GIB, max: 16 * GIB, high: 14 * GIB });
  fp.cgroup('/user.slice/user-1003.slice/work.slice', { current: 8 * GIB, max: 16 * GIB, high: 15 * GIB });
  fp.cgroup('/user.slice/user-1003.slice/work.slice/agent.scope', { current: 13 * MIB, max: 8 * GIB, high: 7 * GIB, procs: [500] });
  fp.subtree('', 'cpu memory pids');
  return fp;
}

function guardFor(fp: FakeProc, infos: PaneProcessInfo | undefined | (() => PaneProcessInfo | undefined) = info(), reserves = RESERVES) {
  const calls = { processInfo: 0 };
  const herdr = {
    paneProcessInfo: async () => {
      calls.processInfo += 1;
      return typeof infos === 'function' ? infos() : infos;
    },
  };
  const guard = createAgentPromptGuard({ herdr, uid: UID, reserves, fs: fp });
  const run = (proveAgent: () => Promise<PromptGuardTarget | undefined> = async () => TARGET) =>
    guard(TARGET, { proveAgent });
  return { run, calls };
}

const refused = async (fp: FakeProc, infos?: Parameters<typeof guardFor>[1], why?: RegExp) => {
  const v = await guardFor(fp, infos).run();
  expect(v.ok, JSON.stringify(v)).toBe(false);
  if (why && !v.ok) expect(v.reason).toMatch(why);
};

describe('headroom at the agent cgroup and every ancestor', () => {
  it('passes when every level has room', async () => {
    expect(await guardFor(standard()).run()).toEqual({ ok: true });
  });

  it('is governed by the TIGHTEST remaining free bytes, not the smallest configured ceiling', async () => {
    // Free by level: scope 7G-13M, work 15G-8G=7G, user 14G-10G=4G. The scope has the
    // smallest ceiling; the user slice has the least room left.
    const fp = standard();
    const need = (gib: number) => ({ engineeringBytes: gib * GIB - 1024 * MIB, providerBytes: 512 * MIB, notificationBytes: 512 * MIB });
    expect((await guardFor(fp, info(), need(4)).run()).ok).toBe(true); // exactly 4 GiB needed
    const tight = await guardFor(fp, info(), { ...need(4), engineeringBytes: need(4).engineeringBytes + 1 }).run();
    expect(tight.ok).toBe(false);
    expect(!tight.ok && tight.reason).toMatch(/MiB free at the tightest cgroup level/);
  });

  it('counts siblings through the ancestor usage, so a roomy leaf under a full parent is refused', async () => {
    const fp = standard();
    fp.cgroup('/user.slice/user-1003.slice/work.slice', { current: Math.floor(14.9 * GIB), max: 16 * GIB, high: 15 * GIB });
    await refused(fp, info(), /MiB free/);
  });

  it('honours memory.high and memory.max independently at each level', async () => {
    const onlyHigh = standard();
    onlyHigh.cgroup('/user.slice/user-1003.slice/work.slice/agent.scope', { current: 7 * GIB, max: 'max', high: 7 * GIB + MIB, procs: [500] });
    await refused(onlyHigh, info(), /MiB free/);
    const onlyMax = standard();
    onlyMax.cgroup('/user.slice/user-1003.slice/work.slice/agent.scope', { current: 7 * GIB, max: 7 * GIB + MIB, high: 'max', procs: [500] });
    await refused(onlyMax, info(), /MiB free/);
  });

  it('allows unlimited intermediate nodes only when a finite ancestor bounds them', async () => {
    const ok = standard();
    ok.cgroup('/user.slice/user-1003.slice/work.slice', { current: 8 * GIB });
    ok.cgroup('/user.slice/user-1003.slice/work.slice/agent.scope', { current: 13 * MIB, procs: [500] });
    expect((await guardFor(ok).run()).ok).toBe(true);

    const none = standard();
    none.cgroup('/user.slice/user-1003.slice', { current: 10 * GIB });
    none.cgroup('/user.slice/user-1003.slice/work.slice', { current: 8 * GIB });
    none.cgroup('/user.slice/user-1003.slice/work.slice/agent.scope', { current: 13 * MIB, procs: [500] });
    await refused(none, info(), /no finite memory limit/);
  });

  it('requires EVERY foreground process to be bounded: a tight sibling cannot vouch for an unbounded one', async () => {
    const fp = standard();
    // Process 500 is in a finite chain with plenty of room. Process 501 sits in a
    // branch where nothing, at any level, has a finite limit.
    fp.proc(501, { cgroup: '0::/free.slice/loose.service' });
    fp.cgroup('/free.slice', { current: 40 * GIB });
    fp.cgroup('/free.slice/loose.service', { current: GIB, procs: [501] });
    const mixed = info({ foreground_processes: [{ pid: 500 }, { pid: 501 }] });
    await refused(fp, mixed, /no finite memory limit/);
    // ...and a process in the root cgroup is the same case.
    const rooted = standard();
    rooted.proc(501, { cgroup: '0::/' });
    await refused(rooted, mixed, /no finite memory limit/);
    // The bounded process alone still passes, so it is the unbounded one that refuses.
    expect((await guardFor(fp, info()).run()).ok).toBe(true);
  });

  it('takes the overall minimum across processes that are each bounded', async () => {
    const fp = standard();
    fp.proc(501, { cgroup: '0::/other.slice/small.service' });
    fp.cgroup('/other.slice', { current: GIB });
    fp.cgroup('/other.slice/small.service', { current: GIB, max: 2 * GIB, high: 2 * GIB, procs: [501] });
    await refused(fp, info({ foreground_processes: [{ pid: 500 }, { pid: 501 }] }), /MiB free/);
  });

  it('refuses a process in the root cgroup, which no limit bounds', async () => {
    const fp = standard();
    fp.proc(500, { cgroup: '0::/' });
    await refused(fp, info(), /no finite/);
  });

  it('checks every foreground process in its own cgroup, never the executor or the pane as a whole', async () => {
    // The wrapper sits in a roomy cgroup; the agent child sits in a tight one.
    const fp = standard();
    fp.proc(500, { cgroup: '0::/user.slice/user-1003.slice/wrapper.service' });
    fp.proc(501, { cgroup: '0::/user.slice/user-1003.slice/work.slice/agent.scope' });
    fp.cgroup('/user.slice/user-1003.slice/wrapper.service', { current: 100 * MIB, max: 16 * GIB, high: 14 * GIB, procs: [500] });
    fp.cgroup('/user.slice/user-1003.slice/work.slice/agent.scope', { current: 7 * GIB - 100 * MIB, max: 8 * GIB, high: 7 * GIB, procs: [501] });
    const two = info({ foreground_processes: [{ pid: 500 }, { pid: 501 }] });
    await refused(fp, two, /MiB free/);
    // Ask about the wrapper alone and the same tree passes: the result really
    // does follow which process is looked at.
    expect((await guardFor(fp, info()).run()).ok).toBe(true);
    // Neither the executor's own cgroup nor /proc/self/cgroup is ever read.
    expect(fp.reads.some((r) => r === '/proc/self/cgroup')).toBe(false);
  });
});

describe('a node without memory files', () => {
  it('is skipped only when the parent proves memory is not enabled for it', async () => {
    const fp = standard();
    fp.dropMemory('/user.slice/user-1003.slice/work.slice');
    fp.subtree('/user.slice/user-1003.slice', 'cpu pids');
    expect((await guardFor(fp).run()).ok).toBe(true);
  });

  it('is refused when the parent enables memory but the files are missing', async () => {
    const fp = standard();
    fp.dropMemory('/user.slice/user-1003.slice/work.slice');
    fp.subtree('/user.slice/user-1003.slice', 'cpu memory pids');
    await refused(fp, info(), /memory is enabled/);
  });

  it('is refused when the parent configuration cannot be read, or the files are only partly there', async () => {
    const unreadable = standard();
    unreadable.dropMemory('/user.slice/user-1003.slice/work.slice');
    await refused(unreadable, info(), /controller state/);

    const partial = standard();
    partial.files.delete(`${MOUNT}/user.slice/user-1003.slice/work.slice/memory.max`);
    await refused(partial, info(), /only some/);
  });

  it('refuses a read error that is not a plain absence', async () => {
    const fp = standard();
    const read = fp.readText.bind(fp);
    fp.readText = async (p) => {
      if (p.endsWith('/work.slice/memory.current')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return read(p);
    };
    await refused(fp, info(), /could not be read/);
  });
});

describe('numbers', () => {
  const bad = ['-1', '1e9', '0123', '', '0x10', ' ', '9223372036854775808', '99999999999999999999', 'MAX', '12 34', '1.5'];
  for (const file of ['memory.current', 'memory.max', 'memory.high'] as const) {
    it(`never treats a malformed ${file} as unlimited or as room`, async () => {
      for (const value of bad) {
        const fp = standard();
        fp.files.set(`${MOUNT}/user.slice/user-1003.slice/work.slice/agent.scope/${file}`, `${value}\n`);
        const v = await guardFor(fp).run();
        expect(v.ok, `${file}=${JSON.stringify(value)}`).toBe(false);
      }
    });
  }

  it('does exact integer arithmetic past 2^53', async () => {
    const fp = standard();
    const big = 2n ** 62n;
    fp.files.set(`${MOUNT}/user.slice/user-1003.slice/work.slice/agent.scope/memory.max`, `${big}\n`);
    fp.files.set(`${MOUNT}/user.slice/user-1003.slice/work.slice/agent.scope/memory.high`, `${big}\n`);
    fp.files.set(`${MOUNT}/user.slice/user-1003.slice/work.slice/agent.scope/memory.current`, `${big - 1n}\n`);
    await refused(fp, info(), /MiB free/);
  });

  it('reports an overcommitted level as negative room rather than passing', async () => {
    const fp = standard();
    fp.cgroup('/user.slice/user-1003.slice', { current: 15 * GIB, max: 16 * GIB, high: 14 * GIB });
    const v = await guardFor(fp).run();
    expect(!v.ok && v.reason).toMatch(/^-1024 MiB free/);
  });
});

describe('who is being measured', () => {
  it('refuses a foreign or mixed owner', async () => {
    for (const uid of [[2000, 2000, 2000, 2000], [UID, 0, UID, UID], [0, UID, UID, UID]]) {
      const fp = standard();
      fp.proc(500, { cgroup: '0::/user.slice/user-1003.slice/work.slice/agent.scope', uid });
      await refused(fp, info(), /different user/);
    }
  });

  it('refuses a process outside the pane foreground group, a zombie and a mismatched record', async () => {
    const group = standard();
    group.proc(500, { cgroup: '0::/user.slice/user-1003.slice/work.slice/agent.scope', pgrp: 999 });
    await refused(group, info(), /foreground group/);
    const zombie = standard();
    zombie.proc(500, { cgroup: '0::/user.slice/user-1003.slice/work.slice/agent.scope', state: 'Z' });
    await refused(zombie, info(), /not alive/);
    const other = standard();
    other.files.set('/proc/500/stat', '777 (pi) S 1 500 500 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345\n');
    await refused(other, info(), /did not match/);
  });

  it('parses a command name that contains spaces and parentheses', async () => {
    const fp = standard();
    fp.proc(500, { cgroup: '0::/user.slice/user-1003.slice/work.slice/agent.scope', comm: 'a) S 1 2 (b' });
    expect((await guardFor(fp).run()).ok).toBe(true);
  });

  it('refuses malformed pane information', async () => {
    const fp = standard();
    await refused(fp, () => undefined, /no such pane/);
    await refused(fp, info({ pane_id: 'wB:p9' }), /different pane/);
    await refused(fp, info({ foreground_process_group_id: null }), /no foreground process group/);
    await refused(fp, info({ foreground_process_group_id: 0 }), /no foreground process group/);
    await refused(fp, info({ foreground_processes: [] }), /no foreground process/);
    await refused(fp, info({ foreground_processes: [{ pid: 0 }] }), /malformed/);
    await refused(fp, info({ foreground_processes: [{ pid: 500 }, { pid: 500 }] }), /malformed/);
  });

  it('refuses when a process is not a member of the cgroup it reports', async () => {
    const fp = standard();
    fp.cgroup('/user.slice/user-1003.slice/work.slice/agent.scope', { current: 13 * MIB, max: 8 * GIB, high: 7 * GIB, procs: [501] });
    await refused(fp, info(), /not a member/);
  });

  it('refuses a cgroup reached through a link or a mount that is not the real hierarchy', async () => {
    const link = standard();
    link.linked.add(`${MOUNT}/user.slice/user-1003.slice/work.slice/agent.scope`);
    await refused(link, info(), /link/);
    const mount = standard();
    mount.linked.add(MOUNT);
    await refused(mount, info(), /link/);

    for (const line of [
      `36 25 0:30 /sub ${MOUNT} rw - cgroup2 cgroup2 rw\n`,
      '36 25 0:30 / /elsewhere rw - cgroup2 cgroup2 rw\n',
      `36 25 0:30 / ${MOUNT} rw - cgroup cgroup rw,memory\n`,
      '',
    ]) {
      const fp = standard();
      fp.files.set('/proc/self/mountinfo', line);
      await refused(fp, info(), /cgroup-v2 mount|no cgroup-v2/);
    }
  });
});

describe('the identity sandwich', () => {
  it('refuses when a process was replaced (PID reuse) while its headroom was read', async () => {
    const fp = standard();
    fp.onRead.set('/proc/500/stat', (n) =>
      n >= 2 ? '500 (pi) S 1 500 500 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 99999\n' : undefined,
    );
    await refused(fp, info(), /replaced or moved/);
  });

  it('refuses when a process moved cgroup while its headroom was read', async () => {
    const fp = standard();
    fp.onRead.set('/proc/500/cgroup', (n) => (n >= 2 ? '0::/user.slice/user-1003.slice/elsewhere\n' : undefined));
    await refused(fp, info(), /replaced or moved/);
  });

  it('refuses when the pane foreground changed between the two looks', async () => {
    let n = 0;
    await refused(standard(), () => {
      n += 1;
      return n === 1 ? info() : info({ foreground_processes: [{ pid: 500 }, { pid: 501 }] });
    }, /changed while/);
    n = 0;
    await refused(standard(), () => (++n === 1 ? info() : undefined), /disappeared/);
    n = 0;
    await refused(standard(), () => (++n === 1 ? info() : info({ foreground_process_group_id: 600 })), /changed while/);
  });

  it('refuses when the agent cannot be re-proved, or is a different one', async () => {
    const g = guardFor(standard());
    for (const again of [undefined, { ...TARGET, paneId: 'wA:p2' }, { ...TARGET, workspaceId: 'wB' }, { ...TARGET, agentName: 'ducky-pi-other' }]) {
      const v = await g.run(async () => again);
      expect(v.ok).toBe(false);
      expect(!v.ok && v.reason).toMatch(/re-proved/);
    }
  });

  it('turns any unexpected throw into a generic refusal that leaks nothing', async () => {
    const guard = createAgentPromptGuard({
      herdr: { paneProcessInfo: async () => { throw new Error('socket /home/someone/secret/path exploded'); } },
      uid: UID, reserves: RESERVES, fs: standard(),
    });
    const v = await guard(TARGET, { proveAgent: async () => TARGET });
    expect(v).toEqual({ ok: false, reason: 'the agent memory headroom could not be proven' });
  });
});

describe('parseUnifiedCgroup', () => {
  it('accepts a plain unified entry and rejects everything else', () => {
    expect(parseUnifiedCgroup('0::/user.slice/user-1003.slice/a\\x2db.scope\n')).toBe('/user.slice/user-1003.slice/a\\x2db.scope');
    expect(parseUnifiedCgroup('0::/\n')).toBe('/');
    for (const bad of [
      '', '0::/a\n1:memory:/b\n', '1:memory:/a\n', '0::relative\n', '0::/a/../b\n', '0::/a/./b\n', '0::/a//b\n',
      '0::/a b\n', '0::/a (deleted)\n', '0::/a\0b\n', '0::/a\n0::/b\n', `0::/${'x'.repeat(300)}\n`,
    ]) {
      expect(() => parseUnifiedCgroup(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
