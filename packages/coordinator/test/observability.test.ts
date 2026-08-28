import { describe, expect, it } from 'vitest';
import { createLogger, newCorrelationId } from '@ducky/adapters';

/**
 * Logging as an EGRESS surface.
 *
 * Eleven call sites used to interpolate `(err as Error).message` straight into
 * `process.stderr.write` while `redact()` sat unused two imports away. An error
 * message is precisely where a path, a URL or a token-shaped fragment turns up,
 * so the guarantee has to be structural: there is no way to emit an unredacted
 * field through this module.
 */
const capture = () => {
  const lines: string[] = [];
  return { lines, log: createLogger({ write: (l) => lines.push(l) }) };
};

const parsed = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

describe('the logger', () => {
  it('emits one JSON object per line', () => {
    const { lines, log } = capture();
    log.info('job.claimed', { jobId: 'j1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(parsed(lines[0]!)['event']).toBe('job.claimed');
    expect(parsed(lines[0]!)['level']).toBe('info');
    expect(parsed(lines[0]!)['at']).toEqual(expect.any(String));
  });

  it('redacts a secret hidden in an Error message', () => {
    const { lines, log } = capture();
    log.error('herdr.failed', { err: new Error('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected') });
    expect(lines[0]).not.toContain('ghp_abcdefghij');
    expect(lines[0]).toContain('[REDACTED');
  });

  it('redacts a secret in a plain string field', () => {
    const { lines, log } = capture();
    log.warn('x', { detail: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' });
    expect(lines[0]).not.toContain('abcdefghijklmnop');
  });

  it('redacts nested fields too, so a whole object cannot smuggle one', () => {
    const { lines, log } = capture();
    log.info('x', { ctx: { inner: { key: 'sk-abcdefghijklmnopqrstuvwxyz' } } });
    expect(lines[0]).not.toContain('sk-abcdefghijkl');
  });

  it('folds a host home directory to ~', () => {
    const { lines, log } = capture();
    log.info('x', { path: `${process.env['HOME'] ?? '/home/nobody'}/projects/thing` });
    expect(lines[0]).toContain('~/projects/thing');
  });

  it('never emits a stack trace, which carries absolute paths', () => {
    const { lines, log } = capture();
    const err = new Error('boom');
    log.error('x', { err });
    expect(lines[0]).not.toContain('at ');
    expect(lines[0]).toContain('boom');
  });

  it('clamps an enormous field rather than writing a transcript', () => {
    const { lines, log } = capture();
    log.info('x', { blob: 'a'.repeat(50_000) });
    expect(lines[0]!.length).toBeLessThan(2_000);
  });

  it('redacts the event name as well, so a caller cannot bypass it there', () => {
    const { lines, log } = capture();
    log.info('failed for ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(lines[0]).not.toContain('ghp_abcdefghij');
  });

  it('stamps a correlation id on every line from a child logger', () => {
    const { lines, log } = capture();
    const cid = newCorrelationId();
    const child = log.child({ correlationId: cid });
    child.info('a');
    child.info('b');
    expect(lines.every((l) => parsed(l)['correlationId'] === cid)).toBe(true);
  });

  it('gives a distinct correlation id each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCorrelationId()));
    expect(ids.size).toBe(50);
  });

  it('has a readable text mode that is still redacted', () => {
    const lines: string[] = [];
    const log = createLogger({ format: 'text', write: (l) => lines.push(l) });
    log.error('boot.failed', { err: new Error('key sk-abcdefghijklmnopqrstuvwxyz') });
    expect(lines[0]).toContain('error boot.failed');
    expect(lines[0]).not.toContain('sk-abcdefghijkl');
  });
});

/**
 * The acceptance criterion is "every line carries a correlationId".
 *
 * A logger built with no base used to emit none — and the lines that matter
 * during an incident are exactly the ones nobody remembered to decorate. So the
 * id is generated when the caller does not supply one.
 */
describe('the correlationId guarantee', () => {
  it('is present on a logger created with no options at all', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.info('bare');
    expect(parsed(lines[0]!)['correlationId']).toEqual(expect.any(String));
    expect(String(parsed(lines[0]!)['correlationId'])).not.toBe('');
  });

  it('a caller-supplied id wins over the generated one', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), base: { correlationId: 'abc123' } });
    log.info('x');
    expect(parsed(lines[0]!)['correlationId']).toBe('abc123');
  });

  it('a child keeps the parent id rather than minting a new one', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), base: { correlationId: 'parent1' } });
    log.child({ jobId: 'j1' }).info('x');
    expect(parsed(lines[0]!)['correlationId']).toBe('parent1');
    expect(parsed(lines[0]!)['jobId']).toBe('j1');
  });

  it('every level carries it', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.info('a');
    log.warn('b');
    log.error('c');
    expect(lines.every((l) => typeof parsed(l)['correlationId'] === 'string')).toBe(true);
  });
});

/**
 * Key-aware redaction.
 *
 * Pattern matching catches a token with a recognisable shape. It does not catch
 * `Basic dXNlcjpwdw==`, a short opaque session id, or a cookie jar — and those
 * are exactly the fields somebody logs while debugging.
 */
