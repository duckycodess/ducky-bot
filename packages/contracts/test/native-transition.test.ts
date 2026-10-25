import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IMPORTED_COUNTERPART, WATCH_EVENT_KINDS, WatchReviewsSchema, WatchRunsSchema, canonicalStamp, commitTransition,
  feedEventTransition, hashProviderRef, isWellFormedTransition, mergedTransition, openedTransition, reviewTransition,
  runTransition, targetTransition, transitionKey, transitionRepoKey, updatedTransition,
  hashSourceIdentity, observedReviewTransition, observedStateKind, type Transition,
  classifyCloseEvidence, closedTransition, TRANSITION_KINDS,
} from '../src/index.js';

const facts = (kind: (typeof WATCH_EVENT_KINDS)[number], identity: string, extra: { occurredAt?: string; providerHash?: string | null; attempt?: string | null } = {}) => ({
  kind, identity, occurredAt: extra.occurredAt ?? '2026-10-01T00:00:00.000Z', providerHash: extra.providerHash ?? null, attempt: extra.attempt ?? null,
});

describe('the codec decides, per imported kind, what a native path could have told', () => {
  it('has an entry for EVERY imported event kind, and only ten families have a native counterpart', () => {
    expect(Object.keys(IMPORTED_COUNTERPART).sort()).toEqual([...WATCH_EVENT_KINDS].sort());
    // The seven earlier families, the observed-state approved and commented reviews (migration 38) and the close (39).
    expect(new Set(Object.values(IMPORTED_COUNTERPART).filter((v) => v !== null)).size).toBe(10);
    for (const none of ['review_pending', 'issue_updated', 'issue_closed',
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


describe('the observed-state review families (migration 38)', () => {
  const H = hashProviderRef('PRR_1')!;
  const exact = (f: ReturnType<typeof facts> & { providerState?: string | null }): Transition => {
    const t = targetTransition(f);
    if (t.status !== 'exact') throw new Error(`expected exact, got ${t.status}`);
    return t.transition;
  };

  it('keys a review by its pull request, its identity domain and the state it was observed in', () => {
    expect(transitionKey(observedReviewTransition(7, H, 'provider', 'APPROVED')!)).toBe(`review_approved:7:${H}`);
    expect(transitionKey(observedReviewTransition(7, H, 'provider', 'DISMISSED')!)).toBe(`review_dismissed:7:${H}`);
    expect(transitionKey(observedReviewTransition(7, H, 'provider', 'COMMENTED')!)).toBe(`review_commented:7:${H}`);
    expect(transitionKey(observedReviewTransition(7, H, 'source_identity', 'APPROVED')!)).toBe(`review_approved:7:src:${H}`);
    expect(transitionKey(observedReviewTransition(7, H, 'source_identity', 'COMMENTED|DISMISSED')!))
      .toBe(`review_commented:7:src:${H}:unknown_state`);
    // The existing requested-changes key is unchanged.
    expect(transitionKey(reviewTransition(7, 'PRR_1')!)).toBe(`changes_requested:7:${H}`);
  });

  it('never shares a key across states or domains, so no state is deduplicated against another', () => {
    const keys = (['APPROVED', 'COMMENTED', 'DISMISSED'] as const).flatMap((st) =>
      (['provider', 'source_identity'] as const).map((d) => transitionKey(observedReviewTransition(7, H, d, st)!)));
    expect(new Set(keys).size).toBe(6);
    expect(observedStateKind('COMMENTED|DISMISSED')).toBe('review_commented');
  });

  it('refuses a malformed fact: a state that does not match its kind, a provider candidate set, a bad hash or number', () => {
    const base = { kind: 'review_approved' as const, item: '7', stamp: null, hash: H, attempt: null };
    expect(isWellFormedTransition({ ...base, domain: 'provider', state: 'APPROVED' })).toBe(true);
    expect(isWellFormedTransition({ ...base, domain: 'provider', state: 'DISMISSED' })).toBe(false);
    expect(isWellFormedTransition({ ...base, domain: 'provider', state: null })).toBe(false);
    expect(isWellFormedTransition({ ...base, kind: 'review_commented', domain: 'provider', state: 'COMMENTED|DISMISSED' })).toBe(false);
    expect(isWellFormedTransition({ ...base, kind: 'review_commented', domain: 'source_identity', state: 'COMMENTED|DISMISSED' })).toBe(true);
    expect(isWellFormedTransition({ ...base, hash: 'zz', domain: 'provider', state: 'APPROVED' })).toBe(false);
    expect(observedReviewTransition(0, H, 'provider', 'APPROVED')).toBeNull();
    expect(observedReviewTransition(7, null, 'provider', 'APPROVED')).toBeNull();
  });

  it('names an approved row by its provider hash when it has one, and by its source identity otherwise', () => {
    const withHash = exact(facts('review_approved', '7:review:99', { providerHash: H }));
    expect(withHash).toMatchObject({ kind: 'review_approved', domain: 'provider', state: 'APPROVED', hash: H });
    const noHash = exact(facts('review_approved', '7:review:99'));
    expect(noHash).toMatchObject({ kind: 'review_approved', domain: 'source_identity', state: 'APPROVED' });
    expect(noHash.hash).toBe(hashSourceIdentity('7:review:99', 'APPROVED'));
    expect(noHash.hash).not.toBe(H);
  });

  it('tells a commented row from a dismissed one by its stored state, and never guesses a stateless one', () => {
    expect(exact({ ...facts('review_commented', '7:review:1', { providerHash: H }), providerState: 'COMMENTED' }))
      .toMatchObject({ kind: 'review_commented', domain: 'provider', state: 'COMMENTED' });
    expect(exact({ ...facts('review_commented', '7:review:1', { providerHash: H }), providerState: 'DISMISSED' }))
      .toMatchObject({ kind: 'review_dismissed', domain: 'provider', state: 'DISMISSED' });
    const stateless = exact(facts('review_commented', '7:review:1', { providerHash: H }));
    // A hash with no state is not trusted as one state's identity: it falls to the identity string, a candidate set.
    expect(stateless).toMatchObject({ kind: 'review_commented', domain: 'source_identity', state: 'COMMENTED|DISMISSED' });
    expect(transitionKey(stateless)).toMatch(/^review_commented:7:src:[0-9a-f]{64}:unknown_state$/);
  });

  it('gives the two source rows of one review two different source hashes', () => {
    const a = exact(facts('review_approved', '7:review:5'));
    const c = exact(facts('review_commented', '7:review:5'));
    expect(a.hash).not.toBe(c.hash);
    expect(hashSourceIdentity('7:review:5', 'COMMENTED')).not.toBe(hashSourceIdentity('7:review:5', 'DISMISSED'));
    expect(hashSourceIdentity('', 'APPROVED')).toBeNull();
  });

  it('reads an identity it cannot parse as having no native counterpart to be confused with', () => {
    expect(targetTransition(facts('review_approved', 'garbage')).status).toBe('none');
    expect(targetTransition(facts('review_commented', '0:review:1')).status).toBe('none');
  });
});

describe('an exact pull request close is its number AND the provider\'s canonical close instant (migration 39)', () => {
  const CLOSED = '2026-10-02T03:04:05.678Z';
  const H = hashProviderRef('PRR_1')!;

  it('is a transition kind with a counterpart, keyed by number and instant and never by the number alone', () => {
    expect(TRANSITION_KINDS).toContain('pr_closed');
    expect(IMPORTED_COUNTERPART.pr_closed).toBe('pr_closed');
    const t = closedTransition(7, '2026-10-02T03:04:05.678+00:00')!;
    expect(t).toEqual({ kind: 'pr_closed', item: '7', stamp: CLOSED, hash: null, attempt: null });
    expect(transitionKey(t)).toBe(`pr_closed:7:${CLOSED}`);
    expect(isWellFormedTransition(t)).toBe(true);
    // A second close at another instant is another close: no key is shared across instants.
    expect(transitionKey(closedTransition(7, '2026-10-02T03:04:06.000Z')!)).not.toBe(transitionKey(t));
  });

  it('canonicalizes every ISO spelling of an instant to one key, and refuses everything else', () => {
    const keys = ['2026-10-02T03:04:05.678Z', '2026-10-02T11:04:05.678+08:00', '2026-10-02T03:04:05.678000Z']
      .map((x) => transitionKey(closedTransition(7, x)!));
    expect(new Set(keys).size).toBe(1);
    for (const bad of [null, undefined, '', 'garbage', '2026-10-02', 'Oct 2 2026 03:04:05 UTC', '2026-13-45T00:00:00Z']) {
      expect(closedTransition(7, bad), String(bad)).toBeNull();
    }
    for (const n of [0, -1, 1.5, 1e10]) expect(closedTransition(n, CLOSED), String(n)).toBeNull();
    // A stored row is well formed only when its parts are exactly what the codec writes.
    const base = { kind: 'pr_closed' as const, item: '7', stamp: CLOSED, hash: null, attempt: null };
    expect(isWellFormedTransition({ ...base, stamp: null })).toBe(false);
    expect(isWellFormedTransition({ ...base, stamp: '2026-10-02T11:04:05.678+08:00' })).toBe(false);
    expect(isWellFormedTransition({ ...base, hash: H })).toBe(false);
  });

  it('reads an imported close by the number in its identity and the instant of the event', () => {
    const key = (f: ReturnType<typeof facts>) => {
      const t = targetTransition(f);
      return t.status === 'exact' ? transitionKey(t.transition) : t;
    };
    expect(key(facts('pr_closed', '7:closed', { occurredAt: '2026-10-02T11:04:05.678+08:00' }))).toBe(`pr_closed:7:${CLOSED}`);
    // Two events of the same pull request at two instants are two transitions.
    expect(key(facts('pr_closed', '7:closed', { occurredAt: '2026-10-02T03:04:06.000Z' }))).toBe('pr_closed:7:2026-10-02T03:04:06.000Z');
  });

  it('calls a readable number with an unreadable instant AMBIGUOUS, and an unreadable identity none', () => {
    for (const occurredAt of ['garbage', 'Oct 2 2026', '', '2026-10-02']) {
      expect(targetTransition(facts('pr_closed', '7:closed', { occurredAt })), occurredAt)
        .toEqual({ status: 'ambiguous', family: 'pr_closed', item: '7' });
    }
    for (const identity of ['x:closed', '0:closed', '07:closed', '7:closed:extra', '7', '7:merged', ' 7:closed', '1234567890:closed']) {
      expect(targetTransition(facts('pr_closed', identity, { occurredAt: CLOSED })).status, identity).toBe('none');
    }
  });

  it('never takes the number from anywhere but the identity', () => {
    const t = targetTransition({ ...facts('pr_closed', '7:closed', { occurredAt: CLOSED }), providerHash: H, attempt: '3' });
    expect(t).toMatchObject({ status: 'exact', transition: { item: '7', hash: null, attempt: null } });
  });

  describe('what a stored historical close identifies (the permanent uncertainty)', () => {
    it('is exact for a readable number and instant, same-item for a readable number alone, else unidentifiable', () => {
      expect(classifyCloseEvidence('Acme/Demo', '7:closed', '2026-10-02T11:04:05.678+08:00')).toEqual({
        kind: 'exact', repoKey: 'acme/demo', item: '7', transitionKey: `pr_closed:7:${CLOSED}`,
      });
      expect(classifyCloseEvidence('Acme/Demo', '7:closed', 'Oct 2 2026')).toEqual({ kind: 'item', repoKey: 'acme/demo', item: '7' });
      expect(classifyCloseEvidence('Acme/Demo', '7:closed', '')).toEqual({ kind: 'item', repoKey: 'acme/demo', item: '7' });
      for (const [repo, identity] of [['nope', '7:closed'], ['a/b/c', '7:closed'], ['acme/demo', 'x:closed'], ['acme/demo', '7:closed:2']] as const) {
        expect(classifyCloseEvidence(repo, identity, CLOSED), `${repo} ${identity}`).toEqual({ kind: 'unidentifiable' });
      }
    });
  });
});
