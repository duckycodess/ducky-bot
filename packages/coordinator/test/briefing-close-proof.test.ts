import { describe, expect, it } from 'vitest';
import {
  EMBED_FIELDS_MAX, EMBED_TOTAL_MAX, TRUNCATION_MARKER, WATCH_EVENT_KINDS, closedTransition, transitionKey,
  type ImportedPreferences, type PrList,
} from '@ducky/contracts';
import { OWNER, TestClock, makeHarness, type Harness } from './helpers.js';
import { FakeWatchReader } from './assistant-watch-helpers.js';
import { MutableGitHubReader } from './github-watch-helpers.js';
import { AssistantImportService } from '../src/domain/assistant-import.service.js';
import { buildRollbackDelta } from '../src/domain/rollback-delta.service.js';
import { importDoc, importEnv } from './assistant-import-fixture.js';
import { proveShownCloses } from '../src/discord/close-proof.js';
import { sanitizeOutbound } from '../src/discord/sanitize-outbound.js';
import { briefingMessage, githubDetailLine, githubRepoHeading } from '../src/discord/assistant-presenters.js';
import type { DigestClose } from '../src/domain/assistant-watch.service.js';
import type { OutboundMessage } from '../src/discord/message.js';

/**
 * A close earns a receipt only when its exact number and canonical instant are proven inside one retained line of the
 * FINAL briefing output (ADR 0034, migration 39): after the per-repository cap, the field clamp, the field and total
 * budgets and the transport's own redaction. One that is not proven stays pending, counted with its age, and is never
 * silently settled or starved. Invented data only.
 */
const NOW = '2026-10-13T00:00:00.000Z';
const MIN = 60_000;
const DAY = 86_400_000;
const PREFS: ImportedPreferences = {
  timeZone: 'UTC', morningEnabled: true, morningTime: '07:00', eveningEnabled: true, eveningTime: '21:00',
  weekendBriefings: true, lookaheadDays: 3, includeWeather: false, includeGithub: true, includeCaptures: false,
  includeMeal: false, assistantWording: false, defaultReminderOffsetsMinutes: [1440, 60],
};
const CLOSED_AT = '2026-10-12T10:00:00.000Z';
const iso = (ms: number): string => new Date(ms).toISOString();

const boot = (github?: MutableGitHubReader) => {
  const clock = new TestClock(NOW, 'UTC');
  const reader = new FakeWatchReader();
  reader.capabilities = { observableKinds: [...WATCH_EVENT_KINDS], discovery: false };
  const h = makeHarness({
    clock, assistantWatchReader: reader, ...(github ? { github } : {}),
    env: { DUCKY_BRIEFING_ENABLED: 'true', DUCKY_IMPORTED_PREFERENCES: 'true' },
  });
  h.store.ownerPreferences.insert({ ownerId: OWNER, prefsJson: JSON.stringify(PREFS), source: 'import', at: NOW });
  return { h, clock };
};
let targetCounter = 0;
/** A distinct six-letter handle per target: `w` and five letters of a counter. */
const handle = (): string => {
  targetCounter += 1;
  return `w${[...String(targetCounter).padStart(5, '0')].map((d) => 'abcdefghij'[Number(d)]).join('')}`;
};
const target = (h: Harness, id: string, repo: string): void => {
  h.store.assistantWatch.insertTarget({
    id, publicId: handle(), discordUserId: OWNER, repoKey: repo.toLowerCase(),
    display: repo, defaultBranch: 'main', state: 'active', lastObservedAt: null, createdAt: NOW, cancelledAt: null,
  });
};
const event = (
  h: Harness, id: string, targetId: string, kind: 'pr_closed' | 'pr_opened' | 'pr_merged', identity: string, occurredAt: string,
  payload: Record<string, unknown> = {}, createdAt = NOW,
): void => {
  h.store.assistantWatch.insertImportedEvent({
    id, targetId, kind, identity, occurredAt, payloadJson: JSON.stringify(payload), alertedAt: null, digestedAt: null, createdAt,
  });
};
const closeEvent = (h: Harness, id: string, targetId: string, n: number, occurredAt = CLOSED_AT, title = `Close ${n}`): void =>
  event(h, id, targetId, 'pr_closed', `${n}:closed`, occurredAt, { number: n, title });
