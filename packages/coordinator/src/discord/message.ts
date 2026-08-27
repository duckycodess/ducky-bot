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

export interface SendTarget {
  readonly userId: string;
  readonly channelId?: string;
}

export const text = (content: string, ephemeral = true): OutboundMessage => ({ content, ephemeral });
