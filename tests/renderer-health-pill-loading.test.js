'use strict';

// Status loader (2026-09-29): the health pill carries the model load
// ("Loading {model} · m:ss", a 1 s visibility-gated tick) and speaks a
// translated tone vocabulary (Blocked / Degraded were literal English).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const PILL_MODULE = require.resolve('../renderer/shell/renderer-health-pill-utils');
const { combineHealthSignal, createHealthPillController, formatElapsed } = require(PILL_MODULE);

const T0 = Date.parse('2026-09-29T12:00:00.000Z');

function loadingSnapshot(extra = {}) {
  return {
    runtime: {
      lifecycle: {
        available: true,
        state: 'sidecar_spawned',
        model_state: 'model_loading',
        model_acquisition: { requested_model: 'qwen3:8b', stage: 'model_loading', ...extra },
      },
    },
  };
}

test('formatElapsed reads m:ss', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(14_400), '0:14');
  assert.equal(formatElapsed(75_000), '1:15');
  assert.equal(formatElapsed(-5), '0:00');
});

// A-7: one m:ss clock for the pill and the popover; the popover download line
// uses decimal units, as the model sources report sizes.
test('the pill and the popover share one clock and one byte base', () => {
  const markup = require('../renderer/shell/renderer-health-pill-markup-utils');
  assert.equal(formatElapsed, markup.formatLoadClock);
  const popoverLine = markup.formatModelAcquisition({ runtime: { lifecycle: { model_acquisition: {
    requested_model: 'q', stage: 'acquiring', percent: 25, completed_bytes: 1.2e9, total_bytes: 4.8e9,
  } } } }).html;
  assert.match(popoverLine, /1\.2 GB \/ 4\.8 GB$/);
});

test('a model load reads "Loading {model} · m:ss" from the load start the backend reports', () => {
  const signal = combineHealthSignal(
    loadingSnapshot({ started_at: new Date(T0 - 14_000).toISOString() }),
    { now: T0 },
  );
  assert.equal(signal.tone, 'pending');
  assert.equal(signal.label, 'Loading qwen3:8b · 0:14');
  assert.equal(signal.loading, true);
  assert.equal(signal.statusLabel, 'Loading qwen3:8b', 'the accessible name carries no ticking clock');
});

test('without a backend start time the pill counts from when it first saw the load', () => {
  const signal = combineHealthSignal(loadingSnapshot(), { now: T0, loadingSinceMs: T0 - 61_000 });
  assert.equal(signal.label, 'Loading qwen3:8b · 1:01');
  const unnamed = combineHealthSignal({
    runtime: { lifecycle: { available: true, state: 'loading' } },
  }, { now: T0, loadingSinceMs: T0 - 3_000 });
  assert.equal(unnamed.label, 'Loading model · 0:03');
});

test('the tone-only vocabulary goes through the translator', (t) => {
  const previous = globalThis.jennyI18n;
  globalThis.jennyI18n = {
    t: (key, fallback) => ({ 'titlebar.runtimeHealth.blocked': 'Bloqueado', 'titlebar.runtimeHealth.degraded': 'Degradado' }[key] || fallback),
  };
  delete require.cache[PILL_MODULE];
  t.after(() => {
    globalThis.jennyI18n = previous;
    delete require.cache[PILL_MODULE];
    require(PILL_MODULE);
  });
  const translated = require(PILL_MODULE);
  const ready = { runtime: { lifecycle: { available: true, state: 'ready' } } };
  assert.equal(translated.combineHealthSignal(ready, {
    deriveRuntimeHealthState: () => ({ tone: 'danger', summary: 'x' }),
  }).label, 'Bloqueado');
  assert.equal(translated.combineHealthSignal(ready, {
    deriveRuntimeHealthState: () => ({ tone: 'warning', summary: 'y' }),
  }).label, 'Degradado');
});

function setup(t, fetch) {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>', { pretendToBeVisual: true });
  const { window } = dom;
  const timers = new Map();
  let id = 0;
  let visibility = 'visible';
  let clock = T0;
  Object.defineProperty(window.document, 'visibilityState', { get: () => visibility });
  window.setTimeout = (fn, ms) => { timers.set(++id, { fn, ms }); return id; };
  window.clearTimeout = (key) => timers.delete(key);
  window.jennyShell = { diagnostics: { getJennyStatus: fetch } };
  const slot = window.document.getElementById('slot');
  const controller = createHealthPillController({ window, slot, now: () => clock });
  t.after(() => { controller.dispose(); window.close(); });
  return {
    window, slot, controller, timers,
    advance(ms) { clock += ms; },
    visibility(value) {
      visibility = value;
      window.document.dispatchEvent(new window.Event('visibilitychange'));
    },
    fireElapsedTick() {
      const entry = [...timers.entries()].find(([, timer]) => timer.ms === 1000);
      assert.ok(entry, 'a 1 s elapsed tick is scheduled');
      timers.delete(entry[0]);
      entry[1].fn();
    },
  };
}

async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

test('the elapsed counter ticks in place each second while visible and stops when the load ends', async (t) => {
  let current = loadingSnapshot({ started_at: new Date(T0 - 2_000).toISOString() });
  const h = setup(t, async () => current);
  await h.controller.refresh({ silent: true });
  const button = h.slot.querySelector('button');
  const label = () => h.slot.querySelector('.workbench-health-pill-label').textContent;
  assert.equal(label(), 'Loading qwen3:8b · 0:02');
  assert.equal(button.getAttribute('aria-label'), 'Loading qwen3:8b', 'the still status label, not the clock');

  h.advance(1000);
  h.fireElapsedTick();
  assert.equal(label(), 'Loading qwen3:8b · 0:03');
  assert.equal(h.slot.querySelector('button'), button, 'the tick never rebuilds the button');
  assert.equal(button.getAttribute('aria-label'), 'Loading qwen3:8b', 'the still status label, not the clock');

  h.visibility('hidden');
  assert.equal([...h.timers.values()].some((timer) => timer.ms === 1000), false, 'no tick while hidden');

  current = { runtime: { lifecycle: { available: true, state: 'ready', model_state: 'ready' } } };
  h.visibility('visible');
  await settle();
  assert.equal(h.controller.getState().label, 'Ready');
  assert.equal([...h.timers.values()].some((timer) => timer.ms === 1000), false, 'the tick stops once loaded');
});

test('the popover says what the same model took last time, only while it loads', () => {
  const { buildPopoverMarkup } = require('../renderer/shell/renderer-health-pill-markup-utils');
  const state = { error: '', toneLabel: { tone: 'pending', label: 'Loading qwen3:8b · 0:05' } };
  const loading = buildPopoverMarkup(state, loadingSnapshot({ last_load_ms: 48_250 }), {});
  assert.match(loading, /data-health-fact="last-load"[^>]*>Last time: 0:48</);

  const firstLoad = buildPopoverMarkup(state, loadingSnapshot({ last_load_ms: null }), {});
  assert.doesNotMatch(firstLoad, /last-load/, 'no memory of this model: no line');

  const ready = buildPopoverMarkup(
    { error: '', toneLabel: { tone: 'success', label: 'Ready' } },
    { runtime: { lifecycle: { available: true, state: 'ready', model_state: 'ready',
      model_acquisition: { requested_model: 'qwen3:8b', stage: 'ready', last_load_ms: 48_250 } } } },
    {}
  );
  assert.doesNotMatch(ready, /last-load/, 'once loaded the expectation has no reader');
});
