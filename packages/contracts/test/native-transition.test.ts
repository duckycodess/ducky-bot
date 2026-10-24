import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IMPORTED_COUNTERPART, WATCH_EVENT_KINDS, WatchReviewsSchema, WatchRunsSchema, canonicalStamp, commitTransition,
  feedEventTransition, hashProviderRef, isWellFormedTransition, mergedTransition, openedTransition, reviewTransition,
  runTransition, targetTransition, transitionKey, transitionRepoKey, updatedTransition,
} from '../src/index.js';

const facts = (kind: (typeof WATCH_EVENT_KINDS)[number], identity: string, extra: { occurredAt?: string; providerHash?: string | null; attempt?: string | null } = {}) => ({
  kind, identity, occurredAt: extra.occurredAt ?? '2026-10-01T00:00:00.000Z', providerHash: extra.providerHash ?? null, attempt: extra.attempt ?? null,
});

describe('the codec decides, per imported kind, what a native path could have told', () => {
  it('has an entry for EVERY imported event kind, and only seven families have a native counterpart', () => {
    expect(Object.keys(IMPORTED_COUNTERPART).sort()).toEqual([...WATCH_EVENT_KINDS].sort());
    expect(new Set(Object.values(IMPORTED_COUNTERPART).filter((v) => v !== null)).size).toBe(7);
    for (const none of ['pr_closed', 'review_approved', 'review_commented', 'review_pending', 'issue_updated', 'issue_closed',
      'release', 'ci_started', 'ci_recovered', 'default_branch_change'] as const) {
      expect(IMPORTED_COUNTERPART[none], none).toBeNull();
      expect(targetTransition(facts(none, '1:x')).status, none).toBe('none');
    }
  });

  it('reads each counterpart identity exactly', () => {
    const key = (f: ReturnType<typeof facts>) => {
      const t = targetTransition(f);
      return t.status === 'exact' ? transitionKey(t.transition) : t.status;
    };
    expect(key(facts('pr_opened', '7:opened'))).toBe('pr_opened:7');
    expect(key(facts('issue_opened', '3:issue_opened:2026-10-01T00:00:00Z'))).toBe('issue_opened:3');
    expect(key(facts('commit', 'abc1234'))).toBe('commit:abc1234');
    expect(key(facts('pr_merged', '7:merged', { occurredAt: '2026-10-02T00:00:00.000Z' }))).toBe('pr_merged:7:2026-10-02T00:00:00.000Z');
    expect(key(facts('pr_updated', '7:updated:2026-10-02T00:00:00Z'))).toBe('pr_updated:7:2026-10-02T00:00:00.000Z');
    const h = hashProviderRef('PRR_1')!;
    expect(key(facts('review_requested_changes', '7:review:99', { providerHash: h }))).toBe(`changes_requested:7:${h}`);
    expect(key(facts('ci_failed', '55:ci_failed', { attempt: '2' }))).toBe('ci_failed:55:2');
  });

  it('calls a review without its id, or a run without its attempt, AMBIGUOUS rather than guessing', () => {
    expect(targetTransition(facts('review_requested_changes', '7:review:99'))).toEqual({ status: 'ambiguous', family: 'changes_requested', item: '7' });
    expect(targetTransition(facts('ci_failed', '55:ci_failed'))).toEqual({ status: 'ambiguous', family: 'ci_failed', item: '55' });
    expect(targetTransition(facts('ci_failed', '55:ci_failed', { attempt: '0' })).status).toBe('ambiguous');
    expect(targetTransition(facts('review_requested_changes', '7:review:99', { providerHash: 'not-a-hash' })).status).toBe('ambiguous');
  });

  it('gives an identity the codec cannot read no counterpart at all: it can never equal one a native path wrote', () => {
    for (const f of [
      facts('commit', 'c4'), facts('pr_opened', 'x:opened'), facts('issue_opened', 'x'), facts('pr_merged', 'nope'),
      facts('pr_updated', '7:updated:not-a-time'), facts('review_requested_changes', 'x:review:1'), facts('ci_failed', 'x'),
    ]) expect(targetTransition(f).status, `${f.kind} ${f.identity}`).toBe('none');
  });

  it('never matches a bare timestamp: a merge or an update needs the number AND the instant', () => {
    expect(targetTransition(facts('pr_merged', '7:merged', { occurredAt: 'garbage' })).status).toBe('none');
    expect(updatedTransition(7, 'garbage')).toBeNull();
    expect(mergedTransition(7, null)).toBeNull();
  });
});

