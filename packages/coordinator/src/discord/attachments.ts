import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DuckyError, SCHEDULE_ATTACHMENT_TIMEOUT_MS, SCHEDULE_MAX_ATTACHMENT_BYTES,
} from '@ducky/contracts';
import { assertLooksLikeText, checkAttachmentMeta, type AttachmentMeta } from '@ducky/adapters';

export const TEMP_PREFIX = 'ducky-sched-';

export interface FetchOptions {
  readonly binaryExtractionEnabled: boolean;
  readonly allowedHosts: readonly string[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Downloads a Discord text attachment under strict, layered limits.
 *
 * The metadata check runs FIRST, so an unsupported type (today: every image and
 * PDF) is refused before a single byte is requested. Redirects are refused
 * outright, the host must match exactly, nothing is ever decompressed, and the
 * byte counter aborts mid-stream if the reported size was a lie.
 *
 * The bytes are written to a private 0600 file inside a 0700 directory that is
 * always removed, on success and on failure alike. Raw bytes never reach the
 * database, Discord, or a log line.
 */
export async function fetchTextAttachment(
  meta: AttachmentMeta,
  opts: FetchOptions,
): Promise<{ text: string }> {
  checkAttachmentMeta(meta, {
    binaryExtractionEnabled: opts.binaryExtractionEnabled,
    allowedHosts: opts.allowedHosts,
    ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
  });

  const maxBytes = opts.maxBytes ?? SCHEDULE_MAX_ATTACHMENT_BYTES;
  const doFetch = opts.fetchImpl ?? fetch;

  const response = await doFetch(meta.url, {
    redirect: 'error',
    headers: { 'accept-encoding': 'identity' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? SCHEDULE_ATTACHMENT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new DuckyError('attachment_rejected', 'That attachment could not be downloaded.');
  }

  const buffer = await readCapped(response, maxBytes);
  assertLooksLikeText(buffer);

  const dir = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
    const file = path.join(dir, 'attachment.txt');
    await writeFile(file, buffer, { mode: 0o600 });
    return { text: buffer.toString('utf8') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new DuckyError('attachment_rejected', 'That file is larger than the limit.');
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    // The reported size can lie; stop the moment the real stream exceeds the cap.
    if (total > maxBytes) {
      await reader.cancel();
      throw new DuckyError('attachment_rejected', 'That file is larger than the limit.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Crash recovery: removes temp directories a previous run could not clean up. */
export function sweepStaleTempDirs(olderThanMs = 3_600_000, tmpdir = os.tmpdir()): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(tmpdir);
  } catch {
    return removed;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(tmpdir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        void rm(full, { recursive: true, force: true });
        removed.push(full);
      }
    } catch {
      /* another process may have removed it already */
    }
  }
  return removed;
}
