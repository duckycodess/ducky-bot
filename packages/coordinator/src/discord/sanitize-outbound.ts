import {
  ACTION_ROWS_MAX, BUTTONS_PER_ROW_MAX, CUSTOM_ID_MAX, DISCORD_CONTENT_MAX,
  EMBED_DESC_MAX, EMBED_FIELDS_MAX, EMBED_FIELD_NAME_MAX, EMBED_FIELD_VALUE_MAX,
  EMBED_FOOTER_MAX, EMBED_TITLE_MAX, EMBED_TOTAL_MAX, TRUNCATION_MARKER,
  isValidEmbedColor,
} from '@ducky/contracts';
import { redact, type Redactor } from '@ducky/adapters';
import { isLinkButton, type OutboundButton, type OutboundEmbed, type OutboundMessage, type OutboundRow } from './message.js';

/**
 * A component id is a signed opaque handle, so it cannot be redacted -- doing
 * so would corrupt the signature and every control would stop working.
 *
 * Instead it is validated STRUCTURALLY: only the exact shape this codebase
 * emits is allowed through, over a character set that cannot express a secret
 * (base64url segments and lowercase identifiers, no quotes, no whitespace).
 * Anything else is dropped rather than sent, so an id can never become a
 * smuggling channel for text that skipped the redactor.
 */
const SAFE_CUSTOM_ID = /^v1:[a-z0-9][a-z0-9-]{0,31}:[a-z_]{1,32}:[A-Za-z0-9._-]{1,64}:[A-Za-z0-9_-]{16,32}$/;

export const isSafeCustomId = (id: string): boolean =>
  id.length <= CUSTOM_ID_MAX && SAFE_CUSTOM_ID.test(id);

/**
 * The only hosts a link button may point at.
 *
 * A URL in a Discord message is a thing the owner is invited to click, so the
 * set is a short allowlist rather than a scheme check: "https" is not a
 * statement about where it goes. GitHub is the only destination any Ducky
 * surface has a reason to offer -- an issue or a pull request -- and anything
 * else is dropped exactly as an unsafe custom id is.
 */
export const LINK_BUTTON_HOSTS = Object.freeze(['github.com', 'www.github.com']);
/** Bounded: Discord's own limit is 512, and nothing here needs close to it. */
export const LINK_BUTTON_URL_MAX = 300;

export function isSafeLinkUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > LINK_BUTTON_URL_MAX) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (!LINK_BUTTON_HOSTS.includes(url.hostname.toLowerCase())) return false;
  // Re-serialized, so what is checked is exactly what is sent.
  return url.toString() === raw;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(0, max - TRUNCATION_MARKER.length);
  return s.slice(0, keep) + TRUNCATION_MARKER;
}

/**
 * The single egress choke point.
 *
 * Every transport calls this as the first statement of every send, so the
 * guarantee does not depend on presenters remembering to sanitize. It is
 * idempotent, so calling it twice is harmless.
 *
 * It also enforces Discord's own limits locally, which means an over-long
 * message is truncated with a visible marker instead of being rejected by the
 * API at delivery time.
 */
export function sanitizeOutbound(message: OutboundMessage, r: Redactor = redact): OutboundMessage {
  const out: {
    content?: string;
    embeds?: OutboundEmbed[];
    rows?: OutboundRow[];
    ephemeral?: boolean;
  } = {};

  if (message.content !== undefined) out.content = clip(r(message.content), DISCORD_CONTENT_MAX);

  if (message.embeds?.length) {
    let budget = EMBED_TOTAL_MAX;
    out.embeds = message.embeds.slice(0, 10).map((e) => {
      const embed: {
        title?: string;
        description?: string;
        fields?: { name: string; value: string; inline?: boolean }[];
        footer?: string;
        color?: number;
      } = {};
      /**
       * Dropped rather than clamped when invalid.
       *
       * Clamping would turn a nonsense value into a plausible one, which is
       * how a bug becomes invisible. A colour is decoration: losing it costs
       * nothing, and it does not count against the character budget because
       * Discord does not count it either.
       */
      if (isValidEmbedColor(e.color)) embed.color = e.color;
      const spend = (s: string, max: number): string => {
        const clipped = clip(r(s), Math.max(0, Math.min(max, budget)));
        budget -= clipped.length;
        return clipped;
      };
      if (e.title !== undefined) embed.title = spend(e.title, EMBED_TITLE_MAX);
      if (e.description !== undefined) embed.description = spend(e.description, EMBED_DESC_MAX);
      if (e.fields?.length) {
        embed.fields = e.fields.slice(0, EMBED_FIELDS_MAX).map((f) => {
          const field: { name: string; value: string; inline?: boolean } = {
            name: spend(f.name, EMBED_FIELD_NAME_MAX),
            value: spend(f.value, EMBED_FIELD_VALUE_MAX),
          };
          if (f.inline !== undefined) field.inline = f.inline;
          return field;
        });
      }
      if (e.footer !== undefined) embed.footer = spend(e.footer, EMBED_FOOTER_MAX);
      return embed;
    });
  }

  if (message.rows?.length) {
    out.rows = message.rows.slice(0, ACTION_ROWS_MAX).map((row) => ({
      buttons: row.buttons
        .slice(0, BUTTONS_PER_ROW_MAX)
        // Dropped rather than mangled, for both kinds: a truncated or
        // malformed id would fail signature verification anyway, a URL that is
        // not on the allowlist is not a destination Ducky offers, and letting
        // arbitrary text through here would bypass the redactor.
        .filter((b) => (isLinkButton(b) ? isSafeLinkUrl(b.url) : isSafeCustomId(b.customId)))
        .map((b): OutboundButton =>
          isLinkButton(b)
            // The URL is NOT passed through the redactor: it has already been
            // proven to be an exact https GitHub URL, and redacting one would
            // corrupt a link exactly as it would corrupt a signature.
            ? { url: b.url, label: clip(r(b.label), 80) }
            : {
                customId: b.customId,
                label: clip(r(b.label), 80),
                ...(b.style ? { style: b.style } : {}),
              },
        ),
    }));
  }

  if (message.ephemeral !== undefined) out.ephemeral = message.ephemeral;
  return out;
}
