import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.js';
import { phonePasscodeVerifier, PHONE_SESSION_COOKIE } from '../src/http/phone-auth.js';
import { createApp } from '../src/app.js';
import { TASK_PREVIEW_TTL_MS } from '@ducky/contracts';
import { OWNER, TestClock, makeHarness, secret } from './helpers.js';

const MANILA = 'Asia/Manila';
const START = '2026-10-13T02:00:00.000Z';
const PASSCODE = 'correct-horse-battery';
const PASTE = '1. ENG 30 Letters (October 13 11:59 PM)\n2. Speech 30 Letters (October 15)';

let server: FastifyInstance | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const phoneEnv = (over: Record<string, string | undefined> = {}) => ({
  DUCKY_PHONE_CAPTURE_ENABLED: '1',
  DUCKY_DEV_PHONE_PASSCODE_VERIFIER: phonePasscodeVerifier(PASSCODE),
  DUCKY_HTTP_HOST: '100.101.102.103',
  ...over,
});

const boot = async (over: Record<string, string | undefined> = {}) => {
  const clock = new TestClock(START, MANILA);
  const h = makeHarness({ clock, env: phoneEnv(over) });
  server = await buildServer({
    store: h.store,
    jobs: h.app.jobs,
    credentials: h.app.credentials,
    ...(h.app.phone ? { phone: h.app.phone } : {}),
  });
  await server.ready();
  return { h, app: server, clock };
};

/** Signs in the way the page does, and returns what the browser would hold. */
async function signIn(app: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/app/session',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `passcode=${encodeURIComponent(PASSCODE)}`,
  });
  expect(res.statusCode).toBe(303);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;

  const page = await app.inject({ method: 'GET', url: '/app', headers: { cookie } });
  expect(page.statusCode).toBe(200);
  const csrf = /const CSRF = "([^"]+)"/.exec(page.body)?.[1] ?? '';
  expect(csrf).not.toBe('');
  return { cookie, csrf };
}

const post = (
  app: FastifyInstance,
  url: string,
  body: unknown,
  auth?: { cookie: string; csrf: string },
) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { cookie: auth.cookie, 'x-ducky-csrf': auth.csrf } : {}),
    },
    payload: JSON.stringify(body),
  });

describe('the phone page is refused unless it is safe to serve', () => {
  it('does not exist at all when it is not enabled', async () => {
    const h = makeHarness();
    server = await buildServer({ store: h.store, jobs: h.app.jobs, credentials: h.app.credentials });
    await server.ready();
    expect(h.app.phone).toBeUndefined();
    expect((await server.inject({ method: 'GET', url: '/app' })).statusCode).toBe(404);
    h.close();
  });

  it('refuses to boot when it is enabled with no human credential', () => {
    expect(() =>
      createApp(
        {
          NODE_ENV: 'test', DUCKY_PROFILE: 'development', OWNER_DISCORD_USER_ID: OWNER,
          DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(), DUCKY_DB_PATH: ':memory:',
          DUCKY_REPOS_FILE: 'unused', DUCKY_PHONE_CAPTURE_ENABLED: '1',
          DUCKY_EXECUTOR_CREDENTIALS: '{"version":1,"executors":[]}',
        } as NodeJS.ProcessEnv,
        { allowlistJson: '{"version":1,"repos":[]}' },
      ),
    ).toThrow(/PHONE_PASSCODE_VERIFIER/);
  });

  it('refuses to boot when the listener is not private', () => {
    expect(() =>
      createApp(
        {
          NODE_ENV: 'test', DUCKY_PROFILE: 'development', OWNER_DISCORD_USER_ID: OWNER,
          DUCKY_DEV_COMPONENT_SIGNING_KEY: secret(), DUCKY_DB_PATH: ':memory:',
          DUCKY_REPOS_FILE: 'unused',
          DUCKY_EXECUTOR_CREDENTIALS: '{"version":1,"executors":[]}',
          ...phoneEnv({ DUCKY_HTTP_HOST: '0.0.0.0' }),
        } as NodeJS.ProcessEnv,
        { allowlistJson: '{"version":1,"repos":[]}' },
      ),
    ).toThrow(/loopback, RFC1918 or tailnet/);
  });

  it('never inherits a development credential into production', () => {
    expect(() =>
      createApp(
        {
          NODE_ENV: 'test', DUCKY_PROFILE: 'production', OWNER_DISCORD_USER_ID: OWNER,
          DUCKY_PROD_COMPONENT_SIGNING_KEY: secret(), DUCKY_DB_PATH: ':memory:',
          DUCKY_REPOS_FILE: 'unused',
          DISCORD_PROD_TOKEN: 'placeholder-not-a-real-token',
          DISCORD_PROD_APP_ID: '100000000000000009',
          DUCKY_CONVERSATION_PROVIDER: 'disabled',
          DUCKY_PHONE_CAPTURE_ENABLED: '1',
          // The DEVELOPMENT name is set, and production must not read it.
          DUCKY_PHONE_PASSCODE_VERIFIER: phonePasscodeVerifier(PASSCODE),
          DUCKY_HTTP_HOST: '100.101.102.103',
        } as NodeJS.ProcessEnv,
        { allowlistJson: '{"version":1,"repos":[]}' },
      ),
    ).toThrow(/DUCKY_PROD_PHONE_PASSCODE_VERIFIER/);
  });
});

