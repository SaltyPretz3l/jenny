'use strict';

// Row 123, live check 2026-11-12: Settings > Team on a profile with no team data threw CMP-RENDER-0001 in the
// real app. Main's `teamData` flag was dropped by `normalizeFeatureState`, and `loadTeamScripts` then fell back
// to `require('../team/renderer-team-tab-gate')`, which in the renderer is Monaco's AMD loader and throws.
// The Settings module is run here the way the renderer runs it: a script with a throwing `require` and no `module`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { flush, harness, shell, snapshot } = require('./helpers/team-settings-harness');

const SHELL_DIR = path.join(__dirname, '..', 'renderer', 'shell');
const SOURCE = fs.readFileSync(path.join(SHELL_DIR, 'renderer-settings-utils.js'), 'utf8');
const manifest = require('../renderer/shell/renderer-settings-script-manifest');
const { normalizeFeatureState } = require('../renderer/shell/renderer-settings-support');
const GATE_SRC = manifest.teamGate[0][0];

function loadAsBrowserScript() {
  const amdRequireCalls = [];
  const sandbox = {
    console,
    require: (name) => { amdRequireCalls.push(name); throw new Error(`Check dependency list! Synchronous require cannot resolve module '${name}'.`); },
    appearanceUtils: require('../renderer/shared/appearance-utils'),
    rendererSettingsSupport: require('../renderer/shell/renderer-settings-support'),
    rendererSettingsCoreRenderers: require('../renderer/shell/renderer-settings-core-renderers'),
    rendererSettingsSectionRegistry: require('../renderer/shell/renderer-settings-section-registry'),
    rendererSettingsFoundation: require('../renderer/shell/renderer-settings-foundation'),
    rendererSettingsControlTowerUtils: require('../renderer/shell/renderer-settings-control-tower-utils'),
    rendererSettingsLazyRenderers: require('../renderer/shell/renderer-settings-lazy-renderers'),
    rendererSettingsV2Surfaces: require('../renderer/shell/renderer-settings-v2-surfaces'),
    rendererSettingsNavUtils: require('../renderer/shell/renderer-settings-nav-utils'),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SOURCE, sandbox, { filename: 'renderer-settings-utils.js' });
  return { utils: sandbox.rendererSettingsUtils, amdRequireCalls };
}

// Settings > Team entered on a fresh profile through the browser-style module, over the real top rail.
function openTeam(t, teamData) {
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h, { activeView: 'settings', ...(teamData === undefined ? {} : { teamData }) });
  // A render pass over the state comes first, as in the app (Settings renders before the section is entered).
  s.state.ui.activeSettingsSection = 'general';
  renderPass(s.state);
  s.state.ui.activeSettingsSection = 'team';
  const shown = [];
  const real = h.section.showTeamSection;
  h.section.showTeamSection = (options) => { shown.push(options); return real(options); };
  const { utils, amdRequireCalls } = loadAsBrowserScript();
  assert.doesNotThrow(() => utils.syncTeamSettingsSection({ state: s.state, windowRef: h.window, activeSection: 'team' }));
  return { h, s, shown, amdRequireCalls };
}

test('first open, teamData false: no throw, the section loads without the gate and draws with teamData false', async (t) => {
  const { h, s, shown, amdRequireCalls } = openTeam(t, false);
  await flush();
  assert.deepEqual(s.requested, manifest.teamSection.map(([src]) => src), 'the section scripts only; the gate is never requested');
  assert.ok(h.window.document.querySelector('link[href="styles/team-settings.css"]'), 'the stylesheet loads');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].teamData, false);
  assert.deepEqual(h.headings(), ['You', 'Host a team', 'Join a team']);
  assert.deepEqual(amdRequireCalls, []);
});

for (const [label, teamData] of [['absent', undefined], ['true', true]]) {
  test(`first open, teamData ${label}: no throw, the gate loads through the script loader, never through require`, async (t) => {
    const { h, s, shown, amdRequireCalls } = openTeam(t, teamData);
    await flush();
    assert.equal(s.requested[0], GATE_SRC, 'the gate is requested from the script loader first');
    assert.ok(manifest.teamSection.every(([src]) => s.requested.includes(src)), 'then the section scripts');
    assert.ok(h.window.document.querySelector('link[href="styles/team-settings.css"]'));
    assert.equal(shown.length, 1);
    assert.equal(shown[0].teamData, teamData);
    assert.deepEqual(amdRequireCalls, []);
  });
}

test('a throwing require never escapes the team section sync, even with no manifest on the window', (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  const { utils, amdRequireCalls } = loadAsBrowserScript();
  const s = shell(h, { activeView: 'settings', teamData: false });
  s.state.ui.activeSettingsSection = 'team';
  const windowRef = Object.create(h.window);
  windowRef.rendererSettingsScriptManifest = undefined;
  assert.doesNotThrow(() => utils.syncTeamSettingsSection({ state: s.state, windowRef, activeSection: 'team' }));
  assert.deepEqual(amdRequireCalls, []);
});

