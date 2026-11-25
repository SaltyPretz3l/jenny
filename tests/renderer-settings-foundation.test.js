'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const foundation = require('../renderer/shell/renderer-settings-foundation');

function makeEl(tag = 'span') {
  const dom = new JSDOM(`<!doctype html><body><${tag} id="t"></${tag}></body>`);
  return { dom, el: dom.window.document.getElementById('t') };
}

// ── T5 — badge loading -> live state model ──────────────────────────────
test('buildBadgeStateModel maps known states and suppresses loading text', () => {
  const live = foundation.buildBadgeStateModel({ state: 'live', text: 'llama3' });
  assert.equal(live.state, 'live');
  assert.equal(live.badgeState, 'ready');
  assert.equal(live.text, 'llama3');

  const loading = foundation.buildBadgeStateModel({ state: 'loading', text: 'stale' });
  assert.equal(loading.state, 'loading');
  assert.equal(loading.badgeState, 'loading');
  assert.equal(loading.text, '', 'loading suppresses stale text so it cannot flash');

  const unknown = foundation.buildBadgeStateModel({ state: 'banana', text: 'x' });
  assert.equal(unknown.state, 'muted', 'unknown state falls back to muted');
});

test('buildBadgeStateModel derives ariaLabel from srLabel then text', () => {
  assert.equal(
    foundation.buildBadgeStateModel({ state: 'info', text: 'Default backend' }).ariaLabel,
    'Default backend'
  );
  assert.equal(
    foundation.buildBadgeStateModel({ state: 'info', text: 'x', srLabel: 'Override active' }).ariaLabel,
    'Override active'
  );
});

test('applyBadgeState mutates element data-state, text, and aria-label', () => {
  const { el } = makeEl();
  foundation.applyBadgeState(el, foundation.buildBadgeStateModel({ state: 'warn', text: 'Unavailable' }));
  assert.equal(el.getAttribute('data-state'), 'warn');
  assert.equal(el.getAttribute('data-badge-state'), 'ready');
  assert.equal(el.textContent, 'Unavailable');
  assert.equal(el.getAttribute('aria-label'), 'Unavailable');
});

test('applyBadgeState accepts a raw options object and builds the model itself', () => {
  const { el } = makeEl();
  const resolved = foundation.applyBadgeState(el, { state: 'loading', text: 'stale' });
  assert.equal(resolved.badgeState, 'loading');
  assert.equal(el.getAttribute('data-badge-state'), 'loading');
  assert.equal(el.textContent, '');
});

test('applyBadgeState tolerates a null element', () => {
  assert.equal(foundation.applyBadgeState(null, { state: 'live', text: 'x' }), null);
});

test('applyNote sets text and collapses (hidden) when empty', () => {
  const { el } = makeEl('div');
  foundation.applyNote(el, 'Requires sign-in.');
  assert.equal(el.textContent, 'Requires sign-in.');
  assert.equal(el.hidden, false);
  foundation.applyNote(el, '');
  assert.equal(el.textContent, '');
  assert.equal(el.hidden, true);
  // Tolerates a null element.
  assert.equal(foundation.applyNote(null, 'x'), '');
});

// ── T9 — non-colour verdict signal ──────────────────────────────────────
// ── T3 / T6 — read-only status list ─────────────────────────────────────

// ── Row 193 C2: the restart list and its bar ────────────────────────────
function barDocument() {
  const dom = new JSDOM('<!doctype html><body><div class="settings-content-frame"><div class="settings-content-scroll"></div></div></body>');
  return { dom, doc: dom.window.document };
}

test('restart list: add, remove, list and a change callback that can be dropped', () => {
  const list = foundation.createRestartList();
  const seen = [];
  const off = list.onChange((items) => seen.push(items.map((i) => i.id)));
  list.add('lang', 'Language');
  list.add('lang', 'Language');
  list.add('ctx', 'Context size');
  assert.deepEqual(list.list(), [{ id: 'lang', label: 'Language' }, { id: 'ctx', label: 'Context size' }]);
  assert.equal(list.has('lang'), true);
  list.remove('lang');
  list.remove('missing');
  assert.deepEqual(seen, [['lang'], ['lang', 'ctx'], ['ctx']], 'one call per real change');
  off();
  list.remove('ctx');
  assert.equal(seen.length, 3);
  assert.deepEqual(list.list(), []);
});

test('restart list: track keeps a setting waiting only while it differs from the value at app start', () => {
  const list = foundation.createRestartList();
  list.track('lang', 'Language', 'en', 'fr');
  assert.equal(list.has('lang'), true);
  list.track('lang', 'Language', 'fr', 'de');
  assert.equal(list.has('lang'), true, 'the start value stays the first one');
  list.track('lang', 'Language', 'de', 'en');
  assert.equal(list.has('lang'), false, 'back at the start value, nothing is owed');
});

test('restart bar: absent when empty, singular and plural words, gone when the list empties', () => {
  const { dom, doc } = barDocument();
  const list = foundation.createRestartList();
  foundation.paintRestartBar(doc, list.list());
  assert.equal(doc.querySelector('.settings-restart-bar'), null);
  list.add('lang', 'Language');
  foundation.paintRestartBar(doc, list.list());
  const bar = doc.querySelector('.settings-restart-bar');
  assert.equal(bar.nextElementSibling.className, 'settings-content-scroll', 'the bar sits above the scrolling pages');
  assert.equal(bar.textContent.trim(), '1 setting takes effect after a restart: Language.');
  assert.equal(bar.getAttribute('role'), 'status');
  list.add('ctx', 'Context size');
  foundation.paintRestartBar(doc, list.list());
  assert.equal(doc.querySelectorAll('.settings-restart-bar').length, 1, 'one bar, repainted in place');
  assert.equal(doc.querySelector('.settings-restart-bar').textContent.trim(), '2 settings take effect after a restart: Language, Context size.');
  list.remove('lang');
  list.remove('ctx');
  foundation.paintRestartBar(doc, list.list());
  assert.equal(doc.querySelector('.settings-restart-bar'), null);
  dom.window.close();
});

test('restart bar: Restart now shows only when a restart handler exists and calls it', () => {
  const { dom, doc } = barDocument();
  foundation.paintRestartBar(doc, [{ id: 'lang', label: 'Language' }]);
  assert.equal(doc.querySelector('.settings-restart-bar button'), null, 'no button without a way to restart');
  let calls = 0;
  foundation.paintRestartBar(doc, [{ id: 'lang', label: 'Language' }], { onRestart: () => { calls += 1; } });
  const button = doc.querySelector('.settings-restart-bar button');
  assert.equal(button.textContent.trim(), 'Restart now');
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(calls, 1);
  dom.window.close();
});
