'use strict';

/* Top chrome, one row (area 1): the health signal in the title bar's right
 * cluster. Badge at the caption role (never under the 12px floor), the
 * accessible name carries every visible segment, the Auto chip is its own
 * button, and the popover's facts carry CPU / GPU / VRAM with a "Show load in
 * title bar" action. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  buildPillMarkup,
  buildPopoverMarkup,
} = require('../renderer/shell/renderer-health-pill-markup-utils');
const { createHealthPillController } = require('../renderer/shell/renderer-health-pill-utils');

const ROOT = path.resolve(__dirname, '..');
const readCss = (name) => fs.readFileSync(path.join(ROOT, 'styles', name), 'utf8');

// The body of the first top-level rule whose selector list is exactly `selector`.
function ruleBody(css, selector) {
  let from = 0;
  for (;;) {
    const at = css.indexOf(selector, from);
    if (at === -1) return '';
    const before = at === 0 ? '\n' : css[at - 1];
    const open = css.indexOf('{', at);
    if ((before === '\n' || before === '}') && css.slice(at + selector.length, open).trim() === '') {
      return css.slice(open + 1, css.indexOf('}', open));
    }
    from = at + selector.length;
  }
}

function fragment(html) {
  const doc = new JSDOM('<!doctype html><body></body>').window.document;
  const host = doc.createElement('div');
  host.innerHTML = html;
  return host;
}

const READY = { tone: 'success', label: 'Ready', segments: [{ tone: 'neutral', label: 'Remote · 2 devices' }] };
const STATS = {
  cpuPercent: 21.4,
  ramPercent: 40.2,
  arch: 'x64',
  platform: 'win32',
  gpuMemory: { available: true, usedMb: 13926, totalMb: 16282, utilAvailable: true, utilPercent: 93.2 },
};
const SNAPSHOT = { runtime: { engine: 'llama-server', model: 'qwen3.8-27b', model_loaded: true, lifecycle: { available: true, state: 'ready' } } };

test('error badge renders at the caption role exactly, 14px tall', () => {
  const badge = ruleBody(readCss('workbench-health-pill.css'), '.workbench-health-pill-error-badge');
  assert.ok(badge, 'badge rule exists');
  assert.match(badge, /font-size:\s*var\(--font-size-caption\);/);
  assert.doesNotMatch(badge, /calc\(/, 'no calc() scaling of the role token');
  assert.match(badge, /height:\s*14px;/);
  assert.match(badge, /line-height:\s*14px;/);
});

test('the accessible name carries every visible segment, the remote one included', () => {
  const host = fragment(buildPillMarkup(READY, {
    unseenErrorCount: 1, engine: 'llama-server', model: 'qwen3.8-27b',
  }));
  const pill = host.querySelector('#workbenchHealthPillButton');
  assert.equal(pill.getAttribute('aria-label'), 'Ready · llama-server · qwen3.8-27b · 1 recent error · Remote · 2 devices');
  assert.equal(pill.getAttribute('title'), pill.getAttribute('aria-label'));
  const remote = pill.querySelector('.workbench-health-pill-label[data-health-tone="neutral"]');
  assert.equal(remote?.textContent, 'Remote · 2 devices', 'the remote segment is visible in the pill');

  const loading = fragment(buildPillMarkup({ tone: 'pending', label: 'Loading qwen · 0:14', statusLabel: 'Loading qwen' }, {}));
  assert.equal(loading.querySelector('#workbenchHealthPillButton').getAttribute('aria-label'), 'Loading qwen',
    'the still status label, never the ticking clock');
});

test('the Auto chip is its own button beside the dot, named "Run mode: Auto"', () => {
  const host = fragment(buildPillMarkup(READY, { runMode: 'auto' }));
  const pill = host.querySelector('#workbenchHealthPillButton');
  const chip = host.querySelector('button.workbench-health-pill-mode');
  assert.ok(chip, 'a button');
  assert.equal(pill.contains(chip), false, 'not nested in the health button');
  assert.equal(chip.previousElementSibling, pill);
  assert.equal(chip.getAttribute('aria-label'), 'Run mode: Auto');
  assert.equal(chip.textContent, 'Auto');
  assert.equal(chip.dataset.healthPillAction, 'open-run-mode');
  assert.doesNotMatch(pill.getAttribute('aria-label'), /Auto/, 'the dot names health only');

  const paused = fragment(buildPillMarkup(READY, { runMode: 'auto', pauseState: 'paused' }));
  assert.equal(paused.querySelector('button.workbench-health-pill-mode').getAttribute('aria-label'), 'Run mode: Auto · Paused');
  assert.equal(fragment(buildPillMarkup(READY, { runMode: 'ask' })).querySelector('.workbench-health-pill-mode'), null);
});

test('popover facts carry CPU, GPU and VRAM when telemetry is available', () => {
  const state = { toneLabel: READY, error: '' };
  const host = fragment(buildPopoverMarkup(state, SNAPSHOT, { systemStats: STATS }));
  const load = host.querySelector('.workbench-health-popover-facts [data-health-fact="load"]');
  assert.ok(load, 'a load fact');
  assert.equal(load.textContent, 'CPU 21% · GPU 93% · VRAM 13.6 / 15.9 GB');

  const noGpu = fragment(buildPopoverMarkup(state, SNAPSHOT, { systemStats: { ...STATS, gpuMemory: { available: false } } }));
  assert.equal(noGpu.querySelector('[data-health-fact="load"]').textContent, 'CPU 21% · RAM 40%');

  const none = fragment(buildPopoverMarkup(state, SNAPSHOT, {}));
  assert.equal(none.querySelector('[data-health-fact="load"]'), null, 'no stats yet: no fabricated zeros');
});

test('popover actions: Diagnostics, Logs and the title-bar read-out toggle, all localized', () => {
  const state = { toneLabel: READY, error: '' };
  const off = fragment(buildPopoverMarkup(state, SNAPSHOT, { systemStats: STATS, titlebarLoad: false }));
  const actions = [...off.querySelectorAll('.workbench-health-popover-actions [data-health-pill-action]')]
    .map((node) => [node.dataset.healthPillAction, node.textContent]);
  assert.deepEqual(actions, [
    ['open-runtime-health', 'Diagnostics'],
    ['open-logs', 'Logs'],
    ['toggle-titlebar-load', 'Show load in title bar'],
  ]);
  const on = fragment(buildPopoverMarkup(state, SNAPSHOT, { systemStats: STATS, titlebarLoad: true }));
  assert.equal(on.querySelector('[data-health-pill-action="toggle-titlebar-load"]').textContent, 'Hide load from title bar');
});

test('popover copy renders through the translator: actions, status and the pluralized issue count', (t) => {
  const MARKUP_MODULE = require.resolve('../renderer/shell/renderer-health-pill-markup-utils');
  const previous = globalThis.jennyI18n;
  globalThis.jennyI18n = { t: (key) => `«${key}»`, tn: (key, count) => `«${key}:${count}»` };
  delete require.cache[MARKUP_MODULE];
  t.after(() => {
    globalThis.jennyI18n = previous;
    delete require.cache[MARKUP_MODULE];
    require(MARKUP_MODULE);
  });
  const translated = require(MARKUP_MODULE);
  const state = { toneLabel: READY, error: '' };
  const host = fragment(translated.buildPopoverMarkup(state, SNAPSHOT, { systemStats: STATS, titlebarLoad: false }));
  const labels = [...host.querySelectorAll('.workbench-health-popover-actions [data-health-pill-action]')].map((node) => node.textContent);
  assert.ok(labels.length >= 3);
  for (const label of labels) assert.match(label, /^«[\w.]+»$/, `action "${label}" is translated`);
  const failed = fragment(translated.buildPopoverMarkup({ toneLabel: READY, error: 'boom' }, SNAPSHOT, {}));
  assert.equal(failed.querySelector('.workbench-health-popover-status span:last-child').textContent, '«healthPill.error»');
  const pending = fragment(translated.buildPopoverMarkup(state, null, {}));
  assert.equal(pending.querySelector('.workbench-health-popover-empty').textContent, '«healthPill.popover.loading»');
  const issues = translated.formatRecentIssues({ logs: { available: true, recent_issues: [{}, {}] } });
  assert.equal(issues.html, '«healthPill.recentIssueCount:2»');
});

function createControllerHarness(t) {
  const dom = new JSDOM('<!doctype html><body><div class="titlebar-status"><div id="metricList" hidden></div><div id="slot"></div></div><div class="composer" data-toolbar-compact><div class="composer-settings-group"><div id="composerRunModeSlot"><button type="button" aria-pressed="false">Ask</button><button type="button" aria-pressed="true">Auto</button></div></div><button type="button" class="composer-settings-summary">Settings</button></div></body>', { pretendToBeVisual: true });
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  const statsListeners = new Set();
  const watches = [];
  const previousRunModeControl = globalThis.rendererRunModeControl;
  globalThis.rendererRunModeControl = { currentRunMode: () => 'auto' };
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => SNAPSHOT },
    system: {
      getStats: async () => STATS,
      onStats(listener) { statsListeners.add(listener); return () => statsListeners.delete(listener); },
      setStatsWatch: async (payload) => { watches.push(payload); return { watched: payload.watched }; },
    },
  };
  const views = [];
  // The compact composer's settings pill: the real one flips data-settings-open.
  const harness = { summaryClicks: 0 };
  const composer = window.document.querySelector('.composer');
  window.document.querySelector('.composer-settings-summary').addEventListener('click', () => {
    harness.summaryClicks += 1;
    composer.toggleAttribute('data-settings-open');
  });
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    setActiveView: (view) => views.push(view),
  });
  t.after(() => {
    controller.dispose();
    if (previousRunModeControl === undefined) delete globalThis.rendererRunModeControl;
    else globalThis.rendererRunModeControl = previousRunModeControl;
    window.close();
  });
  return { window, slot, controller, views, statsListeners, watches, get summaryClicks() { return harness.summaryClicks; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the chip opens the run-mode setting (the composer switcher), not the health dialog', async (t) => {
  const h = createControllerHarness(t);
  await h.controller.refresh?.();
  const chip = h.slot.querySelector('button.workbench-health-pill-mode');
  assert.ok(chip, 'auto mode shows the chip');
  chip.click();
  await settle();
  assert.equal(h.controller.isPopoverOpen(), false, 'the health dialog stays closed');
  assert.deepEqual(h.views, ['chat']);
  assert.equal(h.summaryClicks, 1, 'a compact composer opens its settings group first');
  assert.equal(h.window.document.activeElement, h.window.document.querySelector('#composerRunModeSlot [aria-pressed="true"]'));
  chip.click();
  await settle();
  assert.equal(h.summaryClicks, 1, 'an open group is not toggled shut again');
});

test('in split view the chip focuses the switcher in the focused pane, not in pane 0', async (t) => {
  const pane0 = '<div class="chat-pane" id="chatPane0" data-pane-id="0" data-pane-focused="false"><div class="composer"><div id="composerRunModeSlot"><button type="button" aria-pressed="true">Auto</button></div></div></div>';
  const pane1 = '<div class="chat-pane" data-pane-id="1" data-pane-focused="true"><div class="composer" data-toolbar-compact><div class="composer-settings-group"><div data-chat-node="composerRunModeSlot"><button type="button" aria-pressed="false">Ask</button><button type="button" aria-pressed="true" id="paneOneAuto">Auto</button></div></div><button type="button" class="composer-settings-summary">Settings</button></div></div>';
  const dom = new JSDOM(`<!doctype html><body><div id="slot"></div><section id="chatView">${pane0}${pane1}</section></body>`, { pretendToBeVisual: true });
  const { window } = dom;
  const previousRunModeControl = globalThis.rendererRunModeControl;
  globalThis.rendererRunModeControl = { currentRunMode: () => 'auto' };
  window.jennyShell = { diagnostics: { getJennyStatus: async () => SNAPSHOT } };
  let paneOneSummaryClicks = 0;
  const paneOneComposer = window.document.querySelector('[data-pane-id="1"] .composer');
  paneOneComposer.querySelector('.composer-settings-summary').addEventListener('click', () => {
    paneOneSummaryClicks += 1;
    paneOneComposer.toggleAttribute('data-settings-open');
  });
  const controller = createHealthPillController({ window, document: window.document, slot: window.document.getElementById('slot'), setActiveView: () => {} });
  t.after(() => {
    controller.dispose();
    if (previousRunModeControl === undefined) delete globalThis.rendererRunModeControl;
    else globalThis.rendererRunModeControl = previousRunModeControl;
    window.close();
  });
  await controller.refresh?.();
  window.document.querySelector('#slot button.workbench-health-pill-mode').click();
  await settle();
  assert.equal(window.document.activeElement?.id, 'paneOneAuto', 'the pressed segment in the focused pane');
  assert.equal(paneOneSummaryClicks, 1, 'the compact settings group in the focused pane opens');
});

test('the popover reads machine load only while open, and the toggle asks Settings to flip the read-out', async (t) => {
  const h = createControllerHarness(t);
  await h.controller.refresh?.();
  assert.equal(h.statsListeners.size, 0, 'no stats subscription while closed');
  h.slot.querySelector('#workbenchHealthPillButton').click();
  await settle();
  assert.equal(h.statsListeners.size, 1);
  assert.deepEqual(h.watches, [{ source: 'popover', watched: true }], 'opening declares the popover a stats watcher');
  const popover = h.window.document.getElementById('workbenchHealthPopover');
  assert.equal(popover.querySelector('[data-health-fact="load"]').textContent, 'CPU 21% · GPU 93% · VRAM 13.6 / 15.9 GB');
  for (const listener of h.statsListeners) listener({ ...STATS, cpuPercent: 64 });
  assert.match(h.window.document.querySelector('[data-health-fact="load"]').textContent, /^CPU 64%/, 'live while open');

  const requests = [];
  h.window.document.addEventListener('jenny:titlebar-load-toggle', (event) => requests.push(event.detail));
  h.window.document.querySelector('[data-health-pill-action="toggle-titlebar-load"]').click();
  assert.deepEqual(requests, [{ enabled: true }], 'the read-out is hidden, so the action shows it');
  assert.equal(h.controller.isPopoverOpen(), false);
  assert.equal(h.statsListeners.size, 0, 'closing drops the subscription');
  assert.deepEqual(h.watches.at(-1), { source: 'popover', watched: false }, 'and releases the watch');
});
