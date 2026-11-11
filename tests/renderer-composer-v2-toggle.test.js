const test = require('node:test');
const assert = require('node:assert/strict');
const { createComposerV2ToggleController, sessionToolOverrideEchoMatches, countRows } = require('../renderer/chat/renderer-composer-v2-toggle');
const model = require('../renderer/chat/renderer-composer-v2-model');
const entry = (surfaceFamily, name = surfaceFamily, extra = {}) => ({ name, surfaceFamily, available: true, lockdownAvailable: true, ...extra });
const maps = (categories = {}, connections = {}) => ({ tool_category_overrides: categories, tool_connection_overrides: connections });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(deps = {}, entries = [entry('files'), entry('terminal'), entry('web')]) {
  const state = deps.state || { currentSessionId: 'a' };
  const controller = createComposerV2ToggleController({ ...deps, state });
  controller.setAvailableTools(entries);
  controller.hydrateForSession(state.currentSessionId, {}, {});
  return controller;
}

test('RED regression: an empty reset cannot acknowledge an uncleared override map', () => {
  assert.equal(sessionToolOverrideEchoMatches({ id: 'a', ...maps({ files: false }) }, 'a', {}), false);
});

test('echo requires exact values, keys and target identity in both maps', () => {
  const requested = maps({ files: false }, { 'mcp:github': false });
  assert.equal(sessionToolOverrideEchoMatches({ id: 'a', ...requested }, 'a', requested), true);
  assert.equal(sessionToolOverrideEchoMatches({ id: 'b', ...requested }, 'a', requested), false);
  assert.equal(sessionToolOverrideEchoMatches({ id: 'a', ...maps({ files: true }, requested.tool_connection_overrides) }, 'a', requested), false);
  assert.equal(sessionToolOverrideEchoMatches({ id: 'a', ...maps({ files: false, web: false }, requested.tool_connection_overrides) }, 'a', requested), false);
  assert.equal(sessionToolOverrideEchoMatches({ id: 'a', ...maps({ files: false }) }, 'a', requested), false);
  assert.equal(sessionToolOverrideEchoMatches({ id: 'a', ...maps({}, { 'mcp:github': false }) }, 'a', maps()), false);
  assert.equal(sessionToolOverrideEchoMatches({ id: 'a', ...maps() }, 'a', maps()), true);
  assert.equal(sessionToolOverrideEchoMatches({ id: 'a', tool_category_overrides: {} }, 'a', maps()), false);
});

test('send preferences are the chat overrides only, never a default for every present family', async () => {
  const controller = setup({}, [entry('files'), entry('', 'mcp_search', { connectionId: 'mcp:github', serverName: 'GitHub', sourceKind: 'mcp' }),
    entry('web', 'fetch_url', { available: false }), { name: 'ask_user' }]);
  await controller.setToggle('mcp:github', false);
  assert.deepEqual(controller.getToggleStates(), { families: {}, connections: { 'mcp:github': false } });
  assert.deepEqual(countRows(controller.getViewModel()), { on: 1, off: 1, total: 3 });
  assert.equal(controller.getViewModel().connections[0].label, 'GitHub');
});

test('connection rows carry their member tools and approvals; countRows counts usable rows only', () => {
  const controller = setup({}, [entry('files'), entry('web', 'fetch_url', { available: false }),
    entry('', 'create_issue', { connectionId: 'mcp:github', serverName: 'GitHub', approvalDefault: 'ask' }),
    entry('', 'list_pulls', { connectionId: 'mcp:github', serverName: 'GitHub' })]);
  const github = controller.getViewModel().connections[0];
  assert.deepEqual(github.members.map((member) => [member.name, member.asksFirst]), [['create_issue', true], ['list_pulls', false]]);
  assert.equal(github.approval, 'some');
  assert.deepEqual(countRows(controller.getViewModel()), { on: 2, off: 0, total: 3 }, 'blocked Web is neither on nor off');
  assert.deepEqual(countRows({}), { on: 0, off: 0, total: 0 });
});

test('view model reports blocked and partially usable families, approvals and ignores retired plugin connections', () => {
  const controller = setup({}, [entry('files', 'read_file', { available: false, reason: 'No workspace' }),
    entry('files', 'edit_file', { approvalDefault: 'ask' }), entry('web', 'web_search', { available: false, reason: 'Offline' }),
    entry('', 'plugin_tool', { connectionId: 'plugin:publisher:calendar', sourceKind: 'plugin' })]);
  const vm = controller.getViewModel();
  const files = vm.sections[0].families[0];
  assert.equal(files.usable, 1);
  assert.equal(files.total, 2);
  assert.equal(files.approval, 'some');
  assert.deepEqual(files.members[0], { name: 'read_file', usable: false, reason: 'No workspace', asksFirst: false });
  assert.equal(vm.sections[2].families[0].state, 'blocked');
  assert.equal(vm.sections[2].families[0].reason, 'Offline');
  assert.equal(vm.connections.length, 0, 'a retired plugin: connection id no longer forms a connection row');
});

