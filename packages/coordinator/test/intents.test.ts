import { describe, expect, it } from 'vitest';
import { INTENT_PROPOSAL_TTL_MS, detectIntent } from '@ducky/contracts';
import { CHAT, OWNER, TestClock, makeHarness, replyText } from './helpers.js';
import { FILIPINO_DISHES, buildStudyPlan, mealForHour, suggestMeal } from '../src/domain/local-helpers.js';

/**
 * Deterministic natural language on the conversation route.
 *
 * The risk here is a WRITE nobody asked for, so most of this is about the
 * proposal: that it is never applied on inference alone, that ambiguity produces
 * nothing, and that a non-owner reaches none of it.
 */
const say = async (h: ReturnType<typeof makeHarness>, userId: string, text: string, thread = 'dm-1') =>
  h.app.router.handle({ kind: 'message', userId, text, threadKey: thread });

describe('the rule table reads a message or declines to', () => {
  it('reads the shapes it claims to', () => {
    expect(detectIntent('remind me to call the bank tomorrow 09:00')).toMatchObject({
      kind: 'reminder_add', subject: 'call the bank', when: 'tomorrow 09:00',
    });
    expect(detectIntent('add a task to renew the domain')).toMatchObject({
      kind: 'task_add', subject: 'renew the domain',
    });
    expect(detectIntent('todo: pay the bill')).toMatchObject({ kind: 'task_add', subject: 'pay the bill' });
    expect(detectIntent('capture: the executor lease is 5 minutes')).toMatchObject({
      kind: 'capture', subject: 'the executor lease is 5 minutes',
    });
    expect(detectIntent('brief me')).toMatchObject({ kind: 'briefing' });
    expect(detectIntent('what should i cook')).toMatchObject({ kind: 'meal' });
    expect(detectIntent('help me study zod schemas')).toMatchObject({ kind: 'study' });
  });

  it('reads a repeat, and keeps it out of the subject', () => {
    expect(detectIntent('remind me to stretch every 30m at 09:00')).toMatchObject({
      kind: 'reminder_add', subject: 'stretch', every: '30m', when: '09:00',
    });
  });

  it('means nothing far more often than something', () => {
    for (const text of [
      'hello',
      'that reminds me of the outage last week',
      'the todo list is getting long',
      'what do you think about the API design?',
      '',
      'a'.repeat(3_000),
    ]) {
      expect(detectIntent(text), text).toBeUndefined();
    }
  });

  it('refuses a reminder with no time rather than inventing one', () => {
    expect(detectIntent('remind me to call the bank')).toBeUndefined();
  });
});

