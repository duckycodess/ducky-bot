import { describe, expect, it } from 'vitest';
import {
  WATCH_API_DISCOVERY_MAX_PAGES, WATCH_API_MAX_PAGE, WATCH_API_REVIEWS_MAX_PAGES, WATCH_API_SURFACES,
  WatchDiscoverySchema, WatchIssuesSchema, WatchPullsSchema, WatchReleasesSchema, WatchRepositorySchema,
  WatchReviewsSchema, WatchRunsSchema, checkCommandAllowed, isCommitsApiArgv, isWatchApiArgv,
  parseWatchEndpoint, watchEndpoint, type WatchApiRequest,
} from '../src/index.js';

/**
 * The seven typed notification-watch reads, pinned to ONE canonical endpoint each.
 * Invented repository names only.
 */
const REPO = { owner: 'acme', repo: 'demo' };
const argvOf = (endpoint: string): string[] => ['api', '--method', 'GET', endpoint];

const GOOD: Record<string, WatchApiRequest> = {
  'repos/acme/demo': { surface: 'repository', ...REPO },
  'repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=10&page=3': { surface: 'pulls', ...REPO, page: 3 },
  'repos/acme/demo/pulls/42/reviews?per_page=10&page=2': { surface: 'reviews', ...REPO, number: 42, page: 2 },
  'repos/acme/demo/issues?state=all&sort=updated&direction=desc&per_page=10&page=1': { surface: 'issues', ...REPO, page: 1 },
  'repos/acme/demo/actions/runs?branch=main&per_page=10&page=1': { surface: 'runs', ...REPO, branch: 'main', page: 1 },
  'repos/acme/demo/actions/runs?branch=release%2F1.2&per_page=10&page=2': { surface: 'runs', ...REPO, branch: 'release/1.2', page: 2 },
  'repos/acme/demo/releases?per_page=10&page=1': { surface: 'releases', ...REPO, page: 1 },
  'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page=5':
    { surface: 'discovery', page: 5 },
};

