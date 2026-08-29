#!/usr/bin/env node
/**
 * PROBE E -- what this host can actually read out of a PDF or an image.
 *
 * `docs/CURRENT_STATE.md` has said "no decoder ships, none is installed" for
 * several milestones, and that sentence was true when it was written. Nothing
 * checked it afterwards. A capability claim that nothing re-checks is a claim
 * that drifts silently in the direction of being wrong -- and the direction
 * that matters here is somebody installing `poppler-utils` for an unrelated
 * reason and Ducky's documentation still saying extraction is impossible.
 *
 * So this looks, and records what it found.
 *
 * WHAT IT DOES
 * - Runs `--version` on each candidate decoder, on PATH only.
 * - Records presence and the version STRING, nothing else.
 *
 * WHAT IT DOES NOT DO
 * - It installs nothing. Installing a decoder is a host mutation and an owner
 *   decision, and it is one with a real cost: an OCR engine is a large
 *   dependency and its output is a GUESS, which is a poor foundation for a
 *   schedule the owner will act on.
 * - It does not read any document. There is nothing to read: no attachment
 *   byte has ever been fetched on this host.
 * - It does not enable anything. Even with every decoder present, image and
 *   PDF extraction stays refused until a provider reports `supportsBinary` and
 *   `SCHEDULE_BINARY_EXTRACTION_ENABLED` is set. Two switches, neither of them
 *   this file.
 *
 * Exit 2 while no deterministic text extractor is available, because that is
 * the honest state and a probe that cannot fail is not a certifier.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'packages/adapters/src/schedule/schedule.fixtures');

/**
 * The candidates, and what each would actually buy.
 *
 * The split matters more than the list. `pdftotext` reads text that is already
 * IN a PDF: same input, same output, every time -- which is the only kind of
 * extraction that belongs in front of a schedule the owner confirms. OCR reads
 * pixels and produces a probability dressed as a string; it is recorded here
 * for completeness and is not what "deterministic PDF text extraction" means.
 */
const CANDIDATES = [
  {
    bin: 'pdftotext',
    package: 'poppler-utils',
    kind: 'deterministic',
    buys: 'Extracts the text layer of a PDF. Same input, same output. `-layout` preserves columns, which is what a timetable needs.',
  },
  {
    bin: 'pdfinfo',
    package: 'poppler-utils',
    kind: 'deterministic',
    buys: 'Reports page count and whether a PDF has a text layer at all -- which is how you tell a real PDF from a scan before trying to read it.',
  },
  {
    bin: 'qpdf',
    package: 'qpdf',
    kind: 'deterministic',
    buys: 'Structural inspection and repair. Not an extractor; useful only to reject a malformed file early.',
  },
  {
    bin: 'tesseract',
    package: 'tesseract-ocr',
    kind: 'ocr',
    buys: 'Reads pixels. Output is a GUESS: it varies with resolution and rendering, and it silently misreads digits -- the exact characters a schedule is made of.',
  },
  {
    bin: 'pdftoppm',
    package: 'poppler-utils',
    kind: 'ocr-support',
    buys: 'Renders PDF pages to images, so OCR has something to look at. Only useful with an OCR engine.',
  },
  {
    bin: 'gs',
    package: 'ghostscript',
    kind: 'ocr-support',
    buys: 'Alternative rasteriser. Large dependency; nothing here needs it if poppler is present.',
  },
];

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        out: `${String(stdout ?? '')}${String(stderr ?? '')}`.trim(),
      }),
    );
  });

async function main() {
  const found = [];
  for (const c of CANDIDATES) {
    const res = await run(c.bin, ['--version']);
    // The first line only: some of these print a paragraph of build detail.
    const version = res.ok ? (res.out.split('\n')[0] ?? '').slice(0, 120) : null;
    found.push({ ...c, present: res.ok, version });
    process.stdout.write(
      `  ${c.bin.padEnd(10)} ${res.ok ? `present — ${version}` : 'ABSENT'}\n`,
    );
  }

  const deterministic = found.filter((f) => f.kind === 'deterministic' && f.present);
  const ocr = found.filter((f) => f.kind === 'ocr' && f.present);

  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(
    path.join(FIXTURES, 'binary-extraction.json'),
    `${JSON.stringify(
      {
        _note:
          'Recorded by scripts/probe-extraction.mjs. Presence and version strings only. ' +
          'Nothing was installed, no document was read, and nothing was enabled.',
        recordedAt: new Date().toISOString().slice(0, 10),
        deterministicTextExtractionAvailable: deterministic.length > 0,
        ocrAvailable: ocr.length > 0,
        candidates: found.map(({ bin, package: pkg, kind, present, version, buys }) => ({
          bin, package: pkg, kind, present, version, buys,
        })),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write('\nrecorded binary-extraction.json\n');

  if (deterministic.length > 0) {
    process.stdout.write(
      [
        '',
        'A deterministic text extractor IS available on this host.',
        '',
        'That does not enable anything by itself, and deliberately so. Image and PDF',
        'schedule extraction still needs BOTH:',
        '  * a provider reporting supportsBinary: true -- the shipped deterministic',
        '    extractor reads text and CSV and reports false;',
        '  * SCHEDULE_BINARY_EXTRACTION_ENABLED=true.',
        '',
        'Uploads stay refused BEFORE download until both are true.',
      ].join('\n') + '\n',
    );
    process.exit(0);
  }

  process.stdout.write(
    [
      '',
      'NO deterministic text extractor on this host. The blocker, exactly:',
      '  * pdftotext is absent, so a PDF cannot be read even when it has a text layer;',
      '  * no provider reports supportsBinary, so nothing could read the bytes anyway;',
      '  * image and PDF uploads are refused BEFORE download, so no byte is fetched.',
      '',
      'What would change it, and what it costs:',
      '  * `poppler-utils` provides pdftotext and pdfinfo. It is small, it is',
      '    deterministic, and it is the only option here worth calling extraction.',
      '  * OCR (tesseract) is NOT the same thing. It reads pixels and returns a guess',
      '    that varies with rendering and misreads digits -- which is what a schedule',
      '    is made of. A wrong time the owner then confirms is worse than a refusal.',
      '',
      'Installing either is a HOST MUTATION and an owner decision. Nothing here does it.',
    ].join('\n') + '\n',
  );
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`extraction probe failed: ${err.message}\n`);
  process.exit(1);
});
