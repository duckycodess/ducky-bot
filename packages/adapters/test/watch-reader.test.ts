import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WATCH_API_MAX_BUFFER, checkCommandAllowed } from '@ducky/contracts';
import { GhWatchReader, classifyGhFailure } from '../src/github/watch-reader.js';
import { GH_API_OPERATIONS, GH_OPERATIONS } from '../src/github/gh-cli.js';
import { UnavailableAssistantWatchReader, WatchReadError } from '../src/github/watch.port.js';
import type { RunResult } from '../src/process/run.js';

const REF = { owner: 'acme', repo: 'demo' };
const T = '2026-10-01T00:00:00Z';

type Reply = Partial<RunResult> & { json?: unknown };

/** A reader whose spawn seam records every argv and answers from a script. */
function harness(replies: Reply[], options: { discovery?: boolean } = {}) {
  const argvs: string[][] = [];
  const seen: { timeoutMs: number; maxBuffer: number | undefined }[] = [];
  const reader = new GhWatchReader({
    ...(options.discovery ? { discovery: true } : {}),
    run: async (_cmd, args, opts) => {
      argvs.push([...args]);
      seen.push({ timeoutMs: opts.timeoutMs, maxBuffer: opts.maxBuffer });
      const r = replies.shift() ?? { json: [] };
      return { code: r.code ?? 0, stdout: r.stdout ?? JSON.stringify(r.json ?? []), stderr: r.stderr ?? '' };
    },
  });
  return { reader, argvs, seen };
}

const pull = (n: number, over: Record<string, unknown> = {}) => ({
  number: n, title: `PR ${n}`, state: 'open', created_at: T, updated_at: T, closed_at: null, merged_at: null, ...over,
});

