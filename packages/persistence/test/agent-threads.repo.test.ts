import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createStore } from '../src/index.js';
import { AGENT_INTENT_NOTES_MAX, AGENT_INTENT_NOTE_MAX_CHARS } from '../src/repositories/agent-threads.repo.js';

const OWNER = '111111111111111111';
const OTHER = '222222222222222222';
const NOW = '2026-10-13T00:00:00.000Z';

const fresh = () => {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  return createStore(db);
};

describe('the agent thread binding', () => {
  it('holds one row per (owner, thread) and never a second', () => {
    const store = fresh();
    store.agentThreads.ensure(OWNER, 't1', NOW);
    store.agentThreads.ensure(OWNER, 't1', NOW);
    store.agentThreads.ensure(OWNER, 't2', NOW);
    expect(store.agentThreads.countForOwner(OWNER)).toBe(2);
  });

  it('is scoped to the owner in every read', () => {
    const store = fresh();
    store.agentThreads.bindRepository(OWNER, 't1', 'acme/demo', '/tmp/demo', NOW);
    // The same thread key for a different account reads as absent, not as
    // somebody else's binding.
    expect(store.agentThreads.get(OTHER, 't1')).toBeUndefined();
    expect(store.agentThreads.get(OWNER, 't1')?.repository).toBe('acme/demo');
  });

  it('clears the publication state when the thread is rebound', () => {
    const store = fresh();
    store.agentThreads.bindRepository(OWNER, 't1', 'acme/demo', '/tmp/demo', NOW);
    store.agentThreads.setTicketUuid(OWNER, 't1', 'd0d0d0d0-0000-4000-8000-000000000000', NOW);
    store.agentThreads.startRun(
      OWNER, 't1',
      { runId: 'a00001', command: '$ticket', status: 'publishing', ready: false, detail: null },
      NOW,
    );
    store.agentThreads.setPublication(
      OWNER, 't1', 'a00001',
      { issueNumber: 7, issueUrl: 'https://github.com/acme/demo/issues/7' }, NOW,
    );
    expect(store.agentThreads.get(OWNER, 't1')?.issueNumber).toBe(7);

    // A canonical id and an issue belong to the repository they were minted
    // against; carrying them across would enrich the wrong issue.
    store.agentThreads.bindRepository(OWNER, 't1', 'acme/other', '/tmp/other', NOW);
    const row = store.agentThreads.get(OWNER, 't1')!;
    expect(row.repository).toBe('acme/other');
    expect(row.ticketUuid).toBeNull();
    expect(row.issueNumber).toBeNull();
    expect(row.issueUrl).toBeNull();
  });

  it('keeps a binding to the same repository, including its canonical id', () => {
    const store = fresh();
    store.agentThreads.bindRepository(OWNER, 't1', 'acme/demo', '/tmp/demo', NOW);
    store.agentThreads.setTicketUuid(OWNER, 't1', 'd0d0d0d0-0000-4000-8000-000000000000', NOW);
    store.agentThreads.bindRepository(OWNER, 't1', 'acme/demo', '/tmp/demo', NOW);
    expect(store.agentThreads.get(OWNER, 't1')?.ticketUuid).toBe(
      'd0d0d0d0-0000-4000-8000-000000000000',
    );
  });

  it('mints the canonical id once and never replaces it', () => {
    const store = fresh();
    store.agentThreads.ensure(OWNER, 't1', NOW);
    store.agentThreads.setTicketUuid(OWNER, 't1', 'aaaaaaaa-0000-4000-8000-000000000000', NOW);
    store.agentThreads.setTicketUuid(OWNER, 't1', 'bbbbbbbb-0000-4000-8000-000000000000', NOW);
    // A retry must reuse the SAME id, or it would open a second issue.
    expect(store.agentThreads.get(OWNER, 't1')?.ticketUuid).toBe(
      'aaaaaaaa-0000-4000-8000-000000000000',
    );
  });
});

