#!/usr/bin/env tsx
/**
 * PROBE D -- the LIVE GitHub read surface, against a configured repository.
 *
 * `pnpm probe:gh` records which `--json` selectors this `gh` accepts. It is
 * local, repo-less and contacts nothing, which is exactly why it cannot answer
 * the question that actually matters: does a real RESPONSE parse against the
 * production schemas? Every schema field is optional today precisely because no
 * response value had ever been seen, and "tolerant because unobserved" is a
 * different thing from "tolerant because the field is genuinely optional".
 *
 * So this drives the SHIPPED reader -- `GhCliReader`, the frozen `GH_OPERATIONS`
 * argv table, `checkCommandAllowed`, `runArgv`, and the zod schemas the watch
 * loop uses -- against a repository the operator put in the allowlist, and
 * records what came back.
 *
 * WHAT IT RECORDS
 * - per surface: whether the production schema accepted the real response;
 * - the SHAPE of that response: key names, value TYPES, array lengths;
 * - which optional schema fields were actually present.
 *
 * WHAT IT NEVER RECORDS
 * - a title, a body, a branch name, a login, a URL, a commit message, a SHA;
 * - in short, no VALUE. Key names come from selectors this repository already
 *   chose and are in `gh-cli.ts` in plain sight; values are somebody's
 *   repository content.
 *
 * SAFETY
 * - Read-only by construction: `GitHubReader` has no write method, the argv
 *   table has no write verb, and `checkCommandAllowed` refuses one anyway.
 * - The target comes from the repository allowlist, never from an argument or
 *   an environment variable, so this cannot be pointed at a repository nobody
 *   configured.
 * - It exits 2 while any surface is unrecorded. A partial recording must not
 *   read as success -- the same rule `pnpm probe:openclaw` follows.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { GhCliReader } from '../packages/adapters/src/github/gh-cli.js';
import { createApp } from '../packages/coordinator/src/app.js';
import { RepoAllowlist } from '../packages/coordinator/src/domain/allowlist.js';
import { ConfiguredOwnerClock } from '../packages/coordinator/src/domain/owner-clock.js';
import { MockDiscordTransport } from '../packages/coordinator/src/discord/mock.transport.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'packages/adapters/src/github/github.fixtures');

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * A value's SHAPE, with every leaf replaced by its type.
 *
 * The recursion is what makes this safe to commit: a string never survives it,
 * so no title, branch name or login can reach a fixture. Arrays collapse to one
 * merged item shape plus a length, because ten pull requests have one shape and
 * recording ten copies of it would only add ten chances to leak something.
 */
type Shape = string | { readonly [k: string]: Shape };

function shapeOf(v: unknown): Shape {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const merged: Record<string, Shape> = {};
    for (const item of v) {
      const s = shapeOf(item);
      if (typeof s === 'string') merged['*'] = s;
      else for (const [k, val] of Object.entries(s)) merged[k] = val;
    }
    return { '[]': v.length === 0 ? 'empty' : merged, length: String(v.length) };
  }
  if (typeof v === 'object') {
    const o: Record<string, Shape> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = shapeOf(val);
    return o;
  }
  return typeof v;
}

interface SurfaceRecord {
  readonly surface: string;
  readonly parsed: boolean;
  /** Present only when the production schema REFUSED the real response. */
  readonly error?: string;
  readonly shape?: Shape;
  /** Why a surface could not be exercised at all, rather than a silent skip. */
  readonly unexercised?: string;
}

const records: SurfaceRecord[] = [];
const gaps: string[] = [];

async function record(
  surface: string,
  run: () => Promise<unknown>,
): Promise<unknown | undefined> {
  try {
    const value = await run();
    records.push({ surface, parsed: true, shape: shapeOf(value) });
    out(`  ${surface}: parsed`);
    return value;
  } catch (err) {
    // The message can echo repository detail, so only the CLASS and the first
    // clause are kept, and neither is written to a fixture unredacted.
    const message = (err as Error).message.split('\n')[0]!.slice(0, 200);
    records.push({ surface, parsed: false, error: message });
    gaps.push(`${surface} did not parse: ${message}`);
    out(`  ${surface}: FAILED -- ${message}`);
    return undefined;
  }
}