describe('the watch reader runs only typed GET shapes through the policy', () => {
  it('builds `gh api --method GET <canonical endpoint>` for each surface, bounded and timed', async () => {
    const h = harness([
      { json: { full_name: 'acme/demo', default_branch: 'main', archived: false, fork: false, pushed_at: T } },
      { json: [pull(1)] },
      { json: [{ id: 7, state: 'APPROVED', submitted_at: T, body: 'ok' }] },
      { json: [{ number: 2, title: 'i', state: 'open', created_at: T, updated_at: T }] },
      { json: { total_count: 1, workflow_runs: [{ id: 9, name: 'b', head_branch: 'main', status: 'completed', conclusion: 'success', created_at: T, updated_at: T }] } },
      { json: [{ id: 3, tag_name: 'v1', name: 'One', draft: false, created_at: T, published_at: T }] },
      { json: [{ sha: 'abcdef1', commit: { message: 'm\nbody', committer: { date: T } } }] },
    ]);
    await h.reader.repository(REF);
    await h.reader.pulls(REF, 2);
    await h.reader.pullReviews(REF, 1, 1);
    await h.reader.issues(REF, 1);
    await h.reader.runs(REF, 'main', 1);
    await h.reader.releases(REF, 1);
    await h.reader.commits(REF, 'main', 1);
    expect(h.argvs.map((a) => a[3])).toEqual([
      'repos/acme/demo',
      'repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=10&page=2',
      'repos/acme/demo/pulls/1/reviews?per_page=10&page=1',
      'repos/acme/demo/issues?state=all&sort=updated&direction=desc&per_page=10&page=1',
      'repos/acme/demo/actions/runs?branch=main&per_page=10&page=1',
      'repos/acme/demo/releases?per_page=10&page=1',
      'repos/acme/demo/commits?sha=main&per_page=30&page=1',
    ]);
    for (const a of h.argvs) {
      expect(a.slice(0, 3)).toEqual(['api', '--method', 'GET']);
      expect(a).toHaveLength(4);
      expect(checkCommandAllowed('gh', a)).toBeUndefined();
    }
    for (const s of h.seen) {
      expect(s.timeoutMs).toBeGreaterThan(0);
      expect(s.maxBuffer).toBe(WATCH_API_MAX_BUFFER);
    }
  });

  it('never runs an argv the policy would refuse', async () => {
    const h = harness([]);
    // An owner that is a traversal never reaches a subprocess.
    await expect(h.reader.pulls({ owner: '..', repo: 'demo' }, 1)).rejects.toMatchObject({ code: 'window_exceeded' });
    await expect(h.reader.runs(REF, '../../x', 1)).rejects.toBeInstanceOf(WatchReadError);
    expect(h.argvs).toEqual([]);
  });

  it('stops at the page caps with an exceeded window, never a request', async () => {
    const h = harness([]);
    await expect(h.reader.pulls(REF, 51)).rejects.toMatchObject({ code: 'window_exceeded' });
    await expect(h.reader.pullReviews(REF, 1, 11)).rejects.toMatchObject({ code: 'window_exceeded' });
    // The existing commits builder stops at three pages; that is a window, not a failure.
    await expect(h.reader.commits(REF, 'main', 4)).rejects.toMatchObject({ code: 'window_exceeded' });
    expect(h.argvs).toEqual([]);
  });

  it('maps pull requests, marking a merged one, and reports a full page as possibly more', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => pull(i + 1, i === 0 ? { state: 'closed', merged_at: T, closed_at: T } : {}));
    const h = harness([{ json: rows }, { json: rows.slice(0, 3) }]);
    const full = await h.reader.pulls(REF, 1);
    expect(full.items[0]).toMatchObject({ state: 'merged', mergedAt: T, closedAt: T });
    expect(full.hasMore).toBe(true);
    expect(full.windowStamp).toBe(T);
    expect((await h.reader.pulls(REF, 2)).hasMore).toBe(false);
  });

  it('drops pull requests from the issue listing but counts the RAW page for hasMore', async () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      number: i + 1, title: 't', state: 'open', created_at: T, updated_at: '2026-10-02T00:00:00Z',
      ...(i < 9 ? { pull_request: { url: 'u' } } : {}),
    }));
    const h = harness([{ json: raw }]);
    const page = await h.reader.issues(REF, 1);
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.windowStamp).toBe('2026-10-02T00:00:00Z');
  });

  it('reports the provider total of a runs page and the creation time of its last row', async () => {
    const h = harness([{ json: { total_count: 41, workflow_runs: [{ id: 1, created_at: T }] } }]);
    const page = await h.reader.runs(REF, 'main', 1);
    expect(page.total).toBe(41);
    expect(page.windowStamp).toBe(T);
    expect(page.items[0]).toMatchObject({ id: '1', status: '', conclusion: null, updatedAt: null });
  });

  it('keeps a draft a draft and bounds a review body', async () => {
    const h = harness([
      { json: [{ id: 1, tag_name: 'v1', draft: true, created_at: T, published_at: null }] },
      { json: [{ id: 1, state: 'COMMENTED', body: 'x'.repeat(5_000) }] },
    ]);
    expect((await h.reader.releases(REF, 1)).items[0]).toMatchObject({ draft: true, publishedAt: null });
    expect((await h.reader.pullReviews(REF, 1, 1)).items[0]!.body).toHaveLength(2_000);
  });
});

describe('the repository read checks identity', () => {
  it('returns the facts when the name is the one asked for, in any case', async () => {
    const h = harness([{ json: { full_name: 'Acme/Demo', default_branch: 'trunk', archived: true, fork: true, pushed_at: null } }]);
    expect(await h.reader.repository(REF)).toEqual({
      fullName: 'Acme/Demo', defaultBranch: 'trunk', archived: true, fork: true, pushedAt: null,
    });
  });

  it('blocks a renamed or transferred repository instead of silently retargeting', async () => {
    const h = harness([{ json: { full_name: 'other/renamed', default_branch: 'main' } }]);
    await expect(h.reader.repository(REF)).rejects.toMatchObject({ code: 'identity_changed' });
  });
});

