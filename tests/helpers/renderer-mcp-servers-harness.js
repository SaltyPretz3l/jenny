'use strict';

// Shared JSDOM harness for the Settings > Extensions MCP connections controller
// (tests/renderer-mcp-servers*.test.js): the fake discovery/auth bridges, the
// inventory primitives installed as globals for the UMD module, and the small
// drawer helpers.

const { JSDOM } = require('jsdom');

const actionButton = require('../../renderer/inventory/action-button');
const textField = require('../../renderer/inventory/text-field');
const selectField = require('../../renderer/inventory/select-field');
const toggleSwitch = require('../../renderer/inventory/toggle-switch');
const { createMcpServersController } = require('../../renderer/shell/renderer-mcp-servers');

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

function harness(t, { initialState = discovery(), bridge = {}, authBridge = {}, platform, confirmResult = true } = {}) {
  const dom = new JSDOM(`<!doctype html><body><nav id="nav">
    <button data-settings-section="extensions">Extensions</button></nav>
    <section class="settings-card" data-settings-section="extensions"><h3>Extensions</h3>
      <div id="skillsSettingsSection"></div>
      <div id="mcpServersHost"></div></section>
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
  const controller = createMcpServersController({ windowRef: dom.window, documentRef: dom.window.document, platform,
    showToastMessage: (message, options) => toasts.push({ message, options }),
    appendClientLog: (...entry) => logs.push(entry),
    confirmDanger: async (config) => { confirms.push(config); return confirmResult; } });
  t.after(() => { controller.dispose(); [globalThis.inventoryActionButton, globalThis.inventoryTextField,
    globalThis.inventorySelectField, globalThis.inventoryToggleSwitch] = previous; });
  return { dom, controller, calls, toasts, confirms, logs, api, setState: (next) => { state = next; },
    setAuthState: (next) => { authState = next; },
    extensionsCard: dom.window.document.querySelector('.settings-card[data-settings-section="extensions"]'),
    toolsCard: dom.window.document.querySelector('.settings-card[data-settings-section="tools"]') };
}

const REA_COMMAND = 'C:\\Program Files\\nodejs\\npx.cmd';
const openDrawer = (h, action) => {
  h.extensionsCard.querySelector(`[data-mcp-servers-action="${action}"]`).click();
  return h.dom.window.document.getElementById('mcpServerDetailsDrawer');
};
const saveEditor = (h) => h.dom.window.document
  .querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-editor"]').click();
const drawerSwitch = (h) => h.dom.window.document
  .querySelector('#mcpServerDetailsDrawer .mcp-approval-row [data-inv-toggle]');

module.exports = { flush, discovery, pendingServer, harness, REA_COMMAND, openDrawer, saveEditor, drawerSwitch };
