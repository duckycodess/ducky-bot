import { describe, expect, it } from 'vitest';
import { closedTransition, transitionKey } from '@ducky/contracts';
import { AssistantImportService } from '../src/domain/assistant-import.service.js';
import { buildRollbackDelta } from '../src/domain/rollback-delta.service.js';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';
import { MANILA, importDoc, importEnv, rowCounts, takeLock } from './assistant-import-fixture.js';

/**
 * An import AFTER migration 39 (ADR 0034): a source close that carries an alert or digest marker is historical evidence
 * of exactly the kind migration 39 captured, so it becomes the same permanent, identifiers-only uncertainty through the
 * supported import boundary. Never a delivered receipt, never a cutoff, idempotent, rolled back with the import.
 * Invented data only.
 */
const NOW = '2026-10-13T00:00:00.000Z';
const REPO = 'acme/widgets';
const C1 = '2026-10-11T09:00:00.000Z';
const C2 = '2026-10-11T10:00:00.000Z';

type Ev = { kind: string; identity: string; occurredAt: string; payload: Record<string, unknown>; alertedAt: string | null; digestedAt: string | null };
const close = (n: number, over: Partial<Ev> = {}): Ev => ({
  kind: 'pr_closed', identity: `${n}:closed`, occurredAt: C1, payload: { number: n, title: `PR ${n}` }, alertedAt: null, digestedAt: null, ...over,
});
const docWith = (events: Ev[]): Record<string, any> => {
  const doc = importDoc();
  doc.watch.targets[0].events = events;
  return doc;
};
const boot = () => {
  const clock = new TestClock(NOW, MANILA);
  const h = makeHarness({ clock, env: { DUCKY_OWNER_TIMEZONE: MANILA } });
  const svc = () => new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() });
  const apply = (doc: unknown) => {
    const lock = takeLock(h.store);
    try {
      return svc().run(doc, { apply: true, lock });
    } finally {
      lock.release();
    }
  };
  return { h, clock, svc, apply };
};
const uncertainty = (h: Harness) =>
  h.store.db.prepare('SELECT scope, item, transition_key, origin, marker, multiplicity, representative_ref FROM native_close_uncertainty ORDER BY id').all() as Record<string, unknown>[];
const probe = (h: Harness, n: number, at: string) => h.store.nativeTransitions.probeNative(OWNER, REPO, closedTransition(n, at)!);
const eventId = (h: Harness, identity: string): string =>
  (h.store.db.prepare('SELECT id FROM assistant_watch_events WHERE identity = ?').get(identity) as { id: string }).id;

