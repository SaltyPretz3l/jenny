'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');
const selectField = require('../renderer/inventory/select-field');
const toggleSwitch = require('../renderer/inventory/toggle-switch');
const pluginsSettings = require('../renderer/shell/renderer-plugins-settings');
const { createPluginDetailsController } = require('../renderer/shell/renderer-plugin-manager-details');
const mcpServers = require('../renderer/shell/renderer-mcp-servers');

const flush = async () => { await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve)); };

function plugin(overrides = {}) {
  return { publisher_id: 'acme', plugin_id: 'notes', display_name: 'Notes', resolved_version: '1.0.0',
    effective_state: 'installed_disabled', desired_state: 'installed_disabled', activation_eligible: true,
    activation_reason_code: 'eligible', generation_id: 'gen-notes-1', update_available: false,
    contributions: [{ contribution_id: 'setup', display_name: 'Notes setup', kind: 'setup_scene',
      view: { view_kind: 'setup_scene' }, effective_enabled: false,
      blocked_reason: 'master_disabled' }], ...overrides };
}

// The control plane only reports a contribution as effectively enabled while its plugin
// is active, so a turned-off plugin can never open a view. The default fixture above is
// that turned-off plugin; this is the running one whose view button is live.
function runningPlugin(overrides = {}) {
  return plugin({ effective_state: 'active', desired_state: 'active',
    contributions: [{ contribution_id: 'setup', display_name: 'Notes setup', kind: 'setup_scene',
      view: { view_kind: 'setup_scene' }, effective_enabled: true, blocked_reason: 'none' }],
    ...overrides });
}

function platform(overrides = {}) {
  const plugins = overrides.plugins || [plugin()];
  return { ok: true, enabled: true, safe_mode_active: false, read_only: false,
    store_writable: true, runtime_status: 'ready', revision: 3, installed_count: plugins.length,
    plugins, ...overrides };
}

function catalog(overrides = {}) {
  return { ok: true, revision: 1, configured: false,
    empty_reason: 'no_catalog_sources_configured', sources: [], entries: [], ...overrides };
}

function dom() {
  return new JSDOM(`<!doctype html><body><nav class="settings-nav">
    <button data-settings-section="plugins">Plugins</button></nav>
    <section class="settings-card" data-settings-section="plugins" hidden>
      <div class="settings-card-header"><h3>Plugins &amp; Extensions</h3>
        <div id="pluginsHeaderActionsHost"></div></div>
      <div id="pluginsSettingsHost"></div>
      <div id="skillsSettingsSection"><h4 class="settings-group-heading">Skills</h4></div>
      <div id="mcpServersHost"></div>
      <div id="pluginsSourcesHost"></div>
    </section></body>`, { pretendToBeVisual: true });
}

function harness(t, { bridge = {}, enabled = true, statePayload = platform() } = {}) {
  const instance = dom();
  const { window: windowRef } = instance;
  const calls = [];
  const toasts = [];
  const logs = [];
  const views = [];
  const plugins = { getState: async () => statePayload, getCatalogState: async () => catalog(),
    refreshCatalogs: async () => catalog(), ...bridge };
  windowRef.jennyShell = { plugins, dialog: { async saveFile(payload) { calls.push(['save', payload]); } } };
  const previous = [globalThis.inventoryActionButton, globalThis.inventoryTextField,
    globalThis.inventoryToggleSwitch];
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventoryTextField = textField;
  globalThis.inventoryToggleSwitch = toggleSwitch;
  const controller = pluginsSettings.createPluginsSettingsController({
    state: { features: { featureFlags: { plugins: enabled } }, ui: { activeSettingsSection: 'models' } },
    windowRef, documentRef: windowRef.document,
    showToastMessage: (message, options) => toasts.push({ message, options }),
    appendClientLog: (...entry) => logs.push(entry),
    openPluginView: (identity) => views.push(identity),
    openSettingsSection: (section) => calls.push(['section', section]),
  });
  t.after(() => { controller.dispose(); [globalThis.inventoryActionButton, globalThis.inventoryTextField,
    globalThis.inventoryToggleSwitch] = previous; });
  return { controller, windowRef, document: windowRef.document, plugins, calls, toasts, logs, views,
    card: windowRef.document.querySelector('.settings-card[data-settings-section="plugins"]') };
}

