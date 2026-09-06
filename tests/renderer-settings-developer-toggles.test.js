'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');

test('generic Settings binders no longer own Usage events', () => {
  let listeners = 0;
  const binders = createSettingsSectionBinders({ state: {}, callbacks: {}, getLazySectionDom: () => ({}) });
  const result = binders.bindSection('usage', {
    registerSectionListener() { listeners += 1; },
    finalizeSectionBindings: () => 'finalized',
  });
  assert.equal(result, 'finalized');
  assert.equal(listeners, 0);
});
