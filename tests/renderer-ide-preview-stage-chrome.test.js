'use strict';

/* Preview stage chrome markup (renderer-ide-preview-stage-chrome.js): pure
 * strings, escaped through the passed-in escapeHtml, buttons from the
 * inventory action-button primitive. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { previewBarHtml, previewStateHtml, applyLiveState, createBarController } = require('../renderer/features/renderer-ide-preview-stage-chrome');

const escapeHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const parse = (html) => {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  return dom.window.document.getElementById('root');
};

test('bar: name, kind and note spans keep today\'s classes; noteTitle only when set', () => {
  const root = parse(previewBarHtml({ path: 'a/<b>.html', name: '<b>.html', kindLabel: 'Sandboxed HTML', note: 'N <x>', noteTitle: 'T', escapeHtml }));
  assert.equal(root.querySelector('.ide-preview-stage-name').textContent, '<b>.html');
  assert.equal(root.querySelector('.ide-preview-stage-name').getAttribute('title'), 'a/<b>.html');
  assert.equal(root.querySelector('.ide-preview-stage-kind').textContent, 'Sandboxed HTML');
  const note = root.querySelector('[data-preview-note]');
  assert.equal(note.textContent, 'N <x>');
  assert.equal(note.getAttribute('title'), 'T');
  assert.equal(root.querySelector('b'), null, 'nothing is injected as markup');

  const plain = parse(previewBarHtml({ path: 'a.md', name: 'a.md', note: 'N', escapeHtml }));
  assert.equal(plain.querySelector('[data-preview-note]').hasAttribute('title'), false);
  assert.equal(plain.querySelector('.ide-preview-stage-kind'), null);
});

test('bar: empty name state has no tools; showReload adds the actions group and button', () => {
  const empty = parse(previewBarHtml({ path: '', escapeHtml }));
  assert.equal(empty.querySelector('.ide-preview-stage-name--empty').textContent, 'Preview');
  assert.equal(empty.querySelector('.ide-preview-stage-tools'), null);

  const root = parse(previewBarHtml({ path: 'a.md', name: 'a.md', showReload: true, escapeHtml }));
  const tools = root.querySelector('div.ide-editor-actions.ide-preview-stage-tools');
  assert.ok(tools);
  const button = tools.querySelector('button[data-preview-reload="true"]');
  assert.ok(button);
  assert.equal(button.className, 'ide-editor-action');
  assert.equal(button.getAttribute('aria-label'), 'Reload preview');
  assert.equal(button.getAttribute('title'), 'Reload preview');
  const svg = button.querySelector('svg');
  assert.equal(svg.getAttribute('width'), '14');
  assert.equal(svg.querySelectorAll('path').length, 2);
  assert.equal(root.querySelector('[data-preview-live]'), null, 'no cue unless liveVisible');
});

test('bar: the Live cue renders Live or Updating with the matching dot', () => {
  const live = parse(previewBarHtml({ path: 'a.md', name: 'a.md', showReload: true, liveVisible: true, liveState: 'live', escapeHtml }));
  const cue = live.querySelector('[data-preview-live]');
  assert.equal(cue.textContent, 'Live');
  assert.equal(cue.getAttribute('title'), 'Updates by itself when the file changes');
  assert.ok(cue.querySelector('.status-dot.status-dot--muted'));

  const updating = parse(previewBarHtml({ path: 'a.md', name: 'a.md', showReload: true, liveVisible: true, liveState: 'updating', escapeHtml }));
  assert.equal(updating.querySelector('[data-preview-live]').textContent, 'Updating');
  assert.ok(updating.querySelector('.status-dot--active'));
});

test('applyLiveState mutates the cue in place and keeps sibling nodes', () => {
  const root = parse(previewBarHtml({ path: 'a.md', name: 'a.md', showReload: true, liveVisible: true, liveState: 'live', escapeHtml }));
  const button = root.querySelector('button');
  const cue = root.querySelector('[data-preview-live]');
  applyLiveState(root, 'updating');
  assert.equal(root.querySelector('[data-preview-live]'), cue);
  assert.equal(cue.textContent, 'Updating');
  assert.ok(cue.querySelector('.status-dot--active'));
  applyLiveState(root, 'live');
  assert.equal(cue.textContent, 'Live');
  assert.ok(cue.querySelector('.status-dot--muted'));
  assert.equal(root.querySelector('button'), button);
  assert.doesNotThrow(() => applyLiveState(parse(''), 'live'));
});

test('buttons come from the inventory action-button primitive', (t) => {
  const calls = [];
  globalThis.inventoryActionButton = (opts) => { calls.push(opts); return '<i data-fake></i>'; };
  t.after(() => { delete globalThis.inventoryActionButton; });
  const bar = previewBarHtml({ path: 'a.md', name: 'a.md', showReload: true, escapeHtml });
  assert.match(bar, /<i data-fake><\/i>/);
  assert.equal(calls[0].plain, true);
  assert.equal(calls[0].className, 'ide-editor-action');
  assert.deepEqual(calls[0].dataset, { 'preview-reload': 'true' });
  assert.match(calls[0].trustedHtml, /^<svg /);
  previewStateHtml({ stateKind: 'missing', message: 'm', actionLabel: 'Try again', escapeHtml });
  assert.equal(calls[1].label, 'Try again');
  assert.equal(calls[1].size, 'sm');
  assert.deepEqual(calls[1].dataset, { 'preview-reload': 'true' });
});

test('state card: escaped message, optional action', () => {
  const plain = parse(previewStateHtml({ stateKind: 'empty', message: 'a <b> & c', escapeHtml }));
  const card = plain.querySelector('.ide-preview-stage-state');
  assert.equal(card.dataset.previewState, 'empty');
  assert.equal(card.textContent, 'a <b> & c');
  assert.equal(plain.querySelector('.ide-preview-stage-state-actions'), null);

  const withAction = parse(previewStateHtml({ stateKind: 'missing', message: 'gone', actionLabel: 'Try again', escapeHtml }));
  const button = withAction.querySelector('.ide-preview-stage-state-actions button[data-preview-reload="true"]');
  assert.equal(button.textContent.trim(), 'Try again');
  assert.match(button.className, /btn--sm/);
});

// ---- bar controller ----

function makeBar() {
  const dom = new JSDOM('<body><div id="bar"></div></body>');
  const barEl = dom.window.document.getElementById('bar');
  const timers = new Map();
  let nextId = 1;
  const windowRef = {
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  const bar = createBarController({
    getBarEl: () => barEl, windowRef, ideStateUtils: { fileNameOf: (p) => p }, escapeHtml, isWatchActive: () => true,
  });
  return { bar, barEl, timers, document: dom.window.document };
}

test('controller: the Live cue survives an HTML rebuild of the same path and kind, and shows Updating', () => {
  const h = makeBar();
  h.bar.render('a.html', 'html', 'n', false, 't');
  assert.equal(h.barEl.querySelector('[data-preview-live]'), null, 'not live before the frame succeeds');
  h.bar.markLive();
  assert.ok(h.barEl.querySelector('[data-preview-live]'));
  h.bar.render('a.html', 'html', 'n2', false, 't2');
  assert.ok(h.barEl.querySelector('[data-preview-live]'), 'the cue stays through the rebuild');
  h.bar.beginUpdating();
  h.bar.render('a.html', 'html', 'n3', false, 't3');
  assert.match(h.barEl.querySelector('[data-preview-live]').textContent, /Updating/);
  h.bar.render('b.html', 'html', 'n3', false, 't3');
  assert.equal(h.barEl.querySelector('[data-preview-live]'), null, 'a different path starts without the cue');
});

test('controller: a state card clears the cue and markdown done sets it', () => {
  const h = makeBar();
  h.bar.render('a.md', 'markdown', '', true);
  assert.ok(h.barEl.querySelector('[data-preview-live]'));
  h.bar.render('a.md', '', '', true);
  assert.equal(h.barEl.querySelector('[data-preview-live]'), null);
  h.bar.render('a.md', 'markdown', '', true);
  assert.ok(h.barEl.querySelector('[data-preview-live]'));
});

test('controller: unchanged inputs do not redraw, changed ones do', () => {
  const h = makeBar();
  h.bar.render('a.html', 'html', 'n', false, 't');
  const button = h.barEl.querySelector('[data-preview-reload]');
  h.bar.render('a.html', 'html', 'n', false, 't');
  assert.equal(h.barEl.querySelector('[data-preview-reload]'), button);
  h.bar.render('a.html', 'html', 'n', false, 'other');
  assert.notEqual(h.barEl.querySelector('[data-preview-reload]'), button, 'a changed title redraws');
});

test('controller: Reload keeps keyboard focus across a redraw', () => {
  const h = makeBar();
  h.bar.render('a.html', 'html', 'n', false, 't');
  h.barEl.querySelector('[data-preview-reload]').focus();
  assert.equal(h.document.activeElement, h.barEl.querySelector('[data-preview-reload]'));
  h.bar.render('a.html', 'html', 'changed', false, 't');
  assert.equal(h.document.activeElement, h.barEl.querySelector('[data-preview-reload]'));
  h.bar.showNote('transient');
  assert.equal(h.document.activeElement, h.barEl.querySelector('[data-preview-reload]'));
});

test('controller: noteTitle is its own input and a transient note shows none', () => {
  const h = makeBar();
  h.bar.render('a.html', 'html', 'one linked', false, 'Loaded: a.css');
  assert.equal(h.barEl.querySelector('[data-preview-note]').getAttribute('title'), 'Loaded: a.css');
  h.bar.showNote('Links don’t open');
  const note = h.barEl.querySelector('[data-preview-note]');
  assert.equal(note.textContent, 'Links don’t open');
  assert.equal(note.hasAttribute('title'), false);
  for (const timer of [...h.timers.values()].filter((t) => t.ms === 4000)) timer.fn();
  assert.equal(h.barEl.querySelector('[data-preview-note]').getAttribute('title'), 'Loaded: a.css');
  h.bar.render('b.md', 'markdown', 'plain', true);
  assert.equal(h.barEl.querySelector('[data-preview-note]').hasAttribute('title'), false);
});
