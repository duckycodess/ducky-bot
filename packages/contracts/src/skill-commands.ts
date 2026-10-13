/**
 * The three repository-workflow commands, and the rule that decides when a
 * message IS one.
 *
 * WHY A CLOSED SET. The owner selected exactly `$grill-me`, `$ticket` and
 * `$agentize`. Nothing here invents a fourth, and nothing here is a synonym
 * table: a message either opens with one of these three tokens or it does not
 * address the workflow at all. "implement this", "ticket it" and "queue it"
 * are ordinary English and are deliberately NOT triggers -- an engineering job
 * that can be started by a sentence is a job that can be started by accident,
 * by a pasted log line, or by somebody quoting the owner.
 *
 * WHY THE FIRST UNQUOTED TOKEN. A Discord message carries other people's text:
 * code blocks, pasted diffs, quoted replies, GitHub notification bodies. All
 * of that is DATA. So recognition reads one position -- the very first token of
 * the message -- and refuses every form where that position is inside quoted
 * or code context. A `$ticket` in the middle of a paragraph is a mention of the
 * command, not a use of it.
 */

export const SKILL_COMMANDS = ['$grill-me', '$ticket', '$agentize'] as const;
export type SkillCommand = (typeof SKILL_COMMANDS)[number];

export const isSkillCommand = (s: string): s is SkillCommand =>
  (SKILL_COMMANDS as readonly string[]).includes(s);

/**
 * The ONE flag that authorizes queueing, and the only flag recognised at all.
 *
 * Queue authorization is never inferred: `--ready` has to be typed, as its own
 * token, in the owner's own `$ticket` message. The installed publisher applies
 * the exact `agent:ready` label only when it is passed through.
 */
export const READY_FLAG = '--ready';
/**
 * A classification label for the issue, repeatable.
 *
 * It exists because the alternative is worse. The installed publisher can
 * apply and verify classification labels, but CHOOSING one means deciding
 * whether a piece of work is a bug or an enhancement -- and Ducky inferring
 * that from a sentence would be exactly the guess every other rule here
 * refuses to make. So the owner names it or nothing is classified, and
 * `agent:*` is refused outright because that namespace belongs to the
 * dispatcher and `agent:ready` is the one thing a classification must never
 * be able to apply.
 */
export const LABEL_FLAG = '--label';
/** Bounded: a ticket with a dozen classifications is not classified. */
export const SKILL_COMMAND_MAX_LABELS = 4;

/** How much of a message is ever read as a command. Bounds the parser's work. */
export const SKILL_COMMAND_INPUT_MAX = 4_000;
/** How much argument text is kept. The rest of the thread carries the intent. */
export const SKILL_COMMAND_ARGS_MAX = 2_000;

export interface ParsedSkillCommand {
  readonly command: SkillCommand;
  /** Everything after the token, with recognised flags removed. */
  readonly args: string;
  /**
   * True only when `--ready` was typed as a bare token by the owner.
   *
   * Never derived from text, and never from a `--ready` inside a code span.
   */
  readonly ready: boolean;
  /**
   * Classification labels the owner named, in order, de-duplicated.
   *
   * Empty is the common case and means nothing is classified. `--ready` and
   * `--label` are the only two flags this parser recognises; anything else is
   * argument text, because the owner selected three commands and inventing
   * further options would be the new command surface the ticket's non-goals
   * rule out.
   */
  readonly labels: readonly string[];
}

/**
 * Whether the message's first token sits in quoted or code context.
 *
 * Checked against the RAW message, before any trimming that could move the
 * first token out of a fence.
 */