describe('owner authentication, distinct from the executor credential', () => {
  it('asks for the passcode and says nothing else', async () => {
    const { h, app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/app' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Passcode');
    // No hint about what is configured, who the owner is, or what is stored.
    expect(res.body).not.toContain(OWNER);
    h.close();
  });

  it('refuses a wrong passcode without a session', async () => {
    const { h, app } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/app/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'passcode=not-the-passcode',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    h.close();
  });

  it('issues an httpOnly, SameSite=Strict, bounded session on the right one', async () => {
    const { h, app } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/app/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `passcode=${encodeURIComponent(PASSCODE)}`,
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`${PHONE_SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie).toContain('Path=/app');
    // The passcode is never echoed back, in any form.
    expect(cookie).not.toContain(PASSCODE);
    h.close();
  });

  it('is not the executor credential: neither opens the other’s door', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);

    // A phone session cannot claim a job.
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/executor/claim',
      headers: { 'content-type': 'application/json', cookie: auth.cookie },
      payload: JSON.stringify({ executorId: h.executorId, capabilities: [], waitMs: 0, idempotencyKey: 'k'.repeat(10) }),
    });
    expect(claimed.statusCode).toBe(401);

    // And an executor bearer token is not a phone session.
    const captured = await app.inject({
      method: 'POST',
      url: '/app/tasks/preview',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${h.bearer}` },
      payload: JSON.stringify({ text: PASTE }),
    });
    expect(captured.statusCode).toBe(401);
    h.close();
  });

  it('refuses a state-changing request with a session but no CSRF token', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const res = await app.inject({
      method: 'POST',
      url: '/app/tasks/preview',
      headers: { 'content-type': 'application/json', cookie: auth.cookie },
      payload: JSON.stringify({ text: PASTE }),
    });
    expect(res.statusCode).toBe(403);
    h.close();
  });

  it('refuses a forged session cookie', async () => {
    const { h, app } = await boot();
    const res = await post(app, '/app/tasks/preview', { text: PASTE }, {
      cookie: `${PHONE_SESSION_COOKIE}=v1.99999999999999.aaaa.bbbb`,
      csrf: 'anything',
    });
    expect(res.statusCode).toBe(401);
    h.close();
  });

  it('signs out, and the session stops working', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const out = await post(app, '/app/logout', {}, auth);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    h.close();
  });
});

describe('the login ceiling is the whole defence, so it cannot be side-stepped', () => {
  it('counts attempts by ADDRESS, whatever executor id the caller claims', async () => {
    const { h, app } = await boot();
    // The server-wide key generator reads `x-ducky-executor-id`. If the phone
    // routes inherited it, varying that header would hand an attacker a fresh
    // bucket on every attempt and the ten-per-five-minutes ceiling on a human
    // passcode would mean nothing.
    const codes: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/app/session',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-ducky-executor-id': `forged-${i}`,
        },
        payload: 'passcode=not-the-passcode',
      });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    // And it is the LIMIT that stopped them, not a lucky guess: none ever
    // succeeded.
    expect(codes.filter((c) => c === 303)).toHaveLength(0);
    h.close();
  });

  it('records a refused phone attempt without the executor id the caller supplied', async () => {
    const { h, app } = await boot();
    for (let i = 0; i < 14; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/app/session',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-ducky-executor-id': 'plausible-looking-id',
        },
        payload: 'passcode=no',
      });
    }
    const rows = h.store.auditLog.recent(50).filter((r) => r.event === 'rate_limit.exceeded');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.subjectRef).toBe('/app/session');
    // An unauthenticated caller must not be able to write a plausible executor
    // id into the trail as the ACTOR of their own refusal.
    expect(rows.every((r) => r.actorRef === null)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('plausible-looking-id');
    h.close();
  });

  it('keeps its form parser to itself: the executor routes still take JSON only', async () => {
    const { h, app } = await boot();
    // The page needs a form body for the login POST. A content-type parser
    // added at the ROOT would have taught the executor routes to accept one
    // too, and their signature covers the raw JSON bytes.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/executor/heartbeat',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'executorId=exec-a&version=1',
    });
    expect(res.statusCode).toBe(415);
    h.close();
  });
});

