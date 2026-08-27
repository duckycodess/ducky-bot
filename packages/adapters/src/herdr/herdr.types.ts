import { z } from 'zod';

/**
 * Deliberately lenient: these shapes were read from the live `herdr` CLI and
 * its shipped skill file, but the mutating commands could not be exercised
 * during planning. Unknown keys pass through; only the fields we actually use
 * are required. `pnpm probe:herdr` records real responses as fixtures and
 * `herdr-contract.test.ts` parses them with exactly these schemas.
 */
export const AgentStatusSchema = z.enum(['idle', 'working', 'blocked', 'done', 'unknown']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentInfoSchema = z.looseObject({
  agent: z.string(),
  agent_status: AgentStatusSchema.catch('unknown'),
  cwd: z.string().optional(),
  pane_id: z.string(),
  workspace_id: z.string().optional(),
  tab_id: z.string().optional(),
  name: z.string().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

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
