import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WATCH_EVENT_KINDS } from '@ducky/contracts';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { runImportCli } from '../src/cli/import-assistant.js';
import { OWNER, secret } from './helpers.js';
import { MANILA, importDoc, rowCounts } from './assistant-import-fixture.js';

/** The operator CLI, end to end, against real files outside the repository. Invented data only. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DUCKY_PROFILE: 'development',
  OWNER_DISCORD_USER_ID: OWNER,
  CHAT_WHITELIST_USER_IDS: '100000000000000002',
  DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(),
  DUCKY_REPOS_FILE: 'unused',
  DUCKY_OWNER_TIMEZONE: MANILA,
  DUCKY_IMPORTED_PREFERENCES: 'true',
  DUCKY_BRIEFING_ENABLED: 'true',
  DUCKY_WEATHER_LATITUDE: '14.6',
  DUCKY_WEATHER_LONGITUDE: '121.0',
  DUCKY_WEATHER_LOCATION: 'Somewhere',
};

/** A private directory (0700) holding a migrated database, a 0600 document and optionally a backup. */
function world(doc: unknown = importDoc(), opts: { migrate?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ducky-imp-'));
  dirs.push(dir);
  chmodSync(dir, 0o700);
  const dbPath = path.join(dir, 'target.db');
  const db = openDatabase({ location: dbPath });
  if (opts.migrate !== false) runMigrations(db);
  db.close();
  chmodSync(dbPath, 0o600); // explicit: never rely on the umask of whoever runs the tests
  const file = path.join(dir, 'doc.json');
  writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode: 0o600 });
  chmodSync(file, 0o600);
  const backup = path.join(dir, 'backup.db');
  const makeBackup = (): void => {
    const d = openDatabase({ location: dbPath });
    d.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    d.close();
    chmodSync(backup, 0o600);
  };
  const counts = () => {
    const d = openDatabase({ location: dbPath });
    try {
      return rowCounts(createStore(d));
    } finally {
      d.close();
    }
  };
  return { dir, dbPath, file, backup, makeBackup, counts };
}

/** What a test reader that can see every kind would declare. The shipped one declares none. */
const sees = (base: { watchCapabilities: unknown }) => ({
  ...base,
  watchCapabilities: { observableKinds: [...WATCH_EVENT_KINDS], discovery: false },
}) as never;

const run = (args: string[], opts: Parameters<typeof runImportCli>[3] = {}, env = ENV) => {
  let out = '';
  let err = '';
  const code = runImportCli(args, env, { out: (t) => (out += t), err: (t) => (err += t) }, {
    repoRoot: path.join(tmpdir(), 'not-this-repo'), ...opts,
  });
  return { code, out, err };
};

describe('what it refuses before touching any data', () => {
  it('needs an explicit database and document, and not both modes at once', () => {
    expect(run([]).code).toBe(2);
    const w = world();
    expect(run(['--db', w.dbPath]).code).toBe(2);
    expect(run(['--db', w.dbPath, '--file', w.file, '--apply', '--verify']).code).toBe(2);
  });

  it('refuses a database, document or backup inside the repository', () => {
    const w = world();
    const inside = run(['--db', w.dbPath, '--file', w.file], { repoRoot: w.dir });
    expect(inside.code).toBe(2);
    expect(inside.err).toContain('outside the repository');
    // The same files are fine from outside.
    expect(run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees }).code).toBe(0);
  });

  it('refuses a document that other users could read', () => {
    const w = world();
    chmodSync(w.file, 0o644);
    expect(run(['--db', w.dbPath, '--file', w.file]).code).toBe(2);
    chmodSync(w.file, 0o600);
    chmodSync(w.dir, 0o755);
    expect(run(['--db', w.dbPath, '--file', w.file]).code).toBe(2);
    chmodSync(w.dir, 0o700);
  });

  it('refuses a missing file and a database with pending migrations', () => {
    const w = world();
    expect(run(['--db', w.dbPath, '--file', path.join(w.dir, 'nope.json')]).code).toBe(2);
    const unmigrated = world(importDoc(), { migrate: false });
    const r = run(['--db', unmigrated.dbPath, '--file', unmigrated.file]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('pending migrations');
  });

  it('refuses an unusable configuration without echoing it', () => {
    const w = world();
    const r = run(['--db', w.dbPath, '--file', w.file], {}, { ...ENV, DUCKY_WEATHER_LATITUDE: '14.6', DUCKY_WEATHER_LONGITUDE: undefined, DUCKY_WEATHER_LOCATION: undefined });
    expect(r.code).toBe(2);
    expect(r.err).not.toContain('14.6');
  });

  it('does not echo a document that is not JSON', () => {
    const w = world('PERSONAL-MARKER { not json');
    const r = run(['--db', w.dbPath, '--file', w.file]);
    expect(r.code).toBe(3);
    expect(r.err + r.out).not.toContain('PERSONAL-MARKER');
  });
});

