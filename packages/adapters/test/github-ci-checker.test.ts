import { describe, expect, it } from 'vitest';
import { GitHubCiDependencyChecker } from '../src/dependency/github-ci.checker.js';
import { MockGitHubReader } from '../src/github/github.mock.js';
import type { PrChecks } from '@ducky/contracts';
import type { DependencyCheckInput } from '@ducky/contracts';

const input = (over: Partial<DependencyCheckInput> = {}): DependencyCheckInput => ({
  dependencyId: 'dep-1',
  type: 'ci_run',
  description: 'waiting for CI',
  externalKey: 'demo#12',
  checksMade: 0,
  maxChecks: 10,
  deadlineAt: '2026-12-31T00:00:00.000Z',
  ...over,
});

const resolver = (slug: string) => (slug === 'demo' ? { owner: 'acme', repo: 'demo' } : undefined);

const checkerWith = (checks: PrChecks, verified = false) =>
  new GitHubCiDependencyChecker(new MockGitHubReader({ prChecks: checks }), resolver, verified);

/**
 * The first dependency checker that can actually answer.
 *
 * The shipped default says `pending` forever, which is honest and useless: a job
 * blocked on CI ends at the owner's desk even when CI failed hours ago. What
 * matters here is the ASYMMETRY — it may fail a job on a definite failure, and
 * on this host it may not resume one, because nothing has exercised it live.
 */
describe('the GitHub CI dependency checker', () => {
  it('reports ready only when every check has finished and passed', async () => {
    const outcome = await checkerWith([
      { name: 'tests', bucket: 'pass' },
      { name: 'lint', bucket: 'skipping' },
    ]).check(input());

    expect(outcome.status).toBe('ready');
    expect(outcome.detail).toMatch(/2 check\(s\) passed/);
  });

  it('reports failed on a definite failure, naming the checks', async () => {
    const outcome = await checkerWith([
      { name: 'tests', bucket: 'fail' },
      { name: 'lint', bucket: 'pass' },
    ]).check(input());

    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('tests');
  });

  it('reports pending while anything is still running', async () => {
    const outcome = await checkerWith([
      { name: 'tests', bucket: 'pending' },
      { name: 'lint', bucket: 'pass' },
    ]).check(input());

    expect(outcome.status).toBe('pending');
    expect(outcome.detail).toMatch(/still running/);
  });

  it('is unverified by default, which is what stops it resuming a job', async () => {
    // The resolver downgrades `ready` from an unverified checker to `pending`.
    // Nothing in the code sets this flag: it has to mean "it was exercised".
    expect(checkerWith([]).verified).toBe(false);
    expect(checkerWith([], true).verified).toBe(true);
  });

  it('answers only for CI runs, rather than pretending about the rest', async () => {
    for (const type of ['package_publish', 'upstream_change', 'human_action', 'other'] as const) {
      const outcome = await checkerWith([{ name: 'tests', bucket: 'pass' }]).check(input({ type }));
      expect(outcome.status, type).toBe('pending');
      expect(outcome.detail, type).toMatch(/only answers for CI runs/);
    }
  });

  it('treats an unreadable answer as pending, never as failed', async () => {
    // None of these is evidence that the dependency will not be satisfied, and
    // failing a job on a lookup problem throws work away for an unrelated reason.
    const malformed = await checkerWith([]).check(input({ externalKey: 'not a key' }));
    expect(malformed.status).toBe('pending');
    expect(malformed.detail).toMatch(/externalKey/);

    const unknownRepo = await checkerWith([]).check(input({ externalKey: 'elsewhere#3' }));
    expect(unknownRepo.status).toBe('pending');
    expect(unknownRepo.detail).toMatch(/not an allowlisted repository/);

    const missingKey = await checkerWith([]).check(input({ externalKey: null }));
    expect(missingKey.status).toBe('pending');

    const noChecks = await checkerWith([]).check(input());
    expect(noChecks.status).toBe('pending');
    expect(noChecks.detail).toMatch(/No checks are reported/);
  });

  it('never surfaces a raw error from gh', async () => {
    const reader = new MockGitHubReader();
    reader.prChecks = async () => {
      throw new Error('gh: HTTP 401 with token ghp_supersecrettokenvalue');
    };
    const outcome = await new GitHubCiDependencyChecker(reader, resolver).check(input());

    expect(outcome.status).toBe('pending');
    expect(outcome.detail).toBe('The CI status could not be read this time.');
    expect(JSON.stringify(outcome)).not.toContain('ghp_');
  });

  it('only ever reads: the reader it holds has no write method', () => {
    const reader = new MockGitHubReader();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(reader));
    for (const method of surface) {
      expect(method, method).toMatch(
        /^(constructor|repoView|prList|prListAll|prView|prChecks|prReviews|runList|issueList)$/,
      );
    }
  });
});
