import { BINARY_SNIFF_BYTES, DuckyError, SCHEDULE_MAX_ATTACHMENT_BYTES } from '@ducky/contracts';

/** Content types a Phase 1 provider can actually read. */
export const TEXT_CONTENT_TYPES = ['text/plain', 'text/csv'] as const;

/** Types a future verified provider could read; refused while none exists. */
export const BINARY_CONTENT_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'application/pdf',
] as const;

export const BINARY_REJECTION_MESSAGE =
  "Image and PDF schedule extraction isn't available yet — send the schedule as text, or a .txt/.csv file.";

export interface AttachmentMeta {
  readonly filename: string;
  readonly contentType: string | null;
  readonly size: number;
  readonly url: string;
}

export interface AttachmentPolicyOptions {
  /** True only when a provider that can actually read bytes is configured. */
  readonly binaryExtractionEnabled: boolean;
  readonly allowedHosts: readonly string[];
  readonly maxBytes?: number;
}

const normalizeType = (t: string | null): string => (t ?? '').split(';')[0]!.trim().toLowerCase();

/**
 * Runs entirely on Discord-supplied metadata, BEFORE any network request.
 * A rejected attachment is never fetched, so an unsupported type costs no
 * bandwidth and creates no temporary file.
 */
export function checkAttachmentMeta(meta: AttachmentMeta, opts: AttachmentPolicyOptions): void {
  const type = normalizeType(meta.contentType);

  if ((BINARY_CONTENT_TYPES as readonly string[]).includes(type) && !opts.binaryExtractionEnabled) {
    throw new DuckyError('attachment_rejected', BINARY_REJECTION_MESSAGE);
  }
  if (!(TEXT_CONTENT_TYPES as readonly string[]).includes(type)) {
    throw new DuckyError(
      'attachment_rejected',
      'That file type is not supported. Send a .txt or .csv file, or paste the schedule as text.',
    );
  }

  const max = opts.maxBytes ?? SCHEDULE_MAX_ATTACHMENT_BYTES;
  if (!Number.isFinite(meta.size) || meta.size < 0 || meta.size > max) {
    throw new DuckyError(
      'attachment_rejected',
      `That file is too large. The limit is ${Math.floor(max / 1024)} KiB.`,
    );
  }

  let url: URL;
  try {
    url = new URL(meta.url);
  } catch {
    throw new DuckyError('attachment_rejected', 'That attachment link could not be read.');
  }
  if (url.protocol !== 'https:') {
    throw new DuckyError('attachment_rejected', 'Attachments must be served over HTTPS.');
  }
  // Exact host match only. A suffix match would accept evil-cdn.discordapp.com.evil.tld.
  if (!opts.allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new DuckyError('attachment_rejected', 'That attachment is not hosted by Discord.');
  }
}

/** A NUL byte in the head of the payload means it is not the text we were promised. */
export function assertLooksLikeText(bytes: Uint8Array): void {
  const head = bytes.subarray(0, BINARY_SNIFF_BYTES);
  if (head.includes(0)) {
    throw new DuckyError(
      'attachment_rejected',
      'That file looked like text but contains binary data, so it was rejected.',
    );
  }
}
