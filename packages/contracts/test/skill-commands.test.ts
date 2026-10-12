import { describe, expect, it } from 'vitest';
import {
  AGENT_CARD_LABEL, AGENT_CARD_NEXT, AGENT_CARD_STATUSES, SKILL_COMMANDS,
  isTerminalAgentCardStatus, parseSkillCommand,
} from '../src/skill-commands.js';

describe('recognising a workflow command', () => {
  it('reads exactly the three the owner selected, as the first token', () => {
    expect(SKILL_COMMANDS).toEqual(['$grill-me', '$ticket', '$agentize']);
    for (const command of SKILL_COMMANDS) {
      expect(parseSkillCommand(command)?.command).toBe(command);
      expect(parseSkillCommand(`  ${command}  `)?.command).toBe(command);
    }
  });

  it('keeps the rest of the message as arguments', () => {
    const parsed = parseSkillCommand('$ticket add a health endpoint to the API');
    expect(parsed?.command).toBe('$ticket');
    expect(parsed?.args).toBe('add a health endpoint to the API');
    expect(parsed?.ready).toBe(false);
  });

  it('refuses a token that merely starts with a command name', () => {
    for (const text of ['$ticketing now', '$ticket:', '$agentized', '$grill-men']) {
      expect(parseSkillCommand(text), text).toBeUndefined();
    }
  });

  it('refuses anything but the FIRST position', () => {
    for (const text of [
      'please $ticket this',
      'I was going to $agentize it',
      'we should run $grill-me later',
    ]) {
      expect(parseSkillCommand(text), text).toBeUndefined();
    }
  });

  it('treats a fenced block, a quote and an inline code span as data', () => {
    for (const text of [
      '```\n$ticket do the thing\n```',
      '~~~\n$agentize\n~~~',
      '> $ticket do the thing',
      '>>> $grill-me',
      '`$ticket`',
      '  > $ticket',
    ]) {
      expect(parseSkillCommand(text), text).toBeUndefined();
    }
  });

  it('reads ordinary English as ordinary English', () => {
    for (const text of [
      'implement this',
      'ticket it',
      'queue it',
      'make this agent ready',
      'can you agentize the repo',
      'grill me about the design',
    ]) {
      expect(parseSkillCommand(text), text).toBeUndefined();
    }
  });
});

describe('queue authorization is never inferred', () => {
  it('sets ready only for a bare --ready token on $ticket', () => {
    expect(parseSkillCommand('$ticket --ready')?.ready).toBe(true);
    expect(parseSkillCommand('$ticket fix the parser --ready')?.ready).toBe(true);
    expect(parseSkillCommand('$ticket fix the parser')?.ready).toBe(false);
  });

  it('ignores --ready inside code, where it is somebody describing a flag', () => {
    expect(parseSkillCommand('$ticket run `workflow.py ticket --ready` later')?.ready).toBe(false);
    expect(parseSkillCommand('$ticket\n```\n--ready\n```')?.ready).toBe(false);
  });

  it('never reads --ready for the other two commands', () => {
    expect(parseSkillCommand('$agentize --ready')?.ready).toBe(false);
    expect(parseSkillCommand('$grill-me --ready')?.ready).toBe(false);
  });

  it('strips recognised flags out of the argument text', () => {
    const parsed = parseSkillCommand('$ticket --ready fix the parser');
    expect(parsed?.args).toBe('fix the parser');
  });

  it('reads no other flag at all', () => {
    // An unrecognised flag is ordinary argument text, not a silent option.
    expect(parseSkillCommand('$ticket --force')?.args).toBe('--force');
  });
});

describe('a card status says one thing and not another', () => {
  it('labels and next-steps every status', () => {
    for (const status of AGENT_CARD_STATUSES) {
      expect(AGENT_CARD_LABEL[status], status).toBeTruthy();
      expect(AGENT_CARD_NEXT[status], status).toBeTruthy();
    }
  });

  it('never describes queueing as running, or publication as queueing', () => {
    expect(AGENT_CARD_LABEL.queued.toLowerCase()).not.toContain('running');
    expect(AGENT_CARD_LABEL.queued.toLowerCase()).not.toContain('started');
    // `published` may mention queueing, but only to deny it.
    expect(AGENT_CARD_LABEL.published).toMatch(/not queued/i);
    // And the next-step copy states what queueing does NOT prove.
    expect(AGENT_CARD_NEXT.queued).toMatch(/not evidence that a worker has started/i);
    expect(AGENT_CARD_NEXT.published).toMatch(/does not authorize implementation/i);
  });

  it('treats only finished statuses as terminal', () => {
    expect(isTerminalAgentCardStatus('published')).toBe(true);
    expect(isTerminalAgentCardStatus('queued')).toBe(true);
    expect(isTerminalAgentCardStatus('failed')).toBe(true);
    expect(isTerminalAgentCardStatus('scanning')).toBe(false);
    expect(isTerminalAgentCardStatus('grilling')).toBe(false);
    expect(isTerminalAgentCardStatus('publishing')).toBe(false);
  });
});

describe('classification is named by the owner, never chosen', () => {
  it('reads repeatable --label values and keeps them out of the intent', () => {
    const parsed = parseSkillCommand('$ticket --label bug --label documentation fix the parser');
    expect(parsed?.labels).toEqual(['bug', 'documentation']);
    // The flag AND its value are gone from the text the ticket is built from.
    expect(parsed?.args).toBe('fix the parser');
  });

  it('de-duplicates and bounds them', () => {
    const parsed = parseSkillCommand(
      '$ticket --label bug --label bug --label a --label b --label c --label d work',
    );
    expect(parsed?.labels).toEqual(['bug', 'a', 'b', 'c']);
  });

  it('names nothing for a trailing flag or a flag-shaped value', () => {
    expect(parseSkillCommand('$ticket fix the parser --label')?.labels).toEqual([]);
    expect(parseSkillCommand('$ticket --label --ready fix it')?.labels).toEqual([]);
    // ...and --ready is still read, because it is a bare token of its own.
    expect(parseSkillCommand('$ticket --label --ready fix it')?.ready).toBe(true);
  });

  it('ignores a --label inside code, like every other flag', () => {
    expect(parseSkillCommand('$ticket run `--label bug` later')?.labels).toEqual([]);
  });

  it('reads no label for the other two commands', () => {
    expect(parseSkillCommand('$agentize --label bug')?.labels).toEqual([]);
    expect(parseSkillCommand('$grill-me --label bug')?.labels).toEqual([]);
  });
});
