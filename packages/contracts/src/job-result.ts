import { z } from 'zod';
import { ProposedActionSchema } from './approval.js';
import { isRepoRelativePath } from './paths.js';
import {
  MAX_CHANGED_FILES, MAX_PATH_LEN, MAX_PROPOSED_ACTIONS, MAX_QUESTION,
  MAX_REVIEW_NOTES, MAX_SUMMARY, MAX_VERIFY_CMD, MAX_VERIFY_COMMANDS, MAX_VERIFY_SUMMARY,
} from './limits.js';

const RepoRelativePath = z
  .string()
  .max(MAX_PATH_LEN)
  .refine(isRepoRelativePath, { message: 'path must be repository-relative' });

const ReviewSchema = z.strictObject({
  performed: z.boolean(),
  independent: z.boolean(),
  verdict: z.enum(['pass', 'fail', 'skipped']),
  notes: z.string().max(MAX_REVIEW_NOTES),
});

const VerificationSchema = z.strictObject({
  commands: z
    .array(
      z.strictObject({
        cmd: z.string().min(1).max(MAX_VERIFY_CMD),
        exitCode: z.number().int(),
        summary: z.string().max(MAX_VERIFY_SUMMARY),
      }),
    )
    .max(MAX_VERIFY_COMMANDS),
  passed: z.boolean(),
});

const common = {
  schemaVersion: z.literal(1),
  summary: z.string().min(1).max(MAX_SUMMARY),
  changedFiles: z.array(RepoRelativePath).max(MAX_CHANGED_FILES),
  review: ReviewSchema,
  verification: VerificationSchema,
};

/**
 * Discriminated on `verdict` so `question` is required exactly for
 * needs_owner_input and forbidden elsewhere, and actions are only ever
 * proposed alongside an implementation.
 */
export const JobResultFileSchema = z.discriminatedUnion('verdict', [
  z.strictObject({
    ...common,
    verdict: z.literal('implemented'),
    proposedActions: z.array(ProposedActionSchema).max(MAX_PROPOSED_ACTIONS),
  }),
  z.strictObject({
    ...common,
    verdict: z.literal('needs_owner_input'),
    question: z.string().min(1).max(MAX_QUESTION),
    proposedActions: z.tuple([]),
  }),
  z.strictObject({
    ...common,
    verdict: z.literal('failed'),
    proposedActions: z.tuple([]),
  }),
]);

export type JobResultFile = z.infer<typeof JobResultFileSchema>;
export type JobResultVerdict = JobResultFile['verdict'];

/** Deterministic serialization used for the result idempotency hash. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}
