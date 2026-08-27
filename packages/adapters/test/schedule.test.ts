import { describe, expect, it } from 'vitest';
import { DeterministicScheduleExtractor } from '../src/schedule/extraction.deterministic.js';
import {
  BINARY_REJECTION_MESSAGE, assertLooksLikeText, checkAttachmentMeta,
} from '../src/schedule/attachment-policy.js';

const extractor = new DeterministicScheduleExtractor();
const hosts = ['cdn.discordapp.com', 'media.discordapp.net'];
const meta = (over: Partial<Parameters<typeof checkAttachmentMeta>[0]> = {}) => ({
  filename: 'sched.csv',
  contentType: 'text/csv',
  size: 100,
  url: 'https://cdn.discordapp.com/attachments/1/2/sched.csv',
  ...over,
});

describe('deterministic schedule extraction', () => {
  it('never claims to read binary formats', () => {
    expect(extractor.supportsBinary).toBe(false);
  });

  it('parses a CSV with recognisable headers', async () => {
    const out = await extractor.extract({
      kind: 'file',
      text: 'title,start,location\nStandup,2026-09-01 09:00,Room 3\nRetro,2026-09-02 15:30,Room 1\n',
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: 'Standup', startsAt: '2026-09-01 09:00', location: 'Room 3' });
  });

  it('parses pipe-delimited and bare datetime lines', async () => {
    const out = await extractor.extract({
      kind: 'text',
      text: '2026-09-01 09:00 | Standup | Room 3\n2026-09-02 15:30 Retro @ Room 1\n',
    });
    expect(out.map((e) => e.title)).toEqual(['Standup', 'Retro']);
    expect(out[1]?.location).toBe('Room 1');
  });

  it('returns nothing rather than guessing when nothing matches', async () => {
    expect(await extractor.extract({ kind: 'text', text: 'lunch sometime next week maybe' })).toEqual([]);
    expect(await extractor.extract({ kind: 'text', text: '   ' })).toEqual([]);
  });
});

describe('attachment policy', () => {
  const opts = { binaryExtractionEnabled: false, allowedHosts: hosts };

  it('accepts a small text/csv attachment from a Discord CDN host', () => {
    expect(() => checkAttachmentMeta(meta(), opts)).not.toThrow();
  });

  it('rejects images and PDFs with the documented message while no provider can read them', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']) {
      expect(() => checkAttachmentMeta(meta({ contentType: t }), opts)).toThrow(BINARY_REJECTION_MESSAGE);
    }
  });

  it('rejects any other content type', () => {
    expect(() => checkAttachmentMeta(meta({ contentType: 'application/zip' }), opts)).toThrow(/not supported/);
    expect(() => checkAttachmentMeta(meta({ contentType: null }), opts)).toThrow(/not supported/);
  });

  it('rejects an oversize attachment before any download', () => {
    expect(() => checkAttachmentMeta(meta({ size: 10_000_000 }), opts)).toThrow(/too large/);
  });

  it('requires https and an exact Discord CDN host', () => {
    expect(() => checkAttachmentMeta(meta({ url: 'http://cdn.discordapp.com/x' }), opts)).toThrow(/HTTPS/);
    expect(() =>
      checkAttachmentMeta(meta({ url: 'https://cdn.discordapp.com.evil.tld/x' }), opts),
    ).toThrow(/not hosted by Discord/);
    expect(() => checkAttachmentMeta(meta({ url: 'https://evil.tld/x' }), opts)).toThrow(
      /not hosted by Discord/,
    );
  });

  it('rejects bytes that claim to be text but are not', () => {
    expect(() => assertLooksLikeText(Buffer.from('hello,world\n'))).not.toThrow();
    expect(() => assertLooksLikeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toThrow(
      /binary data/,
    );
  });
});
