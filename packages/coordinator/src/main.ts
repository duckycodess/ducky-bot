import { createApp } from './app.js';
import { buildServer } from './http/server.js';
import { formatDiagnostics, runStartupDiagnostics } from './diagnostics.js';
import { sweepStaleTempDirs } from './discord/attachments.js';
import { createLogger } from '@ducky/adapters';

/**
 * A logger that exists BEFORE configuration is read.
 *
 * The startup-failure path used to hand-build a JSON line with no
 * `correlationId`, which contradicted the guarantee every other line keeps --
 * and the startup failure is the line most likely to be the only one a
 * collector ever sees. Created here, so both the failure and the boot record
 * share one id.
 */
const bootLog = createLogger({
  format: process.env['DUCKY_LOG_FORMAT'] === 'text' ? 'text' : 'json',
  base: { component: 'coordinator', phase: 'boot' },
});

async function main(): Promise<void> {
  const app = createApp();
  // Every line from here goes through the redactor. Interpolating a raw
  // `(err as Error).message` into stderr -- which is what these sites used to
  // do -- puts whatever the error happened to quote into the log.
  // Inherits the boot correlation id, so the lines emitted before configuration
  // was readable and the lines emitted after are the same run.
  const log = bootLog.child({
    instance: app.paths.instanceLabel,
    profile: app.discordProfile.profile,
    phase: 'running',
  });

  // Crash recovery for attachment scratch directories from a previous run.
  sweepStaleTempDirs();

  // OPERATOR DISPLAY, not a log line.
  //
  // This block is written for a human reading the terminal at boot, and a JSON
  // blob is strictly worse for that. It is deliberately outside the structured
  // logging guarantee -- and so that the guarantee still holds for anything a
  // collector consumes, the same facts are ALSO emitted as one structured
  // record immediately below. The detail strings are built from fixed text and
  // already-safe values (see diagnostics.ts).
  const diagnostics = runStartupDiagnostics(app);
  process.stdout.write(`${formatDiagnostics(diagnostics)}\n`);
  log.info('coordinator.diagnostics', {
    checks: Object.fromEntries(diagnostics.map((d) => [d.name, d.ok])),
    warnings: diagnostics.filter((d) => !d.ok).map((d) => d.name),
  });

  const server = await buildServer({
    store: app.store,
    jobs: app.jobs,
    credentials: app.credentials,
  });

  await app.transport.start((event) => app.router.handle(event));
  await server.listen({ host: app.env.DUCKY_HTTP_HOST, port: app.paths.httpPort });
  log.info('http.listening', { host: app.env.DUCKY_HTTP_HOST, port: app.paths.httpPort });

  const timer = setInterval(() => {
    try {
      app.reconciler.run();
      if (app.credentials.reloadIfChanged()) {
        // A reload changes which credentials authenticate, so it is a security
        // event. Records only that it happened -- never a key id's material.
        app.store.auditLog.record({
          event: 'credential.reloaded',
          actorKind: 'system',
          actorRef: 'credential-store',
          subjectKind: 'credential',
          subjectRef: String(app.credentials.listActive().length),
          outcome: 'ok',
          detail: 'credential file changed and was reloaded',
        });
        log.info('credentials.reloaded', { active: app.credentials.listActive().length });
      }
    } catch (err) {
      log.error('reconciler.failed', { err });
    }
    // Independent of the reconciler: a notification failure must never block
    // lease/reservation healing, and vice versa.
    app.notifier.deliverPending().catch((err: unknown) => {
      log.error('notifications.sweep_failed', { err });
    });
    // The daily assistant rides the SAME interval. There is deliberately no
    // second scheduler and no per-reminder timer: one loop, one bound, and a
    // worst-case reminder lateness of one interval that is visible in
    // configuration rather than hidden in a timer table.
    app.reminderNotifier.tick().catch((err: unknown) => {
      log.error('reminders.tick_failed', { err });
    });
    // Dependency waits ride the same interval too. Bounded per pass and
    // bounded per dependency, so this can never become a polling loop.
    app.dependencies.tick().catch((err: unknown) => {
      log.error('dependencies.tick_failed', { err });
    });
    // GitHub watches are another bounded observation on the SAME coordinator
    // interval. Snapshot changes enqueue an owner-DM event; unchanged snapshots
    // do not produce a message.
    app.githubWatches.tick().catch((err: unknown) => {
      log.error('github_watches.tick_failed', { err });
    });
    // Retention rides the SAME interval as everything else. No second
    // scheduler, and it is a no-op unless an operator enabled it.
    app.retention.tick().catch((err: unknown) => {
      log.error('retention.tick_failed', { err });
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
      log.error('credentials.reload_failed', { err });
      // Configuration rejected AFTER boot, so the database exists and this can
      // be audited. A startup config error happens before the store exists and
      // is logged instead -- see docs/SECURITY.md.
      try {
        app.store.auditLog.record({
          event: 'config.rejected',
          actorKind: 'system',
          actorRef: 'credential-store',
          subjectKind: 'config',
          // The VARIABLE NAME, never a path and never a value.
          subjectRef: 'DUCKY_EXECUTOR_CREDENTIALS_FILE',
          outcome: 'refused',
          detail: 'the credential file was rejected on reload',
        });
      } catch {
        /* a record is never worth failing the reload path */
      }
    }
  });
}

main().catch((err: unknown) => {
  // Through the real logger, so this line carries a correlationId and is
  // redacted by the same code as every other -- rather than being the one
  // hand-built exception to both.
  bootLog.error('coordinator.start_failed', { err });
  process.exit(1);
});