test('feature flag off clears only plugin hosts and never calls plugin IPC', async (t) => {
  let count = 0;
  const h = harness(t, { enabled: false, bridge: { getState: async () => { count += 1; return platform(); } } });
  h.document.getElementById('pluginsSettingsHost').innerHTML = '<i>stale</i>';
  h.document.getElementById('pluginsSourcesHost').innerHTML = '<i>stale</i>';
  h.controller.bind();
  await flush();
  assert.equal(count, 0);
  assert.equal(h.card.hidden, true);
  assert.equal(h.document.getElementById('pluginsSettingsHost').textContent, '');
  assert.equal(h.document.getElementById('pluginsSourcesHost').textContent, '');
  assert.equal(h.document.getElementById('pluginsHeaderActionsHost').textContent, '');
  assert.match(h.document.getElementById('skillsSettingsSection').textContent, /Skills/);
});

test('installed and sources render independently as flat full-width groups', async (t) => {
  let catalogRefreshes = 0;
  const h = harness(t, { bridge: { refreshCatalogs: async () => { catalogRefreshes += 1; return catalog(); } } });
  h.controller.bind();
  await flush();
  const installed = h.document.getElementById('pluginsSettingsGroup');
  const sources = h.document.getElementById('pluginsSourcesGroup');
  assert.ok(installed.classList.contains('settings-group--wide'));
  assert.ok(sources.classList.contains('settings-group--wide'));
  assert.equal(installed.querySelector('h4').textContent, 'Installed');
  assert.equal(sources.querySelector('h4').textContent, 'Advanced');
  assert.ok(installed.querySelector('.settings-field-row[data-plugin-row="acme/notes"]'));
  assert.match(installed.textContent, /1\.0\.0 · acme · turned off/);
  assert.match(sources.textContent, /No catalog configured/);
  assert.equal(h.document.querySelector('#pluginsHeaderActionsHost [data-plugins-settings-action="install-package"]')
    .textContent, 'Install plugin');
  assert.ok(installed.querySelector('[data-plugins-drop-zone]'));
  assert.equal(installed.querySelector('[data-plugins-installed-count]'), null);
  assert.equal(h.card.querySelector('.plugin-manager-overflow'), null);
  assert.equal(catalogRefreshes, 1);
});

function dispatchDrop(windowRef, target, file) {
  const event = new windowRef.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
  target.dispatchEvent(event);
}

test('plugin drop zone rejects a wrong extension before resolving or installing a path', async (t) => {
  let pathReads = 0;
  let installs = 0;
  const h = harness(t, { bridge: { installLocalPackageFromPath: async () => {
    installs += 1; return { ok: true };
  } } });
  h.windowRef.jennyShell.attachments = { getPathForFile() { pathReads += 1; return 'G:\\bad.txt'; } };
  h.controller.bind();
  await flush();
  const zone = h.document.querySelector('[data-plugins-drop-zone]');
  dispatchDrop(h.windowRef, zone, new h.windowRef.File(['bad'], 'bad.txt'));
  await flush();
  assert.equal(pathReads, 0);
  assert.equal(installs, 0);
  assert.equal(h.toasts.at(-1).message, 'Choose a .jenny-plugin file.');
});

test('plugin package drop resolves the Electron File path and installs from that path', async (t) => {
  const payloads = [];
  const h = harness(t, { bridge: { installLocalPackageFromPath: async (payload) => {
    payloads.push(payload); return { ok: true };
  } } });
  h.windowRef.jennyShell.attachments = {
    getPathForFile() { return 'G:\\packages\\notes.jenny-plugin'; },
  };
  h.controller.bind();
  await flush();
  dispatchDrop(h.windowRef, h.document.querySelector('[data-plugins-drop-zone]'),
    new h.windowRef.File(['plugin'], 'notes.jenny-plugin'));
  await flush();
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].client_request_id, /^drop_/);
  assert.equal(payloads[0].path, 'G:\\packages\\notes.jenny-plugin');
  assert.equal(h.toasts.at(-1).message, 'Plugin installed — inactive.');
});