const row = (h: Harness, id: string) =>
  h.store.db.prepare('SELECT * FROM assistant_watch_events WHERE id = ?').get(id) as Record<string, unknown>;
const digestedIds = (h: Harness): string[] =>
  (h.store.db.prepare('SELECT id FROM assistant_watch_events WHERE digested_at IS NOT NULL ORDER BY id').all() as { id: string }[]).map((r) => r.id);
const pendingIds = (h: Harness): string[] =>
  (h.store.db.prepare('SELECT id FROM assistant_watch_events WHERE digested_at IS NULL ORDER BY id').all() as { id: string }[]).map((r) => r.id);
const targetClaims = (h: Harness) => h.store.nativeTransitions.all().filter((c) => c.path === 'target');
const morning = (h: Harness, clock: TestClock, day = 13): Promise<unknown> => {
  clock.set(`2026-10-${String(day).padStart(2, '0')}T08:00:00.000Z`);
  return h.app.briefingNotifier.tick();
};
const lastMessage = (h: Harness): OutboundMessage => (h.transport.sent.at(-1) as unknown as { message: OutboundMessage }).message;
const githubField = (m: OutboundMessage): string => m.embeds?.flatMap((e) => e.fields ?? []).find((f) => f.name === 'GitHub')?.value ?? '';

describe('the digest line of an exact close is built from the validated identity and instant', () => {
  it('names the number from the identity and the literal canonical instant, never the payload number', () => {
    const { h } = boot();
    target(h, 't1', 'acme/demo');
    event(h, 'e1', 't1', 'pr_closed', '12:closed', '2026-10-12T18:00:00+08:00', { number: 99, title: 'Tidy up' });
    const d = h.app.assistantWatch.digest();
    expect(d.repos[0]!.lines).toEqual(['PR #12 closed 2026-10-12T10:00:00.000Z: Tidy up']);
    expect(d.closes).toEqual([{ id: 'e1', repoHeading: '**demo**', n: '12', at: '2026-10-12T10:00:00.000Z' }]);
    h.close();
  });

  it('puts an exact close before every other line of its repository, whatever order the events came in', () => {
    const { h } = boot();
    target(h, 't1', 'acme/demo');
    for (let i = 1; i <= 5; i += 1) event(h, `o${i}`, 't1', 'pr_opened', `${i}:opened`, `2026-10-1${i}T00:00:00.000Z`, { number: i, title: `Open ${i}` });
    closeEvent(h, 'c1', 't1', 9, '2026-10-12T23:00:00.000Z'); // the latest event of the repository
    const lines = h.app.assistantWatch.digest().repos[0]!.lines;
    expect(lines[0]).toBe('PR #9 closed 2026-10-12T23:00:00.000Z: Close 9');
    expect(lines).toHaveLength(5); // four lines and "and N more"
    h.close();
  });

  it('keeps the legacy line, with no instant and no claim, for a close whose instant cannot be read', () => {
    const { h } = boot();
    target(h, 't1', 'acme/demo');
    event(h, 'e1', 't1', 'pr_closed', '5:closed', 'garbage', { number: 5, title: 'Old' });
    const d = h.app.assistantWatch.digest();
    expect(d.repos[0]!.lines).toEqual(['PR #5 closed: Old']);
    expect(d.closes).toBeUndefined();
    h.close();
  });

  it('gives a repository with an exact close more weight against the repository cut, and claims no fairness by it', () => {
    const { h } = boot();
    target(h, 'a1', 'acme/aaa');
    target(h, 'b1', 'acme/bbb');
    for (let i = 1; i <= 3; i += 1) event(h, `o${i}`, 'a1', 'pr_opened', `${i}:opened`, CLOSED_AT, { number: i, title: 'x' });
    closeEvent(h, 'c1', 'b1', 7);
    expect(h.app.assistantWatch.digest().repos.map((r) => r.name)).toEqual(['bbb', 'aaa']);
    h.close();
  });
});

