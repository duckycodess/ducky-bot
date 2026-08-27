import { describe, expect, it } from 'vitest';
import { RepoAllowlist } from '../src/domain/allowlist.js';
import { REPOS_JSON, makeHarness } from './helpers.js';

describe('repository allowlist', () => {
  const allowlist = RepoAllowlist.fromJson(REPOS_JSON);

  it('maps a known slug to its configured absolute path', () => {
    expect(allowlist.resolve('demo').absolutePath).toBe('/tmp/ducky-demo');
  });

  it('rejects anything that is not a plain configured slug', () => {
    for (const bad of [
      'unknown',
      '../etc',
      '/tmp/ducky-demo',
      '~/repo',
      'demo/../other',
      'DEMO',
      '',
      'disabled',
    ]) {
      expect(() => allowlist.resolve(bad), bad).toThrow(/not/i);
    }
    expect(() => allowlist.resolve(undefined)).toThrow();
    expect(() => allowlist.resolve({ slug: 'demo' })).toThrow();
  });

  it('refuses a bootstrap job for a repo that does not allow it', () => {
    const h = makeHarness();
    expect(() =>
      h.app.jobs.submit(h.owner, { repoSlug: 'other', task: 't', bootstrap: true }),
    ).toThrow(/not configured to allow bootstrap/);
    expect(() =>
      h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 't', bootstrap: true }),
    ).not.toThrow();
    h.close();
  });
});