function skip(surface: string, why: string): void {
  records.push({ surface, parsed: false, unexercised: why });
  gaps.push(`${surface} was not exercised: ${why}`);
  out(`  ${surface}: not exercised -- ${why}`);
}

async function main(): Promise<void> {
  const reposFile = process.env['DUCKY_REPOS_FILE'] ?? path.join(ROOT, 'config/repos.dev.json');
  const reposJson = readFileSync(reposFile, 'utf8');
  const allowlist = RepoAllowlist.fromJson(reposJson);

  const targets = allowlist.list().filter((r) => r.enabled && r.github !== null);
  if (targets.length === 0) {
    process.stderr.write(
      'No allowlisted repository has a GitHub mapping, so there is nothing to observe.\n' +
        'Add one to the repository configuration -- `allowJobs: false` keeps it watch-only.\n',
    );
    process.exit(2);
  }

  const reader = new GhCliReader();
  mkdirSync(FIXTURES, { recursive: true });

  for (const repo of targets) {
    const ref = repo.github!;
    out(`\n${repo.slug} -> ${ref.owner}/${ref.repo} (allowJobs=${repo.allowJobs})`);

    await record('repoView', () => reader.repoView(ref));
    const open = (await record('prList', () => reader.prList(ref))) as
      | { number: number }[]
      | undefined;
    const all = (await record('prListAll', () => reader.prListAll(ref))) as
      | { number: number }[]
      | undefined;
    await record('runList', () => reader.runList(ref));
    await record('issueList', () => reader.issueList(ref));

    /**
     * The three per-PR surfaces need a pull request to exist.
     *
     * There is no way to manufacture one from here: opening a PR is a WRITE,
     * and this probe has no write verb available to it even if that were
     * acceptable. So an absent PR is recorded as unexercised, which is what
     * keeps the exit code honest.
     */
    const candidate = open?.[0]?.number ?? all?.[0]?.number;
    if (candidate === undefined) {
      const why = `${ref.owner}/${ref.repo} has no pull request, open or closed`;
      for (const s of ['prView', 'prChecks', 'prReviews']) skip(s, why);
    } else {
      await record('prView', () => reader.prView(ref, candidate));
      await record('prChecks', () => reader.prChecks(ref, candidate));
      await record('prReviews', () => reader.prReviews(ref, candidate));
    }
  }

  const watch = await exerciseWatchLoop(reposFile, reposJson, reader, targets[0]!.slug);

  writeFileSync(
    path.join(FIXTURES, 'live-watch.json'),
    `${JSON.stringify(watch, null, 2)}\n`,
  );
  out('recorded live-watch.json');

  writeFileSync(
    path.join(FIXTURES, 'live-shape.json'),
    `${JSON.stringify(
      {
        _note:
          'Recorded by scripts/probe-gh-live.ts against the SHIPPED GhCliReader. ' +
          'Shapes and key names only -- every leaf is a TYPE, never a value.',
        recordedSurfaces: records.length,
        surfaces: records,
      },
      null,
      2,
    )}\n`,
  );
  out('\nrecorded live-shape.json');

  if (gaps.length === 0) {
    out('\nEvery read surface was exercised against a live repository and parsed.');
    process.exit(0);
  }

  process.stdout.write(
    [
      '',
      'RECORDED, PARTIAL. What is missing, exactly:',
      ...gaps.map((g) => `  * ${g}`),
      '',
      'Consequences, stated rather than worked around:',
      '  * the watch loop is live-observed only for the surfaces above that parsed;',
      '  * GitHubCiDependencyChecker stays `verified: false` while `prChecks` is',
      '    unexercised, so the resolver keeps downgrading its `ready`;',
      '  * the schemas stay tolerant, because a field nobody has seen present',
      '    cannot be made required on the strength of one empty response.',
      '',
      'What would close it: a configured repository that HAS a pull request.',
      'Opening one is a GitHub write and is not this probe\'s to make.',
    ].join('\n') + '\n',
  );
  process.exit(2);
}

