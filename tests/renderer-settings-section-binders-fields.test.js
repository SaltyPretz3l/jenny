'use strict';

// Skills scope switches and the Offline force-local switch persist through the
// shared field binding: one adapter per persisted object, per-field busy while
// the write is in flight, and a rejected write restores the switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { toggleSwitch, toggle } = require('../renderer/inventory/toggle-switch.js');
const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(sectionId, switches, { state, callbacks }) {
  const dom = new JSDOM('<!doctype html><body><div id="host">'
    + switches.map(([id, checked]) => toggleSwitch({ id, checked, label: id })).join('')
    + '</div></body>');
  const host = dom.window.document.getElementById('host');
  const errors = [];
  const binders = createSettingsSectionBinders({
    state,
    constants: {},
    callbacks: {
      showSessionActionError: (error, title) => errors.push([error.message, title]),
      ...callbacks,
    },
    getLazySectionDom: (id) => {
      if (id === 'skills') return { skillsSettingsSection: host };
      if (id === 'offline') return { offlineLocalOnlyList: host, offlineModelActions: null };
      return {};
    },
  });
  binders.bindSection(sectionId, {
    registerSectionListener: (target, type, handler) => target?.addEventListener(type, handler),
    finalizeSectionBindings: () => true,
  });
  const track = (id) => host.querySelector(`[data-inv-toggle="${id}"]`);
  return { track, errors, flip: (id, checked) => toggle(track(id), checked) };
}

test('the offline switch is busy until the echoed mode acknowledges it', async () => {
  const state = { offline: { mode: 'disabled' } };
  const pending = deferred();
  const calls = [];
  const h = harness('offline', [['offlineLocalOnlyToggle', false]], {
    state,
    callbacks: { handleOfflineModeChange: (enabled) => { calls.push(enabled); return pending.promise; } },
  });
  h.flip('offlineLocalOnlyToggle', true);
  assert.deepEqual(calls, [true]);
  assert.equal(h.track('offlineLocalOnlyToggle').disabled, true, 'busy while the write is in flight');

  state.offline = { mode: 'local_only' };
  pending.resolve(state.offline);
  await settle();
  assert.equal(h.track('offlineLocalOnlyToggle').disabled, false);
  assert.equal(h.track('offlineLocalOnlyToggle').getAttribute('aria-checked'), 'true');
  assert.deepEqual(h.errors, []);
});

test('a rejected offline write restores the switch and says why under it', async () => {
  const h = harness('offline', [['offlineLocalOnlyToggle', false]], {
    state: { offline: { mode: 'disabled' } },
    callbacks: { handleOfflineModeChange: () => Promise.reject(new Error('bridge down')) },
  });
  h.flip('offlineLocalOnlyToggle', true);
  await settle();
  assert.equal(h.track('offlineLocalOnlyToggle').getAttribute('aria-checked'), 'false');
  assert.equal(h.track('offlineLocalOnlyToggle').disabled, false);
  assert.equal(h.track('offlineLocalOnlyToggle').closest('.inv-toggle').querySelector('.inv-toggle-error').textContent, 'bridge down');
  assert.deepEqual(h.errors, [], 'the reason is under the switch, so there is no toast');
});

test('an offline echo that did not take the requested mode is a rejection', async () => {
  const h = harness('offline', [['offlineLocalOnlyToggle', false]], {
    state: { offline: { mode: 'disabled' } },
    callbacks: { handleOfflineModeChange: () => Promise.resolve({ mode: 'disabled' }) },
  });
  h.flip('offlineLocalOnlyToggle', true);
  await settle();
  assert.equal(h.track('offlineLocalOnlyToggle').getAttribute('aria-checked'), 'false');
  assert.match(h.track('offlineLocalOnlyToggle').closest('.inv-toggle').querySelector('.inv-toggle-error').textContent, /could not be confirmed/);
});

test('a skills scope switch writes its patch and acknowledges from the echoed settings', async () => {
  const state = { skills: { settings: { userEnabled: true, projectEnabled: false, disabledSkillIds: [] } } };
  const pending = deferred();
  const calls = [];
  let renders = 0;
  const h = harness('skills', [['skillsUserToggle', true], ['skillsProjectToggle', false]], {
    state,
    callbacks: {
      // The skills controller applies the echoed payload and hands it back.
      updateSkillsSettings: (patch) => {
        calls.push(patch);
        return pending.promise.then(() => {
          state.skills = { settings: { ...state.skills.settings, ...patch } };
          return { settings: { ...state.skills.settings } };
        });
      },
      renderSettings: () => { renders += 1; },
    },
  });
  h.flip('skillsUserToggle', false);
  assert.deepEqual(calls, [{ userEnabled: false }]);
  assert.equal(h.track('skillsUserToggle').disabled, true, 'the edited switch is busy');
  assert.equal(h.track('skillsProjectToggle').disabled, false, 'busy is per field');

  pending.resolve();
  await settle();
  assert.equal(h.track('skillsUserToggle').disabled, false);
  assert.equal(h.track('skillsUserToggle').getAttribute('aria-checked'), 'false');
  assert.equal(state.skills.settings.userEnabled, false);
  assert.ok(renders > 0, 'the section re-renders on settle');
  assert.deepEqual(h.errors, []);
});

test('a failed skills write rolls the switch back without a second toast', async () => {
  // The controller catches, toasts, and resolves without applying a payload.
  const state = { skills: { settings: { userEnabled: true, projectEnabled: false, disabledSkillIds: [] } } };
  const h = harness('skills', [['skillsUserToggle', true]], {
    state,
    callbacks: { updateSkillsSettings: () => Promise.resolve(), renderSettings() {} },
  });
  h.flip('skillsUserToggle', false);
  await settle();
  assert.equal(h.track('skillsUserToggle').getAttribute('aria-checked'), 'true');
  assert.equal(h.track('skillsUserToggle').disabled, false);
  assert.equal(state.skills.settings.userEnabled, true);
  assert.deepEqual(h.errors, [], 'the skills controller already surfaced the failure');
});
