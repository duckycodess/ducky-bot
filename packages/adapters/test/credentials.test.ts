import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, createHmac } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ExecutorCredential, sha256Hex, keyFingerprint, constantTimeEquals } from '../src/credentials/credential.js';
import { FileCredentialStore } from '../src/credentials/file-credential-store.js';
import { MemoryCredentialStore } from '../src/credentials/memory-credential-store.js';

const secret = (): string => randomBytes(32).toString('base64url');

function writeCredFile(entries: unknown[], mode = 0o600): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ducky-cred-'));
  const file = path.join(dir, 'creds.json');
  writeFileSync(file, JSON.stringify({ version: 1, executors: entries }), { mode });
  chmodSync(file, mode);
  return file;
}

const entry = (executorId: string, keyId: string) => ({
  executorId,
  keyId,
  bearerToken: secret(),
  hmacSecret: secret(),
  state: 'active' as const,
});

describe('executor credential material', () => {
  it('never serialises the plaintext secrets', () => {
    const c = new ExecutorCredential('exec-a', 'k1', secret(), secret());
    expect(JSON.stringify({ c })).toBe('{"c":"[REDACTED]"}');
    expect(String(c)).toBe('[REDACTED]');
    expect(inspect(c)).toBe('[REDACTED]');
    expect(`${c}`).not.toContain('=');
  });

  it('derives a verifier and a fingerprint that cannot authenticate', () => {
    const bearer = secret();
    const hmac = secret();
    const c = new ExecutorCredential('exec-a', 'k1', bearer, hmac);
    expect(c.bearerVerifier).toBe(sha256Hex(bearer));
    expect(c.hmacKeyFingerprint).toBe(keyFingerprint(hmac));
    // The fingerprint is half a digest; signing with it produces nothing usable.
    const real = createHmac('sha256', hmac).update('x').digest('base64url');
    const fake = createHmac('sha256', c.hmacKeyFingerprint).update('x').digest('base64url');
    expect(constantTimeEquals(real, fake)).toBe(false);
  });

  it('enforces a minimum decoded length, and is honest that it is only that', () => {
    expect(new ExecutorCredential('e', 'k', 'short', 'short').hasMinimumLength()).toBe(false);
    expect(new ExecutorCredential('e', 'k', secret(), secret()).hasMinimumLength()).toBe(true);
    // A length floor cannot detect a non-random value of the right size; the
    // guarantee comes from issue-credential always using a CSPRNG.
    const repeated = 'x'.repeat(43);
    expect(new ExecutorCredential('e', 'k', repeated, repeated).hasMinimumLength()).toBe(true);
  });
});

describe('FileCredentialStore', () => {
  it('loads two active credentials for one executor', () => {
    const file = writeCredFile([entry('exec-a', 'k1'), entry('exec-a', 'k2')]);
    const store = new FileCredentialStore(file);
    expect(store.get('exec-a', 'k1')).toBeDefined();
    expect(store.get('exec-a', 'k2')).toBeDefined();
    expect(store.listActive()).toHaveLength(2);
    // metadata only
    expect(JSON.stringify(store.listActive())).not.toContain('bearerToken');
  });

  it('skips revoked entries', () => {
    const file = writeCredFile([{ ...entry('exec-a', 'k1'), state: 'revoked' }]);
    expect(new FileCredentialStore(file).get('exec-a', 'k1')).toBeUndefined();
  });

  it('refuses a group- or world-readable file', () => {
    const file = writeCredFile([entry('exec-a', 'k1')], 0o644);
    expect(() => new FileCredentialStore(file)).toThrow(/chmod 600/);
  });

  it('refuses a symlink', () => {
    const real = writeCredFile([entry('exec-a', 'k1')]);
    const link = path.join(path.dirname(real), 'link.json');
    symlinkSync(real, link);
    expect(() => new FileCredentialStore(link)).toThrow(/symlink/);
  });

  it('refuses a secret shorter than 32 decoded bytes', () => {
    const file = writeCredFile([
      { executorId: 'exec-a', keyId: 'k1', bearerToken: 'x'.repeat(20), hmacSecret: 'y'.repeat(20), state: 'active' },
    ]);
    // Rejected by the schema length bound before it can even be constructed.
    expect(() => new FileCredentialStore(file)).toThrow();
  });

  it('reloads when the file changes', async () => {
    const file = writeCredFile([entry('exec-a', 'k1')]);
    const store = new FileCredentialStore(file);
    expect(store.reloadIfChanged()).toBe(false);
    await new Promise((r) => setTimeout(r, 12));
    writeFileSync(file, JSON.stringify({ version: 1, executors: [entry('exec-a', 'k1'), entry('exec-a', 'k9')] }), { mode: 0o600 });
    expect(store.reloadIfChanged()).toBe(true);
    expect(store.get('exec-a', 'k9')).toBeDefined();
  });
});

describe('MemoryCredentialStore', () => {
  it('applies the same length floor as the file store', () => {
    const weak = JSON.stringify({
      version: 1,
      executors: [
        { executorId: 'exec-a', keyId: 'k1', bearerToken: 'x'.repeat(20), hmacSecret: 'y'.repeat(20), state: 'active' },
      ],
    });
    expect(() => new MemoryCredentialStore(weak, 'test')).toThrow();
  });

  it('works outside production', () => {
    const json = JSON.stringify({ version: 1, executors: [entry('exec-a', 'k1')] });
    expect(new MemoryCredentialStore(json, 'test').get('exec-a', 'k1')).toBeDefined();
  });

  it('refuses to construct in production', () => {
    const json = JSON.stringify({ version: 1, executors: [entry('exec-a', 'k1')] });
    expect(() => new MemoryCredentialStore(json, 'production')).toThrow(/not permitted in production/);
  });
});
