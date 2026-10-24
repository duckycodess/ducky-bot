import { readFile, realpath } from 'node:fs/promises';
import type {
  HerdrClient, PaneProcessInfo, PromptGuard, PromptGuardContext, PromptGuardTarget,
  PromptGuardVerdict,
} from '@ducky/adapters';

/**
 * Memory headroom of the cgroup the AGENT is actually in, checked immediately
 * before model work is sent to it.
 *
 * The account guard in `memory-headroom.ts` reads one slice and runs before a
 * claim. That is not the agent's own position: Herdr owns the agent's process
 * outside the executor's unit, a wrapper may have moved it into a tighter scope
 * of its own, and different foreground processes of one pane can sit in
 * different cgroups. So this finds the owned pane's live foreground processes
 * through Herdr, reads each process's own unified cgroup from `/proc`, and
 * evaluates `memory.current` against `memory.high` and `memory.max` at that
 * cgroup AND at every ancestor up to the cgroup-v2 mount. The tightest
 * remaining free bytes governs. Siblings are counted for free: an ancestor's
 * `memory.current` already includes them.
 *
 * What it does NOT claim: it is a check at one instant, not a reservation. Two
 * agents could pass it together, and memory can move after it. It is not
 * continuous enforcement either. The reserves are operator estimates, and the
 * full sum is required at EVERY level, which is deliberately conservative.
 *
 * FAIL CLOSED, throughout. Anything unreadable, malformed, unsafe, overflowing,
 * moved, replaced or unproven is a refusal -- never a pass, never "unlimited".
 * There is no fallback to the executor's, the account's, a server's or any
 * hard-coded service's cgroup.
 */

/** The only filesystem operations the guard performs. Injected so tests need no real /proc. */
export interface ProcFs {
  readText(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
}

export const realProcFs: ProcFs = {
  readText: (p) => readFile(p, 'utf8'),
  realpath: (p) => realpath(p),
};

export interface AgentGuardReserves {
  readonly engineeringBytes: number;
  readonly providerBytes: number;
  readonly notificationBytes: number;
}

export interface AgentGuardDeps {
  readonly herdr: Pick<HerdrClient, 'paneProcessInfo'>;
  /** The UID Ducky runs as. Every foreground process must belong to it, really and effectively. */
  readonly uid: number;
  readonly reserves: AgentGuardReserves;
  readonly fs?: ProcFs;
  readonly procRoot?: string;
  /** Where the unified hierarchy is mounted. */
  readonly cgroupMount?: string;
}

const I64_MAX = 2n ** 63n - 1n;
const SEGMENT = /^[A-Za-z0-9_.@:\\-]{1,255}$/;

const refuse = (reason: string): PromptGuardVerdict => ({ ok: false, reason });

class Refusal extends Error {}
const fail = (reason: string): never => {
  throw new Refusal(reason);
};

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';

/** A plain non-negative decimal integer that fits a signed 64-bit value, exactly. */
function exactInt(raw: string, what: string): bigint {
  const t = raw.trim();
  if (!/^(0|[1-9]\d{0,18})$/.test(t)) return fail(`${what} was not a plain non-negative integer`);
  const v = BigInt(t);
  return v > I64_MAX ? fail(`${what} was out of range`) : v;
}

/** `max` is the kernel's word for no limit; anything else must be an exact integer. */
function limit(raw: string, what: string): bigint | 'max' {
  return raw.trim() === 'max' ? 'max' : exactInt(raw, what);
}

/** The path of a process's unified cgroup, rejecting anything that is not a plain one-line v2 entry. */
export function parseUnifiedCgroup(raw: string): string {
  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length !== 1) return fail('the process is not in exactly one unified cgroup entry');
  const line = lines[0]!;
  if (!line.startsWith('0::/')) return fail('the process cgroup is not a cgroup-v2 unified entry');
  const p = line.slice(3);
  if (p.includes('\0') || p.endsWith(' (deleted)')) return fail('the process cgroup path is deleted or malformed');
  if (p === '/') return p;
  const segments = p.slice(1).split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || !SEGMENT.test(seg)) {
      return fail('the process cgroup path has an unsafe segment');
    }
  }
  return p;
}

interface ProcSnapshot {
  readonly pid: number;
  readonly startTime: string;
  readonly cgroupPath: string;
}

/** Fields of /proc/<pid>/stat after the parenthesised command name (which may contain anything). */
function parseStat(raw: string, pid: number): { state: string; pgrp: number; startTime: string } {
  raw = raw.trimEnd();
  const close = raw.lastIndexOf(')');
  const open = raw.indexOf('(');
  if (open < 0 || close < open || Number(raw.slice(0, open).trim()) !== pid) {
    return fail('the process stat record did not match the process');
  }
  const rest = raw.slice(close + 2).split(' ');
  const state = rest[0];
  const pgrp = Number(rest[2]);
  const startTime = rest[19];
  if (!state || !Number.isSafeInteger(pgrp) || !startTime || !/^\d+$/.test(startTime)) {
    return fail('the process stat record was malformed');
  }
  return { state, pgrp, startTime };
}

