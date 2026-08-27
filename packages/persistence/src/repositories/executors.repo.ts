import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import type { ExecutorCredentialRow, ExecutorRow } from './types.js';

const mapExecutor = (r: Record<string, unknown>): ExecutorRow => ({
  id: String(r['id']),
  name: String(r['name']),
  state: String(r['state']) as 'active' | 'revoked',
  version: r['version'] == null ? null : String(r['version']),
  lastSeenAt: r['last_seen_at'] == null ? null : String(r['last_seen_at']),
});

const mapCred = (r: Record<string, unknown>): ExecutorCredentialRow => ({
  keyId: String(r['key_id']),
  executorId: String(r['executor_id']),
  bearerVerifier: String(r['bearer_verifier']),
  hmacKeyFingerprint: String(r['hmac_key_fingerprint']),
  state: String(r['state']) as 'active' | 'revoked',
  createdAt: String(r['created_at']),
  lastUsedAt: r['last_used_at'] == null ? null : String(r['last_used_at']),
  revokedAt: r['revoked_at'] == null ? null : String(r['revoked_at']),
});

/**
 * Holds no secret material. `bearer_verifier` is sha256 of a >=256-bit random
 * bearer (a fast hash is right here: the input is high-entropy, not a
 * password). `hmac_key_fingerprint` is an audit aid and cannot verify a
 * signature. Plaintext bearer/HMAC keys exist only in the runtime credential
 * store and in the executor's environment.
 */
export class ExecutorsRepo {
  constructor(private readonly db: Db) {}

  upsertExecutor(id: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO executors (id, name, state, created_at) VALUES (?,?,'active',?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      )
      .run(id, name, nowIso());
  }

  getExecutor(id: string): ExecutorRow | undefined {
    const r = this.db.prepare('SELECT * FROM executors WHERE id = ?').get(id);
    return r ? mapExecutor(r as Record<string, unknown>) : undefined;
  }

  listExecutors(): ExecutorRow[] {
    return this.db
      .prepare('SELECT * FROM executors ORDER BY id')
      .all()
      .map((r) => mapExecutor(r as Record<string, unknown>));
  }

  revokeExecutor(id: string): void {
    this.db
      .prepare(`UPDATE executors SET state = 'revoked', revoked_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  }

  touchExecutor(id: string, version: string | null): void {
    this.db
      .prepare('UPDATE executors SET last_seen_at = ?, version = COALESCE(?, version) WHERE id = ?')
      .run(nowIso(), version, id);
  }

  offlineExecutors(cutoffIso: string): ExecutorRow[] {
    return this.db
      .prepare(`SELECT * FROM executors WHERE state = 'active' AND (last_seen_at IS NULL OR last_seen_at < ?)`)
      .all(cutoffIso)
      .map((r) => mapExecutor(r as Record<string, unknown>));
  }

  // --------------------------------------------------------- credentials ----

  addCredential(row: {
    keyId: string;
    executorId: string;
    bearerVerifier: string;
    hmacKeyFingerprint: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO executor_credentials (key_id, executor_id, bearer_verifier,
           hmac_key_fingerprint, state, created_at) VALUES (?,?,?,?,'active',?)`,
      )
      .run(row.keyId, row.executorId, row.bearerVerifier, row.hmacKeyFingerprint, nowIso());
  }

  /** Exactly one row can match; a revoked key or executor yields nothing. */
  activeCredential(executorId: string, keyId: string): ExecutorCredentialRow | undefined {
    const r = this.db
      .prepare(
        `SELECT c.* FROM executor_credentials c
         JOIN executors e ON e.id = c.executor_id
         WHERE c.key_id = ? AND c.executor_id = ? AND c.state = 'active' AND e.state = 'active'`,
      )
      .get(keyId, executorId);
    return r ? mapCred(r as Record<string, unknown>) : undefined;
  }

  listCredentials(executorId?: string): ExecutorCredentialRow[] {
    const rows = executorId
      ? this.db
          .prepare('SELECT * FROM executor_credentials WHERE executor_id = ? ORDER BY created_at')
          .all(executorId)
      : this.db.prepare('SELECT * FROM executor_credentials ORDER BY executor_id, created_at').all();
    return rows.map((r) => mapCred(r as Record<string, unknown>));
  }

  revokeCredential(keyId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE executor_credentials SET state = 'revoked', revoked_at = ?
         WHERE key_id = ? AND state = 'active'`,
      )
      .run(nowIso(), keyId);
    return Number(res.changes) === 1;
  }

  touchCredential(keyId: string): void {
    this.db
      .prepare('UPDATE executor_credentials SET last_used_at = ? WHERE key_id = ?')
      .run(nowIso(), keyId);
  }

  // -------------------------------------------------------------- nonces ----

  /** Single use. A conflict is a replay. */
  consumeNonce(nonce: string, executorId: string, expiresAt: string): boolean {
    try {
      this.db
        .prepare('INSERT INTO executor_nonces (nonce, executor_id, expires_at) VALUES (?,?,?)')
        .run(nonce, executorId, expiresAt);
      return true;
    } catch {
      return false;
    }
  }

  pruneNonces(now = nowIso()): number {
    const res = this.db.prepare('DELETE FROM executor_nonces WHERE expires_at < ?').run(now);
    return Number(res.changes);
  }
}
