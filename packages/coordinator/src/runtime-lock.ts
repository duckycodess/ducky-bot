import { DuckyError } from '@ducky/contracts';
import { acquireRuntimeLock, type Db, type RuntimeLockHandle } from '@ducky/persistence';

/**
 * Takes the coordinator's place as THE writer of this database.
 *
 * The importer takes the same lock, and it cannot while this process holds it,
 * which is what makes "stop the coordinator before importing" something the
 * machine enforces rather than something an operator asserts. A coordinator in
 * turn refuses to start while an import is in progress, or while another
 * coordinator is live on the same database.
 *
 * Throws, so a start-up that cannot be the sole writer fails loudly at boot
 * instead of two writers discovering each other later.
 */
export function takeCoordinatorLock(db: Db): RuntimeLockHandle {
  const out = acquireRuntimeLock(db, 'coordinator');
  if (!out.ok) {
    throw new DuckyError(
      'invalid_input',
      `A live ${out.heldBy} is already writing this database. Stop it first; two writers are never safe.`,
    );
  }
  return out.handle;
}