test('normalizeFeatureState keeps main\'s teamData: false stays false, true stays true, absent stays absent', () => {
  assert.equal(normalizeFeatureState({ teamData: false }).teamData, false);
  assert.equal(normalizeFeatureState({ teamData: true }).teamData, true);
  assert.equal(Object.hasOwn(normalizeFeatureState({}), 'teamData'), false);
  assert.equal(Object.hasOwn(normalizeFeatureState(null), 'teamData'), false);
  assert.equal(Object.hasOwn(normalizeFeatureState({ teamData: 'no' }), 'teamData'), false);
});

// A real renderSettings pass over a fresh-profile state, with the page's DOM and callbacks stubbed.
function renderPass(state) {
  const el = () => globalThis.document.createElement('div');
  const dom = new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? el() : undefined) });
  const callbacks = new Proxy({}, { get: (_t, key) => {
    if (key === 'getCurrentRuntimePreferences') return () => ({ contextPreferences: {} });
    if (key === 'normalizeAppearancePreferences') return (value) => value || {};
    if (key === 'getSurfaceEffectPresets') return () => [{ id: 'none', label: 'None' }];
    if (key === 'getComposerHoloOptions') return () => [{ id: 'off', label: 'Off' }];
    if (/^get.*(Presets|Bundles)$/.test(String(key))) return () => [];
    if (key === 'getActivitySnapshot' || key === 'getMostRecentActivity' || key === 'getActiveSession') return () => null;
    if (key === 'isActivityBusy') return () => false;
    if (key === 'escapeHtml') return (value) => String(value);
    if (key === 'getSectionDom') return () => ({});
    return () => ({});
  } });
  const scope = new Proxy({}, { get: (_t, key) => String(key) });
  Object.assign(state, { workspaceRoot: {}, modelList: {}, setup: {}, auth: {}, backend: {}, compactionTuning: {}, localEngines: {}, webSearchSecrets: {} });
  state.ui.appearance = {};
  require('../renderer/shell/renderer-settings-utils')
    .createSettingsRenderer({ state, constants: { ACTIVITY_SCOPE: scope }, dom, callbacks }).renderSettings();
}

for (const teamData of [false, true, undefined]) {
  test(`a full renderSettings pass leaves state.features.teamData as main sent it (${teamData})`, (t) => {
    const h = harness({ show: false });
    t.after(h.restore);
    const s = shell(h, { activeView: 'settings', teamData });
    s.state.ui.activeSettingsSection = 'general';
    renderPass(s.state);
    assert.equal(s.state.features.teamData, teamData);
    assert.equal(Object.hasOwn(s.state.features, 'teamData'), teamData !== undefined);
  });
}

test('top nav: after a settings render on a teamData false state, a view switch does not load the gate', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h, { activeView: 'settings', teamData: false });
  s.state.ui.activeSettingsSection = 'general';
  renderPass(s.state);
  s.state.ui.activeView = 'chat';
  s.controller.applyViewChrome();
  await flush();
  assert.equal(s.requested.includes(GATE_SRC), false, 'the gate stays unrequested');
  assert.deepEqual(s.tabs().includes('team'), true, 'row 168: the tab is in the rail; the gate loads only when it is opened');
});

test('the first team gives Team chat density back on Settings > Chat at once; a row with no reason is left alone', async (t) => {
  const h = harness();
  t.after(h.restore);
  await flush();
  const mount = h.window.document.createElement('div');
  mount.dataset.settingMount = 'appearanceTeamDensitySelect';
  mount.innerHTML = '<p class="settings-field-reason">Join or host a team to use this.</p>'
    + '<button data-value="comfortable" aria-checked="false" disabled></button><button data-value="compact" aria-checked="true" disabled></button>';
  h.window.document.body.appendChild(mount);
  const mounted = [];
  globalThis.rendererSettingsFieldDescriptors = { getSettingDescriptor: (id) => ({ id, default: 'comfortable' }) };
  globalThis.rendererSettingsFieldBinding = { mountSettingRow: (el, descriptor, value, opts) => { mounted.push([descriptor.id, value, opts.disabledReason]); el.innerHTML = ''; } };
  t.after(() => { delete globalThis.rendererSettingsFieldDescriptors; delete globalThis.rendererSettingsFieldBinding; });
  h.listeners.state({ teams: [] });
  await flush();
  assert.deepEqual(mounted, [], 'still no team: the row stays greyed');
  h.listeners.state({ teams: [snapshot()] });
  await flush();
  assert.deepEqual(mounted, [['appearanceTeamDensitySelect', 'compact', '']], 'drawn again with no reason, keeping what was chosen');
  h.listeners.state({ teams: [snapshot()] });
  await flush();
  assert.equal(mounted.length, 1, 'a row with no reason is not drawn again');
});