describe('a source close with a marker, imported after migration 39, is permanent uncertainty', () => {
  it('records a digest-marked close through the import and holds a native close of it, with no receipt and no cutoff', () => {
    const { h, apply } = boot();
    const out = apply(docWith([close(12, { digestedAt: '2026-10-12T00:00:00Z' })]));
    expect(out.issues).toEqual([]);
    expect(out.ok).toBe(true);
    expect(uncertainty(h)).toEqual([{
      scope: 'exact', item: '12', transition_key: transitionKey(closedTransition(12, C1)!), origin: 'imported', marker: 'digest_marker',
      multiplicity: 1, representative_ref: eventId(h, '12:closed'),
    }]);
    expect(probe(h, 12, C1)).toBe('uncertain');
    expect(probe(h, 12, C2)).toBe('free'); // a close at another instant is another close
    expect(h.store.nativeTransitions.all()).toEqual([]); // never a delivered receipt
    expect(h.store.nativeTransitions.boundary()).toMatchObject({ fresh: true }); // no new cutoff
    h.close();
  });

  it('classifies an alert-only marker, both markers and an unreadable number, and refuses an unreadable instant at validation', () => {
    const { h, apply } = boot();
    // The document validator refuses an event time that is not an instant, so the same-pull-request fallback (an unreadable
    // instant) can only come from rows written before migration 39, never from an import.
    const refused = apply(docWith([close(3, { occurredAt: 'garbage', digestedAt: '2026-10-12T00:00:00Z' })]));
    expect(refused.ok).toBe(false);
    expect(uncertainty(h)).toEqual([]);
    apply(docWith([
      close(1, { alertedAt: '2026-10-12T00:00:00Z' }),
      close(2, { alertedAt: '2026-10-12T00:00:00Z', digestedAt: '2026-10-12T01:00:00Z' }),
      close(4, { identity: 'x:closed', digestedAt: '2026-10-12T00:00:00Z' }),
    ]));
    expect(uncertainty(h).map((r) => `${r['item']}:${r['scope']}:${r['marker']}`)).toEqual([
      '1:exact:alert_marker_only', '2:exact:alert_and_digest_markers',
    ]);
    expect(h.store.nativeTransitions.closeFamilyProvenance()).toMatchObject({
      uncertainEvents: 2, uncertainRows: 2, itemScopeEvents: 0, unidentifiableEvents: 1,
    });
    h.close();
  });

  it('is idempotent: repeating the same import adds nothing, changes no count and reorders nothing', () => {
    const { h, apply } = boot();
    const doc = docWith([close(12, { digestedAt: '2026-10-12T00:00:00Z' }), close(13, { alertedAt: '2026-10-12T00:00:00Z' })]);
    expect(apply(doc).ok).toBe(true);
    const before = { u: uncertainty(h), p: h.store.nativeTransitions.closeFamilyProvenance() };
    expect(apply(doc).ok).toBe(true);
    expect(apply(doc).ok).toBe(true);
    expect({ u: uncertainty(h), p: h.store.nativeTransitions.closeFamilyProvenance() }).toEqual(before);
    h.close();
  });

  it('merges canonical collisions into one row with multiplicity and a deterministic representative', () => {
    const { h, apply } = boot();
    // An earlier capture of the very same key, origin and marker (for example by migration 39).
    h.store.db.prepare(
      `INSERT INTO native_close_uncertainty (owner_id, repo_key, scope, item, transition_key, origin, marker, multiplicity, representative_ref, earliest_marked_at, recorded_at)
       VALUES (?, ?, 'exact', '12', ?, 'imported', 'digest_marker', 1, 'zzz-late', '2026-10-12T05:00:00.000Z', ?)`,
    ).run(OWNER, REPO, transitionKey(closedTransition(12, C1)!), NOW);
    apply(docWith([close(12, { occurredAt: '2026-10-11T09:00:00Z', digestedAt: '2026-10-12T00:00:00Z' })])); // the same instant, spelled without milliseconds
    expect(uncertainty(h)).toMatchObject([{ multiplicity: 2, representative_ref: eventId(h, '12:closed') }]); // earlier marker wins
    h.close();
  });

  it('records a source marker that fills an OBSERVED row Ducky had not settled, and never one Ducky settled itself', () => {
    const { h, apply } = boot();
    // Discovery found the repository first, so the import adopts the target; two observed closes already exist.
    h.store.assistantWatch.insertTarget({
      id: 'disc', publicId: 'wdisca', discordUserId: OWNER, repoKey: REPO, display: 'acme/widgets', defaultBranch: 'main',
      state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null, origin: 'discovered',
    });
    const observed = h.store.db.prepare(
      `INSERT INTO assistant_watch_events (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, digested_at, settled_by, created_at)
       VALUES (?, 'disc', 'pr_closed', 'pulls', ?, ?, '{}', 'observed', ?, ?, ?)`,
    );
    observed.run('obs1', '21:closed', C1, null, null, NOW); // pending: the source's marker fills it
    observed.run('obs2', '22:closed', C1, NOW, null, NOW); // Ducky already settled it itself (a proven receipt)
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, { kind: 'pr_closed', identity: '22:closed', occurredAt: C1, providerHash: null, attempt: null }, 'target_digest', 'obs2', NOW);
    h.store.nativeTransitions.markTargetDelivered('target_digest', 'obs2', NOW);
    expect(apply(docWith([close(21, { digestedAt: '2026-10-12T00:00:00Z' }), close(22, { alertedAt: '2026-10-12T00:00:00Z' })])).ok).toBe(true);
    expect(uncertainty(h)).toMatchObject([{ item: '21', origin: 'observed', marker: 'digest_marker', multiplicity: 1, representative_ref: 'obs1' }]);
    expect(probe(h, 21, C1)).toBe('uncertain');
    // The proven post-39 target receipt for #22 stays what it is and is not relabelled as history.
    expect(probe(h, 22, C1)).toBe('target_delivered');
    expect(h.store.nativeTransitions.all().map((c) => `${c.path}:${c.state}:${c.transition.item}`)).toEqual(['target:delivered:22']);
    h.close();
  });

  it('takes precedence for a real target receipt: the receipt is checked first, the uncertainty stays unchanged', () => {
    const { h, apply } = boot();
    apply(docWith([close(12, { alertedAt: '2026-10-12T00:00:00Z' })]));
    const before = uncertainty(h);
    h.store.nativeTransitions.reserveTarget(OWNER, REPO, { kind: 'pr_closed', identity: '12:closed', occurredAt: C1, providerHash: null, attempt: null }, 'target_digest', 'x', NOW);
    expect(probe(h, 12, C1)).toBe('target_in_flight');
    h.store.nativeTransitions.markTargetDelivered('target_digest', 'x', NOW);
    expect(probe(h, 12, C1)).toBe('target_delivered');
    expect(uncertainty(h)).toEqual(before);
    h.close();
  });

  it('leaves a close with no source marker to the normal prospective protocol: nothing recorded, nothing held', () => {
    const { h, apply } = boot();
    apply(docWith([close(12), close(13)]));
    expect(uncertainty(h)).toEqual([]);
    expect(probe(h, 12, C1)).toBe('free');
    expect(h.store.nativeTransitions.closeFamilyProvenance()).toMatchObject({ uncertainEvents: 0, uncertainRows: 0 });
    expect(h.store.db.prepare("SELECT COUNT(*) n FROM assistant_watch_events WHERE kind = 'pr_closed' AND digested_at IS NULL").get()).toEqual({ n: 2 });
    h.close();
  });

  it('adopting a discovered target twice records the filled marker once', () => {
    const { h, apply } = boot();
    h.store.assistantWatch.insertTarget({
      id: 'disc', publicId: 'wdisca', discordUserId: OWNER, repoKey: REPO, display: 'acme/widgets', defaultBranch: 'main',
      state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null, origin: 'discovered',
    });
    h.store.db.prepare(
      `INSERT INTO assistant_watch_events (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, created_at)
       VALUES ('obs1', 'disc', 'pr_closed', 'pulls', '21:closed', ?, '{}', 'observed', ?)`,
    ).run(C1, NOW);
    const doc = docWith([close(21, { digestedAt: '2026-10-12T00:00:00Z' })]);
    expect(apply(doc).ok).toBe(true);
    expect(apply(doc).ok).toBe(true);
    expect(uncertainty(h)).toMatchObject([{ item: '21', origin: 'observed', multiplicity: 1 }]);
    h.close();
  });

  it('is part of the import transaction: a dry run and a failed import record nothing', () => {
    const { h, svc, apply } = boot();
    const doc = docWith([close(12, { digestedAt: '2026-10-12T00:00:00Z' }), close(13, { digestedAt: '2026-10-12T00:00:00Z' })]);
    expect(svc().run(doc, { apply: false }).ok).toBe(true);
    expect(uncertainty(h)).toEqual([]);
    const repo = h.store.assistantWatch;
    const original = repo.insertImportedEvent.bind(repo);
    let calls = 0;
    repo.insertImportedEvent = (row) => {
      original(row);
      calls += 1;
      if (calls === 2) throw new Error('simulated failure after the second event');
    };
    const before = rowCounts(h.store);
    expect(() => apply(doc)).toThrow(/simulated failure/);
    repo.insertImportedEvent = original;
    expect(uncertainty(h)).toEqual([]);
    expect(h.store.nativeTransitions.closeFamilyProvenance()).toMatchObject({ uncertainEvents: 0, uncertainRows: 0 });
    expect(rowCounts(h.store)).toEqual(before);
    // The same import then succeeds and records both.
    expect(apply(doc).ok).toBe(true);
    expect(uncertainty(h)).toHaveLength(2);
    h.close();
  });

  it('survives deleting the target and its events (Forget-style deletion) and is never cleared', () => {
    const { h, apply } = boot();
    apply(docWith([close(12, { digestedAt: '2026-10-12T00:00:00Z' })]));
    const before = uncertainty(h);
    h.store.db.prepare('DELETE FROM assistant_watch_targets').run();
    expect(h.store.db.prepare('SELECT COUNT(*) n FROM assistant_watch_events').get()).toEqual({ n: 0 });
    expect(uncertainty(h)).toEqual(before);
    expect(probe(h, 12, C1)).toBe('uncertain');
    h.close();
  });

  it('is counted honestly in status, verification and the export, and verification is not clear', () => {
    const { h, clock, svc, apply } = boot();
    const doc = docWith([close(12, { digestedAt: '2026-10-12T00:00:00Z' }), close(13, { identity: 'x:closed', digestedAt: '2026-10-12T00:00:00Z' })]);
    apply(doc);
    expect(h.app.assistantWatch.statusLine()).toMatch(/1 historical close\(s\) settled before exact close receipts existed/);
    expect(h.app.assistantWatch.statusLine()).toMatch(/1 historical close\(s\) with no readable number or repository/);
    const report = svc().verify(doc);
    expect(report.nativeLedger).toMatchObject({ closeUncertaintyEvents: 1, closeUncertaintyKeys: 1, closeUnidentifiableLegacy: 1, clear: false });
    const delta = buildRollbackDelta({ store: h.store, ownerId: OWNER, profile: 'development', nowIso: clock.nowIso() });
    expect(delta.state.nativeLedger.closeEvidence.uncertainty).toMatchObject([{ item: '12', origin: 'imported', marker: 'digest_marker' }]);
    expect(delta.state.nativeLedger.boundary).toMatchObject({ closeUncertainEvents: 1, closeUnidentifiableEvents: 1 });
    h.close();
  });
});