describe('the default is a dry run', () => {
  it('validates and reports counts, and writes nothing', () => {
    const w = world();
    const before = w.counts();
    const r = run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({ mode: 'dry_run', ok: true });
    expect(report.counts.tasks.created).toBe(3);
    expect(w.counts()).toEqual(before);
  });

  it('fails closed on watch targets with the SHIPPED reader, which observes nothing', () => {
    const w = world();
    const r = run(['--db', w.dbPath, '--file', w.file]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).issues).toContainEqual({ category: 'watch', rule: 'reader_cannot_observe', count: 16 });
    expect(w.counts().tasks).toBe(0);
  });

  it('prints counts and rule names, never a title, an id, a repository or a path', () => {
    const w = world();
    const r = run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees });
    const text = r.out + r.err;
    for (const secret of ['Water the plants', 'Pay the invoice', 'Widgets', 'a loose thought', 'Algebra', w.dir]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('--apply', () => {
  it('needs a backup, and the backup must be a copy of this database as it stands', () => {
    const w = world();
    const noBackup = run(['--db', w.dbPath, '--file', w.file, '--apply'], { importEnvironment: sees });
    expect(noBackup.code).toBe(3);
    expect(w.counts().tasks).toBe(0);

    // A backup that does not match (the database changed after it was taken).
    w.makeBackup();
    const d = openDatabase({ location: w.dbPath });
    d.prepare(`INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at) VALUES ('c','u','x','open','n','n')`).run();
    d.close();
    const stale = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(stale.code).toBe(3);
    expect(stale.err).toContain('not a copy of this database as it stands');
    expect(w.counts().tasks).toBe(0);

    // A file that is not a database at all.
    writeFileSync(w.backup, 'junk');
    expect(run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees }).code).toBe(3);
  });

  it('writes everything against a matching backup, and releases the lock', () => {
    const w = world();
    w.makeBackup();
    const r = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ mode: 'applied', ok: true });
    const c = w.counts();
    expect(c.tasks).toBe(3);
    expect(c.assistant_watch_targets).toBe(2);
    const d = openDatabase({ location: w.dbPath });
    expect((d.prepare('SELECT COUNT(*) n FROM runtime_lock').get() as { n: number }).n).toBe(0);
    d.close();
  });

  it('is repeatable: a second run against a fresh backup adds nothing', () => {
    const w = world();
    w.makeBackup();
    run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    const after = w.counts();
    rmSync(w.backup);
    w.makeBackup();
    const again = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(again.code).toBe(0);
    expect(w.counts()).toEqual(after);
  });

  it('cannot run while a live process holds the database, whatever the operator says', () => {
    const w = world();
    w.makeBackup();
    const d = openDatabase({ location: w.dbPath });
    d.prepare(
      `INSERT INTO runtime_lock (id, holder, pid, host, token, acquired_at, heartbeat_at)
       VALUES (1,'coordinator',?,?, 't', 'n', 'n')`,
    ).run(process.pid, hostname());
    d.close();
    // The lock row changes nothing the backup compares.
    const r = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(r.code).toBe(4);
    expect(r.err).toContain('live coordinator');
    expect(w.counts().tasks).toBe(0);
  });

  it('writes nothing for a foreign owner or any other refused document', () => {
    const doc = importDoc();
    doc['ownerId'] = '100000000000000099';
    const w = world(doc);
    w.makeBackup();
    const r = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).issues).toContainEqual({ category: 'document', rule: 'owner_mismatch', count: 1 });
    expect(w.counts().tasks).toBe(0);
  });
});

