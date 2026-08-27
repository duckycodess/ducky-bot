import {
  ACTION_ROWS_MAX, BUTTONS_PER_ROW_MAX, CUSTOM_ID_MAX, DISCORD_CONTENT_MAX,
  EMBED_DESC_MAX, EMBED_FIELDS_MAX, EMBED_FIELD_NAME_MAX, EMBED_FIELD_VALUE_MAX,
  EMBED_FOOTER_MAX, EMBED_TITLE_MAX, EMBED_TOTAL_MAX, TRUNCATION_MARKER,
} from '@ducky/contracts';
import { redact, type Redactor } from '@ducky/adapters';
import type { OutboundEmbed, OutboundMessage, OutboundRow } from './message.js';

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
      } = {};
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
        // A custom id longer than the limit is dropped rather than silently
        // mangled: a truncated id would fail signature verification anyway.
        .filter((b) => b.customId.length <= CUSTOM_ID_MAX)
        .map((b) => ({
          customId: b.customId,
          label: clip(r(b.label), 80),
          ...(b.style ? { style: b.style } : {}),
        })),
    }));
  }

  if (message.ephemeral !== undefined) out.ephemeral = message.ephemeral;
  return out;
}
