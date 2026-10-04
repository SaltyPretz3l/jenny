'use strict';

// Runtime limits (Settings > Runtime limits): commit-on-change through the
// CAS persister, per-field Default/Revert and the two-step section reset.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const controllers = require('../renderer/shell/renderer-orchestration-controller');
const runsView = require('../renderer/shell/renderer-runs-view');
const limitsView = require('../renderer/shell/renderer-runtime-limits-view');
const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');
const { clone, snapshot, settle, deferred, harness } = require('./helpers/runs-orchestration-harness');

const limitInput = (h, key) => h.limitsHost.querySelector(`[data-draft="${key}"]`);
const limitRow = (h, key) => h.limitsHost.querySelector(`[data-limit="${key}"]`);
const shownLimits = snap => ({ ...clone(snap.lanes.configured_limits), resources: clone(snap.resources.configured_limits) });
// The persister echoes the whole saved set: the expectation with the patch applied.
const ackLimits = payload => {
  const saved = clone(payload.expected_limits);
  for (const [group, values] of Object.entries(payload.patch)) Object.assign(saved[group], values);
  return { ok: true, configured_limits: saved };
};
function withLimits(snap, changes) {
  const next = clone(snap);
  for (const [group, key, value] of changes) {
    if (group === 'resources') next.resources.configured_limits[key] = value;
    else next.lanes.configured_limits[group][key] = value;
  }
  return next;
}
function commitLimit(h, key, value) {
  const el = limitInput(h, key);
  el.value = value;
  el.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  el.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
}

test('Runtime limits: one settings row per limit with the shared Default meta, the capped note, and no Save', async () => {
  const h = harness({}, { section: 'advanced' });
  const capped = withLimits(snapshot(), [['cloud', 'runnable_turns', 6]]);
  capped.lanes.effective_limits.cloud.runnable_turns = 3;
  h.setSnapshot(capped);
  h.controller.bind(); await settle();
  const rows = [...h.limitsHost.querySelectorAll('.settings-field--row[data-settings-field^="runtime_limit_"]')];
  assert.equal(rows.length, 11);
  assert.equal(h.limitsHost.querySelectorAll('h3').length, 1, 'one title, no second heading');
  assert.equal(h.limitsHost.querySelector('.runs-row'), null, 'no work list here');
  const localTurns = limitInput(h, 'limit_local_runnable_turns');
  assert.equal(localTurns.id, 'runtime_limit_local_runnable_turns', 'the search reveal lands on the input');
  assert.equal(localTurns.type, 'number');
  assert.equal(localTurns.getAttribute('min'), '1');
  assert.equal(localTurns.getAttribute('step'), '1');
  assert.equal(limitInput(h, 'limit_local_descendants').getAttribute('min'), '0');
  assert.equal(rows[0].querySelector('.settings-field-title').textContent, 'Local chats running at once');
  assert.equal(rows[0].querySelector('.settings-field-meta-default').textContent, 'Default: 1');
  assert.equal(rows[0].querySelector('.settings-field-meta-modified').hidden, true);
  assert.equal(rows[0].querySelector('[data-setting-revert]').hidden, true);
  assert.equal(rows[0].querySelector('.settings-field-meta [data-setting-revert]'), null, 'the Revert is not on the meta line');
  assert.equal(rows[0].querySelector('.settings-field-control > .inv-number-input').nextElementSibling,
    rows[0].querySelector('[data-setting-revert]'), 'it follows the field in the control cell');
  assert.equal(rows[0].querySelector('[data-limits-note]').textContent, '');
  const cloud = limitRow(h, 'limit_cloud_runnable_turns');
  assert.equal(cloud.querySelector('.settings-field-meta-default').textContent, 'Default: 2');
  assert.equal(cloud.querySelector('[data-limits-note]').textContent, 'capped at 3 by this machine');
  assert.equal(cloud.querySelector('[data-limits-note]').classList.contains('limits-note--capped'), true);
  assert.equal(cloud.getAttribute('data-modified'), 'true');
  assert.equal(cloud.querySelector('.settings-field-meta-modified').hidden, false);
  assert.equal(cloud.querySelector('[data-setting-revert]').hidden, false);
  assert.equal(h.limitsHost.querySelector('[data-action="limits-save"]'), null, 'no Save: a change applies at once');
  h.controller.dispose();
});

