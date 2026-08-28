import { z } from 'zod';
import { isRepoRelativePath } from './paths.js';
import {
  MAX_ACTION_DESCRIPTION, MAX_COMMIT_MESSAGE, MAX_CHANGED_FILES,
  MAX_PATH_LEN, MAX_PR_BODY, MAX_PR_TITLE,
} from './limits.js';

export const APPROVAL_ACTION_KINDS = [
  'git_commit', 'git_push', 'github_pr', 'github_issue', 'deploy', 'azure_mutation',
] as const;
export type ApprovalActionKind = (typeof APPROVAL_ACTION_KINDS)[number];

export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** Durable execution status for an approved action. */
export const APPROVAL_EXECUTION_STATES = ['running', 'succeeded', 'failed'] as const;
export type ApprovalExecutionState = (typeof APPROVAL_EXECUTION_STATES)[number];

const RepoRelativePath = z
  .string()
  .max(MAX_PATH_LEN)
  .refine(isRepoRelativePath, { message: 'path must be repository-relative' });

const BranchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/, 'invalid branch name')
  .refine((b) => !b.includes('..') && !b.startsWith('-'), 'invalid branch name');

const desc = z.string().min(1).max(MAX_ACTION_DESCRIPTION);

/** `details` is a closed, per-kind shape. There is deliberately no open object anywhere. */
export const ProposedActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('git_commit'),
    description: desc,
    details: z.strictObject({
      message: z.string().min(1).max(MAX_COMMIT_MESSAGE),
      files: z.array(RepoRelativePath).max(MAX_CHANGED_FILES),
    }),
  }),
  z.strictObject({
    kind: z.literal('git_push'),
    description: desc,
    details: z.strictObject({ remote: z.literal('origin'), branch: BranchName }),
  }),
  z.strictObject({
    kind: z.literal('github_pr'),
    description: desc,
    details: z.strictObject({
      title: z.string().min(1).max(MAX_PR_TITLE),
      body: z.string().max(MAX_PR_BODY),
      base: BranchName,
      head: BranchName,
    }),
  }),
  z.strictObject({
    kind: z.literal('github_issue'),
    description: desc,
    details: z.strictObject({
      title: z.string().min(1).max(MAX_PR_TITLE),
      body: z.string().max(MAX_PR_BODY),
    }),
  }),
  z.strictObject({
    kind: z.literal('deploy'),
    description: desc,
    details: z.strictObject({ target: z.string().min(1).max(120) }),
  }),
  z.strictObject({
    kind: z.literal('azure_mutation'),
    description: desc,
    details: z.strictObject({ operation: z.string().min(1).max(120) }),
  }),
]);

export type ProposedAction = z.infer<typeof ProposedActionSchema>;
