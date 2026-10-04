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
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

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

test('D21: the Tools project line follows the switcher\'s change event without a list read, and has no 15 s timer cache', async () => {
  const dom = new JSDOM('<p id="line"></p>');
  const node = dom.window.document.getElementById('line');
  let listCalls = 0;
  dom.window.jennyShell = { projects: { async list() { listCalls += 1; return { ok: true, projects: [{ id: 'project_d21', name: 'd21-fixture', root_path: 'G:\\d21-fixture' }] }; } } };
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  const announce = (projects) => dom.window.dispatchEvent(new dom.window.CustomEvent('jenny:projects-changed', { detail: { source: 'switcher', projects } }));
  try {
    coreRenderers.paintToolsWorkspaceProject(node, 'G:\\d21-fixture', 'ready');
    await flush();
    assert.equal(node.textContent, 'Project: d21-fixture · new chats start here');
    assert.equal(listCalls, 1, 'a folder the list does not know yet is read once');

    // A rename on another surface: the switcher's event carries its list.
    announce([{ id: 'project_d21', name: 'Renamed D21', rootPath: 'G:\\d21-fixture' }]);
    assert.equal(node.textContent, 'Project: Renamed D21 · new chats start here', 'repainted from the event');
    assert.equal(listCalls, 1, 'no projects.list read for the change');

    // Main's is_current wins over a folder-string compare (junction / subst).
    announce([{ id: 'project_real', name: 'Via junction', root_path: 'H:\\real', is_current: true }, { id: 'project_d21', name: 'Renamed D21', root_path: 'G:\\d21-fixture', is_current: false }]);
    assert.equal(node.textContent, 'Project: Via junction · new chats start here');

    announce([{ id: 'project_d21', name: 'Renamed D21', root_path: 'G:\\d21-fixture' }]);
    const realNow = Date.now;
    Date.now = () => realNow() + 60 * 1000;
    try {
      coreRenderers.paintToolsWorkspaceProject(node, 'G:\\d21-fixture', 'ready');
      await flush();
    } finally {
      Date.now = realNow;
    }
    assert.equal(listCalls, 1, 'a minute later the known list still serves: no timer re-read');
    assert.equal(node.textContent, 'Project: Renamed D21 · new chats start here');
  } finally {
    globalThis.window = previousWindow;
  }
});


test('Tools parent switches update dependent rows through the existing feature-settings path', async (t) => {
  const patches = [];
  const { window, shell, dispose } = await loadRendererApp({
    shell: { features: {
      state: { tools: { fileTools: false, richFiles: true, bash: false, web: false }, featureFlags: { web_search_providers: true } },
      async updateSettings(patch, { state }) {
        patches.push(JSON.parse(JSON.stringify(patch)));
        Object.assign(state.featuresState.tools, patch.tools);
        return state.featuresState;
      },
    } },
  });
  t.after(dispose);
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  doc.querySelector('.settings-nav-item[data-settings-section="tools"]').click();
  await waitForUi(window, 20);
  const row = (key) => doc.querySelector(`[data-settings-field="settings-tool-config-${key}"]`);
  const track = (key) => row(key).querySelector('[data-inv-toggle]');
  assert.equal(track('richFiles').disabled, true);
  row('richFiles').querySelector('.settings-field-title').click();
  await waitForUi(window, 20);
  assert.deepEqual(patches, []);
  assert.equal(track('richFiles').getAttribute('aria-checked'), 'true');
  row('fileTools').querySelector('.settings-field-title').click();
  await waitForUi(window, 30);
  assert.deepEqual(patches, [{ tools: { fileTools: true } }]);
  assert.equal(track('richFiles').disabled, false);
  assert.equal(row('richFiles').hasAttribute('data-setting-parent-off'), false);
  assert.equal(track('richFiles').getAttribute('aria-checked'), 'true');

  const ready = { enabled: true, state: 'ready', platform: 'windows', qualified: true };
  shell.commandSandbox = { async getState() { return ready; }, async retry() { return ready; } };
  const sandbox = () => doc.querySelector('[data-settings-field="commandSandboxEnabled"]');
  assert.equal(sandbox().dataset.settingParentOff, 'true');
  assert.equal(sandbox().querySelector('[data-inv-toggle]').disabled, true);
  row('bash').querySelector('.settings-field-title').click();
  await waitForUi(window, 30);
  assert.deepEqual(patches.at(-1), { tools: { bash: true } });
  assert.equal(sandbox().hasAttribute('data-setting-parent-off'), false);
  assert.equal(sandbox().querySelector('[data-inv-toggle]').disabled, false);
  // The bridge arrived after the row bound, so the row offers Retry; with the parent on it reaches the bridge.
  sandbox().querySelector('[data-action="commandSandboxRetry"]').click();
  await waitForUi(window, 20);
  assert.equal(sandbox().querySelector('[data-inv-toggle]').getAttribute('aria-checked'), 'true');
  assert.equal(sandbox().querySelector('[data-inv-toggle]').disabled, false);

  const provider = () => doc.getElementById('webSearchProviderSelect');
  assert.equal(provider().disabled, true);
  assert.equal(doc.querySelector('[data-web-search-test]').disabled, true);
  assert.equal(provider().closest('.settings-field--row').dataset.settingParentOff, 'true');
  row('web').querySelector('.settings-field-title').click();
  await waitForUi(window, 30);
  assert.deepEqual(patches.at(-1), { tools: { web: true } });
  assert.equal(provider().disabled, false);
  assert.equal(doc.querySelector('[data-web-search-section]').parentElement.id, 'toolsWebList');
  shell.harness.inspect = async () => ({ web_search_probe: { ok: true, provider: 'duckduckgo' } });
  doc.querySelector('[data-web-search-test]').click();
  await waitForUi(window, 20);
  assert.equal(doc.querySelector('[data-web-search-test-status]').textContent, 'Connected to duckduckgo.');
});


