'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChangePictures } = require('../renderer/features/renderer-change-pictures');

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

const never = () => new Promise(() => {});

function page(path, state, extra) {
  const out = { path, state, beforeUrl: `file:///data/${path}-b.png`, afterUrl: `file:///data/${path}-a.png`, width: 1000, height: 640 };
  if (state === 'new' || state === 'after_failed') out.afterUrl = state === 'new' ? out.afterUrl : null;
  if (state === 'new') out.beforeUrl = null;
  if (state === 'deleted') out.afterUrl = null;
  return Object.assign(out, extra);
}

function rec(turnId, pages, viewport) {
  return { sessionId: 's1', turnId, capturedAt: 1, viewport: viewport || 'desktop', pages };
}

const ok = (record) => ({ ok: true, enabled: true, record });

/** turns: [{ turnId, files: [path] }] in time order; the fake ledger turns every file into a modified change. */
function makeTurns(spec) {
  return spec.map(([turnId, ...files]) => ({ turnId, files }));
}

function fakeLedger(events) {
  return () => (turns, options) => {
    if (events) events.push('build');
    return {
      changes: turns.flatMap((t) => (t.files || []).map((path) => ({
        turnId: t.turnId, path, status: 'modified', beforeHash: `b-${path}`, afterHash: `h-${path}`, sensitive: false,
      }))),
      options,
    };
  };
}

function makeBridge(answers, events) {
  const calls = { capture: [], captureWorkingTree: [], list: [] };
  const bridge = {
    list: (payload) => {
      calls.list.push(payload);
      return Promise.resolve(answers.list || { ok: true, enabled: true, records: [] });
    },
    capture: (payload) => {
      calls.capture.push(payload);
      if (events) events.push(`cap ${payload.turnId}`);
      const a = answers.capture;
      const out = typeof a === 'function' ? a(payload) : (a && Object.prototype.hasOwnProperty.call(a, payload.turnId) ? a[payload.turnId] : ok(null));
      return out && typeof out.then === 'function' ? out : Promise.resolve(out);
    },
    captureWorkingTree: (payload) => {
      calls.captureWorkingTree.push(payload);
      const a = answers.captureWorkingTree;
      const out = typeof a === 'function' ? a(payload) : (a || ok(null));
      return out && typeof out.then === 'function' ? out : Promise.resolve(out);
    },
  };
  return { bridge, calls };
}

function build(html, answers, turns, events, extra) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  const { bridge, calls } = makeBridge(answers || {}, events);
  const cp = createChangePictures({
    getBridge: () => bridge, getLedgerBuilder: fakeLedger(events), ...extra,
  });
  return { dom, document, root: document.getElementById('root'), bridge, calls, cp, turns, ctx: { sessionId: 's1' } };
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/* ── Chat pictures ── */

function article(turnId, { pending = false, marker = true, hover = true } = {}) {
  return `<article class="chat-entry assistant${pending ? ' pending' : ''}" data-turn-id="${turnId}">`
    + '<div class="chat-message-content"><p>reply</p>'
    + (marker ? `<span data-jenny-code-review data-scope="turn" data-turn-id="${turnId}"></span>` : '')
    + (hover ? '<div class="chat-hover-row"></div>' : '')
    + '</div></article>';
}

function chatEnv(articles, answers, turns, events, extra) {
  const env = build(`<div class="chat-timeline" id="pane">${articles}</div>`, answers, turns, events, extra);
  env.pane = env.root.querySelector('#pane');
  env.getTurnsCalls = 0;
  env.decorate = (rootEl) => env.cp.decorateChat({
    root: rootEl || env.pane,
    sessionId: env.ctx.sessionId,
    getTurns: () => { env.getTurnsCalls += 1; return env.turns; },
  });
  return env;
}

const rows = (env) => Array.from(env.root.querySelectorAll('.chat-pics-row'));

test('chat skips pending articles and articles without a change marker without touching the bridge', async () => {
  const env = chatEnv(article('t1', { pending: true }) + article('t2', { marker: false }), {}, makeTurns([['t1', 'index.html'], ['t2', 'index.html']]));
  env.decorate();
  env.decorate();
  await flush();
  assert.equal(env.calls.list.length + env.calls.capture.length, 0);
  assert.equal(env.getTurnsCalls, 0);
  assert.equal(rows(env).length, 0);
});

