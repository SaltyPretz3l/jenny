/* Variant-B run-mode switcher chip (COMPOSER_RUN_MODE_SPEC §5, owner-locked). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createComposerModeChipsRenderer,
  createRunModeSwitcherRenderer,
  syncRunModeChip,
  syncRunModeSegmentsDisabled,
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
    + '</div>'
    + '<div class="composer-run-mode-slot" id="composerRunModeSlot"></div>'
    + '</body>');
  const doc = dom.window.document;
  const state = { runMode };
  const calls = { cycles: 0 };
  const renderer = createRunModeSwitcherRenderer({
    slot: doc.getElementById('composerRunModeSlot'),
    getRunMode: () => state.runMode,
    onCycle: () => { calls.cycles += 1; },
  });
  t.after(() => renderer.destroy());
  return { dom, doc, state, calls, renderer };
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
  assert.equal(chip.title, `Ask · ${HINT_COPY.ask}`, 'the tooltip states what the mode means');
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

test('the chip title and label always state what the current mode means', (t) => {
  const h = buildHarness(t);
  const chip = chipOf(h.doc);
  assert.equal(chip.title, `Ask · ${HINT_COPY.ask}`);
  assert.equal(chip.getAttribute('aria-label').endsWith(` ${HINT_COPY.ask}`), true);
  h.state.runMode = 'auto';
  h.renderer.sync();
  assert.equal(chip.title, `Auto · ${HINT_COPY.auto}`);
  assert.equal(chip.getAttribute('aria-label').endsWith(` ${HINT_COPY.auto}`), true);
  h.state.runMode = 'plan';
  h.renderer.sync();
  assert.equal(chip.title, `Plan · ${HINT_COPY.plan}`);
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

/* Collapsed settings popover (spec 2026-09-26 §4 step 4): an inline
 * Ask | Auto | Plan segmented control in the same slot as the chip. */
function segmentsOf(doc) {
  return doc.getElementById('composerRunModeSlot').querySelector('.composer-run-mode-segments');
}

function pressedModes(doc) {
  return Array.from(segmentsOf(doc).querySelectorAll('[data-run-mode-option]'))
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.getAttribute('data-run-mode-option'));
}

test('the slot also mounts an Ask | Auto | Plan segment group after the chip', (t) => {
  const h = buildHarness(t, { runMode: 'auto' });
  const slot = h.doc.getElementById('composerRunModeSlot');
  assert.equal(slot.children.length, 2);
  assert.equal(slot.firstElementChild, chipOf(h.doc), 'the chip stays first');
  const group = segmentsOf(h.doc);
  assert.equal(slot.lastElementChild, group);
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-label'), 'Run mode');
  assert.equal(group.id, '', 'segments get no ids');
  const buttons = Array.from(group.children);
  assert.deepEqual(buttons.map((b) => b.getAttribute('data-run-mode-option')), ['ask', 'auto', 'plan']);
  buttons.forEach((button, index) => {
    const mode = ['ask', 'auto', 'plan'][index];
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.ok(button.classList.contains('composer-run-mode-segment'));
    assert.ok(button.classList.contains(`composer-run-mode-segment--${mode}`));
    assert.equal(button.getAttribute('title'), HINT_COPY[mode], 'the mode hint copy');
    assert.equal(button.id, '');
    const icon = button.querySelector('.composer-run-mode-segment-icon');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.ok(icon.querySelector('svg'), 'the mode icon');
    assert.equal(button.querySelector('.composer-run-mode-segment-label').textContent, ['Ask', 'Auto', 'Plan'][index]);
  });
  assert.deepEqual(pressedModes(h.doc), ['auto']);
  assert.ok(buttons[1].classList.contains('is-active'));
  assert.ok(!buttons[0].classList.contains('is-active'));
  assert.equal(buttons.some((b) => b.disabled), false);
});

test('segments follow the mode on every sync: aria-pressed and is-active on the current one only', (t) => {
  const h = buildHarness(t);
  assert.deepEqual(pressedModes(h.doc), ['ask']);
  for (const mode of ['plan', 'auto', 'ask']) {
    h.state.runMode = mode;
    h.renderer.sync();
    assert.deepEqual(pressedModes(h.doc), [mode]);
    const active = Array.from(segmentsOf(h.doc).querySelectorAll('.is-active')).map((b) => b.dataset.runModeOption);
    assert.deepEqual(active, [mode]);
  }
  // pane 0's pipeline path (syncRunModeChip by id) syncs the same segments
  syncRunModeChip('plan', h.doc);
  assert.deepEqual(pressedModes(h.doc), ['plan']);
});