describe('sensitive field names', () => {
  const capture2 = () => {
    const lines: string[] = [];
    return { lines, log: createLogger({ write: (l) => lines.push(l) }) };
  };

  for (const key of [
    'authorization', 'Authorization', 'cookie', 'setCookie', 'token', 'refreshToken',
    'accessToken', 'secret', 'clientSecret', 'password', 'passwd', 'apiKey', 'api_key',
    'x-api-key', 'credential', 'bearer', 'signature', 'privateKey', 'sessionId', 'hmacSecret',
  ]) {
    it(`replaces the value of \`${key}\` whatever it looks like`, () => {
      const { lines, log } = capture2();
      log.info('req', { [key]: 'dXNlcjpwYXNzd29yZA==' });
      expect(lines[0]).not.toContain('dXNlcjpwYXNzd29yZA');
      expect(parsed(lines[0]!)[key]).toBe('[REDACTED]');
    });
  }

  it('redacts a sensitive field nested inside an object', () => {
    const { lines, log } = capture2();
    log.info('req', { headers: { authorization: 'Basic abc', accept: 'application/json' } });
    expect(lines[0]).not.toContain('Basic abc');
    // And leaves the harmless neighbour alone, so the line is still useful.
    expect(lines[0]).toContain('application/json');
  });

  it('replaces a sensitive field even when its value is an OBJECT', () => {
    // Otherwise a credential could be smuggled past the name check by wrapping.
    const { lines, log } = capture2();
    log.info('x', { token: { value: 'sensitive-inner', kind: 'bearer' } });
    expect(lines[0]).not.toContain('sensitive-inner');
    expect(parsed(lines[0]!)['token']).toBe('[REDACTED]');
  });

  it('replaces a sensitive field whose value is an array', () => {
    const { lines, log } = capture2();
    log.info('x', { cookies: ['a=1', 'b=2'] });
    expect(lines[0]).not.toContain('a=1');
  });

  it('keeps null and undefined distinguishable rather than inventing a value', () => {
    const { lines, log } = capture2();
    log.info('x', { token: null });
    expect(parsed(lines[0]!)['token']).toBeNull();
  });

  it('does not clobber innocent fields that merely look adjacent', () => {
    const { lines, log } = capture2();
    log.info('x', { jobId: 'j1', repoSlug: 'demo', correlationId: 'c1', phase: 'reviewing' });
    const r = parsed(lines[0]!);
    expect(r['jobId']).toBe('j1');
    expect(r['repoSlug']).toBe('demo');
    expect(r['phase']).toBe('reviewing');
  });
});

/**
 * The startup-failure line.
 *
 * Both processes used to hand-build a JSON line for it with no `correlationId`
 * — and that line is the one most likely to be the only one a collector ever
 * sees, so it was exactly the wrong exception to make. It now goes through the
 * real logger, which means it is redacted and correlated by the same code as
 * every other line.
 */
describe('boot-phase logging', () => {
  it('carries a correlationId on a logger built before any config is read', () => {
    const lines: string[] = [];
    // Mirrors how both mains construct their boot logger: no app, no env schema.
    const bootLog = createLogger({
      write: (l) => lines.push(l),
      base: { component: 'coordinator', phase: 'boot' },
    });
    bootLog.error('coordinator.start_failed', { err: new Error('OWNER_DISCORD_USER_ID required') });

    const r = parsed(lines[0]!);
    expect(r['correlationId']).toEqual(expect.any(String));
    expect(r['component']).toBe('coordinator');
    expect(r['phase']).toBe('boot');
    expect(r['level']).toBe('error');
    expect(String(r['err'])).toContain('OWNER_DISCORD_USER_ID');
  });

  it('redacts a config value quoted by a startup error', () => {
    const lines: string[] = [];
    const bootLog = createLogger({ write: (l) => lines.push(l) });
    bootLog.error('start_failed', {
      err: new Error('bad token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in DISCORD_DEV_TOKEN'),
    });
    expect(lines[0]).not.toContain('ghp_abcdefghij');
    expect(lines[0]).toContain('[REDACTED');
  });

  it('a child keeps the boot correlation id, so one run is one id', () => {
    const lines: string[] = [];
    const bootLog = createLogger({ write: (l) => lines.push(l), base: { phase: 'boot' } });
    bootLog.info('booting');
    bootLog.child({ phase: 'running' }).info('listening');

    const [a, b] = lines.map((l) => parsed(l));
    expect(a!['correlationId']).toBe(b!['correlationId']);
    expect(a!['phase']).toBe('boot');
    expect(b!['phase']).toBe('running');
  });

  it('routes error to stderr and everything else to stdout by default', () => {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (s: string) => { outLines.push(s); return true; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (s: string) => { errLines.push(s); return true; };
    try {
      const log = createLogger({});
      log.info('up');
      log.warn('hmm');
      log.error('down');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = realOut;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = realErr;
    }
    // A startup failure has to reach stderr; routing it through the logger must
    // not quietly move it to stdout.
    expect(errLines.join('')).toContain('"event":"down"');
    expect(outLines.join('')).toContain('"event":"up"');
    expect(outLines.join('')).not.toContain('"event":"down"');
  });
});
