import { randomUUID } from 'node:crypto';
import { redact } from '../redaction/redact.js';

/**
 * The single place this process writes a log line.
 *
 * It exists because the alternative was demonstrably leaky: eleven call sites
 * interpolated `(err as Error).message` straight into `process.stderr.write`,
 * while `redact()` sat unused two imports away. An error message is exactly
 * where a path, a URL or a token-shaped fragment shows up, so every field here
 * goes through the redactor -- there is no way to write an unredacted line
 * through this module.
 *
 * Lines are JSON so a correlation id can actually be grepped, and one event is
 * one line: a multi-line log entry cannot be filtered reliably.
 */
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A child logger that stamps every line with the same correlation id. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** `json` (default) or `text` for a readable local run. */
  readonly format?: 'json' | 'text';
  /** Receives every level. The default routes `error` to stderr. */
  readonly write?: (line: string, level: LogLevel) => void;
  readonly now?: () => Date;
  readonly base?: LogFields;
}

/** Longest single field we will emit; a log line is not a transport. */
const FIELD_MAX = 500;

/**
 * Field names whose VALUE is replaced wholesale, whatever it looks like.
 *
 * Pattern matching catches a token that has a recognisable shape. It does not
 * catch `{ authorization: 'Basic dXNlcjpwdw==' }`, a short opaque session id, or
 * a cookie jar -- and those are exactly the fields somebody logs while
 * debugging. Matching on the NAME needs no guess about the format.
 *
 * Matched as a substring of the lower-cased key, so `x-api-key`,
 * `refreshToken` and `db_password` are all covered.
 */
const SENSITIVE_KEY_PARTS = [
  'authorization',
  'auth',
  'cookie',
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'credential',
  'bearer',
  'signature',
  'privatekey',
  'session',
  'hmac',
];

/**
 * Separators are stripped before matching, so `x-api-key`, `api_key` and
 * `apiKey` are all the same name. Matching the raw string missed the hyphenated
 * form -- which is the one that actually appears in a header dump.
 */
const isSensitiveKey = (key: string): boolean => {
  const k = key.toLowerCase().replace(/[-_\s.]/g, '');
  return SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
};

/**
 * Redacts and clamps one value.
 *
 * Errors are reduced to their message deliberately: a stack trace carries
 * absolute paths and, for a wrapped error, sometimes the offending value.
 */
function safeValue(value: unknown, key?: string): unknown {
  // The name decides first. A field called `authorization` is replaced whatever
  // its value looks like -- including when it is an object or an array, so a
  // nested credential cannot be smuggled past the name check.
  if (key !== undefined && isSensitiveKey(key)) {
    return value === null || value === undefined ? value : '[REDACTED]';
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return clamp(redact(value.message));
  if (typeof value === 'string') return clamp(redact(value));
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => safeValue(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[k] = safeValue(v, k);
    }
    return out;
  }
  return clamp(redact(String(value)));
}

const clamp = (s: string): string => (s.length <= FIELD_MAX ? s : `${s.slice(0, FIELD_MAX)}…`);

/**
 * Every logger has a correlation id, whether or not the caller supplied one.
 *
 * The acceptance criterion is "every line carries a correlationId", and a
 * logger built without a base used to emit none -- which is the same as not
 * having the property, since the lines that matter during an incident are
 * exactly the ones nobody remembered to decorate. A process-scoped id is
 * generated when none is given, so a line can always be tied to at least the
 * run that produced it.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const format = opts.format ?? 'json';
  /**
   * `error` goes to stderr, everything else to stdout.
   *
   * A startup failure has to reach stderr -- that is where an operator, a
   * systemd unit and a CI step all look for it -- and routing it through the
   * logger must not quietly move it to stdout. A supplied `write` receives
   * every level, which is what tests want.
   */
  const write =
    opts.write ??
    ((line: string, level: LogLevel) => {
      if (level === 'error') process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });
  const now = opts.now ?? (() => new Date());
  const base: LogFields = {
    correlationId: newCorrelationId(),
    ...(opts.base ?? {}),
  };

  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const record: Record<string, unknown> = {
      at: now().toISOString(),
      level,
      event: clamp(redact(event)),
    };
    for (const [k, v] of Object.entries({ ...base, ...fields })) record[k] = safeValue(v, k);

    if (format === 'text') {
      const rest = Object.entries(record)
        .filter(([k]) => k !== 'at' && k !== 'level' && k !== 'event')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      write(
        `${record['level'] as string} ${record['event'] as string}${rest ? ` ${rest}` : ''}`,
        level,
      );
      return;
    }
    write(JSON.stringify(record), level);
  };

  const logger: Logger = {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
  return logger;
}

/**
 * A fresh correlation id.
 *
 * One per Discord interaction and one per HTTP request, carried onto the job
 * ids they touch, so a single job's whole life is greppable across the
 * coordinator and the executor.
 */
export const newCorrelationId = (): string => randomUUID().slice(0, 8);
