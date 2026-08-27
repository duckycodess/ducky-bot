import { z } from 'zod';
import { CAPTURE_MAX, CAPTURE_MIN, CONTEXT_MAX, MAX_ANSWER, SCHEDULE_MAX_ENTRIES, TASK_MAX } from './limits.js';
import { PUBLIC_JOB_ID_RE, REPO_SLUG_RE } from './ids.js';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Strips ASCII control characters (keeps \n and \t) from untrusted text. */
export const stripControl = (s: string): string => s.replace(CONTROL_CHARS, '');

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/** Order matters: remove ANSI sequences first, then any remaining control bytes. */
export const cleanUntrusted = (s: string): string => stripControl(stripAnsi(s));

const cleanText = (max: number) =>
  z.string().transform(cleanUntrusted).pipe(z.string().min(1).max(max));

export const CaptureInputSchema = z.strictObject({
  content: z.string().transform(cleanUntrusted).pipe(z.string().min(CAPTURE_MIN).max(CAPTURE_MAX)),
});
export type CaptureInput = z.infer<typeof CaptureInputSchema>;

export const RepoSlugSchema = z.string().regex(REPO_SLUG_RE, 'unknown repository');
export const PublicJobIdSchema = z.string().regex(PUBLIC_JOB_ID_RE, 'not a job id');

export const JobSubmitInputSchema = z.strictObject({
  repoSlug: RepoSlugSchema,
  task: cleanText(TASK_MAX),
  context: z.string().transform(cleanUntrusted).pipe(z.string().max(CONTEXT_MAX)).optional(),
  bootstrap: z.boolean().default(false),
});
export type JobSubmitInput = z.infer<typeof JobSubmitInputSchema>;

export const JobAnswerInputSchema = z.strictObject({
  publicId: PublicJobIdSchema,
  answer: cleanText(MAX_ANSWER),
});
export type JobAnswerInput = z.infer<typeof JobAnswerInputSchema>;

export const ScheduleEntrySchema = z.strictObject({
  title: z.string().transform(cleanUntrusted).pipe(z.string().min(1).max(200)),
  startsAt: z.string().min(1).max(64),
  endsAt: z.string().max(64).nullable(),
  location: z.string().transform(cleanUntrusted).pipe(z.string().max(200)).nullable(),
  notes: z.string().transform(cleanUntrusted).pipe(z.string().max(1000)).nullable(),
});
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

export const ScheduleDraftSchema = z.array(ScheduleEntrySchema).max(SCHEDULE_MAX_ENTRIES);
export type ScheduleDraft = z.infer<typeof ScheduleDraftSchema>;

export const CAPTURE_STATES = ['open', 'done', 'archived'] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];
