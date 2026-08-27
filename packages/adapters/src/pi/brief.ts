import { cleanUntrusted, type OwnerInput } from '@ducky/contracts';
import { redact } from '../redaction/redact.js';

export interface BriefInput {
  readonly publicId: string;
  readonly repoSlug: string;
  readonly task: string;
  readonly context: string | null;
  readonly ownerInputs: readonly OwnerInput[];
  readonly mode: 'worktree' | 'direct';
  readonly resultRelativePath: string;
}

const MAX_BRIEF_CHARS = 12_000;

/**
 * The prompt handed to Pi. Task and context are owner-authored but pass through
 * redaction and control-character stripping anyway, so nothing secret-shaped
 * can be pushed into an argv element or a terminal.
 *
 * Pi stays the orchestrator: this brief tells it what to coordinate, it does
 * not replace it with another local framework.
 */
export function buildOrchestrationBrief(input: BriefInput): string {
  const task = redact(cleanUntrusted(input.task));
  const context = input.context ? redact(cleanUntrusted(input.context)) : null;

  const rounds = input.ownerInputs
    .map((r) => `- Q${r.round + 1}: ${redact(r.question)}\n  A${r.round + 1}: ${redact(r.answer)}`)
    .join('\n');

  const brief = [
    `# Ducky job ${input.publicId} (${input.repoSlug})`,
    '',
    '## Task',
    task,
    ...(context ? ['', '## Context', context] : []),
    ...(rounds ? ['', '## Prior owner answers', rounds] : []),
    '',
    '## Boundaries (non-negotiable)',
    '- You are the orchestrator. Use exactly ONE implementation writer.',
    '- Obtain an INDEPENDENT review of the implementation before reporting success.',
    '- Run the project verification commands and report their real exit codes.',
    '- Do NOT commit, push, open or merge a pull request, deploy, or mutate cloud resources.',
    `- Working mode: ${input.mode}. Stay inside this workspace.`,
    '',
    '## Required output',
    `Write \`${input.resultRelativePath}\` with this exact shape and nothing else:`,
    '```json',
    '{',
    '  "schemaVersion": 1,',
    '  "verdict": "implemented" | "needs_owner_input" | "failed",',
    '  "summary": "<= 4000 chars",',
    '  "changedFiles": ["repo/relative/path.ts"],',
    '  "review": { "performed": true, "independent": true, "verdict": "pass", "notes": "..." },',
    '  "verification": { "commands": [{ "cmd": "pnpm test", "exitCode": 0, "summary": "..." }], "passed": true },',
    '  "proposedActions": [],',
    '  "question": "only when verdict is needs_owner_input"',
    '}',
    '```',
    'Absolute paths are rejected. `question` is required for needs_owner_input and forbidden otherwise.',
    'A verdict of "implemented" is only accepted with an independent passing review and passing verification.',
  ].join('\n');

  return brief.length > MAX_BRIEF_CHARS ? `${brief.slice(0, MAX_BRIEF_CHARS)}\n[brief truncated]` : brief;
}
