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

/* ── Chat: asking for the last turn's pictures ── */

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
  env.decorate = (rootEl) => env.cp.captureForChat({
    root: rootEl || env.pane,
    sessionId: env.ctx.sessionId,
    getTurns: () => { env.getTurnsCalls += 1; return env.turns; },
  });
  return env;
}

// The chat draws no pictures: they are in Changes. Nothing is ever added to a reply.
const rows = (env) => Array.from(env.root.querySelectorAll('.chat-pics-row, .chat-pics, .chat-line, img'));

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
  assert.equal(rows(env).length, 0);
});

test('chat told the feature is off starts nothing', async () => {
  const env = chatEnv(article('t1'), { list: { ok: true, enabled: true, records: [rec('t1', [page('index.html', 'ready')])] } }, makeTurns([['t1', 'index.html']]));
  env.decorate();
  await flush();
  assert.equal(rows(env).length, 0);
  env.cp.captureForChat({ root: env.pane, sessionId: 's1', getTurns: () => env.turns, enabled: false });
  assert.equal(rows(env).length, 0);
  assert.equal(env.calls.capture.length, 0);
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
  assert.equal(rows(env).length, 0);
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