describe('--verify', () => {
  it('fails before the import and passes after it', () => {
    const w = world();
    expect(run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees }).code).toBe(3);
    w.makeBackup();
    run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    const v = run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees });
    expect(v.code).toBe(0);
    expect(JSON.parse(v.out)).toMatchObject({ ok: true, parity: true });
    expect(existsSync(w.file)).toBe(true);
  });

  it('exits 5, not 0, when the data is present but a record has drifted since the import', () => {
    const w = world();
    w.makeBackup();
    run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    const d = openDatabase({ location: w.dbPath });
    d.prepare("UPDATE tasks SET title = 'edited since the import'").run();
    d.close();
    const v = run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees });
    expect(v.code).toBe(5);
    const report = JSON.parse(v.out);
    expect(report).toMatchObject({ ok: true, parity: false });
    expect(report.nativeLedger).toMatchObject({ clear: true });
    expect(v.out).not.toContain('edited since the import');
  });

  it('exits 5 when the native ledger is not clear: a withheld event and a cursor at or before the cutoff', () => {
    const w = world(importDoc(), { migrate: false });
    const d = openDatabase({ location: w.dbPath });
    runMigrations(d, { upTo: 35 });
    runMigrations(d, { now: () => '2026-10-12T12:00:00.000Z' }); // a database that predates the ledger
    d.close();
    chmodSync(w.dbPath, 0o600);
    w.makeBackup();
    expect(run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees }).code).toBe(0);
    const v = run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees });
    expect(v.code).toBe(5);
    const report = JSON.parse(v.out);
    expect(report).toMatchObject({ ok: true, parity: false });
    expect(report.nativeLedger).toMatchObject({ fresh: false, clear: false, withheldLegacy: 1 });
    expect(report.nativeLedger.cursorsAtOrBeforeCutoff).toBeGreaterThan(0);
    // Counts only: no repository, event or identity.
    expect(v.out).not.toMatch(/widgets|acme|review:9/i);
  });

  it('exits 5 when a native card is held because it cannot be told from a review the target delivered', () => {
    const w = world();
    w.makeBackup();
    run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    const d = openDatabase({ location: w.dbPath });
    d.prepare(
      `INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, created_at, held_reason)
       VALUES ('h1', 'changes_requested:acme/widgets#12:X', 'changes_requested', 'acme/widgets', 'selected', NULL, 'pending', '2026-10-12T00:00:00.000Z', 'ambiguous_review')`,
    ).run();
    d.close();
    const v = run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees });
    expect(v.code).toBe(5);
    expect(JSON.parse(v.out).nativeLedger).toMatchObject({ heldNativeCards: 1, clear: false });
  });

  it('exits 5 while an ordinary-summary requested-changes fact is held, even after its watch was cancelled', () => {
    const w = world();
    w.makeBackup();
    run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    const d = openDatabase({ location: w.dbPath });
    d.prepare(`INSERT INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES ('demo','/x','acme','demo','2026-10-12T00:00:00.000Z')`).run();
    d.prepare(
      `INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key, cancelled_at)
       VALUES ('w1','wabcde','100000000000000001','demo', 15, NULL, 'cancelled', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z', 'acme/demo', '2026-10-12T00:00:00.000Z')`,
    ).run();
    d.prepare(
      `INSERT INTO github_watch_events (id, watch_id, fingerprint, summary, created_at, repo_key, held_reason, held_key)
       VALUES ('h1','w1','held:k','held, not sent','2026-10-12T00:00:00.000Z','acme/demo','ambiguous_review','changes_requested:7:${'b'.repeat(64)}')`,
    ).run();
    d.close();
    const v = run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees });
    expect(v.code).toBe(5);
    expect(JSON.parse(v.out).nativeLedger).toMatchObject({ heldOrdinaryReviews: 1, clear: false });
    // Counts only: no handle, hash or repository.
    expect(v.out).not.toMatch(/wabcde|bbbbbbbb|acme\/demo/);
  });

  const applied = () => {
    const w = world();
    w.makeBackup();
    run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    return w;
  };
  const watchRow = (d: ReturnType<typeof openDatabase>, snapshot: string | null = null): void => {
    d.prepare(`INSERT INTO repos (slug, absolute_path, github_owner, github_repo, created_at) VALUES ('demo','/x','acme','demo','2026-10-12T00:00:00.000Z')`).run();
    d.prepare(
      `INSERT INTO github_watches (id, public_id, discord_user_id, repo_slug, interval_minutes, next_check_at, state, created_at, updated_at, repo_key, cancelled_at, snapshot_json)
       VALUES ('w1','wabcde','100000000000000001','demo', 15, NULL, 'cancelled', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z', 'acme/demo', '2026-10-12T00:00:00.000Z', ?)`,
    ).run(snapshot);
  };

  it('exits 5 while an imported review row reports an impossible state change, and prints only a count', () => {
    const w = applied();
    const d = openDatabase({ location: w.dbPath });
    const target = d.prepare('SELECT id FROM assistant_watch_targets LIMIT 1').get() as { id: string };
    d.prepare(
      `INSERT INTO assistant_watch_events (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, created_at, withheld_reason, provider_state)
       VALUES ('c1', ?, 'review_approved', 'pulls', '7:review:1', '2026-10-12T00:00:00.000Z', '{}', 'observed', '2026-10-12T00:00:00.000Z', 'state_conflict', 'APPROVED')`,
    ).run(target.id);
    d.close();
    const v = run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees });
    expect(v.code).toBe(5);
    expect(JSON.parse(v.out).nativeLedger).toMatchObject({ withheldStateConflict: 1, clear: false });
    expect(v.out).not.toMatch(/7:review|acme\/widgets/);
  });

  it('exits 5 while a pull request has exact review facts refused, even after its watch was cancelled', () => {
    const w = applied();
    const d = openDatabase({ location: w.dbPath });
    watchRow(d, JSON.stringify({
      v: 3, repoName: 'demo', defaultBranch: 'main', openPrCount: 1,
      prs: [{ number: 7, title: 't', state: 'OPEN', isDraft: false, headRefName: 'f', updatedAt: '2026-10-12T00:00:00.000Z', checks: [], rf: { s: 'unavailable', known: true, pb: null, x: 'left', rv: [] } }],
    }));
    d.close();
    const v = run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees });
    expect(v.code).toBe(5);
    expect(JSON.parse(v.out).nativeLedger).toMatchObject({ refusedReviewPullRequests: 1, clear: false });
  });

  it.each([['shown'], ['delivered_not_provably_shown']])(
    'exits 5 while a per-author review line delivered without exact identity (%s) is on record',
    (shown) => {
      const w = applied();
      const d = openDatabase({ location: w.dbPath });
      d.prepare(
        `INSERT INTO github_watch_gap_markers (owner_id, watch_id, repo_key, pr_number, review_class, reason, shown, outbox_ref, delivered_at)
         VALUES ('100000000000000001', 'gone', 'acme/demo', 7, 'approval', 'unavailable', ?, 's1', '2026-10-12T00:00:00.000Z')`,
      ).run(shown);
      d.close();
      const v = run(['--db', w.dbPath, '--file', w.file, '--verify'], { importEnvironment: sees });
      expect(v.code).toBe(5);
      expect(JSON.parse(v.out).nativeLedger).toMatchObject({
        clear: false, gapMarkersShown: shown === 'shown' ? 1 : 0, gapMarkersNotProvablyShown: shown === 'shown' ? 0 : 1,
      });
      expect(v.out).not.toMatch(/acme\/demo|s1/);
    },
  );
});


