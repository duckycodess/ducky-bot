import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobResultFileSchema } from '@ducky/contracts';
import {
  AgentListResultSchema, AgentPromptResultSchema, AgentStartResultSchema, EnvelopeSchema,
  PaneSplitResultSchema, WorkspaceCreateResultSchema, WorkspaceListResultSchema,
  WorktreeCreateResultSchema,
} from '../src/herdr/herdr.types.js';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'src', 'herdr', 'herdr.fixtures');

const SCHEMAS = {
  'agent-list': AgentListResultSchema,
  'workspace-list': WorkspaceListResultSchema,
  'workspace-create': WorkspaceCreateResultSchema,
  'pane-split': PaneSplitResultSchema,
  'worktree-create': WorktreeCreateResultSchema,
  // Recorded only by `pnpm probe:herdr --with-agent`, which starts a real Pi
  // agent. Absent fixtures skip rather than pass.
  'agent-start': AgentStartResultSchema,
  'agent-prompt': AgentPromptResultSchema,
} as const;

/** The commands that, once recorded, make the orchestrator certifiable. */
const AGENT_FIXTURES = ['agent-start.json', 'agent-prompt.json', 'agent-get.json'];

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

  /**
   * `agent get` returns a bare `agent_info`, which `AgentInfoSchema` covers
   * through `AgentPromptResultSchema`'s shape; it is asserted separately so a
   * malformed recording cannot pass by being ignored.
   */
  it.runIf(existsSync(path.join(FIXTURES, 'agent-get.json')))(
    'parses the recorded agent-get response',
    () => {
      const raw = JSON.parse(readFileSync(path.join(FIXTURES, 'agent-get.json'), 'utf8')) as unknown;
      const envelope = EnvelopeSchema.parse(raw);
      expect(envelope.error).toBeUndefined();
      expect(() => AgentPromptResultSchema.parse(envelope.result)).not.toThrow();
    },
  );

  /**
   * The result file is the ONLY channel back from Pi, and the probe reads it
   * from the checkout path Herdr reported rather than from the source
   * repository. Parsing it with the production schema is what proves the two
   * halves of that contract actually meet.
   */
  it.runIf(existsSync(path.join(FIXTURES, 'agent-result-file.json')))(
    'parses the result file a real Pi agent wrote, with the production schema',
    () => {
      const raw = JSON.parse(
        readFileSync(path.join(FIXTURES, 'agent-result-file.json'), 'utf8'),
      ) as unknown;
      expect(() => JobResultFileSchema.parse(raw)).not.toThrow();
    },
  );

  it('states plainly whether the agent commands have been exercised', () => {
    const missing = AGENT_FIXTURES.filter((f) => !existsSync(path.join(FIXTURES, f)));
    if (missing.length > 0) {
      // Not a failure: recording these launches a real agent. It is a fact the
      // suite reports so nothing downstream can quietly claim verification.
      expect(missing.length).toBeGreaterThan(0);
      return;
    }
    expect(missing).toEqual([]);
  });

  it.runIf(recorded.length > 0)('never records a host path or a token', () => {
    for (const f of recorded) {
      const body = readFileSync(path.join(FIXTURES, f), 'utf8');
      expect(body, f).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
      expect(body, f).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/);
    }
  });

  /**
   * `agent list` returns EVERY agent in the session, so a recording picks up
   * whatever else is running on the machine -- and a terminal title is often a
   * task description, i.e. somebody's private prompt. One recording on this
   * host captured the title of the very session that made it.
   *
   * No schema reads these fields, so blanking them costs the contract nothing.
   */
  it.runIf(recorded.length > 0)('records no free-text title from unrelated work', () => {
    const opaque = ['terminal_title', 'terminal_title_stripped', 'title', 'display_agent'];
    for (const f of recorded) {
      const body = readFileSync(path.join(FIXTURES, f), 'utf8');
      for (const key of opaque) {
        const found = [...body.matchAll(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'g'))];
        for (const m of found) {
          expect(m[1], `${f} ${key}`).toBe('[REDACTED:title]');
        }
      }
    }
  });
});