describe('the owner\'s own grill lines', () => {
  it('bounds the list and each line, in the write itself', () => {
    const store = fresh();
    for (let i = 0; i < AGENT_INTENT_NOTES_MAX + 10; i += 1) {
      store.agentThreads.appendNote(OWNER, 't1', `line ${i}`, NOW);
    }
    const notes = store.agentThreads.get(OWNER, 't1')!.intentNotes;
    expect(notes).toHaveLength(AGENT_INTENT_NOTES_MAX);
    // Oldest dropped, newest kept.
    expect(notes.at(-1)).toBe(`line ${AGENT_INTENT_NOTES_MAX + 9}`);

    store.agentThreads.appendNote(OWNER, 't2', 'x'.repeat(AGENT_INTENT_NOTE_MAX_CHARS + 500), NOW);
    expect(store.agentThreads.get(OWNER, 't2')!.intentNotes[0]).toHaveLength(
      AGENT_INTENT_NOTE_MAX_CHARS,
    );
  });

  it('ignores a blank line rather than storing one', () => {
    const store = fresh();
    store.agentThreads.appendNote(OWNER, 't1', '   ', NOW);
    expect(store.agentThreads.get(OWNER, 't1')!.intentNotes).toEqual([]);
  });

  it('reads a corrupt notes column as empty rather than failing the thread', () => {
    const store = fresh();
    store.agentThreads.ensure(OWNER, 't1', NOW);
    store.db
      .prepare('UPDATE agent_threads SET intent_notes = ? WHERE discord_user_id = ?')
      .run('not json', OWNER);
    expect(store.agentThreads.get(OWNER, 't1')!.intentNotes).toEqual([]);
  });
});

