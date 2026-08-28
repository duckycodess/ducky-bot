import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers.js';

/**
 * Captures, inbox, schedules, tasks, reminders, briefings, jobs and repository
 * data are private personal data. Every one of these is exercised at the SERVICE layer with the command
 * router bypassed, so the guarantee does not depend on routing.
 */
describe('private data is owner-only at the service layer', () => {
  it('refuses captures and inbox to a chat user and a stranger', () => {
    const h = makeHarness();
    for (const actor of [h.chat, h.stranger]) {
      expect(() => h.app.captures.create(actor, 'note')).toThrow(/not authorized/i);
      expect(() => h.app.captures.list(actor)).toThrow(/not authorized/i);
      expect(() => h.app.captures.setStatus(actor, 'x', 'done')).toThrow(/not authorized/i);
      expect(() => h.app.captures.delete(actor, 'x')).toThrow(/not authorized/i);
    }
    h.close();
  });

  it('refuses schedules, jobs, approvals and repo status to non-owners', async () => {
    const h = makeHarness();
    for (const actor of [h.chat, h.stranger]) {
      await expect(
        h.app.schedules.preview(actor, { kind: 'text', text: '2026-09-01 09:00 | Standup' }),
      ).rejects.toThrow(/not authorized/i);
      expect(() => h.app.schedules.confirm(actor, 'draft')).toThrow(/not authorized/i);
      expect(() => h.app.schedules.list(actor)).toThrow(/not authorized/i);
      expect(() =>
        h.app.jobs.submit(actor, { repoSlug: 'demo', task: 'do it', bootstrap: false }),
      ).toThrow(/not authorized/i);
      expect(() => h.app.jobs.list(actor)).toThrow(/not authorized/i);
      expect(() => h.app.jobs.detail(actor, 'jabcde')).toThrow(/not authorized/i);
      expect(() => h.app.jobs.requestCancel(actor, 'jabcde')).toThrow(/not authorized/i);
      expect(() => h.app.jobs.submitOwnerInput(actor, 'jabcde', 'yes')).toThrow(/not authorized/i);
      expect(() => h.app.jobs.cleanup(actor, 'jabcde', false)).toThrow(/not authorized/i);
      expect(() => h.app.approvals.decide(actor, 'approval', 'approved')).toThrow(/not authorized/i);
      await expect(h.app.github.repoStatus(actor, 'demo')).rejects.toThrow(/not authorized/i);
      // The daily assistant (2B) joins the same class of private data.
      expect(() => h.app.tasks.add(actor, { title: 'x' })).toThrow(/not authorized/i);
      expect(() => h.app.tasks.list(actor)).toThrow(/not authorized/i);
      expect(() => h.app.tasks.complete(actor, 'tabcde')).toThrow(/not authorized/i);
      expect(() => h.app.reminders.add(actor, { text: 'x', at: 'in 1h' })).toThrow(
        /not authorized/i,
      );
      expect(() => h.app.reminders.list(actor)).toThrow(/not authorized/i);
      expect(() => h.app.reminders.cancel(actor, 'rabcde')).toThrow(/not authorized/i);
      expect(() => h.app.briefing.build(actor)).toThrow(/not authorized/i);
    }
    h.close();
  });

  it('lets the owner through on the same calls', () => {
    const h = makeHarness();
    const capture = h.app.captures.create(h.owner, 'buy milk');
    expect(h.app.captures.list(h.owner).map((c) => c.id)).toContain(capture.id);
    const job = h.app.jobs.submit(h.owner, { repoSlug: 'demo', task: 'do it', bootstrap: false });
    expect(h.app.jobs.detail(h.owner, job.publicId).job.id).toBe(job.id);
    h.close();
  });

  it('hides another account’s rows even from the owner path', () => {
    const h = makeHarness();
    const capture = h.app.captures.create(h.owner, 'mine');
    // simulate a row belonging to someone else
    h.store.db.prepare('UPDATE captures SET discord_user_id = ? WHERE id = ?').run('999', capture.id);
    expect(() => h.app.captures.setStatus(h.owner, capture.id, 'done')).toThrow(/no longer exists/);
    expect(h.app.captures.list(h.owner)).toHaveLength(0);
    h.close();
  });

  it('keeps conversation isolated from every privileged service', () => {
    const h = makeHarness();
    const conversation = h.app.conversation as unknown as Record<string, unknown>;
    for (const key of Object.keys(conversation)) {
      const value = conversation[key];
      expect(typeof value === 'object' && value !== null && 'submit' in (value as object)).toBe(false);
    }
    h.close();
  });
});
