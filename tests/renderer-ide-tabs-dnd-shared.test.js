'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tabs = require('../renderer/features/renderer-ide-tabs');
const groupView = require('../renderer/features/renderer-ide-editor-group-view');
const tabsController = require('../renderer/features/renderer-ide-tabs-controller');

function tabEl(path, left, width) {
  return { getAttribute: (name) => (name === 'data-ide-tab' ? path : null), getBoundingClientRect: () => ({ left, width }) };
}

test('one tab drag payload format is shared by the strip controller and group views', () => {
  assert.equal(tabs.TAB_MIME, 'application/x-jenny-editor-tab');
  assert.equal(groupView.TAB_MIME, tabs.TAB_MIME, 'group-view still re-exports the mime');
  assert.equal('closeAllTabs' in tabsController.createIdeTabsController({}), false, 'unused bulk-close wrappers are gone');
});

test('readTabPayload / hasTabPayload parse only well-formed tab payloads', () => {
  const ev = (data, types = [tabs.TAB_MIME]) => ({ dataTransfer: { types, getData: (t) => (t === tabs.TAB_MIME ? data : '') } });
  assert.deepEqual(tabs.readTabPayload(ev(JSON.stringify({ path: 'a.js', fromGroup: 'editor-2' }))), { path: 'a.js', fromGroup: 'editor-2' });
  assert.deepEqual(tabs.readTabPayload(ev(JSON.stringify({ path: 'a.js' }))), { path: 'a.js', fromGroup: '' });
  assert.equal(tabs.readTabPayload(ev('{bad')), null);
  assert.equal(tabs.readTabPayload(ev('')), null);
  assert.equal(tabs.readTabPayload(ev(JSON.stringify({ path: '' }))), null);
  assert.equal(tabs.hasTabPayload(ev('', [tabs.TAB_MIME])), true);
  assert.equal(tabs.hasTabPayload(ev('', ['Files'])), false);
  assert.equal(tabs.hasTabPayload({}), false);
});

test('tabDropIndex counts midpoints before the pointer, mirrored in RTL, skipping the dragged tab', () => {
  const els = [tabEl('a', 0, 100), tabEl('b', 100, 100), tabEl('c', 200, 100)]; // mids 50/150/250
  assert.equal(tabs.tabDropIndex(els, 160), 2);
  assert.equal(tabs.tabDropIndex(els, 160, { skipPath: 'a' }), 1);
  assert.equal(tabs.tabDropIndex(els, 160, { rtl: true }), 1);
  assert.equal(tabs.tabDropIndex(null, 10), 0);
});
