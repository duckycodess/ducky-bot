import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { RepoAllowlist, RepoAllowlistSchema } from '../src/domain/allowlist.js';
import { makeHarness, OWNER } from './helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const config = (repos: unknown[]): string => JSON.stringify({ version: 1, repos });

const WSL = '/home/dev/projects/app';
const AZURE = '/var/lib/ducky/repos/app';

const twoHosts = config([
  {
    slug: 'app',
    placements: [
      { executorId: 'wsl-dev', absolutePath: WSL },
      { executorId: 'azure-prod', absolutePath: AZURE },
    ],
    defaultBranch: 'main',
  },
]);

describe('repository placements', () => {
  describe('configuration', () => {
    it('keeps the single-path form meaning exactly what it always meant', () => {
      const a = RepoAllowlist.fromJson(
        config([{ slug: 'app', absolutePath: '/srv/app', defaultBranch: 'main' }]),
      );
      const repo = a.resolve('app');
      expect(repo.placements).toEqual([]);
      expect(repo.allowJobs).toBe(true);
      // Any executor at all, because that is what one path has always meant.
      for (const id of ['wsl-dev', 'azure-prod', 'somebody-else']) {
        expect(a.placementFor(repo, id)).toEqual({
          absolutePath: '/srv/app',
          source: 'default',
        });
      }
      // There is no SET of eligible executors to enumerate, and inventing one
      // would make the answer depend on who happened to be online.
      expect(a.eligibleExecutors(repo)).toBeUndefined();
    });

    it('resolves a different absolute path per executor', () => {
      const a = RepoAllowlist.fromJson(twoHosts);
      const repo = a.resolve('app');
      expect(a.placementFor(repo, 'wsl-dev')?.absolutePath).toBe(WSL);
      expect(a.placementFor(repo, 'azure-prod')?.absolutePath).toBe(AZURE);
      expect(a.placementFor(repo, 'wsl-dev')?.source).toBe('placement');
    });

    it('is EXHAUSTIVE once placements exist: an unlisted executor gets nothing', () => {
      const a = RepoAllowlist.fromJson(twoHosts);
      const repo = a.resolve('app');
      expect(a.placementFor(repo, 'a-third-host')).toBeUndefined();
      expect(a.slugsFor('a-third-host')).toEqual([]);
    });

    it('lets one host be taken out of rotation without deleting its path', () => {
      const a = RepoAllowlist.fromJson(
        config([
          {
            slug: 'app',
            placements: [
              { executorId: 'wsl-dev', absolutePath: WSL },
              { executorId: 'azure-prod', absolutePath: AZURE, enabled: false },
            ],
          },
        ]),
      );
      const repo = a.resolve('app');
      expect(a.placementFor(repo, 'azure-prod')).toBeUndefined();
      expect(a.placementFor(repo, 'wsl-dev')?.absolutePath).toBe(WSL);
      expect(a.eligibleExecutors(repo)).toEqual(['wsl-dev']);
    });

    it('refuses both forms at once rather than deciding which wins', () => {
      expect(() =>
        RepoAllowlist.fromJson(
          config([
            {
              slug: 'app',
              absolutePath: '/srv/app',
              placements: [{ executorId: 'wsl-dev', absolutePath: WSL }],
            },
          ]),
        ),
      ).toThrow(/Pick one/);
    });

    it('refuses a repository that accepts jobs but names no path', () => {
      expect(() => RepoAllowlist.fromJson(config([{ slug: 'app' }]))).toThrow(/names no path/);
      // ...and accepts the same entry once it is honestly watch-only.
      expect(() =>
        RepoAllowlist.fromJson(
          config([{ slug: 'app', allowJobs: false, github: { owner: 'acme', repo: 'app' } }]),
        ),
      ).not.toThrow();
    });

    it('refuses a duplicate executor and an unplaced preference', () => {
      expect(() =>
        RepoAllowlist.fromJson(
          config([
            {
              slug: 'app',
              placements: [
                { executorId: 'wsl-dev', absolutePath: WSL },
                { executorId: 'wsl-dev', absolutePath: AZURE },
              ],
            },
          ]),
        ),
      ).toThrow(/twice/);

      expect(() =>
        RepoAllowlist.fromJson(
          config([
            {
              slug: 'app',
              preferredExecutorId: 'ghost',
              placements: [{ executorId: 'wsl-dev', absolutePath: WSL }],
            },
          ]),
        ),
      ).toThrow(/no placement/);
    });

    it('still takes no path from anywhere but this file', () => {
      // The whole model rests on this: Discord names a slug, and only a slug.
      const a = RepoAllowlist.fromJson(twoHosts);
      for (const bad of ['/home/dev/projects/app', '../app', 'app/../other', 'APP']) {
        expect(() => a.resolve(bad), bad).toThrow(/not/i);
      }
    });

    it('parses the shipped configuration files, so neither can drift', () => {
      // The example documents the model and the dev file is what this host
      // actually loads. A schema change that broke either would otherwise be
      // found at boot.
      for (const file of ['config/repos.example.json', 'config/repos.dev.json']) {
        const raw = readFileSync(path.join(REPO_ROOT, file), 'utf8');
        const parsed = RepoAllowlistSchema.safeParse(JSON.parse(raw));
        expect(parsed.success, `${file}: ${parsed.error?.message ?? ''}`).toBe(true);
      }
    });

    it('keeps the watch-only mapping in the dev config genuinely read-only', () => {
      const a = RepoAllowlist.fromJson(
        readFileSync(path.join(REPO_ROOT, 'config/repos.dev.json'), 'utf8'),
      );
      const watched = a.list().filter((r) => !r.allowJobs);
      expect(watched.length).toBeGreaterThan(0);
      for (const repo of watched) {
        // A watch target has a GitHub mapping and no path anywhere.
        expect(repo.github).not.toBeNull();
        expect(repo.absolutePath).toBeNull();
        expect(repo.placements).toEqual([]);
        expect(a.eligibleExecutors(repo)).toEqual([]);
      }
    });
  });

  describe('claim eligibility', () => {
    const harnessWith = (repos: unknown[]) => makeHarness({ allowlistJson: config(repos) });

    /** Marks an executor live by the same route the real one uses. */
    const live = (h: ReturnType<typeof makeHarness>, id: string): void => {
      h.store.executors.upsertExecutor(id, id);
      h.store.executors.touchExecutor(id, '0.0.0-test');
    };

    it('hands a job only to an executor that has the repository checked out', () => {
      const h = harnessWith([
        { slug: 'app', placements: [{ executorId: 'wsl-dev', absolutePath: WSL }] },
      ]);
      live(h, 'wsl-dev');
      live(h, 'other-host');
      h.app.jobs.submit(h.owner, { repoSlug: 'app', task: 't', bootstrap: false });

      expect(h.app.jobs.claim('other-host', 'k1')).toBeUndefined();
      const claimed = h.app.jobs.claim('wsl-dev', 'k2');
      expect(claimed?.payload.absolutePath).toBe(WSL);
      h.close();
    });

    it('sends each executor its OWN path for the same logical slug', () => {
      const h = harnessWith([
        {
          slug: 'app',
          placements: [
            { executorId: 'wsl-dev', absolutePath: WSL },
            { executorId: 'azure-prod', absolutePath: AZURE },
          ],
        },
        {
          slug: 'app2',
          placements: [
            { executorId: 'wsl-dev', absolutePath: `${WSL}-2` },
            { executorId: 'azure-prod', absolutePath: `${AZURE}-2` },
          ],
        },
      ]);
      live(h, 'wsl-dev');
      live(h, 'azure-prod');
      h.app.jobs.submit(h.owner, { repoSlug: 'app', task: 't', bootstrap: false });
      h.app.jobs.submit(h.owner, { repoSlug: 'app2', task: 't', bootstrap: false });

      const first = h.app.jobs.claim('wsl-dev', 'k1');
      const second = h.app.jobs.claim('azure-prod', 'k2');
      expect(first?.payload.repoSlug).toBe('app');
      expect(first?.payload.absolutePath).toBe(WSL);
      // The second executor gets the OTHER repository -- `app` is reserved --
      // and it gets that repository's path for ITSELF, not the first host's.
      expect(second?.payload.repoSlug).toBe('app2');
      expect(second?.payload.absolutePath).toBe(`${AZURE}-2`);
      h.close();
    });

    it('keeps ONE reservation per logical slug, across every executor', () => {
      // The guarantee the whole model has to preserve: two hosts, one repo,
      // one job at a time. The reservation is keyed on the slug and knows
      // nothing about placements.
      const h = harnessWith([
        {
          slug: 'app',
          placements: [
            { executorId: 'wsl-dev', absolutePath: WSL },
            { executorId: 'azure-prod', absolutePath: AZURE },
          ],
        },
      ]);
      live(h, 'wsl-dev');
      live(h, 'azure-prod');
      h.app.jobs.submit(h.owner, { repoSlug: 'app', task: 'first', bootstrap: false });
      h.app.jobs.submit(h.owner, { repoSlug: 'app', task: 'second', bootstrap: false });

      expect(h.app.jobs.claim('wsl-dev', 'k1')).toBeDefined();
      // The second host cannot start the second job in the same repository,
      // even though it has its own checkout of it.
      expect(h.app.jobs.claim('azure-prod', 'k2')).toBeUndefined();
      expect(
        h.store.db.prepare('SELECT COUNT(*) AS n FROM repo_reservations').get(),
      ).toEqual({ n: 1 });
      h.close();
    });

    it('prefers the named host while it is live, and falls back once it is not', () => {
      const h = harnessWith([
        {
          slug: 'app',
          preferredExecutorId: 'wsl-dev',
          placements: [
            { executorId: 'wsl-dev', absolutePath: WSL },
            { executorId: 'azure-prod', absolutePath: AZURE },
          ],
        },
      ]);
      live(h, 'wsl-dev');
      live(h, 'azure-prod');
      h.app.jobs.submit(h.owner, { repoSlug: 'app', task: 't', bootstrap: false });

      // Preferred host is live, so the other one is passed over.
      expect(h.app.jobs.claim('azure-prod', 'k1')).toBeUndefined();
      expect(h.app.jobs.claim('wsl-dev', 'k2')).toBeDefined();
      h.close();
    });

    it('falls back to another placed host when the preferred one goes offline', () => {
      const h = harnessWith([
        {
          slug: 'app',
          preferredExecutorId: 'wsl-dev',
          placements: [
            { executorId: 'wsl-dev', absolutePath: WSL },
            { executorId: 'azure-prod', absolutePath: AZURE },
          ],
        },
      ]);
      // `wsl-dev` is registered but has never checked in, so it is not live.
      h.store.executors.upsertExecutor('wsl-dev', 'wsl-dev');
      live(h, 'azure-prod');
      h.app.jobs.submit(h.owner, { repoSlug: 'app', task: 't', bootstrap: false });

      const claimed = h.app.jobs.claim('azure-prod', 'k1');
      expect(claimed?.payload.absolutePath).toBe(AZURE);
      h.close();
    });

    it('waits rather than running somewhere it was never placed', () => {
      const h = harnessWith([
        { slug: 'app', placements: [{ executorId: 'wsl-dev', absolutePath: WSL }] },
      ]);
      live(h, 'azure-prod');
      const job = h.app.jobs.submit(h.owner, { repoSlug: 'app', task: 't', bootstrap: false });

      expect(h.app.jobs.claim('azure-prod', 'k1')).toBeUndefined();
      // Still queued, not failed: an offline host is a wait, not an error.
      expect(h.store.jobs.byId(job.id)?.state).toBe('queued');
      expect(h.app.jobs.placementHold('app')).toMatch(/none is online/);
      h.close();
    });

    it('says plainly when no executor is configured for a repository at all', () => {
      const h = harnessWith([
        {
          slug: 'app',
          placements: [{ executorId: 'wsl-dev', absolutePath: WSL, enabled: false }],
        },
      ]);
      expect(h.app.jobs.placementHold('app')).toMatch(/No executor is configured/);
      h.close();
    });

    it('holds nothing back for the single-path form', () => {
      const h = harnessWith([{ slug: 'app', absolutePath: WSL }]);
      expect(h.app.jobs.placementHold('app')).toBeUndefined();
      h.close();
    });
  });

  describe('a watch-only mapping', () => {
    it('refuses a job at SUBMIT, so nothing is queued that could never run', () => {
      const h = makeHarness({
        allowlistJson: config([
          { slug: 'app', absolutePath: WSL },
          { slug: 'watched', allowJobs: false, github: { owner: 'acme', repo: 'watched' } },
        ]),
      });
      expect(() =>
        h.app.jobs.submit(h.owner, { repoSlug: 'watched', task: 't', bootstrap: false }),
      ).toThrow(/read-only observation/);
      expect(h.store.jobs.listRecent(OWNER, 10)).toHaveLength(0);
      h.close();
    });

    it('is invisible to the claim predicate as well', () => {
      const a = RepoAllowlist.fromJson(
        config([{ slug: 'watched', allowJobs: false, github: { owner: 'acme', repo: 'watched' } }]),
      );
      expect(a.slugsFor('wsl-dev')).toEqual([]);
      expect(a.eligibleExecutors(a.resolve('watched'))).toEqual([]);
    });
  });

  describe('the mirrored tables', () => {
    it('mirrors placements and replaces them when configuration changes', () => {
      const db = openDatabase({ location: ':memory:' });
      runMigrations(db);
      const store = createStore(db);
      const a = RepoAllowlist.fromJson(twoHosts);
      for (const row of a.toRepoRows()) {
        store.repos.upsert(row);
        store.repos.replacePlacements(row.slug, a.toPlacementRows(row.slug));
      }
      expect(store.repos.placements('app').map((p) => p.executorId)).toEqual([
        'azure-prod',
        'wsl-dev',
      ]);
      // The placement form has no single host path, so the mirrored row has none.
      expect(store.repos.get('app')?.localPath).toBeNull();

      // Taking a host out of the configuration removes it, rather than leaving
      // a path nobody reviewed any more.
      const shrunk = RepoAllowlist.fromJson(
        config([{ slug: 'app', placements: [{ executorId: 'wsl-dev', absolutePath: WSL }] }]),
      );
      for (const row of shrunk.toRepoRows()) {
        store.repos.upsert(row);
        store.repos.replacePlacements(row.slug, shrunk.toPlacementRows(row.slug));
      }
      expect(store.repos.placements('app').map((p) => p.executorId)).toEqual(['wsl-dev']);
      db.close();
    });

    it('carries an existing single-path row through the migration unchanged', () => {
      const db = openDatabase({ location: ':memory:' });
      runMigrations(db);
      const store = createStore(db);
      store.repos.upsert({
        slug: 'app', localPath: '/srv/app', defaultBranch: 'main', githubOwner: null,
        githubRepo: null, allowWorktree: true, allowBootstrap: false,
        bootstrapAllowedEntries: ['.git'], allowJobs: true, enabled: true,
      });
      expect(store.repos.get('app')?.localPath).toBe('/srv/app');
      expect(store.repos.get('app')?.allowJobs).toBe(true);
      db.close();
    });
  });
});

