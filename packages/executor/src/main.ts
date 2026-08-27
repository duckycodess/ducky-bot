import { HerdrCli, HerdrPiOrchestrator, MockPiOrchestrator } from '@ducky/adapters';
import { loadExecutorEnv } from './config.js';
import { CoordinatorClient } from './client.js';
import { ExecutorLoop } from './loop.js';

async function main(): Promise<void> {
  const env = loadExecutorEnv();

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

  process.stdout.write(
    `ducky executor ${env.DUCKY_EXECUTOR_ID} starting; orchestrator=${orchestrator.name}` +
      `${orchestrator.verified ? ' (verified)' : ' (experimental)'}\n`,
  );

  const loop = new ExecutorLoop({
    client,
    orchestrator,
    pollWaitMs: env.DUCKY_POLL_WAIT_MS,
    version: env.DUCKY_EXECUTOR_VERSION,
    log: (line) => process.stdout.write(`${line}\n`),
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
  process.stderr.write(`ducky executor failed: ${(err as Error).message}\n`);
  process.exit(1);
});