describe('a briefing settles an exact close only when its line is proven in the output that was sent', () => {
  it('delivers it, writes a target receipt keyed by number and instant, and settles exactly that event', async () => {
    const { h, clock } = boot();
    target(h, 't1', 'acme/demo');
    closeEvent(h, 'c1', 't1', 12);
    const before = h.app.assistantWatch.digest();
    expect((await morning(h, clock) as { delivered: number }).delivered).toBe(1);
    expect(githubField(lastMessage(h))).toContain('-# PR #12 closed 2026-10-12T10:00:00.000Z: Close 12');
    expect(row(h, 'c1')['digested_at']).not.toBeNull();
    expect(targetClaims(h).map((c) => `${c.state}:${c.via}:${transitionKey(c.transition)}`))
      .toEqual([`delivered:target_digest:${transitionKey(closedTransition(12, CLOSED_AT)!)}`]);
    expect(proveShownCloses(lastMessage(h), before.closes!)).toEqual(new Set(['c1']));
    h.close();
  });

  it('sends exactly the output that was proven: the transport adds no transformation after the proof', async () => {
    const { h, clock } = boot();
    target(h, 't1', 'acme/demo');
    closeEvent(h, 'c1', 't1', 12);
    clock.set('2026-10-13T08:00:00.000Z');
    const body = await h.app.briefing.assemble(h.owner, 'morning', { includePrivate: true });
    await h.app.briefingNotifier.tick();
    expect(lastMessage(h)).toEqual(sanitizeOutbound(briefingMessage(body)));
    expect(sanitizeOutbound(lastMessage(h))).toEqual(lastMessage(h)); // idempotent: nothing further happens to it
    h.close();
  });

  it('leaves no receipt for a send that failed, and tells it on the next attempt', async () => {
    const { h, clock } = boot();
    target(h, 't1', 'acme/demo');
    closeEvent(h, 'c1', 't1', 12);
    h.transport.failSends = true;
    expect((await morning(h, clock) as { failed: number }).failed).toBe(1);
    expect(targetClaims(h)).toEqual([]);
    expect(row(h, 'c1')['digested_at']).toBeNull();
    h.transport.failSends = false;
    clock.advance(MIN);
    await h.app.briefingNotifier.tick();
    expect(targetClaims(h).map((c) => c.state)).toEqual(['delivered']);
    expect(row(h, 'c1')['digested_at']).not.toBeNull();
    h.close();
  });

  it('leaves no receipt for a briefing that was abandoned after its attempts', async () => {
    const { h, clock } = boot();
    target(h, 't1', 'acme/demo');
    closeEvent(h, 'c1', 't1', 12);
    h.transport.failSends = true;
    await morning(h, clock);
    for (let i = 0; i < 6; i += 1) {
      clock.advance(MIN);
      await h.app.briefingNotifier.tick();
    }
    expect(h.store.db.prepare("SELECT COUNT(*) n FROM briefing_deliveries WHERE status = 'abandoned'").get()).toMatchObject({ n: 1 });
    expect(targetClaims(h)).toEqual([]);
    expect(row(h, 'c1')['digested_at']).toBeNull();
    expect(h.store.assistantWatch.pendingCloses(OWNER).count).toBe(1);
    h.close();
  });

  it('settles a close the target delivered with proof so that a later native observation of it is covered', async () => {
    const reader = new MutableGitHubReader();
    const pr = (n: number, over: Partial<PrList[number]> = {}): PrList[number] => ({
      number: n, title: `PR ${n}`, state: 'OPEN', isDraft: false, headRefName: `f${n}`, updatedAt: NOW, headRefOid: `h${n}`,
      createdAt: '2026-08-01T00:00:00Z', mergedAt: null, closedAt: null, ...over,
    });
    reader.prs = [pr(1), pr(12)];
    const { h, clock } = boot(reader);
    h.app.githubWatches.add(h.owner, { repoSlug: 'demo', everyMinutes: 15 });
    clock.advance(15 * MIN);
    await h.app.githubWatches.tick();
    target(h, 't1', 'acme/demo');
    closeEvent(h, 'c1', 't1', 12);
    await morning(h, clock);
    expect(row(h, 'c1')['digested_at']).not.toBeNull();
    h.transport.clear();
    reader.prs = [pr(1), pr(12, { state: 'CLOSED', mergedAt: null, closedAt: CLOSED_AT, updatedAt: CLOSED_AT })];
    clock.advance(DAY);
    await h.app.githubWatches.tick();
    expect(h.transport.sent).toEqual([]); // the target's proven receipt covers the native close
    h.close();
  });
});