describe('the card on a thread', () => {
  it('refuses a second run while the first is still live', () => {
    /**
     * The single-writer gate, in the statement rather than in a caller.
     *
     * Two Discord messages a moment apart are two concurrent handlers. Before
     * this, the second replaced the first one's `run_id` mid-flight, and the
     * first run's remaining writes either vanished or landed on the second
     * run's card.
     */
    const store = fresh();
    expect(
      store.agentThreads.startRun(
        OWNER, 't1', { runId: 'a00001', command: '$ticket', status: 'publishing', ready: false, detail: null }, NOW,
      ),
    ).toBeDefined();
    store.agentThreads.setCard(OWNER, 't1', 'a00001', { channelId: 'c1', messageId: 'm1' }, NOW);

    expect(
      store.agentThreads.startRun(
        OWNER, 't1', { runId: 'a00002', command: '$agentize', status: 'onboarding', ready: false, detail: null }, NOW,
      ),
    ).toBeUndefined();
    expect(store.agentThreads.get(OWNER, 't1')!.runId).toBe('a00001');
    expect(store.agentThreads.liveRun(OWNER, 't1')?.runId).toBe('a00001');
    expect(store.agentThreads.runIsLive(OWNER, 't1', 'a00001')).toBe(true);
  });

  it('replaces the previous one once it has finished', () => {
    const store = fresh();
    store.agentThreads.startRun(
      OWNER, 't1', { runId: 'a00001', command: '$ticket', status: 'publishing', ready: false, detail: null }, NOW,
    );
    store.agentThreads.setCard(OWNER, 't1', 'a00001', { channelId: 'c1', messageId: 'm1' }, NOW);
    store.agentThreads.updateRun(OWNER, 't1', 'a00001', { status: 'failed', finished: true }, NOW);

    expect(
      store.agentThreads.startRun(
        OWNER, 't1', { runId: 'a00002', command: '$agentize', status: 'onboarding', ready: false, detail: null }, NOW,
      ),
    ).toBeDefined();
    const row = store.agentThreads.get(OWNER, 't1')!;
    expect(row.runId).toBe('a00002');
    // A new run starts with no card, so it cannot edit the previous one.
    expect(row.cardMessageId).toBeNull();
    expect(store.agentThreads.countForOwner(OWNER)).toBe(1);
  });

  it('refuses to move a run that has already reached a terminal status', () => {
    /**
     * The guard that stops a subprocess returning after Cancel from rewriting
     * the card to "queued" -- the most consequential false report this
     * surface could make.
     */
    const store = fresh();
    store.agentThreads.startRun(
      OWNER, 't1', { runId: 'a00001', command: '$ticket', status: 'publishing', ready: true, detail: null }, NOW,
    );
    expect(
      store.agentThreads.updateRun(OWNER, 't1', 'a00001', { status: 'cancelled', finished: true }, NOW),
    ).toBeDefined();

    expect(
      store.agentThreads.updateRun(
        OWNER, 't1', 'a00001', { status: 'queued', queueState: 'queued', finished: true }, NOW,
      ),
    ).toBeUndefined();
    const row = store.agentThreads.get(OWNER, 't1')!;
    expect(row.runStatus).toBe('cancelled');
    expect(row.queueState).not.toBe('queued');
  });

  it('records a publication only onto the run that made it', () => {
    const store = fresh();
    store.agentThreads.startRun(
      OWNER, 't1', { runId: 'a00001', command: '$ticket', status: 'publishing', ready: false, detail: null }, NOW,
    );
    // A late answer from a run that no longer owns the thread lands nowhere.
    expect(
      store.agentThreads.setPublication(
        OWNER, 't1', 'a99999', { issueNumber: 7, issueUrl: 'https://github.com/a/b/issues/7' }, NOW,
      ),
    ).toBe(false);
    expect(store.agentThreads.get(OWNER, 't1')!.issueNumber).toBeNull();

    expect(
      store.agentThreads.setPublication(
        OWNER, 't1', 'a00001', { issueNumber: 7, issueUrl: 'https://github.com/a/b/issues/7' }, NOW,
      ),
    ).toBe(true);
    expect(store.agentThreads.get(OWNER, 't1')!.issueNumber).toBe(7);
  });

  it('updates only the run it names', () => {
    const store = fresh();
    store.agentThreads.startRun(
      OWNER, 't1', { runId: 'a00001', command: '$ticket', status: 'publishing', ready: true, detail: null }, NOW,
    );
    // A stale control carrying an older run id changes nothing.
    store.agentThreads.updateRun(OWNER, 't1', 'a99999', { status: 'cancelled' }, NOW);
    expect(store.agentThreads.get(OWNER, 't1')!.runStatus).toBe('publishing');

    store.agentThreads.updateRun(
      OWNER, 't1', 'a00001', { status: 'queued', queueState: 'queued', finished: true }, NOW,
    );
    const row = store.agentThreads.get(OWNER, 't1')!;
    expect(row.runStatus).toBe('queued');
    expect(row.queueState).toBe('queued');
    expect(row.runFinishedAt).not.toBeNull();
  });

  it('finds a run only for its own owner', () => {
    const store = fresh();
    store.agentThreads.startRun(
      OWNER, 't1', { runId: 'a00001', command: '$ticket', status: 'publishing', ready: false, detail: null }, NOW,
    );
    expect(store.agentThreads.byRunId(OWNER, 'a00001')?.threadKey).toBe('t1');
    expect(store.agentThreads.byRunId(OTHER, 'a00001')).toBeUndefined();
  });

  it('refuses a status word the card vocabulary does not contain', () => {
    const store = fresh();
    store.agentThreads.ensure(OWNER, 't1', NOW);
    expect(() =>
      store.db
        .prepare('UPDATE agent_threads SET run_status = ? WHERE discord_user_id = ?')
        .run('running', OWNER),
    ).toThrow();
  });
});

describe('deleting the owner\'s workflow records', () => {
  it('removes every thread for that owner and nobody else\'s, by count', () => {
    const store = fresh();
    store.agentThreads.bindRepository(OWNER, 't1', 'acme/demo', '/tmp/demo', NOW);
    store.agentThreads.bindRepository(OWNER, 't2', 'acme/demo', '/tmp/demo', NOW);
    store.agentThreads.bindRepository(OTHER, 't1', 'acme/demo', '/tmp/demo', NOW);

    expect(store.agentThreads.deleteForOwner(OWNER)).toBe(2);
    expect(store.agentThreads.countForOwner(OWNER)).toBe(0);
    expect(store.agentThreads.countForOwner(OTHER)).toBe(1);
  });
});
