'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { minimatch } = require('minimatch');

const manifest = require('../services/tools/tool-manifest.json');
const {
  SURFACE_FAMILIES, ALWAYS_ON_TOOL_NAMES, resolveRequestToolPreferences, surfaceFamilyForTool,
} = require('../services/tools/tool-surface-families');
const { normalizeManagedToolPreferences, requestToolPreferences, resolveSessionToolDenyList } = require('../services/backend/backend-service-utils');
const { normalizeToolCategoryOverrides } = require('../services/backend/session-normalizers');
const { SessionExecutionAuthority, getTrustedExecutionBinding } = require('../services/backend/session-execution-authority');
const { TOOL_NETWORK_CLASSIFICATION, applySessionLockdownToToolPreferences, isToolAvailableDuringSessionLockdown } = require('../services/backend/session-lockdown-gate');
const { evaluatePolicy, normalizePolicySnapshot } = require('../services/tools/tool-policy-evaluator');
const { buildFeatureFlags, INTERNAL_FEATURE_FLAG_KEYS, FEATURE_OVERRIDE_KEYS, normalizeFeatureOverrides } = require('../services/feature-flags');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-config');
const { createDefaultRegistry } = require('../services/tools');
const { ELECTRON_BRIDGE_TOOL_NAMES } = require('../services/backend/electron-tool-bridge');
const { ALLOWED: SANDBOX_BRIDGE_TOOLS } = require('../services/execution/command-bridge');

const ROOT = path.resolve(__dirname, '..');
const browserOff = result => Boolean(result?.disabled_tools?.includes('browser'));

test('the browser_use family exists in the Reach section and browser belongs to it only', () => {
  const family = SURFACE_FAMILIES.find(item => item.id === 'browser_use');
  assert.ok(family);
  assert.equal(family.section, 'reach');
  assert.deepEqual(family.sidecarFamilies, ['browser_use']);
  assert.equal(surfaceFamilyForTool('browser'), 'browser_use');
  assert.ok(!ALWAYS_ON_TOOL_NAMES.includes('browser'), 'the composer switch can turn it off');
  assert.equal(SURFACE_FAMILIES.filter(item => item.toolNames.includes('browser') || item.sidecarFamilies.includes('browser_use')).length, 1);
});

test('an absent key and any value but a real true leave the tool off', () => {
  assert.equal(browserOff(resolveRequestToolPreferences(undefined)), true);
  assert.equal(browserOff(resolveRequestToolPreferences({})), true);
  assert.equal(browserOff(resolveRequestToolPreferences({ families: {} })), true);
  assert.equal(browserOff(resolveRequestToolPreferences({ families: { web: true } })), true);
  for (const value of [false, 'true', 1, 'yes', null, undefined, {}, []]) {
    assert.equal(browserOff(resolveRequestToolPreferences({ families: { browser_use: value } })), true, String(value));
  }
});

test('an explicit true offers the tool and leaves the rest of the resolution alone', () => {
  assert.equal(resolveRequestToolPreferences({ families: { browser_use: true } }), undefined);
  const result = resolveRequestToolPreferences({ families: { browser_use: true, web: false } });
  assert.equal(browserOff(result), false);
  assert.ok(result.disabled_tools.includes('web_search'));
  assert.ok(result.disabled_tools.includes('fetch_url'));
});

test('an explicit false still switches other families off and never touches always-on tools', () => {
  const result = resolveRequestToolPreferences({ families: { files: false, git: false } });
  assert.ok(result.disabled_tools.includes('read_file'));
  assert.ok(result.disabled_tools.includes('git_status'));
  assert.ok(browserOff(result));
  assert.ok(!result.disabled_tools.includes('session_message'));
  const everything = resolveRequestToolPreferences({ families: Object.fromEntries(SURFACE_FAMILIES.map(item => [item.id, false])) });
  assert.ok(everything.disabled_tools.includes('browser'));
  assert.ok(ALWAYS_ON_TOOL_NAMES.every(name => !everything.disabled_tools.includes(name)));
});

test('the sidecar catalog entry is resolved the same way', () => {
  const catalog = { browser: { tool_family: 'browser_use' }, mcp__x__browser_thing: { tool_family: 'other', source_kind: 'mcp' } };
  assert.ok(resolveRequestToolPreferences({ families: {} }, catalog).disabled_tools.includes('browser'));
  assert.equal(resolveRequestToolPreferences({ families: { browser_use: true } }, catalog), undefined);
});

