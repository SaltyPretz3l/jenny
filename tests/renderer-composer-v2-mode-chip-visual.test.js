/* Composer V2 mode-chip CSS class and token contract.
 *
 * JSDOM cannot reliably compute @media (prefers-reduced-motion: reduce) rules, so this file
 * pins the contract textually against the imported chat-composer CSS surface. Two halves:
 *   1. DOM-level: confirm CSS classes / icon spans / chip data attributes are applied.
 *   2. Stylesheet contract: confirm the shared chip token remains without retired variants. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createComposerModeChipsRenderer } = require('../renderer/chat/renderer-composer-v2-render');

const STYLES_ENTRY_PATH = path.join(__dirname, '..', 'styles.css');
const STYLES_CSS = readComposerCssSurface();

function readComposerCssSurface() {
  const stylesCss = fs.readFileSync(STYLES_ENTRY_PATH, 'utf8');
  return stylesCss
    .split(/\r?\n/)
    .map((line) => line.match(/url\("\.\/styles\/(chat-composer[^"]*\.css)"\)/)?.[1])
    .filter(Boolean)
    .map((fileName) => fs.readFileSync(path.join(__dirname, '..', 'styles', fileName), 'utf8'))
    .join('\n');
}

function buildHarness(t) {
  const dom = new JSDOM('<!doctype html><body><div id="composerModeChips"><div id="composerModeChipsAnnouncer" class="sr-only" aria-live="polite"></div><span id="composerRunModeHint"></span></div><div id="composerRunModeSlot"></div></body>');
  const doc = dom.window.document;
  const container = doc.getElementById('composerModeChips');
  const announcer = doc.getElementById('composerModeChipsAnnouncer');
  const renderer = createComposerModeChipsRenderer({
    container,
    announcer,
    getRunMode: () => 'plan',
  });
  t.after(() => { renderer.destroy(); });
  return { container, announcer };
}

test('visual: Plan run-mode chip carries the rail CSS class and inventory identity', (t) => {
  const { container } = buildHarness(t);
  const plan = container.ownerDocument.getElementById('composerRunModeChip');
  assert.ok(plan.classList.contains('composer-run-mode-chip'));
  assert.ok(plan.classList.contains('composer-run-mode-plan'));
  assert.equal(plan.dataset.invChip, 'composer-run-mode');
});

test('visual: Plan run-mode chip includes inventory icon and label spans', (t) => {
  const { container } = buildHarness(t);
  const plan = container.ownerDocument.getElementById('composerRunModeChip');
  assert.ok(plan.querySelector('span.inv-chip-icon > svg'));
  assert.equal(plan.querySelector('span.inv-chip-label').textContent, 'Plan');
});

test('stylesheet: the retired v1 mode-chip CSS is gone (rail chip owns the surface)', () => {
  // The old .composer-mode-chip family, its icon tokens, the plan-mode line,
  // and the collapse guard all died with the plan chip; the run-mode rail chip
  // styles via inv-chip + composer-run-mode-*. Dead CSS invites dead revivals.
  assert.doesNotMatch(STYLES_CSS, /--composer-mode-chip-icon-size:/);
  assert.doesNotMatch(STYLES_CSS, /\.composer-mode-chip\b/);
  assert.doesNotMatch(STYLES_CSS, /composer-plan-mode-line/);
  assert.doesNotMatch(STYLES_CSS, /composer-mode-chip-research/);
  assert.doesNotMatch(STYLES_CSS, /:not\(:has\(\.composer-mode-chip\)\)/);
});

test('stylesheet: the rail-config lock never keys on the streaming lifecycle (spec §6 matrix)', () => {
  // The §6 policy matrix makes the run-mode switcher, model pill, tools
  // toggles, and settings gear USABLE while a turn streams; the rail lock may
  // only cover the brief preflight window. A streaming-keyed [data-rail-config]
  // lock re-creates the exact owner-reported "controls locked while streaming".
  assert.doesNotMatch(
    STYLES_CSS,
    /data-send-lifecycle='streaming'[^{]*\[data-rail-config\]/,
    'no streaming-keyed rail-config lock'
  );
});

test('markup: the run-mode slot is never rail-locked (the switcher stays live in every send phase)', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const slotTag = indexHtml.match(/<div[^>]*id="composerRunModeSlot"[^>]*>/)?.[0];
  assert.ok(slotTag, 'run-mode slot present');
  assert.doesNotMatch(slotTag, /data-rail-config/, 'spec §4: the switcher is never disabled mid-turn');
});