describe('one close identity cannot stand for two different instants', () => {
  const adopted = (h: Harness, rows: { id: string; n: number; at: string; settle?: 'proven' | 'pending' }[]): void => {
    h.store.assistantWatch.insertTarget({
      id: 'disc', publicId: 'wdisca', discordUserId: OWNER, repoKey: REPO, display: 'acme/widgets', defaultBranch: 'main',
      state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null, origin: 'discovered',
    });
    for (const r of rows) {
      h.store.db.prepare(
        `INSERT INTO assistant_watch_events (id, target_id, kind, surface, identity, occurred_at, payload_json, origin, digested_at, created_at)
         VALUES (?, 'disc', 'pr_closed', 'pulls', ?, ?, '{}', 'observed', ?, ?)`,
      ).run(r.id, `${r.n}:closed`, r.at, r.settle === 'proven' ? NOW : null, NOW);
      if (r.settle === 'proven') {
        h.store.nativeTransitions.reserveTarget(OWNER, REPO, { kind: 'pr_closed', identity: `${r.n}:closed`, occurredAt: r.at, providerHash: null, attempt: null }, 'target_digest', r.id, NOW);
        h.store.nativeTransitions.markTargetDelivered('target_digest', r.id, NOW);
      }
    }
  };
  const row = (h: Harness, id: string) => h.store.db.prepare('SELECT occurred_at, alerted_at, digested_at FROM assistant_watch_events WHERE id = ?').get(id);

  for (const settle of ['pending', 'proven'] as const) {
    it(`refuses a source close at C1 beside an adopted ${settle} close at C2, counted, with nothing written or mis-keyed`, () => {
      const { h, apply } = boot();
      adopted(h, [{ id: 'obs', n: 21, at: C2, settle }]);
      const before = { counts: rowCounts(h.store), row: row(h, 'obs'), claims: h.store.nativeTransitions.all() };
      const out = apply(docWith([close(21, { occurredAt: C1, digestedAt: '2026-10-12T00:00:00Z' })]));
      expect(out.ok).toBe(false);
      expect(out.issues).toEqual([{ category: 'watch', rule: 'close_instant_differs', count: 1 }]);
      // Nothing was written: no uncertainty for either instant, the row is unchanged, the target is not adopted, the
      // proven receipt (if any) is exactly what it was.
      expect(uncertainty(h)).toEqual([]);
      expect({ counts: rowCounts(h.store), row: row(h, 'obs'), claims: h.store.nativeTransitions.all() }).toEqual(before);
      expect(probe(h, 21, C1)).toBe('free');
      expect(probe(h, 21, C2)).toBe(settle === 'proven' ? 'target_delivered' : 'free');
      // Refusal is deterministic: repeating it changes nothing.
      expect(apply(docWith([close(21, { occurredAt: C1, digestedAt: '2026-10-12T00:00:00Z' })])).ok).toBe(false);
      expect(uncertainty(h)).toEqual([]);
      h.close();
    });
  }

  it('counts every conflicting close, refuses even an unmarked one (it cannot be represented), and not the rest of the import', () => {
    const { h, apply } = boot();
    adopted(h, [{ id: 'a', n: 21, at: C2 }, { id: 'b', n: 22, at: C2 }, { id: 'c', n: 23, at: C1 }]);
    const out = apply(docWith([close(21, { occurredAt: C1 }), close(22, { occurredAt: C1, alertedAt: '2026-10-12T00:00:00Z' }), close(23, { occurredAt: C1, digestedAt: '2026-10-12T00:00:00Z' })]));
    expect(out.issues).toEqual([{ category: 'watch', rule: 'close_instant_differs', count: 2 }]);
    // The same document minus the two conflicts imports: only #23 (an equal instant) is left.
    expect(apply(docWith([close(23, { occurredAt: C1, digestedAt: '2026-10-12T00:00:00Z' })])).ok).toBe(true);
    expect(uncertainty(h)).toMatchObject([{ item: '23' }]);
    h.close();
  });

  it('still merges an equivalent spelling of the same instant, and a repeat import is then idempotent', () => {
    const { h, apply } = boot();
    adopted(h, [{ id: 'obs', n: 21, at: C1 }]);
    const doc = docWith([close(21, { occurredAt: '2026-10-11T09:00:00Z', digestedAt: '2026-10-12T00:00:00Z' })]);
    expect(apply(doc).issues).toEqual([]);
    expect(uncertainty(h)).toMatchObject([{ item: '21', transition_key: transitionKey(closedTransition(21, C1)!), origin: 'observed', multiplicity: 1 }]);
    const after = uncertainty(h);
    expect(apply(doc).ok).toBe(true);
    expect(uncertainty(h)).toEqual(after);
    expect(probe(h, 21, C1)).toBe('uncertain');
    expect(probe(h, 21, C2)).toBe('free');
    h.close();
  });

  it('has the same guard at the write itself: the repository refuses to fill a marker onto a close of another instant', () => {
    const { h } = boot();
    adopted(h, [{ id: 'obs', n: 21, at: C2 }]);
    expect(() => h.store.assistantWatch.insertImportedEventIfNew({
      id: 'x', targetId: 'disc', kind: 'pr_closed', identity: '21:closed', occurredAt: C1, payloadJson: '{}',
      alertedAt: null, digestedAt: '2026-10-12T00:00:00Z', createdAt: NOW,
    })).toThrow(/close instant conflict/);
    expect(uncertainty(h)).toEqual([]);
    expect(row(h, 'obs')).toMatchObject({ occurred_at: C2, digested_at: null });
    h.close();
  });
});
