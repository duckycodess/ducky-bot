import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DuckyError } from '@ducky/contracts';

/**
 * The owner's own HUMAN credential, and why it is not the executor's.
 *
 * An executor credential authenticates a MACHINE: it is a long random string
 * in a file on a host the owner controls, signed per request, and it is issued
 * and revoked by a CLI. A phone is a person holding a device, typing something
 * they can remember, over a session that has to survive the screen locking.
 * The two have different threat models and different lifetimes, so they are
 * different credentials with different storage -- sharing one would mean
 * either a passcode strong enough to be an HMAC key (which nobody types) or an
 * executor credential weak enough to be memorised (which nobody should).
 *
 * What is stored is a VERIFIER, never the passcode:
 *
 *     scrypt$<salt-base64url>$<key-base64url>
 *
 * scrypt with deliberately expensive parameters, because the thing behind it
 * is short enough to be guessed if guessing were cheap. The comparison is
 * constant time. Neither the passcode nor the verifier is ever logged, written
 * to SQLite, or included in any response.
 */

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 } as const;
const SESSION_VERSION = 'v1';
/** How long a phone stays signed in. Long enough to be usable, bounded anyway. */
export const PHONE_SESSION_TTL_MS = 12 * 60 * 60_000;
export const PHONE_SESSION_COOKIE = 'ducky_phone';
export const PHONE_CSRF_HEADER = 'x-ducky-csrf';

const b64 = (b: Buffer): string => b.toString('base64url');

/** Builds the stored verifier for a passcode. Used by the operator CLI only. */
export function phonePasscodeVerifier(passcode: string): string {
  if (passcode.trim().length < 10) {
    throw new DuckyError(
      'invalid_input',
      'A phone passcode must be at least 10 characters. It is the only thing between a ' +
        'tailnet and your records.',
    );
  }
  const salt = randomBytes(16);
  const key = scryptSync(passcode.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${b64(salt)}$${b64(key)}`;
}

interface ParsedVerifier {
  readonly salt: Buffer;
  readonly key: Buffer;
}

export function parsePhoneVerifier(raw: string, variableName: string): ParsedVerifier {
  const parts = raw.trim().split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    throw new DuckyError(
      'invalid_input',
      `${variableName} must be a verifier of the form scrypt$<salt>$<key>; generate one with ` +
        '`pnpm phone:passcode`.',
    );
  }
  const salt = Buffer.from(parts[1]!, 'base64url');
  const key = Buffer.from(parts[2]!, 'base64url');
  if (salt.length < 16 || key.length !== SCRYPT.keylen) {
    throw new DuckyError('invalid_input', `${variableName} is not a usable verifier.`);
  }
  return { salt, key };
}

/** Constant time, and the only place a typed passcode is ever compared. */
export function passcodeMatches(passcode: string, verifier: ParsedVerifier): boolean {
  if (passcode === '' || passcode.length > 256) return false;
  const candidate = scryptSync(passcode.normalize('NFKC'), verifier.salt, SCRYPT.keylen, SCRYPT);
  return timingSafeEqual(candidate, verifier.key);
}

/**
 * The session signing key, derived from the verifier rather than configured
 * separately.
 *
 * One secret to deploy instead of two, and it cannot drift out of step with
 * the credential it belongs to: changing the passcode invalidates every
 * existing session by construction, which is exactly what changing a passcode
 * should do. The verifier never leaves the server, so deriving from it gives
 * away nothing.
 */
export const phoneSessionKey = (verifierRaw: string): Buffer =>
  createHmac('sha256', verifierRaw).update('ducky-phone-session-v1').digest();

const mac = (key: Buffer, payload: string): string =>
  createHmac('sha256', key).update(payload).digest('base64url');

export interface PhoneSession {
  readonly expiresAtMs: number;
  readonly nonce: string;
}

/** A stateless, bounded, signed session. No server-side table to grow or leak. */
export function issuePhoneSession(key: Buffer, nowMs: number, ttlMs = PHONE_SESSION_TTL_MS): string {
  const expiresAtMs = nowMs + ttlMs;
  const nonce = b64(randomBytes(12));
  const payload = `${SESSION_VERSION}.${expiresAtMs}.${nonce}`;
  return `${payload}.${mac(key, payload)}`;
}

export function readPhoneSession(
  key: Buffer,
  token: string | undefined,
  nowMs: number,
): PhoneSession | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 4) return undefined;
  const [version, expiresRaw, nonce, signature] = parts as [string, string, string, string];
  if (version !== SESSION_VERSION) return undefined;
  const expected = mac(key, `${version}.${expiresRaw}.${nonce}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return undefined;
  return { expiresAtMs, nonce };
}

/**
 * The CSRF token for a session, derived from its nonce.
 *
 * Double submit: the session travels in an httpOnly cookie the browser sends
 * automatically, and every state-changing request must ALSO carry this token
 * in a header. A cross-site page can make the browser send the cookie; it
 * cannot read the page that holds the token, so it cannot set the header.
 */
export const phoneCsrfToken = (key: Buffer, session: PhoneSession): string =>
  mac(key, `csrf.${session.nonce}`);

export function csrfMatches(key: Buffer, session: PhoneSession, presented: string | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(phoneCsrfToken(key, session));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * The cookie, with every flag that matters.
 *
 * `Secure` is set only when the request actually arrived over TLS. A tailnet
 * address is reached over plain HTTP inside an encrypted overlay, and a cookie
 * marked Secure there would simply never be stored -- so the page would ask
 * for the passcode again on every tap and the owner would conclude the thing
 * is broken. SameSite=Strict and httpOnly do the work either way, and the CSRF
 * token is required regardless.
 */
export function phoneSessionCookie(
  token: string,
  opts: { readonly secure: boolean; readonly maxAgeSeconds: number },
): string {
  return [
    `${PHONE_SESSION_COOKIE}=${token}`,
    'Path=/app',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${opts.maxAgeSeconds}`,
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

export const clearedPhoneSessionCookie = (): string =>
  `${PHONE_SESSION_COOKIE}=; Path=/app; HttpOnly; SameSite=Strict; Max-Age=0`;

/** Reads one cookie out of a header without trusting its shape. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 4096) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}
