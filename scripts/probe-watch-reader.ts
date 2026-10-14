#!/usr/bin/env tsx
/**
 * PROBE -- the typed notification-watch reads, against an owner-approved PUBLIC repository.
 *
 * `pnpm probe:watch-reader` drives the SHIPPED reader (`GhWatchReader`, the exact
 * `gh api --method GET` shapes, `checkCommandAllowed`, `runArgv` and the pinned
 * zod schemas) once per approved surface and says whether each answer parsed.
 *
 * It is READ-ONLY and sends no notification: the reader has no write method, the
 * policy refuses every non-GET shape, and nothing here touches a database or a
 * transport.
 *
 * WHAT IT PRINTS: the surface, ok or not, and an item COUNT. Never a title, a
 * branch, a login, a URL, a SHA, a body or any identifier of the repository.
 *
 * TARGET: only the repositories in APPROVED below. The one named there is the
 * public repository the owner approved for read-only probing. A private or
 * unlisted repository is refused, so this cannot be pointed at one by accident.
 *
 * DISCOVERY is a separate authorization and is NOT probed unless `--with-discovery`
 * is given, because it reads the authenticated account's repository list.
 *
 * EXIT CODES (a probe that cannot fail certifies nothing):
 *   0  every approved surface answered and parsed
 *   3  the target is not an approved probe target
 *   4  a surface failed, or evidence is missing (for example a repository with no
 *      pull request, so reviews could not be exercised)
 */
import { GhWatchReader } from '../packages/adapters/src/github/watch-reader.js';
import { WatchReadError } from '../packages/adapters/src/github/watch.port.js';

const APPROVED: readonly string[] = ['duckycodess/ducky-bot'];

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const args = process.argv.slice(2);
const repoArg = args.find((a) => a.startsWith('--repo='))?.slice('--repo='.length) ?? APPROVED[0]!;
const withDiscovery = args.includes('--with-discovery');
if (!APPROVED.includes(repoArg.toLowerCase())) {
  out('refused: that repository is not an approved probe target.');
  process.exit(3);
}
const [owner, repo] = repoArg.split('/') as [string, string];
const ref = { owner, repo };
const reader = new GhWatchReader({ discovery: withDiscovery });

let missing = 0;
const record = (surface: string, ok: boolean, detail: string): void => {
  out(`${ok ? 'ok     ' : 'MISSING'} ${surface.padEnd(12)} ${detail}`);
  if (!ok) missing += 1;
};

async function step<T>(surface: string, fn: () => Promise<T>, describe: (v: T) => string): Promise<T | undefined> {
  try {
    const v = await fn();
    record(surface, true, describe(v));
    return v;
  } catch (err) {
    record(surface, false, `failed (${err instanceof WatchReadError ? err.code : 'error'})`);
    return undefined;
  }
}

const repository = await step('repository', () => reader.repository(ref), () => 'identity matched, default branch read');
const branch = repository?.defaultBranch ?? 'main';
const pulls = await step('pulls', () => reader.pulls(ref, 1), (p) => `${p.items.length} item(s), hasMore=${p.hasMore}`);
const open = pulls?.items[0];
if (open) {
  await step('reviews', () => reader.pullReviews(ref, open.number, 1), (p) => `${p.items.length} item(s)`);
} else {
  record('reviews', false, 'no pull request to read reviews of');
}
await step('issues', () => reader.issues(ref, 1), (p) => `${p.items.length} item(s), hasMore=${p.hasMore}`);
await step('runs', () => reader.runs(ref, branch, 1), (p) => `${p.items.length} item(s), total=${p.total ?? 'none'}`);
await step('releases', () => reader.releases(ref, 1), (p) => `${p.items.length} item(s), hasMore=${p.hasMore}`);
await step('commits', () => reader.commits(ref, branch, 1), (p) => `${p.items.length} item(s)`);

if (withDiscovery) {
  await step('discovery', () => reader.discover(1), (p) => `${p.items.length} item(s), hasMore=${p.hasMore}`);
} else {
  out('not probed discovery    (a separate authorization: pass --with-discovery to probe it)');
}

if (missing > 0) {
  out(`${missing} surface(s) missing evidence.`);
  process.exit(4);
}
out('every approved surface answered and parsed.');
