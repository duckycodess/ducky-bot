import { createApp } from './app.js';
import { buildServer } from './http/server.js';
import { formatDiagnostics, runStartupDiagnostics } from './diagnostics.js';
import { sweepStaleTempDirs } from './discord/attachments.js';

async function main(): Promise<void> {
  const app = createApp();

  // Crash recovery for attachment scratch directories from a previous run.
  sweepStaleTempDirs();

  const diagnostics = runStartupDiagnostics(app);
  process.stdout.write(`${formatDiagnostics(diagnostics)}\n`);

  const server = await buildServer({
    store: app.store,
    jobs: app.jobs,
    credentials: app.credentials,
  });

  await app.transport.start((event) => app.router.handle(event));
  await server.listen({ host: app.env.DUCKY_HTTP_HOST, port: app.paths.httpPort });
  process.stdout.write(
    `${app.paths.instanceLabel} listening on ${app.env.DUCKY_HTTP_HOST}:${app.paths.httpPort}\n`,
  );

  const timer = setInterval(() => {
    try {
      app.reconciler.run();
      app.credentials.reloadIfChanged();
    } catch (err) {
      process.stderr.write(`reconciler error: ${(err as Error).message}\n`);
    }
    // Independent of the reconciler: a notification failure must never block
    // lease/reservation healing, and vice versa.
    app.notifier.deliverPending().catch((err: unknown) => {
      process.stderr.write(`notification sweep error: ${(err as Error).message}\n`);
    });
    // The daily assistant rides the SAME interval. There is deliberately no
    // second scheduler and no per-reminder timer: one loop, one bound, and a
    // worst-case reminder lateness of one interval that is visible in
    // configuration rather than hidden in a timer table.
    app.reminderNotifier.tick().catch((err: unknown) => {
      process.stderr.write(`reminder tick error: ${(err as Error).message}\n`);
    });
    // Dependency waits ride the same interval too. Bounded per pass and
    // bounded per dependency, so this can never become a polling loop.
    app.dependencies.tick().catch((err: unknown) => {
      process.stderr.write(`dependency tick error: ${(err as Error).message}\n`);
    });
    // GitHub watches are another bounded observation on the SAME coordinator
    // interval. Snapshot changes enqueue an owner-DM event; unchanged snapshots
    // do not produce a message.
    app.githubWatches.tick().catch((err: unknown) => {
      process.stderr.write(`GitHub watch tick error: ${(err as Error).message}\n`);
    });
  }, app.env.DUCKY_RECONCILE_INTERVAL_MS);
  timer.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    // A notification sweep can be mid-write when shutdown is requested; wait
    // for it to settle before the store closes underneath it, without
    // triggering a new one.
    await app.notifier.waitForIdle();
    await app.reminderNotifier.waitForIdle();
    await app.dependencies.waitForIdle();
    await app.githubWatches.waitForIdle();
    await app.transport.stop();
    await server.close();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGHUP', () => {
    try {
      app.credentials.reloadIfChanged();
    } catch (err) {
      process.stderr.write(`credential reload failed: ${(err as Error).message}\n`);
    }
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`ducky coordinator failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