describe('failures are short codes, never provider text', () => {
  it.each([
    ['gh: Not Found (HTTP 404)', 'not_found'],
    ['gh: Bad credentials (HTTP 401)', 'auth'],
    ['gh: Resource not accessible by personal access token (HTTP 403)', 'auth'],
    ['gh: API rate limit exceeded for user ID 1 (HTTP 403)', 'rate_limited'],
    ['gh: You have exceeded a secondary rate limit (HTTP 403)', 'rate_limited'],
    ['gh: HTTP 429', 'rate_limited'],
    ['gh: Server Error (HTTP 502)', 'unavailable'],
    ['', 'unavailable'],
  ])('%s -> %s', (stderr, code) => {
    expect(classifyGhFailure(stderr).code).toBe(code);
  });

  it('a non-zero exit is a failure even when stdout looks like an empty page', async () => {
    const h = harness([{ code: 1, stdout: '[]', stderr: 'gh: Not Found (HTTP 404)' }]);
    await expect(h.reader.pulls(REF, 1)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses an unreadable body, a wrong shape and a cut-off body', async () => {
    const h = harness([
      { stdout: 'not json' },
      { json: { surprise: true } },
      { stdout: `[${'1,'.repeat(WATCH_API_MAX_BUFFER / 2)}` },
      { json: Array.from({ length: 11 }, (_, i) => pull(i + 1)) },
    ]);
    await expect(h.reader.pulls(REF, 1)).rejects.toMatchObject({ code: 'malformed' });
    await expect(h.reader.pulls(REF, 1)).rejects.toMatchObject({ code: 'malformed' });
    await expect(h.reader.pulls(REF, 1)).rejects.toMatchObject({ code: 'oversized' });
    // A longer page than per_page asked for is not a longer window.
    await expect(h.reader.pulls(REF, 1)).rejects.toMatchObject({ code: 'malformed' });
  });

  it('never carries stderr text in the error', async () => {
    // Built at run time so no token-shaped literal sits in the source.
    const token = ['gh', 'p_', 'a'.repeat(36)].join('');
    const h = harness([{ code: 1, stderr: `gh: Not Found (HTTP 404) token ${token}` }]);
    const err = await h.reader.pulls(REF, 1).then(() => new Error('no failure'), (e: unknown) => e as Error);
    expect(String(err.message)).not.toMatch(/ghp_|Not Found/);
  });
});

describe('discovery is off unless frozen configuration turned it on', () => {
  it('refuses without a request', async () => {
    const h = harness([]);
    expect(h.reader.capabilities.discovery).toBe(false);
    await expect(h.reader.discover(1)).rejects.toMatchObject({ code: 'not_enabled' });
    expect(h.argvs).toEqual([]);
  });

  it('reads one bounded page when enabled', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ full_name: `acme/r${i}`, owner: { login: 'acme', type: 'Organization' }, pushed_at: T }));
    const h = harness([{ json: rows }], { discovery: true });
    expect(h.reader.capabilities.discovery).toBe(true);
    const page = await h.reader.discover(1);
    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(h.argvs[0]![3]).toBe(
      'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page=1',
    );
    await expect(h.reader.discover(6)).rejects.toMatchObject({ code: 'window_exceeded' });
  });
});

describe('the unavailable reader observes nothing', () => {
  it('declares no capability and refuses every read', async () => {
    const r = new UnavailableAssistantWatchReader();
    expect(r.capabilities.observableKinds).toEqual([]);
    expect(r.capabilities.discovery).toBe(false);
    await expect(r.pulls()).rejects.toMatchObject({ code: 'not_enabled' });
  });
});

describe('only the watch adapter names the watch endpoint builders', () => {
  const SRC = join(__dirname, '..', '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      if (n === 'node_modules' || n === 'dist') return [];
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });

  it('keeps `watchEndpoint` out of every other source file', () => {
    const users = walk(SRC)
      .filter((f) => !f.includes(`${join('/test/')}`) && !f.endsWith('.d.ts'))
      .filter((f) => /\bwatchEndpoint\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
      .sort();
    expect(users).toEqual([
      join('adapters', 'src', 'github', 'watch-reader.ts'),
      join('contracts', 'src', 'github-watch.ts'),
    ]);
  });

  it('leaves the engineering reader with the one commits `api` shape and no other', () => {
    expect(Object.keys(GH_API_OPERATIONS)).toEqual(['commits']);
    for (const build of Object.values(GH_OPERATIONS)) expect(build(REF, 1)[0]).not.toBe('api');
  });

  it('builds no `api` argv anywhere else', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.includes('/test/') && !f.endsWith('.d.ts'))
      .filter((f) => /['"]api['"]\s*,\s*['"]--method['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
      .sort();
    expect(offenders).toEqual([
      join('adapters', 'src', 'github', 'gh-cli.ts'),
      join('adapters', 'src', 'github', 'watch-reader.ts'),
    ]);
  });
});
