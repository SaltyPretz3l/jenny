const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createComposerV2ToggleController } = require('../renderer/chat/renderer-composer-v2-toggle');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');
const inventory = {
  toggleSwitch: require('../renderer/inventory/toggle-switch').toggleSwitch,
  chip: require('../renderer/inventory/chip'),
  popover: require('../renderer/inventory/popover'),
  actionButton: require('../renderer/inventory/action-button'),
};

const PANEL = `<span id="composerChatChipHost"></span>
<div class="inv-popover composer-chat-panel" id="composerChatPanel" data-inv-popover="composer-chat" hidden>
  <div data-chat-panel-view="main"><button data-chat-panel-action="all-tools">All tools ?</button>
    <div id="composerChatPanelChips"></div><div id="composerProjectPillSlot"></div>
    <button data-chat-panel-action="reset" hidden>Reset to defaults</button><button data-chat-panel-action="settings">Full settings</button></div>
  <div data-chat-panel-view="all" hidden><button data-chat-panel-action="back">? All tools</button>
    <input type="search" data-chat-panel-filter hidden><div id="composerChatPanelList"></div></div>
</div>`;

test('render rehydrates session B after session A disabled files', async (t) => {
  const dom = new JSDOM('<div id="composerToolToggleSlot">' + PANEL + '</div>');
  t.after(() => dom.window.close());
  dom.window.inventory = inventory;
  const previous = global.inventory;
  global.inventory = inventory;
  t.after(() => { global.inventory = previous; });
  const state = { currentSessionId: 'a', features: { tools: {} }, sessions: [
    { id: 'a', tool_category_overrides: { files: false }, tool_connection_overrides: {} },
    { id: 'b', tool_category_overrides: {}, tool_connection_overrides: {} },
  ] };
  const controller = createComposerV2ToggleController({ state });
  dom.window.jennyShell = { tools: { list: async () => [{ name: 'read_file', surfaceFamily: 'files', lockdownAvailable: true }] } };
  const shell = createShellRuntimeController({ state, windowRef: dom.window,
    dom: { composerToolToggleSlot: dom.window.document.getElementById('composerToolToggleSlot') },
    modules: { composerToggleModule: controller },
  });
  await shell.refreshComposerToolToggles();
  assert.equal(controller.getToggleStates().families.files, false);
  state.currentSessionId = 'b';
  shell.renderComposerEnhancements();
  assert.deepEqual(controller.getToggleStates(), { families: {}, connections: {} });
});

const { createComposerToolsSlot, extractToolEntries } = require('../renderer/chat/renderer-composer-tools-slot');
function setup(t, persistence = async () => {}) {
  const dom = new JSDOM('<div id="slot">' + PANEL + '</div>');
  t.after(() => dom.window.close());
  dom.window.inventory = inventory;
  const state = { currentSessionId: 'a', features: { tools: {} }, sessions: [{ id: 'a', tool_category_overrides: {}, tool_connection_overrides: {} }] };
  const controller = createComposerV2ToggleController({ state, persistSessionToolPreference: persistence });
  const entries = [{ name: 'read_file', surfaceFamily: 'files', available: true, lockdownAvailable: true },
    { name: 'remote', connectionId: 'mcp:github', sourceKind: 'mcp', serverName: 'GitHub', available: true, lockdownAvailable: false }];
  dom.window.jennyShell = { tools: { list: async () => entries } };
  const slot = dom.window.document.getElementById('slot');
  const tools = createComposerToolsSlot({ state, windowRef: dom.window, slot, controller });
  return { dom, state, controller, slot, tools };
}

test('identical renders retain nodes; toggles patch in place without losing focus', async (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files', lockdownAvailable: true }]);
  tools.render();
  const nodes = [...slot.querySelectorAll('*')];
  tools.render();
  assert.deepEqual([...slot.querySelectorAll('*')], nodes);
  const track = slot.querySelector('[data-inv-toggle="tool-target:files"]');
  track.focus();
  await tools.handleToggleChange({ detail: { id: 'tool-target:files', checked: false } });
  assert.equal(track.isConnected, true);
  assert.equal(dom.window.document.activeElement, track);
  assert.equal(track.getAttribute('aria-checked'), 'false');
  assert.equal(slot.querySelector('.inv-chip-label').textContent, '0 tools');
  assert.equal(slot.querySelector('[data-chat-panel-action="reset"]').hidden, false);
});