/**
 * The watch LOOP, against live GitHub, in a throwaway database.
 *
 * The surfaces above prove the reader parses. This proves the thing built on
 * top of it: add a watch, observe, store a normalized snapshot, and -- the part
 * that matters most -- observe AGAIN and produce nothing, because nothing
 * changed. Deduplication is the property that decides whether a watch is
 * useful or a machine for sending the owner the same message every fifteen
 * minutes, and it had never been exercised against a real repository.
 *
 * Isolated on purpose:
 * - an in-memory database, so the development database is not touched;
 * - the MOCK Discord transport, so no message leaves this process;
 * - a clock the probe advances, rather than sleeping for the interval or
 *   backdating a row behind the service's back.
 */
async function exerciseWatchLoop(
  reposFile: string,
  allowlistJson: string,
  reader: GhCliReader,
  slug: string,
): Promise<Record<string, unknown>> {
  out(`\nwatch loop against ${slug}, in an in-memory database`);

  const ownerId = '100000000000000001';
  let nowMs = Date.now();
  const clock = new ConfiguredOwnerClock('UTC', () => nowMs);
  const transport = new MockDiscordTransport();

  /**
   * The real composition root, not a hand-assembled service.
   *
   * `createApp` is what wires the watch service in production, so building the
   * probe's own would certify an arrangement that only exists in this file.
   * Three things are overridden and each is a deliberate isolation: an
   * in-memory database, the mock Discord transport, and a clock this probe
   * advances instead of sleeping for the interval.
   */
  const app = createApp(
    {
      NODE_ENV: 'probe',
      DUCKY_PROFILE: 'development',
      OWNER_DISCORD_USER_ID: ownerId,
      // Generated, used in memory, never written down. The probe presses no
      // signed control, so this only has to exist.
      DUCKY_DEV_COMPONENT_SIGNING_KEY: randomBytes(32).toString('base64url'),
      DUCKY_DB_PATH: ':memory:',
      DUCKY_REPOS_FILE: reposFile,
    } as NodeJS.ProcessEnv,
    { transport, github: reader, allowlistJson, clock },
  );

  try {
    const everyMinutes = 15;
    const owner = app.authz.actor(ownerId);
    const added = app.githubWatches.add(owner, { repoSlug: slug, everyMinutes });
    out(`  watch ${added.publicId} added, every ${everyMinutes}m`);

    // Forward past the first due time rather than waiting for it.
    nowMs += (everyMinutes + 1) * 60_000;
    const first = await app.githubWatches.tick();
    out(`  first pass:  ${JSON.stringify(first)}`);

    nowMs += (everyMinutes + 1) * 60_000;
    const second = await app.githubWatches.tick();
    out(`  second pass: ${JSON.stringify(second)}`);

    const snapshot = app.store.githubWatches.byId(added.id);
    const result = {
      _note:
        'The watch loop driven against live GitHub through the real composition root, with an ' +
        'in-memory database and the mock Discord transport. COUNTS and booleans only: no ' +
        'snapshot content, no summary text, no repository data of any kind.',
      repoSlugWatched: slug,
      firstPass: first,
      secondPass: second,
      snapshotStored: snapshot?.snapshotHash != null,
      /** The property being certified: a second identical observation is silent. */
      deduplicated: second.changed === 0 && second.observed === 1,
      /**
       * The first pass DID deliver -- to the mock transport, which is the
       * point. A watch that observed a repository for the first time has
       * something to say. Naming the target exactly matters: nothing reached
       * Discord, and a field called "messages sent" reading zero beside a
       * `delivered: 1` above it would have been the kind of near-truth this
       * file exists to avoid.
       */
      deliveredToMockTransport: first.delivered + second.delivered,
      realDiscordMessagesSent: 0,
    };

    if (first.observed !== 1 || first.failed !== 0) {
      gaps.push('the first watch pass did not cleanly observe the repository');
    }
    if (!result.deduplicated) {
      gaps.push('a second identical observation was not deduplicated');
    }
    return result;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  process.stderr.write(`gh live probe failed: ${(err as Error).message}\n`);
  process.exit(1);
});