test('the request and session paths that resolve preferences keep the tool off by default', () => {
  assert.equal(browserOff(normalizeManagedToolPreferences({ families: {} })), true);
  assert.equal(browserOff(normalizeManagedToolPreferences({ web_search: false })), true);
  assert.equal(normalizeManagedToolPreferences({ families: { browser_use: true } }), undefined);
  assert.ok(resolveSessionToolDenyList({}, undefined).includes('browser'));
  assert.ok(resolveSessionToolDenyList(null, undefined).includes('browser'));
  assert.ok(!resolveSessionToolDenyList({ tool_category_overrides: { browser_use: true } }, undefined).includes('browser'));
});

test('a turn that names no preference follows the chat for this family and leaves every other one on', () => {
  for (const none of [undefined, null, 'text', []]) {
    assert.deepEqual(requestToolPreferences(none, { session: { id: 'chat' } }), { disabled_tools: ['browser'] }, String(none));
    assert.deepEqual(requestToolPreferences(none, {}), { disabled_tools: ['browser'] }, 'no session reads as off');
    assert.equal(requestToolPreferences(none, { session: { tool_category_overrides: { browser_use: true } } }), undefined);
    assert.deepEqual(requestToolPreferences(none, { session: { tool_category_overrides: { browser_use: 'true' } } }), { disabled_tools: ['browser'] });
  }
});

test('a stated preference is left to the ordinary resolution', () => {
  const session = { tool_category_overrides: { browser_use: true } };
  assert.equal(browserOff(requestToolPreferences({ families: {} }, { session })), true, 'the request names the families');
  assert.equal(requestToolPreferences({ families: { browser_use: true } }, {}), undefined);
  assert.deepEqual(requestToolPreferences({ disabled_tools: ['read_file'] }, {}), { disabled_tools: ['read_file'] });
});

test('the per-chat switch survives being saved', () => {
  assert.deepEqual(normalizeToolCategoryOverrides({ browser_use: true, web: false, nonsense: true }), { web: false, browser_use: true });
  assert.deepEqual(normalizeToolCategoryOverrides({ browser_use: 'yes' }), {});
});

function authorityFor(session) {
  const project = { project_id: 'p', root_path: os.tmpdir(), root_id: 'r', root_revision: 1, device_id: 'd', inode: 'i' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: current => current, _sessionStore: { getSessionSummary: () => session } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    resolveSessionDisabledTools: () => resolveSessionToolDenyList(session, undefined),
  });
  return getTrustedExecutionBinding(authority.captureSession('chat', { requestId: 'stream', mode: 'assist', approvalMode: 'prompt' }));
}

test('a turn that carried no preference still cannot call browser unless the chat switched it on', () => {
  const availability = trusted => trusted.describeToolAvailability({ browser: { available: true } }).tools_status.browser;
  assert.equal(availability(authorityFor({ id: 'chat' })).available, false);
  assert.equal(availability(authorityFor({ id: 'chat' })).reason, 'disabled for this request');
  assert.equal(availability(authorityFor({ id: 'chat', tool_category_overrides: { browser_use: true } })).available, true);
});

test('lockdown disables browser as a network tool', () => {
  assert.equal(TOOL_NETWORK_CLASSIFICATION.browser, 'possible');
  assert.equal(isToolAvailableDuringSessionLockdown('browser', true), false);
  assert.equal(isToolAvailableDuringSessionLockdown('browser', false), true);
  const locked = applySessionLockdownToToolPreferences({}, true);
  assert.ok(locked.disabled_tools.includes('browser'));
  assert.ok(!locked.enabled_tools.includes('browser'));
});

test('the flag is declared on by default, internal, and rolled back by its env switch', () => {
  assert.equal(buildFeatureFlags({}).tools_browser_use_enabled, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_TOOLS_BROWSER_USE: '1' }).tools_browser_use_enabled, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_TOOLS_BROWSER_USE: '0' }).tools_browser_use_enabled, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('tools_browser_use_enabled'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('tools_browser_use_enabled'));
  assert.deepEqual(normalizeFeatureOverrides({ tools_browser_use_enabled: false }), {});
});

function sidecarConfig(featureFlags, hostMode = 'desktop') {
  return buildManagedSidecarConfig({
    hostMode, currentEngineType: 'replay', currentModel: 'replay-model', defaultModel: 'replay-model',
    options: { userDataPath: os.tmpdir(), modelEndpoint: { engine: 'replay', model: 'replay-model' } },
    featureFlags, toolExecutor: {},
    configService: { getState: () => ({ tools: {} }), getToolsWorkspaceRoot: () => '' },
    skillsService: { getSidecarConfig: () => ({}) }, knowledgeService: { getSidecarConfig: () => ({}) },
  });
}

