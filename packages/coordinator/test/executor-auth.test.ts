import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXECUTOR_HEADERS, canonicalRequest } from '@ducky/contracts';
import { MemoryCredentialStore, keyFingerprint, sha256Hex } from '@ducky/adapters';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { verifyExecutorRequest } from '../src/security/executor-auth.js';

const secret = () => randomBytes(32).toString('base64url');

interface Key {
  keyId: string;
  bearer: string;
  hmac: string;
}

function setup(keys: Key[], executorId = 'exec-a') {
  const db = openDatabase({ location: ':memory:' });
  runMigrations(db);
  const store = createStore(db);
  store.executors.upsertExecutor(executorId, 'test');
  for (const k of keys) {
    store.executors.addCredential({
      executorId,
      keyId: k.keyId,
      bearerVerifier: sha256Hex(k.bearer),
      hmacKeyFingerprint: keyFingerprint(k.hmac),
    });
  }
  const credentialStore = new MemoryCredentialStore(
    JSON.stringify({
      version: 1,
      executors: keys.map((k) => ({
        executorId,
        keyId: k.keyId,
        bearerToken: k.bearer,
        hmacSecret: k.hmac,
        state: 'active',
      })),
    }),
    'test',
  );
  return { db, store, credentialStore, executorId };
}

const newKey = (keyId: string): Key => ({ keyId, bearer: secret(), hmac: secret() });

function signed(
  key: Key,
  executorId: string,
  over: { body?: string; path?: string; timestamp?: string; nonce?: string; bearer?: string } = {},
) {
  const body = over.body ?? '{"a":1}';
  const requestPath = over.path ?? '/api/v1/executor/heartbeat';
  const timestamp = over.timestamp ?? new Date().toISOString();
  const nonce = over.nonce ?? randomBytes(16).toString('base64url');
  const signature = createHmac('sha256', key.hmac)
    .update(
      canonicalRequest({
        method: 'POST',
        path: requestPath,
        timestamp,
        nonce,
        bodySha256Hex: createHash('sha256').update(Buffer.from(body)).digest('hex'),
      }),
    )
    .digest('base64url');
  return {
    method: 'POST',
    path: requestPath,
    rawBody: Buffer.from(body),
    headers: {
      authorization: `Bearer ${over.bearer ?? key.bearer}`,
      [EXECUTOR_HEADERS.executorId]: executorId,
      [EXECUTOR_HEADERS.keyId]: key.keyId,
      [EXECUTOR_HEADERS.timestamp]: timestamp,
      [EXECUTOR_HEADERS.nonce]: nonce,
      [EXECUTOR_HEADERS.signature]: signature,
    } as Record<string, string>,
  };
}