describe('GitHub-bound sync configuration', () => {
  it('refuses fetchBeforeJob without something to fetch from', () => {
    expect(() =>
      RepoAllowlist.fromJson(
        config([{ slug: 'app', absolutePath: WSL, defaultBranch: 'main', fetchBeforeJob: true }]),
      ),
    ).toThrow(/no GitHub mapping/);
  });

  it('refuses fetchBeforeJob without a branch to fetch', () => {
    expect(() =>
      RepoAllowlist.fromJson(
        config([
          {
            slug: 'app',
            absolutePath: WSL,
            github: { owner: 'acme', repo: 'app' },
            fetchBeforeJob: true,
          },
        ]),
      ),
    ).toThrow(/names no `defaultBranch`/);
  });

  it('sends the mapping and the flag to the executor that claims', () => {
    const h = makeHarness({
      allowlistJson: config([
        {
          slug: 'app',
          absolutePath: WSL,
          defaultBranch: 'main',
          github: { owner: 'acme', repo: 'app' },
          fetchBeforeJob: true,
        },
      ]),
    });
    h.store.executors.upsertExecutor('wsl-dev', 'wsl-dev');
    h.store.executors.touchExecutor('wsl-dev', '0.0.0-test');
    h.app.jobs.submit(h.owner, { repoSlug: 'app', task: 't', bootstrap: false });

    const claimed = h.app.jobs.claim('wsl-dev', 'k1');
    // The executor cannot check that the checkout is the right repository
    // unless it is told which repository that is.
    expect(claimed?.payload.github).toEqual({ owner: 'acme', repo: 'app' });
    expect(claimed?.payload.fetchBeforeJob).toBe(true);
    h.close();
  });

  it('defaults both off, so an existing configuration changes nothing', () => {
    const h = makeHarness({ allowlistJson: config([{ slug: 'app', absolutePath: WSL }]) });
    h.store.executors.upsertExecutor('wsl-dev', 'wsl-dev');
    h.store.executors.touchExecutor('wsl-dev', '0.0.0-test');
    h.app.jobs.submit(h.owner, { repoSlug: 'app', task: 't', bootstrap: false });
    const claimed = h.app.jobs.claim('wsl-dev', 'k1');
    expect(claimed?.payload.github).toBeNull();
    expect(claimed?.payload.fetchBeforeJob).toBe(false);
    h.close();
  });
});
