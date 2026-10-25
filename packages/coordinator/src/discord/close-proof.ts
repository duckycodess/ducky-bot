import { TRUNCATION_MARKER } from '@ducky/contracts';
import type { DigestClose } from '../domain/assistant-watch.service.js';
import { GITHUB_BRIEFING_FIELD } from './assistant-presenters.js';
import type { OutboundMessage } from './message.js';

/**
 * Which pull request closes a briefing ACTUALLY SHOWS, proven from the final output (ADR 0034, migration 39).
 *
 * A digest line is not final output: a line can be cut by the per-repository cap, a repository can be dropped, the
 * field can be clamped, and the redactor can rewrite text. So a close earns a receipt only when its exact number and
 * its literal canonical UTC instant (the ISO text with milliseconds, never a rounded timestamp) are byte-exact inside
 * ONE retained close line, under its own repository heading, of the message the transport will actually send.
 *
 * `final` must be `sanitizeOutbound(briefingMessage(body))` with the redactor the transport uses (its default): the
 * proof reads the output after every cut and redaction, so there is no second transformation that could undo it. The
 * last line of a clamped field is treated as cut, never as shown. Two repositories that share a bare name and a close
 * are told apart only by count: if fewer lines survive than closes asked for, none of that group is proven.
 */
const CLOSE_LINE = /^-# PR #([1-9]\d{0,8}) closed (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(?::|$)/;
const HEADING = /^\*\*(.*)\*\*$/;

const groupKey = (heading: string, n: string, at: string): string => `${heading}\u0000${n}\u0000${at}`;

export function proveShownCloses(final: OutboundMessage, closes: readonly DigestClose[]): ReadonlySet<string> {
  const proven = new Set<string>();
  if (closes.length === 0) return proven;

  const shown = new Map<string, number>();
  for (const embed of final.embeds ?? []) {
    for (const field of embed.fields ?? []) {
      if (field.name !== GITHUB_BRIEFING_FIELD) continue;
      let lines = field.value.split('\n');
      // A clamped value ends in the truncation marker: its last line was cut and is not shown in full.
      if (field.value.endsWith(TRUNCATION_MARKER)) lines = lines.slice(0, -1);
      let heading: string | null = null;
      for (const line of lines) {
        if (HEADING.test(line)) {
          heading = line;
          continue;
        }
        if (heading === null) continue;
        const m = CLOSE_LINE.exec(line);
        if (m) {
          const key = groupKey(heading, m[1]!, m[2]!);
          shown.set(key, (shown.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const asked = new Map<string, DigestClose[]>();
  for (const c of closes) {
    const key = groupKey(c.repoHeading, c.n, c.at);
    asked.set(key, [...(asked.get(key) ?? []), c]);
  }
  for (const [key, group] of asked) {
    if ((shown.get(key) ?? 0) >= group.length) for (const c of group) proven.add(c.id);
  }
  return proven;
}