describe('native feed keys', () => {
  it('names a transition only for the four kinds an imported event can be, with the event\'s own repository', () => {
    const repo = 'Acme/Demo';
    expect(feedEventTransition('pr_opened:Acme/Demo#7', 'pr_opened', repo)).toEqual({
      repoKey: 'acme/demo', transition: openedTransition('pr_opened', 7),
    });
    expect(feedEventTransition('issue_opened:Acme/Demo#3', 'issue_opened', repo)?.transition.item).toBe('3');
    expect(feedEventTransition('changes_requested:Acme/Demo#7:PRR_x', 'changes_requested', repo)?.transition)
      .toEqual(reviewTransition(7, 'PRR_x'));
    expect(feedEventTransition('check_failed:Acme/Demo:55:2', 'check_failed', repo)?.transition).toEqual(runTransition(55, 2));
    // Not a transition an imported event can be, or not this repository's own key.
    expect(feedEventTransition('review_requested:Acme/Demo#7', 'review_requested', repo)).toBeNull();
    expect(feedEventTransition('check_failed:Acme/Demo:pr7:abc:1:2026-10-01T00:00:00Z', 'check_failed', repo)).toBeNull();
    expect(feedEventTransition('pr_opened:Other/Repo#7', 'pr_opened', repo)).toBeNull();
    expect(feedEventTransition('pr_opened:Acme/Demo#0', 'pr_opened', repo)).toBeNull();
    expect(feedEventTransition('pr_opened:Acme/Demo#7x', 'pr_opened', repo)).toBeNull();
  });
});

describe('the shared validators', () => {
  it('canonicalises a repository the same way on both sides, and refuses what is not one', () => {
    expect(transitionRepoKey('Acme/Demo')).toBe('acme/demo');
    for (const bad of ['', 'a', 'a/b/c', 'a/..', '../b', 'a b/c', 'a/b c']) expect(transitionRepoKey(bad), bad).toBeNull();
  });

  it('canonicalises an instant and refuses anything else', () => {
    expect(canonicalStamp('2026-10-01T00:00:00Z')).toBe('2026-10-01T00:00:00.000Z');
    expect(canonicalStamp('2026-10-01T08:00:00+08:00')).toBe('2026-10-01T00:00:00.000Z');
    for (const bad of [null, undefined, '', 'yesterday', '2026-10-01', '2026-13-01T00:00:00Z']) expect(canonicalStamp(bad as never), String(bad)).toBeNull();
  });

  it('hashes a review id with domain separation, by exact equality, and never keeps the id', () => {
    const h = hashProviderRef('PRR_1')!;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(createHash('sha256').update('PRR_1').digest('hex'));
    expect(h).toBe(hashProviderRef('PRR_1'));
    expect(h).not.toBe(hashProviderRef('prr_1')); // no case folding, no decoding
    expect(hashProviderRef('')).toBeNull();
    expect(hashProviderRef('x'.repeat(256))).toBeNull();
    expect(hashProviderRef(null)).toBeNull();
  });

  it('refuses to build or accept a malformed transition', () => {
    expect(commitTransition('XYZ')).toBeNull();
    expect(openedTransition('pr_opened', 0)).toBeNull();
    expect(runTransition(5, null)).toBeNull();
    expect(isWellFormedTransition({ kind: 'pr_merged', item: '7', stamp: null, hash: null, attempt: null })).toBe(false);
    expect(isWellFormedTransition({ kind: 'pr_opened', item: '7', stamp: '2026-10-01T00:00:00.000Z', hash: null, attempt: null })).toBe(false);
  });
});

describe('the approved review and run DTOs carry the exact ids, bounded and optional', () => {
  const t = '2026-10-01T00:00:00Z';
  it('parses node_id and run_attempt, and turns an unusable value into "absent" instead of failing the page', () => {
    const reviews = WatchReviewsSchema.parse([
      { id: 5, state: 'CHANGES_REQUESTED', submitted_at: t, node_id: 'PRR_abc' },
      { id: 6, state: 'APPROVED', submitted_at: t },
      { id: 7, state: 'APPROVED', submitted_at: t, node_id: 'x'.repeat(300) },
      { id: 8, state: 'APPROVED', submitted_at: t, node_id: 5 },
    ]);
    expect(reviews.map((r) => r.node_id)).toEqual(['PRR_abc', undefined, undefined, undefined]);
    const runs = WatchRunsSchema.parse({
      total_count: 4,
      workflow_runs: [
        { id: 1, created_at: t, run_attempt: 2 }, { id: 2, created_at: t }, { id: 3, created_at: t, run_attempt: 0 },
        { id: 4, created_at: t, run_attempt: 'two' },
      ],
    });
    expect(runs.workflow_runs.map((r) => r.run_attempt)).toEqual([2, undefined, undefined, undefined]);
  });
});
