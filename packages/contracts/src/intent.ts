/**
 * What a plain message deterministically MEANS, when it means anything.
 *
 * DCStro guessed intent from ordinary messages, rules first and a model only to
 * improve a low-confidence read. The rules half is the good half, and it is the
 * half that needs no provider — so it ships here, and the provider improves
 * nothing until one is verified.
 *
 * Three properties hold everything together:
 *
 * 1. **Deterministic and closed.** A fixed rule table over normalized text.
 *    There is no scoring model, no learned threshold and no free-text fallback:
 *    a message either matches a rule or means nothing, and meaning nothing is
 *    the common case.
 * 2. **An inferred WRITE is never applied.** A matched write intent produces a
 *    PROPOSAL. The owner confirms it in their own words, or it expires. Ducky
 *    reading "remind me to call the bank" and silently creating a reminder is
 *    the failure mode this shape exists to prevent.
 * 3. **Ambiguity refuses.** Two rules matching, or a rule matching without the
 *    fields it needs, produces nothing at all rather than a guess. A wrong task
 *    silently created is worse than no task.
 */

export const INTENT_KINDS = [
  /** Personal-data WRITES. Each needs an explicit confirmation. */
  'task_add',
  'reminder_add',
  'capture',
  /** READS, answered immediately. Owner-only, and none of them generates prose. */
  'briefing',
  'meal',
  'study',
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

/** The three that change stored data, and therefore need confirming. */
export const WRITE_INTENTS = ['task_add', 'reminder_add', 'capture'] as const;
export type WriteIntent = (typeof WRITE_INTENTS)[number];

export const isWriteIntent = (k: IntentKind): k is WriteIntent =>
  (WRITE_INTENTS as readonly IntentKind[]).includes(k);

export interface DetectedIntent {
  readonly kind: IntentKind;
  /** The subject: a task title, a reminder text, a capture body, a topic. */
  readonly subject: string;
  /** A when-expression, exactly as typed. Resolved later, by the service. */
  readonly when?: string;
  /** A repeat expression for a reminder, exactly as typed. */
  readonly every?: string;
}

/** How long a proposal waits for a yes. Short: intent is about right now. */
export const INTENT_PROPOSAL_TTL_MS = 10 * 60_000;
/** One pending proposal per (user, thread). A queue of them would be a trap. */
export const INTENT_SUBJECT_MAX = 300;

const YES = /^(y|yes|yeah|yep|ok|okay|sure|do it|go ahead|confirm|please do)\b[.! ]*$/i;
const NO = /^(n|no|nope|cancel|never ?mind|forget it|stop)\b[.! ]*$/i;

/** An explicit confirmation, and nothing looser. */
export const isAffirmation = (text: string): boolean => YES.test(text.trim());
export const isRefusal = (text: string): boolean => NO.test(text.trim());

/**
 * A trailing time expression, split off so the subject does not swallow it.
 *
 * Only the forms `parseWhen` already accepts are recognised, because a "when"
 * this cannot resolve would produce a proposal that fails on confirmation.
 */
const WHEN_TAIL =
  /\s+(?:at|on|by)?\s*((?:today|tomorrow|tonight|mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?|in\s+\d+\s*(?:m|min|mins|minutes|h|hr|hrs|hours|d|days)|\d{1,2}:\d{2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))\s*$/i;

/** `every 30m`, `every 2 hours`, taken from anywhere in the message. */
const EVERY = /\bevery\s+(\d+\s*(?:m|min|mins|minutes|h|hr|hrs|hours|d|days))\b/i;

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, INTENT_SUBJECT_MAX);

/**
 * The rule table.
 *
 * Ordered, and the first match wins ONLY when no other rule also matches — see
 * `detectIntent`. Each pattern requires a leading verb phrase, so an ordinary
 * sentence that happens to contain "remind" ("that reminds me of the outage")
 * does not become a reminder.
 */
const RULES: readonly { kind: IntentKind; re: RegExp }[] = [
  { kind: 'reminder_add', re: /^remind me (?:to|that|about)\s+(?<subject>.+)$/i },
  { kind: 'reminder_add', re: /^set a reminder (?:to|for|about)\s+(?<subject>.+)$/i },
  { kind: 'task_add', re: /^(?:add|create) a task(?: to| for| called)?\s+(?<subject>.+)$/i },
  { kind: 'task_add', re: /^(?:todo|to-do)[:,]?\s+(?<subject>.+)$/i },
  { kind: 'task_add', re: /^i need to\s+(?<subject>.+)$/i },
  { kind: 'capture', re: /^(?:capture|note|jot down|remember)[:,]?\s+(?<subject>.+)$/i },
  { kind: 'briefing', re: /^(?:what(?:'s| is) (?:on|up) today|my day|brief me|briefing)\b.*$/i },
  { kind: 'meal', re: /^(?:what should i (?:cook|eat)|meal idea|what(?:'s| is) for (?:lunch|dinner|breakfast))\b(?<subject>.*)$/i },
  { kind: 'study', re: /^(?:help me study|study plan(?: for)?|quiz me(?: on)?)\b(?<subject>.*)$/i },
];

/**
 * Reads one message. Returns nothing far more often than something.
 *
 * Ambiguity is resolved by REFUSING: if two rules of different kinds match, the
 * message is not clear enough to act on, and a wrong inference costs more than a
 * missed one.
 */
export function detectIntent(text: string): DetectedIntent | undefined {
  const raw = text.trim();
  if (raw === '' || raw.length > 2_000) return undefined;

  const matches = RULES.map((rule) => ({ rule, m: rule.re.exec(raw) })).filter((x) => x.m !== null);
  if (matches.length === 0) return undefined;

  const kinds = new Set(matches.map((x) => x.rule.kind));
  if (kinds.size > 1) return undefined;

  const first = matches[0]!;
  const kind = first.rule.kind;
  let subject = clean(first.m!.groups?.['subject'] ?? '');

  // A briefing has no subject; the others must have one to be actionable.
  if (kind === 'briefing') return { kind, subject: '' };

  let every: string | undefined;
  const everyMatch = EVERY.exec(subject);
  if (everyMatch && kind === 'reminder_add') {
    every = clean(everyMatch[1]!);
    subject = clean(subject.replace(EVERY, ' '));
  }

  let when: string | undefined;
  const whenMatch = WHEN_TAIL.exec(subject);
  if (whenMatch && (kind === 'reminder_add' || kind === 'task_add')) {
    when = clean(whenMatch[1]!);
    subject = clean(subject.slice(0, whenMatch.index));
  }

  // A reminder with no time cannot be scheduled, and inventing one would be
  // exactly the guess this refuses to make.
  if (kind === 'reminder_add' && when === undefined) return undefined;
  if (subject === '' && kind !== 'meal' && kind !== 'study') return undefined;

  return {
    kind,
    subject,
    ...(when !== undefined ? { when } : {}),
    ...(every !== undefined ? { every } : {}),
  };
}
