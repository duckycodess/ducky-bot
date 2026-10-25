import { describe, expect, it } from 'vitest';
import { PrListSchema, checkCommandAllowed } from '@ducky/contracts';
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

  it('is exactly this argv: the added selectors are createdAt and closedAt, and no verb, flag or endpoint came with them', () => {
    expect(argv).toEqual([
      'pr', 'list', '-R', 'acme/demo', '--state', 'all', '--limit', '20',
      '--json', 'number,title,state,isDraft,headRefName,headRefOid,updatedAt,mergedAt,closedAt,reviewDecision,createdAt',
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

describe('the closed-at field of the pull request list', () => {
  const row = { number: 7, title: 't', state: 'CLOSED' };

  it('is selected by the fixed list and by nothing else, and is not an argument anyone supplies', () => {
    const fixed = GH_OPERATIONS.prListAll({ owner: 'acme', repo: 'demo' });
    expect(fixed.join(' ')).toContain('mergedAt,closedAt,reviewDecision');
    // No other list in the table asks for it: the close proof is the watch's alone.
    for (const [name, build] of Object.entries(GH_OPERATIONS)) {
      if (name === 'prListAll') continue;
      expect(build({ owner: 'acme', repo: 'demo' }, 1).join(' '), name).not.toContain('closedAt');
    }
    // The central gate still sees the same read verb: a selector is not a verb, a flag or an endpoint.
    expect(checkCommandAllowed('gh', fixed)).toBeUndefined();
  });

  it('is accepted as a string, as null (open or merged) or missing, and nothing about it is required', () => {
    expect(PrListSchema.parse([{ ...row, closedAt: '2026-10-02T03:04:05Z' }])[0]!.closedAt).toBe('2026-10-02T03:04:05Z');
    expect(PrListSchema.parse([{ ...row, closedAt: null }])[0]!.closedAt).toBeNull();
    expect(PrListSchema.parse([row])[0]!.closedAt).toBeUndefined();
  });

  it('refuses a close instant that is not text, so a malformed answer fails the read rather than being coerced', () => {
    expect(() => PrListSchema.parse([{ ...row, closedAt: 1760000000 }])).toThrow();
    expect(() => PrListSchema.parse([{ ...row, closedAt: {} }])).toThrow();
  });
});