test('Advanced row persists disclosure state and contains the three source actions', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  let toggle = h.document.querySelector('[data-plugins-settings-action="toggle-advanced"]');
  let disclosure = h.document.querySelector('[data-plugins-advanced-disclosure]');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(disclosure.hidden, true);
  toggle.click();
  toggle = h.document.querySelector('[data-plugins-settings-action="toggle-advanced"]');
  disclosure = h.document.querySelector('[data-plugins-advanced-disclosure]');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(disclosure.hidden, false);
  assert.deepEqual([...disclosure.querySelectorAll('[data-plugins-settings-action]')]
    .map((button) => button.textContent.trim()).filter((label) => [
      'Add offline mirror', 'Install signed package', 'Export audit log',
    ].includes(label)), ['Add offline mirror', 'Install signed package', 'Export audit log']);
  h.controller.render();
  assert.equal(h.document.querySelector('[data-plugins-advanced-disclosure]').hidden, false);
});

test('developer installs replace the publisher token with the unsigned label', async (t) => {
  const h = harness(t, { statePayload: platform({ plugins: [plugin({
    source_kind: 'developer_link',
  })] }) });
  h.controller.bind();
  await flush();
  assert.match(h.document.getElementById('pluginsSettingsGroup').textContent,
    /1\.0\.0 · developer \(unsigned\) · turned off/);
});

test('lifecycle, activation, and progress values are bounded user copy', () => {
  assert.deepEqual(['absent', 'staged', 'installed_disabled', 'preparing', 'active', 'disabling',
    'blocked', 'quarantined', 'uninstalling'].map(pluginsSettings.stateCopy),
  ['not installed', 'installing…', 'turned off', 'starting…', 'active', 'turning off…',
    'blocked', 'quarantined', 'uninstalling…']);
  assert.equal(pluginsSettings.stateCopy('internal_raw_state'), 'state unavailable');
  assert.equal(pluginsSettings.activationReasonCopy('publisher_key_not_current'), 'publisher trust is no longer current');
  assert.equal(pluginsSettings.activationReasonCopy('internal_raw_reason'), 'activation unavailable');
  assert.deepEqual(['staging', 'validating', 'committing', 'preparing', 'cleanup', 'other']
    .map(pluginsSettings.progressCopy), ['Staging…', 'Validating…', 'Applying changes…',
    'Starting…', 'Cleaning up…', 'Working…']);
});

test('plugin switch sends bounded identity and restores focus after refresh', async (t) => {
  const calls = [];
  const h = harness(t, { bridge: { enable: async (payload) => { calls.push(payload); return { ok: true }; } } });
  h.controller.bind();
  await flush();
  const toggle = h.card.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.match(toggle.closest('label').textContent, /Notes enabled/);
  toggle.focus();
  toggle.click();
  await flush();
  assert.deepEqual(calls, [{ publisher_id: 'acme', plugin_id: 'notes' }]);
  assert.equal(h.document.activeElement.dataset.invToggle, 'pluginToggle_acme_notes');
});

test('primary setup action passes complete snake-case view identity', async (t) => {
  const h = harness(t, { statePayload: platform({ plugins: [runningPlugin()] }) });
  h.controller.bind();
  await flush();
  const row = h.card.querySelector('[data-plugin-row="acme/notes"]');
  assert.equal(row.dataset.contributionId, 'setup');
  const open = row.querySelector('[data-plugins-settings-action="open-view"]');
  assert.equal(open.textContent.trim(), 'Set up');
  assert.equal(open.disabled, false);
  open.click();
  assert.deepEqual(h.views, [{ publisher_id: 'acme', plugin_id: 'notes', contribution_id: 'setup',
    generation_id: 'gen-notes-1', display_name: 'Notes setup' }]);
});

test('a view whose contribution is not running offers an inert button that says why', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  const open = h.card.querySelector('[data-plugins-settings-action="open-view"]');
  assert.equal(open.disabled, true);
  assert.equal(open.title, 'Turn this plugin on to open its view.');
  open.click();
  assert.deepEqual(h.views, []);
});

test('a managed-policy block names the policy instead of the master switch', async (t) => {
  const blocked = runningPlugin({ contributions: [{ contribution_id: 'setup',
    display_name: 'Notes setup', kind: 'setup_scene', view: { view_kind: 'setup_scene' },
    effective_enabled: false, blocked_reason: 'managed_policy' }] });
  const h = harness(t, { statePayload: platform({ plugins: [blocked] }) });
  h.controller.bind();
  await flush();
  const open = h.card.querySelector('[data-plugins-settings-action="open-view"]');
  assert.equal(open.disabled, true);
  assert.equal(open.title, 'Managed policy blocks this plugin view.');
});