describe('what a briefing cut off is not settled', () => {
  const many = (h: Harness, repo: string, targetId: string, count: number, base = 1): void => {
    target(h, targetId, repo);
    for (let i = 0; i < count; i += 1) closeEvent(h, `${targetId}-${base + i}`, targetId, base + i, iso(Date.parse(CLOSED_AT) + i * MIN));
  };

  it('keeps a close the per-repository line cap dropped ("and N more") pending, counted, and tells it in the next briefing', async () => {
    const { h, clock } = boot();
    many(h, 'acme/demo', 'd', 6);
    await morning(h, clock);
    const text = githubField(lastMessage(h));
    expect(text).toContain('-# and 2 more');
    const shown = [1, 2, 3, 4, 5, 6].filter((n) => text.includes(`PR #${n} closed `));
    expect(shown).toHaveLength(4);
    expect(digestedIds(h)).toEqual(shown.map((n) => `d-${n}`).sort());
    expect(pendingIds(h)).toHaveLength(2);
    expect(targetClaims(h)).toHaveLength(4);
    expect(h.store.assistantWatch.pendingCloses(OWNER)).toEqual({ count: 2, oldestCreatedAt: NOW });
    // The next briefing shows the rest: nothing was starved.
    clock.set('2026-10-13T21:00:00.000Z');
    await h.app.briefingNotifier.tick();
    expect(pendingIds(h)).toEqual([]);
    expect(targetClaims(h)).toHaveLength(6);
    h.close();
  });

  it('settles nothing it did not show when the field clamp cuts repositories off, and every settled close is in a sent message', async () => {
    const { h, clock } = boot();
    for (let r = 0; r < 8; r += 1) many(h, `acme/repo${r}`, `r${r}x`, 4, r * 10 + 1);
    const sentText: string[] = [];
    let remaining = 32;
    for (let day = 13; day < 30 && remaining > 0; day += 1) {
      await morning(h, clock, day);
      sentText.push(githubField(lastMessage(h)));
      const left = pendingIds(h).length;
      // Progress: each briefing settles what it showed and only that.
      expect(left).toBeLessThan(remaining);
      remaining = left;
      const all = sentText.join('\n');
      for (const id of digestedIds(h)) {
        const n = Number(id.split('-')[1]);
        expect(all, id).toContain(`PR #${n} closed `);
      }
    }
    expect(remaining).toBe(0);
    expect(sentText.length).toBeGreaterThan(1); // a single briefing could not hold them all
    expect(targetClaims(h)).toHaveLength(32);
    h.close();
  });

  it('PERMANENT: a close under a repository whose heading the redactor rewrites is never proven, never settled, never starved of a count', async () => {
    const { h, clock } = boot();
    const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}`; // the redactor rewrites the whole word
    target(h, 'tok', `acme/${token}`);
    closeEvent(h, 'tok-1', 'tok', 31);
    for (let day = 13; day < 20; day += 1) await morning(h, clock, day);
    expect(h.transport.sent.length).toBeGreaterThan(0);
    // The line itself was sent, but the heading it sits under was rewritten, so it cannot be tied to this repository.
    expect(row(h, 'tok-1')['digested_at']).toBeNull();
    expect(targetClaims(h)).toEqual([]);
    expect(h.store.assistantWatch.pendingCloses(OWNER)).toEqual({ count: 1, oldestCreatedAt: NOW });
    expect(h.app.assistantWatch.statusLine()).toMatch(/1 pull request close\(s\) still pending, not yet shown in a proven briefing \(oldest 6 days\)/);
    h.close();
  });

  it('settles the other repositories of a briefing even while one close stays pending', async () => {
    const { h, clock } = boot();
    target(h, 'tok', `acme/ghp_${'a1B2c3D4e5F6g7H8i9J0'}`);
    closeEvent(h, 'tok-1', 'tok', 31);
    target(h, 'ok', 'acme/fine');
    closeEvent(h, 'ok-1', 'ok', 32);
    event(h, 'ok-2', 'ok', 'pr_opened', '3:opened', CLOSED_AT, { number: 3, title: 'Unrelated' });
    await morning(h, clock);
    expect(digestedIds(h)).toEqual(['ok-1', 'ok-2']);
    expect(pendingIds(h)).toEqual(['tok-1']);
    expect(targetClaims(h).filter((c) => c.transition.kind === 'pr_closed').map((c) => c.transition.item)).toEqual(['32']);
    h.close();
  });

  it('proves a close whose own title the redactor rewrote: the number and instant are still byte-exact in the retained line', async () => {
    const { h, clock } = boot();
    target(h, 't1', 'acme/demo');
    closeEvent(h, 'c1', 't1', 12, CLOSED_AT, `Fix ghp_${'a1B2c3D4e5F6g7H8i9J0'} leak`);
    await morning(h, clock);
    expect(githubField(lastMessage(h))).toContain('-# PR #12 closed 2026-10-12T10:00:00.000Z: Fix [REDACTED:github-token] leak');
    expect(row(h, 'c1')['digested_at']).not.toBeNull();
    h.close();
  });

  it('rebuilds when a reservation drops an event, proves the close again against the rebuilt output, and settles exactly that set', async () => {
    const { h, clock } = boot();
    target(h, 't1', 'acme/demo');
    closeEvent(h, 'c1', 't1', 12);
    event(h, 'o1', 't1', 'pr_opened', '5:opened', CLOSED_AT, { number: 5, title: 'Waits for a native send' });
    let injected = false;
    const watch = h.app.assistantWatch;
    const original = watch.reserveDigest.bind(watch);
    watch.reserveDigest = (ids: readonly string[]) => {
      if (!injected) {
        injected = true;
        // A native path takes the opening between the digest being built and the reservation: it must wait.
        h.store.nativeTransitions.reserveNative(OWNER, 'acme/demo', { kind: 'pr_opened', item: '5', stamp: null, hash: null, attempt: null }, 'feed_event', 'n5', NOW, NOW);
      }
      return original(ids);
    };
    const before = watch.digest();
    expect(before.eventIds).toHaveLength(2);
    await morning(h, clock);
    expect(injected).toBe(true);
    const text = githubField(lastMessage(h));
    expect(text).toContain('PR #12 closed 2026-10-12T10:00:00.000Z');
    expect(text).not.toContain('Waits for a native send'); // the rebuilt output, not the first one
    expect(digestedIds(h)).toEqual(['c1']);
    expect(pendingIds(h)).toEqual(['o1']);
    expect(targetClaims(h).map((c) => c.transition.kind)).toEqual(['pr_closed']);
    h.close();
  });

  it('on the final fallback sends no GitHub section, reserves nothing and settles nothing', async () => {
    const { h, clock } = boot();
    target(h, 't1', 'acme/demo');
    closeEvent(h, 'c1', 't1', 12);
    const watch = h.app.assistantWatch;
    // Every reservation attempt loses an event to a native holder: after the last rebuild the section is dropped.
    let n = 0;
    watch.reserveDigest = (ids: readonly string[]) => {
      n += 1;
      return ids.slice(0, -1);
    };
    await morning(h, clock);
    expect(n).toBeGreaterThan(0);
    expect(githubField(lastMessage(h))).toBe('');
    expect(digestedIds(h)).toEqual([]);
    expect(targetClaims(h)).toEqual([]);
    h.close();
  });
});

describe('status, verification and the export count what is pending and what is uncertain', () => {
  const pendingTwo = async () => {
    const { h, clock } = boot();
    target(h, 'd', 'acme/demo');
    for (let i = 1; i <= 6; i += 1) closeEvent(h, `d-${i}`, 'd', i, iso(Date.parse(CLOSED_AT) + i * MIN));
    await morning(h, clock);
    clock.set('2026-10-14T00:00:00.000Z');
    return { h, clock };
  };
  const uncertainRow = (h: Harness): void => {
    h.store.db.prepare(
      `INSERT INTO native_close_uncertainty (owner_id, repo_key, scope, item, transition_key, origin, marker, multiplicity, representative_ref, earliest_marked_at, recorded_at)
       VALUES (?, 'acme/demo', 'exact', '3', ?, 'imported', 'alert_marker_only', 2, 'e1', ?, ?)`,
    ).run(OWNER, transitionKey(closedTransition(3, CLOSED_AT)!), NOW, NOW);
  };

  it('says how many closes are pending and how old the oldest is, in the owner status', async () => {
    const { h } = await pendingTwo();
    expect(h.app.assistantWatch.statusLine()).toMatch(/2 pull request close\(s\) still pending, not yet shown in a proven briefing \(oldest 24 hours\) \(a required blocker\)/);
    h.close();
  });

  it('reports them in the import verification as a blocker, with an instant and an age, never a repository or a number', async () => {
    const { h, clock } = await pendingTwo();
    const report = new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() }).verify(importDoc());
    expect(report.nativeLedger).toMatchObject({
      pendingClosesUnshown: 2, oldestPendingCloseAt: NOW, oldestPendingCloseAgeMs: DAY, clear: false,
    });
    expect(report.parity).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/acme|demo|PR #/);
    h.close();
  });

  it('counts the permanent historical uncertainty in status, verification and the export, and never clears it', async () => {
    const { h, clock } = boot();
    target(h, 't1', 'acme/demo');
    uncertainRow(h);
    expect(h.app.assistantWatch.statusLine()).toMatch(/2 historical close\(s\) settled before exact close receipts existed and never provable \(1 key\(s\), 0 matching any close of their pull request\)/);
    const verify = () => new AssistantImportService({ store: h.store, env: importEnv(), nowMs: () => clock.nowMs() }).verify(importDoc());
    expect(verify().nativeLedger).toMatchObject({ closeUncertaintyEvents: 2, closeUncertaintyKeys: 1, clear: false });
    const delta = buildRollbackDelta({ store: h.store, ownerId: OWNER, profile: 'development', nowIso: NOW });
    expect(delta.schema).toBe('ducky-rollback-delta/v6');
    expect(delta.state.nativeLedger.closeEvidence.uncertainty).toMatchObject([
      { repoKey: 'acme/demo', scope: 'exact', item: '3', origin: 'imported', marker: 'alert_marker_only', multiplicity: 2, representativeRef: 'e1' },
    ]);
    expect(delta.state.nativeLedger.closeEvidence.pendingUnshown).toEqual({ count: 0, oldestCreatedAt: null });
    expect(delta.state.nativeLedger.boundary).toMatchObject({ closeUncertainEvents: 0, closeFamilyAt: expect.any(String) });
    expect(delta.replay.join(' ')).toMatch(/closeEvidence\.uncertainty/);
    h.close();
  });

  it('puts the pending closes, their age and the held closes in the versioned export', async () => {
    const { h } = await pendingTwo();
    const delta = buildRollbackDelta({ store: h.store, ownerId: OWNER, profile: 'development', nowIso: '2026-10-14T00:00:00.000Z' });
    expect(delta.state.nativeLedger.closeEvidence.pendingUnshown).toEqual({ count: 2, oldestCreatedAt: NOW });
    expect(delta.state.nativeLedger.closeEvidence.heldCloses).toEqual([]);
    h.close();
  });
});

describe('proveShownCloses reads the final output, after every cut and redaction', () => {
  const close = (id: string, repo: string, n: number, at = CLOSED_AT): DigestClose =>
    ({ id, repoHeading: githubRepoHeading(repo), n: String(n), at });
  const line = (n: number, at = CLOSED_AT, title = 't'): string => githubDetailLine(`PR #${n} closed ${at}: ${title}`);
  const message = (githubValue: string, fieldsBefore = 0, descriptionLength = 0): OutboundMessage => ({
    embeds: [{
      title: 'Morning briefing',
      ...(descriptionLength > 0 ? { description: 'x'.repeat(descriptionLength) } : {}),
      fields: [
        ...Array.from({ length: fieldsBefore }, (_, i) => ({ name: `f${i}`, value: 'v' })),
        { name: 'GitHub', value: githubValue },
      ],
    }],
  });
  const prove = (m: OutboundMessage, closes: DigestClose[]): string[] => [...proveShownCloses(sanitizeOutbound(m), closes)].sort();

  it('proves a close whose line is complete under its own repository heading', () => {
    const v = [githubRepoHeading('demo'), line(7), line(8)].join('\n');
    expect(prove(message(v), [close('a', 'demo', 7), close('b', 'demo', 8)])).toEqual(['a', 'b']);
  });

  it('proves nothing for another number, another instant, another repository, or a line that merely mentions a close', () => {
    const v = [githubRepoHeading('demo'), line(7), githubDetailLine('PR #9 opened: PR #8 closed 2026-10-12T10:00:00.000Z')].join('\n');
    expect(prove(message(v), [
      close('a', 'demo', 8), close('b', 'demo', 7, '2026-10-12T10:00:00.001Z'), close('c', 'other', 7), close('d', 'demo', 9),
    ])).toEqual([]);
  });

  it('requires the literal canonical ISO text with milliseconds, never a rounded or localized instant', () => {
    const v = [githubRepoHeading('demo'), githubDetailLine('PR #7 closed 2026-10-12T10:00:00Z: t'), githubDetailLine('PR #8 closed <t:1760263200:R>: t')].join('\n');
    expect(prove(message(v), [close('a', 'demo', 7), close('b', 'demo', 8)])).toEqual([]);
  });

  it('treats the last line of a clamped field as cut, and proves the complete lines before it', () => {
    const lines = [githubRepoHeading('demo')];
    for (let i = 1; i <= 40; i += 1) lines.push(line(i, CLOSED_AT, 'a long enough title to fill a field'));
    const m = message(lines.join('\n'));
    const out = sanitizeOutbound(m);
    const value = out.embeds![0]!.fields!.at(-1)!.value;
    expect(value.endsWith(TRUNCATION_MARKER)).toBe(true);
    const complete = value.split('\n').slice(0, -1).filter((l) => l.startsWith('-# PR #')).length;
    expect(complete).toBeGreaterThan(5);
    expect(complete).toBeLessThan(40);
    const closes = Array.from({ length: 40 }, (_, i) => close(`c${i + 1}`, 'demo', i + 1));
    const proven = proveShownCloses(out, closes);
    expect(proven.size).toBe(complete);
    for (let i = 1; i <= complete; i += 1) expect(proven.has(`c${i}`)).toBe(true);
    expect(proven.has(`c${complete + 1}`)).toBe(false);
  });

  it('proves nothing from a field that the field-count cut dropped', () => {
    const v = [githubRepoHeading('demo'), line(7)].join('\n');
    const m = message(v, EMBED_FIELDS_MAX); // the GitHub field is the 26th: Discord keeps 25
    expect(sanitizeOutbound(m).embeds![0]!.fields!.some((f) => f.name === 'GitHub')).toBe(false);
    expect(prove(m, [close('a', 'demo', 7)])).toEqual([]);
  });

  it('proves nothing from a field that the total-size budget emptied or cut', () => {
    const v = [githubRepoHeading('demo'), line(7)].join('\n');
    // A full description and two full fields spend the 6000-character budget before the GitHub field is reached.
    const starved: OutboundMessage = {
      embeds: [{
        title: 'Morning briefing', description: 'x'.repeat(4096),
        fields: [
          { name: 'a', value: 'y'.repeat(1024) }, { name: 'b', value: 'y'.repeat(1024) }, { name: 'GitHub', value: v },
        ],
      }],
    };
    const out = sanitizeOutbound(starved);
    const spent = out.embeds![0]!;
    expect(JSON.stringify(spent).length).toBeLessThan(EMBED_TOTAL_MAX + 1500);
    expect(spent.fields!.find((f) => f.name === 'GitHub')?.value ?? '').not.toContain('PR #7 closed');
    expect(prove(starved, [close('a', 'demo', 7)])).toEqual([]);
    // The same field with room to spare is proven.
    expect(prove(message(v), [close('a', 'demo', 7)])).toEqual(['a']);
  });

  it('proves nothing when redaction rewrites the heading, and still proves a line whose title was redacted', () => {
    const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}`;
    const v = [githubRepoHeading(token), line(7), githubRepoHeading('demo'), line(8, CLOSED_AT, `leaks ${token}`)].join('\n');
    expect(prove(message(v), [close('a', token, 7), close('b', 'demo', 8)])).toEqual(['b']);
  });

  it('tells two repositories that share a bare name by count: fewer lines than closes proves none of that group', () => {
    const v = [githubRepoHeading('demo'), line(7)].join('\n');
    expect(prove(message(v), [close('a', 'demo', 7), close('b', 'demo', 7)])).toEqual([]);
    const both = [githubRepoHeading('demo'), line(7), githubRepoHeading('demo'), line(7)].join('\n');
    expect(prove(message(both), [close('a', 'demo', 7), close('b', 'demo', 7)])).toEqual(['a', 'b']);
  });

  it('never proves a close from a message with no GitHub field, an empty field, or the "nothing new" text', () => {
    expect(prove({ content: 'PR #7 closed 2026-10-12T10:00:00.000Z' }, [close('a', 'demo', 7)])).toEqual([]);
    expect(prove(message(''), [close('a', 'demo', 7)])).toEqual([]);
    expect(prove(message('Nothing new since the last digest.'), [close('a', 'demo', 7)])).toEqual([]);
    expect(proveShownCloses(message('x'), [])).toEqual(new Set());
  });

  it('is the same function the briefing uses: a digest rendered through the presenter proves its own closes', async () => {
    const { h } = boot();
    target(h, 't1', 'acme/demo');
    closeEvent(h, 'c1', 't1', 7);
    const body = await h.app.briefing.assemble(h.owner, 'morning', { includePrivate: true });
    expect(prove(briefingMessage(body), [...body.github!.closes!])).toEqual(['c1']);
    h.close();
  });
});
