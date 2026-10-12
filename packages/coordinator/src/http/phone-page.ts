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
 * A box and three controls, because that is the whole job: paste, check what
 * it read, then Save it, Edit it or Discard it.
 *
 * Two rules about identity run through the script, and both exist because a
 * phone is a device people double-tap on a bad connection:
 *
 * 1. **Each rendered preview's buttons close over THEIR OWN id**, captured
 *    when they are built, never read from a shared variable at click time. A
 *    reply that arrives while a thumb is moving cannot make Save act on a
 *    different list from the one on screen.
 * 2. **Only the newest read is allowed to render.** Every "Read it back"
 *    takes a sequence number and a late reply from a superseded request is
 *    dropped, so two taps cannot leave the screen describing one preview
 *    while the buttons belong to another.
 *
 * Save is disabled the moment it is pressed and re-enabled only on failure,
 * and the server replays rather than duplicating even if a second press got
 * through.
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
const read = document.getElementById('read');
// The preview currently on screen. Used ONLY to tell the server that the next
// read is a correction of this one rather than a new list; the buttons never
// read it, because they carry their own.
let editingId = null;
// Monotonic: a reply whose sequence is not the newest is dropped on arrival.
let readSeq = 0;

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

read.addEventListener('click', async () => {
  const seq = ++readSeq;
  clear();
  read.disabled = true;
  try {
    const body = { text: text.value };
    // A correction of the list already on screen, so the server re-parses into
    // the SAME preview instead of leaving the old draft behind.
    if (editingId) body.previewId = editingId;
    const data = await post('/app/tasks/preview', body);
    if (seq !== readSeq) return; // superseded by a later tap; this reply is stale
    if (data.problems) {
      say('err', 'Nothing was saved. I will not guess at these:');
      const list = el('ul');
      for (const p of data.problems) list.appendChild(el('li', null, 'Line ' + p.lineNo + ' ' + p.message));
      out.appendChild(list);
      // The text in the box is still the owner's to fix, and the preview it
      // came from (if any) is untouched: a correction that did not parse
      // changed nothing on the server either.
      return;
    }
    if (!data.items || data.items.length === 0) { say('note', 'I found no tasks in that.'); return; }
    // Captured HERE, so every control built below acts on this exact list
    // whatever happens afterwards.
    const id = data.previewId;
    const editable = data.editable || text.value;
    editingId = id;
    say('note', 'Nothing is saved yet.');
    const list = el('ol');
    for (const item of data.items) {
      const li = el('li', null, item.title);
      li.appendChild(el('div', 'due', item.deadline || 'no deadline'));
      list.appendChild(li);
    }
    out.appendChild(list);
    const save = el('button', 'primary', 'Save ' + data.items.length + ' task(s)');
    const edit = el('button', null, 'Edit');
    const discard = el('button', null, 'Discard');
    save.addEventListener('click', async () => {
      save.disabled = true;
      edit.disabled = true;
      discard.disabled = true;
      try {
        const saved = await post('/app/tasks/save', { previewId: id });
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
        editingId = null;
      } catch (err) {
        save.disabled = false;
        edit.disabled = false;
        discard.disabled = false;
        say('err', err.message);
      }
    });
    /**
     * Edit puts the list BACK in the box, in the form the parser reads, and
     * says plainly that nothing has been saved. The next read corrects this
     * same preview rather than starting another one.
     */
    edit.addEventListener('click', () => {
      text.value = editable;
      editingId = id;
      clear();
      say('note', 'Edit the list, then read it back again. Nothing was saved.');
      text.focus();
    });
    discard.addEventListener('click', async () => {
      try { await post('/app/tasks/discard', { previewId: id }); } catch (err) { /* already gone */ }
      clear();
      say('note', 'Discarded. Nothing was saved.');
      text.value = '';
      editingId = null;
    });
    out.appendChild(save);
    out.appendChild(edit);
    out.appendChild(discard);
  } catch (err) {
    if (seq === readSeq) say('err', err.message);
  } finally {
    if (seq === readSeq) read.disabled = false;
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