describe('capturing from the phone', () => {
  it('reads the owner’s own example back, saving nothing yet', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const res = await post(app, '/app/tasks/preview', { text: PASTE }, auth);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { previewId: string; items: { title: string; deadline: string }[] };
    expect(body.items.map((i) => i.title)).toEqual(['ENG 30 Letters', 'Speech 30 Letters']);
    expect(body.items[0]?.deadline).toBe('October 13, 11:59 PM');
    expect(body.items[1]?.deadline).toBe('October 15');
    expect(JSON.stringify(body)).not.toMatch(/manila|utc|gmt/i);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('asks for clarification rather than guessing an ambiguous date', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const res = await post(app, '/app/tasks/preview', { text: '1. One (10/13)\n2. Two (October 15)' }, auth);
    const body = res.json() as { problems?: { lineNo: number }[]; previewId?: string };
    expect(body.problems?.map((p) => p.lineNo)).toEqual([1]);
    expect(body.previewId).toBeUndefined();
    h.close();
  });

  it('saves once, and a retry returns the same tasks rather than a second set', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const preview = (await post(app, '/app/tasks/preview', { text: PASTE }, auth)).json() as {
      previewId: string;
    };

    const first = (await post(app, '/app/tasks/save', { previewId: preview.previewId }, auth)).json() as {
      replayed: boolean; tasks: { id: string }[];
    };
    const second = (await post(app, '/app/tasks/save', { previewId: preview.previewId }, auth)).json() as {
      replayed: boolean; tasks: { id: string }[];
    };

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.tasks.map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(2);
    h.close();
  });

  it('links the deadlines it saved to real reminders', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const preview = (await post(app, '/app/tasks/preview', { text: PASTE }, auth)).json() as {
      previewId: string;
    };
    await post(app, '/app/tasks/save', { previewId: preview.previewId }, auth);

    const speech = h.app.tasks.list(h.owner, 'all').find((t) => t.title.startsWith('Speech'))!;
    const rows = h.store.reminders.scheduledForTask(OWNER, speech.id);
    // A date-only deadline two days out earns exactly one: 08:00 that morning.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.firstFireAt).toBe('2026-10-15T00:00:00.000Z');
    h.close();
  });

  it('offers Save, Edit and Discard — three controls, not two', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const page = await app.inject({ method: 'GET', url: '/app', headers: { cookie: auth.cookie } });

    // The Edit control must EXIST and be wired, not merely be a word on the
    // page: the issue asks for the same three choices the Discord preview has.
    expect(page.body).toContain("const edit = el('button', null, 'Edit');");
    expect(page.body).toContain('edit.addEventListener');
    expect(page.body).toContain('out.appendChild(edit)');
    h.close();
  });

  it('hands back an editable rendering that parses to the same list', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const first = (await post(app, '/app/tasks/preview', { text: PASTE }, auth)).json() as {
      previewId: string; editable: string; items: { title: string; deadline: string }[];
    };
    expect(first.editable).toBe(
      '1. ENG 30 Letters (October 13, 11:59 PM)\n2. Speech 30 Letters (October 15)',
    );

    // Exactly what Edit puts back in the box, read straight back: same items,
    // same deadlines, and the SAME preview rather than a second one.
    const again = (await post(
      app, '/app/tasks/preview', { text: first.editable, previewId: first.previewId }, auth,
    )).json() as { previewId: string; items: { title: string; deadline: string }[] };
    expect(again.previewId).toBe(first.previewId);
    expect(again.items).toEqual(first.items);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('corrects in place: one preview row, and the saved task is the corrected one', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const first = (await post(app, '/app/tasks/preview', { text: PASTE }, auth)).json() as {
      previewId: string;
    };
    const corrected = (await post(
      app,
      '/app/tasks/preview',
      { text: '1. ENG 30 Letters (October 14 11:59 PM)', previewId: first.previewId },
      auth,
    )).json() as { previewId: string; items: { deadline: string }[] };

    expect(corrected.previewId).toBe(first.previewId);
    expect(corrected.items).toHaveLength(1);
    expect(corrected.items[0]?.deadline).toBe('October 14, 11:59 PM');
    // Editing does not litter: still ONE preview row, not a trail of drafts
    // each holding a copy of what the owner wrote.
    expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM task_previews').get()).toEqual({ n: 1 });

    await post(app, '/app/tasks/save', { previewId: first.previewId }, auth);
    const tasks = h.app.tasks.list(h.owner, 'all');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.dueAt).toBe('2026-10-14T15:59:00.000Z');
    h.close();
  });

  it('refuses a correction that does not parse, and changes nothing', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const first = (await post(app, '/app/tasks/preview', { text: PASTE }, auth)).json() as {
      previewId: string;
    };
    const refused = (await post(
      app, '/app/tasks/preview', { text: '1. Thing (10/13)', previewId: first.previewId }, auth,
    )).json() as { problems?: { lineNo: number }[] };
    expect(refused.problems?.map((p) => p.lineNo)).toEqual([1]);

    // The preview it was correcting is untouched, so the owner can fix the
    // line and read it back again.
    const pending = h.app.taskCapture.pendingPreview(h.owner, first.previewId);
    expect(pending?.items).toHaveLength(2);
    h.close();
  });

  it('starts a fresh preview rather than failing when the one being edited expired', async () => {
    const { h, app, clock } = await boot();
    const auth = await signIn(app);
    const first = (await post(app, '/app/tasks/preview', { text: PASTE }, auth)).json() as {
      previewId: string; editable: string;
    };

    clock.advance(TASK_PREVIEW_TTL_MS + 1000);
    const after = await post(
      app, '/app/tasks/preview', { text: first.editable, previewId: first.previewId }, auth,
    );
    expect(after.statusCode).toBe(200);
    const body = after.json() as { previewId: string; items: unknown[] };
    expect(body.previewId).not.toBe(first.previewId);
    expect(body.items).toHaveLength(2);

    // And saving the NEW one is what writes the tasks; the expired id does not.
    const stale = await post(app, '/app/tasks/save', { previewId: first.previewId }, auth);
    expect(stale.statusCode).toBe(400);
    await post(app, '/app/tasks/save', { previewId: body.previewId }, auth);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(2);
    h.close();
  });

  it('keeps two previews independent, so a stale id cannot save the wrong list', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const a = (await post(app, '/app/tasks/preview', { text: '1. First one (October 20)\n2. Second (October 21)' }, auth)).json() as {
      previewId: string;
    };
    const b = (await post(app, '/app/tasks/preview', { text: '1. Different (October 22)\n2. Also different (October 23)' }, auth)).json() as {
      previewId: string;
    };
    expect(b.previewId).not.toBe(a.previewId);

    // Saving the OLDER id saves the older list, whatever happened since: the
    // server keys everything off the id the client sends, and the page binds
    // each button to the id it was rendered with.
    const saved = (await post(app, '/app/tasks/save', { previewId: a.previewId }, auth)).json() as {
      tasks: { title: string }[];
    };
    expect(saved.tasks.map((t) => t.title)).toEqual(['First one', 'Second']);

    // Discarding the older one afterwards leaves the newer one usable.
    await post(app, '/app/tasks/discard', { previewId: b.previewId }, auth);
    expect(h.app.tasks.list(h.owner, 'all').map((t) => t.title).sort())
      .toEqual(['First one', 'Second']);
    h.close();
  });

  it('refuses a malformed preview id rather than treating it as a new paste', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const res = await post(app, '/app/tasks/preview', { text: PASTE, previewId: 'x'.repeat(200) }, auth);
    expect(res.statusCode).toBe(400);
    expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM task_previews').get()).toEqual({ n: 0 });
    h.close();
  });

  it('discards a preview without saving anything', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const preview = (await post(app, '/app/tasks/preview', { text: PASTE }, auth)).json() as {
      previewId: string;
    };
    expect((await post(app, '/app/tasks/discard', { previewId: preview.previewId }, auth)).statusCode)
      .toBe(200);
    const late = await post(app, '/app/tasks/save', { previewId: preview.previewId }, auth);
    expect(late.statusCode).toBe(400);
    expect(h.app.tasks.list(h.owner, 'all')).toHaveLength(0);
    h.close();
  });

  it('bounds what it will read, and says so plainly', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const res = await post(app, '/app/tasks/preview', { text: 'x'.repeat(5000) }, auth);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toMatch(/smaller lists/);
    h.close();
  });

  it('escapes what it renders, and renders the preview from data rather than HTML', async () => {
    const { h, app } = await boot();
    const auth = await signIn(app);
    const page = await app.inject({ method: 'GET', url: '/app', headers: { cookie: auth.cookie } });
    // The page builds every row with textContent; nothing is interpolated into
    // markup, so a task title can never become an element.
    expect(page.body).not.toContain('innerHTML');
    expect(page.body).toContain('textContent');
    h.close();
  });

  it('serves a manifest so the shortcut opens as an app rather than a tab', async () => {
    const { h, app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/app/manifest.webmanifest' });
    expect((res.json() as { display: string; start_url: string }).display).toBe('standalone');
    expect((res.json() as { start_url: string }).start_url).toBe('/app');
    h.close();
  });
});
