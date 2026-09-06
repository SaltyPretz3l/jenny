'use strict';

/* tests/renderer-ide-map-controls.test.js - red-first coverage for
 * renderer/features/renderer-ide-map-controls.js: the Living Atlas controls
 * bar (search field with debounce/Enter-submit/Escape-clear, three layer
 * toggle chips, hide-tests toggle + N/N readout, status chip, overview
 * pressed state, inventory-only markup, dispose). Uses jsdom directly;
 * t.after() teardown, never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createMapControls } = require('../renderer/features/renderer-ide-map-controls');

function setupHost() {
  const dom = new JSDOM('<div id="host"></div>');
  const hostEl = dom.window.document.getElementById('host');
  return { dom, hostEl };
}

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (id) => { pending.delete(id); },
    },
    flushAll() {
      const entries = Array.from(pending.entries());
      pending.clear();
      for (const [, { fn }] of entries) fn();
    },
    get pendingCount() { return pending.size; },
  };
}

function dispatchKeydown(el, key) {
  el.dispatchEvent(new el.ownerDocument.defaultView.KeyboardEvent('keydown', { key, bubbles: true }));
}

// ── DOM-mounted controls bar ─────────────────────────────────────────────────

test('renders inventory-only markup: search field, layer chips, toggle switch, spacer, action buttons', (t) => {
  const { hostEl } = setupHost();
  const controls = createMapControls({ hostEl });
  t.after(() => controls.dispose());

  assert.ok(hostEl.querySelector('.ide-map-search'), 'expected the search text field');
  assert.equal(hostEl.querySelector('.ide-map-search .inv-text-field-control').getAttribute('placeholder'), 'Search files…');
  assert.equal(hostEl.querySelectorAll('.ide-map-layer-chip').length, 3, 'expected three layer chips');
  assert.ok(hostEl.querySelector('[data-action="layer-activity"]'), 'expected the Activity chip');
  assert.ok(hostEl.querySelector('[data-action="layer-health"]'), 'expected the Health chip');
  assert.ok(hostEl.querySelector('[data-action="layer-deps"]'), 'expected the Deps chip');
  assert.ok(hostEl.querySelector('[data-inv-toggle="ide-map-hide-tests"]'), 'expected the hide-tests toggle');
  assert.ok(hostEl.querySelector('.ide-map-controls-spacer'), 'expected the spacer');
  assert.ok(hostEl.querySelector('[data-action="generate"]'), 'expected the Generate button');
  assert.ok(hostEl.querySelector('[data-action="refresh"]'), 'expected the Refresh button');
  assert.ok(hostEl.querySelector('[data-action="overview"]'), 'expected the Overview button');
  // No lens select — retired.
  assert.equal(hostEl.querySelector('select'), null, 'the lens select must be gone');
  // No raw primitives: every interactive control is inventory-rendered.
  assert.equal(hostEl.querySelectorAll('input:not(.inv-text-field-control)').length, 0);
});

test('layer chips default to activity:true, health:false, deps:true (mirrors prefs defaults)', (t) => {
  const { hostEl } = setupHost();
  const controls = createMapControls({ hostEl });
  t.after(() => controls.dispose());

  assert.equal(hostEl.querySelector('[data-action="layer-activity"]').getAttribute('aria-pressed'), 'true');
  assert.equal(hostEl.querySelector('[data-action="layer-health"]').getAttribute('aria-pressed'), 'false');
  assert.equal(hostEl.querySelector('[data-action="layer-deps"]').getAttribute('aria-pressed'), 'true');
});

test('search input fires onSearchChange only after the debounce elapses (fake timers)', (t) => {
  const { hostEl } = setupHost();
  const fake = fakeTimers();
  const calls = [];
  const controls = createMapControls({ hostEl, timers: fake.timers, onSearchChange: (v) => calls.push(v) });
  t.after(() => controls.dispose());

  const input = hostEl.querySelector('.ide-map-search .inv-text-field-control');
  input.value = 'widget';
  input.dispatchEvent(new hostEl.ownerDocument.defaultView.Event('input', { bubbles: true }));

  assert.equal(calls.length, 0, 'debounced callback must not fire synchronously');
  assert.equal(fake.pendingCount, 1, 'exactly one debounce timer must be pending');
  fake.flushAll();
  assert.deepEqual(calls, ['widget']);
});

test('rapid search keystrokes coalesce into a single debounced call with the final value', (t) => {
  const { hostEl } = setupHost();
  const { timers, flushAll } = fakeTimers();
  const calls = [];
  const controls = createMapControls({ hostEl, timers, onSearchChange: (v) => calls.push(v) });
  t.after(() => controls.dispose());

  const input = hostEl.querySelector('.ide-map-search .inv-text-field-control');
  const EventCtor = hostEl.ownerDocument.defaultView.Event;
  for (const value of ['w', 'wi', 'wid', 'widg']) {
    input.value = value;
    input.dispatchEvent(new EventCtor('input', { bubbles: true }));
  }
  flushAll();
  assert.deepEqual(calls, ['widg'], 'only the last keystroke value should be delivered');
});

test('Enter in the search field fires onSearchSubmit immediately, bypassing the debounce', (t) => {
  const { hostEl } = setupHost();
  const fake = fakeTimers();
  const changeCalls = [];
  const submitCalls = [];
  const controls = createMapControls({
    hostEl,
    timers: fake.timers,
    onSearchChange: (v) => changeCalls.push(v),
    onSearchSubmit: (v) => submitCalls.push(v),
  });
  t.after(() => controls.dispose());

  const input = hostEl.querySelector('.ide-map-search .inv-text-field-control');
  input.value = 'router.js';
  input.dispatchEvent(new hostEl.ownerDocument.defaultView.Event('input', { bubbles: true }));
  assert.equal(fake.pendingCount, 1, 'debounce timer scheduled by the input event');

  dispatchKeydown(input, 'Enter');
  assert.deepEqual(submitCalls, ['router.js'], 'onSearchSubmit fires with the current value');
  assert.equal(fake.pendingCount, 0, 'Enter cancels the pending debounce');
  assert.equal(changeCalls.length, 0, 'onSearchChange never fires — the debounce was cancelled');
  assert.equal(input.value, 'router.js');
});

test('Escape in the search field clears the field and fires onSearchClear (not onSearchChange)', (t) => {
  const { hostEl } = setupHost();
  const fake = fakeTimers();
  const changeCalls = [];
  const clearCalls = [];
  const controls = createMapControls({
    hostEl,
    timers: fake.timers,
    onSearchChange: (v) => changeCalls.push(v),
    onSearchClear: () => clearCalls.push(true),
  });
  t.after(() => controls.dispose());

  const input = hostEl.querySelector('.ide-map-search .inv-text-field-control');
  input.value = 'widget';
  input.dispatchEvent(new hostEl.ownerDocument.defaultView.Event('input', { bubbles: true }));
  assert.equal(fake.pendingCount, 1);

  dispatchKeydown(input, 'Escape');
  assert.equal(input.value, '', 'the field is cleared');
  assert.equal(clearCalls.length, 1, 'onSearchClear fires once');
  assert.equal(fake.pendingCount, 0, 'Escape cancels the pending debounce');
  assert.equal(changeCalls.length, 0, 'onSearchChange never fires on Escape');
});

test('layer chip clicks fire onLayerToggle with the toggled name/pressed and flip aria-pressed', (t) => {
  const { hostEl } = setupHost();
  const calls = [];
  const controls = createMapControls({ hostEl, onLayerToggle: (name, pressed) => calls.push([name, pressed]) });
  t.after(() => controls.dispose());

  const EventCtor = hostEl.ownerDocument.defaultView.MouseEvent;
  const healthChip = hostEl.querySelector('[data-action="layer-health"]');
  healthChip.dispatchEvent(new EventCtor('click', { bubbles: true }));
  assert.deepEqual(calls, [['health', true]], 'health starts false, toggles to true');
  assert.equal(healthChip.getAttribute('aria-pressed'), 'true');

  const activityChip = hostEl.querySelector('[data-action="layer-activity"]');
  activityChip.dispatchEvent(new EventCtor('click', { bubbles: true }));
  assert.deepEqual(calls, [['health', true], ['activity', false]], 'activity starts true, toggles to false');
  assert.equal(activityChip.getAttribute('aria-pressed'), 'false');
});

test('hide-tests toggle click fires onHideTestsChange with the new checked state', (t) => {
  const { hostEl } = setupHost();
  const calls = [];
  const controls = createMapControls({ hostEl, onHideTestsChange: (v) => calls.push(v) });
  t.after(() => controls.dispose());

  const track = hostEl.querySelector('[data-inv-toggle="ide-map-hide-tests"]');
  track.dispatchEvent(new hostEl.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(calls, [true]);
  assert.equal(track.getAttribute('aria-checked'), 'true');
});

test('Generate and Refresh buttons invoke their respective callbacks', (t) => {
  const { hostEl } = setupHost();
  let generated = 0;
  let refreshed = 0;
  const controls = createMapControls({
    hostEl,
    onGenerate: () => { generated += 1; },
    onRefresh: () => { refreshed += 1; },
  });
  t.after(() => controls.dispose());

  const EventCtor = hostEl.ownerDocument.defaultView.MouseEvent;
  hostEl.querySelector('[data-action="generate"]').dispatchEvent(new EventCtor('click', { bubbles: true }));
  hostEl.querySelector('[data-action="refresh"]').dispatchEvent(new EventCtor('click', { bubbles: true }));

  assert.equal(generated, 1);
  assert.equal(refreshed, 1);
});

test('setTestCounts renders an N/N readout', (t) => {
  const { hostEl } = setupHost();
  const controls = createMapControls({ hostEl });
  t.after(() => controls.dispose());

  controls.setTestCounts(3, 12);
  assert.equal(hostEl.querySelector('[data-map-hide-tests-count]').textContent, '3/12');
});

test('setState restores search/hideTests/layers without re-firing change callbacks', (t) => {
  const { hostEl } = setupHost();
  const calls = { search: [], hideTests: [], layer: [] };
  const controls = createMapControls({
    hostEl,
    onSearchChange: (v) => calls.search.push(v),
    onHideTestsChange: (v) => calls.hideTests.push(v),
    onLayerToggle: (name, pressed) => calls.layer.push([name, pressed]),
  });
  t.after(() => controls.dispose());

  controls.setState({ search: 'foo', hideTests: true, layers: { activity: false, health: true, deps: false } });

  assert.deepEqual(calls.search, [], 'setState must not fire onSearchChange');
  assert.deepEqual(calls.hideTests, [], 'setState must not fire onHideTestsChange');
  assert.deepEqual(calls.layer, [], 'setState must not fire onLayerToggle');
  assert.equal(hostEl.querySelector('.ide-map-search .inv-text-field-control').value, 'foo');
  assert.equal(hostEl.querySelector('[data-inv-toggle="ide-map-hide-tests"]').getAttribute('aria-checked'), 'true');
  assert.equal(hostEl.querySelector('[data-action="layer-health"]').getAttribute('aria-pressed'), 'true');
  assert.equal(hostEl.querySelector('[data-action="layer-activity"]').getAttribute('aria-pressed'), 'false');
  assert.equal(hostEl.querySelector('[data-action="layer-deps"]').getAttribute('aria-pressed'), 'false');
});

test('setState with a partial layers object leaves the other layers untouched', (t) => {
  const { hostEl } = setupHost();
  const controls = createMapControls({ hostEl });
  t.after(() => controls.dispose());

  controls.setState({ layers: { health: true } });
  assert.equal(hostEl.querySelector('[data-action="layer-activity"]').getAttribute('aria-pressed'), 'true');
  assert.equal(hostEl.querySelector('[data-action="layer-health"]').getAttribute('aria-pressed'), 'true');
  assert.equal(hostEl.querySelector('[data-action="layer-deps"]').getAttribute('aria-pressed'), 'true');
});

test('setStatus renders a transient chip; empty message / clearStatus clears it', (t) => {
  const { hostEl } = setupHost();
  const controls = createMapControls({ hostEl });
  t.after(() => controls.dispose());

  const slot = hostEl.querySelector('[data-map-status-slot]');
  assert.ok(slot, 'status slot present in the bar');
  assert.equal(slot.innerHTML, '', 'empty by default');

  controls.setStatus('Map updated · 42 files · 10 links · 0 cycles');
  assert.match(slot.textContent, /Map updated · 42 files · 10 links · 0 cycles/);

  controls.clearStatus();
  assert.equal(slot.innerHTML, '', 'clearStatus empties the slot');

  controls.setStatus('anything');
  assert.notEqual(slot.innerHTML, '');
  controls.setStatus('');
  assert.equal(slot.innerHTML, '', 'empty message also clears');
});

test('setStatus auto-clears after autoClearMs (fake timers)', (t) => {
  const { hostEl } = setupHost();
  const fake = fakeTimers();
  const controls = createMapControls({ hostEl, timers: fake.timers });
  t.after(() => controls.dispose());

  controls.setStatus('Rescanning…', { spinner: true, autoClearMs: 4000 });
  const slot = hostEl.querySelector('[data-map-status-slot]');
  assert.match(slot.textContent, /Rescanning…/);
  assert.equal(fake.pendingCount, 1, 'an auto-clear timer is pending');
  fake.flushAll();
  assert.equal(slot.innerHTML, '', 'chip auto-clears when the timer fires');
});

test('persistent partial status survives transient search and refresh messages', (t) => {
  const { hostEl } = setupHost();
  const fake = fakeTimers();
  const controls = createMapControls({ hostEl, timers: fake.timers });
  t.after(() => controls.dispose());
  const slot = hostEl.querySelector('[data-map-status-slot]');

  controls.setPersistentStatus('Partial map · Enumeration time limit after 6,214 files');
  assert.match(slot.textContent, /Partial map/);
  controls.setStatus('12 matches — Enter to cycle');
  assert.match(slot.textContent, /12 matches/);
  controls.clearStatus();
  assert.match(slot.textContent, /Partial map/, 'clearing transient status restores disclosure');
  controls.setStatus('Map updated', { autoClearMs: 4000 });
  fake.flushAll();
  assert.match(slot.textContent, /Partial map/, 'auto-clear restores persistent disclosure');
  controls.clearPersistentStatus();
  assert.equal(slot.innerHTML, '');
});

test('status survives a setState() rebuild (re-applied into the fresh slot)', (t) => {
  const { hostEl } = setupHost();
  const controls = createMapControls({ hostEl });
  t.after(() => controls.dispose());

  controls.setStatus('Map updated · 3 files · 1 links · 0 cycles');
  controls.setState({ hideTests: true }); // forces a full render()
  const slot = hostEl.querySelector('[data-map-status-slot]');
  assert.match(slot.textContent, /Map updated · 3 files/, 'status re-applied after render');
});

test('setOverviewPressed reflects on the Overview button aria-pressed (survives render)', (t) => {
  const { hostEl } = setupHost();
  const controls = createMapControls({ hostEl });
  t.after(() => controls.dispose());

  const btn = () => hostEl.querySelector('[data-action="overview"]');
  assert.equal(btn().getAttribute('aria-pressed'), 'false', 'defaults to not-pressed');
  controls.setOverviewPressed(true);
  assert.equal(btn().getAttribute('aria-pressed'), 'true');
  controls.setState({ hideTests: false }); // rebuild
  assert.equal(btn().getAttribute('aria-pressed'), 'true', 'pressed state re-applied after render');
  controls.setOverviewPressed(false);
  assert.equal(btn().getAttribute('aria-pressed'), 'false');
});

test('status chip emits no raw input/select primitives', (t) => {
  const { hostEl } = setupHost();
  const controls = createMapControls({ hostEl });
  t.after(() => controls.dispose());

  controls.setStatus('Rescanning…', { spinner: true });
  const slot = hostEl.querySelector('[data-map-status-slot]');
  assert.equal(slot.querySelector('input'), null);
  assert.equal(slot.querySelector('select'), null);
  assert.equal(slot.querySelector('button'), null);
});

test('focusSearch focuses the search field; focusFilter is kept as an alias', (t) => {
  const { hostEl } = setupHost();
  const controls = createMapControls({ hostEl });
  t.after(() => controls.dispose());

  assert.equal(typeof controls.focusFilter, 'function', 'focusFilter alias must exist for the a11y module');
  controls.focusSearch();
  assert.equal(hostEl.ownerDocument.activeElement, hostEl.querySelector('.ide-map-search .inv-text-field-control'));
});

test('dispose() removes listeners and clears the host; further input does nothing', (t) => {
  const { hostEl } = setupHost();
  const { timers } = fakeTimers();
  const calls = [];
  const controls = createMapControls({ hostEl, timers, onGenerate: () => calls.push('generate') });

  controls.dispose();
  assert.equal(hostEl.innerHTML, '');
  // Idempotent.
  controls.dispose();
  assert.equal(hostEl.innerHTML, '');
  assert.deepEqual(calls, []);
});
