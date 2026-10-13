import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMBED_TOTAL_MAX, OWNER_ONLY_COMMANDS, TRUNCATION_MARKER,
  type GitHubCommitDigestSection, type GitHubFeedCard,
} from '@ducky/contracts';
import { githubDigestMessage, githubFeedMessage } from '../src/discord/github-feed-presenters.js';
import { sanitizeOutbound } from '../src/discord/sanitize-outbound.js';
import { toDiscordPayload } from '../src/discord/payload.js';
import { isLinkButton } from '../src/discord/message.js';
import { sha } from './github-feed-helpers.js';

const card = (over: Partial<GitHubFeedCard> = {}): GitHubFeedCard => ({
  kind: 'pr_opened', repo: 'acme/demo', number: 7, title: 'Add the feed',
  detail: ['Opened by alice'],
  links: [
    { label: 'Open PR', url: 'https://github.com/acme/demo/pull/7' },
    { label: 'View changes', url: 'https://github.com/acme/demo/pull/7/files' },
  ],
  observedAt: '2026-10-01T00:00:00.000Z', ...over,
});

const src = (...parts: string[]): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', 'src', ...parts), 'utf8');

describe('a feed card', () => {
  it('shows the kind, repository, number, title and details, in plain text', () => {
    const m = githubFeedMessage(card());
    const e = m.embeds![0]!;
    expect(e.title).toBe('Pull request opened');
    expect(e.description).toBe('acme/demo #7\nAdd the feed\nOpened by alice');
    expect(m.ephemeral).toBe(false);
    expect(e.footer).toBeUndefined();
    expect(e.fields).toBeUndefined();
  });

  it('colours by meaning: a failure is not an opened issue', () => {
    const failed = githubFeedMessage(card({ kind: 'check_failed', number: null, links: [] }));
    const opened = githubFeedMessage(card({ kind: 'issue_opened' }));
    expect(failed.embeds![0]!.color).not.toBe(opened.embeds![0]!.color);
    expect(githubFeedMessage(card({ kind: 'check_failed', number: null })).embeds![0]!.description)
      .toMatch(/^acme\/demo\n/);
  });

  it('carries real link buttons, never a custom id', () => {
    const m = githubFeedMessage(card());
    const buttons = m.rows!.flatMap((r) => r.buttons);
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(isLinkButton(b)).toBe(true);
      expect(b).not.toHaveProperty('customId');
    }
  });

  it('reaches Discord as style-5 buttons with a url and NO custom_id', () => {
    const payload = toDiscordPayload(sanitizeOutbound(githubFeedMessage(card())));
    const comps = payload.components!.flatMap((r) => r.components);
    expect(comps).toEqual([
      { type: 2, label: 'Open PR', style: 5, url: 'https://github.com/acme/demo/pull/7' },
      { type: 2, label: 'View changes', style: 5, url: 'https://github.com/acme/demo/pull/7/files' },
    ]);
    expect(payload.flags).toBeUndefined();
  });

  it('survives the egress sanitizer unchanged, and stays unchanged on a second pass', () => {
    const once = sanitizeOutbound(githubFeedMessage(card()));
    expect(sanitizeOutbound(once)).toEqual(once);
    expect(once.rows![0]!.buttons).toHaveLength(2);
  });

  it('has the sanitizer DROP a link that is not github, however it was built', () => {
    const hostile = githubFeedMessage(card({
      links: [
        { label: 'Open PR', url: 'https://github.com/acme/demo/pull/7' },
        { label: 'Open PR', url: 'https://evil.example/acme/demo/pull/7' },
        { label: 'Open PR', url: 'https://github.com.evil.example/x' },
        { label: 'Open PR', url: 'javascript:alert(1)' },
        { label: 'Open PR', url: 'http://github.com/acme/demo' },
        { label: 'Open PR', url: 'https://user:pass@github.com/acme/demo' },
      ],
    }));
    const safe = sanitizeOutbound(hostile);
    expect(safe.rows!.flatMap((r) => r.buttons).map((b) => (isLinkButton(b) ? b.url : ''))).toEqual([
      'https://github.com/acme/demo/pull/7',
    ]);
  });

  it('puts no more than five buttons in a row and five rows in a message', () => {
    const many = githubFeedMessage(card({
      links: Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, url: `https://github.com/acme/demo/pull/${i + 1}` })),
    }));
    expect(many.rows).toHaveLength(1);
    expect(many.rows![0]!.buttons).toHaveLength(5);
  });

  it('never makes a card a control, by construction', () => {
    const text = src('discord', 'github-feed-presenters.ts');
    expect(text).not.toMatch(/customId|custom_id|signer|\.sign\(/);
    // And no feed code reaches the signer at all.
    expect(src('domain', 'github-feed.service.ts')).not.toMatch(/ComponentSigner|signer|customId/);
    expect(src('domain', 'github-feed-cards.ts')).not.toMatch(/ComponentSigner|signer|customId/);
  });
});

