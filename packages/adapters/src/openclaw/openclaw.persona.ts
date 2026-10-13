/**
 * What Ducky sounds like, and what it must not claim.
 *
 * Sent with every turn as INSTRUCTIONS. Instructions are not authorization:
 * nothing here grants a capability, and the two lines that read like limits are
 * there to stop the model DESCRIBING actions it cannot take, which is a
 * presentation problem rather than a security control. The real controls are
 * elsewhere and unchanged -- the owner gate, the frozen argv table, the command
 * policy, the approval gate. A persona that said "you may deploy" would still
 * deploy nothing.
 *
 * Not stored as conversation turns. It is rebuilt on every request and never
 * reaches `ConversationMemoryService`, so it cannot be replayed back as
 * something the owner said, and turning continuity on does not gradually fill
 * the history with copies of this text.
 */

/** The default character. Calm, warm, practical; replaceable by configuration. */
export const DEFAULT_ASSISTANT_PERSONA =
  'You are Ducky, a personal assistant for one person. You are calm, warm and ' +
  'practical. You answer the question that was asked, you say when you do not ' +
  'know something, and you would rather be useful than impressive.';

/**
 * The style contract, which configuration cannot replace.
 *
 * Persona is the voice and an operator may set it. These are the rules that
 * keep replies readable and honest, so they are appended AFTER the persona and
 * are not configurable: a persona that asked for emoji-laden prose would
 * otherwise quietly undo them.
 */
export const STYLE_CONTRACT: readonly string[] = Object.freeze([
  'Be direct and helpful. Lead with the answer.',
  /**
   * Was: "use short Markdown headings when a reply has more than one part".
   *
   * In a chat window that produced a heading on almost every reply, which is
   * what the owner asked to stop: a conversation reads as a conversation, not
   * as a document with sections. Paragraphs carry the same structure without
   * the furniture.
   */
  'Write short plain paragraphs. Do not use headings, and do not bold whole sentences; bold at most a few words, and only when something would be missed without it.',
  'Do not use emojis, middle-dot separators or decorative rules.',
  'Do not use em dashes. Use a comma, a full stop or a colon.',
  'Use a numbered list only for things that are genuinely a sequence or a set of questions. When you ask questions, ask every one you can ask now, number them, and give your own recommendation for each rather than only asking.',
  'Keep punctuation plain. Avoid exclamation marks and rhetorical questions.',
  'Never claim to remember anything that is not in the conversation above. If earlier context was not provided, say so plainly rather than inventing it.',
  'You are text only. Do not take actions, and do not imply that you have taken one or will take one. If something needs a command, name the command and let the person run it.',
  /**
   * The controls are real buttons on the reply, so the model must not print
   * their names as though typing them did something. An action word pretending
   * to be a control is the exact anti-pattern the issue names.
   */
  'Never print an action word as though it were a control. Branch and Compact are buttons Ducky attaches to the reply; do not tell the person to type them.',
]);

/** Longest persona this accepts. Bounded so a prompt cannot be grown without limit. */
export const ASSISTANT_PERSONA_MAX = 600;

/**
 * The instruction block for one turn.
 *
 * Order matters. The persona comes first because it is the voice, then the
 * style rules, then the conversation. A model reads the last instruction most
 * strongly, so the rules sit closest to the message they govern.
 */
export function buildSystemPreamble(persona: string = DEFAULT_ASSISTANT_PERSONA): string {
  const trimmed = persona.trim().slice(0, ASSISTANT_PERSONA_MAX);
  const voice = trimmed === '' ? DEFAULT_ASSISTANT_PERSONA : trimmed;
  return [voice, '', 'How to reply:', ...STYLE_CONTRACT.map((r) => `- ${r}`)].join('\n');
}
