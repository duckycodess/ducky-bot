import {
  HerdrCli, HerdrPiOrchestrator, MockPiOrchestrator, createLogger,
} from '@ducky/adapters';
import { loadExecutorEnv } from './config.js';
import { CoordinatorClient } from './client.js';
import { ExecutorLoop } from './loop.js';

/**
 * A logger that exists before `loadExecutorEnv()` can throw.
 *
 * Same reason as the coordinator's: the startup-failure line was hand-built
 * without a `correlationId`, and it is the line most likely to be the only one
 * anybody sees.
 */
const bootLog = createLogger({
  format: process.env['DUCKY_LOG_FORMAT'] === 'text' ? 'text' : 'json',
  base: { component: 'executor', phase: 'boot' },
});

async function main(): Promise<void> {
  const env = loadExecutorEnv();

  // Inherits the boot correlation id, so one run is one id across both phases.
  const log = bootLog.child({ executorId: env.DUCKY_EXECUTOR_ID, phase: 'running' });

  const client = new CoordinatorClient({
    baseUrl: env.DUCKY_COORDINATOR_URL,
    executorId: env.DUCKY_EXECUTOR_ID,
    keyId: env.DUCKY_EXECUTOR_KEY_ID,
    bearerToken: env.DUCKY_EXECUTOR_TOKEN,
    hmacSecret: env.DUCKY_EXECUTOR_HMAC_SECRET,
  });

  const herdr = new HerdrCli({ bin: env.DUCKY_HERDR_BIN });
  const herdrUp = await herdr.available();

  // Honest by construction: without a reachable Herdr the executor uses the
  // mock orchestrator and says so, rather than pretending to drive Pi.
  const orchestrator = herdrUp
    ? new HerdrPiOrchestrator({ herdr, verified: env.DUCKY_HERDR_VERIFIED === '1' })
    : new MockPiOrchestrator();

  log.info('executor.starting', {
    orchestrator: orchestrator.name,
    verified: orchestrator.verified,
    herdrReachable: herdrUp,
  });

  const loop = new ExecutorLoop({
    client,
    orchestrator,
    pollWaitMs: env.DUCKY_POLL_WAIT_MS,
    version: env.DUCKY_EXECUTOR_VERSION,
    log: (line) => log.info('executor.loop', { message: line }),
  });

  const stop = (): void => {
    loop.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await loop.run();
}

main().catch((err: unknown) => {
  bootLog.error('executor.start_failed', { err });
  process.exit(1);
});
