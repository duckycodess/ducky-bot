import { describe, expect, it } from 'vitest';
import {
  GH_REVIEW_SEARCH_FIELDS, checkCommandAllowed, commitsEndpoint, isCommitsApiArgv,
  isReviewSearchArgv, parseCommitsEndpoint,
} from '@ducky/contracts';
import {
  GH_API_OPERATIONS, GH_OPERATIONS, GH_SEARCH_OPERATIONS, GhCliReader,
} from '../src/github/gh-cli.js';

const REF = { owner: 'acme', repo: 'demo' };
const GOOD_ENDPOINT = 'repos/acme/demo/commits?sha=main&per_page=30&page=1';
const GOOD_API = ['api', '--method', 'GET', GOOD_ENDPOINT];

describe('the commits read: the one `gh api` call', () => {
  it('is built from validated parts and passes the central policy', () => {
    const argv = GH_API_OPERATIONS.commits(REF, 'main', 1);
    expect(argv).toEqual(GOOD_API);
    expect(checkCommandAllowed('gh', argv)).toBeUndefined();
    expect(isCommitsApiArgv(argv)).toBe(true);
  });

  it('encodes a branch with a slash and still passes', () => {
    const argv = GH_API_OPERATIONS.commits(REF, 'release/1.2', 2);
    expect(argv[3]).toBe('repos/acme/demo/commits?sha=release%2F1.2&per_page=30&page=2');
    expect(checkCommandAllowed('gh', argv)).toBeUndefined();
    expect(parseCommitsEndpoint(argv[3]!)).toMatchObject({ branch: 'release/1.2', page: 2 });
  });

  describe('gate one: the builder refuses what it cannot validate', () => {
    it.each([
      ['an owner that is a path traversal', { owner: '..', repo: 'demo' }, 'main', 1],
      ['a repo that is a path traversal', { owner: 'acme', repo: '..' }, 'main', 1],
      ['an owner with a dot-dot inside', { owner: 'a..b', repo: 'demo' }, 'main', 1],
      ['an owner with a slash', { owner: 'a/b', repo: 'demo' }, 'main', 1],
      ['a placeholder owner', { owner: '{owner}', repo: 'demo' }, 'main', 1],
      ['a traversing branch', REF, '../../admin', 1],
      ['a branch with a query smuggled in', REF, 'main&per_page=100', 1],
      ['a branch with a fragment', REF, 'main#x', 1],
      ['a branch with a space', REF, 'my branch', 1],
      ['a placeholder branch', REF, '{branch}', 1],
      ['an empty branch', REF, '', 1],
      ['a leading-dash branch', REF, '-X', 1],
      ['page zero', REF, 'main', 0],
      ['a page past the cap', REF, 'main', 99],
      ['a fractional page', REF, 'main', 1.5],
    ] as const)('%s', (_name, ref, branch, page) => {
      expect(() => GH_API_OPERATIONS.commits(ref, branch, page)).toThrow();
      expect(() => commitsEndpoint(ref.owner, ref.repo, branch, page)).toThrow();
    });

    it('refuses before any subprocess is spawned', async () => {
      const reader = new GhCliReader('/nonexistent/gh');
      await expect(reader.commits(REF, '../x', 1)).rejects.toThrow(/not allowed/);
    });
  });

  describe('gate two: the policy re-checks the finished argv from scratch', () => {
    const refuse = (argv: readonly string[]): void => {
      const refusal = checkCommandAllowed('gh', argv);
      expect(refusal, argv.join(' ')).toBeDefined();
      expect(isCommitsApiArgv(argv), argv.join(' ')).toBe(false);
    };

    it('refuses every other method', () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'get', 'HEAD']) {
        refuse(['api', '--method', method, GOOD_ENDPOINT]);
      }
      // No explicit method at all: gh would pick POST if a field were added.
      refuse(['api', GOOD_ENDPOINT]);
      refuse(['api', '-X', 'GET', GOOD_ENDPOINT]);
    });

    it('refuses fields, input, headers, hostname, jq, template, cache and pagination', () => {
      for (const extra of [
        ['-f', 'title=x'], ['-F', 'title=x'], ['--field', 'a=b'], ['--raw-field', 'a=b'],
        ['--input', '-'], ['--input', '/etc/passwd'], ['-H', 'Accept: x'], ['--header', 'x'],
        ['--hostname', 'evil.example'], ['--jq', '.'], ['-q', '.'], ['--template', '{{.}}'],
        ['-t', 'x'], ['--cache', '1h'], ['--paginate'], ['--slurp'], ['--include'], ['-i'],
        ['--silent'], ['--verbose'], ['-p', 'corsair'], ['--preview', 'x'],
      ]) {
        refuse([...GOOD_API, ...extra]);
        refuse(['api', '--method', 'GET', ...extra, GOOD_ENDPOINT]);
      }
    });

    it('refuses graphql, absolute urls and other endpoints', () => {
      refuse(['api', '--method', 'GET', 'graphql']);
      refuse(['api', '--method', 'GET', 'https://api.github.com/repos/acme/demo/commits']);
      refuse(['api', '--method', 'GET', 'https://evil.example/repos/acme/demo/commits']);
      refuse(['api', '--method', 'GET', '//evil.example/x']);
      refuse(['api', '--method', 'GET', '/repos/acme/demo/commits?sha=main&per_page=30&page=1']);
      refuse(['api', '--method', 'GET', 'repos/acme/demo/issues?sha=main&per_page=30&page=1']);
      refuse(['api', '--method', 'GET', 'repos/acme/demo/git/refs']);
      refuse(['api', '--method', 'GET', 'repos/acme/demo/commits/abc123']);
      refuse(['api', '--method', 'GET', 'user']);
      refuse(['api', '--method', 'GET', 'repos/acme/demo/commits']);
      refuse(['api', '--method', 'GET', 'repos/acme/demo/commits?sha=main']);
    });

    it('refuses traversal, placeholders and encoded path tricks', () => {
      for (const endpoint of [
        'repos/../demo/commits?sha=main&per_page=30&page=1',
        'repos/acme/../commits?sha=main&per_page=30&page=1',
        'repos/acme/demo/../../user?sha=main&per_page=30&page=1',
        'repos/{owner}/{repo}/commits?sha=main&per_page=30&page=1',
        'repos/acme/demo/commits?sha={branch}&per_page=30&page=1',
        'repos/acme/demo/commits?sha=%7Bbranch%7D&per_page=30&page=1',
        'repos/acme/demo/commits?sha=%2e%2e%2f%2e%2e%2fuser&per_page=30&page=1',
        'repos/acme/demo/commits?sha=..%2f..&per_page=30&page=1',
        'repos/acme/%2e%2e/commits?sha=main&per_page=30&page=1',
        'repos/acme/demo%2fx/commits?sha=main&per_page=30&page=1',
        // Lower-case hex and over-encoding are alternate spellings of a valid
        // value; only the canonical one is accepted.
        'repos/acme/demo/commits?sha=release%2f1&per_page=30&page=1',
        'repos/acme/demo/commits?sha=%6Dain&per_page=30&page=1',
        'repos/acme/demo/commits?sha=main%00&per_page=30&page=1',
        'repos/acme/demo/commits?sha=main&per_page=30&page=1&x=1',
        'repos/acme/demo/commits?sha=main&per_page=30&page=1#frag',
        'repos/acme/demo/commits?sha=main&sha=other&per_page=30&page=1',
      ]) {
        refuse(['api', '--method', 'GET', endpoint]);
      }
    });

    it('refuses pagination beyond the fixed caps', () => {
      refuse(['api', '--method', 'GET', 'repos/acme/demo/commits?sha=main&per_page=100&page=1']);
      refuse(['api', '--method', 'GET', 'repos/acme/demo/commits?sha=main&per_page=30&page=4']);
      refuse(['api', '--method', 'GET', 'repos/acme/demo/commits?sha=main&per_page=30&page=0']);
      refuse(['api', '--method', 'GET', 'repos/acme/demo/commits?sha=main&per_page=0&page=1']);
    });

    it('refuses a root flag in front of the verb, and any other binary or verb', () => {
      refuse(['--paginate', ...GOOD_API]);
      refuse(['--hostname', 'x', ...GOOD_API]);
      expect(checkCommandAllowed('curl', GOOD_API)?.reason).toBe('unclassified');
      expect(checkCommandAllowed('gh', ['api'])?.reason).toBe('unclassified');
      expect(checkCommandAllowed('gh', ['api', '--method', 'GET'])?.reason).toBe('unclassified');
    });
  });

  it('adds no other `api` reachable form to the frozen tables', () => {
    expect(Object.keys(GH_API_OPERATIONS)).toEqual(['commits']);
    expect(Object.isFrozen(GH_API_OPERATIONS)).toBe(true);
    for (const build of Object.values(GH_OPERATIONS)) {
      expect(build(REF, 1)[0]).not.toBe('api');
    }
  });
});