describe('the notification-watch endpoint grammar', () => {
  it('builds exactly the approved canonical endpoint for each surface', () => {
    for (const [endpoint, req] of Object.entries(GOOD)) {
      expect(watchEndpoint(req)).toBe(endpoint);
      expect(parseWatchEndpoint(endpoint)).toEqual(req);
      expect(isWatchApiArgv(argvOf(endpoint)), endpoint).toBe(true);
      expect(checkCommandAllowed('gh', argvOf(endpoint)), endpoint).toBeUndefined();
    }
    // Every surface is covered by at least one example, so none can be added unpinned.
    expect(new Set(Object.values(GOOD).map((r) => r.surface))).toEqual(new Set(WATCH_API_SURFACES));
  });

  it('refuses to build what it cannot validate', () => {
    const bad: WatchApiRequest[] = [
      { surface: 'repository', owner: '..', repo: 'demo' },
      { surface: 'repository', owner: 'acme', repo: 'a..b' },
      { surface: 'repository', owner: 'a/b', repo: 'demo' },
      { surface: 'repository', owner: '{owner}', repo: 'demo' },
      { surface: 'pulls', ...REPO, page: 0 },
      { surface: 'pulls', ...REPO, page: WATCH_API_MAX_PAGE + 1 },
      { surface: 'pulls', ...REPO, page: 1.5 },
      { surface: 'reviews', ...REPO, number: 0, page: 1 },
      { surface: 'reviews', ...REPO, number: 1.5, page: 1 },
      { surface: 'reviews', ...REPO, number: 1, page: WATCH_API_REVIEWS_MAX_PAGES + 1 },
      { surface: 'runs', ...REPO, branch: '../../admin', page: 1 },
      { surface: 'runs', ...REPO, branch: 'main&per_page=100', page: 1 },
      { surface: 'runs', ...REPO, branch: '', page: 1 },
      { surface: 'runs', ...REPO, branch: '-x', page: 1 },
      { surface: 'discovery', page: 0 },
      { surface: 'discovery', page: WATCH_API_DISCOVERY_MAX_PAGES + 1 },
    ];
    for (const req of bad) expect(() => watchEndpoint(req), JSON.stringify(req)).toThrow();
  });

  it('refuses every alternate spelling, extra key and reordered query', () => {
    const refused = [
      // A different order, an extra key, a repeated key, a different sort or state.
      'repos/acme/demo/pulls?sort=updated&state=all&direction=desc&per_page=10&page=1',
      'repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=10&page=1&x=1',
      'repos/acme/demo/pulls?state=all&sort=created&direction=desc&per_page=10&page=1',
      'repos/acme/demo/pulls?state=open&sort=updated&direction=desc&per_page=10&page=1',
      'repos/acme/demo/pulls?state=all&sort=updated&direction=asc&per_page=10&page=1',
      'repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1',
      'repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=10&page=1&page=2',
      'repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=10&page=51',
      'repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=10&page=01',
      'repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=10&page=1#frag',
      'repos/acme/demo/pulls/42/reviews?per_page=100&page=1',
      'repos/acme/demo/pulls/042/reviews?per_page=10&page=1',
      'repos/acme/demo/pulls/42/reviews?per_page=10&page=11',
      'repos/acme/demo/pulls/42/comments?per_page=10&page=1',
      'repos/acme/demo/pulls/42/files?per_page=10&page=1',
      'repos/acme/demo/pulls/42?per_page=10&page=1',
      'repos/acme/demo/issues?state=all&sort=updated&direction=desc&per_page=10&page=1&labels=bug',
      'repos/acme/demo/issues/7/comments?per_page=10&page=1',
      'repos/acme/demo/actions/runs?branch=main&per_page=100&page=1',
      'repos/acme/demo/actions/runs?branch=main&per_page=10&page=1&status=completed',
      'repos/acme/demo/actions/runs?per_page=10&page=1',
      'repos/acme/demo/actions/runs?branch=%2e%2e%2f%2e%2e&per_page=10&page=1',
      'repos/acme/demo/actions/runs?branch=release%2f1&per_page=10&page=1',
      'repos/acme/demo/actions/runs?branch=%6Dain&per_page=10&page=1',
      'repos/acme/demo/actions/runs/1/logs',
      'repos/acme/demo/actions/secrets',
      'repos/acme/demo/releases?per_page=10&page=1&prerelease=false',
      'repos/acme/demo/releases/latest',
      'repos/acme/demo/releases/1/assets',
      'repos/acme/demo/contents/README.md',
      'repos/acme/demo/git/refs',
      'repos/acme/demo/hooks',
      'repos/acme/demo/collaborators',
      'repos/acme/demo/',
      'repos/acme/demo?x=1',
      'repos/../demo',
      'repos/acme/%2e%2e',
      'repos/{owner}/{repo}',
      '/repos/acme/demo',
      'https://api.github.com/repos/acme/demo',
      '//evil.example/repos/acme/demo',
      'user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=100&page=1',
      'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page=6',
      'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=30&page=1',
      'user/repos?affiliation=organization_member,collaborator,owner&sort=pushed&direction=desc&per_page=100&page=1',
      'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page=1&type=all',
      // The notifications API is NOT approved: "notification" means the typed event surfaces.
      'notifications',
      'notifications?all=true',
      'repos/acme/demo/notifications',
      'user',
      'user/orgs',
      'user/repos',
      'user/starred',
      'orgs/acme/repos',
      'graphql',
      'search/repositories?q=x',
    ];
    for (const endpoint of refused) {
      expect(parseWatchEndpoint(endpoint), endpoint).toBeUndefined();
      expect(isWatchApiArgv(argvOf(endpoint)), endpoint).toBe(false);
      expect(checkCommandAllowed('gh', argvOf(endpoint)), endpoint).toBeDefined();
    }
  });

  it('accepts only `api --method GET <endpoint>`, four words, nothing added', () => {
    const endpoint = 'repos/acme/demo/releases?per_page=10&page=1';
    const good = argvOf(endpoint);
    const refuse = (argv: readonly string[]): void => {
      expect(isWatchApiArgv(argv), argv.join(' ')).toBe(false);
      expect(checkCommandAllowed('gh', argv), argv.join(' ')).toBeDefined();
    };
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'get', 'HEAD']) {
      refuse(['api', '--method', method, endpoint]);
    }
    refuse(['api', endpoint]);
    refuse(['api', '-X', 'GET', endpoint]);
    refuse(['api', '--method=GET', endpoint]);
    for (const extra of [
      ['-f', 'title=x'], ['-F', 'title=x'], ['--field', 'a=b'], ['--raw-field', 'a=b'],
      ['--input', '-'], ['--input', '/etc/passwd'], ['-H', 'Accept: x'], ['--header', 'x'],
      ['--hostname', 'evil.example'], ['--jq', '.'], ['-q', '.'], ['--template', '{{.}}'],
      ['-t', 'x'], ['--cache', '1h'], ['--paginate'], ['--slurp'], ['--include'], ['-i'],
      ['--silent'], ['--verbose'], ['-p', 'corsair'], ['--preview', 'x'],
    ]) {
      refuse([...good, ...extra]);
      refuse(['api', '--method', 'GET', ...extra, endpoint]);
    }
    refuse(['--paginate', ...good]);
    refuse(['--hostname', 'x', ...good]);
    refuse(['api', '--method', 'GET']);
    expect(checkCommandAllowed('curl', good)?.reason).toBe('unclassified');
  });

  it('leaves the single commits shape exactly as it was, and the two shapes disjoint', () => {
    const commits = argvOf('repos/acme/demo/commits?sha=main&per_page=30&page=1');
    expect(isCommitsApiArgv(commits)).toBe(true);
    expect(isWatchApiArgv(commits)).toBe(false);
    for (const endpoint of Object.keys(GOOD)) {
      expect(isCommitsApiArgv(argvOf(endpoint)), endpoint).toBe(false);
    }
  });
});

