import { describe, expect, it } from 'vitest';
import { resolveMigrateDbPath } from '../src/cli/migrate.js';

describe('migrate CLI: profile-aware db path resolution', () => {
  it('defaults to the development database when DUCKY_PROFILE is unset', () => {
    expect(resolveMigrateDbPath({} as NodeJS.ProcessEnv)).toBe('./data/ducky-dev.db');
  });

  it('honours the selected profile default', () => {
    expect(resolveMigrateDbPath({ DUCKY_PROFILE: 'development' } as NodeJS.ProcessEnv)).toBe(
      './data/ducky-dev.db',
    );
    expect(resolveMigrateDbPath({ DUCKY_PROFILE: 'production' } as NodeJS.ProcessEnv)).toBe(
      './data/ducky-prod.db',
    );
  });

  it('lets an explicit DUCKY_DB_PATH override the profile default', () => {
    expect(
      resolveMigrateDbPath({
        DUCKY_PROFILE: 'production',
        DUCKY_DB_PATH: '/var/lib/ducky/custom.db',
      } as NodeJS.ProcessEnv),
    ).toBe('/var/lib/ducky/custom.db');
  });

  it('treats a blank DUCKY_DB_PATH as unset rather than as an empty location', () => {
    expect(
      resolveMigrateDbPath({ DUCKY_PROFILE: 'production', DUCKY_DB_PATH: '' } as NodeJS.ProcessEnv),
    ).toBe('./data/ducky-prod.db');
  });

  it('rejects an unknown profile', () => {
    expect(() => resolveMigrateDbPath({ DUCKY_PROFILE: 'staging' } as NodeJS.ProcessEnv)).toThrow(
      /must be one of/,
    );
  });
});
