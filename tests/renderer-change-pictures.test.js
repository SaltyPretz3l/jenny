'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../renderer/features/renderer-change-pictures-model');
const actionButton = require('../renderer/inventory/action-button');
const compareSlider = require('../renderer/inventory/compare-slider');
const { escapeHtml } = require('../renderer/shared/string-utils');
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
    model, getBridge: () => bridge, getLedgerBuilder: fakeLedger(events), compareSlider, actionButton, escapeHtml, ...extra,
  });
  return { dom, document, root: document.getElementById('root'), bridge, calls, cp, turns, ctx: { sessionId: 's1' } };
}

function attach(env) {
  env.panel = env.cp.attachPanel(env.root, {
    getSessionId: () => env.ctx.sessionId,
    getTurnViewModels: () => env.turns,
    getWorkspaceId: () => 'w1',
  });
  return env.panel;
}

const slot = (turnId) => `<div class="cp-slot" data-cp-turn="${turnId}"></div>`;
const WT_SLOT = '<div class="cp-slot" data-cp-working-tree></div>';
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/* ── Changes panel ── */

test('a ready turn gets a slider block, open because it is the newest turn', async () => {
  const env = build(slot('t1'), { capture: { t1: ok(rec('t1', [page('site/index.html', 'ready')])) } }, makeTurns([['t1', 'site/index.html']]));
  attach(env);
  await flush();
  const section = env.root.querySelector('section.cp');
  assert.ok(section);
  assert.equal(section.getAttribute('data-cp-page'), 'site/index.html');
  assert.equal(section.getAttribute('data-cp-state'), 'ready');
  assert.equal(section.getAttribute('data-expanded'), 'true');
  assert.equal(section.getAttribute('aria-label'), 'site/index.html, before and after');
  assert.equal(text(section.querySelector('.cp-title')), 'index.html');
  assert.equal(text(section.querySelector('.cp-sub')), 'site');
  const toggle = section.querySelector('button.cp-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(toggle.querySelector('svg.file-diff-chevron'));
  const tools = section.querySelectorAll('button.changes-scope-tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[0].getAttribute('aria-label'), 'Desktop size');
  assert.equal(tools[0].getAttribute('title'), 'Desktop size');
  assert.equal(tools[0].getAttribute('aria-pressed'), 'true');
  assert.equal(tools[1].getAttribute('aria-label'), 'Phone size');
  assert.equal(tools[1].getAttribute('aria-pressed'), 'false');
  const slider = section.querySelector('.inv-compare');
  assert.ok(slider);
  assert.equal(slider.querySelector('.inv-compare-img--before').getAttribute('src'), 'file:///data/site/index.html-b.png');
  assert.equal(slider.querySelector('.inv-compare-img--after').getAttribute('src'), 'file:///data/site/index.html-a.png');
  assert.equal(text(slider.querySelector('[data-compare-snap="100"]')), 'Before this turn');
  assert.equal(text(slider.querySelector('[data-compare-snap="0"]')), 'After');
  assert.equal(slider.querySelector('.inv-compare-handle').getAttribute('aria-label'), 'Before and after');
  assert.equal(env.root.querySelector('.cp-pending'), null);
  assert.deepEqual(env.calls.capture, [{
    sessionId: 's1',
    turnId: 't1',
    files: [{ path: 'site/index.html', status: 'modified', beforeHash: 'b-site/index.html', afterHash: 'h-site/index.html' }],
    viewport: 'desktop',
    force: false,
  }]);
});

test('same, after-failed and new pages show one picture and their sentence', async () => {
  const record = rec('t1', [page('same.html', 'same'), page('failed.html', 'after_failed'), page('fresh.html', 'new')]);
  const env = build(slot('t1'), { capture: { t1: ok(record) } }, makeTurns([['t1', 'same.html']]));
  attach(env);
  await flush();
  const same = env.root.querySelector('[data-cp-page="same.html"]');
  assert.equal(same.getAttribute('data-cp-state'), 'same');
  assert.equal(same.querySelector('img.cp-shot').getAttribute('src'), 'file:///data/same.html-a.png');
  assert.equal(same.querySelector('img.cp-shot').getAttribute('decoding'), 'async');
  assert.equal(same.querySelector('img.cp-shot').getAttribute('width'), '1000');
  assert.match(text(same.querySelector('.cp-caps')), /The top of the page looks the same at this size\./);
  assert.equal(text(same.querySelector('.cp-caps button.changes-wt-link')), 'Check phone size');

  const failed = env.root.querySelector('[data-cp-page="failed.html"]');
  assert.equal(failed.querySelector('img.cp-shot').getAttribute('src'), 'file:///data/failed.html-b.png');
  assert.match(text(failed.querySelector('.cp-caps')), /No After picture: the page didn't finish loading after the change\./);
  assert.equal(text(failed.querySelector('.cp-caps button.changes-wt-link')), 'Try again');

  const fresh = env.root.querySelector('[data-cp-page="fresh.html"]');
  assert.equal(fresh.querySelector('img.cp-shot').getAttribute('src'), 'file:///data/fresh.html-a.png');
  assert.match(text(fresh.querySelector('.cp-caps')), /New page, so there is no Before\./);
  assert.equal(fresh.querySelector('button.changes-wt-link'), null);
});

test('a deleted page shows the Before picture and says it was deleted; phone offers the desktop size', async () => {
  const record = rec('t1', [page('gone.html', 'deleted'), page('same.html', 'same')], 'phone');
  const env = build(slot('t1'), { capture: { t1: ok(record) } }, makeTurns([['t1', 'gone.html']]));
  attach(env);
  await flush();
  const gone = env.root.querySelector('[data-cp-page="gone.html"]');
  assert.equal(gone.querySelector('img.cp-shot').getAttribute('src'), 'file:///data/gone.html-b.png');
  assert.match(text(gone.querySelector('.cp-caps')), /This page was deleted\./);
  const tools = gone.querySelectorAll('button.changes-scope-tool');
  assert.equal(tools[0].getAttribute('aria-pressed'), 'false');
  assert.equal(tools[1].getAttribute('aria-pressed'), 'true');
  assert.equal(text(env.root.querySelector('[data-cp-page="same.html"] button.changes-wt-link')), 'Check desktop size');
});

test('only file URLs become pictures and bridge strings are escaped', async () => {
  const record = rec('t1', [
    page('a.html', 'ready', { afterUrl: 'https://evil.example/a.png' }),
    page('b.html', 'new', { afterUrl: 'javascript:alert(1)' }),
    page('<img src=x onerror=alert(1)>.html', 'same', { afterUrl: 'file:///x.png" onerror="alert(1)' }),
  ]);
  const env = build(slot('t1'), { capture: { t1: ok(record) } }, makeTurns([['t1', 'a.html']]));
  attach(env);
  await flush();
  assert.equal(env.root.querySelectorAll('section.cp').length, 3);
  assert.equal(env.root.querySelector('[data-cp-page="a.html"] img'), null);
  assert.equal(env.root.querySelector('[data-cp-page="b.html"] img'), null);
  assert.equal(env.root.querySelector('img[onerror]'), null);
  const imgs = env.root.querySelectorAll('img');
  for (const img of imgs) assert.ok(img.getAttribute('src').startsWith('file:'));
  assert.equal(env.root.querySelector('img[src="x"]'), null);
});

test('a pending request shows one plain line until the pictures arrive', async () => {
  const env = build(slot('t1'), { capture: () => never() }, makeTurns([['t1', 'index.html']]));
  attach(env);
  await flush();
  const line = env.root.querySelector('.cp-slot .cp-pending');
  assert.equal(text(line), 'Taking pictures…');
  assert.equal(env.root.querySelector('section.cp'), null);
});

test('a turn that changed no web file asks for nothing and stays empty', async () => {
  const env = build(slot('t1'), {}, makeTurns([['t1', 'notes.txt']]));
  attach(env);
  await flush();
  assert.equal(env.calls.capture.length, 0);
  assert.equal(env.root.querySelector('.cp-slot').innerHTML, '');
});

test('the working tree slot uses the commit labels and asks once per interval', async () => {
  const env = build(WT_SLOT, { captureWorkingTree: ok(rec('@working-tree', [page('index.html', 'ready')])) }, makeTurns([]));
  const panel = attach(env);
  await flush();
  const section = env.root.querySelector('section.cp');
  assert.equal(section.getAttribute('data-expanded'), 'true');
  const slider = section.querySelector('.inv-compare');
  assert.equal(text(slider.querySelector('[data-compare-snap="100"]')), 'Before · last commit');
  assert.equal(text(slider.querySelector('[data-compare-snap="0"]')), 'After · now');
  assert.equal(env.calls.captureWorkingTree.length, 1);
  assert.equal(env.calls.captureWorkingTree[0].sessionId, 's1');
  panel.refresh();
  await flush();
  env.root.insertAdjacentHTML('beforeend', '<p>other</p>');
  await flush();
  assert.equal(env.calls.captureWorkingTree.length, 1);
});

test('a fill with unchanged state writes nothing', async () => {
  const env = build(`${slot('t1')}<p id="other">x</p>`, { capture: { t1: ok(rec('t1', [page('index.html', 'ready')])) } }, makeTurns([['t1', 'index.html']]));
  const panel = attach(env);
  await flush();
  const target = env.root.querySelector('.cp-slot');
  const before = target.firstChild;
  const section = target.querySelector('section.cp');
  let writes = 0;
  new env.dom.window.MutationObserver(() => { writes += 1; }).observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
  panel.refresh();
  env.root.querySelector('#other').textContent = 'changed';
  env.root.insertAdjacentHTML('beforeend', '<p>more</p>');
  await flush();
  assert.equal(writes, 0);
  assert.equal(target.firstChild, before);
  assert.equal(target.querySelector('section.cp'), section);
});

test('a re-rendered slot is filled again from the cache without another request', async () => {
  const env = build(slot('t1'), { capture: { t1: ok(rec('t1', [page('index.html', 'ready')])) } }, makeTurns([['t1', 'index.html']]));
  attach(env);
  await flush();
  env.root.innerHTML = slot('t1');
  await flush();
  assert.ok(env.root.querySelector('section.cp .inv-compare'));
  assert.equal(env.calls.capture.length, 1);
  assert.equal(env.calls.list.length, 1);
});

test('only the five newest turns are ever requested, and the ledger is built only when needed', async () => {
  const events = [];
  const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
  const env = build(names.map(slot).join(''), {}, makeTurns(names.map((n) => [n, 'index.html'])), events);
  const panel = attach(env);
  await flush();
  assert.deepEqual(events, ['build', 'cap t7', 'cap t6', 'cap t5', 'cap t4', 'cap t3']);
  panel.refresh();
  await flush();
  assert.equal(events.filter((e) => e === 'build').length, 1);
});

test('a panel told the feature is off clears its slots and asks for nothing', async () => {
  const events = [];
  const env = build(slot('t1'), { list: { ok: true, enabled: true, records: [rec('t1', [page('index.html', 'ready')])] } }, makeTurns([['t1', 'index.html']]), events);
  let enabled = true;
  const panel = env.cp.attachPanel(env.root, { getSessionId: () => 's1', getTurnViewModels: () => env.turns, isEnabled: () => enabled });
  await flush();
  assert.ok(env.root.querySelector('section.cp'));
  enabled = false;
  panel.refresh();
  await flush();
  assert.equal(env.root.querySelector('section.cp'), null);
  assert.deepEqual(events, []);
});

test('turns whose pictures were listed need no request and no ledger', async () => {
  const events = [];
  const env = build(slot('t1'), { list: { ok: true, enabled: true, records: [rec('t1', [page('index.html', 'ready')])] } }, makeTurns([['t1', 'index.html']]), events);
  attach(env);
  await flush();
  assert.deepEqual(events, []);
  assert.ok(env.root.querySelector('section.cp .inv-compare'));
});

test('older turns start closed, a toggle opens one and the choice survives a re-render', async () => {
  const env = build(slot('t2') + slot('t1'), {
    list: { ok: true, enabled: true, records: [rec('t1', [page('a.html', 'ready')]), rec('t2', [page('b.html', 'ready')])] },
  }, makeTurns([['t1', 'a.html'], ['t2', 'b.html']]));
  attach(env);
  await flush();
  const old = () => env.root.querySelector('[data-cp-turn="t1"] section.cp');
  assert.equal(env.root.querySelector('[data-cp-turn="t2"] section.cp').getAttribute('data-expanded'), 'true');
  assert.equal(old().getAttribute('data-expanded'), 'false');
  assert.equal(old().querySelector('.cp-body'), null);
  assert.equal(old().querySelector('button.changes-scope-tool'), null);
  assert.equal(old().querySelector('button.cp-toggle').getAttribute('aria-expanded'), 'false');

  old().querySelector('button.cp-toggle').click();
  await flush();
  assert.equal(old().getAttribute('data-expanded'), 'true');
  assert.ok(old().querySelector('.inv-compare'));

  env.root.innerHTML = slot('t2') + slot('t1');
  await flush();
  assert.equal(old().getAttribute('data-expanded'), 'true');

  old().querySelector('button.cp-toggle').click();
  await flush();
  assert.equal(old().getAttribute('data-expanded'), 'false');
});

test('the slider position is remembered across re-renders, and the snap buttons work', async () => {
  const env = build(slot('t1'), { list: { ok: true, enabled: true, records: [rec('t1', [page('a.html', 'ready')])] } }, makeTurns([['t1', 'a.html']]));
  attach(env);
  await flush();
  compareSlider.setPosition(env.root.querySelector('.inv-compare'), 30);
  env.root.innerHTML = slot('t1');
  await flush();
  assert.equal(env.root.querySelector('.inv-compare').style.getPropertyValue('--pos'), '30%');
  env.root.querySelector('[data-compare-snap="100"]').click();
  env.root.innerHTML = slot('t1');
  await flush();
  assert.equal(env.root.querySelector('.inv-compare').style.getPropertyValue('--pos'), '100%');
});

test('a size button asks for the other size with the turn files', async () => {
  const env = build(slot('t1'), {
    list: { ok: true, enabled: true, records: [rec('t1', [page('a.html', 'ready')])] },
    capture: { t1: ok(rec('t1', [page('a.html', 'ready')], 'phone')) },
  }, makeTurns([['t1', 'a.html']]));
  attach(env);
  await flush();
  env.root.querySelector('button[data-cp-viewport="phone"]').click();
  await flush();
  assert.equal(env.calls.capture.length, 1);
  assert.equal(env.calls.capture[0].viewport, 'phone');
  assert.equal(env.calls.capture[0].force, false);
  assert.deepEqual(env.calls.capture[0].files.map((f) => f.path), ['a.html']);
  const tools = env.root.querySelectorAll('button.changes-scope-tool');
  assert.equal(tools[1].getAttribute('aria-pressed'), 'true');
  assert.equal(env.root.querySelector('.inv-compare').getAttribute('data-vp'), 'phone');
});

test('a new listing renames the working tree slot, which asks again without redrawing unchanged pictures', async () => {
  const clock = { t: 1000 };
  const env = build('<div class="cp-slot" data-cp-working-tree="1"></div>', {
    captureWorkingTree: ok(rec('@working-tree', [page('index.html', 'ready')])),
  }, makeTurns([]), null, { now: () => clock.t, setTimer: () => null });
  attach(env);
  await flush();
  const slot = env.root.querySelector('.cp-slot');
  const drawn = slot.querySelector('section.cp');
  assert.ok(drawn);
  clock.t += 3001;
  slot.setAttribute('data-cp-working-tree', '2');
  await flush();
  assert.equal(env.calls.captureWorkingTree.length, 2);
  assert.equal(slot.querySelector('section.cp'), drawn, 'the same record is not drawn again');
  slot.setAttribute('data-cp-working-tree', '2');
  await flush();
  assert.equal(env.calls.captureWorkingTree.length, 2);
});

test('the working tree size button asks for the other size even right after the first call', async () => {
  const env = build(WT_SLOT, { captureWorkingTree: ok(rec('@working-tree', [page('a.html', 'ready')])) }, makeTurns([]));
  attach(env);
  await flush();
  env.root.querySelector('button[data-cp-viewport="phone"]').click();
  await flush();
  assert.equal(env.calls.captureWorkingTree.length, 2);
  assert.equal(env.calls.captureWorkingTree[1].viewport, 'phone');
});

test('the "Check phone size" link asks like the size button', async () => {
  const env = build(slot('t1'), { list: { ok: true, enabled: true, records: [rec('t1', [page('a.html', 'same')])] } }, makeTurns([['t1', 'a.html']]));
  attach(env);
  await flush();
  env.root.querySelector('.cp-caps button.changes-wt-link').click();
  await flush();
  assert.equal(env.calls.capture.length, 1);
  assert.equal(env.calls.capture[0].viewport, 'phone');
});

test('Try again forces a new picture at the record size, and a null answer says why it stays', async () => {
  const env = build(slot('t1'), {
    list: { ok: true, enabled: true, records: [rec('t1', [page('a.html', 'after_failed')], 'phone')] },
    capture: { t1: ok(null) },
  }, makeTurns([['t1', 'a.html']]));
  attach(env);
  await flush();
  assert.doesNotMatch(text(env.root), /can't be retaken/);
  env.root.querySelector('.cp-caps button.changes-wt-link').click();
  await flush();
  assert.equal(env.calls.capture.length, 1);
  assert.equal(env.calls.capture[0].force, true);
  assert.equal(env.calls.capture[0].viewport, 'phone');
  assert.match(text(env.root), /These pictures can't be retaken: the files have changed since\./);
  assert.ok(env.root.querySelector('section.cp'));
});

test('an answer that the feature is off empties every slot, even ones already filled', async () => {
  const env = build(`${slot('t1')}${WT_SLOT}`, {
    list: { ok: true, enabled: true, records: [rec('t1', [page('a.html', 'ready')])] },
    captureWorkingTree: { ok: true, enabled: false, record: null },
  }, makeTurns([['t1', 'a.html']]));
  attach(env);
  await flush();
  assert.equal(env.root.querySelectorAll('.cp-slot').length, 2);
  for (const el of env.root.querySelectorAll('.cp-slot')) assert.equal(el.innerHTML, '');
  assert.ok(env.cp.cache.isDisabled());
});

test('without a session id every slot stays empty and the bridge is not called', async () => {
  const env = build(`${slot('t1')}${WT_SLOT}`, {}, makeTurns([['t1', 'a.html']]));
  env.ctx.sessionId = '';
  attach(env);
  await flush();
  assert.equal(env.calls.capture.length + env.calls.list.length + env.calls.captureWorkingTree.length, 0);
  for (const el of env.root.querySelectorAll('.cp-slot')) assert.equal(el.innerHTML, '');
});

test('dispose stops watching the panel', async () => {
  const env = build('', { capture: { t1: ok(rec('t1', [page('a.html', 'ready')])) } }, makeTurns([['t1', 'a.html']]));
  const panel = attach(env);
  await flush();
  panel.dispose();
  env.root.insertAdjacentHTML('beforeend', slot('t1'));
  await flush();
  assert.equal(env.root.querySelector('.cp-slot').innerHTML, '');
  assert.equal(env.calls.capture.length, 0);
});
