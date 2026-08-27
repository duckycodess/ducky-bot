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
  }, app.env.DUCKY_RECONCILE_INTERVAL_MS);
  timer.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
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