test('settings defaults yield to chat overrides and hydrateForSession clears both previous maps', () => {
  const controller = setup({}, [entry('terminal'), entry('', 'remote', { connectionId: 'mcp:github' })]);
  const terminalOn = () => controller.getViewModel().sections[0].families[0].on;
  controller.hydrateFromToolSettings({ bash: false });
  assert.equal(terminalOn(), false);
  assert.deepEqual(controller.getToggleStates(), { families: {}, connections: {} }, 'Settings defaults stay out of the send payload');
  assert.equal(controller.getViewModel().hasOverrides, false);
  controller.hydrateForSession('a', { terminal: true }, { 'mcp:github': false });
  assert.equal(terminalOn(), true);
  assert.equal(controller.getViewModel().sections[0].families[0].overridden, true);
  controller.hydrateForSession('b', {}, {});
  assert.deepEqual(controller.getToggleStates(), { families: {}, connections: {} });
  assert.equal(terminalOn(), false);
  assert.equal(controller.getViewModel().hasOverrides, false);
  controller.hydrateFromToolSettings({ bash: 'no' });
  assert.equal(terminalOn(), true);
});

test('serialized writes persist both full maps to the captured session', async () => {
  const first = deferred();
  const calls = [];
  const controller = setup({ persistSessionToolPreference: (preferences, id) => {
    calls.push([preferences, id]); return calls.length === 1 ? first.promise : Promise.resolve();
  } }, [entry('files'), entry('', 'remote', { connectionId: 'mcp:github' })]);
  const a = controller.setToggle('files', false);
  const b = controller.setToggle('mcp:github', false);
  assert.equal(controller.getToggleStates().connections['mcp:github'], false);
  await new Promise(setImmediate);
  assert.deepEqual(calls, [[maps({ files: false }), 'a']]);
  first.resolve();
  assert.equal(await a, true);
  assert.equal(await b, true);
  assert.deepEqual(calls[1], [maps({ files: false }, { 'mcp:github': false }), 'a']);
});

test('a rejected sibling write is excluded from later full-map requests', async () => {
  const first = deferred();
  const calls = [], errors = [];
  const controller = setup({ persistSessionToolPreference: (preferences) => {
    calls.push(preferences); return calls.length === 1 ? first.promise : Promise.resolve();
  }, onPersistError: (error, id) => errors.push([error.message, id]) });
  const a = controller.setToggle('files', false), b = controller.setToggle('terminal', false);
  first.reject(new Error('ipc down'));
  assert.equal(await a, false);
  assert.equal(await b, true);
  assert.deepEqual(calls[1], maps({ terminal: false }));
  assert.equal(Object.hasOwn(controller.getToggleStates().families, 'files'), false);
  assert.deepEqual(errors, [['ipc down', 'files']]);
});

test('a later rejected revision rolls back to the acknowledged value and source', async () => {
  let writes = 0;
  const controller = setup({ persistSessionToolPreference: async () => { if (++writes > 1) throw new Error('rejected'); } });
  assert.equal(await controller.setToggle('files', false), true);
  assert.equal(await controller.setToggle('files', true), false);
  assert.equal(controller.getToggleStates().families.files, false);
  assert.equal(controller.getViewModel().sections[0].families[0].overridden, true);
});

test('reset persists empty maps and rolls back on rejection', async () => {
  const calls = [];
  let reject = true;
  const controller = setup({ persistSessionToolPreference: async (preferences, sessionId) => {
    calls.push([preferences, sessionId]); if (reject) throw new Error('rejected');
  } });
  controller.hydrateForSession('a', { files: false }, { 'mcp:github': false });
  const reset = controller.resetToDefaults();
  assert.equal(controller.getViewModel().hasOverrides, false);
  assert.equal(await reset, false);
  assert.equal(controller.getToggleStates().families.files, false);
  assert.equal(controller.getViewModel().hasOverrides, true);
  reject = false;
  assert.equal(await controller.resetToDefaults(), true);
  assert.deepEqual(calls, [[maps(), 'a'], [maps(), 'a']]);
  assert.equal(controller.getViewModel().hasOverrides, false);
});

test('old-session failures cannot mutate a newly hydrated session', async () => {
  const write = deferred(), errors = [];
  const state = { currentSessionId: 'a' };
  const controller = setup({ state, persistSessionToolPreference: () => write.promise,
    onPersistError: (error, id, details) => errors.push(details.isCurrent) });
  const pending = controller.setToggle('files', false);
  state.currentSessionId = 'b';
  controller.hydrateForSession('b', { files: false }, {});
  write.reject(new Error('old request'));
  assert.equal(await pending, false);
  assert.equal(controller.getToggleStates().families.files, false);
  assert.deepEqual(errors, [false]);
});