test('Runtime limits: a change writes exactly one key with the shown expectation; the field alone is busy', async () => {
  const writes = [];
  const gate = deferred();
  let h = null;
  h = harness({ updateLimits: payload => { writes.push(payload); return gate.promise.then(result => {
    h.setSnapshot(withLimits(snapshot(), [['local', 'runnable_turns', 3]])); return result; }); } }, { section: 'advanced' });
  h.controller.bind(); await settle();
  commitLimit(h, 'limit_local_runnable_turns', '3'); await settle();
  assert.deepEqual(writes, [{ expected_limits: shownLimits(snapshot()), patch: { local: { runnable_turns: 3 } } }]);
  const input = limitInput(h, 'limit_local_runnable_turns');
  assert.equal(input.disabled, true);
  assert.equal(input.getAttribute('aria-busy'), 'true');
  assert.equal(limitRow(h, 'limit_local_runnable_turns').getAttribute('data-state'), 'busy');
  assert.equal(limitInput(h, 'limit_cloud_runnable_turns').disabled, false, 'other fields stay editable');
  h.setSnapshot(withLimits(snapshot(), [['local', 'runnable_turns', 7]]));
  await h.controller.refresh();
  assert.equal(input.value, '3', 'a poll never rewrites a field with a write in flight');
  gate.resolve({ ok: true, configured_limits: withLimits(snapshot(), [['local', 'runnable_turns', 3]]).lanes.configured_limits });
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(input.disabled, false);
  assert.equal(input.hasAttribute('aria-busy'), false);
  assert.equal(input.value, '3', 'the written value is adopted');
  assert.equal(h.controller.getState().draft.limit_local_runnable_turns, undefined, 'the draft is cleared');
  assert.equal(limitRow(h, 'limit_local_runnable_turns').getAttribute('data-modified'), 'true');
  h.controller.dispose();
});

test('Runtime limits: a refused write keeps the expectation from when the edit began, restores the field and says so inline', async () => {
  const writes = [];
  const h = harness({ updateLimits: async payload => { writes.push(payload); return { ok: false }; } }, { section: 'advanced' });
  h.controller.bind(); await settle();
  const input = limitInput(h, 'limit_local_runnable_turns');
  input.focus();
  h.input('limit_local_runnable_turns', '3');
  h.setSnapshot(withLimits(snapshot(), [['local', 'runnable_turns', 5]]));
  await h.controller.refresh();
  assert.equal(input.value, '3', 'the draft survives the poll');
  input.dispatchEvent(new h.dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(writes.length, 1, 'never retried');
  assert.equal(writes[0].expected_limits.local.runnable_turns, 1, 'checked against what was shown when the edit began');
  assert.deepEqual(writes[0].patch, { local: { runnable_turns: 3 } });
  const error = limitRow(h, 'limit_local_runnable_turns').querySelector('[data-limits-error]');
  assert.match(error.textContent, /weren't saved/);
  assert.equal(error.hidden, false);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.value, '5', 'restored to the configured value');
  assert.equal(input.disabled, false);
  assert.equal(h.document.activeElement, input, 'keyboard focus stays on the field');
  h.controller.dispose();
});

test('Runtime limits: invalid input is never written, and leaving the field puts back the value in effect', async () => {
  const writes = [];
  const h = harness({ updateLimits: async payload => { writes.push(payload); return ackLimits(payload); } }, { section: 'advanced' });
  h.controller.bind(); await settle();
  const key = 'limit_local_runnable_turns';
  const inEffect = limitInput(h, key).value;
  commitLimit(h, key, '0'); await settle();
  assert.match(limitRow(h, key).querySelector('[data-limits-error]').textContent, /whole number from 1 to 16/);
  assert.equal(limitInput(h, key).value, '0', 'while the field is being edited the person keeps what they typed');
  limitInput(h, key).dispatchEvent(new h.dom.window.FocusEvent('focusout', { bubbles: true })); await settle();
  assert.equal(limitInput(h, key).value, inEffect, 'the field never keeps a number the runtime is not using');
  assert.equal(limitRow(h, key).querySelector('[data-limits-error]').textContent, '');
  assert.equal(writes.length, 0, 'invalid input never reaches the backend');
  // A valid edit afterwards starts clean.
  commitLimit(h, key, '2'); await settle();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].patch, { local: { runnable_turns: 2 } });
  h.controller.dispose();
});

