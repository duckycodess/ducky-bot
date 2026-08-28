import { DuckyError } from '@ducky/contracts';

/**
 * The metadata Discord hands us about an attachment, before anything is
 * fetched.
 *
 * Every field is attacker-influenced: the filename is user-chosen, the content
 * type is a *claim*, the size is a *claim*, and the url is a string that
 * happens to look like a CDN link. Nothing here is trusted; this module is
 * what turns the claims into a decision.
 */
export interface AttachmentMeta {
  readonly filename: string;
  readonly contentType: string | null;
  readonly size: number;
  readonly url: string;
}

/**
 * One reusable, strict metadata policy, shared by every attachment surface.
 *
 * It exists so a second surface (conversation, in 2C) cannot accidentally ship
 * a *weaker* set of checks than the first (schedule, in Phase 1). Both call
 * the same function; only the allowlists and the ceiling differ.
 */
export interface AttachmentMetadataPolicy {
  /** Exact, normalized MIME types. Anything else is refused. */
  readonly allowedContentTypes: readonly string[];
  /** Exact hostnames. A suffix match would accept `cdn.discordapp.com.evil.tld`. */
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  /** Shown when the type is not on the allowlist. Surface-specific wording. */
  readonly unsupportedTypeMessage: string;
}

/** `image/png; charset=x` and `IMAGE/PNG` both normalize to `image/png`. */
export const normalizeContentType = (t: string | null): string =>
  (t ?? '').split(';')[0]!.trim().toLowerCase();

/**
 * Decides on METADATA ALONE, before any network request exists.
 *
 * The order is deliberate and is the whole point of the module: an
 * unsupported type, an oversize claim or a foreign host costs zero bandwidth
 * and creates no temporary file, because none of those branches has reached a
 * fetch yet.
 */
export function assertAttachmentMeta(
  meta: AttachmentMeta,
  policy: AttachmentMetadataPolicy,
): void {
  const type = normalizeContentType(meta.contentType);
  if (!policy.allowedContentTypes.includes(type)) {
    throw new DuckyError('attachment_rejected', policy.unsupportedTypeMessage);
  }

  // A declared size is a claim, so this is the CHEAP half of the size check.
  // The received stream is capped again while it is being read.
  if (!Number.isFinite(meta.size) || meta.size < 0 || meta.size > policy.maxBytes) {
    throw new DuckyError(
      'attachment_rejected',
      `That file is too large. The limit is ${Math.floor(policy.maxBytes / 1024)} KiB.`,
    );
  }

  assertAllowedAttachmentUrl(meta.url, policy.allowedHosts);
}

/**
 * HTTPS, and an EXACT host from the configured allowlist.
 *
 * Split out because it is the check most likely to be wanted on its own, and
 * because getting it wrong is the difference between "download from Discord"
 * and "make the coordinator fetch an arbitrary URL somebody typed".
 */
export function assertAllowedAttachmentUrl(
  raw: string,
  allowedHosts: readonly string[],
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DuckyError('attachment_rejected', 'That attachment link could not be read.');
  }
  if (url.protocol !== 'https:') {
    throw new DuckyError('attachment_rejected', 'Attachments must be served over HTTPS.');
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new DuckyError('attachment_rejected', 'That attachment is not hosted by Discord.');
  }
  return url;
}
