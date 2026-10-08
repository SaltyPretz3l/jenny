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


test('dom-e2e: the rail slot also carries the Ask | Auto | Plan segments; refresh syncs aria-pressed, a disabled chip disables them', async (t) => {
  const h = buildHarness(t, { runMode: 'auto' });
  const doc = h.container.ownerDocument;
  const slot = doc.getElementById('composerRunModeSlot');
  const chip = doc.getElementById('composerRunModeChip');
  const group = slot.querySelector('.composer-run-mode-segments[role="group"]');
  assert.ok(group, 'segments mounted beside the chip');
  assert.equal(chip.nextElementSibling, group);
  const pressed = () => Array.from(group.querySelectorAll('[aria-pressed="true"]')).map((b) => b.dataset.runModeOption);
  assert.deepEqual(pressed(), ['auto']);
  h.mode.current = 'plan';
  h.renderer.refresh();
  assert.deepEqual(pressed(), ['plan']);
  assert.equal(chip.hasAttribute('aria-pressed'), false, 'the chip stays a three-state indicator');

  chip.disabled = true; // plugin read-only session (the render pipeline flips it directly)
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(Array.from(group.querySelectorAll('button')).map((b) => b.disabled), [true, true, true, true]);

  h.renderer.destroy();
  assert.equal(slot.querySelector('.composer-run-mode-segments'), null, 'destroy removes the segments');
});

test('dom-e2e: cycling through every run mode leaves exactly one composer-run-mode-* class', (t) => {
  const h = buildHarness(t);
  const chip = h.container.ownerDocument.getElementById('composerRunModeChip');
  const modeClasses = () => Array.from(chip.classList).filter((c) => /^composer-run-mode-(?!chip$)/.test(c));
  for (const mode of ['ask', 'auto', 'plan', 'propose', 'ask', 'propose', 'plan']) {
    h.mode.current = mode;
    h.renderer.refresh();
    assert.deepEqual(modeClasses(), [`composer-run-mode-${mode}`], `after switching to ${mode}`);
    assert.equal(chip.classList.contains('inv-chip--on'), mode === 'auto');
  }
});

test('dom-e2e: an unchanged apply still strips a stale run-mode class', (t) => {
  const h = buildHarness(t, { runMode: 'ask' });
  const chip = h.container.ownerDocument.getElementById('composerRunModeChip');
  chip.classList.add('composer-run-mode-propose');
  h.renderer.refresh();
  assert.equal(chip.classList.contains('composer-run-mode-propose'), false);
  assert.ok(chip.classList.contains('composer-run-mode-ask'));
});
