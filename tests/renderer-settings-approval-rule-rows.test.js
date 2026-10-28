'use strict';

// Settings > Tools > Approval rules: how a rule row reads, and where focus goes after Remove.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const coreRenderers = require('../renderer/shell/renderer-settings-core-renderers');
const actionButton = require('../renderer/inventory/action-button');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const dom = new JSDOM('<div id="host"></div>');
  return { dom, container: dom.window.document.getElementById('host') };
}

function savedFixture() {
  return {
    policies: { run_command: 'auto', delete_file: 'deny' },
    rules: [{ id: 'always-allow:write_file:abc123def456', decision: 'auto',
      match: { tool_id: 'write_file', path_prefix: 'docs/a.md' } }],
  };
}

function fakeApi(saved) {
  return {
    async getPermissions() { return { policies: {}, saved }; },
    async clearPermission(name) { delete saved.policies[name]; return { cleared: true }; },
    async removePermissionRule(ruleId) {
      saved.rules = saved.rules.filter((rule) => rule.id !== ruleId);
      return { removed: true };
    },
  };
}

test.beforeEach(() => coreRenderers.resetApprovalRulesCache());

test('a scoped grant names its project and says its match in words, never raw JSON', () => {
  const rows = coreRenderers.buildApprovalRuleRows({ scoped_grants: [{ id: 'grant_2',
    tool_name: 'run_command', path_prefix: null, match: { tool_id: 'run_command' },
    authority: { project_id: 'project_b', root_path: 'G:/beta' } }] },
  [{ id: 'project_b', name: 'Beta' }]);
  assert.equal(rows[0].detail, 'Beta · G:/beta · every call');
});

test('after Remove, focus moves to the next rule, then to the list once it is empty', async () => {
  const { dom, container } = harness();
  dom.window.document.body.appendChild(container);
  const api = fakeApi(savedFixture());
  coreRenderers.bindApprovalRules({
    container, api, actionButton,
    registerListener: (target, name, handler, options) => target.addEventListener(name, handler, options),
  });
  await coreRenderers.renderApprovalRules({ container, api, actionButton });
  const settle = async () => { for (let i = 0; i < 4; i += 1) await flush(); };
  const remove = (key) => {
    const button = container.querySelector(`[data-rule-key="${key}"]`);
    button.focus();
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };
  remove('run_command');
  await settle();
  assert.equal(dom.window.document.activeElement.dataset.ruleKey, 'delete_file', 'the next row takes focus');
  remove('always-allow:write_file:abc123def456');
  await settle();
  assert.equal(dom.window.document.activeElement.dataset.ruleKey, 'delete_file', 'the last row takes the place of the removed one');
  remove('delete_file');
  await settle();
  assert.equal(container.querySelectorAll('.tools-approval-rule').length, 0);
  assert.equal(dom.window.document.activeElement, container, 'an empty list keeps focus');
});