test('Tools workspace line shows ready paths without idle text and invalid roots with their message', async (t) => {
  for (const rootState of ['ready', 'invalid']) {
    const { window, dispose } = await loadRendererApp({ shell: { workspaceRoot: {
      state: { workspaceRoot: 'G:/workspace/example', workspaceRootStatus: { state: rootState, message: 'The selected root is invalid.' } },
    } } });
    t.after(dispose);
    const doc = window.document;
    assert.equal(doc.getElementById('toolsWorkspaceLine').dataset.state, rootState === 'ready' ? 'ready' : 'blocked');
    assert.equal(doc.getElementById('toolsWorkspacePath').textContent, 'G:/workspace/example');
    assert.equal(doc.getElementById('toolsWorkspaceStatus').textContent, rootState === 'ready' ? '' : 'The selected root is invalid.');
    await dispose();
  }
});

test('a dependent tool row follows its parent while the Tools lists are held by focus', async (t) => {
  const { window, dispose } = await loadRendererApp({
    shell: { features: {
      state: { tools: { fileTools: true, richFiles: true, bash: true, web: false } },
      async updateSettings(patch, { state }) {
        Object.assign(state.featuresState.tools, patch.tools);
        return state.featuresState;
      },
    } },
  });
  t.after(dispose);
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  doc.querySelector('.settings-nav-item[data-settings-section="tools"]').click();
  await waitForUi(window, 20);
  const row = (key) => doc.querySelector(`[data-settings-field="settings-tool-config-${key}"]`);
  const held = row('web');
  held.querySelector('[data-inv-toggle]').focus();
  row('fileTools').querySelector('.settings-field-title').click();
  await waitForUi(window, 30);
  assert.equal(row('web'), held, 'the focused list was not repainted');
  assert.equal(row('richFiles').dataset.settingParentOff, 'true');
  assert.equal(row('richFiles').querySelector('[data-inv-toggle]').disabled, true);
  assert.equal(row('richFiles').querySelector('[data-inv-toggle]').getAttribute('aria-checked'), 'true', 'the stored value is kept');
});

