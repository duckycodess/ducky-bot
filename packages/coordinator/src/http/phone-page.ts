/**
 * The capture page itself: one HTML file, no build step, no framework, no
 * third-party request of any kind.
 *
 * Everything is inline because a home-screen shortcut over a tailnet should
 * work the moment the coordinator answers, with no asset pipeline and nothing
 * fetched from a CDN that would also be a place the owner's page could be
 * changed from. The only values interpolated into it are a CSRF token (a
 * base64url MAC this process just produced) and fixed text, and the preview is
 * rendered with `textContent` rather than `innerHTML`, so a task title is text
 * on both the way in and the way out.
 */

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
          : c === '"' ? '&quot;'
            : '&#39;');

const SHELL = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Ducky">
<meta name="theme-color" content="#1b1b1f">
<link rel="manifest" href="/app/manifest.webmanifest">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; padding:1rem; font:16px/1.45 system-ui,-apple-system,sans-serif;
  background:#1b1b1f; color:#e9e9ec; }
h1 { font-size:1.1rem; font-weight:600; margin:0 0 .75rem; }
p { margin:.5rem 0; color:#b9b9c2; }
textarea, input { width:100%; padding:.7rem; border-radius:.6rem; border:1px solid #3a3a42;
  background:#111114; color:inherit; font:inherit; }
textarea { min-height:9rem; resize:vertical; }
button { font:inherit; padding:.7rem 1rem; border-radius:.6rem; border:0; margin:.35rem .35rem 0 0;
  background:#3a3a42; color:#e9e9ec; }
button.primary { background:#d9a54b; color:#1b1b1f; font-weight:600; }
button[disabled] { opacity:.5; }
ol { padding-left:1.2rem; }
li { margin:.35rem 0; }
.due { color:#b9b9c2; font-size:.9rem; }
.note { border-left:3px solid #c28a3a; padding-left:.7rem; white-space:pre-wrap; }
.err { border-left:3px solid #a84a4a; padding-left:.7rem; white-space:pre-wrap; }
.ok { border-left:3px solid #4c8f63; padding-left:.7rem; }
</style>
</head>
<body>
${body}
</body>
</html>
`;

/** The passcode form. Says nothing about whether a passcode is even configured. */
export const phoneLoginPage = (failed: boolean): string =>
  SHELL(
    'Ducky',
    `<h1>Ducky</h1>
<form method="post" action="/app/session">
  <p><label for="passcode">Passcode</label></p>
  <input id="passcode" name="passcode" type="password" autocomplete="current-password"
         inputmode="text" autofocus required maxlength="256">
  <p><button class="primary" type="submit">Unlock</button></p>
</form>
${failed ? '<p class="err">That did not match.</p>' : ''}
<p class="due">Reachable on your tailnet only.</p>`,
  );

/**
 * The capture page.
 *
 * Two buttons and a box, because that is the whole job: paste, check what it
 * read, keep it. Save is disabled the moment it is pressed and re-enabled only
 * on a failure, and it always sends the SAME preview id -- so a double tap on
 * a slow connection cannot ask for two sets of tasks, and the server would
 * replay rather than duplicate even if it did.
 */
export const phoneCapturePage = (csrfToken: string): string =>
  SHELL(
    'Ducky',
    `<h1>New tasks</h1>
<p class="due">One numbered item per line. A deadline goes in brackets: <code>(October 13 11:59 PM)</code>.</p>
<textarea id="text" placeholder="1. ENG 30 Letters (October 13 11:59 PM)
2. Speech 30 Letters (October 15)" autocapitalize="sentences"></textarea>
<p>
  <button class="primary" id="read">Read it back</button>
  <button id="signout">Sign out</button>
</p>
<div id="out"></div>
<script>
const CSRF = ${JSON.stringify(csrfToken)};
const out = document.getElementById('out');
const text = document.getElementById('text');
let previewId = null;

const el = (tag, cls, content) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (content !== undefined) n.textContent = content;
  return n;
};
const clear = () => { out.textContent = ''; };
const say = (cls, message) => { out.appendChild(el('p', cls, message)); };

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ducky-csrf': CSRF },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (res.status === 401) { location.reload(); throw new Error('signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'That did not work.');
  return data;
}

document.getElementById('read').addEventListener('click', async () => {
  clear();
  previewId = null;
  try {
    const data = await post('/app/tasks/preview', { text: text.value });
    if (data.problems) {
      say('err', 'Nothing was saved. I will not guess at these:');
      const list = el('ul');
      for (const p of data.problems) list.appendChild(el('li', null, 'Line ' + p.lineNo + ' ' + p.message));
      out.appendChild(list);
      return;
    }
    if (!data.items || data.items.length === 0) { say('note', 'I found no tasks in that.'); return; }
    previewId = data.previewId;
    say('note', 'Nothing is saved yet.');
    const list = el('ol');
    for (const item of data.items) {
      const li = el('li', null, item.title);
      li.appendChild(el('div', 'due', item.deadline || 'no deadline'));
      list.appendChild(li);
    }
    out.appendChild(list);
    const save = el('button', 'primary', 'Save ' + data.items.length + ' task(s)');
    const discard = el('button', null, 'Discard');
    save.addEventListener('click', async () => {
      save.disabled = true;
      discard.disabled = true;
      try {
        const saved = await post('/app/tasks/save', { previewId });
        clear();
        say('ok', (saved.replayed ? 'Already saved — the same ' : 'Saved ') + saved.tasks.length + ' task(s).');
        const done = el('ol');
        for (const t of saved.tasks) {
          const li = el('li', null, t.title);
          li.appendChild(el('div', 'due', t.deadline || 'no deadline'));
          done.appendChild(li);
        }
        out.appendChild(done);
        text.value = '';
        previewId = null;
      } catch (err) {
        save.disabled = false;
        discard.disabled = false;
        say('err', err.message);
      }
    });
    discard.addEventListener('click', async () => {
      try { await post('/app/tasks/discard', { previewId }); } catch (err) { /* already gone */ }
      clear();
      say('note', 'Discarded. Nothing was saved.');
      previewId = null;
    });
    out.appendChild(save);
    out.appendChild(discard);
  } catch (err) {
    say('err', err.message);
  }
});

document.getElementById('signout').addEventListener('click', async () => {
  try { await post('/app/logout', {}); } finally { location.reload(); }
});
</script>`,
  );

export const phoneManifest = (): string =>
  JSON.stringify({
    name: 'Ducky',
    short_name: 'Ducky',
    start_url: '/app',
    scope: '/app',
    display: 'standalone',
    background_color: '#1b1b1f',
    theme_color: '#1b1b1f',
  });