test('missing bridge methods produce bounded visible diagnostics', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  h.card.querySelector('[role="switch"]').click();
  await flush();
  assert.match(h.card.textContent, /action is unavailable in this build/i);
  assert.match(h.toasts.at(-1).message, /action is unavailable/i);
  assert.deepEqual(h.logs.at(-1), ['WARN', 'plugins_settings.bridge_method_missing',
    { name: 'enable' }]);
});

test('open details reloads after a successful lifecycle switch', async (t) => {
  let detailReads = 0;
  const detail = { publisher_id: 'acme', plugin_id: 'notes', display_name: 'Notes',
    resolved_version: '1.0.0', effective_state: 'installed_disabled', activation_eligible: true,
    source_evidence: {}, signature_evidence: {}, lifecycle: {}, authentication: [], revocation: {},
    contributions: [{ contribution_id: 'setup', display_name: 'Notes setup', kind: 'setup_scene',
      view: { view_kind: 'setup_scene' } }] };
  const h = harness(t, { bridge: {
    getDetails: async () => { detailReads += 1; return { ok: true, plugin: detail }; },
    enable: async () => ({ ok: true }),
  } });
  h.controller.bind();
  await flush();
  const originalTrigger = h.card.querySelector('[data-plugins-settings-action="details"]');
  originalTrigger.focus();
  originalTrigger.click();
  await flush();
  assert.equal(detailReads, 1);
  h.card.querySelector('[role="switch"]').click();
  await flush();
  assert.equal(detailReads, 2);
  const contribution = h.document.querySelector('#pluginManagerDetailsDrawer [data-contribution-id="setup"]');
  assert.ok(contribution.querySelector('[data-plugins-settings-action="open-view"]'));
  const currentTrigger = h.card.querySelector('[data-plugins-settings-action="details"]');
  assert.notEqual(currentTrigger, originalTrigger);
  h.document.querySelector('#pluginManagerDetailsDrawer [data-drawer-close]').click();
  assert.equal(h.document.activeElement, currentTrigger);
});

test('disabled activation controls explain bounded reasons without exposing raw enums', async (t) => {
  const blocked = plugin({ activation_eligible: false, activation_reason_code: 'safe_mode' });
  const h = harness(t, { statePayload: platform({ plugins: [blocked] }) });
  h.controller.bind();
  await flush();
  assert.match(h.card.querySelector('[data-plugin-row]').textContent, /can’t start — plugins are in safe mode/);
  assert.equal(h.card.querySelector('[data-plugin-row] [role="switch"]').disabled, true);
  assert.doesNotMatch(h.card.textContent, /safe_mode/);
});

test('progress mutates only the permanent status node', async (t) => {
  let progressListener;
  const finishes = [];
  const h = harness(t, { bridge: {
    installLocalPackage: () => new Promise((resolve) => { finishes.push(resolve); }),
    onOperationProgress: (listener) => { progressListener = listener; return () => {}; },
  } });
  h.controller.bind();
  await flush();
  h.card.querySelector('[data-plugins-settings-action="install-package"]').click();
  await flush();
  const group = h.document.getElementById('pluginsSettingsGroup');
  const sourcesHtml = h.document.getElementById('pluginsSourcesHost').innerHTML;
  progressListener({ operation_id: 'op-1', event: { phase: 'validating' } });
  assert.equal(h.document.getElementById('pluginsSettingsGroup'), group);
  assert.equal(h.document.getElementById('pluginsSourcesHost').innerHTML, sourcesHtml);
  assert.equal(group.querySelector('[role="status"]').textContent, 'Validating…');
  finishes[0]({ ok: true, operation_id: 'op-1' });
  await flush();
  h.card.querySelector('[data-plugins-settings-action="install-package"]').click();
  await flush();
  progressListener({ operation_id: 'op-2', event: { phase: 'cleanup' } });
  assert.equal(h.document.getElementById('pluginsSettingsGroup').querySelector('[role="status"]').textContent,
    'Cleaning up…');
  finishes[1]({ ok: true, operation_id: 'op-2' });
  await flush();
});

