/* Composer V2 mode chips at the DOM layer. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createComposerModeChipsRenderer } = require('../renderer/chat/renderer-composer-v2-render');

function buildHarness(t, { runMode = 'ask' } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="composer-mode-chips" id="composerModeChips"><div id="composerModeChipsAnnouncer" class="sr-only" aria-live="polite" aria-atomic="true"></div><span id="composerRunModeHint"></span></div><div id="composerRunModeSlot"></div></body>');
  const container = dom.window.document.getElementById('composerModeChips');
  const announcer = dom.window.document.getElementById('composerModeChipsAnnouncer');
  const mode = { current: runMode };
  const renderer = createComposerModeChipsRenderer({
    container,
    announcer,
    getRunMode: () => mode.current,
  });
  t.after(() => renderer.destroy());
  return { announcer, container, mode, renderer };
}

test('dom-e2e: the mode row no longer owns a routine mode chip', (t) => {
  const h = buildHarness(t);
  assert.equal(h.container.querySelectorAll('button[data-mode]').length, 0);
});

test('dom-e2e: destroy removes mounted chips and detaches state updates', (t) => {
  const h = buildHarness(t);
  h.renderer.destroy();
  assert.equal(h.container.querySelectorAll('button[data-mode]').length, 0);
});

test('dom-e2e: the rail owns one run-mode chip and reflects its per-session reader', (t) => {
  const h = buildHarness(t);
  const chip = h.container.ownerDocument.getElementById('composerRunModeChip');
  assert.equal(chip.dataset.invChip, 'composer-run-mode');
  assert.equal(chip.hasAttribute('aria-pressed'), false);

  h.mode.current = 'plan';
  h.renderer.refresh();
  assert.ok(chip.classList.contains('composer-run-mode-plan'));
  assert.match(chip.getAttribute('aria-label'), /Run mode: Plan/);
});

test('dom-e2e: the permanent announcer prevents an empty collapse guard from matching', (t) => {
  const h = buildHarness(t);
  assert.equal(h.container.children.length, 2);
  assert.equal(h.container.firstElementChild, h.announcer);
  assert.equal(h.container.querySelectorAll('.composer-mode-chip').length, 0);
  assert.equal(h.container.matches(':empty'), false);
});

test('dom-e2e: the mode row lays out unconditionally — no collapse guard survives', () => {
  // With the chip in the rail, the row holds only the permanent announcer +
  // hint; the old :has(.composer-mode-chip) guard was unconditionally true and
  // needed a second :has() override to cancel it. Both are retired.
  const fs = require('fs');
  const path = require('path');
  const css = ['chat-composer-v2-affordances.css', 'chat-composer.css']
    .map((name) => fs.readFileSync(path.join(__dirname, '..', 'styles', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(css, /:not\(:has\(\.composer-mode-chip\)\)/);
  assert.doesNotMatch(css, /:has\(\.composer-run-mode-hint\)/);
});