test('refresh preserves IPC metadata and changed summary identities rehydrate without another IPC call', async (t) => {
  const { state, controller, slot, tools } = setup(t);
  await tools.refresh();
  assert.ok(slot.querySelector('[data-inv-toggle="tool-target:mcp:github"]'));
  state.sessions[0].tool_connection_overrides = { 'mcp:github': false };
  state.sessions[0].tool_category_overrides = { files: false };
  tools.render();
  assert.deepEqual(tools.getToolPreferences(), { families: { files: false }, connections: { 'mcp:github': false } });
  assert.equal(controller.getViewModel().connections[0].label, 'GitHub');
  state.sessions[0].tool_category_overrides = {};
  state.sessions[0].tool_connection_overrides = {};
  tools.render();
  assert.deepEqual(tools.getToolPreferences(), { families: {}, connections: {} });
  const metadata = extractToolEntries([{ name: 'read_file', surfaceFamily: 'files', approvalDefault: 'ask', lockdownAvailable: true,
    connectionId: 'mcp:github', serverName: 'GitHub', sourceKind: 'mcp', available: false, reason: 'missing' }])[0];
  assert.deepEqual(metadata, { name: 'read_file', surfaceFamily: 'files', approvalDefault: 'ask', lockdownAvailable: true,
    connectionId: 'mcp:github', serverName: 'GitHub', sourceKind: 'mcp', toolFamily: '', sideEffecting: false, available: false, reason: 'missing' });
});

test('rollback patches a focused switch and its source copy in place', async (t) => {
  const { dom, slot, tools } = setup(t, async () => { throw new Error('rejected'); });
  await tools.refresh();
  const track = slot.querySelector('[data-inv-toggle="tool-target:files"]');
  track.focus();
  assert.equal(await tools.handleToggleChange({ detail: { id: 'tool-target:files', checked: false } }), false);
  await Promise.resolve();
  assert.equal(dom.window.document.activeElement, track);
  assert.equal(track.getAttribute('aria-checked'), 'true');
  assert.equal(slot.querySelector('[data-chat-panel-action="reset"]').hidden, true);
  assert.equal(slot.querySelector('.inv-chip-label').textContent, '2 tools');
});

function bindPanel(dom, slot, tools, openSettingsSection) {
  const { bindInteractiveComposerEvents } = require('../renderer/chat/renderer-chat-event-interactive-bindings');
  bindInteractiveComposerEvents({ composerWrap: slot, interactiveDelegateRoot: dom.window.document.createElement('div'),
    registerListener: (el, type, handler, opts) => el.addEventListener(type, handler, opts),
    handleComposerToggleChange: tools.handleToggleChange, openSettingsSection });
  require('../renderer/inventory/toggle-switch').initToggleHandlers(dom.window.document);
  inventory.popover.initPopoverHandlers(dom.window.document);
}

test('chips cover present families and connections; blocked chip drills in without changing preferences', async (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files', available: false, reason: 'workspace requirement missing' },
    { name: 'remote', connectionId: 'mcp:github', serverName: 'GitHub' }]);
  const calls = [];
  controller.setToggle = (...args) => { calls.push(args); return Promise.resolve(); };
  tools.render(); bindPanel(dom, slot, tools);
  const chips = [...slot.querySelectorAll('.composer-family-chip')];
  assert.deepEqual(chips.map((chip) => chip.dataset.toolTarget), ['files', 'mcp:github']);
  const blocked = chips[0];
  assert.equal(blocked.hasAttribute('aria-pressed'), false);
  assert.match(dom.window.document.getElementById(blocked.getAttribute('aria-describedby')).textContent, /Needs a project/);
  assert.equal(blocked.title, 'Needs a project');
  const row = slot.querySelector('.composer-tool-row[data-tool-target="files"]');
  let scrolled = false;
  row.scrollIntoView = () => { scrolled = true; };
  slot.querySelector('#composerToolsChip').click();
  blocked.click();
  assert.equal(slot.querySelector('[data-chat-panel-view="all"]').hidden, false);
  assert.equal(row.hidden, false);
  assert.equal(scrolled, true);
  assert.deepEqual(calls, []);
  row.querySelector('[data-tool-fix="project"]').click();
  assert.equal(slot.querySelector('[data-chat-panel-view="main"]').hidden, false);
  slot.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id: 'tool-target:mcp:github', checked: false } }));
  assert.deepEqual(calls, [['mcp:github', false]]);
});