test('Runtime limits: Revert writes the live default for that one key', async () => {
  const writes = [];
  const h = harness({ updateLimits: async payload => { writes.push(payload); return ackLimits(payload); } }, { section: 'advanced' });
  const shown = withLimits(snapshot(), [['cloud', 'runnable_turns', 6], ['resources', 'tests', 3]]);
  h.setSnapshot(shown);
  h.controller.bind(); await settle();
  h.click('[data-limit="limit_cloud_runnable_turns"] [data-setting-revert]', h.limitsHost); await settle();
  assert.deepEqual(writes, [{ expected_limits: shownLimits(shown), patch: { cloud: { runnable_turns: 2 } } }]);
  h.controller.dispose();
});

test('Runtime limits: Reset arms first, disarms after 5 s, and on confirm writes only the keys that differ', async () => {
  const writes = [];
  const h = harness({ updateLimits: async payload => { writes.push(payload); return ackLimits(payload); } }, { section: 'advanced' });
  const shown = withLimits(snapshot(), [['cloud', 'runnable_turns', 6], ['resources', 'tests', 3]]);
  h.setSnapshot(shown);
  h.controller.bind(); await settle();
  const reset = () => h.limitsHost.querySelector('[data-action="limits-reset"]');
  reset().click();
  assert.equal(writes.length, 0, 'the first click only arms');
  assert.equal(reset().getAttribute('aria-pressed'), 'true');
  h.timers.at(-1)();
  assert.notEqual(reset().getAttribute('aria-pressed'), 'true', 'disarmed after the timeout');
  reset().click(); await settle();
  assert.equal(writes.length, 0, 'a click after the timeout arms again');
  reset().click(); await settle();
  assert.deepEqual(writes, [{ expected_limits: shownLimits(shown), patch: { cloud: { runnable_turns: 2 }, resources: { tests: 1 } } }]);
  h.controller.dispose();
});

test('Runtime limits: a poll never rewrites the focused field but patches the others', async () => {
  const h = harness({}, { section: 'advanced' });
  h.controller.bind(); await settle();
  limitInput(h, 'limit_local_runnable_turns').focus();
  h.setSnapshot(withLimits(snapshot(), [['local', 'runnable_turns', 5], ['cloud', 'runnable_turns', 4]]));
  await h.controller.refresh();
  assert.equal(limitInput(h, 'limit_local_runnable_turns').value, '1', 'the focused field is left alone');
  assert.equal(limitInput(h, 'limit_cloud_runnable_turns').value, '4');
  h.controller.dispose();
});

