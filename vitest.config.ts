import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Bound fork fan-out to preserve memory and task headroom on shared hosts.
    maxWorkers: 2,
  },
});
