import { z } from 'zod';
import { EXECUTOR_ID_RE, KEY_ID_RE } from '@ducky/contracts';

export const CredentialFileEntrySchema = z.strictObject({
  executorId: z.string().regex(EXECUTOR_ID_RE),
  keyId: z.string().regex(KEY_ID_RE),
  name: z.string().max(120).optional(),
  bearerToken: z.string().min(16).max(512),
  hmacSecret: z.string().min(16).max(512),
  state: z.enum(['active', 'revoked']).default('active'),
});

export const CredentialFileSchema = z.strictObject({
  version: z.literal(1),
  executors: z.array(CredentialFileEntrySchema).max(64),
});

export type CredentialFile = z.infer<typeof CredentialFileSchema>;
export type CredentialFileEntry = z.infer<typeof CredentialFileEntrySchema>;
