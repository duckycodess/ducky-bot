import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommitsPageSchema, ReviewRequestSearchSchema } from '@ducky/contracts';

const FIXTURE = path.resolve(
  import.meta.dirname, '..', 'src', 'github', 'github.fixtures', 'live-shape.json',
);

type Shape = string | { [k: string]: Shape };

/**
 * `gh api` has no `--json` selector, so there is no recorded field list for the
 * commits read. These tests are its contract instead: the keys below are the
 * ones a REAL response carried (recorded as types in `live-shape.json` by
 * `pnpm probe:gh-live`), and the schema has to accept that shape and refuse to
 * keep anything it does not name.
 */
const REAL_SHAPED_COMMIT = {
  sha: '0123456789abcdef0123456789abcdef01234567',
  node_id: 'C_x',
  commit: {
    author: { name: 'A Person', email: 'a.person@example.invalid', date: '2026-10-12T01:02:03Z' },
    committer: { name: 'GitHub', email: 'noreply@github.com', date: '2026-10-12T01:02:04Z' },
    message: 'Fix the thing\n\nA longer body that must not be kept.',
    tree: { sha: 'abc', url: 'x' },
    url: 'x',
    comment_count: 0,
    verification: { verified: false },
  },
  url: 'x',
  html_url: 'x',
  comments_url: 'x',
  author: { login: 'aperson', id: 1, node_id: 'x', avatar_url: 'x' },
  committer: { login: 'web-flow', id: 2 },
  parents: [{ sha: 'abc', url: 'x', html_url: 'x' }],
};

describe('the commits response schema', () => {
  it('accepts the shape a real response has, and keeps no email', () => {
    const [commit] = CommitsPageSchema.parse([REAL_SHAPED_COMMIT]);
    expect(commit!.sha).toBe(REAL_SHAPED_COMMIT.sha);
    expect(commit!.author?.login).toBe('aperson');
    expect(JSON.stringify(commit)).not.toContain('example.invalid');
    expect(JSON.stringify(commit)).not.toContain('noreply');
    expect(JSON.stringify(commit)).not.toContain('avatar');
  });

  it('accepts a commit with no linked account (author is null)', () => {
    expect(() => CommitsPageSchema.parse([{ ...REAL_SHAPED_COMMIT, author: null }])).not.toThrow();
  });

  it('refuses something that is not a list of commits', () => {
    expect(() => CommitsPageSchema.parse({ message: 'Not Found' })).toThrow();
    expect(() => CommitsPageSchema.parse([{ sha: 'not-hex!', commit: {} }])).toThrow();
    expect(() => CommitsPageSchema.parse([{ commit: {} }])).toThrow();
  });

  it('matches the keys the live recording saw', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      surfaces: { surface: string; parsed: boolean; shape?: Shape }[];
    };
    const recorded = fixture.surfaces.find((s) => s.surface === 'commits');
    expect(recorded?.parsed, 'commits was not recorded live').toBe(true);
    const item = (recorded!.shape as { '[]': Record<string, Shape> })['[]'];
    for (const key of ['sha', 'commit', 'author', 'parents']) expect(item, key).toHaveProperty(key);
  });
});

describe('the review-request search schema', () => {
  it('needs the repository name with owner, and nothing it does not name survives', () => {
    const [pr] = ReviewRequestSearchSchema.parse([{
      number: 4, title: 'A change', state: 'open', isDraft: false,
      author: { login: 'someone', id: 'x', is_bot: false },
      createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
      repository: { name: 'demo', nameWithOwner: 'acme/demo' },
      url: 'https://evil.example/not-used',
      body: 'never selected, never kept',
    }]);
    expect(pr!.repository.nameWithOwner).toBe('acme/demo');
    expect(JSON.stringify(pr)).not.toContain('evil.example');
    expect(JSON.stringify(pr)).not.toContain('never selected');
    expect(() => ReviewRequestSearchSchema.parse([{ number: 1, title: 't' }])).toThrow();
  });
});