function firstTokenIsQuoted(raw: string): boolean {
  // A fenced block that opens the message. Everything inside it is data,
  // including a line that looks exactly like a command.
  if (/^\s*(?:```|~~~)/.test(raw)) return true;
  // A Discord quote (`> `) or a block quote (`>>> `). Quoting somebody is the
  // clearest possible statement that the words are not yours.
  if (/^\s*>/.test(raw)) return true;
  // An inline code span opening the message: `$ticket` is a mention of the
  // command, not a use of it.
  if (/^\s*`/.test(raw)) return true;
  return false;
}

/**
 * Removes everything that is somebody else's words before the flag scan.
 *
 * Two kinds, and the second was missed at first with real consequences.
 *
 * CODE: `--ready` inside a pasted command line is somebody describing the
 * flag, not the owner authorizing a queue.
 *
 * QUOTES: recognition already refuses a message whose FIRST token is quoted,
 * but the scan ran over every later line unchanged -- so quoting somebody who
 * had written `--ready` authorized a queue in their name. A quote is data
 * wherever it appears in the message, not only at the top, and that has to be
 * true of the argument text as well as of the flags: a quoted line must not
 * become part of what the ticket says the work IS.
 */
const stripQuoted = (s: string): string =>
  s
    // A fenced block is somebody's pasted output, wherever it sits.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // Any line whose first non-space character is `>`: a Discord quote, a
    // block quote, or a nested one.
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');

/**
 * Additionally removes inline code, for the FLAG scan only.
 *
 * An inline code span is still the owner's own writing -- `` `parseWhen` ``
 * in a sentence is them naming a function, and dropping it would quietly
 * remove a word from the ticket they are writing. It is simply not a place a
 * flag can be typed, so it is stripped where flags are read and kept where
 * intent is read.
 */
const stripInlineCode = (s: string): string => s.replace(/`[^`\n]*`/g, ' ');

/**
 * Reads one message as a workflow command, or declines to.
 *
 * `undefined` is the answer for almost every message, and for every message
 * whose first token is quoted, fenced, inline-coded or simply something else.
 */
export function parseSkillCommand(text: string): ParsedSkillCommand | undefined {
  if (typeof text !== 'string') return undefined;
  if (text.length === 0 || text.length > SKILL_COMMAND_INPUT_MAX) return undefined;
  if (firstTokenIsQuoted(text)) return undefined;

  const trimmed = text.trimStart();
  // The first WHITESPACE-DELIMITED token. Not a prefix match: `$ticketing`
  // and `$ticket:` are different words and neither is the command.
  const match = /^(\S+)([\s\S]*)$/.exec(trimmed);
  if (!match) return undefined;

  const token = match[1]!;
  if (!isSkillCommand(token)) return undefined;

  /**
   * The owner's OWN words only, for both the flags and the intent.
   *
   * One stripped string feeds both, so there is no way for a line to be
   * ignored by the flag scan and still reach the ticket body, or the reverse.
   */
  const rest = stripQuoted((match[2] ?? '').slice(0, SKILL_COMMAND_ARGS_MAX));
  const tokens = stripInlineCode(rest).split(/\s+/).filter(Boolean);

  // Recognised only for the command that defines them, and only as bare
  // tokens outside code.
  const ready = token === '$ticket' && tokens.includes(READY_FLAG);
  const labels = token === '$ticket' ? labelsIn(tokens) : [];

  /**
   * Flags and their values are removed from the argument text.
   *
   * `--label` takes the NEXT token, so that token must not also survive as
   * part of the intent -- a ticket whose goal began "bug" because the owner
   * classified it would be a sentence they did not write.
   */
  const words = rest.split(/\s+/);
  const args: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (word === READY_FLAG) continue;
    if (word === LABEL_FLAG) {
      i += 1;
      continue;
    }
    args.push(word);
  }

  return { command: token, args: args.join(' ').trim(), ready, labels };
}

/**
 * The labels named by `--label <name>` tokens, bounded and de-duplicated.
 *
 * A trailing `--label` with nothing after it names nothing, and a value that
 * is itself a flag is not a label: both produce no classification rather than
 * a guess at what was meant.
 */
function labelsIn(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length && out.length < SKILL_COMMAND_MAX_LABELS; i += 1) {
    if (tokens[i] !== LABEL_FLAG) continue;
    const value = tokens[i + 1];
    if (value === undefined || value.startsWith('-')) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Every honest status an agent card may report, and nothing that could be
 * mistaken for one of the others.
 *
 * The distinctions here are the acceptance criteria written as a type:
 *
 * - `scanning` is a read of the repository. It changes nothing.
 * - `grilling` is a conversation. It writes no issue, no label, no worker.
 * - `publishing` is the installed publisher running.
 * - `published` is a GitHub issue that exists and is NOT queued.
 * - `queued` is the exact `agent:ready` label verified on the issue. It says
 *   NOTHING about whether a worker started -- there is a separate word for
 *   that and Ducky never uses it, because Ducky never observes it.
 * - `onboarded` is `$agentize` having completed. It started no service.
 */
export const AGENT_CARD_STATUSES = [
  'scanning',
  'grilling',
  'publishing',
  'published',
  'queued',
  'onboarding',
  'onboarded',
  'needs_input',
  'failed',
  'cancelled',
] as const;
export type AgentCardStatus = (typeof AGENT_CARD_STATUSES)[number];

/** Terminal statuses. A fresh notification is sent when one is reached. */
export const AGENT_CARD_TERMINAL: readonly AgentCardStatus[] = [
  'published', 'queued', 'onboarded', 'needs_input', 'failed', 'cancelled',
];

export const isTerminalAgentCardStatus = (s: AgentCardStatus): boolean =>
  AGENT_CARD_TERMINAL.includes(s);

/**
 * The owner-facing label for each status.
 *
 * Written out rather than derived, because the WORDS are the contract. "Queued"
 * must never render as "running", and "published" must never render as
 * "queued": the whole point of the installed publisher's two-step
 * authorization is lost if the card flattens them.
 */
export const AGENT_CARD_LABEL: Record<AgentCardStatus, string> = {
  scanning: 'Reading the repository',
  grilling: 'Grilling',
  publishing: 'Publishing the ticket',
  published: 'Issue created, not queued',
  queued: 'Queued for implementation',
  onboarding: 'Onboarding the repository',
  onboarded: 'Repository onboarded',
  needs_input: 'Needs your answer',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * What happens next, in the owner's own terms.
 *
 * `queued` is the sentence that matters: it states what queueing does and does
 * not prove, because "queued" reads like "started" to everyone who has not
 * read the dispatcher's documentation.
 */
export const AGENT_CARD_NEXT: Record<AgentCardStatus, string> = {
  scanning: 'Nothing has been created yet.',
  grilling: 'Reply to continue. No issue, label or worker is created by grilling.',
  publishing: 'Nothing is authorized yet.',
  published: 'Creating the issue does not authorize implementation. Send `$ticket --ready` to queue it.',
  queued:
    'The agent:ready label is verified on the issue. That authorizes implementation; it is not ' +
    'evidence that a worker has started, and Ducky does not start one.',
  onboarding: 'No service is started or restarted by onboarding.',
  onboarded: 'Create work with `$ticket`. Onboarding adds no agent:ready label.',
  needs_input: 'Answer in this thread, then run the command again.',
  failed: 'Nothing was queued and nothing was started.',
  cancelled: 'Nothing further will happen for this request.',
};

/**
 * What is known about the `agent:ready` label after a `$ticket` run.
 *
 * Four states, not a boolean, because a boolean cannot say "I do not know" --
 * and that is exactly the state a publisher that wrote the label and then
 * failed to read it back leaves behind. Reporting that as "not queued" is a
 * false negative about the one label that authorizes an agent to start work.
 */
export const QUEUE_STATES = ['not_requested', 'not_queued', 'queued', 'unknown'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** What each state means to the owner, written out because the words matter. */
export const QUEUE_STATE_LABEL: Record<QueueState, string> = {
  not_requested: 'Not requested. The issue, if any, is unqueued.',
  not_queued: 'Not applied. The run stopped before any label could be written.',
  queued: 'agent:ready is applied and was verified on the issue.',
  unknown:
    'UNKNOWN. The label may have been applied before the failure and could not be confirmed. ' +
    'Open the issue and check for agent:ready before assuming either way.',
};
