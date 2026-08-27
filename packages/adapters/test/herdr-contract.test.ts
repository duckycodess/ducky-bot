import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentListResultSchema, EnvelopeSchema, PaneSplitResultSchema,
  WorkspaceCreateResultSchema, WorkspaceListResultSchema, WorktreeCreateResultSchema,
} from '../src/herdr/herdr.types.js';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'src', 'herdr', 'herdr.fixtures');

const SCHEMAS = {
  'agent-list': AgentListResultSchema,
  'workspace-list': WorkspaceListResultSchema,
  'workspace-create': WorkspaceCreateResultSchema,
  'pane-split': PaneSplitResultSchema,
  'worktree-create': WorktreeCreateResultSchema,
} as const;

const recorded = existsSync(FIXTURES)
  ? readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))
  : [];

/**
 * The mutating Herdr commands could not be exercised while planning, so the
 * production schemas are checked against RECORDED LIVE RESPONSES rather than
 * against assumptions. Until `pnpm probe:herdr` has run on this host there are
 * no fixtures, the suite says so, and the orchestrator stays experimental --
 * passing mocks is not evidence that the real integration works.
 */
describe('herdr response contract', () => {
  it('reports honestly when no live probe has been recorded', () => {
    if (recorded.length === 0) {
      expect(recorded).toEqual([]);
      return;
    }
    expect(recorded.length).toBeGreaterThan(0);
  });

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const file = path.join(FIXTURES, `${name}.json`);
    it.runIf(existsSync(file))(`parses the recorded ${name} response`, () => {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const envelope = EnvelopeSchema.parse(raw);
      expect(envelope.error).toBeUndefined();
      expect(() => schema.parse(envelope.result)).not.toThrow();
    });
  }

  it.runIf(recorded.length > 0)('never records a host path or a token', () => {
    for (const f of recorded) {
      const body = readFileSync(path.join(FIXTURES, f), 'utf8');
      expect(body, f).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
      expect(body, f).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/);
    }
  });
});
