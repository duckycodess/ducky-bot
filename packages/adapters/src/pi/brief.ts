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
  /** Where Pi reports its own engineering phase. Nothing else can observe it. */
  readonly phaseRelativePath: string;
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
    '## Progress reporting',
    `As you enter each engineering phase, overwrite \`${input.phaseRelativePath}\` with exactly`,
    'one of these lowercase words and nothing else:',
    '',
    '    implementing, reviewing, fixing, verifying',
    '',
    'Write them IN THE ORDER you actually enter them. Skipping ahead is refused and',
    'discarded, so a jump straight to `verifying` reports nothing at all. This file is',
    'the only way the owner can see where the work is; it never affects the result.',
    '',
    '## Required output',
    `Write \`${input.resultRelativePath}\` with this exact shape and nothing else:`,
    '```json',
    '{',
    '  "schemaVersion": 1,',
    '  "verdict": "implemented" | "needs_owner_input" | "failed" | "waiting_on_dependency",',
    '  "summary": "<= 4000 chars",',
    '  "changedFiles": ["repo/relative/path.ts"],',
    '  "review": { "performed": true, "independent": true, "verdict": "pass", "notes": "..." },',
    '  "verification": { "commands": [{ "cmd": "pnpm test", "exitCode": 0, "summary": "..." }], "passed": true },',
    '  "proposedActions": [],',
    '  "question": "only when verdict is needs_owner_input",',
    '  "dependency": { "…": "only when verdict is waiting_on_dependency; see below" }',
    '}',
    '```',
    'Absolute paths are rejected. `question` is required for needs_owner_input and forbidden otherwise.',
    'A verdict of "implemented" is only accepted with an independent passing review and passing verification.',
    '',
    '### waiting_on_dependency',
    'Use this ONLY when the work genuinely cannot continue until something OUTSIDE this',
    'machine happens — a CI run, a package publish, an upstream merge, a person acting.',
    'It is not a way to report being stuck: if you need a decision from the owner, that',
    'is `needs_owner_input` with a question. The repository stays reserved for you while',
    'a dependency is waiting, so it is never the cheap option.',
    '',
    'Then `dependency` is required and must have exactly this shape:',
    '```json',
    '{',
    '  "type": "ci_run" | "external_service" | "package_publish" | "upstream_change" | "human_action" | "other",',
    '  "description": "what has to happen, <= 500 chars",',
    '  "externalKey": "optional opaque handle: a run id, a version, a ticket ref",',
    '  "nextCheckInSeconds": 30,',
    '  "maxChecks": 10,',
    '  "deadlineInSeconds": 3600',
    '}',
    '```',
    '`externalKey` must never be a URL to fetch and never a credential. The three numeric',
    'fields are optional and are clamped by the coordinator; every wait is bounded twice,',
    'by a check count AND by a wall clock, and nothing polls forever.',
    '',
    '**Be aware before you choose it:** no checker on this host can observe a CI run or a',
    'registry, so a dependency wait here always runs out its budget and comes back to the',
    'owner rather than resuming. Say what you are waiting for anyway — an honest wait that',
    'expires is better than a guess that looks finished.',
  ].join('\n');

  return brief.length > MAX_BRIEF_CHARS ? `${brief.slice(0, MAX_BRIEF_CHARS)}\n[brief truncated]` : brief;
}