describe('executor request verification', () => {
  it('accepts a correctly signed request and records the key use', () => {
    const k = newKey('k1');
    const { store, credentialStore, executorId } = setup([k]);
    const verified = verifyExecutorRequest(signed(k, executorId), { store: credentialStore, executors: store.executors });
    expect(verified).toEqual({ executorId, keyId: 'k1' });
    expect(store.executors.listCredentials(executorId)[0]?.lastUsedAt).not.toBeNull();
  });

  it('rejects a wrong bearer, tampered body, tampered path and skewed clock generically', () => {
    const k = newKey('k1');
    const { store, credentialStore, executorId } = setup([k]);
    const deps = { store: credentialStore, executors: store.executors };

    expect(() => verifyExecutorRequest(signed(k, executorId, { bearer: secret() }), deps)).toThrow(
      /not authorized/i,
    );

    const tamperedBody = signed(k, executorId);
    expect(() =>
      verifyExecutorRequest({ ...tamperedBody, rawBody: Buffer.from('{"a":2}') }, deps),
    ).toThrow(/not authorized/i);

    const tamperedPath = signed(k, executorId);
    expect(() =>
      verifyExecutorRequest({ ...tamperedPath, path: '/api/v1/executor/claim' }, deps),
    ).toThrow(/not authorized/i);

    expect(() =>
      verifyExecutorRequest(
        signed(k, executorId, { timestamp: new Date(Date.now() - 10 * 60_000).toISOString() }),
        deps,
      ),
    ).toThrow(/not authorized/i);
  });

  it('does not consume a nonce when the signature is invalid', () => {
    const k = newKey('k1');
    const { store, credentialStore, executorId } = setup([k]);
    const deps = { store: credentialStore, executors: store.executors };
    const req = signed(k, executorId);
    const nonce = req.headers[EXECUTOR_HEADERS.nonce]!;

    expect(() => verifyExecutorRequest({ ...req, rawBody: Buffer.from('{"a":9}') }, deps)).toThrow();
    // the same nonce is still spendable by a genuine request
    expect(store.executors.consumeNonce(nonce, executorId, '2099-01-01T00:00:00.000Z')).toBe(true);
  });

  it('treats a replayed nonce as a replay, not an auth failure', () => {
    const k = newKey('k1');
    const { store, credentialStore, executorId } = setup([k]);
    const deps = { store: credentialStore, executors: store.executors };
    const req = signed(k, executorId);
    verifyExecutorRequest(req, deps);
    expect(() => verifyExecutorRequest(req, deps)).toThrow(/replay/i);
  });

  it('rejects malformed executor and key ids before any lookup', () => {
    const k = newKey('k1');
    const { store, credentialStore, executorId } = setup([k]);
    const deps = { store: credentialStore, executors: store.executors };
    for (const bad of ['../etc', 'UPPER', 'a'.repeat(64), '']) {
      const req = signed(k, executorId);
      req.headers[EXECUTOR_HEADERS.keyId] = bad;
      expect(() => verifyExecutorRequest(req, deps), bad).toThrow(/not authorized/i);
    }
  });
});

describe('zero-downtime credential rotation', () => {
  it('authenticates two active keys simultaneously', () => {
    const k1 = newKey('k1');
    const k2 = newKey('k2');
    const { store, credentialStore, executorId } = setup([k1, k2]);
    const deps = { store: credentialStore, executors: store.executors };
    expect(verifyExecutorRequest(signed(k1, executorId), deps).keyId).toBe('k1');
    expect(verifyExecutorRequest(signed(k2, executorId), deps).keyId).toBe('k2');
  });

  it('revoking one key leaves the other working', () => {
    const k1 = newKey('k1');
    const k2 = newKey('k2');
    const { store, credentialStore, executorId } = setup([k1, k2]);
    const deps = { store: credentialStore, executors: store.executors };
    expect(store.executors.revokeCredential('k1')).toBe(true);
    expect(() => verifyExecutorRequest(signed(k1, executorId), deps)).toThrow(/not authorized/i);
    expect(verifyExecutorRequest(signed(k2, executorId), deps).keyId).toBe('k2');
  });

  it('revoking the executor refuses every one of its keys immediately', () => {
    const k1 = newKey('k1');
    const k2 = newKey('k2');
    const { store, credentialStore, executorId } = setup([k1, k2]);
    const deps = { store: credentialStore, executors: store.executors };
    store.executors.revokeExecutor(executorId);
    expect(() => verifyExecutorRequest(signed(k1, executorId), deps)).toThrow(/not authorized/i);
    expect(() => verifyExecutorRequest(signed(k2, executorId), deps)).toThrow(/not authorized/i);
  });

  it('requires BOTH the database row and the runtime store', () => {
    const k1 = newKey('k1');
    const k2 = newKey('k2');
    // database knows k1 and k2; the runtime store only holds k1
    const { store, executorId } = setup([k1, k2]);
    const partial = new MemoryCredentialStore(
      JSON.stringify({
        version: 1,
        executors: [{ executorId, keyId: 'k1', bearerToken: k1.bearer, hmacSecret: k1.hmac, state: 'active' }],
      }),
      'test',
    );
    const deps = { store: partial, executors: store.executors };
    expect(verifyExecutorRequest(signed(k1, executorId), deps).keyId).toBe('k1');
    expect(() => verifyExecutorRequest(signed(k2, executorId), deps)).toThrow(/not authorized/i);
  });
});
