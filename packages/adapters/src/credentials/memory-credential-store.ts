import { DuckyError } from '@ducky/contracts';
import { ExecutorCredential, credentialKey, type ExecutorCredentialMeta } from './credential.js';
import { CredentialFileSchema } from './credential-file.js';
import type { ExecutorCredentialStore } from './credential-store.port.js';

/**
 * Development and test store. Refuses to construct in production so a real
 * deployment can never hold credentials in an environment variable.
 */
export class MemoryCredentialStore implements ExecutorCredentialStore {
  readonly #creds = new Map<string, ExecutorCredential>();

  constructor(json: string, nodeEnv: string | undefined = process.env['NODE_ENV']) {
    if (nodeEnv === 'production') {
      throw new DuckyError(
        'credential_unavailable',
        'Environment-provided credentials are not permitted in production; use a credential file.',
      );
    }
    const parsed = CredentialFileSchema.parse(JSON.parse(json));
    for (const e of parsed.executors) {
      if (e.state !== 'active') continue;
      const cred = new ExecutorCredential(e.executorId, e.keyId, e.bearerToken, e.hmacSecret);
      // The same entropy floor as the file store. A development credential
      // that is weak is still a credential an executor authenticates with.
      if (!cred.hasMinimumLength()) {
        throw new DuckyError(
          'credential_unavailable',
          `Credential ${e.keyId} is shorter than 32 bytes; issue a new one with executor:issue-credential.`,
        );
      }
      this.#creds.set(credentialKey(e.executorId, e.keyId), cred);
    }
  }

  get(executorId: string, keyId: string): ExecutorCredential | undefined {
    return this.#creds.get(credentialKey(executorId, keyId));
  }

  listActive(): ExecutorCredentialMeta[] {
    return [...this.#creds.values()].map((c) => ({
      executorId: c.executorId,
      keyId: c.keyId,
      bearerVerifier: c.bearerVerifier,
      hmacKeyFingerprint: c.hmacKeyFingerprint,
    }));
  }

  reloadIfChanged(): boolean {
    return false;
  }
}
