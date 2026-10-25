import path from 'node:path';
import { FileDispatchJournal } from './dispatch-journal-file.js';
import { FilePauseIntentStore } from './pause-intents.js';
import { StateDir, type OpenStateOptions } from './state-store.js';

/** Pause intents are few by construction: at most one per job, and claims stop while any is pending. */
const MAX_INTENTS = 64;
/** One journal record per job this profile has touched; bounded, and refused beyond it. */
const MAX_JOURNAL = 1024;

export interface ExecutorState {
  readonly intents: FilePauseIntentStore;
  readonly journal: FileDispatchJournal;
}

/**
 * Opens this profile's durable executor state at an EXPLICIT directory. There is
 * deliberately no default: a path derived from the executor id alone would
 * collide across profiles that share one, and an implicit location is how state
 * ends up in a directory a cleanup timer owns.
 */
export function openExecutorState(root: string, opts: OpenStateOptions): ExecutorState {
  StateDir.open(root, { ...opts, maxRecords: 1 });
  return {
    intents: new FilePauseIntentStore(
      StateDir.open(path.join(root, 'pause-intents'), { ...opts, maxRecords: MAX_INTENTS }),
    ),
    journal: new FileDispatchJournal(
      StateDir.open(path.join(root, 'dispatch-journal'), { ...opts, maxRecords: MAX_JOURNAL }),
    ),
  };
}
