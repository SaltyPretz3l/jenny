'use strict';

// Settings > Tools > Approval rules: the saved per-tool policies and the
// path-scoped "Always allow" rules render as rows with a Remove button that
// clears the decision through tools.* and refetches the list.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const coreRenderers = require('../renderer/shell/renderer-settings-core-renderers');
const actionButton = require('../renderer/inventory/action-button');
const selectField = require('../renderer/inventory/select-field');

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

function reviewHarness() {
  const { dom, container } = harness();
  const saved = { policies: {}, rules: [], pending_review: [{ id: 'review_one',
    tool_name: 'write_file', path_prefix: 'docs/<private>.md', original_kind: 'rule',
    original_record: { match: { tool_id: 'write_file', path_prefix: 'docs/<private>.md', action: 'create' } } }] };
  const calls = [];
  const projects = [{ id: 'project_a', name: 'Alpha', root_path: 'G:/alpha', root_revision: 3,
    authority_key: 'reviewed-physical-folder' }];
  const options = { container, api: fakeApi(saved), actionButton, selectField,
    projectsApi: { list: async () => ({ projects }) },
    permissionReviewApi: { resolve: async request => { calls.push(request); saved.pending_review = []; } },
    registerListener: (target, name, handler) => target.addEventListener(name, handler) };
  coreRenderers.bindApprovalRules(options);
  const click = selector => container.querySelector(selector)
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return { dom, container, saved, calls, projects, options, click };
}

test('review notice persists and expansion never grants permission', async () => {
  const h = reviewHarness();
  await coreRenderers.renderApprovalRules(h.options);
  assert.match(h.container.textContent, /Saved automatic permissions need review/);
  h.click('[data-action="permission-review-open"]');
  await flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.container.querySelector('private'), null);
  assert.match(h.container.textContent, /docs\/<private>\.md/);
  assert.match(h.container.textContent, /"action":"create"/);
  assert.equal(h.container.querySelector('[data-decision="auto"]').disabled, true);
  await coreRenderers.renderApprovalRules({ ...h.options, force: true });
  assert.ok(h.container.querySelector('[data-permission-review-notice]'));
  assert.deepEqual(h.calls, []);
});

test('automatic review requires explicit selection and submits the reviewed physical identity', async () => {
  const h = reviewHarness();
  await coreRenderers.renderApprovalRules(h.options);
  h.click('[data-action="permission-review-open"]');
  await flush();
  const select = h.container.querySelector('#permission-review-project');
  select.value = 'project_a';
  select.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  const button = h.container.querySelector('[data-decision="auto"]');
  assert.equal(button.disabled, false);
  assert.ok(button.getAttribute('title'));
  h.click('[data-decision="auto"]');
  await flush(); await flush();
  assert.deepEqual(h.calls, [{ review_id: 'review_one', decision: 'auto', project_id: 'project_a',
    expected_root_revision: 3, expected_authority_key: 'reviewed-physical-folder' }]);
  assert.equal(h.container.querySelector('[data-permission-review-notice]'), null);
});

test('review pages stay bounded and navigating never grants or carries project selection', async () => {
  const h = reviewHarness();
  h.saved.pending_review = Array.from({ length: 101 }, (_, index) => ({
    ...h.saved.pending_review[0], id: `review_${index}`, tool_name: `tool_${index}`,
  }));
  await coreRenderers.renderApprovalRules(h.options);
  h.click('[data-action="permission-review-open"]');
  await flush();
  assert.equal(h.container.querySelectorAll('[data-decision="auto"]').length, 50);
  assert.equal(h.container.querySelector('[data-direction="previous"]').disabled, true);
  const select = h.container.querySelector('#permission-review-project');
  select.value = 'project_a';
  select.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  h.click('[data-direction="next"]');
  await flush();
  assert.ok(h.container.querySelector('[data-review-id="review_50"]'));
  assert.equal(h.container.querySelector('#permission-review-project').value, '');
  assert.equal(h.container.querySelector('[data-decision="auto"]').disabled, true);
  h.click('[data-direction="next"]');
  await flush();
  assert.equal(h.container.querySelectorAll('[data-decision="auto"]').length, 1);
  assert.equal(h.container.querySelector('[data-direction="next"]').disabled, true);
  h.click('[data-direction="previous"]');
  await flush();
  assert.ok(h.container.querySelector('[data-review-id="review_50"]'));
  assert.deepEqual(h.calls, []);
});