function parseUids(raw: string): number[] {
  const line = raw.split('\n').find((l) => l.startsWith('Uid:'));
  const ids = line?.slice(4).trim().split(/\s+/) ?? [];
  if (ids.length !== 4 || !ids.every((i) => /^\d{1,10}$/.test(i))) return fail('the process owner was unreadable');
  return ids.map(Number);
}

function validPids(info: PaneProcessInfo, paneId: string): { pgid: number; pids: number[] } {
  if (info.pane_id !== paneId) return fail('Herdr answered for a different pane');
  const pgid = info.foreground_process_group_id;
  if (typeof pgid !== 'number' || !Number.isSafeInteger(pgid) || pgid <= 0) {
    return fail('the pane reported no foreground process group');
  }
  const pids = info.foreground_processes.map((p) => p.pid);
  if (pids.length === 0) return fail('the pane reported no foreground process');
  if (pids.some((p) => !Number.isSafeInteger(p) || p <= 0) || new Set(pids).size !== pids.length) {
    return fail('the pane reported malformed foreground processes');
  }
  return { pgid, pids: [...pids].sort((a, b) => a - b) };
}

/** `/a/b/c` -> ['/a', '/a/b', '/a/b/c']: every node that bounds a process, leaf last. */
const nodesOf = (cgroupPath: string): string[] => {
  if (cgroupPath === '/') return [];
  const parts = cgroupPath.slice(1).split('/');
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
};

