import type { WatchSurface } from '@ducky/contracts';
import type { ReviewTarget } from './assistant-watch.engine.js';

/**
 * Where a read stands INSIDE one surface of one target, between two requests.
 *
 * A unit of work is one request, so a read that needs several (pages of a list,
 * a pull request's reviews, a re-read to prove the window held still) has to
 * remember where it is. This is that memory: small, JSON, owned by the service
 * and stored beside the checkpoint, cleared whenever a window commits or a pass
 * restarts. It never holds a repository's content, only item keys and numbers.
 */
export interface ScanState {
  readonly v: 1;
  /** The branch a commits or runs pass follows, fixed for the whole pass. */
  readonly branch?: string;
  /** The last LIST page read, with the keys of its items, for the end-of-window check. */
  readonly last?: { readonly page: number; readonly keys: readonly string[] };
  /** The window closed; the next request re-reads `last.page` and compares it. */
  readonly verify?: boolean;
  /** The window closed on the last list page, but reviews remain to be read first. */
  readonly closing?: boolean;
  /** The provider's total on the first page, where it gives one. */
  readonly total?: number | null;
  /** The oldest unsettled item's creation time (ms) seen so far this pass. */
  readonly floorMs?: number | null;
  /** What the newest NEW conclusion on a runs pass said. */
  readonly ci?: 'failing' | 'passing' | null;
  /** Pull requests whose reviews remain to be read, in order. */
  readonly queue?: readonly ReviewTarget[];
  /** Progress through the review pages of `queue[0]`. */
  readonly rv?: { readonly page: number; readonly changes: boolean };
}

export const EMPTY_SCAN: ScanState = Object.freeze({ v: 1 }) as ScanState;

export function parseScan(json: string | null): ScanState {
  if (json === null) return EMPTY_SCAN;
  try {
    const v = JSON.parse(json) as unknown;
    if (v && typeof v === 'object' && (v as { v?: unknown }).v === 1) return v as ScanState;
  } catch {
    /* an unreadable state is a fresh read: the cursor was never touched */
  }
  return EMPTY_SCAN;
}

export const serializeScan = (s: ScanState): string => JSON.stringify(s);

/**
 * The key of an item for the end-of-window check.
 *
 * Lists sorted on an update time move an item to the top when it changes, so its
 * key includes that time. Runs and releases sort on creation, which never
 * changes, so their key is the identity alone: an update that does not move an
 * item is not drift.
 */
export type KeyedItem =
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'pull' | 'issue'; readonly number: number; readonly updatedAt: string }
  | { readonly kind: 'run' | 'release'; readonly id: string };

export const keyOf = (i: KeyedItem): string => {
  switch (i.kind) {
    case 'commit': return i.sha;
    case 'pull': return `p${i.number}@${i.updatedAt}`;
    case 'issue': return `i${i.number}@${i.updatedAt}`;
    case 'run': return `r${i.id}`;
    case 'release': return `e${i.id}`;
  }
};

/**
 * Whether a page re-read at the END of a window shows the window held still.
 *
 * Lists are newest-first, so the only change that does not lose an item is an
 * INSERTION above the page: everything already read shifts DOWN. A deletion above
 * shifts the next page UP, so its first item slides into a page that was already
 * read and is never seen. Re-reading the last page and comparing proves which
 * happened, because the page then holds the original items shifted down by the
 * number of new ones (possibly pushing the tail off it), or exactly as it was.
 *
 * Anything else (an item gone, an item moved, a different order) is drift, and
 * the pass is thrown away. One mix this cannot tell apart is a deletion and
 * insertions that cancel out between the first read and the re-read; that is a
 * documented residual, not a claim of proof.
 */
export function windowHeldStill(original: readonly string[], again: readonly string[]): boolean {
  // Nothing was read on that page, or nothing is on it now: no item can have
  // slid past a boundary into a page that was already read.
  if (original.length === 0 || again.length === 0) return true;
  for (let shift = 0; shift < again.length; shift += 1) {
    const rest = again.slice(shift);
    // `rest` is the original page shifted down by `shift` new items, possibly with
    // its tail pushed onto the next page, so it must be a PREFIX of the original.
    if (rest.length <= original.length && rest.every((k, i) => k === original[i])) return true;
  }
  return false;
}

/** Pages a window may span, by surface, before it is called too deep to prove. */
export type PageCaps = Readonly<Partial<Record<WatchSurface, number>>>;
