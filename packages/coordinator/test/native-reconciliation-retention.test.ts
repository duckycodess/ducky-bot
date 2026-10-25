import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETENTION_FORBIDDEN_TABLES } from '@ducky/contracts';
import { RetentionService } from '../src/domain/retention.service.js';
import { OWNER, makeHarness } from './helpers.js';

/**
 * What native paths told the owner must outlive the rows that told it (ADR 0034): retention may prune
 * an outbox row or a feed card, never the receipt, the boundary or the pause provenance. And no native
 * path may consult a promise of future coverage. Invented data only.
 */
const old = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

const policy = {
  enabled: true, jobMetadataDays: 90, jobDetailDays: 30, doneCaptureDays: 365, closedTaskDays: 90,
  closedReminderDays: 90, pastScheduleDays: 180, auditDays: 90, watchEventDays: 1, idempotencyDays: 7,
  cancelledWatchDays: 365, runLogDays: 365, conversationOwnerDays: 30, conversationOtherDays: 7,
  closedThreadDays: 14, batch: 200,
};

describe('retention never touches the ledger', () => {
  it('names the ledger, its boundary, its staging and the pause provenance as forbidden tables', () => {
    for (const t of ['native_transition_claims', 'native_ledger_boundary', 'native_legacy_seed', 'assistant_watch_pause_periods']) {
      expect(RETENTION_FORBIDDEN_TABLES as readonly string[], t).toContain(t);
    }
  });

  it('prunes the feed card and the outbox row that were told, and keeps every receipt, the boundary and the pauses', async () => {
    const h = makeHarness();
    const at = old(400);
    h.store.githubFeed.insertRepo({ repoKey: 'acme/demo', display: 'acme/demo', source: 'explicit', atIso: at });
    h.store.db.prepare(
      `INSERT INTO github_feed_events (id, event_key, kind, repo_key, origin, card_json, status, delivered_at, delivered_to, created_at)
       VALUES ('f1','pr_opened:acme/demo#7','pr_opened','acme/demo','selected',NULL,'delivered',?,'owner_dm',?)`,
    ).run(at, at);
    h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'pr_opened', item: '7', stamp: null, hash: null, attempt: null }, 'feed_event', 'f1', at, at);
    h.store.nativeTransitions.markNativeDelivered('feed_event', 'f1', 'owner_dm', at);
    h.store.assistantWatch.setMonitoring(OWNER, false, at, 'import');
    const before = {
      claims: h.store.db.prepare('SELECT * FROM native_transition_claims').all(),
      boundary: h.store.db.prepare('SELECT * FROM native_ledger_boundary').all(),
      pauses: h.store.db.prepare('SELECT * FROM assistant_watch_pause_periods').all(),
    };
    const out = await new RetentionService({ store: h.store, policy }).tick();
    expect(out.ran).toBe(true);
    // The settled card is pruned...
    expect(h.store.githubFeed.listEvents('delivered')).toEqual([]);
    // ...and what it told is still known, so the same transition is never told again.
    expect({
      claims: h.store.db.prepare('SELECT * FROM native_transition_claims').all(),
      boundary: h.store.db.prepare('SELECT * FROM native_ledger_boundary').all(),
      pauses: h.store.db.prepare('SELECT * FROM assistant_watch_pause_periods').all(),
    }).toEqual(before);
    expect(h.store.nativeTransitions.resolveTarget(OWNER, 'acme/demo', {
      kind: 'pr_opened', identity: '7:opened', occurredAt: at, providerHash: null, attempt: null,
    })).toEqual({ outcome: 'covered' });
    h.close();
  });
});

describe('no native path consults future coverage', () => {
  const src = (name: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'domain', name), 'utf8');

  it.each(['github-feed.service.ts', 'github-watches.service.ts'])('%s reads neither an imported surface nor the monitoring switch', (file) => {
    const text = src(file);
    for (const banned of ['coveredByImport', 'importedCovers', 'covers(', 'observes(', 'monitoringEnabled', 'assistantWatch.observes', 'assistantWatch.covers', 'digestDeliverable']) {
      expect(text, `${file} mentions ${banned}`).not.toContain(banned);
    }
  });

  it('the application wiring passes no suppression input to either path', () => {
    const app = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'app.ts'), 'utf8');
    for (const banned of ['coveredByImport', 'importedCovers', 'IMPORT_COVERS_NATIVE', 'IMPORT_COVER_DELIVERY', 'nativeWatchedEver', 'digestDeliverable']) {
      expect(app, banned).not.toContain(banned);
    }
  });

  it('the imported service no longer exports or defines the coverage questions', () => {
    const text = src('assistant-watch.service.ts');
    for (const banned of ['IMPORT_COVERS_NATIVE', 'IMPORT_COVER_DELIVERY', 'nativeWatchedEver', '  covers(']) {
      expect(text, banned).not.toContain(banned);
    }
  });
});
