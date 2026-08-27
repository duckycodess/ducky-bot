import { lstatSync, readFileSync, statSync } from 'node:fs';
import { DuckyError } from '@ducky/contracts';
import { ExecutorCredential, credentialKey, type ExecutorCredentialMeta } from './credential.js';
import { CredentialFileSchema } from './credential-file.js';
import type { ExecutorCredentialStore } from './credential-store.port.js';

/**
 * Reads a 0600 JSON file. Refuses to load a file that any other account could
 * read, that is owned by another uid, or that is a symlink -- a credential file
 * with loose permissions is a finding, not something to work around.
 */
export class FileCredentialStore implements ExecutorCredentialStore {
  #creds = new Map<string, ExecutorCredential>();
  #mtimeMs = -1;

  constructor(private readonly path: string) {
    this.load();
  }

  private assertSafePermissions(): void {
    const l = lstatSync(this.path);
    if (l.isSymbolicLink()) {
      throw new DuckyError('credential_unavailable', 'The credential file must not be a symlink.');
    }
    const s = statSync(this.path);
    if ((s.mode & 0o077) !== 0) {
      throw new DuckyError(
        'credential_unavailable',
        'The credential file must not be readable by group or others (chmod 600).',
      );
    }
    if (typeof process.getuid === 'function' && s.uid !== process.getuid()) {
      throw new DuckyError(
        'credential_unavailable',
        'The credential file is owned by another user.',
      );
    }
  }

  private load(): void {
    this.assertSafePermissions();
    const parsed = CredentialFileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    const next = new Map<string, ExecutorCredential>();
    for (const e of parsed.executors) {
      if (e.state !== 'active') continue;
      const cred = new ExecutorCredential(e.executorId, e.keyId, e.bearerToken, e.hmacSecret);
      if (!cred.isStrongEnough()) {
        throw new DuckyError(
          'credential_unavailable',
          `Credential ${e.keyId} has insufficient entropy; issue a new one.`,
        );
      }
      next.set(credentialKey(e.executorId, e.keyId), cred);
    }
    this.#creds = next;
    this.#mtimeMs = statSync(this.path).mtimeMs;
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
    let mtime: number;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch {
      return false;
    }
    if (mtime === this.#mtimeMs) return false;
    this.load();
    return true;
  }
}
