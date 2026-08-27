import { describe, expect, it } from 'vitest';
import { JobResultFileSchema, canonicalJson } from '../src/job-result.js';

const base = {
  schemaVersion: 1,
  summary: 'did the thing',
  changedFiles: ['src/a.ts'],
  review: { performed: true, independent: true, verdict: 'pass', notes: 'ok' },
  verification: { commands: [{ cmd: 'pnpm test', exitCode: 0, summary: 'green' }], passed: true },
};

describe('result contract', () => {
  it('accepts a well-formed implemented result', () => {
    expect(JobResultFileSchema.safeParse({ ...base, verdict: 'implemented', proposedActions: [] }).success).toBe(true);
  });

  it('requires question exactly for needs_owner_input', () => {
    expect(
      JobResultFileSchema.safeParse({ ...base, verdict: 'needs_owner_input', proposedActions: [] }).success,
      'missing question',
    ).toBe(false);
    expect(
      JobResultFileSchema.safeParse({
        ...base, verdict: 'needs_owner_input', question: 'which db?', proposedActions: [],
      }).success,
    ).toBe(true);
  });

  it('forbids question on implemented and failed', () => {
    expect(
      JobResultFileSchema.safeParse({ ...base, verdict: 'implemented', proposedActions: [], question: 'x' }).success,
    ).toBe(false);
    expect(
      JobResultFileSchema.safeParse({ ...base, verdict: 'failed', proposedActions: [], question: 'x' }).success,
    ).toBe(false);
  });

  it('forbids proposed actions unless implemented', () => {
    const action = {
      kind: 'git_commit',
      description: 'commit it',
      details: { message: 'feat: x', files: ['src/a.ts'] },
    };
    expect(
      JobResultFileSchema.safeParse({ ...base, verdict: 'failed', proposedActions: [action] }).success,
    ).toBe(false);
    expect(
      JobResultFileSchema.safeParse({
        ...base, verdict: 'needs_owner_input', question: 'q', proposedActions: [action],
      }).success,
    ).toBe(false);
    expect(
      JobResultFileSchema.safeParse({ ...base, verdict: 'implemented', proposedActions: [action] }).success,
    ).toBe(true);
  });

  it('rejects unknown keys anywhere, including inside action details', () => {
    expect(
      JobResultFileSchema.safeParse({ ...base, verdict: 'implemented', proposedActions: [], extra: 1 }).success,
    ).toBe(false);
    expect(
      JobResultFileSchema.safeParse({
        ...base,
        verdict: 'implemented',
        proposedActions: [
          {
            kind: 'git_commit',
            description: 'c',
            details: { message: 'm', files: [], sneaky: true },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects absolute paths in changedFiles and in commit details', () => {
    expect(
      JobResultFileSchema.safeParse({
        ...base, verdict: 'implemented', changedFiles: ['/etc/passwd'], proposedActions: [],
      }).success,
    ).toBe(false);
    expect(
      JobResultFileSchema.safeParse({
        ...base,
        verdict: 'implemented',
        proposedActions: [
          { kind: 'git_commit', description: 'c', details: { message: 'm', files: ['../x'] } },
        ],
      }).success,
    ).toBe(false);
  });

  it('canonicalises key order so the idempotency hash is stable', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});
