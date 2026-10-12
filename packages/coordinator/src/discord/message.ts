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
  /**
   * A 24-bit colour, chosen by the PRESENTER from `DUCKY_COLORS`.
   *
   * Never derived from message content. A reply that could pick its own colour
   * would be output influencing its own presentation, and the sanitizer drops
   * anything that is not a plain integer in range rather than clamping it.
   */
  readonly color?: number;
}

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

/**
 * A button, which is EITHER a signed control or a link, never both.
 *
 * A discriminated union rather than two optional fields, because the
 * difference matters: a signed control acts on the owner's behalf and is
 * verified on the way back in; a link acts on nobody's behalf and never
 * reaches Ducky again. Expressing both on one object would make "which is
 * this?" a question with a wrong answer available.
 */
export interface OutboundControlButton {
  readonly customId: string;
  readonly label: string;
  readonly style?: ButtonStyle;
}

/**
 * A link button. Carries no custom id, so it cannot act and cannot be
 * replayed; the sanitizer restricts the URL to the exact hosts a Ducky message
 * is ever allowed to point at.
 */
export interface OutboundLinkButton {
  readonly url: string;
  readonly label: string;
}

export type OutboundButton = OutboundControlButton | OutboundLinkButton;

export const isLinkButton = (b: OutboundButton): b is OutboundLinkButton =>
  'url' in b && typeof b.url === 'string';

/**
 * The signed id of a control button, or the empty string for a link.
 *
 * A narrowing helper for the many callers that only ever deal in controls.
 * Returning '' rather than throwing is deliberate: a link where a control was
 * expected is a presentation mistake, and an empty id simply fails
 * verification like any other invalid one.
 */
export const controlId = (b: OutboundButton | undefined): string =>
  b && !isLinkButton(b) ? b.customId : '';

/** The style of a control button, or undefined for a link. */
export const controlStyle = (b: OutboundButton | undefined): ButtonStyle | undefined =>
  b && !isLinkButton(b) ? b.style : undefined;

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
