import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BULK_CAPTURE_MAX_INPUT, BULK_PROBLEM_MESSAGE, DuckyError, formatDeadline, isDuckyError,
} from '@ducky/contracts';
import type { TaskRow } from '@ducky/persistence';
import {
  editableListText,
  type TaskCaptureOutcome, type TaskCaptureService,
} from '../domain/task-capture.service.js';
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
/**
 * Every phone route's rate limit, keyed by the CALLER'S ADDRESS.
 *
 * The server-wide key generator reads `x-ducky-executor-id` -- which is right
 * for the executor surface, where that header names a credential the request
 * then has to prove. Inherited HERE it was a hole: nothing on the login route
 * is authenticated yet, so an attacker varying that header on each attempt
 * would get a fresh bucket every time and the ten-attempts-per-five-minutes
 * ceiling on a human passcode would mean nothing.
 *
 * So the phone routes key on `req.ip` and ignore the header entirely. One
 * place, used by every route below, because a route that forgot it would be
 * the one that is actually attacked.
 */
const byAddress = (max: number, timeWindow: number) => ({
  rateLimit: { max, timeWindow, keyGenerator: (req: FastifyRequest) => req.ip },
});

export async function registerPhoneRoutes(
  app: FastifyInstance,
  config: PhoneCaptureConfig,
): Promise<void> {
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
   * Everything below lives in its own ENCAPSULATED scope, and that is what
   * makes the next paragraph true rather than merely intended.
   *
   * A Fastify content-type parser added to an instance applies to every route
   * on it. Added at the root, the form parser below would also have taught the
   * EXECUTOR routes to accept `application/x-www-form-urlencoded` -- and their
   * signature covers the raw JSON bytes, so a second body format on that path
   * would be a second way to disagree about what was signed. Inside
   * `register`, the parser belongs to this scope alone: the executor routes
   * answer 415 to a form body, exactly as they did before this page existed,
   * and a test asserts it.
   */
  await app.register(async (scope) => {
    registerScopedPhoneRoutes(scope, config, { now, owner, isSecure, sessionOf, html, authed });
  });
}

interface ScopeHelpers {
  readonly now: () => number;
  readonly owner: () => ReturnType<Authorizer['actor']>;
  readonly isSecure: (req: FastifyRequest) => boolean;
  readonly sessionOf: (req: FastifyRequest) => PhoneSession | undefined;
  readonly html: (reply: FastifyReply, body: string, code?: number) => FastifyReply;
  readonly authed: (
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

function registerScopedPhoneRoutes(
  app: FastifyInstance,
  config: PhoneCaptureConfig,
  { now, owner, isSecure, sessionOf, html, authed }: ScopeHelpers,
): void {
  /**
   * The login form, and the ONLY form-encoded body this server accepts.
   *
   * Scoped to the routes below (see the `register` above), bounded by the
   * server's own body limit, and parsed with `URLSearchParams` rather than by
   * hand.
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

  app.get('/app', { config: byAddress(60, 60_000) }, async (req, reply) => {
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
    // Ten attempts per five minutes per ADDRESS. The one route where the
    // ceiling is the whole defence, because nothing here is authenticated yet.
    { config: byAddress(10, 5 * 60_000) },
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

  app.post('/app/logout', { config: byAddress(30, 60_000) }, authed(async (_req, reply) =>
    reply.header('set-cookie', clearedPhoneSessionCookie()).send({ ok: true }),
  ));

  /**
   * Reads a paste back. Writes a short-lived preview row and no task at all.
   *
   * With a `previewId` it is the EDIT path: the corrected text is re-parsed
   * into the SAME preview rather than creating a second one, which is both
   * what the Discord modal does and what stops a few rounds of correction
   * leaving a trail of abandoned drafts holding the owner's text.
   *
   * A `previewId` that has expired or already settled falls back to a fresh
   * preview rather than refusing. Nothing was saved either way, the text in
   * the box is what the owner just typed, and "your draft expired while you
   * were editing it" is a dead end on a phone.
   */
  app.post(
    '/app/tasks/preview',
    { config: byAddress(30, 60_000) },
    authed(async (req, reply) => {
      const text = readText(req.body);
      const previewId = optionalPreviewId(req.body);

      let outcome: TaskCaptureOutcome;
      if (previewId === undefined) {
        outcome = config.capture.preview(owner(), text, 'phone');
      } else {
        try {
          outcome = config.capture.correct(owner(), previewId, text);
        } catch (err) {
          if (!isDuckyError(err) || err.code !== 'extraction_expired') throw err;
          outcome = config.capture.preview(owner(), text, 'phone');
        }
      }

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
        // What Edit puts back in the box: the same list, in the form the
        // parser reads. The client never reconstructs this itself, so the
        // round trip cannot drift from what the parser accepts.
        editable: editableListText(outcome.preview.items, config.capture.timeZone, now()),
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
    { config: byAddress(30, 60_000) },
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
    { config: byAddress(30, 60_000) },
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

/**
 * The preview a correction belongs to, when the client sent one.
 *
 * Absent and malformed are NOT the same: an absent id means "this is a fresh
 * paste", while a malformed one is a client bug and is refused rather than
 * quietly treated as a new preview.
 */
function optionalPreviewId(body: unknown): string | undefined {
  const value = (body as Record<string, unknown> | null)?.['previewId'];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 64) {
    throw new DuckyError('invalid_input', 'That list is no longer waiting to be saved.');
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
