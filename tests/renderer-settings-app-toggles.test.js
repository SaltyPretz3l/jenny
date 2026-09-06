const test = require('node:test');
const assert = require('node:assert/strict');
const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');

test('offline local-only switch still routes through its section binder', () => {
  const list = {};
  let captured = null;
  const calls = [];
  const binders = createSettingsSectionBinders({
    state: {}, constants: {},
    callbacks: {
      handleOfflineModeChange: (checked) => { calls.push(checked); return Promise.resolve(); },
      showSessionActionError() {},
    },
    getLazySectionDom: () => ({ offlineLocalOnlyList: list, offlineModelActions: {} }),
  });
  binders.bindSection('offline', {
    registerSectionListener(el, event, handler) { if (el === list && event === 'inv-toggle-change') captured = handler; },
    finalizeSectionBindings: () => ({}),
  });
  captured({ detail: { id: 'offlineLocalOnlyToggle', checked: true } });
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
