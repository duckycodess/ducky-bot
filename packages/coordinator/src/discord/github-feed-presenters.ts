import {
  DUCKY_COLORS, GITHUB_FEED_DIGEST_CHAR_BUDGET, GITHUB_FEED_DIGEST_MAX_LINES,
  GITHUB_FEED_KIND_COLOR, GITHUB_FEED_KIND_LABEL,
  type GitHubCommitDigestSection, type GitHubFeedCard, type GitHubFeedLink,
} from '@ducky/contracts';
import type { OutboundButton, OutboundEmbed, OutboundMessage, OutboundRow } from './message.js';

/**
 * The GitHub feed's cards. Both presenters take ONLY the projections defined in
 * `@ducky/contracts` -- a `GitHubFeedCard` or a digest section -- and nothing
 * else, for the same reason `shared-presenters.ts` takes only
 * `SharedJobProjection`: a presenter that could see the raw observation could
 * render a field nobody meant to publish.
 *
 * Plain on purpose. No bold, no emoji, no separator characters, no decorative
 * heading, no timestamp and no timezone: the kind is the embed title, the
 * repository and the item are two plain lines, and every action is a real link
 * button (Discord style 5) rather than a word printed in the text.
 *
 * Link buttons only. Nothing here carries a custom id, so a card can never be a
 * control, and reading one grants nobody anything.
 */

/** Buttons per row and rows per message are Discord's own bounds. */
const BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;

const buttonsOf = (ls: readonly GitHubFeedLink[]): OutboundButton[] =>
  ls.map((l) => ({ url: l.url, label: l.label.slice(0, 80) }));

const rowsOf = (buttons: readonly OutboundButton[]): OutboundRow[] => {
  const rows: OutboundRow[] = [];
  for (let i = 0; i < buttons.length && rows.length < MAX_ROWS; i += BUTTONS_PER_ROW) {
    rows.push({ buttons: buttons.slice(i, i + BUTTONS_PER_ROW) });
  }
  return rows;
};

export function githubFeedMessage(card: GitHubFeedCard): OutboundMessage {
  const head = card.number === null ? card.repo : `${card.repo} #${card.number}`;
  const lines = [head, card.title, ...card.detail].filter((l) => l.length > 0);
  const rows = rowsOf(buttonsOf(card.links));
  return {
    embeds: [{
      title: GITHUB_FEED_KIND_LABEL[card.kind],
      description: lines.join('\n'),
      color: GITHUB_FEED_KIND_COLOR[card.kind],
    }],
    ...(rows.length > 0 ? { rows } : {}),
    // A feed card is posted, not replied: it is deliberately visible.
    ephemeral: false,
  };
}

/**
 * One digest message: a section per repository, as one embed each.
 *
 * Discord allows 10 embeds and 6000 characters, and the sanitizer would clip an
 * over-long embed with a marker and give later embeds nothing. So the budget is
 * spent HERE, where it can be spent deliberately: lines per section shrink until
 * the whole message fits, and every cut is said aloud ("and 7 more commits")
 * rather than left to a silent clip.
 */
export function githubDigestMessage(input: {
  readonly dayLabel: string;
  readonly sections: readonly GitHubCommitDigestSection[];
  /** Part numbering when the day's digest needed more than one message. */
  readonly part?: { readonly index: number; readonly of: number };
  /** Repositories whose commits could not be read. Only ever passed for the DM. */
  readonly unreadable?: readonly string[];
  /** Repositories the digest has no room for, which stay for the next digest. */
  readonly omittedRepos?: number;
}): OutboundMessage {
  const lineCap = fitLines(input.sections);
  const embeds: OutboundEmbed[] = input.sections.map((s, i) => {
    const shown = s.commits.slice(0, lineCap);
    const hidden = Math.max(0, s.total - shown.length);
    const lines = shown.map((c) => `${c.sha.slice(0, 7)} ${c.headline}${c.author ? ` (${c.author})` : ''}`);
    if (hidden > 0) lines.push(`and ${hidden} more ${hidden === 1 ? 'commit' : 'commits'}`);
    if (s.truncated) {
      lines.push('History was rewritten or longer than the read limit, so some commits may be missing.');
    }
    return {
      title: i === 0 ? titleFor(input) : s.repo,
      description: i === 0 ? [s.repo, ...lines].join('\n') : lines.join('\n'),
      color: DUCKY_COLORS.neutral,
    };
  });

  const notes: string[] = [];
  if (input.unreadable && input.unreadable.length > 0) {
    notes.push(`Commits could not be read for ${input.unreadable.join(', ')}.`);
  }
  if (input.omittedRepos && input.omittedRepos > 0) {
    notes.push(
      `${input.omittedRepos} more ${input.omittedRepos === 1 ? 'repository has' : 'repositories have'} ` +
        'commits that did not fit and stay for the next digest.',
    );
  }
  if (notes.length > 0) {
    if (embeds.length === 0) {
      embeds.push({ title: titleFor(input), description: notes.join('\n'), color: DUCKY_COLORS.neutral });
    } else {
      const last = embeds[embeds.length - 1]!;
      embeds[embeds.length - 1] = {
        ...last, description: [last.description ?? '', ...notes].filter(Boolean).join('\n'),
      };
    }
  }

  const rows = rowsOf(
    input.sections.flatMap((s) =>
      s.links.map((l) => ({ url: l.url, label: `${l.label} ${s.repo}`.slice(0, 80) }) as OutboundButton)),
  );
  return { embeds, ...(rows.length > 0 ? { rows } : {}), ephemeral: false };
}

const titleFor = (input: { dayLabel: string; part?: { index: number; of: number } }): string =>
  `Commit digest for ${input.dayLabel}${input.part && input.part.of > 1 ? `, part ${input.part.index} of ${input.part.of}` : ''}`;

/** The largest per-section line cap at which the whole message stays inside the budget. */
function fitLines(sections: readonly GitHubCommitDigestSection[]): number {
  for (let cap = GITHUB_FEED_DIGEST_MAX_LINES; cap >= 1; cap -= 1) {
    let used = 0;
    for (const s of sections) {
      used += s.repo.length + 40;
      for (const c of s.commits.slice(0, cap)) used += c.headline.length + c.author.length + 14;
      if (s.total > cap) used += 24;
      if (s.truncated) used += 96;
    }
    if (used <= GITHUB_FEED_DIGEST_CHAR_BUDGET) return cap;
  }
  return 1;
}