test('only the last assistant article may start a capture, and the ledger is built once', async () => {
  const env = chatEnv(article('t1') + article('t2'), {}, makeTurns([['t1', 'index.html'], ['t2', 'index.html']]));
  env.decorate();
  await flush();
  env.decorate();
  await flush();
  assert.equal(env.calls.list.length, 1);
  assert.deepEqual(env.calls.capture.map((c) => c.turnId), ['t2']);
  assert.equal(env.getTurnsCalls, 1);
});

test('a single article root that is not the last in its timeline never starts a capture', async () => {
  const env = chatEnv(article('t1') + article('t2'), {}, makeTurns([['t1', 'index.html'], ['t2', 'index.html']]));
  env.decorate(env.pane.querySelector('[data-turn-id="t1"]'));
  await flush();
  assert.equal(env.calls.capture.length, 0);
  env.decorate(env.pane.querySelector('[data-turn-id="t2"]'));
  await flush();
  assert.deepEqual(env.calls.capture.map((c) => c.turnId), ['t2']);
});

test('a listed record for the last article means no ledger and no capture', async () => {
  const env = chatEnv(article('t1'), { list: { ok: true, enabled: true, records: [rec('t1', [page('index.html', 'ready')])] } }, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  assert.equal(env.calls.capture.length, 0);
  assert.equal(env.getTurnsCalls, 0);
  assert.equal(rows(env).length, 1);
});

test('a ready turn gets two small pictures in a button that opens the Changes panel', async () => {
  const env = chatEnv(article('t1'), { capture: { t1: ok(rec('t1', [page('site/index.html', 'ready')])) } }, makeTurns([['t1', 'site/index.html']]));
  env.decorate();
  await flush();
  const [row] = rows(env);
  assert.equal(row.getAttribute('data-cp-chat'), 't1');
  assert.equal(row.parentElement.className, 'chat-message-content');
  assert.ok(row.nextElementSibling.classList.contains('chat-hover-row'));
  const button = row.querySelector('button.chat-pics');
  assert.equal(button.getAttribute('title'), 'Open in Changes');
  assert.equal(button.getAttribute('data-jenny-code-review'), '');
  assert.equal(button.getAttribute('data-scope'), 'turn');
  assert.equal(button.getAttribute('data-turn-id'), 't1');
  assert.equal(button.getAttribute('class'), 'chat-pics');
  const figures = button.querySelectorAll('figure');
  assert.equal(figures.length, 2);
  const img = figures[0].querySelector('img.chat-pic');
  assert.equal(img.getAttribute('src'), 'file:///data/site/index.html-b.png');
  assert.equal(img.getAttribute('width'), '168');
  assert.equal(img.getAttribute('decoding'), 'sync');
  assert.equal(text(figures[0].querySelector('figcaption')), 'Before');
  assert.equal(figures[1].querySelector('img').getAttribute('src'), 'file:///data/site/index.html-a.png');
  assert.equal(text(figures[1].querySelector('figcaption')), 'After · index.html');
});

test('chat shows one picture for a new page and a plain line for same, failed and pending', async () => {
  const cases = [
    ['new', 'index.html · new page', 'figure'],
    ['same', 'index.html looks the same before and after.', 'p.chat-line'],
    ['after_failed', "Couldn't take the After picture of index.html.", 'p.chat-line'],
  ];
  for (const [state, expected, selector] of cases) {
    const env = chatEnv(article('t1'), { capture: { t1: ok(rec('t1', [page('index.html', state)])) } }, makeTurns([['t1', 'index.html']]));
    env.decorate();
    await flush();
    const [row] = rows(env);
    assert.ok(row, state);
    assert.equal(text(row.querySelector(selector === 'figure' ? 'figcaption' : selector)), expected, state);
    if (selector === 'figure') assert.equal(row.querySelectorAll('figure').length, 1);
    else assert.equal(row.querySelector('button'), null);
  }
  const deleted = chatEnv(article('t1'), { capture: { t1: ok(rec('t1', [page('index.html', 'deleted')])) } }, makeTurns([['t1', 'index.html']]));
  deleted.decorate();
  await flush();
  assert.equal(rows(deleted).length, 0);

  const pending = chatEnv(article('t1'), { capture: () => never() }, makeTurns([['t1', 'index.html']]));
  pending.decorate();
  await flush();
  assert.equal(text(rows(pending)[0].querySelector('p.chat-line')), 'Taking pictures of index.html…');

  const cssOnly = chatEnv(article('t1'), { capture: () => never() }, makeTurns([['t1', 'site.css']]));
  cssOnly.decorate();
  await flush();
  assert.equal(cssOnly.calls.capture.length, 1);
  assert.equal(rows(cssOnly).length, 0);
});

test('chat draws no picture for a URL that is not a file URL', async () => {
  const env = chatEnv(article('t1'), { capture: { t1: ok(rec('t1', [page('index.html', 'ready', { afterUrl: 'https://evil.example/a.png' })])) } }, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  assert.equal(rows(env).length, 0);
  assert.equal(env.root.querySelector('img'), null);
});

test('the same element is put back after the chat render removed it, and its content is not rebuilt', async () => {
  const env = chatEnv(article('t1'), { capture: { t1: ok(rec('t1', [page('index.html', 'ready')])) } }, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  const [row] = rows(env);
  const inner = row.firstChild;
  row.remove();
  env.decorate();
  assert.equal(rows(env)[0], row);
  assert.equal(row.firstChild, inner);
  // The whole article is rebuilt by the chat render.
  env.pane.innerHTML = article('t1');
  assert.equal(rows(env).length, 0);
  env.decorate();
  assert.equal(rows(env)[0], row);
  assert.ok(row.nextElementSibling.classList.contains('chat-hover-row'));
  // No hover row: the element goes last.
  env.pane.innerHTML = article('t1', { hover: false });
  env.decorate();
  assert.equal(rows(env)[0], row);
  assert.equal(row.parentElement.lastElementChild, row);
  assert.equal(env.calls.capture.length, 1);
});

test('chat removes everything once the feature answers that it is off', async () => {
  const env = chatEnv(article('t1') + article('t2'), {
    list: { ok: true, enabled: true, records: [rec('t1', [page('index.html', 'ready')])] },
    capture: { t2: { ok: true, enabled: false, record: null } },
  }, makeTurns([['t1', 'index.html'], ['t2', 'index.html']]));
  env.decorate();
  await flush();
  assert.equal(env.calls.capture.length, 1);
  assert.equal(rows(env).length, 0);
  const listCalls = env.calls.list.length;
  env.decorate();
  await flush();
  assert.equal(rows(env).length, 0);
  assert.equal(env.calls.list.length, listCalls);
  assert.equal(env.calls.capture.length, 1);
});

test('chat told the feature is off removes its pictures and starts nothing', async () => {
  const env = chatEnv(article('t1'), { list: { ok: true, enabled: true, records: [rec('t1', [page('index.html', 'ready')])] } }, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  assert.equal(rows(env).length, 1);
  env.cp.decorateChat({ root: env.pane, sessionId: 's1', getTurns: () => env.turns, enabled: false });
  assert.equal(rows(env).length, 0);
  assert.equal(env.calls.capture.length, 0);
});

test('an answer still reaches its pane after another session was decorated', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const env = chatEnv(article('t1'), { capture: () => held }, makeTurns([['t1', 'index.html']]));
  env.root.insertAdjacentHTML('beforeend', `<div class="chat-timeline" id="other">${article('u1')}</div>`);
  env.decorate();
  await flush();
  assert.deepEqual(env.calls.capture.map((c) => c.turnId), ['t1']);
  env.cp.decorateChat({ root: env.root.querySelector('#other'), sessionId: 's2', getTurns: () => [] });
  await flush();
  release(ok(rec('t1', [page('index.html', 'ready')])));
  await flush();
  assert.equal(env.pane.querySelectorAll('.chat-pics-row .chat-pic').length, 2);
  assert.equal(env.root.querySelector('#other .chat-pics-row'), null);
});

test('repeated streaming frames cost no bridge calls and no ledger builds once the turn is settled', async () => {
  const env = chatEnv(article('t1') + article('t2', { pending: true }), { capture: { t1: ok(rec('t1', [page('index.html', 'ready')])) } }, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  assert.equal(env.calls.capture.length, 0);
  env.pane.querySelector('[data-turn-id="t2"]').classList.remove('pending');
  env.pane.querySelector('[data-turn-id="t1"]').remove();
  env.decorate();
  await flush();
  const captures = env.calls.capture.length;
  const lists = env.calls.list.length;
  const builds = env.getTurnsCalls;
  for (let i = 0; i < 20; i += 1) env.decorate();
  await flush();
  assert.equal(env.calls.capture.length, captures);
  assert.equal(env.calls.list.length, lists);
  assert.equal(env.getTurnsCalls, builds);
});

test('dispose removes the chat pictures it added', async () => {
  const env = chatEnv(article('t1'), { capture: { t1: ok(rec('t1', [page('index.html', 'ready')])) } }, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  assert.equal(rows(env).length, 1);
  env.cp.dispose();
  assert.equal(rows(env).length, 0);
});

test('a busy answer is not asked again on every render, and is asked again once it has had time to clear', async () => {
  let clock = 1000;
  let busy = true;
  const env = chatEnv(article('t1'), {
    capture: () => (busy ? { ok: false, reason: 'busy' } : ok(rec('t1', [page('index.html', 'ready')]))),
  }, makeTurns([['t1', 'index.html']]), null, { now: () => clock });
  env.decorate();
  await flush();
  assert.equal(env.calls.capture.length, 1);
  assert.equal(rows(env).length, 0);

  const built = env.getTurnsCalls;
  env.decorate();
  env.decorate();
  await flush();
  assert.equal(env.calls.capture.length, 1);
  assert.equal(env.getTurnsCalls, built, 'a render inside the wait does not rebuild the change list');

  busy = false;
  clock += 7000;
  env.decorate();
  await flush();
  assert.equal(env.calls.capture.length, 2);
  assert.equal(rows(env).length, 1);
});

test('checking phone size in Changes leaves the chat on the desktop pictures', async () => {
  const phoneUrls = { beforeUrl: 'file:///data/phone-b.png', afterUrl: 'file:///data/phone-a.png', width: 390, height: 844 };
  const env = chatEnv(article('t1'), {
    capture: (payload) => ok(rec('t1', [page('index.html', 'ready', payload.viewport === 'phone' ? phoneUrls : {})], payload.viewport)),
  }, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  const desktop = rows(env)[0].innerHTML;
  assert.match(desktop, /index\.html-b\.png/);

  await env.cp.cache.request('s1', 't1', env.calls.capture[0].files, { viewport: 'phone' });
  await flush();
  assert.equal(env.cp.cache.peek('s1', 't1').record.viewport, 'phone');
  assert.equal(rows(env)[0].innerHTML, desktop);
  env.decorate();
  await flush();
  assert.equal(rows(env)[0].innerHTML, desktop);
});

test('a turn the Changes view shows as undone loses its chat pictures, and gets them back on Redo', async () => {
  const env = chatEnv(article('t1'), {
    list: { ok: true, enabled: true, records: [rec('t1', [page('index.html', 'ready')])] },
  }, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  assert.equal(rows(env).length, 1);

  const panel = env.document.createElement('div');
  env.root.appendChild(panel);
  panel.innerHTML = '<section class="changes-history-turn changes-history-turn--undone" data-changes-turn-block="t1"></section>';
  env.cp.attachPanel(panel, { getSessionId: () => 's1', getTurnViewModels: () => env.turns, getWorkspaceId: () => 'w1' });
  await flush();
  assert.equal(rows(env).length, 0);
  // The next chat render does not bring them back.
  env.decorate();
  await flush();
  assert.equal(rows(env).length, 0);

  panel.innerHTML = '<section class="changes-history-turn" data-changes-turn-block="t1"><div class="cp-slot" data-cp-turn="t1"></div></section>';
  await flush();
  assert.equal(rows(env).length, 1);
  assert.equal(rows(env)[0].querySelectorAll('img.chat-pic').length, 2);
});

test('a later edit in the same reply asks again, so a second page is not left out', async () => {
  const env = chatEnv(article('t1'), {}, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  env.decorate();
  await flush();
  assert.equal(env.calls.capture.length, 1);
  const marker = env.root.ownerDocument.createElement('span');
  marker.setAttribute('data-jenny-code-review', '');
  env.pane.querySelector('.chat-message-content').appendChild(marker);
  env.turns = makeTurns([['t1', 'index.html', 'about.html']]);
  env.decorate();
  await flush();
  env.decorate();
  await flush();
  assert.equal(env.calls.capture.length, 2);
});
