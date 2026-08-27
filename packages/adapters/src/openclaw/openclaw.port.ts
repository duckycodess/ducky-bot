export interface ConversationInput {
  readonly userId: string;
  readonly text: string;
  readonly threadKey: string;
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
  reply(input: ConversationInput): Promise<ConversationReply>;
}
