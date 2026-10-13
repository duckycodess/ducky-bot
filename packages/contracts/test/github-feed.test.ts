import { describe, expect, it } from 'vitest';
import {
  GITHUB_FEED_KINDS, GITHUB_FEED_KIND_COLOR, GITHUB_FEED_KIND_LABEL, canonicalRepoKey,
  githubCommitUrl, githubCommitsUrl, githubFeedTarget, githubIssueUrl, githubPrChecksUrl,
  githubPrFilesUrl, githubPrUrl, githubRunUrl, parseRepoKey, repoKey,
} from '../src/github-feed.js';

describe('where a card may be shown', () => {
  const base = { channelConfigured: true, selected: true, isPrivate: false as boolean | undefined };

  it('reaches the channel only when all four conditions hold', () => {
    expect(githubFeedTarget(base)).toBe('github_channel');
  });

  it('falls back to the DM on every ambiguous or private case', () => {
    expect(githubFeedTarget({ ...base, channelConfigured: false })).toBe('owner_dm');
    expect(githubFeedTarget({ ...base, selected: false })).toBe('owner_dm');
    expect(githubFeedTarget({ ...base, isPrivate: true })).toBe('owner_dm');
    // Not observed is not "probably public".
    expect(githubFeedTarget({ ...base, isPrivate: undefined })).toBe('owner_dm');
  });
});

describe('the cards', () => {
  it('has a plain label and a colour for every kind, and no decoration', () => {
    for (const kind of GITHUB_FEED_KINDS) {
      expect(GITHUB_FEED_KIND_LABEL[kind]).toMatch(/^[A-Za-z ]+$/);
      expect(typeof GITHUB_FEED_KIND_COLOR[kind]).toBe('number');
    }
  });
});

describe('repository identity', () => {
  it('validates both halves and is case-insensitive once canonical', () => {
    expect(repoKey('Acme', 'Demo')).toBe('Acme/Demo');
    expect(canonicalRepoKey('Acme/Demo')).toBe('acme/demo');
    expect(parseRepoKey('acme/demo')).toEqual({ owner: 'acme', repo: 'demo' });
    expect(parseRepoKey('acme')).toBeUndefined();
    expect(parseRepoKey('a/b/c')).toBeUndefined();
    expect(parseRepoKey('acme/de mo')).toBeUndefined();
    expect(repoKey('ac;me', 'demo')).toBeUndefined();
  });
});

describe('links are built, never echoed', () => {
  it('builds the exact github urls from validated parts', () => {
    expect(githubPrUrl('acme', 'demo', 7)).toBe('https://github.com/acme/demo/pull/7');
    expect(githubPrFilesUrl('acme', 'demo', 7)).toBe('https://github.com/acme/demo/pull/7/files');
    expect(githubPrChecksUrl('acme', 'demo', 7)).toBe('https://github.com/acme/demo/pull/7/checks');
    expect(githubIssueUrl('acme', 'demo', 3)).toBe('https://github.com/acme/demo/issues/3');
    expect(githubRunUrl('acme', 'demo', 99)).toBe('https://github.com/acme/demo/actions/runs/99');
    expect(githubCommitUrl('acme', 'demo', 'abcdef1')).toBe('https://github.com/acme/demo/commit/abcdef1');
    expect(githubCommitsUrl('acme', 'demo', 'main')).toBe('https://github.com/acme/demo/commits/main');
  });

  it('refuses a malformed part instead of building a half-url', () => {
    expect(githubPrUrl('acme', 'demo', 0)).toBeUndefined();
    expect(githubPrUrl('acme', 'demo', 1.5)).toBeUndefined();
    expect(githubPrUrl('ac me', 'demo', 1)).toBeUndefined();
    expect(githubCommitUrl('acme', 'demo', 'not-hex!')).toBeUndefined();
    expect(githubRunUrl('acme', 'demo', -1)).toBeUndefined();
  });

  it('falls back to the plain commits page for a branch it will not put in a path', () => {
    expect(githubCommitsUrl('acme', 'demo', 'a b#c')).toBe('https://github.com/acme/demo/commits');
    expect(githubCommitsUrl('acme', 'demo', '../x')).toBe('https://github.com/acme/demo/commits');
    expect(githubCommitsUrl('acme', 'demo')).toBe('https://github.com/acme/demo/commits');
    expect(githubCommitsUrl('bad owner', 'demo', 'main')).toBeUndefined();
  });
});
