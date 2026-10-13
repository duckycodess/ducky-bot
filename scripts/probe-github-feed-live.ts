#!/usr/bin/env tsx
/**
 * PROBE E -- the GitHub FEED, driven against live GitHub through the real
 * composition root.
 *
 * `pnpm probe:gh-live` proves the reader parses real responses. This proves the
 * thing built on it: that the feed's pipeline, fed by the SHIPPED `GhCliReader`,
 * records history without announcing it, announces nothing twice across repeated
 * polls, builds cards whose action links really resolve, and groups real
 * default-branch commits into the 09:00 digest.
 *
 * WHAT IS REAL AND WHAT IS NOT -- stated, because a probe that blurs the two is
 * how coverage gets invented:
 *
 * - REAL: every GitHub read (the argv, the policy gate, `runArgv`, the zod
 *   schemas), the repository's open issues, its commit history, its visibility,
 *   and an HTTP check of every link a card carries.
 * - SIMULATED: the clock, and the fact that the watch "started earlier". A
 *   repository that is quiet right now has no NEW pull request to announce, so
 *   the issue and commit cursors are pre-seeded as already-baselined, at a point
 *   that leaves real, existing items unseen. Those items are real; that they
 *   are "new" is the simulation. Nothing about it is recorded as a live
 *   observation of a new event.
 * - ABSENT: real Discord. The transport is the in-memory mock, so nothing is
 *   posted anywhere, and `realDiscordMessagesSent` is 0 by construction.
 *
 * SAFETY
 * - Read-only: the reader has no write method and the policy refuses one.
 * - The target comes from the repository allowlist file, never from an argument.
 * - It loads NO environment file and reads NO credential. `gh` uses its own
 *   stored login, exactly as the coordinator would; nothing here prints it.
 * - It exits 2 while anything it set out to observe was not observed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { GhCliReader } from '../packages/adapters/src/github/gh-cli.js';
import { createApp } from '../packages/coordinator/src/app.js';
import { RepoAllowlist } from '../packages/coordinator/src/domain/allowlist.js';
import { ConfiguredOwnerClock } from '../packages/coordinator/src/domain/owner-clock.js';
import { MockDiscordTransport } from '../packages/coordinator/src/discord/mock.transport.js';
import { isLinkButton } from '../packages/coordinator/src/discord/message.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'packages/adapters/src/github/github.fixtures');
const OWNER = '100000000000000001';
const CHANNEL = '900000000000000021';
const TZ = 'Asia/Manila';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const gaps: string[] = [];

async function linkStatus(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    return res.status;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const reposFile = process.env['DUCKY_REPOS_FILE'] ?? path.join(ROOT, 'config/repos.dev.json');
  const allowlistJson = readFileSync(reposFile, 'utf8');
  const target = RepoAllowlist.fromJson(allowlistJson).list().find((r) => r.enabled && r.github !== null);
  if (!target) {
    process.stderr.write('No allowlisted repository has a GitHub mapping; nothing to observe.\n');
    process.exit(2);
  }
  const ref = target.github!;
  out(`feed against ${ref.owner}/${ref.repo}, in an in-memory database, mock Discord transport`);

  const reader = new GhCliReader();
  const transport = new MockDiscordTransport();
  let nowMs = Date.now();
  const clock = new ConfiguredOwnerClock(TZ, () => nowMs);

  const app = createApp(
    {
      NODE_ENV: 'test',
      DUCKY_PROFILE: 'development',
      OWNER_DISCORD_USER_ID: OWNER,
      DUCKY_DEV_COMPONENT_SIGNING_KEY: randomUUID() + randomUUID(),
      DUCKY_EXECUTOR_CREDENTIALS: '{"version":1,"executors":[]}',
      DUCKY_DB_PATH: ':memory:',
      DUCKY_REPOS_FILE: reposFile,
      DUCKY_GITHUB_FEED_ENABLED: 'true',
      DUCKY_GITHUB_FEED_REVIEW_REQUESTS: 'true',
      DUCKY_GITHUB_DIGEST_AT: '09:00',
      DUCKY_DEV_GITHUB_CHANNEL_ID: CHANNEL,
    } as NodeJS.ProcessEnv,
    { transport, github: reader, allowlistJson, clock },
  );

  try {
    const feed = app.githubFeed;
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    const selected = feed.selected().map((r) => r.repoKey);
    out(`selected: ${selected.length} repositor${selected.length === 1 ? 'y' : 'ies'} (from the allowlist)`);
    const allowJobsBefore = JSON.stringify(app.store.db.prepare('SELECT slug, allow_jobs FROM repos').all());

    // ---- 1. a first watch: history is recorded and nothing is announced --------
    const first = await feed.tick();
    out(`first pass:  ${JSON.stringify(first)}`);
    const baselineRows = app.store.githubFeed.listEvents('baseline').length;

    // ---- 2. repeated polls announce nothing -----------------------------------
    const repeats = [];
    for (let i = 0; i < 3; i += 1) {
      nowMs += 16 * 60_000;
      repeats.push(await feed.tick());
    }
    const duplicates = repeats.reduce((n, r) => n + r.recorded + r.delivered, 0);
    out(`three repeated polls announced ${duplicates} thing(s)`);

    // ---- 3. the simulation: pretend the watch began before today's items -------
    //
    // Reset the issue cursor to "baselined, nothing seen", and the commit cursor
    // to a real older head, so real existing items are unseen. See the header.
    const at = clock.nowIso();
    const repo = app.store.githubFeed;
    const issueCursor = repo.cursor(key, 'issues')!;
    app.store.db.prepare(
      "DELETE FROM github_feed_events WHERE repo_key = ? AND kind = 'issue_opened'",
    ).run(key);
    app.store.db.prepare(
      'UPDATE github_feed_cursors SET cursor = ?, next_check_at = ? WHERE scope = ? AND kind = ?',
    ).run('', at, key, 'issues');
    void issueCursor;

    const page = await reader.commits(ref, (await reader.repoView(ref)).defaultBranchRef?.name ?? 'main', 1);
    const older = page[2]?.sha;
    if (older === undefined) {
      gaps.push('the repository has fewer than three commits, so the commit walk could not be exercised');
    } else {
      app.store.db.prepare('DELETE FROM github_feed_commits WHERE repo_key = ? AND sha IN (?, ?)')
        .run(key, page[0]!.sha, page[1]!.sha);
      app.store.db.prepare(
        'UPDATE github_feed_cursors SET cursor = ?, next_check_at = ? WHERE scope = ? AND kind = ?',
      ).run(older, at, key, 'commits');
    }

    nowMs += 16 * 60_000;
    const announced = await feed.tick();
    out(`after the simulated earlier start: ${JSON.stringify(announced)}`);
    const sentAlerts = transport.sent.slice();
    const kinds = new Map<string, number>();
    for (const s of sentAlerts) {
      const title = s.message.embeds?.[0]?.title ?? '';
      kinds.set(title, (kinds.get(title) ?? 0) + 1);
    }

    // ---- 4. the same poll again: still nothing new -------------------------------
    nowMs += 16 * 60_000;
    const again = await feed.tick();
    out(`the same poll again: ${JSON.stringify(again)}`);

    // ---- 5. the links on the cards really resolve ---------------------------------
    const buttons = sentAlerts.flatMap((s) => (s.message.rows ?? []).flatMap((r) => r.buttons));
    const links = buttons.filter(isLinkButton);
    const controls = buttons.length - links.length;
    const statuses: number[] = [];
    for (const l of [...new Map(links.map((b) => [b.url, b])).values()].slice(0, 12)) {
      statuses.push(await linkStatus(l.url));
    }
    out(`${links.length} link button(s), ${controls} control button(s); statuses ${JSON.stringify(statuses)}`);

    // ---- 6. the 09:00 digest, from real commits -----------------------------------
    const slot = new Date(nowMs);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(slot);
    let slotMs = Date.parse(`${day}T01:00:00.000Z`); // 09:00 Manila is 01:00Z
    if (slotMs <= nowMs) slotMs += 24 * 60 * 60_000;
    nowMs = slotMs - 60_000;
    const beforeSlot = await feed.tick();
    const digestsBefore = transport.sent.filter((m) => (m.message.embeds?.[0]?.title ?? '').startsWith('Commit digest')).length;
    nowMs = slotMs + 60_000;
    const atSlot = await feed.tick();
    nowMs += 16 * 60_000;
    const after = await feed.tick();
    const digests = transport.sent.filter((m) => (m.message.embeds?.[0]?.title ?? '').startsWith('Commit digest'));
    out(`digest: one minute before ${JSON.stringify(beforeSlot.digestsDelivered)}, at slot ${JSON.stringify(atSlot.digestsDelivered)}, later ${JSON.stringify(after.digestsDelivered)}`);
    const digestLinks = digests.flatMap((d) => (d.message.rows ?? []).flatMap((r) => r.buttons)).filter(isLinkButton);
    const digestStatuses: number[] = [];
    for (const l of digestLinks.slice(0, 3)) digestStatuses.push(await linkStatus(l.url));
    const digestTargets = digests.map((d) => (d.target.kind === 'channel' ? 'channel' : 'dm'));

    // ---- 7. coverage that was NOT exercised, said plainly --------------------------
    const reviewReturned = app.store.githubFeed.cursor('@me', 'review_requests');
    const everythingDelivered = transport.sent.length;
    const allowJobsAfter = JSON.stringify(app.store.db.prepare('SELECT slug, allow_jobs FROM repos').all());

    if (first.failed > 0) gaps.push('the first pass had failing reads');
    if (duplicates !== 0) gaps.push('a repeated poll announced something');
    if (again.recorded + again.delivered !== 0) gaps.push('the same poll again announced something');
    if (links.length === 0) gaps.push('no link button was produced to check');
    if (statuses.some((s) => s !== 200)) gaps.push('a card link did not resolve with HTTP 200');
    if (digests.length === 0) gaps.push('no digest was produced from real commits');
    if (digestStatuses.some((s) => s !== 200)) gaps.push('a digest link did not resolve with HTTP 200');
    if (controls !== 0) gaps.push('a card carried a control button');
    if (allowJobsBefore !== allowJobsAfter) gaps.push('the repository allowlist table changed');

    const record = {
      _note:
        'The GitHub feed driven against live GitHub through the real composition root, with an ' +
        'in-memory database, the mock Discord transport and an injected clock. COUNTS, statuses and ' +
        'booleans only: no title, login, sha, url or message text. The issue and commit cursors were ' +
        'pre-seeded to simulate a watch that started earlier, so real, existing items count as new; ' +
        'that is a simulation of WHEN the watch began, not a live observation of a new event.',
      realGithubReads: true,
      realDiscordMessagesSent: 0,
      selectedRepositories: selected.length,
      firstPass: first,
      baselineRowsRecorded: baselineRows,
      announcedByThreeRepeatedPolls: duplicates,
      afterSimulatedEarlierStart: { recorded: announced.recorded, delivered: announced.delivered, byKind: Object.fromEntries(kinds) },
      theSamePollAgainAnnounced: again.recorded + again.delivered,
      cards: {
        linkButtons: links.length,
        controlButtons: controls,
        linkHttpStatuses: statuses,
      },
      digest: {
        claimedBeforeTheSlot: digestsBefore,
        deliveredAtTheSlot: atSlot.digestsDelivered,
        deliveredTotal: digests.length,
        targets: digestTargets,
        viewCommitsLinkStatuses: digestStatuses,
      },
      reviewRequestSearch: {
        ran: reviewReturned !== undefined && reviewReturned.baselinedAt !== null,
        // The search returned nothing for this account, so what an ELEMENT looks
        // like was not observed live. Only the selectors are recorded.
        elementShapeObservedLive: false,
      },
      messagesSentToMockTransport: everythingDelivered,
      allowlistTableUnchanged: allowJobsBefore === allowJobsAfter,
      gaps,
    };
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(path.join(FIXTURES, 'live-feed.json'), `${JSON.stringify(record, null, 2)}\n`);
    out('recorded live-feed.json');
  } finally {
    await app.close();
  }

  if (gaps.length === 0) {
    out('\nEverything this probe set out to observe was observed.');
    process.exit(0);
  }
  process.stdout.write(`\nNOT FULLY OBSERVED:\n${gaps.map((g) => `  * ${g}`).join('\n')}\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`github feed live probe failed: ${(err as Error).message}\n`);
  process.exit(1);
});