test('lockdown blocks denied switches while permitting local families and mixed groups', async () => {
  const state = { currentSessionId: 'a', features: { featureFlags: { session_offline_lockdown: true } }, sessions: [{ id: 'a', lockdown: true }] };
  const controller = setup({ state }, [entry('files'), entry('web', 'web_search', { lockdownAvailable: false }),
    entry('checks', 'verify', { lockdownAvailable: false }), entry('checks', 'preview_test')]);
  assert.equal(await controller.setToggle('web', false), false);
  assert.equal(await controller.setToggle('files', false), true);
  assert.equal(await controller.setToggle('checks', false), true);
  assert.equal(controller.getViewModel().sections[2].families[0].state, 'blocked');
  assert.equal(controller.getViewModel().sections[0].families[1].usable, 1);
  state.sessions[0].lockdown = false;
  assert.equal(await controller.setToggle('web', false), true);
});

test('model preserves legacy exports, safely normalizes metadata, and translates families at call time', (t) => {
  assert.deepEqual(model.TOOL_TOGGLE_CATEGORIES.map((category) => category.id), ['web_search', 'Bash', 'python_execute', 'file_tools']);
  assert.equal(model.TOOL_CATEGORY_CONFIG_KEYS.Bash, 'bash');
  assert.equal(model.TOOL_CATEGORY_SESSION_KEYS.file_tools, 'files');
  assert.ok(Object.isFrozen(model.SURFACE_FAMILY_UI));
  assert.deepEqual(model.SURFACE_FAMILY_UI.map((family) => family.id), ['files', 'terminal', 'git', 'python', 'code', 'checks', 'artifacts', 'images', 'web', 'browser_use', 'knowledge', 'home', 'helpers']);
  assert.equal(model.normalizeToolEntry({ name: 'read_file', connectionId: {}, lockdownAvailable: 'yes' }).connectionId, '');
  assert.equal(model.normalizeToolEntry('read_file').lockdownAvailable, false);
  const prior = global.jennyI18n;
  t.after(() => { global.jennyI18n = prior; });
  global.jennyI18n = { t: (key) => key };
  assert.equal(model.familyLabel('files'), 'composer.toolFamily.files.label');
  assert.equal(model.familyDescription('files'), 'composer.toolFamily.files.description');
});

test('RED regression: a same-chat summary refresh mid-flight keeps queued writes in the next full map', async () => {
  const first = deferred(), second = deferred();
  const calls = [];
  const controller = setup({ persistSessionToolPreference: (preferences) => {
    calls.push(preferences);
    return calls.length === 1 ? first.promise : calls.length === 2 ? second.promise : Promise.resolve();
  } });
  const web = controller.setToggle('web', false);
  const terminal = controller.setToggle('terminal', false);
  first.resolve();
  await web;
  // The first save's echo replaces the summary maps while Terminal is still saving.
  controller.hydrateForSession('a', { web: false }, {});
  assert.deepEqual(controller.getToggleStates().families, { web: false, terminal: false });
  const files = controller.setToggle('files', false);
  second.resolve();
  await terminal; await files;
  assert.deepEqual(calls.at(-1), maps({ web: false, terminal: false, files: false }));
  // Once the queue drains, a later refresh adopts the stored maps.
  controller.hydrateForSession('a', { web: false }, {});
  assert.deepEqual(controller.getToggleStates().families, { web: false });
});

test('RED regression: legacy Files off keeps Artifacts off and unlisted connections still reach the send', () => {
  const controller = setup({}, [entry('files'), entry('artifacts', 'create_artifact')]);
  controller.hydrateForSession('b', { files: false }, { 'mcp:late': false });
  assert.deepEqual(controller.getToggleStates(), { families: { files: false }, connections: { 'mcp:late': false } });
  const rows = controller.getViewModel().sections.flatMap((section) => section.families);
  assert.equal(rows.find((row) => row.id === 'artifacts').on, false);
  const { resolveRequestToolPreferences } = require('../services/tools/tool-surface-families');
  const resolved = resolveRequestToolPreferences(controller.getToggleStates(), {
    mcp__late__search: { source_kind: 'mcp', server_name: 'late' } });
  assert.ok(resolved.disabled_tools.includes('create_artifact'));
  assert.ok(resolved.disabled_tools.includes('mcp__late__search'));
});