describe('review fixes: paths, modes and the order of the gates', () => {
  const lockedByCoordinator = (dbPath: string): void => {
    const d = openDatabase({ location: dbPath });
    d.prepare(
      `INSERT INTO runtime_lock (id, holder, pid, host, token, acquired_at, heartbeat_at)
       VALUES (1,'coordinator',?,?, 't', 'n', 'n')`,
    ).run(process.pid, hostname());
    d.close();
  };

  it('judges a path by where it LANDS: a symlink into the repository is refused', () => {
    const w = world();
    const repo = mkdtempSync(path.join(tmpdir(), 'ducky-fakerepo-'));
    dirs.push(repo);
    chmodSync(repo, 0o700);
    const inside = path.join(repo, 'doc.json');
    copyFileSync(w.file, inside);
    chmodSync(inside, 0o600);
    const link = path.join(w.dir, 'innocent-name.json');
    symlinkSync(inside, link);
    const viaLink = run(['--db', w.dbPath, '--file', link], { repoRoot: repo, importEnvironment: sees });
    expect(viaLink.code).toBe(2);
    expect(viaLink.err).toContain('outside the repository');
    // Likewise a database or a backup reached through a link.
    const dbLink = path.join(w.dir, 'db-link.db');
    const insideDb = path.join(repo, 'x.db');
    copyFileSync(w.dbPath, insideDb);
    chmodSync(insideDb, 0o600);
    symlinkSync(insideDb, dbLink);
    expect(run(['--db', dbLink, '--file', w.file], { repoRoot: repo }).code).toBe(2);
    // And the same real files are fine when the repository is elsewhere.
    expect(run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees }).code).toBe(0);
  });

  it('refuses a database or backup that others could read, or in a directory they could enter', () => {
    const w = world();
    chmodSync(w.dbPath, 0o644);
    expect(run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees }).code).toBe(2);
    chmodSync(w.dbPath, 0o600);

    w.makeBackup();
    chmodSync(w.backup, 0o644);
    const loose = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(loose.code).toBe(2);
    expect(w.counts().tasks).toBe(0);
    chmodSync(w.backup, 0o600);

    // A backup in an open directory.
    const open = mkdtempSync(path.join(tmpdir(), 'ducky-open-'));
    dirs.push(open);
    chmodSync(open, 0o755);
    const there = path.join(open, 'b.db');
    copyFileSync(w.backup, there);
    chmodSync(there, 0o600);
    expect(run(['--db', w.dbPath, '--file', w.file, '--backup', there, '--apply'], { importEnvironment: sees }).code).toBe(2);
    expect(w.counts().tasks).toBe(0);
  });

  it('a dry run takes the lock too, and says so when a live coordinator holds the database', () => {
    const w = world();
    lockedByCoordinator(w.dbPath);
    const r = run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees });
    expect(r.code).toBe(4);
    expect(r.err).toContain('live coordinator');
    expect(r.out).toBe('');
  });

  it('a dry run leaves no lock behind', () => {
    const w = world();
    expect(run(['--db', w.dbPath, '--file', w.file], { importEnvironment: sees }).code).toBe(0);
    const d = openDatabase({ location: w.dbPath });
    expect((d.prepare('SELECT COUNT(*) n FROM runtime_lock').get() as { n: number }).n).toBe(0);
    d.close();
  });

  it('takes the lock BEFORE it looks at the backup, so a live writer is reported as that, not as a bad backup', () => {
    const w = world();
    lockedByCoordinator(w.dbPath);
    writeFileSync(w.backup, 'junk');
    chmodSync(w.backup, 0o600);
    const r = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(r.code).toBe(4);
    expect(r.err).not.toContain('backup');
  });

  it('refuses a backup with the SAME row counts but different content', () => {
    const w = world();
    const d = openDatabase({ location: w.dbPath });
    d.prepare(`INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at) VALUES ('c','u','before','open','n','n')`).run();
    d.close();
    chmodSync(w.dbPath, 0o600);
    w.makeBackup();
    const e = openDatabase({ location: w.dbPath });
    e.prepare(`UPDATE captures SET content = 'after' WHERE id = 'c'`).run();
    e.close();
    const r = run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees });
    expect(r.code).toBe(3);
    expect(r.err).toContain('not a copy of this database as it stands');
    expect(r.err).not.toMatch(/before|after/);
    expect(w.counts().tasks).toBe(0);
  });

  it('still applies against a backup that matches in content', () => {
    const w = world();
    const d = openDatabase({ location: w.dbPath });
    d.prepare(`INSERT INTO captures (id, discord_user_id, content, status, created_at, updated_at) VALUES ('c','u','kept','open','n','n')`).run();
    d.close();
    chmodSync(w.dbPath, 0o600);
    w.makeBackup();
    expect(run(['--db', w.dbPath, '--file', w.file, '--backup', w.backup, '--apply'], { importEnvironment: sees }).code).toBe(0);
  });
});
