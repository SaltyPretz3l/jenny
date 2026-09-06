/* Variant-B run-mode switcher chip (COMPOSER_RUN_MODE_SPEC §5, owner-locked). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createComposerModeChipsRenderer,
  createRunModeSwitcherRenderer,
} = require('../renderer/chat/renderer-composer-v2-render');

const HINT_COPY = {
  ask: 'Jenny asks before running tools that change things.',
  auto: 'Tools run without asking. Python, blocked commands, and explicit denies still prompt.',
  plan: 'Read-only: Jenny plans first and presents it before acting.',
};

function buildHarness(t, { runMode = 'ask' } = {}) {
  const dom = new JSDOM('<!doctype html><body>'
    + '<div class="composer-mode-chips" id="composerModeChips">'
    + '<div id="composerModeChipsAnnouncer" class="sr-only" aria-live="polite" aria-atomic="true"></div>'
    + '<span class="composer-run-mode-hint" id="composerRunModeHint"></span>'
    + '</div>'
    + '<div class="composer-run-mode-slot" id="composerRunModeSlot"></div>'
    + '</body>');
  const doc = dom.window.document;
  const state = { runMode };
  const calls = { cycles: 0 };
  const renderer = createRunModeSwitcherRenderer({
    slot: doc.getElementById('composerRunModeSlot'),
    hint: doc.getElementById('composerRunModeHint'),
    getRunMode: () => state.runMode,
    onCycle: () => { calls.cycles += 1; },
  });
  t.after(() => renderer.destroy());
  return { doc, state, calls, renderer };
}

function chipOf(doc) {
  return doc.getElementById('composerRunModeChip');
}

test('switcher mounts one chip with the Ask identity by default', (t) => {
  const h = buildHarness(t);
  const chip = chipOf(h.doc);
  assert.ok(chip, 'chip mounted');
  assert.equal(h.doc.querySelectorAll('#composerRunModeChip').length, 1);
  assert.equal(chip.dataset.invChip, 'composer-run-mode');
  assert.ok(chip.classList.contains('composer-run-mode-chip'));
  assert.ok(chip.classList.contains('composer-run-mode-ask'));
  assert.match(chip.textContent, /Ask/);
  assert.ok(chip.querySelector('svg'), 'mode icon present — color is never the only signal');
  assert.equal(chip.getAttribute('aria-keyshortcuts'), 'Shift+Tab');
  assert.match(chip.title, / \(Shift\+Tab to cycle\)$/);
  assert.equal(chip.hasAttribute('aria-pressed'), false, 'three-state indicator, not a toggle');
  assert.match(chip.getAttribute('aria-label') || '', /Ask/);
  assert.match(chip.getAttribute('aria-label') || '', /Auto/, 'aria-label names the next mode');
});

test('sync updates identity in place across all three modes', (t) => {
  const h = buildHarness(t);
  const chip = chipOf(h.doc);
  const askIcon = chip.querySelector('svg').outerHTML;

  h.state.runMode = 'auto';
  h.renderer.sync();
  assert.equal(chipOf(h.doc), chip, 'same node updated in place');
  assert.ok(chip.classList.contains('composer-run-mode-auto'));
  assert.ok(!chip.classList.contains('composer-run-mode-ask'));
  assert.match(chip.textContent, /Auto/);
  assert.notEqual(chip.querySelector('svg').outerHTML, askIcon, 'icon changes with the mode');
  assert.match(chip.getAttribute('aria-label') || '', /Plan/, 'next mode in the cycle');

  h.state.runMode = 'plan';
  h.renderer.sync();
  assert.ok(chip.classList.contains('composer-run-mode-plan'));
  assert.match(chip.textContent, /Plan/);
});

test('the hint line always states what the current mode means', (t) => {
  const h = buildHarness(t);
  const hint = h.doc.getElementById('composerRunModeHint');
  assert.equal(hint.textContent, HINT_COPY.ask);
  h.state.runMode = 'auto';
  h.renderer.sync();
  assert.equal(hint.textContent, HINT_COPY.auto);
  h.state.runMode = 'plan';
  h.renderer.sync();
  assert.equal(hint.textContent, HINT_COPY.plan);
});

test('a malformed stored mode renders as Ask', (t) => {
  const h = buildHarness(t, { runMode: 'garbage' });
  const chip = chipOf(h.doc);
  assert.ok(chip.classList.contains('composer-run-mode-ask'));
  assert.match(chip.textContent, /Ask/);
});

test('click requests one cycle step', (t) => {
  const h = buildHarness(t);
  chipOf(h.doc).click();
  assert.equal(h.calls.cycles, 1);
});

test('destroy unmounts the chip', (t) => {
  const h = buildHarness(t);
  h.renderer.destroy();
  assert.equal(chipOf(h.doc), null);
});

test('the mode-chips renderer no longer mounts the retired Plan chip', (t) => {
  const dom = new JSDOM('<!doctype html><body>'
    + '<div class="composer-mode-chips" id="composerModeChips">'
    + '<div id="composerModeChipsAnnouncer" class="sr-only" aria-live="polite" aria-atomic="true"></div>'
    + '</div></body>');
  const container = dom.window.document.getElementById('composerModeChips');
  const renderer = createComposerModeChipsRenderer({
    container,
    getPlanMode: () => true,
    onPlanModeToggle: () => {},
  });
  t.after(() => renderer.destroy());
  assert.equal(dom.window.document.getElementById('composerPlanModeChip'), null);
  assert.equal(container.querySelectorAll('button[data-mode]').length, 0);
});
