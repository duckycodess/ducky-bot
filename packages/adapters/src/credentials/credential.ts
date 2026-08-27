import { createHash, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import { MIN_SECRET_BYTES } from '@ducky/contracts';

export const sha256Hex = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('hex');

/** First 16 bytes of the key digest. Audit aid only: it cannot verify a signature. */
export const keyFingerprint = (secret: string): string => sha256Hex(secret).slice(0, 32);

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Decoded byte length of a base64url secret, used to enforce a minimum entropy. */
export function secretBytes(secret: string): number {
  try {
    return Buffer.from(secret, 'base64url').length;
  } catch {
    return 0;
  }
}

/**
 * Wraps plaintext credential material so an accidental log line, JSON.stringify,
 * or util.inspect can never leak it. The raw values are only reachable through
 * the explicit accessors below.
 */
export class ExecutorCredential {
  readonly executorId: string;
  readonly keyId: string;
  readonly #bearer: string;
  readonly #hmacSecret: string;

  constructor(executorId: string, keyId: string, bearer: string, hmacSecret: string) {
    this.executorId = executorId;
    this.keyId = keyId;
    this.#bearer = bearer;
    this.#hmacSecret = hmacSecret;
  }

  /** Only the auth hook and the executor client call these. */
  revealBearer(): string {
    return this.#bearer;
  }

  revealHmacSecret(): string {
    return this.#hmacSecret;
  }

  get bearerVerifier(): string {
    return sha256Hex(this.#bearer);
  }

  get hmacKeyFingerprint(): string {
    return keyFingerprint(this.#hmacSecret);
  }

  isStrongEnough(): boolean {
    return (
      secretBytes(this.#bearer) >= MIN_SECRET_BYTES &&
      secretBytes(this.#hmacSecret) >= MIN_SECRET_BYTES
    );
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }

  [inspect.custom](): string {
    return '[REDACTED]';
  }
}

export interface ExecutorCredentialMeta {
  readonly executorId: string;
  readonly keyId: string;
  readonly bearerVerifier: string;
  readonly hmacKeyFingerprint: string;
}

/** Map key for a credential. Both components are constrained to [a-z0-9-]. */
export const credentialKey = (executorId: string, keyId: string): string =>
  `${executorId}::${keyId}`;