async function openHeldTools(t, tools, webSearch) {
  const app = await loadRendererApp({
    shell: { features: {
      state: { tools, featureFlags: { web_search_providers: true }, webSearch },
      async updateSettings(patch, { state }) {
        Object.assign(state.featuresState.tools, patch.tools);
        return state.featuresState;
      },
    } },
  });
  t.after(app.dispose);
  const doc = app.window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(app.window, 20);
  doc.querySelector('.settings-nav-item[data-settings-section="tools"]').click();
  await waitForUi(app.window, 20);
  const row = (key) => doc.querySelector(`[data-settings-field="settings-tool-config-${key}"]`);
  // Focus inside the Tools page holds its lists, so a re-render patches nothing there.
  row('fileTools').querySelector('[data-inv-toggle]').focus();
  const flipWeb = async () => {
    row('web').querySelector('.settings-field-title').click();
    await waitForUi(app.window, 30);
  };
  return { ...app, doc, row, flipWeb };
}

test('web search rows follow Web tools while the Tools lists are held by focus', async (t) => {
  const { doc, flipWeb } = await openHeldTools(t, { fileTools: true, richFiles: true, bash: true, web: false }, { provider: 'brave' });
  const section = doc.querySelector('[data-web-search-section]');
  const disabled = () => ['#webSearchProviderSelect', '[data-web-search-key-field="brave"]', '[data-web-search-key-save="brave"]', '[data-web-search-test]']
    .map((selector) => doc.querySelector(selector).disabled);
  const parentOffRows = () => section.querySelectorAll('.settings-field[data-setting-parent-off="true"]').length;
  assert.deepEqual(disabled(), [true, true, true, true]);
  await flipWeb();
  assert.equal(doc.querySelector('[data-web-search-section]'), section, 'the held lists were not repainted');
  assert.deepEqual(disabled(), [false, false, false, false]);
  assert.equal(parentOffRows(), 0);
  await flipWeb();
  assert.equal(doc.querySelector('[data-web-search-section]'), section);
  assert.deepEqual(disabled(), [true, true, true, true]);
  assert.equal(parentOffRows(), section.querySelectorAll('.settings-field').length);
});

test('a running connection test keeps its lock through Web tools changes and releases to the parent state', async (t) => {
  const { window, doc, shell, flipWeb } = await openHeldTools(t, { fileTools: true, web: true }, { provider: 'duckduckgo' });
  let finishProbe;
  shell.harness.inspect = () => new Promise((resolve) => { finishProbe = resolve; });
  const testButton = doc.querySelector('[data-web-search-test]');
  testButton.click();
  assert.equal(testButton.disabled, true);
  await flipWeb();
  await flipWeb();
  assert.equal(doc.querySelector('[data-web-search-test]'), testButton, 'the held lists were not repainted');
  assert.equal(testButton.disabled, true, 'turning the parent on does not unlock a running test');
  await flipWeb();
  finishProbe({ web_search_probe: { ok: true, provider: 'duckduckgo' } });
  await waitForUi(window, 20);
  assert.equal(doc.querySelector('[data-web-search-test-status]').textContent, 'Connected to duckduckgo.');
  assert.equal(testButton.disabled, true, 'a finished test does not unlock a button whose parent is off');
  await flipWeb();
  assert.equal(testButton.disabled, false, 'the parent is on again and the test has finished');
});

test('the tool row link to PDF reading opens Tools with keyboard focus on the first usable control of the add-on group', async (t) => {
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  const doc = window.document;
  const host = doc.getElementById('toolsPdfAddonHost');
  // The harness has no add-on bridge, so the group shows its unsupported state with no actions; give it two.
  host.querySelector('.settings-field-control').insertAdjacentHTML('beforeend', '<button type="button" disabled>Cancel</button><button type="button" data-action="pdfAddonSetup">Set up</button>');
  let scrolled = 0;
  host.scrollIntoView = () => { scrolled += 1; };
  doc.getElementById('chatTimeline').insertAdjacentHTML('beforeend', '<span role="link" tabindex="0" data-inv-error-action="open_pdf_addon_settings">Set up PDF reading</span>');
  doc.querySelector('[data-inv-error-action="open_pdf_addon_settings"]').click();
  await waitForUi(window, 80);
  assert.equal(doc.querySelector('.settings-card.settings-section-active').dataset.settingsSection, 'tools');
  assert.equal(doc.activeElement, host.querySelector('[data-action="pdfAddonSetup"]'));
  assert.ok(scrolled > 0, 'the group is scrolled into view');
});
