import os from 'node:os';

export interface RedactorOptions {
  /** Absolute home directory to fold to `~`. */
  readonly homeDir?: string;
  /** Local account name to replace with the display name. */
  readonly username?: string;
  /** What the local account name is replaced with in owner-facing text. */
  readonly displayName?: string;
}

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, '');
export const stripControl = (s: string): string => s.replace(CONTROL, '');

/**
 * Ordered secret patterns. Each is replaced wholesale -- never partially -- so
 * a redacted string cannot be used to narrow a brute force.
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // Private key blocks first: they span lines and contain base64 that later
  // patterns would otherwise chew into unreadable fragments.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED:private-key]',
  ],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bsk-ant-[A-Za-z0-9._-]{16,}/g, '[REDACTED:api-key]'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED:api-key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key-id]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}/gi, 'Bearer [REDACTED]'],
  [/\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+\/=]{40,}/g, '[REDACTED:ssh-key]'],
  // Azure/AD identifiers and any other bare GUID.
  [
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    '[REDACTED:guid]',
  ],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED:email]'],
];

/** KEY=VALUE where the key itself looks like a credential. */
const SECRETISH_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|BEARER)[A-Z0-9_]*)\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g;

export type Redactor = (input: unknown) => string;

export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const homeDir = opts.homeDir ?? os.homedir();
  const username = opts.username ?? safeUsername();
  const displayName = opts.displayName ?? 'Tj';

  return function redactOne(input: unknown): string {
    let s = typeof input === 'string' ? input : String(input ?? '');
    s = stripControl(stripAnsi(s));

    for (const [re, repl] of SECRET_PATTERNS) s = s.replace(re, repl);
    s = s.replace(SECRETISH_ASSIGNMENT, (_m, k: string) => `${k}=[REDACTED]`);

    // Fold host paths before the bare username, since the path contains it.
    if (homeDir && homeDir !== '/') s = s.split(homeDir).join('~');
    if (username && username.length >= 2) {
      s = s.replace(new RegExp(`\\b${escapeRe(username)}\\b`, 'g'), displayName);
    }
    return s;
  };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function safeUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/** Process-wide default redactor. */
export const redact: Redactor = createRedactor();

/** Deep-redacts every string in a structure, preserving shape. */
export function redactDeep<T>(value: T, r: Redactor = redact): T {
  if (typeof value === 'string') return r(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, r)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, r);
    return out as T;
  }
  return value;
}
