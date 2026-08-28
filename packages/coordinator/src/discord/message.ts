export interface OutboundEmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface OutboundEmbed {
  readonly title?: string;
  readonly description?: string;
  readonly fields?: readonly OutboundEmbedField[];
  readonly footer?: string;
}

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface OutboundButton {
  readonly customId: string;
  readonly label: string;
  readonly style?: ButtonStyle;
}

export interface OutboundRow {
  readonly buttons: readonly OutboundButton[];
}

export interface OutboundMessage {
  readonly content?: string;
  readonly embeds?: readonly OutboundEmbed[];
  readonly rows?: readonly OutboundRow[];
  /** Owner-facing replies default to ephemeral so private data is not echoed. */
  readonly ephemeral?: boolean;
}

/**
 * Where a proactive message goes.
 *
 * A discriminated union rather than an object with two optional ids: the
 * difference between a private DM and a channel everyone can read is the
 * single most consequential choice an outbound message makes, so it must be
 * impossible to express by accident or to get wrong by forgetting a field.
 */
export type SendTarget =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'channel'; readonly channelId: string };

export const dmTarget = (userId: string): SendTarget => ({ kind: 'user', userId });
export const channelTarget = (channelId: string): SendTarget => ({ kind: 'channel', channelId });

export const text = (content: string, ephemeral = true): OutboundMessage => ({ content, ephemeral });