test('an unchanged apply writes nothing to the segments (gate C13 cache)', (t) => {
  const h = buildHarness(t, { runMode: 'plan' });
  const observer = new h.dom.window.MutationObserver(() => {});
  observer.observe(segmentsOf(h.doc), { attributes: true, subtree: true, childList: true });
  t.after(() => observer.disconnect());
  h.renderer.sync();
  h.renderer.sync();
  assert.equal(observer.takeRecords().length, 0, 'no segment write on an unchanged apply');
  h.state.runMode = 'ask';
  h.renderer.sync();
  assert.ok(observer.takeRecords().length > 0, 'a mode change writes');
});

test('a disabled chip disables all three segments, and re-enabling mirrors back', async (t) => {
  const h = buildHarness(t);
  const chip = chipOf(h.doc);
  const buttons = () => Array.from(segmentsOf(h.doc).querySelectorAll('[data-run-mode-option]'));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  // both panes flip chip.disabled directly (plugin read-only sessions)
  chip.disabled = true;
  await settle();
  assert.deepEqual(buttons().map((b) => b.disabled), [true, true, true], 'the observer mirrors a direct flip');
  chip.disabled = false;
  await settle();
  assert.deepEqual(buttons().map((b) => b.disabled), [false, false, false]);
  // the exported helper: slot, chip or group; synchronous
  assert.equal(syncRunModeSegmentsDisabled(h.doc.getElementById('composerRunModeSlot'), true), true);
  assert.deepEqual(buttons().map((b) => b.disabled), [true, true, true]);
  assert.equal(syncRunModeSegmentsDisabled(chip, false), true);
  assert.deepEqual(buttons().map((b) => b.disabled), [false, false, false]);
  assert.equal(syncRunModeSegmentsDisabled(segmentsOf(h.doc), true), true);
  assert.deepEqual(buttons().map((b) => b.disabled), [true, true, true]);
  syncRunModeSegmentsDisabled(chip, false);
  assert.equal(syncRunModeSegmentsDisabled(null, true), false);
  assert.equal(syncRunModeSegmentsDisabled(h.doc.body.appendChild(h.doc.createElement('div')), true), false);
});

test('applyRunModeChip mirrors the chip disabled state synchronously (disabled rides the cache key)', (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="composerRunModeSlot"></div><span id="composerRunModeHint"></span></body>');
  const doc = dom.window.document;
  const renderer = createRunModeSwitcherRenderer({ slot: doc.getElementById('composerRunModeSlot'), getRunMode: () => 'ask' });
  t.after(() => renderer.destroy());
  const buttons = () => Array.from(segmentsOf(doc).querySelectorAll('button')).map((b) => b.disabled);
  const chip = chipOf(doc);
  chip.disabled = true;
  renderer.sync();
  assert.deepEqual(buttons(), [true, true, true], 'no microtask needed on the apply path');
  chip.disabled = false;
  renderer.sync();
  assert.deepEqual(buttons(), [false, false, false]);
});

test('segment clicks do not trigger the chip cycle handler', (t) => {
  const h = buildHarness(t);
  segmentsOf(h.doc).querySelector('[data-run-mode-option="plan"]').click();
  assert.equal(h.calls.cycles, 0);
});

test('destroy removes the segments with the chip', (t) => {
  const h = buildHarness(t);
  h.renderer.destroy();
  assert.equal(segmentsOf(h.doc), null);
  assert.equal(h.doc.getElementById('composerRunModeSlot').children.length, 0);
});

test('a second pane switcher (domId empty) mounts id-less segments that follow its own reader', (t) => {
  const dom = new JSDOM('<!doctype html><body><div class="pane-slot"></div></body>');
  const doc = dom.window.document;
  const slot = doc.querySelector('.pane-slot');
  const mode = { current: 'ask' };
  const renderer = createRunModeSwitcherRenderer({ slot, domId: '', getRunMode: () => mode.current });
  t.after(() => renderer.destroy());
  assert.equal(slot.querySelectorAll('[id]').length, 0);
  mode.current = 'auto';
  renderer.sync();
  const pressed = Array.from(slot.querySelectorAll('[aria-pressed="true"]')).map((b) => b.dataset.runModeOption);
  assert.deepEqual(pressed, ['auto']);
});
