import { describe, expect, it } from 'vitest';
import { createRedactor, redactDeep } from '../src/redaction/redact.js';

const r = createRedactor({ homeDir: '/home/tj', username: 'tj', displayName: 'Tj' });

describe('redaction', () => {
  const vectors: [string, string][] = [
    ['token ghp_abcdefghijklmnopqrstuvwxyz012345', 'github-token'],
    ['github_pat_11ABCDEFG0abcdefghijklmnop', 'github-token'],
    ['key sk-ant-api03-abcdefghijklmnopqrstuvwx', 'api-key'],
    ['key sk-abcdefghijklmnopqrstuvwxyz01', 'api-key'],
    ['slack xoxb-1234567890-abcdefghij', 'slack-token'],
    ['aws AKIAIOSFODNN7EXAMPLE', 'aws-key-id'],
    [
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'jwt',
    ],
    ['id 3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'guid'],
    ['mail someone@example.com', 'email'],
  ];

  it.each(vectors)('scrubs %s', (input, marker) => {
    expect(r(input)).toContain(`[REDACTED:${marker}]`);
  });

  it('scrubs bearer headers and private keys', () => {
    expect(r('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toContain('Bearer [REDACTED]');
    expect(
      r('-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----'),
    ).toBe('[REDACTED:private-key]');
  });

  it('scrubs secret-looking assignments but keeps the key name', () => {
    expect(r('DISCORD_TOKEN=super-secret-value')).toBe('DISCORD_TOKEN=[REDACTED]');
    expect(r('MY_API_KEY="abc123"')).toBe('MY_API_KEY=[REDACTED]');
    expect(r('LOG_LEVEL=debug')).toBe('LOG_LEVEL=debug');
  });

  it('folds the home directory and the local username', () => {
    expect(r('/home/tj/projects/ducky/src')).toBe('~/projects/ducky/src');
    expect(r('user tj ran it')).toBe('user Tj ran it');
  });

  it('strips ANSI escape sequences and control characters', () => {
    expect(r('\u001b[31mred\u001b[0m')).toBe('red');
    expect(r('a\u0000b\u0007c')).toBe('abc');
  });

  it('is idempotent', () => {
    const once = r('ghp_abcdefghijklmnopqrstuvwxyz012345 at /home/tj');
    expect(r(once)).toBe(once);
  });

  it('redacts deeply while preserving shape', () => {
    const out = redactDeep(
      { a: ['/home/tj/x', { b: 'ghp_abcdefghijklmnopqrstuvwxyz012345' }], n: 1 },
      r,
    );
    expect(out).toEqual({ a: ['~/x', { b: '[REDACTED:github-token]' }], n: 1 });
  });
});
