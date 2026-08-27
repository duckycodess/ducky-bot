import { readdirSync } from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { BINARY_REJECTION_MESSAGE } from '@ducky/adapters';
import { TEMP_PREFIX, fetchTextAttachment } from '../src/discord/attachments.js';

const hosts = ['cdn.discordapp.com', 'media.discordapp.net'];
const base = {
  filename: 'sched.csv',
  contentType: 'text/csv',
  size: 40,
  url: 'https://cdn.discordapp.com/attachments/1/2/sched.csv',
};

const tempDirs = (): string[] => readdirSync(os.tmpdir()).filter((d) => d.startsWith(TEMP_PREFIX));

const okFetch = (body: string): typeof fetch =>
  (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

describe('attachment download', () => {
  it('reads a small text attachment and leaves no temp directory behind', async () => {
    const before = tempDirs().length;
    const { text } = await fetchTextAttachment(base, {
      binaryExtractionEnabled: false,
      allowedHosts: hosts,
      fetchImpl: okFetch('title,start\nStandup,2026-09-01 09:00\n'),
    });
    expect(text).toContain('Standup');
    expect(tempDirs().length).toBe(before);
  });

  it('refuses images and PDFs without making any request', async () => {
    let called = 0;
    const spy = (async () => {
      called += 1;
      return new Response('x');
    }) as unknown as typeof fetch;

    for (const contentType of ['image/png', 'application/pdf']) {
      await expect(
        fetchTextAttachment(
          { ...base, contentType },
          { binaryExtractionEnabled: false, allowedHosts: hosts, fetchImpl: spy },
        ),
      ).rejects.toThrow(BINARY_REJECTION_MESSAGE);
    }
    expect(called).toBe(0);
  });

  it('refuses an oversize attachment before requesting it', async () => {
    let called = 0;
    const spy = (async () => {
      called += 1;
      return new Response('x');
    }) as unknown as typeof fetch;
    await expect(
      fetchTextAttachment(
        { ...base, size: 99_999_999 },
        { binaryExtractionEnabled: false, allowedHosts: hosts, fetchImpl: spy },
      ),
    ).rejects.toThrow(/too large/);
    expect(called).toBe(0);
  });

  it('aborts mid-stream when the reported size was a lie', async () => {
    const big = 'a'.repeat(5000);
    await expect(
      fetchTextAttachment(base, {
        binaryExtractionEnabled: false,
        allowedHosts: hosts,
        maxBytes: 100,
        fetchImpl: okFetch(big),
      }),
    ).rejects.toThrow(/larger than the limit/);
  });

  it('rejects a non-Discord host and plain HTTP', async () => {
    for (const url of ['https://evil.tld/x.csv', 'http://cdn.discordapp.com/x.csv']) {
      await expect(
        fetchTextAttachment(
          { ...base, url },
          { binaryExtractionEnabled: false, allowedHosts: hosts, fetchImpl: okFetch('a') },
        ),
      ).rejects.toThrow();
    }
  });

  it('never follows a redirect', async () => {
    let seenInit: RequestInit | undefined;
    const spy = (async (_u: unknown, init: RequestInit) => {
      seenInit = init;
      return new Response('title,start\na,2026-09-01\n');
    }) as unknown as typeof fetch;
    await fetchTextAttachment(base, {
      binaryExtractionEnabled: false,
      allowedHosts: hosts,
      fetchImpl: spy,
    });
    expect(seenInit?.redirect).toBe('error');
    expect((seenInit?.headers as Record<string, string>)['accept-encoding']).toBe('identity');
  });

  it('rejects bytes that are secretly binary and still cleans up', async () => {
    const before = tempDirs().length;
    const binary = new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]));
    await expect(
      fetchTextAttachment(base, {
        binaryExtractionEnabled: false,
        allowedHosts: hosts,
        fetchImpl: (async () => binary) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/binary data/);
    expect(tempDirs().length).toBe(before);
  });
});