describe('an inferred write is proposed, never applied', () => {
  it('proposes and stores nothing until the owner says yes', async () => {
    const h = makeHarness();

    const proposal = await say(h, OWNER, 'i need to renew the domain');

    expect(replyText(proposal)).toMatch(/looks like a task/i);
    expect(replyText(proposal)).toMatch(/Nothing is saved yet/);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);

    const confirmed = await say(h, OWNER, 'yes');
    expect(replyText(confirmed)).toMatch(/Task `t/);
    const tasks = h.app.tasks.list(h.owner, 'all');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('renew the domain');
    h.close();
  });

  it('drops the proposal on a refusal, saving nothing', async () => {
    const h = makeHarness();
    await say(h, OWNER, 'todo: something i changed my mind about');

    const dropped = await say(h, OWNER, 'no');

    expect(replyText(dropped)).toMatch(/Dropped it/);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('does not treat an unrelated later message as consent', async () => {
    const h = makeHarness();
    await say(h, OWNER, 'todo: renew the domain');

    // Anything that is not an explicit yes falls through to conversation, and
    // the proposal stays outstanding rather than being applied.
    const unrelated = await say(h, OWNER, 'what is the weather like');

    expect(replyText(unrelated)).not.toMatch(/Task `t/);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    expect(h.app.intents.hasPending(h.owner, 'dm-1')).toBe(true);
    h.close();
  });

  it('expires a proposal rather than holding it forever', async () => {
    const clock = new TestClock('2026-03-02T08:00:00Z');
    const h = makeHarness({ clock });
    await say(h, OWNER, 'todo: renew the domain');

    clock.advance(INTENT_PROPOSAL_TTL_MS + 1_000);
    const late = await say(h, OWNER, 'yes');

    expect(replyText(late)).not.toMatch(/Task `t/);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('holds one proposal per thread, so a yes cannot mean the older one', async () => {
    const h = makeHarness();
    await say(h, OWNER, 'todo: the first thing');
    await say(h, OWNER, 'todo: the second thing');

    await say(h, OWNER, 'yes');

    const titles = h.app.tasks.list(h.owner, 'all').map((t) => t.title);
    expect(titles).toEqual(['the second thing']);
    h.close();
  });

  it('keeps proposals separate per thread', async () => {
    const h = makeHarness();
    await say(h, OWNER, 'todo: from the first thread', 'dm-1');

    // A yes in ANOTHER thread confirms nothing.
    const elsewhere = await say(h, OWNER, 'yes', 'dm-2');
    expect(replyText(elsewhere)).not.toMatch(/Task `t/);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);

    await say(h, OWNER, 'yes', 'dm-1');
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(1);
    h.close();
  });

  it('reports a refusal from the service instead of claiming a save', async () => {
    const h = makeHarness();
    // A time the parser refuses: the proposal is made from the rule table, and
    // the service is what validates it.
    await say(h, OWNER, 'remind me to call the bank at 99:99');
    const applied = await say(h, OWNER, 'yes');

    expect(applied?.content ?? '').not.toMatch(/Reminder `r/);
    h.close();
  });
});

describe('none of it is reachable by a non-owner', () => {
  it('gives a whitelist user plain conversation, with no proposal', async () => {
    const h = makeHarness();

    const reply = await say(h, CHAT, 'i need to renew the domain');

    expect(replyText(reply)).toMatch(/\[mock\]/);
    expect(h.app.intents.hasPending(h.chat, 'dm-1')).toBe(false);
    h.close();
  });

  it('gives a whitelist user no meal or study helper either', async () => {
    const h = makeHarness();
    const meal = await say(h, CHAT, 'what should i cook');
    expect(replyText(meal)).toMatch(/\[mock\]/);
    h.close();
  });
});

describe('the local helpers answer from fixed data, and say so', () => {
  it('suggests from the fixed list and names its own limits', async () => {
    const h = makeHarness();

    const reply = await say(h, OWNER, 'what should i cook for dinner');

    expect(replyText(reply)).toMatch(/For dinner:/);
    expect(replyText(reply)).toMatch(/fixed list in Ducky's own source/);
    expect(replyText(reply)).toMatch(/not a complete set/);
    h.close();
  });

  it('honours only constraints it can actually check', () => {
    const s = suggestMeal({ text: 'what should i cook, no pork and quick', hour: 18, dayKey: '2026-03-02' });
    expect(s.applied).toContain('quick');
    expect(s.applied).toContain('no pork');
    for (const dish of s.picks) {
      expect(dish.mainProtein).not.toBe('pork');
      expect(dish.minutes).toBeLessThanOrEqual(30);
    }
  });

  it('says so when a constraint left nothing, instead of inventing a dish', () => {
    const s = suggestMeal({
      text: 'no pork no chicken no beef no fish vegetarian quick',
      hour: 18,
      dayKey: '2026-03-02',
    });
    // Either it found something real, or it admits it fell back.
    for (const dish of s.picks) expect(FILIPINO_DISHES).toContain(dish);
    if (s.narrowed) expect(s.picks.length).toBeGreaterThan(0);
  });

  it('is deterministic for the same day, so it is a suggestion not a slot machine', () => {
    const a = suggestMeal({ text: 'what should i cook', hour: 18, dayKey: '2026-03-02' });
    const b = suggestMeal({ text: 'what should i cook', hour: 18, dayKey: '2026-03-02' });
    expect(a.picks.map((d) => d.name)).toEqual(b.picks.map((d) => d.name));
  });

  it('picks the meal from the local hour', () => {
    expect(mealForHour(7)).toBe('breakfast');
    expect(mealForHour(12)).toBe('lunch');
    expect(mealForHour(19)).toBe('dinner');
  });

  it('builds a study plan that claims no knowledge of the topic', async () => {
    const h = makeHarness();

    const reply = await say(h, OWNER, 'help me study zod schemas for 60 minutes');

    expect(replyText(reply)).toMatch(/60 minutes on zod schemas/);
    expect(replyText(reply)).toMatch(/knows nothing about the subject/);
    expect(replyText(reply)).toMatch(/kept nothing/);
    h.close();
  });

  it('bounds the study plan rather than trusting the number', () => {
    expect(buildStudyPlan('x', 5).totalMinutes).toBe(20);
    expect(buildStudyPlan('x', 10_000).totalMinutes).toBe(180);
    const plan = buildStudyPlan('x', 100);
    expect(plan.blocks.reduce((n, b) => n + b.minutes, 0)).toBeCloseTo(100, 0);
  });
});

describe('the owner-only surface is unchanged by any of this', () => {
  it('adds no command and no interaction kind', async () => {
    const { OWNER_ONLY_COMMANDS, OWNER_ONLY_INTERACTION_KINDS } = await import('@ducky/contracts');
    // AGENTS.md forbids widening the owner-only surface, so the natural-language
    // path rides conversation and confirms with a message rather than a button.
    expect([...OWNER_ONLY_COMMANDS]).toEqual([
      'capture', 'inbox', 'schedule', 'job', 'jobs', 'repo', 'status',
      'task', 'reminder', 'briefing', 'watch', 'forget',
    ]);
    expect([...OWNER_ONLY_INTERACTION_KINDS]).not.toContain('intent_confirm');
    expect([...OWNER_ONLY_COMMANDS]).not.toContain('meal');
    expect([...OWNER_ONLY_COMMANDS]).not.toContain('study');
  });
});
