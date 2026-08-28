import { describe, expect, it } from 'vitest';
import { FORBIDDEN_GH_VERBS, GH_OPERATIONS, GhCliReader } from '../src/github/gh-cli.js';

describe('gh adapter', () => {
  it('exposes exactly the read-only operations the watch feature needs', () => {
    // Every one of these is a READ, and every `--json` selector inside them was
    // recorded from `gh` itself by `pnpm probe:gh` rather than guessed.
    expect(Object.keys(GH_OPERATIONS).sort()).toEqual([
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