test('offline mirror validates input and treats picker cancellation as neutral', async (t) => {
  const payloads = [];
  const h = harness(t, { bridge: { selectOfflineMirror: async (payload) => {
    payloads.push(payload); return { ok: false, canceled: true, selected_path: 'G:\\secret' };
  } } });
  h.controller.bind();
  await flush();
  h.card.querySelector('[data-plugins-settings-action="add-mirror"]').click();
  // source_id is the ONLY mirror identity that survives: plugin-source-trust.schema.json
  // is frozen with additional_properties "reject" and its offline_mirror variant has no
  // name field, so the form must not collect one it cannot persist.
  assert.equal(h.document.getElementById('pluginMirrorDisplayName'), null);
  const source = h.document.getElementById('pluginMirrorSourceId');
  source.value = 'INVALID';
  source.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));
  h.card.querySelector('[data-plugins-settings-action="save-mirror"]').click();
  await flush();
  assert.equal(payloads.length, 0);
  assert.match(h.card.textContent, /Source ID must start with a letter/);
  const nextSource = h.document.getElementById('pluginMirrorSourceId');
  nextSource.value = 'team_mirror';
  nextSource.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));
  h.card.querySelector('[data-plugins-settings-action="save-mirror"]').click();
  await flush();
  assert.deepEqual(payloads, [{ source_id: 'team_mirror' }]);
  assert.ok(h.card.querySelector('[data-plugins-mirror-form]'));
  assert.equal(h.toasts.length, 0);
  assert.equal(JSON.stringify(h.logs).includes('G:\\secret'), false);
});

const drawerDetail = { publisher_id: 'acme', plugin_id: 'notes', display_name: 'Notes',
  resolved_version: '1.0.0', effective_state: 'installed_disabled', activation_eligible: true,
  generation_id: 'gen-notes-1', source_evidence: {}, signature_evidence: {}, lifecycle: {},
  authentication: [], revocation: {}, contributions: [] };

test('renderer-invented failure reasons never reach the user as raw enums', async (t) => {
  assert.equal(pluginsSettings.failureMessage({ ok: false, reason: 'operation_busy' }),
    'Another plugin operation is still running. Wait for it to finish.');
  assert.equal(pluginsSettings.failureMessage({ ok: false, reason: 'bridge_call_failed' }),
    'The plugin service did not respond. Try again.');
  assert.equal(pluginsSettings.failureMessage({ ok: false, reason: 'bridge_method_missing' }),
    'This plugin action is unavailable in this build.');
  // Wire refusals are a different class: CMP-PLUGIN codes stay verbatim by design.
  assert.equal(pluginsSettings.failureMessage({ ok: false, code: 'CMP-PLUGIN-014', reason: 'store_locked' }),
    'CMP-PLUGIN-014 · store_locked');

  const h = harness(t, { bridge: { enable: async () => { throw new Error('EPIPE G:\\secret'); } } });
  h.controller.bind();
  await flush();
  h.card.querySelector('[role="switch"]').click();
  await flush();
  assert.equal(h.toasts.at(-1).message, 'The plugin service did not respond. Try again.');
  assert.equal(h.card.textContent.includes('bridge_call_failed'), false);
  assert.equal(JSON.stringify(h.logs).includes('secret'), false);
  assert.equal(h.logs.some((entry) => entry[1] === 'plugins_settings.bridge_call_failed'), true);
});

test('an in-flight operation disables the open drawer but never its close control', async (t) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const h = harness(t, { bridge: {
    getDetails: async () => ({ ok: true, plugin: drawerDetail }),
    enable: () => pending,
  } });
  h.controller.bind();
  await flush();
  h.card.querySelector('[data-plugins-settings-action="details"]').click();
  await flush();
  const panel = h.document.querySelector('#pluginManagerDetailsDrawer .inv-drawer-panel');
  panel.querySelector('[data-plugins-settings-action="enable"]').click();
  await flush();
  assert.equal(panel.getAttribute('aria-busy'), 'true');
  assert.match(panel.querySelector('[data-plugin-drawer-operation-status]').textContent, /Working/);
  assert.equal(panel.querySelector('[data-plugins-settings-action="uninstall"]').disabled, true);
  // An operation must never trap the user inside the drawer.
  assert.equal(panel.querySelector('button[data-drawer-close]').disabled, false);
  finish({ ok: true });
  await flush();
  const next = h.document.querySelector('#pluginManagerDetailsDrawer .inv-drawer-panel');
  assert.equal(next.querySelector('[data-plugin-drawer-operation-status]'), null);
  assert.notEqual(next.getAttribute('aria-busy'), 'true');
  assert.equal(next.querySelector('[data-plugins-settings-action="uninstall"]').disabled, false);
});