test('arrows rove chips; Escape backs out first, then closes and restores trigger focus', async (t) => {
  const { dom, slot, tools } = setup(t);
  await tools.refresh(); bindPanel(dom, slot, tools);
  const key = (value) => dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true }));
  const chip = slot.querySelector('#composerToolsChip');
  const families = [...slot.querySelectorAll('.composer-family-chip')];
  chip.click();
  assert.equal(dom.window.document.activeElement, families[0]);
  for (const value of ['ArrowRight', 'ArrowDown']) {
    key(value);
    assert.equal(dom.window.document.activeElement, families[value === 'ArrowRight' ? 1 : 0]);
  }
  key('End'); assert.equal(dom.window.document.activeElement, families[1]);
  key('Home'); assert.equal(dom.window.document.activeElement, families[0]);
  key('ArrowLeft'); assert.equal(dom.window.document.activeElement, families[1]);
  key('ArrowUp'); assert.equal(dom.window.document.activeElement, families[0]);
  assert.deepEqual(families.map((node) => node.tabIndex), [0, -1]);
  slot.querySelector('[data-chat-panel-action="all-tools"]').click();
  assert.equal(dom.window.document.activeElement.dataset.chatPanelAction, 'back');
  key('Escape');
  assert.equal(slot.querySelector('#composerChatPanel').hidden, false);
  assert.equal(slot.querySelector('[data-chat-panel-view="main"]').hidden, false);
  assert.equal(dom.window.document.activeElement.dataset.chatPanelAction, 'all-tools');
  key('Escape');
  assert.equal(slot.querySelector('#composerChatPanel').hidden, true);
  assert.equal(dom.window.document.activeElement, chip);
});

test('reset visibility follows overrides and reset restores defaults', async (t) => {
  const { slot, dom, tools } = setup(t);
  await tools.refresh(); bindPanel(dom, slot, tools);
  const reset = slot.querySelector('[data-chat-panel-action="reset"]');
  assert.equal(reset.hidden, true);
  slot.querySelector('.composer-family-chip').click();
  await Promise.resolve();
  assert.equal(reset.hidden, false);
  reset.focus();
  reset.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reset.hidden, true);
  assert.equal(slot.querySelector('.composer-family-chip').getAttribute('aria-pressed'), 'true');
  assert.equal(dom.window.document.activeElement, slot.querySelector('.composer-family-chip'), 'focus lands on the chips, not the body');
});

test('All tools filter matches member names and hides empty sections, retaining focused input', (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'special_member', surfaceFamily: 'files', available: true, approvalDefault: 'ask' },
    { name: 'edit_file', surfaceFamily: 'files', available: false, reason: 'config disabled' },
    ...Array.from({ length: 12 }, (_, index) => ({ name: 'remote_' + index, connectionId: 'mcp:server' + index }))]);
  tools.render(); bindPanel(dom, slot, tools);
  const files = slot.querySelector('.composer-tool-row[data-tool-target="files"]');
  assert.match(files.querySelector('.inv-toggle-description').textContent, /Some actions ask first/);
  assert.equal(files.querySelector('.composer-tool-partial').textContent, '1 of 2 available');
  assert.equal(files.querySelector('[data-tool-fix]').dataset.toolFix, 'settings');
  files.querySelector('[data-chat-panel-expand]').click();
  assert.equal(files.querySelector('.composer-tool-members').hidden, false);
  assert.match(files.querySelector('.composer-tool-members').textContent, /special_member · asks first/);
  const input = slot.querySelector('[data-chat-panel-filter]');
  assert.equal(input.hidden, false);
  input.focus(); input.value = 'SPECIAL_MEMBER';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(files.hidden, false);
  assert.ok([...slot.querySelectorAll('.composer-tool-row')].slice(1).every((node) => node.hidden));
  assert.equal(slot.querySelectorAll('#composerChatPanelList section')[1].hidden, true);
  assert.equal(dom.window.document.activeElement, input);
  input.value = ''; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const mode = dom.window.document.createElement('button');
  mode.id = 'composerRunModeChip'; mode.className = 'composer-run-mode-auto'; slot.before(mode);
  tools.render();
  assert.ok(!files.querySelector('.inv-toggle-description').textContent.includes('Some actions ask first'));
});