test('the flag reaches the sidecar config only as a real true, and hosted keeps it closed', () => {
  assert.equal(sidecarConfig({ tools_browser_use_enabled: true }).tools_browser_use_enabled, true);
  for (const flags of [{ tools_browser_use_enabled: false }, {}, { tools_browser_use_enabled: 'true' }]) {
    assert.equal(sidecarConfig(flags).tools_browser_use_enabled, false, JSON.stringify(flags));
  }
  assert.equal(sidecarConfig({ tools_browser_use_enabled: true }, 'server').tools_browser_use_enabled, false);
});

test('the registry holds browser only on an explicit true', () => {
  assert.equal(createDefaultRegistry({}).getTool('browser'), undefined);
  assert.equal(createDefaultRegistry({ toolsBrowserUseEnabled: false }).getTool('browser'), undefined);
  assert.ok(createDefaultRegistry({ toolsBrowserUseEnabled: true }).getTool('browser'));
});

test('browser is an Electron bridge tool, allowed through the sandbox bridge, with per-call policy out of the way', () => {
  assert.ok(ELECTRON_BRIDGE_TOOL_NAMES.has('browser'));
  assert.ok(SANDBOX_BRIDGE_TOOLS.has('browser'));
  const entry = manifest.tools.find(tool => tool.name === 'browser');
  for (const action of Object.keys(entry.actions)) {
    const decision = evaluatePolicy({ descriptor: entry, args: { action }, mode: 'assist', snapshot: normalizePolicySnapshot({}) });
    assert.equal(decision.decision, 'auto', action);
  }
});

test('the description makes this the tool for web pages once a chat has turned it on', () => {
  // With every tool on offer the model reached for fetch_url and then Python (2026-11-09).
  const { description } = manifest.tools.find(tool => tool.name === 'browser');
  assert.match(description, /turned it on for this chat/);
  assert.match(description, /localhost/);
  for (const other of ['fetch_url', 'python_execute']) assert.ok(description.includes(other), other);
});

test('the app package includes the browser-use modules and the tool files', () => {
  const config = require('js-yaml').load(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
  const globs = config.files.map(String);
  const includes = globs.filter(glob => !glob.startsWith('!'));
  const excludes = globs.filter(glob => glob.startsWith('!')).map(glob => glob.slice(1));
  const packaged = relPath => includes.some(glob => minimatch(relPath, glob, { dot: true }))
    && !excludes.some(glob => minimatch(relPath, glob, { dot: true }));
  const files = fs.readdirSync(path.join(ROOT, 'services/browser-use')).filter(name => name.endsWith('.js'));
  assert.ok(files.includes('result-format.js'));
  for (const name of files) assert.ok(packaged(`services/browser-use/${name}`), name);
  for (const relPath of ['services/browser-use/browser-use-service.js', 'services/browser-use/reserved-ports.js',
    'services/tools/builtin/browser-tool.js', 'services/tools/mid-tool-consent.js', 'services/main/browser-use-composition.js']) {
    assert.ok(packaged(relPath), relPath);
  }
});

test('a turn nobody is at the keyboard for stays off even in a chat that turned the browser on', () => {
  const session = { tool_category_overrides: { browser_use: true } };
  for (const applicationTurn of ['scheduled_check', 'digest']) {
    assert.equal(browserOff(requestToolPreferences(undefined, { session, applicationTurn })), true, applicationTurn);
  }
  // A woken chat is offered the tool so it can close its page; browser-tool.js refuses every other step.
  assert.equal(requestToolPreferences(undefined, { session, applicationTurn: 'wake' }), undefined);
  assert.equal(browserOff(requestToolPreferences(undefined, { session: {}, applicationTurn: 'wake' })), true, 'only where the chat turned it on');
  assert.equal(requestToolPreferences(undefined, { session, applicationTurn: 'auto_resume' }), undefined, 'it finishes a turn the user started');
  assert.equal(requestToolPreferences(undefined, { session }), undefined);
});

test('the Tools row and the request resolver agree on what starts off', () => {
  const { defaultOffFamilySwitches } = require('../services/tools/tool-surface-families');
  const { DEFAULT_OFF_FAMILY_IDS } = require('../renderer/chat/renderer-composer-v2-model');
  assert.deepEqual([...DEFAULT_OFF_FAMILY_IDS].sort(), Object.keys(defaultOffFamilySwitches({})).sort());
});
