import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DuckyError, SCHEDULE_ATTACHMENT_TIMEOUT_MS, SCHEDULE_MAX_ATTACHMENT_BYTES,
} from '@ducky/contracts';
import { assertLooksLikeText, checkAttachmentMeta, type AttachmentMeta } from '@ducky/adapters';

/**
 * Temp-directory prefixes, one per surface, so a sweep can tell whose leftovers
 * it is removing. Every prefix here is swept at startup.
 */
export const SCHEDULE_TEMP_PREFIX = 'ducky-sched-';
export const CONVERSATION_TEMP_PREFIX = 'ducky-conv-';
export const TEMP_PREFIXES = [SCHEDULE_TEMP_PREFIX, CONVERSATION_TEMP_PREFIX] as const;

/** Retained name for the schedule surface, which shipped first. */
export const TEMP_PREFIX = SCHEDULE_TEMP_PREFIX;

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
  const buffer = await fetchCappedBytes(meta.url, {
    maxBytes,
    timeoutMs: opts.timeoutMs ?? SCHEDULE_ATTACHMENT_TIMEOUT_MS,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  assertLooksLikeText(buffer);

  const spooled = await spoolToPrivateFile(buffer, SCHEDULE_TEMP_PREFIX, 'attachment.txt');
  try {
    return { text: buffer.toString('utf8') };
  } finally {
    await spooled.dispose();
  }
}

export interface CappedFetchOptions {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The one network read every attachment surface uses.
 *
 * `redirect: 'error'` matters as much as the host allowlist: without it, an
 * allowlisted CDN url could bounce the request anywhere, and the host check
 * would have been decoration. `accept-encoding: identity` means the cap
 * applies to real bytes rather than to a compressed stream that expands past
 * it afterwards.
 */
export async function fetchCappedBytes(
  url: string,
  opts: CappedFetchOptions,
): Promise<Buffer> {
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    redirect: 'error',
    headers: { 'accept-encoding': 'identity' },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!response.ok) {
    throw new DuckyError('attachment_rejected', 'That attachment could not be downloaded.');
  }
  return readCapped(response, opts.maxBytes);
}

export interface SpooledFile {
  readonly dir: string;
  readonly file: string;
  /** Idempotent; safe to call from a `finally` that may run twice. */
  dispose(): Promise<void>;
}

/**
 * Writes bytes to a 0600 file inside a 0700 directory of our own.
 *
 * The directory permissions are set explicitly rather than relying on
 * `mkdtemp`'s documented default, so the guarantee is visible in the code and
 * assertable in a test. `rm -rf` on dispose is `force`, so a caller that
 * disposes twice — the normal shape of a `finally` around a throwing call —
 * is not itself a new failure.
 */
export async function spoolToPrivateFile(
  bytes: Uint8Array,
  prefix: string,
  filename: string,
): Promise<SpooledFile> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(dir, 0o700);
  const file = path.join(dir, filename);
  try {
    await writeFile(file, bytes, { mode: 0o600 });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    dir,
    file,
    dispose: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
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

/**
 * Crash recovery: removes temp directories a previous run could not clean up.
 *
 * Sweeps EVERY surface's prefix. A prefix added without being listed in
 * `TEMP_PREFIXES` would leave the owner's bytes on disk after a crash, so the
 * list is the single place a new surface has to register.
 */
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
    if (!TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
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
