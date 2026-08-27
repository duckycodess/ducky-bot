import { createHash, createHmac } from 'node:crypto';
import {
  CLOCK_SKEW_MS, DuckyError, EXECUTOR_HEADERS, EXECUTOR_ID_RE, KEY_ID_RE, NONCE_TTL_MS,
  canonicalRequest, unauthorized,
} from '@ducky/contracts';
import { constantTimeEquals, sha256Hex, type ExecutorCredentialStore } from '@ducky/adapters';
import type { ExecutorsRepo } from '@ducky/persistence';

export interface VerifyInput {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: Buffer;
}

export interface VerifiedExecutor {
  readonly executorId: string;
  readonly keyId: string;
}

const header = (h: VerifyInput['headers'], name: string): string => {
  const v = h[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return typeof v === 'string' ? v : '';
};

/**
 * Verification order matters.
 *
 * Identity and signature are checked BEFORE the nonce is consumed, so
 * unauthenticated traffic cannot burn nonces. Both the database row and the
 * runtime credential store must agree, which gives two independent revocation
 * surfaces: revoking the row takes effect immediately, removing the file entry
 * takes effect at the next reload.
 *
 * Every failure returns the same generic error; nothing distinguishes an
 * unknown executor from a bad signature.
 */
export function verifyExecutorRequest(
  input: VerifyInput,
  deps: { store: ExecutorCredentialStore; executors: ExecutorsRepo; now?: () => number },
): VerifiedExecutor {
  const now = deps.now ?? Date.now;

  const executorId = header(input.headers, EXECUTOR_HEADERS.executorId);
  const keyId = header(input.headers, EXECUTOR_HEADERS.keyId);
  const timestamp = header(input.headers, EXECUTOR_HEADERS.timestamp);
  const nonce = header(input.headers, EXECUTOR_HEADERS.nonce);
  const signature = header(input.headers, EXECUTOR_HEADERS.signature);
  const authorization = header(input.headers, 'authorization');

  // Both ids are attacker-controlled: constrain them before any query.
  if (!EXECUTOR_ID_RE.test(executorId) || !KEY_ID_RE.test(keyId)) throw unauthorized();
  if (!timestamp || !nonce || !signature) throw unauthorized();
  if (nonce.length < 16 || nonce.length > 128) throw unauthorized();
  if (!authorization.startsWith('Bearer ')) throw unauthorized();
  const bearer = authorization.slice('Bearer '.length);
  if (bearer.length < 16) throw unauthorized();

  const row = deps.executors.activeCredential(executorId, keyId);
  if (!row) throw unauthorized();

  const credential = deps.store.get(executorId, keyId);
  if (!credential) throw unauthorized();

  if (!constantTimeEquals(sha256Hex(bearer), row.bearerVerifier)) throw unauthorized();

  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now() - ts) > CLOCK_SKEW_MS) throw unauthorized();

  const expected = createHmac('sha256', credential.revealHmacSecret())
    .update(
      canonicalRequest({
        method: input.method,
        path: input.path,
        timestamp,
        nonce,
        bodySha256Hex: createHash('sha256').update(input.rawBody).digest('hex'),
      }),
    )
    .digest('base64url');
  if (!constantTimeEquals(expected, signature)) throw unauthorized();

  // Authenticated: only now is it safe to spend the nonce.
  const fresh = deps.executors.consumeNonce(
    nonce,
    executorId,
    new Date(now() + NONCE_TTL_MS).toISOString(),
  );
  if (!fresh) throw new DuckyError('replay_detected', 'Request replay detected.');

  deps.executors.touchCredential(keyId);
  return { executorId, keyId };
}

/** Client-side signing, shared with the executor so both sides agree byte for byte. */
export function signExecutorRequest(input: {
  method: string;
  path: string;
  body: string;
  timestamp: string;
  nonce: string;
  hmacSecret: string;
}): string {
  return createHmac('sha256', input.hmacSecret)
    .update(
      canonicalRequest({
        method: input.method,
        path: input.path,
        timestamp: input.timestamp,
        nonce: input.nonce,
        bodySha256Hex: createHash('sha256').update(Buffer.from(input.body, 'utf8')).digest('hex'),
      }),
    )
    .digest('base64url');
}
