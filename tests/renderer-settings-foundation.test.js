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
