import { ImportedPreferencesSchema, type ImportedPreferences } from '@ducky/contracts';
import type { Store } from '@ducky/persistence';

export interface OwnerPreferencesServiceDeps {
  readonly store: Store;
  /** Frozen configuration: the CONFIGURED owner, never a stored row. */
  readonly ownerId: string;
  /**
   * Whether the active profile selected imported preferences. Off by default:
   * nothing stored here changes behavior until an operator says so.
   */
  readonly enabled: boolean;
}

/**
 * Reads the owner's imported preferences, and says nothing about authority.
 *
 * Preferences are presentation and scheduling choices. Nothing here, and
 * nothing that calls it, decides whether anybody may do anything: authorization
 * reads frozen configuration only. A row that does not parse is read as ABSENT,
 * which is the native default, never as a half-applied setting.
 */
export class OwnerPreferencesService {
  constructor(private readonly deps: OwnerPreferencesServiceDeps) {}

  get enabled(): boolean {
    return this.deps.enabled;
  }

  /** The preferences in force, or undefined when none apply. */
  effective(): ImportedPreferences | undefined {
    if (!this.deps.enabled) return undefined;
    const row = this.deps.store.ownerPreferences.get(this.deps.ownerId);
    if (!row) return undefined;
    try {
      const parsed = ImportedPreferencesSchema.safeParse(JSON.parse(row.prefsJson));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** The default reminder offsets a policy-bearing task defers to. */
  defaultReminderOffsets(): readonly number[] | undefined {
    return this.effective()?.defaultReminderOffsetsMinutes;
  }
}
