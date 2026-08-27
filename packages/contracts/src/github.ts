import { z } from 'zod';

export const GH_OWNER_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const RepoViewSchema = z.object({
  name: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable().optional(),
  isPrivate: z.boolean().optional(),
  updatedAt: z.string().optional(),
});
export type RepoView = z.infer<typeof RepoViewSchema>;

export const PrListSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    isDraft: z.boolean().optional(),
    headRefName: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
);
export type PrList = z.infer<typeof PrListSchema>;

export const PrViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  mergeable: z.string().optional(),
  reviewDecision: z.string().nullable().optional(),
});
export type PrView = z.infer<typeof PrViewSchema>;

export const PrChecksSchema = z.array(
  z.object({ name: z.string(), state: z.string().optional(), bucket: z.string().optional() }),
);
export type PrChecks = z.infer<typeof PrChecksSchema>;

export interface RepoStatusSummary {
  slug: string;
  repoName: string;
  defaultBranch: string | null;
  openPrCount: number;
  latestPr: { number: number; title: string; state: string; checks: string } | null;
}
