import type { ExecutorCredential, ExecutorCredentialMeta } from './credential.js';

/**
 * Runtime home of plaintext bearer/HMAC material. Nothing here is ever written
 * to SQLite; the database keeps only a verifier and a fingerprint per key id.
 *
 * The port exists so a future phase can swap in an OS keyring or Azure Key
 * Vault with no call-site changes.
 */
export interface ExecutorCredentialStore {
  /** Exactly one credential per (executorId, keyId). */
  get(executorId: string, keyId: string): ExecutorCredential | undefined;
  /** Metadata only -- never secret material. */
  listActive(): ExecutorCredentialMeta[];
  /** Returns true when the backing source changed and was reloaded. */
  reloadIfChanged(): boolean;
}