test('redrawing the details drawer never bounces focus back into the list', async (t) => {
  const h = harness(t, { bridge: {
    getDetails: async () => ({ ok: true, plugin: drawerDetail }),
    enable: async () => ({ ok: true }),
  } });
  h.controller.bind();
  await flush();
  h.card.querySelector('[data-plugins-settings-action="details"]').click();
  await flush();
  // drawer.open() closes the previous panel first; both the drawer and the overlay
  // manager restore focus to the trigger on close, which used to yank focus out to
  // the row and straight back on every redraw.
  const landed = [];
  h.card.addEventListener('focusin', (event) => landed.push(event.target));
  h.document.querySelector('#pluginManagerDetailsDrawer [data-plugins-settings-action="enable"]').click();
  await flush();
  assert.deepEqual(landed, []);
  assert.equal(h.card.contains(h.document.activeElement), false);
});

test('a stale plugin-details load cannot repaint a newer drawer selection', async (t) => {
  const instance = dom();
  const pending = [];
  const controller = createPluginDetailsController({
    documentRef: instance.window.document,
    actionButton,
    getApi: () => ({
      getDetails: ({ plugin_id: pluginId }) => new Promise((resolve) => pending.push({ pluginId, resolve })),
    }),
  });
  t.after(() => {
    controller.dispose();
    instance.window.close();
  });

  void controller.open({ publisherId: 'acme', pluginId: 'a', displayName: 'Plugin A' });
  void controller.open({ publisherId: 'acme', pluginId: 'b', displayName: 'Plugin B' });
  pending.find(({ pluginId }) => pluginId === 'b').resolve({ ok: true, plugin: {
    ...drawerDetail, plugin_id: 'b', display_name: 'Plugin B',
  } });
  await flush();
  pending.find(({ pluginId }) => pluginId === 'a').resolve({ ok: true, plugin: {
    ...drawerDetail, plugin_id: 'a', display_name: 'Plugin A',
  } });
  await flush();

  assert.equal(instance.window.document.querySelector('.inv-drawer-header h2').textContent, 'Plugin B');
});

test('verified catalog install and audit export retain bounded payloads', async (t) => {
  const calls = [];
  const entry = { source_id: 'usb', publisher_id: 'acme', plugin_id: 'weather', display_name: 'Weather',
    version: '2.0.0', summary: 'Forecasts', package_size_bytes: 42, package_sha256: 'a'.repeat(64) };
  const h = harness(t, { bridge: {
    getCatalogState: async () => catalog({ configured: true, entries: [entry] }),
    installFromCatalog: async (payload) => { calls.push(payload); return { ok: true }; },
    exportAudit: async () => ({ ok: true, document: { audit_schema_version: 1 } }),
  } });
  h.controller.bind();
  await flush();
  h.card.querySelector('[data-plugins-settings-action="catalog-install"]').click();
  await flush();
  h.card.querySelector('[data-plugins-settings-action="export-audit"]').click();
  await flush();
  assert.deepEqual(calls, [{ source_id: 'usb', publisher_id: 'acme', plugin_id: 'weather',
    version: '2.0.0', package_sha256: 'a'.repeat(64) }]);
  assert.equal(JSON.stringify(calls).includes('path'), false);
  assert.match(h.calls[0][1].content, /audit_schema_version/);
});

test('a rejected audit save is contained and reported without provider details', async (t) => {
  const h = harness(t, { bridge: {
    exportAudit: async () => ({ ok: true, document: { audit_schema_version: 1 } }),
  } });
  h.windowRef.jennyShell.dialog.saveFile = async () => {
    throw new Error('disk failure at C:\\Users\\alice\\private\\audit.json');
  };
  h.controller.bind();
  await flush();

  h.card.querySelector('[data-plugins-settings-action="export-audit"]').click();
  await flush();

  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].options.tone, 'warning');
  assert.match(h.toasts[0].message, /could not save/i);
  assert.doesNotMatch(JSON.stringify({ toasts: h.toasts, logs: h.logs }), /Users\\alice|audit\.json|disk failure/);
  assert.deepEqual(h.logs, [['WARN', 'plugins_settings.audit_export_save_failed', { reason: 'save_failed' }]]);
});

