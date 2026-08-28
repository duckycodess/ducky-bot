import { z } from 'zod';

/**
 * Deliberately lenient: unknown keys pass through and only the fields we
 * actually use are required. `pnpm probe:herdr` records real responses as
 * fixtures and `herdr-contract.test.ts` parses them with exactly these
 * schemas.
 *
 * Field optionality is taken from `herdr api schema --json`, which the server
 * publishes, rather than from what a sample response happened to contain. In
 * particular `AgentInfo.agent` and `AgentInfo.name` are BOTH nullable there:
 * a pane can be recognised as hosting an agent whose kind or name Herdr
 * cannot currently state, and requiring them would turn that into an outage.
 */
export const AgentStatusSchema = z.enum(['idle', 'working', 'blocked', 'done', 'unknown']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentInfoSchema = z.looseObject({
  agent: z.string().nullish(),
  agent_status: AgentStatusSchema.catch('unknown'),
  cwd: z.string().nullish(),
  pane_id: z.string(),
  /** Whether the agent can take input right now. Absent on older responses. */
  interactive_ready: z.boolean().optional(),
  workspace_id: z.string().optional(),
  tab_id: z.string().optional(),
  name: z.string().nullish(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

/**
 * Which terminal snapshot `agent read` returns. Recorded from the live CLI on
 * this host (herdr 0.8.0): `visible | recent | recent-unwrapped | detection`,
 * default `recent`.
 *
 * `detection` is the one readiness uses. It is the same snapshot Herdr feeds
 * its own agent detection, so it is the closest thing to "what Herdr is looking
 * at when it decides an agent is ready" that a caller can see.
 */
export const AGENT_READ_SOURCES = ['visible', 'recent', 'recent-unwrapped', 'detection'] as const;
export type AgentReadSource = (typeof AGENT_READ_SOURCES)[number];

/**
 * `agent start` answers `{ type: 'agent_started', agent, argv }` and
 * `agent prompt` answers `{ type: 'agent_prompted', agent }`.
 *
 * The prompt response carries the SETTLED agent, which is the only way to tell
 * a turn that finished from one that stopped at an approval prompt. Discarding
 * it -- as this adapter used to -- makes `blocked` indistinguishable from
 * `idle`, so the caller reads a missing result file and reports "no result"
 * for an agent that is alive and waiting for a human.
 */
export const AgentStartResultSchema = z.looseObject({
  agent: AgentInfoSchema,
  argv: z.array(z.string()).optional(),
});

export const AgentPromptResultSchema = z.looseObject({ agent: AgentInfoSchema });

export const AgentListResultSchema = z.looseObject({ agents: z.array(AgentInfoSchema) });

export const WorkspaceSummarySchema = z.looseObject({
  workspace_id: z.string(),
  label: z.string().optional(),
  agent_status: z.string().optional(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const WorkspaceListResultSchema = z.looseObject({
  workspaces: z.array(WorkspaceSummarySchema),
});

export const PaneSchema = z.looseObject({ pane_id: z.string() });

export const WorkspaceCreateResultSchema = z.looseObject({
  workspace: z.looseObject({ workspace_id: z.string() }),
  tab: z.looseObject({ tab_id: z.string() }).optional(),
  root_pane: PaneSchema.optional(),
});

export const PaneSplitResultSchema = z.looseObject({ pane: PaneSchema });

/**
 * Shape confirmed against a live `herdr worktree create` (see
 * herdr.fixtures/worktree-create.json). The checkout path is reported both as
 * `result.worktree.path` and as `result.workspace.worktree.checkout_path`; we
 * read the former and fall back to the latter.
 */
export const WorktreeCreateResultSchema = z.looseObject({
  workspace: z
    .looseObject({
      workspace_id: z.string(),
      worktree: z.looseObject({ checkout_path: z.string().optional() }).optional(),
    })
    .optional(),
  worktree: z
    .looseObject({ path: z.string().optional(), branch: z.string().optional() })
    .optional(),
  root_pane: PaneSchema.optional(),
});

/** Every herdr CLI response is `{ id, result }` (or `{ id, error }`). */
export const EnvelopeSchema = z.looseObject({
  id: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

/**
 * Herdr's error body, verified live: a failing command exits non-zero and
 * writes `{"error":{"code","message"},"id"}` to STDERR.
 *
 * `code` is the machine-stable half. Classifying on the human `message`
 * instead -- which this adapter used to do -- means a wording change silently
 * reclassifies "no such agent" as "Herdr is down", and the two have opposite
 * consequences for a repository reservation.
 */
export const HerdrErrorBodySchema = z.looseObject({
  code: z.string(),
  message: z.string().optional(),
});

export const HerdrErrorEnvelopeSchema = z.looseObject({
  id: z.string().optional(),
  error: HerdrErrorBodySchema,
});

/** Codes meaning "that target does not exist", as opposed to an outage. */
export const HERDR_NOT_FOUND_CODES: readonly string[] = [
  'agent_not_found',
  'pane_not_found',
  'workspace_not_found',
  'tab_not_found',
  'worktree_not_found',
  'not_found',
];

/** Codes meaning "the wait did not settle", which is NOT an outage either. */
export const HERDR_STALLED_CODES: readonly string[] = ['agent_prompt_stalled'];

/**
 * Codes meaning "the checkout has uncommitted work, pass --force".
 *
 * Verified live: `worktree remove` on a checkout containing an untracked file
 * answers `dirty_worktree_requires_force`. Every finished Ducky job leaves at
 * least `.ducky/result.json` there, so this is the NORMAL outcome of cleaning
 * up after real work -- not an error condition.
 */
export const HERDR_DIRTY_WORKTREE_CODES: readonly string[] = ['dirty_worktree_requires_force'];

/**
 * Codes meaning "the agent exists but cannot take input yet".
 *
 * Verified live: `agent start` returned successfully and a prompt three seconds
 * later was refused with `agent_not_ready`. Transient by nature, so it must be
 * distinguishable from an outage -- retrying is correct, failing the job is not.
 */
export const HERDR_NOT_READY_CODES: readonly string[] = ['agent_not_ready'];
