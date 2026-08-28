/**
 * What a provider says about an attachment BEFORE it ever sees one.
 *
 * Declared rather than inferred, and consulted before a single byte is
 * requested. A provider that cannot read attachments says so here, and the
 * coordinator's refusal then happens on metadata alone -- no download, no
 * temporary file, no bandwidth.
 */
export interface AttachmentCapability {
  /** False unless the provider can genuinely accept bytes today. */
  readonly supported: boolean;
  /** Exact, normalized MIME types. Empty whenever `supported` is false. */
  readonly contentTypes: readonly string[];
  /**
   * The provider's own ceiling. The coordinator takes the SMALLER of this and
   * its configured cap, so neither side can be talked past the other.
   */
  readonly maxBytes: number;
}

export interface ConversationCapabilities {
  readonly attachments: AttachmentCapability;
}

/** A capability object for a provider that cannot take attachments at all. */
export const NO_ATTACHMENT_CAPABILITY: AttachmentCapability = Object.freeze({
  supported: false,
  contentTypes: Object.freeze([]) as readonly string[],
  maxBytes: 0,
});

export interface ConversationAttachmentMetadata {
  readonly filename: string;
  /** Already normalized, and already on the agreed allowlist. */
  readonly contentType: string;
  readonly byteLength: number;
}

/**
 * A provider-agnostic view of one attachment's bytes.
 *
 * Deliberately NOT a filesystem path and NOT a base64 string. Either would
 * bake one provider's transport into the port: a path assumes the provider
 * runs on this host and can read our temp directory, base64 assumes it wants
 * the whole payload inlined in a request body. Both are decisions for an
 * adapter, not for the contract, and the roadmap flagged exactly this as the
 * choice that would shape the port.
 *
 * So the port offers metadata plus one bounded read. An adapter that needs a
 * file writes one; an adapter that needs base64 encodes one. Neither is owed
 * anything by the coordinator.
 *
 * **Lifetime is explicit and belongs to the caller, not the provider.** The
 * handle is valid only for the duration of the `reply` call it was passed to.
 * A provider that stashes it and reads afterwards gets a thrown error rather
 * than bytes -- see `ManagedConversationAttachment`.
 */
export interface ConversationAttachment {
  readonly metadata: ConversationAttachmentMetadata;
  /**
   * Reads the payload, at most `maxBytes` (default: all of it, which the
   * coordinator has already capped).
   *
   * Throws once the handle has been disposed. Callers must not retain the
   * result beyond what they need: these are the owner's personal bytes.
   */
  read(maxBytes?: number): Promise<Uint8Array>;
}

/**
 * The coordinator-side handle, which additionally owns the lifetime.
 *
 * `dispose` is on THIS interface and not on `ConversationAttachment` on
 * purpose: a provider is handed the narrower type, so it is structurally
 * unable to extend, keep alive or free the resource. Whoever created the
 * bytes destroys them, in a `finally`, on success and on failure alike.
 */
export interface ManagedConversationAttachment extends ConversationAttachment {
  /** Idempotent. After it resolves, every `read` throws. */
  dispose(): Promise<void>;
}

/**
 * One earlier turn of the SAME conversation, supplied as context.
 *
 * DCStro's rule, kept: only the owner's own messages and Ducky's own output can
 * ever appear here, because anyone who can post in a channel can post in a
 * thread on it. The coordinator enforces that by scoping every stored turn to
 * one (user, thread) -- a provider is handed history, never a way to ask for
 * somebody else's.
 */
export interface ConversationHistoryTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface ConversationInput {
  readonly userId: string;
  readonly text: string;
  readonly threadKey: string;
  /**
   * Earlier turns of this conversation, oldest first, already bounded by the
   * coordinator. Absent when continuity is disabled, when this is the first
   * message of a thread, or when the thread is not one memory applies to.
   *
   * Optional so a provider that ignores context is still correct: continuity is
   * the coordinator's feature, and a provider is never obliged to use it.
   */
  readonly history?: readonly ConversationHistoryTurn[];
  /**
   * Present only when the provider is verified, attachment-capable, the
   * operator has opted in, and the sender is the owner. Valid for the
   * duration of this call only.
   */
  readonly attachment?: ConversationAttachment;
}

export interface ConversationReply {
  readonly text: string;
  /** True when the reply came from a stand-in rather than a real gateway. */
  readonly mock: boolean;
}

export interface ConversationProvider {
  readonly name: string;
  /** Reported by /status and the startup diagnostics so the owner always knows. */
  readonly verified: boolean;
  /**
   * What this provider can actually do. Read before anything is fetched.
   * Required rather than optional so a new provider must state its position
   * instead of defaulting into one.
   */
  readonly capabilities: ConversationCapabilities;
  reply(input: ConversationInput): Promise<ConversationReply>;
}

/**
 * The single gate the router consults before it will fetch any bytes.
 *
 * All three conditions, and `verified` is not negotiable: a provider whose API
 * has never been exercised must not be sent the owner's personal files on the
 * strength of a capability flag it also wrote itself.
 */
export function attachmentsUsable(
  provider: ConversationProvider,
  operatorEnabled: boolean,
): boolean {
  return operatorEnabled && provider.verified && provider.capabilities.attachments.supported;
}