test('Runtime limits: a write whose echo lacks the saved keys is a refusal, not a success', async () => {
  const h = harness({ updateLimits: async () => ({ ok: true, configured_limits: {} }) }, { section: 'advanced' });
  h.controller.bind(); await settle();
  commitLimit(h, 'limit_local_runnable_turns', '3'); await settle();
  const input = limitInput(h, 'limit_local_runnable_turns');
  assert.equal(input.value, '1', 'restored to the configured value');
  assert.match(limitRow(h, 'limit_local_runnable_turns').querySelector('[data-limits-error]').textContent, /weren't saved/);
  assert.equal(limitRow(h, 'limit_local_runnable_turns').getAttribute('data-modified'), null);
  h.controller.dispose();
});

test('Runtime limits: the expectation is captured when the field takes focus, so a poll behind it cannot be overwritten unseen', async () => {
  const writes = [];
  const h = harness({ updateLimits: async payload => { writes.push(payload); return ackLimits(payload); } }, { section: 'advanced' });
  h.controller.bind(); await settle();
  const input = limitInput(h, 'limit_local_runnable_turns');
  input.focus();
  h.setSnapshot(withLimits(snapshot(), [['local', 'runnable_turns', 5]]));
  await h.controller.refresh();
  assert.equal(input.value, '1', 'the focused field keeps what the person sees');
  h.input('limit_local_runnable_turns', '3');
  input.dispatchEvent(new h.dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].expected_limits.local.runnable_turns, 1, 'checked against the value shown at focus, not the polled one');
  // Focus that leaves without an edit drops its expectation; the next edit captures afresh.
  const other = limitInput(h, 'limit_cloud_runnable_turns');
  other.focus(); other.blur();
  h.setSnapshot(withLimits(snapshot(), [['cloud', 'runnable_turns', 4]]));
  await h.controller.refresh();
  commitLimit(h, 'limit_cloud_runnable_turns', '6'); await settle();
  assert.equal(writes[1].expected_limits.cloud.runnable_turns, 4, 'a fresh capture after the poll');
  h.controller.dispose();
});

