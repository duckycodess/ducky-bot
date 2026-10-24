import { describe, expect, it } from 'vitest';
import { checkCommandAllowed } from '@ducky/contracts';
import { FORBIDDEN_GH_VERBS, GH_OPERATIONS, GhCliReader } from '../src/github/gh-cli.js';

describe('gh adapter', () => {
  it('exposes exactly the read-only operations the watch feature needs', () => {
    // Every one of these is a READ, and every `--json` selector inside them was
    // recorded from `gh` itself by `pnpm probe:gh` rather than guessed.
    expect(Object.keys(GH_OPERATIONS).sort()).toEqual([
      'feedIssueList', 'feedPrChecks', 'feedPrList', 'feedRunList',
      'issueList', 'prChecks', 'prList', 'prListAll', 'prReviews', 'prView', 'repoView', 'runList',
    ]);
  });

  it('is frozen so no operation can be added at runtime', () => {
    expect(Object.isFrozen(GH_OPERATIONS)).toBe(true);
  });

  it('contains no write verb anywhere in the argv table', () => {
    const argv = Object.values(GH_OPERATIONS)
      .flatMap((build) => build({ owner: 'o', repo: 'r' }, 1))
      .map((a) => a.toLowerCase());
    for (const verb of FORBIDDEN_GH_VERBS) {
      expect(argv, `write verb "${verb}" must not appear`).not.toContain(verb);
    }
  });

  it('always requests machine-readable output', () => {
    for (const build of Object.values(GH_OPERATIONS)) {
      expect(build({ owner: 'o', repo: 'r' }, 1)).toContain('--json');
    }
  });

  it('rejects an owner/repo that is not plain identifier text', async () => {
    const reader = new GhCliReader('gh');
    await expect(reader.repoView({ owner: 'o;rm -rf /', repo: 'r' })).rejects.toThrow(
      /not configured/,
    );
    await expect(reader.repoView({ owner: 'o', repo: '../../etc' })).rejects.toThrow(
      /not configured/,
    );
  });
});

describe('the pull request list the watch reads for openings', () => {
  const argv = GH_OPERATIONS.prListAll({ owner: 'acme', repo: 'demo' });

  it('is exactly this argv: the one added selector is createdAt, and no verb, flag or endpoint came with it', () => {
    expect(argv).toEqual([
      'pr', 'list', '-R', 'acme/demo', '--state', 'all', '--limit', '20',
      '--json', 'number,title,state,isDraft,headRefName,headRefOid,updatedAt,mergedAt,reviewDecision,createdAt',
    ]);
    // Flags are exactly the four it always had.
    expect(argv.filter((a) => a.startsWith('-'))).toEqual(['-R', '--state', '--limit', '--json']);
    expect(argv).not.toContain('api');
  });

  it('is allowed by the central gate as the read it is, and the same argv with a forbidden flag or a write verb is not', () => {
    expect(checkCommandAllowed('gh', argv)).toBeUndefined();
    expect(checkCommandAllowed('gh', [...argv, '--force'])).toBeDefined();
    expect(checkCommandAllowed('gh', ['pr', 'merge', '7', '-R', 'acme/demo'])).toBeDefined();
    expect(checkCommandAllowed('gh', ['api', '--method', 'GET', 'repos/acme/demo/pulls'])).toBeDefined();
    expect(checkCommandAllowed('gh', ['api', '--method', 'POST', 'repos/acme/demo/pulls'])).toBeDefined();
  });
});
