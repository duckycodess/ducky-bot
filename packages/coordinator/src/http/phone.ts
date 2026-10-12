import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BULK_CAPTURE_MAX_INPUT, BULK_PROBLEM_MESSAGE, DuckyError, formatDeadline, isDuckyError,
} from '@ducky/contracts';
import type { TaskRow } from '@ducky/persistence';
import type { TaskCaptureService } from '../domain/task-capture.service.js';
import type { Authorizer } from '../security/authz.js';
import {
  PHONE_CSRF_HEADER, PHONE_SESSION_COOKIE, PHONE_SESSION_TTL_MS,
  clearedPhoneSessionCookie, csrfMatches, issuePhoneSession, passcodeMatches, phoneCsrfToken,
  phoneSessionCookie, readCookie, readPhoneSession, type PhoneSession,
} from './phone-auth.js';
import { phoneCapturePage, phoneLoginPage, phoneManifest } from './phone-page.js';

export interface PhoneCaptureConfig {
  /** The parsed verifier for the owner's passcode. Never the passcode itself. */
  readonly verifier: ReturnType<typeof import('./phone-auth.js').parsePhoneVerifier>;
  readonly sessionKey: Buffer;
  readonly capture: TaskCaptureService;
  readonly authz: Authorizer;
  readonly nowMs?: () => number;
}

/**
 * The owner's phone, as a surface.
 *
 * It is a TRANSPORT and nothing else: every route below authenticates, checks
 * CSRF, and then calls the same `TaskCaptureService` the Discord path calls.
 * There is no second validation, no second set of bounds and no second place a
 * task can be written from -- which is the only reason adding a web surface to
 * this codebase is a small change rather than a parallel implementation of the
 * assistant.
 *
 * What it is NOT:
 *
 * - **not public.** It is registered only when the coordinator is bound to a
 *   private address (checked at startup, see `isPrivateBindHost`) and only
 *   when a human credential is configured. Nothing here enables Tailscale
 *   Funnel or serves anything to the internet.
 * - **not the executor's credential.** The executor's signed routes are
 *   untouched and still require their own HMAC: putting the listener on a
 *   tailnet address exposes those routes to the tailnet, and they are
 *   authenticated exactly as they were before.
 * - **not a second authorization authority.** A verified passcode means "this
 *   is the owner", and the owner is the CONFIGURED one from frozen
 *   environment configuration. There is no user table and no way for this
 *   surface to act as anybody else.
 */
