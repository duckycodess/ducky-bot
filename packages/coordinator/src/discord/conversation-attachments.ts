import { readFile } from 'node:fs/promises';
import {
  CONVERSATION_ATTACHMENT_TIMEOUT_MS, CONVERSATION_MAX_ATTACHMENT_BYTES, DuckyError,
} from '@ducky/contracts';
import {
  assertAttachmentMeta, normalizeContentType,
  type AttachmentMeta, type ConversationProvider, type ManagedConversationAttachment,
} from '@ducky/adapters';
import { CONVERSATION_TEMP_PREFIX, fetchCappedBytes, spoolToPrivateFile } from './attachments.js';

/**
 * Images a generic byte reader can hand on unchanged.
 *
 * Narrow on purpose. This says nothing about whether anything can *see* them:
 * no vision capability is claimed anywhere in this batch, and the bytes are
 * only ever forwarded to a provider that has itself declared it accepts this
 * exact type.
 */
export const CONVERSATION_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Non-image types that survive the same generic path.
 *
 * PDF is deliberately absent. It is a different parsing surface, the roadmap
 * flags it as an open decision, and accepting it here would imply a document
 * capability nothing on this host has.
 */
export const CONVERSATION_FILE_TYPES = [
  'text/plain', 'text/csv', 'text/markdown', 'application/json',
] as const;

export const CONVERSATION_ATTACHMENT_TYPES = [
  ...CONVERSATION_IMAGE_TYPES,
  ...CONVERSATION_FILE_TYPES,
] as const;

export const TOO_MANY_ATTACHMENTS_MESSAGE =
  'Send one file at a time. Nothing was downloaded.';

export const UNSUPPORTED_CONVERSATION_TYPE_MESSAGE =
  'That file type is not accepted. Send a PNG, JPEG or WebP image, or a .txt, .csv, .md or .json file.';

export interface ConversationAttachmentConfig {
  /** Operator opt-in. False by default: the whole path is off until enabled. */
  readonly enabled: boolean;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The gate, and the only place that decides whether bytes may be fetched.
 *
 * Three independent conditions, all required:
 *
 * - the operator has opted in (`CONVERSATION_ATTACHMENTS_ENABLED`),
 * - the provider reports itself `verified` — an unexercised API is not sent
 *   the owner's personal files on the strength of its own flag, and
 * - the provider declares attachment support.
 *
 * Anything less and this returns false, the router answers honestly, and no
 * fetch is constructed.
 */
export function conversationAttachmentsUsable(
  provider: ConversationProvider,
  config: ConversationAttachmentConfig,
): boolean {
  return config.enabled && provider.verified && provider.capabilities.attachments.supported;
}

/** Human-readable reason for `/status` and for the refusal reply. */
export function attachmentAvailability(
  provider: ConversationProvider,
  config: ConversationAttachmentConfig,
): string {
  if (!config.enabled) return 'disabled (CONVERSATION_ATTACHMENTS_ENABLED is off)';
  if (!provider.verified) return `unavailable (${provider.name} is unverified)`;
  if (!provider.capabilities.attachments.supported) {
    return `unavailable (${provider.name} accepts no attachments)`;
  }
  const { maxBytes } = effectiveLimits(provider, config);
  return `enabled (${provider.name}, ≤ ${Math.floor(maxBytes / 1024)} KiB)`;
}

/**
 * The intersection of what the operator allows and what the provider claims.
 *
 * Taking the SMALLER of the two caps, and the INTERSECTION of the two type
 * lists, means neither side can talk the other past its own limit: a provider
 * advertising a 50 MiB PDF appetite gets our 2 MiB image cap, and an operator
 * who widens the config cannot make us send a type the provider never offered
 * to read.
 */
export function effectiveLimits(
  provider: ConversationProvider,
  config: ConversationAttachmentConfig,
): { maxBytes: number; contentTypes: readonly string[] } {
  const declared = provider.capabilities.attachments;
  const ours = CONVERSATION_ATTACHMENT_TYPES as readonly string[];
  const theirs = declared.contentTypes.map(normalizeContentType);
  return {
    maxBytes: Math.min(config.maxBytes || CONVERSATION_MAX_ATTACHMENT_BYTES, declared.maxBytes),
    contentTypes: ours.filter((t) => theirs.includes(t)),
  };
}

/**
 * Metadata-only check for the conversation surface. No network request exists
 * at this point, and none is built if this throws.
 */
export function checkConversationAttachmentMeta(
  meta: AttachmentMeta,
  provider: ConversationProvider,
  config: ConversationAttachmentConfig,
): void {
  const limits = effectiveLimits(provider, config);
  assertAttachmentMeta(meta, {
    allowedContentTypes: limits.contentTypes,
    allowedHosts: config.allowedHosts,
    maxBytes: limits.maxBytes,
    unsupportedTypeMessage: UNSUPPORTED_CONVERSATION_TYPE_MESSAGE,
  });
}

/**
 * Downloads one attachment into a private temp file and wraps it in a handle
 * whose lifetime the CALLER owns.
 *
 * The bytes exist in exactly two places: a 0600 file in a 0700 directory, and
 * whatever the provider does with what `read` returns. They never reach
 * SQLite, never reach a log line, and never reach Discord. `dispose` removes
 * the directory and poisons the handle, so a provider that kept a reference
 * gets a thrown error rather than the owner's file.
 *
 * Callers MUST `dispose` in a `finally`. The router does.
 */
export async function downloadConversationAttachment(
  meta: AttachmentMeta,
  provider: ConversationProvider,
  config: ConversationAttachmentConfig,
): Promise<ManagedConversationAttachment> {
  if (!conversationAttachmentsUsable(provider, config)) {
    // Defence in depth. The router refuses first; reaching here would be a
    // wiring bug, and it must not be the bug that downloads the file.
    throw new DuckyError('attachment_rejected', 'Attachments are not accepted right now.');
  }
  checkConversationAttachmentMeta(meta, provider, config);

  const limits = effectiveLimits(provider, config);
  const bytes = await fetchCappedBytes(meta.url, {
    maxBytes: limits.maxBytes,
    timeoutMs: config.timeoutMs ?? CONVERSATION_ATTACHMENT_TIMEOUT_MS,
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
  });

  const spooled = await spoolToPrivateFile(bytes, CONVERSATION_TEMP_PREFIX, 'attachment.bin');
  let disposed = false;

  return {
    metadata: {
      // The filename is owner-supplied text and is carried as metadata only;
      // it is never used to build a path. The spooled file has a fixed name.
      filename: meta.filename,
      contentType: normalizeContentType(meta.contentType),
      byteLength: bytes.byteLength,
    },
    read: async (maxBytes?: number): Promise<Uint8Array> => {
      if (disposed) {
        throw new DuckyError(
          'not_found',
          'That attachment is no longer available: its lifetime ended when the reply completed.',
        );
      }
      const buf = await readFile(spooled.file);
      const cap = Math.min(maxBytes ?? buf.byteLength, limits.maxBytes);
      return cap < buf.byteLength ? buf.subarray(0, cap) : buf;
    },
    dispose: async (): Promise<void> => {
      // Poisoned FIRST, so a concurrent read cannot slip past the removal.
      disposed = true;
      await spooled.dispose();
    },
  };
}
