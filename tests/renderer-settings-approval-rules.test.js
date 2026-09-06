'use strict';

// Settings > Tools > Approval rules: the saved per-tool policies and the
// path-scoped "Always allow" rules render as rows with a Remove button that
// clears the decision through tools.* and refetches the list.

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
    rules: [
      {
        id: 'always-allow:write_file:abc123def456',
        decision: 'auto',
        reason: 'Always allow write_file for docs/a.md (approved in chat)',
        match: { tool_id: 'write_file', path_prefix: 'docs/a.md' },
      },
    ],
  };
}

function fakeApi(saved, calls = []) {
  return {
    calls,
    async getPermissions() {
      calls.push(['getPermissions']);
      return { policies: {}, saved };
    },
    async clearPermission(name) {
      calls.push(['clearPermission', name]);
      delete saved.policies[name];
      return { cleared: true, toolName: name };
    },
    async removePermissionRule(ruleId) {
      calls.push(['removePermissionRule', ruleId]);
      saved.rules = saved.rules.filter((rule) => rule.id !== ruleId);
      return { removed: true, ruleId };
    },
  };
}

test.beforeEach(() => coreRenderers.resetApprovalRulesCache());

test('buildApprovalRuleRows lists per-tool policies then path-scoped rules with plain-language labels', () => {
  const rows = coreRenderers.buildApprovalRuleRows(savedFixture());
  assert.deepEqual(rows.map((row) => [row.kind, row.key, row.label, row.detail]), [
    ['tool', 'run_command', 'Always allow: run_command', 'every call'],
    ['tool', 'delete_file', 'Never allow: delete_file', 'every call'],
    ['rule', 'always-allow:write_file:abc123def456', 'Always allow: write_file', 'for docs/a.md'],
  ]);
  assert.deepEqual(coreRenderers.buildApprovalRuleRows(null), []);
});

test('renderApprovalRules fetches once, paints one row per decision, and escapes the path', async () => {
  const { container } = harness();
  const saved = savedFixture();
  saved.rules[0].match.path_prefix = 'docs/<b>.md';
  const api = fakeApi(saved);

  await coreRenderers.renderApprovalRules({ container, api, actionButton });
  const rowsMarkup = container.querySelectorAll('.tools-approval-rule');
  assert.equal(rowsMarkup.length, 3);
  assert.equal(container.querySelector('b'), null, 'the path prefix must be escaped');
  assert.match(container.textContent, /for docs\/<b>\.md/);
  const removeButtons = container.querySelectorAll('[data-action="tools-approval-rule-remove"]');
  assert.equal(removeButtons.length, 3);
  assert.equal(removeButtons[0].getAttribute('title'), 'Remove this approval rule');
  assert.equal(removeButtons[2].dataset.ruleKind, 'rule');
  assert.equal(removeButtons[2].dataset.ruleKey, 'always-allow:write_file:abc123def456');

  // A second render inside the cache window repaints without another IPC call.
  await coreRenderers.renderApprovalRules({ container, api, actionButton });
  assert.deepEqual(api.calls, [['getPermissions']]);
});

test('renderApprovalRules shows the empty state and the unavailable state', async () => {
  const { container } = harness();
  await coreRenderers.renderApprovalRules({ container, api: fakeApi({ policies: {}, rules: [] }), actionButton });
  assert.match(container.textContent, /No saved approval rules yet/);
  assert.equal(container.querySelector('.tools-approval-rule'), null);

  const other = harness().container;
  assert.equal(coreRenderers.renderApprovalRules({ container: other, api: null, actionButton }), null);
  assert.match(other.textContent, /unavailable/);
});

test('Remove clears a per-tool policy or deletes a rule, then refetches', async () => {
  const { dom, container } = harness();
  const api = fakeApi(savedFixture());
  const errors = [];
  coreRenderers.bindApprovalRules({
    container,
    api,
    actionButton,
    registerListener: (target, name, handler, options) => target.addEventListener(name, handler, options),
    onError: (error, title) => errors.push([title, error.message]),
  });
  await coreRenderers.renderApprovalRules({ container, api, actionButton });

  container.querySelector('[data-rule-key="always-allow:write_file:abc123def456"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  await flush();
  assert.deepEqual(api.calls.slice(1), [
    ['removePermissionRule', 'always-allow:write_file:abc123def456'],
    ['getPermissions'],
  ]);
  assert.equal(container.querySelectorAll('.tools-approval-rule').length, 2);

  container.querySelector('[data-rule-key="run_command"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  await flush();
  assert.deepEqual(api.calls.slice(3), [['clearPermission', 'run_command'], ['getPermissions']]);
  assert.equal(container.querySelectorAll('.tools-approval-rule').length, 1);
  assert.deepEqual(errors, []);
});

test('a failed removal re-enables the button and reports the error', async () => {
  const { dom, container } = harness();
  const api = fakeApi(savedFixture());
  api.clearPermission = async () => { throw new Error('store offline'); };
  const errors = [];
  coreRenderers.bindApprovalRules({
    container,
    api,
    actionButton,
    registerListener: (target, name, handler) => target.addEventListener(name, handler),
    onError: (error, title) => errors.push([title, error.message]),
  });
  await coreRenderers.renderApprovalRules({ container, api, actionButton });

  const button = container.querySelector('[data-rule-key="delete_file"]');
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  await flush();
  assert.deepEqual(errors, [['Approval Rule Removal Failed', 'store offline']]);
  assert.equal(button.disabled, false);
  assert.equal(container.querySelectorAll('.tools-approval-rule').length, 3);
});
