import { describe, expect, it } from 'vitest';
import { validateAssistantImport, type AssistantImportDocument } from '../src/assistant-import.js';

/** Invented data only. Nothing here is, or resembles, a real record. */
const OWNER = '100000000000000001';

export function baseDoc(): Record<string, unknown> {
  return {
    schema: 'ducky-assistant-import/v1',
    profile: 'development',
    ownerId: OWNER,
    timeZone: 'Asia/Manila',
    namespace: 'fixture',
    exportedAt: '2026-10-01T00:00:00Z',
    tasks: [
      {
        sourceId: 't-open', title: 'Water the plants', status: 'open', priority: 'normal',
        due: { kind: 'instant', at: '2026-10-05T15:59:00Z' },
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', closedAt: null,
        reminderPolicy: { enabled: true, offsetsMinutes: null },
      },
      {
        sourceId: 't-done', title: 'Pay the invoice', status: 'done', priority: 'high',
        due: { kind: 'date', date: '2026-09-30' },
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
        closedAt: '2026-09-29T00:00:00Z', reminderPolicy: null,
      },
    ],
    reminders: [
      {
        sourceId: 'r-1', taskSourceId: 't-open', kind: 'offset', offsetMinutes: 60,
        fireAt: '2026-10-05T14:59:00Z', state: 'pending', deliveredAt: null,
        createdAt: '2026-09-01T00:00:00Z',
      },
      {
        sourceId: 'r-2', taskSourceId: 't-done', kind: 'offset', offsetMinutes: 1440,
        fireAt: '2026-09-29T15:59:00Z', state: 'delivered', deliveredAt: '2026-09-29T15:59:30Z',
        createdAt: '2026-09-01T00:00:00Z',
      },
    ],
    captures: [
      { sourceId: 'c-1', text: 'a loose thought', state: 'inbox', createdAt: '2026-09-01T00:00:00Z', processedAt: null },
      { sourceId: 'c-2', state: 'deleted', createdAt: '2026-09-01T00:00:00Z', processedAt: '2026-09-02T00:00:00Z' },
    ],
    schedule: {
      batches: [
        {
          sourceId: 'b-1', status: 'active',
          rules: [
            { sourceId: 'k-1', weekday: 1, startTime: '09:00', endTime: '10:30', label: 'Algebra',
              courseCode: 'MATH 1', section: null, room: null, uncertain: [],
              effectiveFrom: null, effectiveUntil: null },
          ],
        },
        { sourceId: 'b-0', status: 'replaced', rules: [] },
      ],
      exceptions: [
        { sourceId: 'x-1', date: '2026-10-06', courseCode: null, label: null, kind: 'cancelled',
          note: null, createdAt: '2026-10-01T00:00:00Z' },
      ],
    },
    preferences: {
      timeZone: 'Asia/Manila', morningEnabled: true, morningTime: '07:00', eveningEnabled: true,
      eveningTime: '21:00', weekendBriefings: true, lookaheadDays: 3, includeWeather: false,
      includeGithub: true, includeCaptures: true, includeMeal: false, assistantWording: false,
      defaultReminderOffsetsMinutes: [1440, 60],
    },
    briefingDeliveries: [{ kind: 'morning', localDate: '2026-10-01', status: 'delivered', at: '2026-10-01T00:00:10Z' }],
    watch: {
      monitoringEnabled: true,
      targets: [
        {
          sourceId: 'w-1', reference: 'acme/widgets', state: 'active', defaultBranch: 'main',
          lastObservedAt: '2026-10-01T00:00:00Z',
          checkpoints: [
            { surface: 'pulls', cursor: '2026-09-30T10:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
            { surface: 'default_branch', cursor: 'main', updatedAt: '2026-10-01T00:00:00Z' },
          ],
          events: [
            { kind: 'pr_opened', identity: '12:opened', occurredAt: '2026-09-30T09:00:00Z',
              payload: { number: 12, title: 'Add a thing' }, alertedAt: null, digestedAt: '2026-10-01T00:00:00Z' },
          ],
        },
      ],
    },
  };
}

const bad = (mutate: (d: Record<string, any>) => void) => {
  const d = baseDoc();
  mutate(d);
  return validateAssistantImport(d);
};
const rules = (v: ReturnType<typeof validateAssistantImport>): string[] =>
  v.ok ? [] : v.issues.map((i) => `${i.category}:${i.rule}`);

describe('the interchange document', () => {
  it('accepts a complete, consistent document', () => {
    const v = validateAssistantImport(baseDoc());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const doc: AssistantImportDocument = v.doc;
    expect(doc.tasks).toHaveLength(2);
    // Instants are normalised, so equal instants compare equal as text.
    expect(doc.tasks[0]!.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('defaults absent categories to empty rather than failing', () => {
    const v = validateAssistantImport({
      schema: 'ducky-assistant-import/v1', profile: 'development', ownerId: OWNER,
      timeZone: 'UTC', namespace: 'fixture', exportedAt: '2026-10-01T00:00:00Z',
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.doc.watch).toBeNull();
  });

  it('refuses an unknown key instead of dropping it, without naming the key', () => {
    const v = bad((d) => {
      d['tasks'][0]['secret_source_column_name'] = 'x';
    });
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v)).not.toContain('secret_source_column_name');
    expect(rules(v)).toContain('tasks:tasks:unrecognized_keys');
  });

  it('refuses a wrong schema, an unknown profile and a malformed owner', () => {
    expect(rules(bad((d) => { d['schema'] = 'ducky-assistant-import/v2'; }))).toContain('document:schema:invalid_value');
    expect(rules(bad((d) => { d['profile'] = 'staging'; })).length).toBeGreaterThan(0);
    expect(rules(bad((d) => { d['ownerId'] = 'not-a-snowflake'; })).length).toBeGreaterThan(0);
    expect(rules(bad((d) => { d['timeZone'] = 'Mars/Olympus'; })).length).toBeGreaterThan(0);
  });

  it('never repeats a record value in its report', () => {
    const v = bad((d) => {
      d['tasks'][0]['title'] = 'PERSONAL-MARKER-123 ' + 'x'.repeat(400);
      d['captures'][0]['text'] = 'ANOTHER-MARKER-456';
      d['captures'][0]['state'] = 'deleted';
    });
    expect(v.ok).toBe(false);
    const dump = JSON.stringify(v);
    expect(dump).not.toContain('PERSONAL-MARKER');
    expect(dump).not.toContain('ANOTHER-MARKER');
  });

  it('is strict about instants and dates', () => {
    expect(rules(bad((d) => { d['tasks'][0]['createdAt'] = '2026-09-01 00:00:00'; })).length).toBeGreaterThan(0);
    expect(rules(bad((d) => { d['tasks'][0]['createdAt'] = '2026-09-01T00:00:00+08:00'; })).length).toBeGreaterThan(0);
    expect(rules(bad((d) => { d['tasks'][1]['due'] = { kind: 'date', date: '2026-02-30' }; })).length).toBeGreaterThan(0);
  });

  it('does not let a date-only deadline pose as a midnight instant', () => {
    const v = validateAssistantImport(baseDoc());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.doc.tasks[1]!.due).toEqual({ kind: 'date', date: '2026-09-30' });
    expect(v.doc.tasks[0]!.due).toEqual({ kind: 'instant', at: '2026-10-05T15:59:00.000Z' });
  });
});

describe('task and reminder consistency', () => {
  it('requires closed times to agree with state', () => {
    expect(rules(bad((d) => { d['tasks'][0]['closedAt'] = '2026-09-03T00:00:00Z'; }))).toContain('tasks:closed_at_mismatch');
    expect(rules(bad((d) => { d['tasks'][1]['closedAt'] = null; }))).toContain('tasks:closed_at_mismatch');
    expect(rules(bad((d) => { d['tasks'][0]['updatedAt'] = '2026-08-01T00:00:00Z'; }))).toContain('tasks:updated_before_created');
  });

  it('refuses a pending reminder for a closed task, which could become a late send', () => {
    expect(rules(bad((d) => { d['reminders'][1]['state'] = 'pending'; d['reminders'][1]['deliveredAt'] = null; })))
      .toContain('reminders:pending_for_closed_task');
  });

  it('refuses a reminder for an unknown task and a duplicate identity', () => {
    expect(rules(bad((d) => { d['reminders'][0]['taskSourceId'] = 'nope'; }))).toContain('reminders:unknown_task');
    expect(rules(bad((d) => { d['tasks'][1]['sourceId'] = 't-open'; }))).toContain('tasks:duplicate_source_id');
  });

  it('requires a delivered time exactly for a delivered reminder', () => {
    expect(rules(bad((d) => { d['reminders'][1]['deliveredAt'] = null; }))).toContain('reminders:delivered_at_mismatch');
    expect(rules(bad((d) => { d['reminders'][0]['deliveredAt'] = '2026-10-05T14:59:00Z'; }))).toContain('reminders:delivered_at_mismatch');
  });

  it('refuses custom offsets on an all-day deadline rather than inventing a time of day', () => {
    expect(rules(bad((d) => { d['tasks'][1]['reminderPolicy'] = { enabled: true, offsetsMinutes: [60] }; })))
      .toContain('tasks:all_day_with_offsets_unsupported');
    // Disabled, or deferring to the default list, is fine.
    expect(bad((d) => { d['tasks'][1]['reminderPolicy'] = { enabled: false, offsetsMinutes: null }; }).ok).toBe(true);
  });

  it('keeps an offset reminder and a snooze distinct', () => {
    expect(rules(bad((d) => { d['reminders'][0]['kind'] = 'snooze'; }))).toContain('reminders:offset_mismatch');
  });
});

describe('captures', () => {
  it('keeps only the identity of a deleted capture', () => {
    expect(rules(bad((d) => { d['captures'][1]['text'] = 'still here'; }))).toContain('captures:text_presence');
    expect(rules(bad((d) => { delete d['captures'][0]['text']; }))).toContain('captures:text_presence');
  });
});

describe('schedule', () => {
  it('allows at most one active batch', () => {
    expect(rules(bad((d) => { d['schedule']['batches'][1]['status'] = 'active'; }))).toContain('schedule:multiple_active_batches');
  });

  it('refuses a rule whose end is not after its start', () => {
    expect(rules(bad((d) => { d['schedule']['batches'][0]['rules'][0]['endTime'] = '09:00'; }))).toContain('schedule:end_not_after_start');
  });

  it('refuses an exception kind it does not implement', () => {
    expect(rules(bad((d) => { d['schedule']['exceptions'][0]['kind'] = 'moved'; })).length).toBeGreaterThan(0);
  });
});

describe('preferences: unsupported active behavior is refused, never dropped', () => {
  it('refuses meals and assistant wording when active', () => {
    expect(rules(bad((d) => { d['preferences']['includeMeal'] = true; }))).toContain('preferences:meal_unsupported');
    expect(rules(bad((d) => { d['preferences']['assistantWording'] = true; }))).toContain('preferences:assistant_wording_unsupported');
  });

  it('refuses a preference timezone that disagrees with the document', () => {
    expect(rules(bad((d) => { d['preferences']['timeZone'] = 'UTC'; }))).toContain('preferences:time_zone_disagrees');
  });
});

describe('watch targets', () => {
  it('refuses a disabled global switch because there is no paused state', () => {
    expect(rules(bad((d) => { d['watch']['monitoringEnabled'] = false; }))).toContain('watch:monitoring_disabled_unsupported');
  });

  it('refuses a duplicate reference regardless of case', () => {
    expect(rules(bad((d) => {
      d['watch']['targets'].push({ ...d['watch']['targets'][0], sourceId: 'w-2', reference: 'ACME/Widgets' });
    }))).toContain('watch:duplicate_reference');
  });

  it('refuses an event whose surface has no checkpoint, which would be re-announced', () => {
    expect(rules(bad((d) => {
      d['watch']['targets'][0]['events'][0]['kind'] = 'issue_opened';
    }))).toContain('watch:event_without_checkpoint');
  });

  it('refuses a malformed cursor, an unknown CI state and an unknown event kind', () => {
    expect(rules(bad((d) => { d['watch']['targets'][0]['checkpoints'][0]['cursor'] = 'yesterday'; }))).toContain('watch:cursor_not_an_instant');
    expect(rules(bad((d) => {
      d['watch']['targets'][0]['checkpoints'].push({ surface: 'ci_state', cursor: 'flaky', updatedAt: '2026-10-01T00:00:00Z' });
    }))).toContain('watch:ci_state_unknown');
    expect(rules(bad((d) => { d['watch']['targets'][0]['events'][0]['kind'] = 'branch_created'; })).length).toBeGreaterThan(0);
  });

  it('refuses a malformed repository reference', () => {
    expect(rules(bad((d) => { d['watch']['targets'][0]['reference'] = 'not a repo'; })).length).toBeGreaterThan(0);
    expect(rules(bad((d) => { d['watch']['targets'][0]['reference'] = 'a/b/c'; })).length).toBeGreaterThan(0);
  });
});
