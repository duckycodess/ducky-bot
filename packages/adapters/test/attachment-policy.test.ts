import { describe, expect, it } from 'vitest';
import {
  BINARY_REJECTION_MESSAGE, assertAllowedAttachmentUrl, assertAttachmentMeta,
  checkAttachmentMeta, normalizeContentType,
} from '../src/index.js';

const HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

const policy = {
  allowedContentTypes: ['image/png', 'text/plain'],
  allowedHosts: HOSTS,
  maxBytes: 1024,
  unsupportedTypeMessage: 'nope, not that type',
};

const meta = (over: Record<string, unknown> = {}) => ({
  filename: 'a.png',
  contentType: 'image/png',
  size: 100,
  url: 'https://cdn.discordapp.com/attachments/1/2/a.png',
  ...over,
});

describe('the shared attachment metadata policy', () => {
  it('normalizes a content type before comparing it', () => {
    expect(normalizeContentType('IMAGE/PNG; charset=utf-8')).toBe('image/png');
    expect(normalizeContentType(null)).toBe('');
    expect(normalizeContentType('  text/csv  ')).toBe('text/csv');
    // A parameterized, upper-cased type still matches the allowlist.
    expect(() => assertAttachmentMeta(meta({ contentType: 'IMAGE/PNG; x=1' }), policy)).not.toThrow();
  });

  it('accepts only an exact type from the allowlist', () => {
    expect(() => assertAttachmentMeta(meta(), policy)).not.toThrow();
    for (const contentType of ['application/pdf', 'image/gif', null, '', 'image/png-evil']) {
      expect(() => assertAttachmentMeta(meta({ contentType }), policy)).toThrow(
        'nope, not that type',
      );
    }
  });

  it('rejects an implausible or oversize declared size', () => {
    for (const size of [1025, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertAttachmentMeta(meta({ size }), policy), String(size)).toThrow(/too large/);
    }
    expect(() => assertAttachmentMeta(meta({ size: 1024 }), policy)).not.toThrow();
  });

  it('requires HTTPS and an EXACT host, so a suffix cannot be smuggled', () => {
    expect(assertAllowedAttachmentUrl(meta().url, HOSTS).hostname).toBe('cdn.discordapp.com');

    for (const url of [
      'http://cdn.discordapp.com/x',
      'https://cdn.discordapp.com.evil.tld/x',
      'https://evil.tld/cdn.discordapp.com/x',
      'https://notcdn.discordapp.com/x',
      'ftp://cdn.discordapp.com/x',
      'not a url at all',
    ]) {
      expect(() => assertAllowedAttachmentUrl(url, HOSTS), url).toThrow();
    }
  });

  it('is case-insensitive about the host, as DNS is', () => {
    expect(() =>
      assertAllowedAttachmentUrl('https://CDN.DiscordApp.com/x', HOSTS),
    ).not.toThrow();
  });

  it('checks type before size and before host, so nothing is fetched to find out', () => {
    // Every field is wrong at once; the type message is what comes back,
    // proving the cheapest, most decisive check ran first.
    expect(() =>
      assertAttachmentMeta(
        meta({ contentType: 'application/zip', size: 99_999, url: 'https://evil.tld/x' }),
        policy,
      ),
    ).toThrow('nope, not that type');
  });
});

describe('the schedule surface still layers its own wording on top', () => {
  it('keeps the capability-honest message for images and PDFs', () => {
    for (const contentType of ['image/png', 'application/pdf']) {
      expect(() =>
        checkAttachmentMeta(meta({ contentType, filename: 'x' }), {
          binaryExtractionEnabled: false,
          allowedHosts: HOSTS,
        }),
      ).toThrow(BINARY_REJECTION_MESSAGE);
    }
  });

  it('still accepts text and CSV, and still refuses everything else', () => {
    expect(() =>
      checkAttachmentMeta(meta({ contentType: 'text/csv', filename: 's.csv' }), {
        binaryExtractionEnabled: false,
        allowedHosts: HOSTS,
      }),
    ).not.toThrow();

    expect(() =>
      checkAttachmentMeta(meta({ contentType: 'application/json' }), {
        binaryExtractionEnabled: false,
        allowedHosts: HOSTS,
      }),
    ).toThrow(/Send a .txt or .csv file/);
  });

  it('shares the host and size rules with every other surface', () => {
    const base = { binaryExtractionEnabled: false, allowedHosts: HOSTS };
    expect(() =>
      checkAttachmentMeta(meta({ contentType: 'text/plain', url: 'https://evil.tld/x' }), base),
    ).toThrow(/not hosted by Discord/);
    expect(() =>
      checkAttachmentMeta(meta({ contentType: 'text/plain', size: 11 }), { ...base, maxBytes: 10 }),
    ).toThrow(/too large/);
  });
});