test('discard resolves only the saved record and never supplies project authority', async () => {
  const h = reviewHarness();
  await coreRenderers.renderApprovalRules(h.options);
  h.click('[data-action="permission-review-open"]');
  await flush();
  h.click('[data-decision="dismiss"]');
  await flush(); await flush();
  assert.deepEqual(h.calls, [{ review_id: 'review_one', decision: 'dismiss' }]);
});

test('unavailable project list retains the notice and prevents automatic review', async () => {
  const h = reviewHarness();
  h.options.projectsApi.list = async () => { throw new Error('projects unavailable'); };
  await coreRenderers.renderApprovalRules(h.options);
  h.click('[data-action="permission-review-open"]');
  await flush();
  assert.ok(h.container.querySelector('[data-permission-review-notice]'));
  assert.equal(h.container.querySelector('[data-decision="auto"]').disabled, true);
  assert.deepEqual(h.calls, []);
});

test('scoped grants remain visible and removable with their project and match', () => {
  const rows = coreRenderers.buildApprovalRuleRows({ scoped_grants: [{ id: 'grant_1',
    tool_name: 'write_file', match: { path_prefix: 'docs/' },
    authority: { project_id: 'project_a', root_path: 'G:/alpha' } }] });
  assert.equal(rows[0].kind, 'rule');
  assert.equal(rows[0].key, 'grant_1');
  assert.match(rows[0].detail, /project_a.*G:\/alpha.*docs\//);
});

test('structured stale-authority refusal keeps the notice and reports the failure', async () => {
  const h = reviewHarness();
  const errors = [];
  h.options.onError = error => errors.push(error.code);
  h.options.permissionReviewApi.resolve = async () => ({ ok: false,
    error: { code: 'CMP-PROJECT-0004', reason: 'stale_root_revision', message: 'Project authority is stale.' } });
  await coreRenderers.renderApprovalRules(h.options);
  h.click('[data-action="permission-review-open"]');
  await flush();
  h.click('[data-decision="ask"]');
  await flush(); await flush();
  assert.deepEqual(errors, ['CMP-PROJECT-0004']);
  assert.ok(h.container.querySelector('[data-permission-review-notice]'));
  assert.equal(h.saved.pending_review.length, 1);
});

test('F33: Settings > Tools names the project of a folder picked moments ago instead of reusing the previous folder\'s cached list', async () => {
  const { dom } = harness();
  const node = dom.window.document.createElement('p');
  const listed = [{ id: 'project_sandbox', name: 'sandbox-0923', root_path: 'G:\\sandbox-0923' }];
  let listCalls = 0;
  const previousWindow = globalThis.window;
  globalThis.window = { jennyShell: { projects: { async list() { listCalls += 1; return { ok: true, projects: listed.slice() }; } } } };
  try {
    coreRenderers.paintToolsWorkspaceProject(node, 'G:\\sandbox-0923', 'ready');
    await flush();
    assert.equal(node.textContent, 'Project: sandbox-0923 · new chats start here');
    // The folder commit provisioned the new folder's project a moment later.
    listed.push({ id: 'project_fixture', name: 'a2-fixture-project', root_path: 'G:\\a2-fixture-project' });
    coreRenderers.paintToolsWorkspaceProject(node, 'G:\\a2-fixture-project', 'ready');
    await flush();
    assert.equal(node.hidden, false);
    assert.equal(node.textContent, 'Project: a2-fixture-project · new chats start here');
    const reads = listCalls;
    coreRenderers.paintToolsWorkspaceProject(node, 'g:/a2-fixture-project/', 'ready');
    await flush();
    assert.equal(listCalls, reads, 'the same folder reuses the fresh list');
    assert.equal(node.textContent, 'Project: a2-fixture-project · new chats start here');
  } finally {
    globalThis.window = previousWindow;
  }
});