test('the Browser row starts off, stays off under any setting, and only a real choice turns it on', async () => {
  const controller = setup({}, [entry('files'), entry('browser_use', 'browser')]);
  controller.hydrateFromToolSettings({ bash: true });
  const browserRow = () => controller.getViewModel().sections.flatMap((section) => section.families).find((row) => row.id === 'browser_use');
  assert.equal(browserRow().on, false);
  assert.equal(browserRow().state, 'off');
  assert.deepEqual(controller.getToggleStates(), { families: {}, connections: {} }, 'the resolver owns the default');
  await controller.setToggle('browser_use', true);
  assert.equal(browserRow().on, true);
  assert.deepEqual(controller.getToggleStates().families, { browser_use: true });
});

test('a default-off row left alone is not counted as something this chat turned off', async () => {
  const controller = setup({}, [entry('files'), entry('terminal'), entry('browser_use', 'browser')]);
  assert.deepEqual(countRows(controller.getViewModel()), { on: 2, off: 0, total: 3 });
  await controller.setToggle('browser_use', true);
  await controller.setToggle('browser_use', false);
  assert.deepEqual(countRows(controller.getViewModel()), { on: 2, off: 1, total: 3 }, 'switched off by hand it counts');
});

function browserSetup({ persist = async () => {}, remember = async () => {}, remembered = false, state } = {}) {
  const writes = [];
  const controller = setup({ state, persistSessionToolPreference: persist,
    readBrowserDefault: () => remembered,
    persistBrowserDefault: (enabled) => { writes.push(enabled); return remember(enabled); } },
  [entry('files'), entry('browser_use', 'browser_navigate')]);
  return { controller, writes };
}
const browserRow = (controller) => controller.getViewModel().sections.flatMap((section) => section.families).find((row) => row.id === 'browser_use');

test('the Browser row remembers on, off and reset, after the chat write lands', async () => {
  const { controller, writes } = browserSetup();
  assert.equal(await controller.setToggle('browser_use', true), true);
  assert.deepEqual(writes, [true]);
  assert.equal(await controller.setToggle('browser_use', false), true);
  assert.deepEqual(writes, [true, false]);
  await controller.setToggle('browser_use', true);
  assert.equal(await controller.resetToDefaults(), true);
  assert.deepEqual(writes, [true, false, true, false]);
});

test('other rows and a refused chat write never touch the remembered choice', async () => {
  const quiet = browserSetup();
  await quiet.controller.setToggle('files', false);
  assert.deepEqual(quiet.writes, []);
  const refused = browserSetup({ persist: async () => { throw new Error('rejected'); } });
  assert.equal(await refused.controller.setToggle('browser_use', true), false);
  assert.deepEqual(refused.writes, []);
});

test('a failed remember write does not fail the chat toggle', async () => {
  const { controller, writes } = browserSetup({ remember: async () => { throw new Error('disk full'); } });
  assert.equal(await controller.setToggle('browser_use', true), true);
  assert.deepEqual(writes, [true]);
  assert.equal(browserRow(controller).on, true);
});

test('offline lockdown refuses the row before it can remember anything', async () => {
  const state = { currentSessionId: 'a', features: { featureFlags: { session_offline_lockdown: true } }, sessions: [{ id: 'a', lockdown: true }] };
  const writes = [];
  const controller = setup({ state, persistSessionToolPreference: async () => {}, persistBrowserDefault: (enabled) => writes.push(enabled) },
    [entry('browser_use', 'browser_navigate', { lockdownAvailable: false })]);
  assert.equal(await controller.setToggle('browser_use', true), false);
  assert.deepEqual(writes, []);
});

test('a chat with no saved record yet shows and sends the remembered choice', async () => {
  const draft = browserSetup({ remembered: true, state: { currentSessionId: '' } });
  await new Promise(setImmediate);
  assert.equal(browserRow(draft.controller).on, true);
  assert.equal(browserRow(draft.controller).overridden, false, 'nothing to reset on the row');
  assert.deepEqual(draft.controller.getToggleStates().families, { browser_use: true });
  assert.equal(draft.controller.getViewModel().hasOverrides, false);
  for (const flag of ['local_draft', 'optimistic_local']) {
    const local = browserSetup({ remembered: true, state: { currentSessionId: 'd', sessions: [{ id: 'd', [flag]: true }] } });
    await new Promise(setImmediate);
    assert.deepEqual(local.controller.getToggleStates().families, { browser_use: true }, flag);
  }
});

test('a saved chat follows only its own switches, and a remembered off adds nothing', async () => {
  const saved = browserSetup({ remembered: true, state: { currentSessionId: 'a', sessions: [{ id: 'a' }] } });
  await new Promise(setImmediate);
  assert.equal(browserRow(saved.controller).on, false);
  assert.deepEqual(saved.controller.getToggleStates().families, {});
  const off = browserSetup({ remembered: false, state: { currentSessionId: '' } });
  await new Promise(setImmediate);
  assert.equal(browserRow(off.controller).on, false);
  assert.deepEqual(off.controller.getToggleStates().families, {});
});
