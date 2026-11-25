'use strict';

// new-test-file: renderer-settings-approval-rules.test.js sits at the 600-line ceiling.
// Settings > Tools > Approval rules: Remove opens a confirm strip under the row (a removal
// cannot be restored from the renderer); Cancel and Escape close it and return focus.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const coreRenderers = require('../renderer/shell/renderer-settings-core-renderers');
const actionButton = require('../renderer/inventory/action-button');

const clickNode = (dom, node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

test.beforeEach(() => coreRenderers.resetApprovalRulesCache());

test('Remove asks first in a strip under the row; Cancel and Escape close it and return focus to Remove', async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const container = dom.window.document.getElementById('host');
  const calls = [];
  const api = { async getPermissions() { calls.push(['getPermissions']); return { policies: {}, saved: { policies: { run_command: 'auto', delete_file: 'deny' }, rules: [] } }; },
    async clearPermission(name) { calls.push(['clearPermission', name]); return {}; }, async removePermissionRule() { return {}; } };
  coreRenderers.bindApprovalRules({ container, api, actionButton,
    registerListener: (target, name, handler) => target.addEventListener(name, handler) });
  await coreRenderers.renderApprovalRules({ container, api, actionButton });
  const remove = () => container.querySelector('[data-action="tools-approval-rule-remove"][data-rule-key="delete_file"]');
  const cancel = () => container.querySelector('[data-action="tools-approval-rule-cancel"]');

  remove().focus();
  clickNode(dom, remove());
  assert.equal(calls.filter((call) => call[0] !== 'getPermissions').length, 0, 'nothing is removed yet');
  assert.match(container.querySelector('.projects-confirm').textContent, /Jenny will ask again next time/);
  assert.equal(container.querySelector('.projects-confirm').previousElementSibling.dataset.decision, 'deny', 'the strip sits under its own row');
  assert.equal(container.ownerDocument.activeElement, cancel(), 'the safe answer holds focus');
  clickNode(dom, cancel());
  assert.equal(container.querySelector('.projects-confirm'), null);
  assert.equal(container.ownerDocument.activeElement, remove(), 'Cancel returns focus to Remove');

  clickNode(dom, remove());
  cancel().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(container.querySelector('.projects-confirm'), null, 'Escape closes the strip');
  assert.equal(container.ownerDocument.activeElement, remove(), 'Escape returns focus to Remove');
  assert.equal(calls.filter((call) => call[0] !== 'getPermissions').length, 0);
});