test('stale revisions are ignored and disposal suppresses late paint', async (t) => {
  let resolveState;
  const pending = new Promise((resolve) => { resolveState = resolve; });
  const h = harness(t, { bridge: { getState: () => pending, refreshCatalogs: async () => catalog() } });
  h.controller._test.setPlatform(pluginsSettings.classifyPluginsPlatform(true, platform({ revision: 9 })));
  const refresh = h.controller.refresh();
  resolveState(platform({ revision: 2, plugins: [], installed_count: 0 }));
  await refresh;
  assert.equal(h.controller._test.getPlatform().revision, 9);
  const second = harness(t, { bridge: { getState: () => new Promise(() => {}), refreshCatalogs: async () => catalog() } });
  second.controller.bind();
  second.controller.dispose();
  await flush();
  assert.equal(second.document.getElementById('pluginsSettingsGroup'), null);
});

test('controller activation order cannot change Installed → Skills → MCP → Sources', async (t) => {
  const previous = [globalThis.inventoryActionButton, globalThis.inventoryTextField,
    globalThis.inventorySelectField, globalThis.inventoryToggleSwitch];
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventoryTextField = textField;
  globalThis.inventorySelectField = selectField;
  globalThis.inventoryToggleSwitch = toggleSwitch;
  t.after(() => { [globalThis.inventoryActionButton, globalThis.inventoryTextField,
    globalThis.inventorySelectField, globalThis.inventoryToggleSwitch] = previous; });

  for (const order of ['plugins-first', 'mcp-first']) {
    const instance = dom();
    instance.window.jennyShell = {
      plugins: { getState: async () => platform(), getCatalogState: async () => catalog(),
        refreshCatalogs: async () => catalog() },
      mcpDiscovery: { getState: async () => ({ schemaVersion: 1, servers: [] }) },
      mcpAuth: { getStatus: async () => ({ loaded: true, store: { status: 'ready' }, servers: [] }) },
    };
    const shared = { state: { features: { featureFlags: { plugins: true, mcp_management_ui: true } } },
      windowRef: instance.window, documentRef: instance.window.document };
    const pluginsController = pluginsSettings.createPluginsSettingsController(shared);
    const mcpController = mcpServers.createMcpServersController(shared);
    const controllers = order === 'plugins-first' ? [pluginsController, mcpController] : [mcpController, pluginsController];
    controllers.forEach((controller) => controller.bind());
    await flush();
    const card = instance.window.document.querySelector('.settings-card[data-settings-section="plugins"]');
    assert.deepEqual(Array.from(card.children).filter((node) => node.id).map((node) => node.id),
      ['pluginsSettingsHost', 'skillsSettingsSection', 'mcpServersHost', 'pluginsSourcesHost'], order);
    assert.deepEqual(['pluginsSettingsHost', 'skillsSettingsSection', 'mcpServersHost', 'pluginsSourcesHost']
      .map((id) => card.querySelector(`#${id} h4`)?.textContent),
    ['Installed', 'Skills', 'MCP connections', 'Advanced'], order);
    controllers.reverse().forEach((controller) => controller.dispose());
  }
});

test('platform classifier keeps fail-closed postures distinct', () => {
  assert.equal(pluginsSettings.classifyPluginsPlatform(false, null).kind, 'unavailable');
  assert.equal(pluginsSettings.classifyPluginsPlatform(true, { safe_mode_active: true }).kind, 'safe_mode');
  assert.equal(pluginsSettings.classifyPluginsPlatform(true, { ok: false, enabled: true }).kind, 'refused');
  assert.equal(pluginsSettings.classifyPluginsPlatform(true, platform()).kind, 'ready');
  assert.equal(pluginsSettings.isNewerVersion('1.1.0', '1.0.9'), true);
  assert.equal(pluginsSettings.isNewerVersion('1.0.0-beta.2', '1.0.0-beta.1'), true);
  assert.equal(pluginsSettings.isNewerVersion('1.0.0-2', '1.0.0-1'), true);
});