export function createAgentPromptGuard(deps: AgentGuardDeps): PromptGuard {
  const fs = deps.fs ?? realProcFs;
  const procRoot = deps.procRoot ?? '/proc';
  const mount = deps.cgroupMount ?? '/sys/fs/cgroup';
  const required =
    BigInt(deps.reserves.engineeringBytes) +
    BigInt(deps.reserves.providerBytes) +
    BigInt(deps.reserves.notificationBytes);

  /** The cgroup-v2 mount must be where we think, rooted at the real hierarchy root. */
  async function verifyMount(): Promise<void> {
    const mountinfo = await fs.readText(`${procRoot}/self/mountinfo`);
    const entry = mountinfo.split('\n').find((l) => {
      const sep = l.indexOf(' - ');
      return sep >= 0 && l.slice(sep + 3).startsWith('cgroup2 ');
    });
    if (!entry) return fail('no cgroup-v2 mount was found');
    const fields = entry.split(' ');
    if (fields[3] !== '/' || fields[4] !== mount) {
      return fail('the cgroup-v2 mount is not the expected unrooted hierarchy');
    }
    if ((await fs.realpath(mount)) !== mount) return fail('the cgroup mount is reached through a link');
  }

  async function snapshot(pid: number, pgid: number): Promise<ProcSnapshot> {
    const base = `${procRoot}/${pid}`;
    const stat = parseStat(await fs.readText(`${base}/stat`), pid);
    if (stat.state === 'Z' || stat.state === 'X') return fail('a foreground process is not alive');
    if (stat.pgrp !== pgid) return fail('a process is not in the pane foreground group');
    if (!parseUids(await fs.readText(`${base}/status`)).every((u) => u === deps.uid)) {
      return fail('a foreground process belongs to a different user');
    }
    return { pid, startTime: stat.startTime, cgroupPath: parseUnifiedCgroup(await fs.readText(`${base}/cgroup`)) };
  }

  async function verifyMembership(snap: ProcSnapshot): Promise<void> {
    if (snap.cgroupPath === '/') return;
    const dir = `${mount}${snap.cgroupPath}`;
    if ((await fs.realpath(dir)) !== dir) return fail('a process cgroup is reached through a link');
    const members = (await fs.readText(`${dir}/cgroup.procs`)).split('\n').filter(Boolean);
    if (!members.includes(String(snap.pid))) return fail('a process is not a member of the cgroup it reports');
  }

  /** One node's own usage and ceiling, or `skipped` when memory is provably not enabled there. */
  async function readNode(node: string, parent: string): Promise<{ free: bigint } | 'unlimited' | 'skipped'> {
    const dir = `${mount}${node}`;
    const files = ['memory.current', 'memory.max', 'memory.high'];
    const read = await Promise.all(
      files.map((f) => fs.readText(`${dir}/${f}`).then((t) => ({ t }), (e: unknown) => ({ e }))),
    );
    const missing = read.filter((r) => 'e' in r && isEnoent(r.e)).length;
    if (read.some((r) => 'e' in r && !isEnoent(r.e))) return fail('a memory file could not be read');
    if (missing === files.length) {
      // Genuinely absent files are acceptable only when the PARENT says memory
      // is not enabled for its children; otherwise they are simply missing.
      const parentDir = parent === '' ? mount : `${mount}${parent}`;
      let controllers: string;
      try {
        controllers = await fs.readText(`${parentDir}/cgroup.subtree_control`);
      } catch {
        return fail('the memory controller state of an ancestor could not be read');
      }
      if (controllers.split(/\s+/).includes('memory')) {
        return fail('memory is enabled for a cgroup whose memory files are missing');
      }
      return 'skipped';
    }
    if (missing > 0) return fail('a cgroup has only some of its memory files');

    const [cur, max, high] = read.map((r) => ('t' in r ? r.t : '')) as [string, string, string];
    const current = exactInt(cur, 'memory.current');
    const ceilings = [limit(max, 'memory.max'), limit(high, 'memory.high')].filter(
      (l): l is bigint => l !== 'max',
    );
    if (ceilings.length === 0) return 'unlimited';
    const ceiling = ceilings.reduce((a, b) => (a < b ? a : b));
    return { free: ceiling - current };
  }

  async function evaluate(target: PromptGuardTarget, ctx: PromptGuardContext): Promise<PromptGuardVerdict> {
    await verifyMount();

    // 1. Who is in the pane, right now.
    const first = await deps.herdr.paneProcessInfo(target.paneId);
    if (!first) return fail('Herdr has no such pane');
    const { pgid, pids } = validPids(first, target.paneId);

    // 2. Each foreground process: owner, group, start time and OWN cgroup.
    const snaps: ProcSnapshot[] = [];
    for (const pid of pids) {
      const snap = await snapshot(pid, pgid);
      await verifyMembership(snap);
      snaps.push(snap);
    }

    // 3. Every node from each process's cgroup up to the mount, evaluated once
    //    each, but BOUNDED PER PROCESS: a process whose own chain has no finite
    //    limit anywhere is unproven no matter how tightly a sibling process is
    //    bounded, so one bounded foreground process can never vouch for another.
    const results = new Map<string, { free: bigint } | 'unlimited' | 'skipped'>();
    for (const node of [...new Set(snaps.flatMap((s) => nodesOf(s.cgroupPath)))].sort()) {
      results.set(node, await readNode(node, node.slice(0, node.lastIndexOf('/'))));
    }
    let tightest: bigint | undefined;
    for (const snap of snaps) {
      let bounded = false;
      for (const node of nodesOf(snap.cgroupPath)) {
        const r = results.get(node);
        if (typeof r !== 'object') continue;
        bounded = true;
        if (tightest === undefined || r.free < tightest) tightest = r.free;
      }
      if (!bounded) {
        return fail('a foreground process has no finite memory limit at its cgroup or any ancestor');
      }
    }
    if (tightest === undefined) return fail('no finite memory limit bounds the agent');

    // 4. The sandwich: nothing about WHO this is may have changed during the reads.
    for (const before of snaps) {
      const after = await snapshot(before.pid, pgid);
      if (after.startTime !== before.startTime || after.cgroupPath !== before.cgroupPath) {
        return fail('a foreground process was replaced or moved while its headroom was read');
      }
    }
    const second = await deps.herdr.paneProcessInfo(target.paneId);
    if (!second) return fail('the pane disappeared while its headroom was read');
    const again = validPids(second, target.paneId);
    if (again.pgid !== pgid || again.pids.join(',') !== pids.join(',')) {
      return fail('the pane foreground processes changed while its headroom was read');
    }
    const still = await ctx.proveAgent();
    if (
      !still ||
      still.paneId !== target.paneId ||
      still.agentName !== target.agentName ||
      still.workspaceId !== target.workspaceId
    ) {
      return fail('the agent identity could not be re-proved after the headroom was read');
    }

    if (tightest < required) {
      const mib = (b: bigint): string => (b / 1048576n).toString();
      const neededMib = ((required + 1048575n) / 1048576n).toString();
      return refuse(
        `${tightest < 0n ? '-' + mib(-tightest) : mib(tightest)} MiB free at the tightest cgroup level, ` +
          `${neededMib} MiB needed (engineering, provider and notification reserves)`,
      );
    }
    return { ok: true };
  }

  return async (target, ctx) => {
    try {
      return await evaluate(target, ctx);
    } catch (err) {
      // A Refusal carries owner-safe wording of its own. Anything else (a
      // thrown Herdr error, an unexpected shape) is reported generically so no
      // path or raw message is carried into a log line.
      return refuse(err instanceof Refusal ? err.message : 'the agent memory headroom could not be proven');
    }
  };
}