describe('the pinned response schemas', () => {
  const t = '2026-10-01T00:00:00Z';

  it('accept the shapes GitHub returns and ignore every other key', () => {
    expect(WatchRepositorySchema.parse({
      full_name: 'acme/demo', default_branch: 'main', archived: false, fork: false, pushed_at: t, id: 1, owner: {},
    })).toMatchObject({ full_name: 'acme/demo', default_branch: 'main' });
    expect(WatchPullsSchema.parse([{
      number: 1, title: 'x', state: 'open', created_at: t, updated_at: t, closed_at: null, merged_at: null, head: {},
    }])).toHaveLength(1);
    expect(WatchReviewsSchema.parse([{ id: 5, state: 'APPROVED', submitted_at: t, body: 'ok', user: {} }])).toHaveLength(1);
    expect(WatchIssuesSchema.parse([
      { number: 2, title: 'x', state: 'open', created_at: t, updated_at: t, closed_at: null },
      { number: 3, title: 'y', state: 'open', created_at: t, updated_at: t, pull_request: { url: 'u' } },
    ])).toHaveLength(2);
    expect(WatchRunsSchema.parse({
      total_count: 1,
      workflow_runs: [{ id: 9, name: 'build', head_branch: 'main', status: 'completed', conclusion: 'success', created_at: t, updated_at: t }],
    }).total_count).toBe(1);
    expect(WatchReleasesSchema.parse([{ id: 1, tag_name: 'v1', name: null, draft: false, created_at: t, published_at: t }])).toHaveLength(1);
    expect(WatchDiscoverySchema.parse([{ full_name: 'acme/demo', owner: { login: 'acme', type: 'Organization' } }])).toHaveLength(1);
  });

  it('refuse a page longer than the page that was asked for, and malformed rows', () => {
    const pull = { number: 1, title: 'x', state: 'open', created_at: t, updated_at: t };
    expect(WatchPullsSchema.safeParse(Array.from({ length: 11 }, () => pull)).success).toBe(false);
    expect(WatchPullsSchema.safeParse([{ ...pull, state: 'weird' }]).success).toBe(false);
    expect(WatchPullsSchema.safeParse([{ ...pull, number: 0 }]).success).toBe(false);
    expect(WatchPullsSchema.safeParse([{ number: 1 }]).success).toBe(false);
    expect(WatchRunsSchema.safeParse({ workflow_runs: [] }).success).toBe(false);
    expect(WatchRunsSchema.safeParse({ total_count: -1, workflow_runs: [] }).success).toBe(false);
    expect(WatchRepositorySchema.safeParse({ full_name: 'a/b' }).success).toBe(false);
    expect(WatchDiscoverySchema.safeParse([{ full_name: 'a/b' }]).success).toBe(false);
    expect(WatchReviewsSchema.safeParse([{ id: -1, state: 'x' }]).success).toBe(false);
  });
});
