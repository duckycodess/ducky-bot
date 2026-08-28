import { BINARY_SNIFF_BYTES, DuckyError, SCHEDULE_MAX_ATTACHMENT_BYTES } from '@ducky/contracts';
import {
  assertAttachmentMeta, normalizeContentType, type AttachmentMeta,
} from '../attachments/policy.js';

export type { AttachmentMeta };

/** Content types a Phase 1 provider can actually read. */
export const TEXT_CONTENT_TYPES = ['text/plain', 'text/csv'] as const;

/** Types a future verified provider could read; refused while none exists. */
export const BINARY_CONTENT_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'application/pdf',
] as const;

export const BINARY_REJECTION_MESSAGE =
  "Image and PDF schedule extraction isn't available yet — send the schedule as text, or a .txt/.csv file.";

export const UNSUPPORTED_SCHEDULE_TYPE_MESSAGE =
  'That file type is not supported. Send a .txt or .csv file, or paste the schedule as text.';

export interface AttachmentPolicyOptions {
  /** True only when a provider that can actually read bytes is configured. */
  readonly binaryExtractionEnabled: boolean;
  readonly allowedHosts: readonly string[];
  readonly maxBytes?: number;
}

/**
 * The SCHEDULE surface's metadata check.
 *
 * The type/size/host rules live in the shared `assertAttachmentMeta`, so this
 * surface and the conversation one cannot drift into different strictness.
 * What is specific here is the *wording*: an image or a PDF gets a distinct
 * message saying extraction is not available yet, rather than the generic
 * "unsupported type", because that is a capability statement and it is the
 * honest one (ADR 0011).
 *
 * Runs entirely on Discord-supplied metadata, BEFORE any network request.
 */
export function checkAttachmentMeta(meta: AttachmentMeta, opts: AttachmentPolicyOptions): void {
  const type = normalizeContentType(meta.contentType);
  if ((BINARY_CONTENT_TYPES as readonly string[]).includes(type) && !opts.binaryExtractionEnabled) {
    throw new DuckyError('attachment_rejected', BINARY_REJECTION_MESSAGE);
  }

  assertAttachmentMeta(meta, {
    allowedContentTypes: TEXT_CONTENT_TYPES,
    allowedHosts: opts.allowedHosts,
    maxBytes: opts.maxBytes ?? SCHEDULE_MAX_ATTACHMENT_BYTES,
    unsupportedTypeMessage: UNSUPPORTED_SCHEDULE_TYPE_MESSAGE,
  });
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