describe('a digest message', () => {
  const section = (repo: string, n: number, headline = 'A reasonably long commit headline for width'): GitHubCommitDigestSection => ({
    repo, branch: 'main', total: n, truncated: false,
    commits: Array.from({ length: n }, (_, i) => ({ sha: sha(i + 1), headline: `${headline} ${i}`, author: 'alice' })),
    links: [{ label: 'View commits', url: `https://github.com/${repo}/commits/main` }],
  });

  it('prints a line per commit and says aloud what it cut', () => {
    const m = githubDigestMessage({ dayLabel: '2026-10-01', sections: [section('acme/demo', 30)] });
    const text = m.embeds!.map((e) => e.description).join('\n');
    expect(text).toMatch(/and 18 more commits/);
    expect(m.embeds![0]!.title).toBe('Commit digest for 2026-10-01');
    expect(text).not.toMatch(/·|—|UTC/);
  });

  it('fits Discord limits for the widest legal message WITHOUT a silent clip', () => {
    const sections = Array.from({ length: 8 }, (_, i) => section(`acme/repository-${i}`, 50, 'x'.repeat(170)));
    const raw = githubDigestMessage({ dayLabel: '2026-10-01', sections });
    const safe = sanitizeOutbound(raw);
    const embeds = safe.embeds!;
    expect(embeds.length).toBeLessThanOrEqual(10);
    const total = embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(EMBED_TOTAL_MAX);
    // The sanitizer had nothing to clip, because the presenter had already fit it.
    expect(JSON.stringify(safe)).not.toContain(TRUNCATION_MARKER);
    // Every section is still there, each with its "and N more".
    expect(embeds).toHaveLength(8);
    for (const e of embeds) expect(e.description).toMatch(/and \d+ more commits/);
  });

  it('gives each repository its own View commits button, labelled with the repository', () => {
    const m = githubDigestMessage({
      dayLabel: '2026-10-01', sections: [section('acme/one', 2), section('acme/two', 2)],
    });
    expect(m.rows!.flatMap((r) => r.buttons).map((b) => (isLinkButton(b) ? b.label : ''))).toEqual([
      'View commits acme/one', 'View commits acme/two',
    ]);
  });

  it('numbers parts, and discloses omitted repositories and unreadable ones', () => {
    const m = githubDigestMessage({
      dayLabel: '2026-10-01', sections: [section('acme/one', 1)], part: { index: 2, of: 3 },
      unreadable: ['acme/gone'], omittedRepos: 4,
    });
    expect(m.embeds![0]!.title).toBe('Commit digest for 2026-10-01, part 2 of 3');
    const text = m.embeds!.map((e) => e.description).join('\n');
    expect(text).toContain('Commits could not be read for acme/gone.');
    expect(text).toContain('4 more repositories have commits that did not fit');
  });
});

describe('the owner-only surface is untouched', () => {
  it('adds no command, and no router code reaches the feed', () => {
    expect(OWNER_ONLY_COMMANDS.join(' ')).not.toMatch(/github|feed|digest/i);
    expect(src('discord', 'router.ts')).not.toMatch(/github-feed|githubFeed/);
    expect(src('discord', 'register-commands.ts')).not.toMatch(/github-feed|githubFeed|digest/i);
  });
});