test('inventory refresh keeps focused controls connected and removes obsolete controls on blur', (t) => {
  const { controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files' }]); tools.render();
  const track = slot.querySelector('[data-inv-toggle]'); track.focus();
  controller.setAvailableTools([{ name: 'web_search', surfaceFamily: 'web' }]); tools.render();
  assert.equal(track.isConnected, true);
  track.blur(); tools.render();
  assert.equal(track.isConnected, false);
});

test('the mounted panel label changes its family preference exactly once', async (t) => {
  const { dom, slot, tools, controller } = setup(t);
  await tools.refresh(); bindPanel(dom, slot, tools);
  const calls = [];
  const setToggle = controller.setToggle;
  controller.setToggle = (...args) => { calls.push(args); return setToggle(...args); };
  slot.querySelector('#composerToolsChip').click();
  slot.querySelector('[data-chat-panel-action="all-tools"]').click();
  slot.querySelector('.composer-tool-row .inv-toggle-label').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['files', false]]);
  assert.equal(slot.querySelector('[data-inv-toggle]').getAttribute('aria-checked'), 'false');
});

test('inventory refresh retains registry order in chips and drill-in sections', (t) => {
  const { slot, tools, controller } = setup(t);
  controller.setAvailableTools([{ name: 'web_search', surfaceFamily: 'web' }, { name: 'git_status', surfaceFamily: 'git' }]); tools.render();
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files' }, { name: 'web_search', surfaceFamily: 'web' }, { name: 'git_status', surfaceFamily: 'git' }]); tools.render();
  assert.deepEqual([...slot.querySelectorAll('.composer-family-chip')].map((node) => node.dataset.toolTarget), ['files', 'git', 'web']);
  assert.deepEqual([...slot.querySelectorAll('.composer-tool-row')].map((node) => node.dataset.toolTarget), ['files', 'git', 'web']);
});

test('a Settings-off family offers Turn on, which opens the Settings tools section', (t) => {
  const { dom, slot, tools, controller } = setup(t);
  const navigations = [];
  controller.setAvailableTools([{ name: 'image_generate', surfaceFamily: 'images', available: false, reason: 'config disabled' },
    { name: 'run_command', surfaceFamily: 'terminal', available: false, reason: 'model/runtime does not support tool calling' }]);
  tools.render(); bindPanel(dom, slot, tools, (...args) => navigations.push(args));
  const terminal = slot.querySelector('.composer-tool-row[data-tool-target="terminal"]');
  assert.equal(terminal.querySelector('[data-tool-fix]').hidden, true, 'other reasons show as sent, with no fix');
  assert.match(terminal.querySelector('.composer-tool-reason').textContent, /does not support tool calling/);
  slot.querySelector('#composerToolsChip').click();
  slot.querySelector('.composer-family-chip').click();
  const fix = slot.querySelector('.composer-tool-row[data-tool-target="images"] [data-tool-fix="settings"]');
  assert.equal(fix.hidden, false);
  fix.click();
  assert.deepEqual(navigations, [['tools', { source: 'composer_chat_panel' }]]);
  assert.equal(slot.querySelector('#composerChatPanel').hidden, true);
});

test('Full settings closes the panel and opens the Settings tools section', (t) => {
  const { dom, slot, tools, controller } = setup(t);
  const navigations = [];
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files' }]);
  tools.render(); bindPanel(dom, slot, tools, (...args) => navigations.push(args));
  slot.querySelector('#composerToolsChip').click();
  slot.querySelector('[data-chat-panel-action="settings"]').click();
  assert.deepEqual(navigations, [['tools', { source: 'composer_chat_panel' }]]);
  assert.equal(slot.querySelector('#composerChatPanel').hidden, true);
});

test('a session switch closes the open panel back on its main view', (t) => {
  const { dom, state, slot, tools, controller } = setup(t);
  state.sessions.push({ id: 'b', tool_category_overrides: {}, tool_connection_overrides: {} });
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files' }]);
  tools.render(); bindPanel(dom, slot, tools);
  slot.querySelector('#composerToolsChip').click();
  slot.querySelector('[data-chat-panel-action="all-tools"]').click();
  const panel = slot.querySelector('#composerChatPanel');
  assert.equal(panel.hidden, false);
  state.currentSessionId = 'b';
  tools.render();
  assert.equal(panel.hidden, true);
  assert.equal(panel.querySelector('[data-chat-panel-view="main"]').hidden, false);
  assert.equal(panel.querySelector('[data-chat-panel-view="all"]').hidden, true);
});
