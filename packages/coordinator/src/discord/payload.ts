import {
  ACTION_ROWS_MAX, BUTTONS_PER_ROW_MAX, EMBED_FIELDS_MAX,
} from '@ducky/contracts';
import type { ButtonStyle, OutboundMessage } from './message.js';

/**
 * Structural conversion from our sanitized outbound shape to the JSON Discord
 * actually accepts.
 *
 * Kept free of any `discord.js` import so it can be unit-tested without a
 * client and without touching the network. Input must already have been
 * through `sanitizeOutbound`.
 */

/** Discord's numeric button styles. */
const BUTTON_STYLE: Record<ButtonStyle, number> = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
};

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const COMPONENT_TEXT_INPUT = 4;

export interface DiscordEmbedPayload {
  title?: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
}

export interface DiscordComponentPayload {
  type: number;
  components: { type: number; custom_id: string; label: string; style: number }[];
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbedPayload[];
  components?: DiscordComponentPayload[];
  flags?: number;
}

/** Ephemeral. Owner-facing replies use it so private data is not left in a channel. */
export const EPHEMERAL_FLAG = 1 << 6;

export function toDiscordPayload(message: OutboundMessage): DiscordMessagePayload {
  const payload: DiscordMessagePayload = {};

  if (message.content) payload.content = message.content;

  if (message.embeds?.length) {
    payload.embeds = message.embeds.map((e) => {
      const embed: DiscordEmbedPayload = {};
      if (e.title !== undefined) embed.title = e.title;
      if (e.description !== undefined) embed.description = e.description;
      if (e.fields?.length) {
        embed.fields = e.fields.slice(0, EMBED_FIELDS_MAX).map((f) => ({
          name: f.name,
          value: f.value,
          ...(f.inline === undefined ? {} : { inline: f.inline }),
        }));
      }
      if (e.footer !== undefined) embed.footer = { text: e.footer };
      return embed;
    });
  }

  if (message.rows?.length) {
    const rows = message.rows
      .slice(0, ACTION_ROWS_MAX)
      .map((row) => ({
        type: COMPONENT_ACTION_ROW,
        components: row.buttons.slice(0, BUTTONS_PER_ROW_MAX).map((b) => ({
          type: COMPONENT_BUTTON,
          custom_id: b.customId,
          label: b.label,
          style: BUTTON_STYLE[b.style ?? 'secondary'],
        })),
      }))
      // A row with no buttons is rejected by Discord; sanitization can empty
      // one by dropping an unsafe id, so drop the row too.
      .filter((row) => row.components.length > 0);
    if (rows.length > 0) payload.components = rows;
  }

  // Default to ephemeral: every owner-only surface carries private data.
  if (message.ephemeral !== false) payload.flags = EPHEMERAL_FLAG;

  return payload;
}

export interface ModalField {
  readonly customId: string;
  readonly label: string;
  readonly value?: string | undefined;
  readonly paragraph?: boolean;
  readonly required?: boolean;
  readonly maxLength?: number;
}

export interface DiscordModalPayload {
  custom_id: string;
  title: string;
  components: {
    type: number;
    components: {
      type: number;
      custom_id: string;
      label: string;
      style: number;
      required: boolean;
      value?: string;
      max_length?: number;
    }[];
  }[];
}

/** Modals carry corrections and answers, so the owner edits rather than retypes. */
export function toModalPayload(
  customId: string,
  title: string,
  fields: readonly ModalField[],
): DiscordModalPayload {
  return {
    custom_id: customId,
    title: title.slice(0, 45),
    components: fields.slice(0, 5).map((f) => ({
      type: COMPONENT_ACTION_ROW,
      components: [
        {
          type: COMPONENT_TEXT_INPUT,
          custom_id: f.customId,
          label: f.label.slice(0, 45),
          style: f.paragraph === false ? 1 : 2,
          required: f.required ?? true,
          ...(f.value === undefined ? {} : { value: f.value.slice(0, 4000) }),
          ...(f.maxLength === undefined ? {} : { max_length: f.maxLength }),
        },
      ],
    })),
  };
}