describe('the review-request search', () => {
  const GOOD = GH_SEARCH_OPERATIONS.reviewRequests();

  it('has one exact, bounded, read-only shape that the policy accepts', () => {
    expect(GOOD).toEqual([
      'search', 'prs', 'user-review-requested:@me', '--state', 'open',
      '--sort', 'updated', '--order', 'desc', '--limit', '25',
      '--json', GH_REVIEW_SEARCH_FIELDS,
    ]);
    expect(checkCommandAllowed('gh', GOOD)).toBeUndefined();
    expect(Object.isFrozen(GH_SEARCH_OPERATIONS)).toBe(true);
  });

  it('is the individual-request qualifier, never the flag that includes team requests', () => {
    expect(GOOD).not.toContain('--review-requested');
    expect(GOOD).toContain('user-review-requested:@me');
  });

  it('refuses every other search shape', () => {
    const swap = (i: number, v: string): string[] => GOOD.map((a, j) => (j === i ? v : a));
    const refused: string[][] = [
      swap(2, 'review-requested:@me'),
      swap(2, 'user-review-requested:someone-else'),
      swap(2, 'user-review-requested:@me org:acme'),
      swap(4, 'all'),
      swap(5, '--sorted'),
      swap(6, 'created'),
      swap(6, 'best-match'),
      swap(8, 'asc'),
      swap(10, '26'),
      swap(10, '1000'),
      swap(10, '0'),
      swap(12, `${GH_REVIEW_SEARCH_FIELDS},body`),
      swap(12, 'number'),
      // The old, unsorted shape is no longer an accepted form.
      ['search', 'prs', 'user-review-requested:@me', '--state', 'open', '--limit', '25', '--json', GH_REVIEW_SEARCH_FIELDS],
      [...GOOD, '--web'],
      [...GOOD, '--jq', '.'],
      [...GOOD, '--owner', 'x'],
      [...GOOD, '--repo', 'a/b'],
      ['search', 'issues', ...GOOD.slice(2)],
      ['search', 'code', 'x'],
      ['search', 'repos', 'x'],
      ['search', 'prs'],
      GOOD.slice(0, -2),
    ];
    for (const argv of refused) {
      expect(isReviewSearchArgv(argv), argv.join(' ')).toBe(false);
      expect(checkCommandAllowed('gh', argv), argv.join(' ')).toBeDefined();
    }
  });
});
