const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');

test('offline local-only switch still routes through its section binder', () => {
  const dom = new JSDOM('<!doctype html><body><div id="offlineLocalOnlyList"></div></body>');
  const list = dom.window.document.getElementById('offlineLocalOnlyList');
  const calls = [];
  const binders = createSettingsSectionBinders({
    state: { offline: { mode: 'disabled' } }, constants: {},
    callbacks: {
      handleOfflineModeChange: (checked) => { calls.push(checked); return Promise.resolve({ mode: checked ? 'local_only' : 'disabled' }); },
      showSessionActionError() {},
    },
    getLazySectionDom: () => ({ offlineLocalOnlyList: list, offlineModelActions: null }),
  });
  binders.bindSection('offline', {
    registerSectionListener: (target, type, handler) => target?.addEventListener(type, handler),
    finalizeSectionBindings: () => ({}),
  });
  list.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'offlineLocalOnlyToggle', checked: true },
  }));
  assert.deepEqual(calls, [true]);
});

test('retired Proactive and Tips sections have no Settings binders', () => {
  const binders = createSettingsSectionBinders({ state: {}, constants: {}, callbacks: {}, getLazySectionDom: () => ({}) });
  for (const id of ['proactive', 'tips']) {
    let bound = false;
    const result = binders.bindSection(id, {
      registerSectionListener() { bound = true; },
      finalizeSectionBindings: () => 'finalized',
    });
    assert.equal(bound, false);
    assert.equal(result, 'finalized');
  }
});