test('Runtime limits: a refused write shows the value the poll after it reports, even on the focused field', async () => {
  let h = null;
  h = harness({ updateLimits: async () => {
    // The backend moved on before refusing the stale expectation.
    h.setSnapshot(withLimits(snapshot(), [['local', 'runnable_turns', 5]]));
    return { ok: false };
  } }, { section: 'advanced' });
  h.controller.bind(); await settle();
  const input = limitInput(h, 'limit_local_runnable_turns');
  input.focus();
  commitLimit(h, 'limit_local_runnable_turns', '3'); await settle(); await settle();
  assert.equal(h.document.activeElement, input, 'focus stayed on the field');
  assert.equal(input.value, '5', 'the authoritative value after the refusal, not the one shown before the edit');
  assert.match(limitRow(h, 'limit_local_runnable_turns').querySelector('[data-limits-error]').textContent, /weren't saved/);
  h.controller.dispose();
});

test('stacked limit lines patch caps, revert slots, ranges, errors and locks without replacing inputs', () => {
  const { JSDOM } = require('jsdom');
  const limits = require('../renderer/shell/renderer-runtime-limits-view');
  const advanced = require('../renderer/shell/renderer-settings-advanced-section');
  const dom = new JSDOM('<section class="settings-card"><p data-limits-status hidden></p><div data-limits-lines></div></section>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('[data-limits-lines]');
  const section = advanced.createAdvancedTuningSection({ inventory: {
    settingsField: require('../renderer/inventory/settings-field'), numberInput: require('../renderer/inventory/number-input'),
    actionButton: require('../renderer/inventory/action-button'),
  } });
  section.bind({ advancedTuningFields: host }, (target, type, listener) => target?.addEventListener(type, listener));
  const view = limits.createLimitLines(host);
  let events = 0;
  dom.window.document.querySelector('.settings-card').addEventListener('limits-lines-updated', () => { events += 1; });
  const model = { loaded: false, snapshot: null, draft: {}, limitErrors: {}, limitWrites: {} };
  view.update(model);
  const input = host.querySelector('[data-draft="limit_local_descendants"]');
  assert.equal(input.disabled, true);
  assert.equal(input.value, '');
  assert.match(host.closest('.settings-card').querySelector('[data-limits-status]').textContent, /Loading limits/);
  model.loaded = true;
  model.snapshot = withLimits(snapshot(), [['local', 'descendants', 12]]);
  model.snapshot.lanes.effective_limits.local.descendants = 4;
  model.snapshot.limit_defaults.ranges.descendants = { min: 0, max: 123 };
  view.update(model);
  const row = input.closest('.settings-field');
  assert.equal(input.value, '12');
  assert.equal(input.min, '0'); assert.equal(input.max, '123');
  assert.equal(row.querySelector('.settings-field-meta-modified').hidden, false);
  const slot = row.querySelector('[data-setting-revert-slot="runtime_limit_local_descendants"]');
  assert.equal(slot.querySelector('button').textContent, '↺ ' + model.snapshot.limit_defaults.defaults.local.descendants);
  const note = host.querySelector('[data-limits-note="limit_local_descendants"]');
  assert.equal(note.textContent, 'capped at 4 by this machine'); assert.equal(note.hidden, false);
  assert.ok(input.getAttribute('aria-describedby').split(' ').includes(note.id));
  assert.ok(input.getAttribute('aria-describedby').split(' ').includes(row.querySelector('.settings-field-help').id), 'the row help is read with the field');
  input.focus(); input.value = '11';
  model.snapshot = withLimits(model.snapshot, [['local', 'descendants', 10]]);
  model.limitErrors.limit_local_descendants = 'Refused';
  view.update(model);
  assert.equal(input.value, '11');
  assert.equal(host.querySelector('[data-draft="limit_local_descendants"]'), input);
  assert.equal(row.querySelector('.settings-field-error').textContent, 'Refused', 'the clean Cloud line must not clear the Local error');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  model.limitWrites.limit_cloud_descendants = true;
  view.update(model);
  assert.equal(host.querySelector('[data-draft="limit_cloud_descendants"]').disabled, true);
  assert.equal(host.querySelector('[data-draft="limit_cloud_descendants"]').getAttribute('aria-busy'), 'true');
  assert.equal(input.disabled, false);
  model.limitWrites = {}; model.limitErrors = {};
  model.snapshot = clone(snapshot());
  view.update(model);
  assert.equal(note.hidden, true); assert.equal(note.textContent, '');
  assert.equal(slot.textContent, ''); assert.equal(row.querySelector('.settings-field-meta-modified').hidden, true);
  model.snapshot.read_only = true; view.update(model);
  assert.equal(input.disabled, true);
  assert.match(host.closest('.settings-card').querySelector('[data-limits-status]').textContent, /read-only/);
  model.snapshot = null; view.update(model);
  assert.equal(input.value, ''); assert.equal(input.disabled, true);
  assert.match(host.closest('.settings-card').querySelector('[data-limits-status]').textContent, /unavailable/);
  assert.equal(events, 7);
  view.dispose(); section.dispose(); dom.window.close();
});

// The same limits as lines of the Limits & budgets page (Settings > Developer).
test('W2-4 test 6: Advanced limit change and revert use CAS without engine writes', async () => {
  const dom = new JSDOM('<section class="settings-card"><div id="advancedTuningFields" data-limits-lines></div><div id="advancedTuningActions"></div><div id="advancedTuningStatus"></div><p data-limits-status></p></section>', { pretendToBeVisual: true });
  const document = dom.window.document;
  const host = document.getElementById('advancedTuningFields');
  const writes = [];
  const engineWrites = [];
  let snap = clone(snapshot());
  const expected = { ...clone(snap.lanes.configured_limits), resources: clone(snap.resources.configured_limits) };
  const section = require('../renderer/shell/renderer-settings-advanced-section').createAdvancedTuningSection({
    inventory: { settingsField: require('../renderer/inventory/settings-field'), numberInput: require('../renderer/inventory/number-input'), actionButton: require('../renderer/inventory/action-button') },
    getBridge: () => ({ update: payload => engineWrites.push(payload) }),
  });
  section.bind({ advancedTuningFields: host }, (target, type, handler) => target?.addEventListener(type, handler));
  const controller = controllers.createController({
    state: { ui: { activeView: 'settings', activeSettingsSection: 'advanced' } },
    windowRef: { document, setTimeout: () => 1, clearTimeout() {} },
    api: { getSnapshot: async () => clone(snap), updateLimits: async payload => {
      writes.push(payload);
      for (const [group, values] of Object.entries(payload.patch)) {
        Object.assign(group === 'resources' ? snap.resources.configured_limits : snap.lanes.configured_limits[group], values);
      }
      return { ok: true, configured_limits: { ...snap.lanes.configured_limits, resources: snap.resources.configured_limits } };
    } },
  });
  try {
    controller.attach('limits', host);
    await settle();
    const input = host.querySelector('[data-draft="limit_local_descendants"]');
    assert.ok(input);
    input.value = '12';
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    assert.deepEqual(writes[0], { expected_limits: expected, patch: { local: { descendants: 12 } } });
    host.querySelector('[data-setting-revert="runtime_limit_local_descendants"]').click();
    await settle();
    assert.deepEqual(writes[1].patch, { local: { descendants: snap.limit_defaults.defaults.local.descendants } });
    assert.deepEqual(engineWrites, []);
  } finally { controller.dispose(); section.dispose(); }
});

test('Advanced and its limits companion build one skeleton before engine state, in either binder order', async () => {
  for (const order of [['advanced', 'runtimeLimits'], ['runtimeLimits', 'advanced']]) {
    const dom = new JSDOM('<section class="settings-card"><div id="advancedTuningFields" data-limits-lines></div><div id="advancedTuningActions"></div><p id="advancedTuningStatus"></p><p data-limits-status></p></section>', { pretendToBeVisual: true });
    const document = dom.window.document;
    const state = { ui: { activeView: 'settings', activeSettingsSection: 'advanced' }, status: { engine: 'llama_cpp' } };
    const pending = deferred();
    const writes = [];
    let snap = clone(snapshot());
    snap.resources.configured_limits.tests = 3;
    const engineResets = [];
    const windowRef = {
      document, setTimeout: () => 1, clearTimeout() {},
      inventory: { settingsField: require('../renderer/inventory/settings-field'), numberInput: require('../renderer/inventory/number-input'), actionButton: require('../renderer/inventory/action-button') },
      rendererRunsView: runsView, rendererRuntimeLimitsView: limitsView, rendererOrchestrationController: controllers,
      rendererSettingsAdvancedSection: require('../renderer/shell/renderer-settings-advanced-section'),
      jennyShell: {
        engineTuning: { getState: () => pending.promise, reset: async (...args) => { engineResets.push(args); return { status: 'applied', state: { values: {} } }; } },
        sessionRuntime: { getSnapshot: async () => clone(snap), updateLimits: async payload => {
          writes.push(payload);
          const limits = { ...snap.lanes.configured_limits, resources: snap.resources.configured_limits };
          for (const [group, values] of Object.entries(payload.patch)) Object.assign(limits[group], values);
          return { ok: true, configured_limits: limits };
        } },
      },
    };
    const targets = Object.fromEntries(['advancedTuningFields', 'advancedTuningActions', 'advancedTuningStatus'].map(id => [id, document.getElementById(id)]));
    const cleanups = [];
    const listeners = [];
    const marked = [];
    const binder = createSettingsSectionBinders({ state, windowRef, getLazySectionDom: () => targets, callbacks: {} });
    for (const id of order) {
      binder.bindSection(id, {
        registerSectionListener: (target, type, listener) => { target.addEventListener(type, listener); listeners.push(() => target.removeEventListener(type, listener)); },
        markSectionBound: () => marked.push(id), addCleanup: fn => cleanups.push(fn), finalizeSectionBindings: () => true,
      });
    }
    await settle();
    const host = targets.advancedTuningFields;
    const input = host.querySelector('[data-draft="limit_local_descendants"]');
    assert.equal(input.value, String(snap.lanes.configured_limits.local.descendants));
    assert.equal(host.querySelector('[data-settings-field="limitsRow-ollamaRequest"]').hidden, true);
    assert.equal(host.querySelector('.settings-fold-count').textContent, '1 modified');
    assert.deepEqual(marked.sort(), ['advanced', 'runtimeLimits']);
    pending.resolve({ values: { cloudMaxToolsPerTurn: 7 }, fields: require('../renderer/shared/engine-tuning-schema').ENGINE_TUNING_FIELDS });
    await settle();
    assert.equal(host.querySelector('[data-draft="limit_local_descendants"]'), input);
    targets.advancedTuningActions.querySelector('[data-tuning-reset-all]').click();
    assert.deepEqual(writes, []); assert.deepEqual(engineResets, []);
    targets.advancedTuningActions.querySelector('[data-tuning-reset-all]').click();
    await settle();
    assert.deepEqual(writes[0].patch, { resources: { tests: snap.limit_defaults.defaults.resources.tests } });
    assert.deepEqual(engineResets, [[]]);
    for (const cleanup of cleanups) cleanup();
    for (const remove of listeners) remove();
    dom.window.close();
  }
});

test('the page reset honours the limits lock and reports a refused write; a quiet poll keeps the Revert node', async () => {
  const dom = new JSDOM('<section class="settings-card"><div id="advancedTuningFields" data-limits-lines></div><div id="advancedTuningActions"></div><div id="advancedTuningStatus"></div><p data-limits-status hidden></p></section>', { pretendToBeVisual: true });
  const document = dom.window.document;
  const host = document.getElementById('advancedTuningFields');
  const writes = [];
  let refuse = false;
  const snap = clone(snapshot());
  snap.lanes.configured_limits.local.descendants = snap.limit_defaults.defaults.local.descendants + 1;
  const section = require('../renderer/shell/renderer-settings-advanced-section').createAdvancedTuningSection({
    inventory: { settingsField: require('../renderer/inventory/settings-field'), numberInput: require('../renderer/inventory/number-input'), actionButton: require('../renderer/inventory/action-button') },
    getBridge: () => ({}),
  });
  section.bind({ advancedTuningFields: host }, (target, type, handler) => target?.addEventListener(type, handler));
  const controller = controllers.createController({
    state: { ui: { activeView: 'settings', activeSettingsSection: 'advanced' } },
    windowRef: { document, setTimeout: () => 1, clearTimeout() {} },
    api: { getSnapshot: async () => clone(snap), updateLimits: async payload => {
      writes.push(payload);
      if (refuse) return { ok: false };
      for (const [group, values] of Object.entries(payload.patch)) {
        Object.assign(group === 'resources' ? snap.resources.configured_limits : snap.lanes.configured_limits[group], values);
      }
      return { ok: true, configured_limits: { ...snap.lanes.configured_limits, resources: snap.resources.configured_limits } };
    } },
  });
  try {
    assert.equal(await controller.resetLimitsToDefaults(), false, 'limits that never loaded are not reported as reset');
    controller.attach('limits', host);
    await settle();
    const selector = '[data-setting-revert="runtime_limit_local_descendants"]';
    const revert = host.querySelector(selector);
    assert.ok(revert, 'the modified limit offers its Revert');
    const status = document.querySelector('[data-limits-status]');
    let statusWrites = 0;
    new dom.window.MutationObserver(records => { statusWrites += records.length; }).observe(status, { childList: true, characterData: true, subtree: true });
    controller.resume();
    await settle();
    assert.equal(host.querySelector(selector), revert, 'a poll that changes nothing keeps the node, so focus stays');
    assert.equal(statusWrites, 0, 'and does not rewrite the live status line');

    refuse = true;
    assert.equal(await controller.resetLimitsToDefaults(), false, 'a refused write is reported');
    assert.equal(writes.length, 1);
    await settle();

    refuse = false;
    snap.read_only = true;
    controller.resume();
    await settle();
    assert.equal(await controller.resetLimitsToDefaults(), false, 'a read-only window does not write');
    assert.equal(writes.length, 1);

    snap.read_only = false;
    controller.resume();
    await settle();
    assert.equal(await controller.resetLimitsToDefaults(), true);
    assert.deepEqual(writes[1].patch, { local: { descendants: snap.limit_defaults.defaults.local.descendants } });
  } finally { controller.dispose(); section.dispose(); }
});