export function registerPhoneRoutes(app: FastifyInstance, config: PhoneCaptureConfig): void {
  const now = config.nowMs ?? (() => Date.now());
  const owner = () => config.authz.actor(config.authz.ownerId);

  /** Over TLS, or behind something that terminated it. */
  const isSecure = (req: FastifyRequest): boolean =>
    req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '') === 'https';

  const sessionOf = (req: FastifyRequest): PhoneSession | undefined =>
    readPhoneSession(
      config.sessionKey,
      readCookie(req.headers.cookie, PHONE_SESSION_COOKIE),
      now(),
    );

  const html = (reply: FastifyReply, body: string, code = 200): FastifyReply =>
    reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(body);

  /**
   * Every state-changing route runs through this.
   *
   * A missing or expired session answers 401 with no detail, and a session
   * without the matching CSRF token is refused the same way: the cookie is
   * sent automatically by the browser, so the header is the half a cross-site
   * page cannot forge.
   */
  const authed =
    (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        const session = sessionOf(req);
        if (!session) return reply.code(401).send({ error: 'unauthorized' });
        const presented = req.headers[PHONE_CSRF_HEADER];
        if (!csrfMatches(config.sessionKey, session, Array.isArray(presented) ? presented[0] : presented)) {
          return reply.code(403).send({ error: 'csrf' });
        }
        try {
          return await handler(req, reply);
        } catch (err) {
          // The owner's own message, never a stack and never the input back.
          const message = isDuckyError(err)
            ? err.ownerMessage
            : 'That did not work. Nothing was saved.';
          const status = isDuckyError(err) && err.code === 'not_found' ? 404 : 400;
          return reply.code(status).send({ error: 'refused', message });
        }
      };

  /**
   * The login form, and the ONLY form-encoded body this server accepts.
   *
   * Registered here rather than globally so the executor surface keeps exactly
   * one content type: its signature covers the raw JSON bytes, and a second
   * parser on that path would be a second way to disagree about what was
   * signed. Bounded, and parsed with `URLSearchParams` rather than by hand.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body)));
      } catch {
        done(new Error('invalid form'), undefined);
      }
    },
  );

  app.get('/app', async (req, reply) => {
    const session = sessionOf(req);
    if (!session) return html(reply, phoneLoginPage(false), 401);
    return html(reply, phoneCapturePage(phoneCsrfToken(config.sessionKey, session)));
  });

  app.get('/app/manifest.webmanifest', async (_req, reply) =>
    reply.type('application/manifest+json').header('cache-control', 'no-store').send(phoneManifest()),
  );

  /**
   * Sign in. Rate limited tightly, and deliberately uninformative: a wrong
   * passcode and an unconfigured surface are indistinguishable from here.
   *
   * The passcode arrives in a form post rather than a URL, so it cannot land
   * in a proxy log or a browser history entry, and nothing on this path writes
   * it anywhere.
   */
  app.post(
    '/app/session',
    { config: { rateLimit: { max: 10, timeWindow: 5 * 60_000 } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const passcode = typeof body['passcode'] === 'string' ? body['passcode'] : '';
      if (!passcodeMatches(passcode, config.verifier)) {
        return html(reply, phoneLoginPage(true), 401);
      }
      const token = issuePhoneSession(config.sessionKey, now());
      return reply
        .header(
          'set-cookie',
          phoneSessionCookie(token, {
            secure: isSecure(req),
            maxAgeSeconds: Math.floor(PHONE_SESSION_TTL_MS / 1000),
          }),
        )
        .code(303)
        .header('location', '/app')
        .send();
    },
  );

  app.post('/app/logout', authed(async (_req, reply) =>
    reply.header('set-cookie', clearedPhoneSessionCookie()).send({ ok: true }),
  ));

  /** Reads a paste back. Writes a short-lived preview row and no task at all. */
  app.post(
    '/app/tasks/preview',
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    authed(async (req, reply) => {
      const text = readText(req.body);
      const outcome = config.capture.preview(owner(), text, 'phone');
      if (outcome.kind === 'needs_clarification') {
        return reply.send({
          problems: outcome.problems.map((p) => ({
            lineNo: p.lineNo,
            message: BULK_PROBLEM_MESSAGE[p.kind],
          })),
        });
      }
      if (outcome.kind === 'empty') return reply.send({ items: [] });
      return reply.send({
        previewId: outcome.preview.previewId,
        expiresAt: outcome.preview.expiresAt,
        ignoredLeadingLines: outcome.preview.ignoredLeadingLines,
        items: outcome.preview.items.map((item) => ({
          title: item.title,
          deadline: item.dueAt
            ? formatDeadline(item.dueAt, {
                timeZone: config.capture.timeZone,
                allDay: item.dueAllDay,
                nowMs: now(),
              })
            : null,
        })),
      });
    }),
  );

  /**
   * Keeps the previewed list.
   *
   * Idempotent on the preview id, so the retry a flaky mobile connection makes
   * -- and the double tap a thumb makes -- reports the same tasks instead of
   * creating a second set. `replayed` says which happened, because a client
   * that cannot tell would have to guess.
   */
  app.post(
    '/app/tasks/save',
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    authed(async (req, reply) => {
      const result = config.capture.save(owner(), readPreviewId(req.body));
      return reply.send({
        replayed: result.replayed,
        tasks: result.tasks.map((task) => describe(task, config, now())),
      });
    }),
  );

  app.post(
    '/app/tasks/discard',
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    authed(async (req, reply) => {
      config.capture.discard(owner(), readPreviewId(req.body));
      return reply.send({ ok: true });
    }),
  );
}

const describe = (task: TaskRow, config: PhoneCaptureConfig, nowMs: number) => ({
  id: task.publicId,
  title: task.title,
  deadline: task.dueAt
    ? formatDeadline(task.dueAt, {
        timeZone: config.capture.timeZone,
        allDay: task.dueAllDay,
        nowMs,
      })
    : null,
});

function readText(body: unknown): string {
  const value = (body as Record<string, unknown> | null)?.['text'];
  if (typeof value !== 'string') {
    throw new DuckyError('invalid_input', 'Send the list as text.');
  }
  if (value.length > BULK_CAPTURE_MAX_INPUT) {
    throw new DuckyError(
      'invalid_input',
      `That is longer than ${BULK_CAPTURE_MAX_INPUT} characters. Send it in smaller lists.`,
    );
  }
  return value;
}

function readPreviewId(body: unknown): string {
  const value = (body as Record<string, unknown> | null)?.['previewId'];
  if (typeof value !== 'string' || value.length > 64) {
    throw new DuckyError('invalid_input', 'That list is no longer waiting to be saved.');
  }
  return value;
}
