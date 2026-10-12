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
/** Validate and render without any GitHub mutation. */
export const DRAFT_FLAG = '--draft';

/** How much of a message is ever read as a command. Bounds the parser's work. */
export const SKILL_COMMAND_INPUT_MAX = 4_000;
/** How much argument text is kept. The rest of the thread carries the intent. */
export const SKILL_COMMAND_ARGS_MAX = 2_000;

export interface ParsedSkillCommand {
  readonly command: SkillCommand;
  /** Everything after the token, with recognised flags removed. */
  readonly args: string;
  /** True only when `--ready` was typed as a bare token by the owner. */
  readonly ready: boolean;
  /** True only when `--draft` was typed as a bare token by the owner. */
  readonly draft: boolean;
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
 * Removes code spans and fenced blocks before flag scanning.
 *
 * `--ready` inside a pasted command line is somebody describing the flag, not
 * the owner authorizing a queue. Scanning the stripped text means the only way
 * to queue is to type the flag in the clear.
 */
const stripCode = (s: string): string =>
  s.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ').replace(/`[^`\n]*`/g, ' ');

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

  const rest = (match[2] ?? '').slice(0, SKILL_COMMAND_ARGS_MAX);
  const scannable = stripCode(rest);
  const tokens = scannable.split(/\s+/).filter(Boolean);

  // Flags are only ever recognised for the command that defines them, and
  // only as bare tokens.
  const ready = token === '$ticket' && tokens.includes(READY_FLAG);
  const draft = token === '$ticket' && tokens.includes(DRAFT_FLAG);

  const args = rest
    .split(/\s+/)
    .filter((t) => t !== READY_FLAG && t !== DRAFT_FLAG)
    .join(' ')
    .trim();

  return { command: token, args, ready, draft };
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
