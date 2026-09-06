'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');
const selectField = require('../renderer/inventory/select-field');
const toggleSwitch = require('../renderer/inventory/toggle-switch');
const { createMcpServersController, resolveMcpServerBadge,
  mapMcpFailureMessage } = require('../renderer/shell/renderer-mcp-servers');

const flush = async () => { await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve)); };

function discovery(overrides = {}) {
  return { schemaVersion: 1, readOnly: false, remediationReason: '', migrated: false,
    sseEnabled: true, servers: [], ...overrides };
}

function pendingServer(overrides = {}) {
  return { name: 'weather', transport: 'stdio', command: 'weather-mcp', args: ['--stdio'],
    status: 'configured', toolsCount: 0, enabled: false,
    trust: { status: 'pending', configuration_digest: 'a'.repeat(64),
      advertised_tools_digest: '', reviewed_at: '' }, ...overrides };
}

function harness(t, { initialState = discovery(), feature = true, bridge = {}, authBridge = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><body><nav id="nav">
    <button data-settings-section="plugins">Plugins</button></nav>
    <section class="settings-card" data-settings-section="plugins"><h3>Plugins &amp; Extensions</h3>
      <div id="pluginsSettingsHost"></div><div id="skillsSettingsSection"></div>
      <div id="mcpServersHost"></div><div id="pluginsSourcesHost"></div></section>
    <section class="settings-card" data-settings-section="tools"><h3>Tools</h3></section></body>`,
  { pretendToBeVisual: true });
  let state = initialState;
  let authState = { loaded: true, store: { status: 'ready' }, servers: [] };
  const calls = [];
  const toasts = [];
  const confirms = [];
  const logs = [];
  const api = {
    getState: async () => state,
    createServer: async (payload) => { calls.push(['create', payload]); return { ok: true }; },
    updateServer: async (payload) => { calls.push(['update', payload]); return { ok: true }; },
    removeServer: async (payload) => { calls.push(['remove', payload]);
      state = discovery({ ...state, servers: state.servers.filter((server) => server.name !== payload.name) });
      return { ok: true }; },
    testServer: async (payload) => { calls.push(['test', payload]); return payload.confirmed
      ? { ok: true, tool_count: 1, tools_digest: 'b'.repeat(64), tools: [{ name: 'forecast',
        description: 'Get a forecast', schema_digest: 'c'.repeat(64) }] }
      : { ok: false, confirmation_required: true, command: 'weather-mcp', args: ['--stdio'] }; },
    approveServer: async (payload) => { calls.push(['approve', payload]); return { ok: true }; },
    setServerEnabled: async (payload) => { calls.push(['toggle', payload]); return { ok: true }; },
    ...bridge,
  };
  const authApi = { getStatus: async () => authState, ...authBridge };
  dom.window.jennyShell = { mcpDiscovery: api, mcpAuth: authApi };
  const previous = [globalThis.inventoryActionButton, globalThis.inventoryTextField,
    globalThis.inventorySelectField, globalThis.inventoryToggleSwitch];
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventoryTextField = textField;
  globalThis.inventorySelectField = selectField;
  globalThis.inventoryToggleSwitch = toggleSwitch;
  const controller = createMcpServersController({ state: { features: { featureFlags: {
    mcp_management_ui: feature } } }, windowRef: dom.window, documentRef: dom.window.document,
    showToastMessage: (message, options) => toasts.push({ message, options }),
    appendClientLog: (...entry) => logs.push(entry),
    confirmDanger: async (config) => { confirms.push(config); return true; } });
  t.after(() => { controller.dispose(); [globalThis.inventoryActionButton, globalThis.inventoryTextField,
    globalThis.inventorySelectField, globalThis.inventoryToggleSwitch] = previous; });
  return { dom, controller, calls, toasts, confirms, logs, api, setState: (next) => { state = next; },
    setAuthState: (next) => { authState = next; },
    pluginsCard: dom.window.document.querySelector('.settings-card[data-settings-section="plugins"]'),
    toolsCard: dom.window.document.querySelector('.settings-card[data-settings-section="tools"]') };
}

test('flag off clears only the MCP host', async (t) => {
  const h = harness(t, { feature: false });
  const host = h.dom.window.document.getElementById('mcpServersHost');
  host.innerHTML = '<i>stale</i>';
  h.controller.bind();
  await flush();
  assert.equal(host.textContent, '');
  assert.equal(h.dom.window.document.getElementById('mcpServersGroup'), null);
});

test('flat MCP rows mount in their stable host with only drawer action and switch', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  const group = h.dom.window.document.getElementById('mcpServersGroup');
  const row = group.querySelector('[data-mcp-server-row="weather"]');
  assert.ok(group.classList.contains('settings-group--wide'));
  assert.equal(group.parentElement.id, 'mcpServersHost');
  assert.equal(group.closest('.settings-card'), h.pluginsCard);
  assert.equal(h.toolsCard.querySelector('#mcpServersGroup'), null);
  assert.ok(row.classList.contains('settings-field-row'));
  assert.deepEqual(Array.from(row.querySelectorAll('button')).map((button) => button.textContent.trim()), ['Review', '']);
  const toggle = row.querySelector('[role="switch"]');
  assert.equal(toggle.disabled, true);
  assert.match(row.textContent, /turn on unavailable until its tools are reviewed/);
});

test('read-only future state explains preservation and disables creation', async (t) => {
  const h = harness(t, { initialState: discovery({ schemaVersion: 2, readOnly: true,
    remediationReason: 'future_schema' }) });
  h.controller.bind();
  await flush();
  assert.match(h.pluginsCard.textContent, /preserved unchanged/);
  assert.match(h.pluginsCard.textContent, /future_schema/);
  assert.equal(h.pluginsCard.querySelector('[data-mcp-servers-action="add"]').disabled, true);
});

test('create editor stays outside the list and preserves typed values through refresh', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  const trigger = h.pluginsCard.querySelector('[data-mcp-servers-action="add"]');
  trigger.focus();
  trigger.click();
  const drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  assert.equal(drawer.hidden, false);
  assert.equal(h.pluginsCard.querySelector('[data-mcp-editor]'), null);
  h.dom.window.document.getElementById('mcpServerName').value = 'docs';
  h.dom.window.document.getElementById('mcpServerTarget').value = 'node';
  h.dom.window.document.getElementById('mcpServerArgs').value = 'server.js\n--safe';
  await h.controller.refresh();
  assert.equal(h.dom.window.document.getElementById('mcpServerName').value, 'docs');
  assert.equal(h.dom.window.document.getElementById('mcpServerArgs').value, 'server.js\n--safe');
  drawer.querySelector('[data-mcp-servers-action="save-editor"]').click();
  await flush();
  assert.deepEqual(h.calls[0], ['create', { server: { name: 'docs', transport: 'stdio',
    command: 'node', args: ['server.js', '--safe'] } }]);
});

test('Edit stays in the drawer and preserves bounded stdio arguments', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  h.pluginsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="edit"]').click();
  assert.equal(h.dom.window.document.getElementById('mcpServerArgs').value, '--stdio');
  h.dom.window.document.getElementById('mcpServerTarget').value = 'weather-mcp-v2';
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-editor"]').click();
  await flush();
  assert.deepEqual(h.calls[0], ['update', { name: 'weather', server: { name: 'weather', transport: 'stdio',
    command: 'weather-mcp-v2', args: ['--stdio'] } }]);
});

test('pending Review opens one drawer for inspection and approval', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  const trigger = h.pluginsCard.querySelector('[data-mcp-servers-action="details"]');
  trigger.focus();
  trigger.click();
  let drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  assert.equal(drawer.hidden, false);
  assert.match(drawer.textContent, /Trust review/);
  assert.equal(drawer.querySelector('[data-mcp-servers-action="approve"]').disabled, true);
  drawer.querySelector('[data-mcp-servers-action="test"]').click();
  await flush();
  assert.match(h.confirms[0].title, /Inspect MCP connection/);
  assert.match(h.confirms[0].message, /weather-mcp --stdio/);
  assert.deepEqual(h.calls.slice(0, 2), [['test', { name: 'weather' }],
    ['test', { name: 'weather', confirmed: true }]]);
  drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  assert.match(drawer.textContent, /forecast/);
  assert.match(drawer.textContent, /Get a forecast/);
  const approve = drawer.querySelector('[data-mcp-servers-action="approve"]');
  assert.equal(approve.disabled, false);
  approve.click();
  await flush();
  assert.deepEqual(h.calls[2], ['approve', { name: 'weather' }]);
});

test('in-progress drawer actions are visibly disabled and restored after failure', async (t) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const approved = pendingServer({ enabled: true, trust: { status: 'approved' } });
  const h = harness(t, { initialState: discovery({ servers: [approved] }), bridge: {
    testServer: () => pending,
  } });
  h.controller.bind();
  await flush();
  h.pluginsCard.querySelector('[data-mcp-servers-action="details"]').click();
  const drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  drawer.querySelector('[data-mcp-servers-action="test"]').click();
  assert.equal(drawer.querySelector('.inv-drawer-panel').getAttribute('aria-busy'), 'true');
  assert.match(drawer.querySelector('[data-mcp-drawer-operation-status]').textContent, /Working/);
  assert.equal(drawer.querySelector('[data-mcp-servers-action="remove"]').disabled, true);
  assert.match(h.pluginsCard.querySelector('[data-mcp-server-row]').textContent, /operation in progress/);
  finish({ ok: false, reason: 'unavailable' });
  await flush();
  assert.equal(drawer.querySelector('[data-mcp-drawer-operation-status]'), null);
  assert.equal(drawer.querySelector('[data-mcp-servers-action="remove"]').disabled, false);
  assert.equal(h.toasts.at(-1).message, 'The MCP operation could not be completed.');
  assert.deepEqual(h.logs.at(-1), ['WARN', 'mcp_settings.operation_failed', { name: 'testServer' }]);
});

test('structured editor failures retain typed values and surface bounded diagnostics', async (t) => {
  const h = harness(t, { bridge: { createServer: async () => ({ ok: false, reason: 'invalid' }) } });
  h.controller.bind();
  await flush();
  h.pluginsCard.querySelector('[data-mcp-servers-action="add"]').click();
  h.dom.window.document.getElementById('mcpServerName').value = 'docs';
  h.dom.window.document.getElementById('mcpServerTarget').value = 'node';
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-editor"]').click();
  await flush();
  assert.equal(h.dom.window.document.getElementById('mcpServerName').value, 'docs');
  assert.equal(h.dom.window.document.getElementById('mcpServerTarget').value, 'node');
  assert.equal(h.toasts.at(-1).message, 'The MCP operation could not be completed.');
  assert.deepEqual(h.logs.at(-1), ['WARN', 'mcp_settings.operation_failed', { name: 'createServer' }]);
});

test('approved switch uses inv-toggle-change and removal uses shared danger confirmation', async (t) => {
  const approved = pendingServer({ trust: { status: 'approved', configuration_digest: 'a'.repeat(64),
    advertised_tools_digest: 'b'.repeat(64), reviewed_at: '2026-08-17T00:00:00Z' } });
  const h = harness(t, { initialState: discovery({ servers: [approved] }) });
  h.controller.bind();
  await flush();
  const toggle = h.pluginsCard.querySelector('[role="switch"]');
  assert.equal(toggle.disabled, false);
  toggle.focus();
  toggle.click();
  await flush();
  assert.deepEqual(h.calls[0], ['toggle', { name: 'weather', enabled: true }]);
  assert.equal(h.dom.window.document.activeElement.dataset.invToggle, toggle.dataset.invToggle);
  h.pluginsCard.querySelector('[data-mcp-servers-action="details"]').click();
  const drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  assert.match(drawer.textContent, /Approved tool surface/);
  assert.match(drawer.textContent, new RegExp('a{64}'));
  assert.match(drawer.textContent, new RegExp('b{64}'));
  assert.match(drawer.textContent, /2026-08-17/);
  drawer.querySelector('[data-mcp-servers-action="remove"]').click();
  await flush();
  assert.deepEqual(h.calls[1], ['remove', { name: 'weather' }]);
  assert.match(h.confirms[0].title, /Remove MCP connection/);
  assert.equal(h.dom.window.document.getElementById('mcpServerDetailsDrawer').hidden, true);
});

test('remote credentials use the safeStorage bridge and never render the secret', async (t) => {
  const saved = [];
  const remote = pendingServer({ name: 'remote', transport: 'sse', command: '', args: [],
    url: 'https://mcp.example.test/sse', auth: { kind: 'bearer', secretRef: null } });
  const h = harness(t, { initialState: discovery({ servers: [remote] }), authBridge: {
    getStatus: async () => ({ loaded: true, store: { status: 'ready' },
      servers: [{ name: 'remote', hasAuthBlock: true, configured: false }] }),
    set: async (payload) => { saved.push(payload); return { ok: true, loaded: true,
      store: { status: 'ready' }, servers: [{ name: 'remote', configured: true }] }; },
  } });
  h.controller.bind();
  await flush();
  h.pluginsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="configure-credential"]').click();
  h.dom.window.document.getElementById('mcpServerCredential').value = 'secret-value';
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-credential"]').click();
  await flush();
  assert.deepEqual(saved, [{ serverName: 'remote', value: 'secret-value' }]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.dom.window.document.body.innerHTML.includes('secret-value'), false);
});

test('credential bridge failures keep raw errors out of UI diagnostics', async (t) => {
  const remote = pendingServer({ name: 'remote', transport: 'sse', command: '', args: [],
    url: 'https://mcp.example.test/sse', auth: { kind: 'bearer', secretRef: null } });
  const h = harness(t, { initialState: discovery({ servers: [remote] }), authBridge: {
    getStatus: async () => ({ loaded: true, store: { status: 'ready' },
      servers: [{ name: 'remote', hasAuthBlock: true, configured: false }] }),
    set: async () => { throw new Error('secret-value at C:\\private'); },
  } });
  h.controller.bind();
  await flush();
  h.pluginsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="configure-credential"]').click();
  h.dom.window.document.getElementById('mcpServerCredential').value = 'secret-value';
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-credential"]').click();
  await flush();
  assert.equal(h.toasts.at(-1).message, 'The credential operation failed.');
  assert.deepEqual(h.logs.at(-1), ['WARN', 'mcp_settings.auth_bridge_call_failed', { name: 'set' }]);
  assert.equal(JSON.stringify([h.toasts, h.logs]).includes('secret-value'), false);
  assert.equal(JSON.stringify([h.toasts, h.logs]).includes('C:\\private'), false);
});

test('drawer close restores the current row focus after an operation rerenders the list', async (t) => {
  const approved = pendingServer({ trust: { status: 'approved' }, enabled: true });
  const h = harness(t, { initialState: discovery({ servers: [approved] }), bridge: {
    testServer: async () => ({ ok: false, reason: 'unavailable' }),
  } });
  h.controller.bind();
  await flush();
  const trigger = h.pluginsCard.querySelector('[data-mcp-servers-action="details"]');
  trigger.focus();
  trigger.click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="test"]').click();
  await flush();
  const currentTrigger = h.pluginsCard.querySelector('[data-mcp-servers-action="details"]');
  assert.notEqual(currentTrigger, trigger);
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-drawer-close]').click();
  assert.equal(h.dom.window.document.activeElement, currentTrigger);
  h.controller.dispose();
  assert.equal(h.dom.window.document.getElementById('mcpServerDetailsDrawer'), null);
});

test('closing a drawer during an operation prevents async completion from reopening it', async (t) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const approved = pendingServer({ trust: { status: 'approved' }, enabled: true });
  const h = harness(t, { initialState: discovery({ servers: [approved] }), bridge: {
    testServer: () => pending,
  } });
  h.controller.bind();
  await flush();
  h.pluginsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="test"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-drawer-close]').click();
  finish({ ok: true, tool_count: 1, tools_digest: 'b'.repeat(64), tools: [] });
  await flush();
  assert.equal(h.dom.window.document.getElementById('mcpServerDetailsDrawer').hidden, true);
});

test('badge and failure mapping make trust state primary', () => {
  assert.deepEqual(resolveMcpServerBadge({ enabled: false, trustStatus: 'pending' }),
    { state: 'muted', text: 'Off' });
  assert.deepEqual(resolveMcpServerBadge({ enabled: true, trustStatus: 'pending', status: 'running' }),
    { state: 'warn', text: 'Review required' });
  assert.deepEqual(resolveMcpServerBadge({ enabled: true, trustStatus: 'approved', status: 'running' }),
    { state: 'success', text: 'Running' });
  assert.match(mapMcpFailureMessage('blocked: PermissionError'), /private or local/);
  assert.equal(mapMcpFailureMessage('custom failure'), 'custom failure');
});

test('MCP controller does not use native window confirmation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shell',
    'renderer-mcp-servers.js'), 'utf8');
  assert.doesNotMatch(source, /windowRef\.confirm|window\.confirm/);
  assert.match(source, /confirmDanger/);
});
