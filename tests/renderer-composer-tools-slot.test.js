const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createComposerV2ToggleController } = require('../renderer/chat/renderer-composer-v2-toggle');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');
const inventory = {
  // Helpers attached as renderer/inventory/index.js does in the app.
  toggleSwitch: (({ toggleSwitch, setChecked, setDisabled }) => Object.assign(toggleSwitch, { setChecked, setDisabled }))(require('../renderer/inventory/toggle-switch')),
  chip: require('../renderer/inventory/chip'),
  popover: require('../renderer/inventory/popover'),
  actionButton: require('../renderer/inventory/action-button'),
};

const PANEL = `<span id="composerChatChipHost"></span>
<div class="inv-popover composer-chat-panel" id="composerChatPanel" data-inv-popover="composer-chat" role="dialog" aria-modal="false" aria-labelledby="composerChatPanelTitle" hidden>
  <div class="composer-chat-panel-head"><span class="composer-chat-panel-title" id="composerChatPanelTitle">Tools for this chat</span><span class="composer-chat-panel-tally" data-chat-panel-tally></span></div>
  <div class="composer-chat-panel-row composer-chat-posture" id="composerChatPosture" hidden><span class="status-dot" id="composerChatPostureDot" aria-hidden="true"></span><span id="composerChatPostureText"></span></div>
  <input type="search" class="composer-chat-filter" data-chat-panel-filter hidden placeholder="Find a tool" aria-label="Find a tool">
  <div class="composer-chat-list" id="composerChatPanelList"><p class="composer-chat-empty" data-chat-panel-empty hidden></p><p class="composer-chat-always-on">Always on: questions, to-dos, plan, status, skills</p></div>
  <div class="composer-chat-panel-foot"><button type="button" class="composer-chat-link" data-chat-panel-action="reset" hidden>Reset to defaults</button><button type="button" class="composer-chat-link" data-chat-panel-action="settings">Tool settings</button></div>
</div>
<div id="composerProjectPillSlot"></div>`;

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
const flush = () => new Promise((resolve) => setImmediate(resolve));
const chipLabel = (slot) => slot.querySelector('#composerToolsChip .inv-chip-label').textContent;
const chipCount = (slot) => slot.querySelector('#composerToolsChip .inv-chip-count')?.textContent;
const row = (slot, id) => slot.querySelector(`.composer-tool-row[data-tool-target="${id}"]`);
const track = (slot, id) => slot.querySelector(`[data-inv-toggle="tool-target:${id}"]`);
const type = (dom, input, value) => {
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
// Counts how often a toggle reaches the controller, so double-toggles are visible.
function spyToggles(controller) {
  const calls = [];
  const setToggle = controller.setToggle;
  controller.setToggle = (...args) => { calls.push(args); return setToggle(...args); };
  return calls;
}
const manyFamilies = [
  { name: 'read_file', surfaceFamily: 'files' }, { name: 'web_search', surfaceFamily: 'web' }, { name: 'git_status', surfaceFamily: 'git' },
  { name: 'image_generate', surfaceFamily: 'images' }, { name: 'run_command', surfaceFamily: 'terminal' },
  ...Array.from({ length: 4 }, (_, index) => ({ name: 'remote_' + index, connectionId: 'mcp:server' + index, sourceKind: 'mcp', serverName: 'Server ' + index })),
];

function bindPanel(dom, slot, tools, openSettingsSection) {
  const { bindInteractiveComposerEvents } = require('../renderer/chat/renderer-chat-event-interactive-bindings');
  bindInteractiveComposerEvents({ composerWrap: slot, interactiveDelegateRoot: dom.window.document.createElement('div'),
    registerListener: (el, type, handler, opts) => el.addEventListener(type, handler, opts),
    handleComposerToggleChange: tools.handleToggleChange, openSettingsSection });
  require('../renderer/inventory/toggle-switch').initToggleHandlers(dom.window.document);
  inventory.popover.initPopoverHandlers(dom.window.document);
}

test('identical renders retain nodes; toggles patch in place without losing focus', async (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files', lockdownAvailable: true }]);
  tools.render();
  const nodes = [...slot.querySelectorAll('*')];
  tools.render();
  assert.deepEqual([...slot.querySelectorAll('*')], nodes);
  const switchTrack = track(slot, 'files');
  switchTrack.focus();
  await tools.handleToggleChange({ detail: { id: 'tool-target:files', checked: false } });
  assert.equal(switchTrack.isConnected, true);
  assert.equal(dom.window.document.activeElement, switchTrack);
  assert.equal(switchTrack.getAttribute('aria-checked'), 'false');
  assert.equal(row(slot, 'files').dataset.on, 'false');
  assert.equal(chipCount(slot), '1 off');
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

test('rollback patches a focused switch in place', async (t) => {
  const { dom, slot, tools } = setup(t, async () => { throw new Error('rejected'); });
  await tools.refresh();
  const switchTrack = track(slot, 'files');
  switchTrack.focus();
  assert.equal(await tools.handleToggleChange({ detail: { id: 'tool-target:files', checked: false } }), false);
  await Promise.resolve();
  assert.equal(dom.window.document.activeElement, switchTrack);
  assert.equal(switchTrack.getAttribute('aria-checked'), 'true');
  assert.equal(slot.querySelector('[data-chat-panel-action="reset"]').hidden, true);
  assert.equal(chipCount(slot), undefined);
  assert.equal(slot.querySelector('[data-chat-panel-tally]').textContent, '2 of 2 on');
});

test('the bar chip reads Tools, shows an off count only with overrides, and reads Offline in lockdown', async (t) => {
  const { controller, slot, tools } = setup(t);
  await tools.refresh();
  const chip = slot.querySelector('#composerToolsChip');
  assert.equal(chipLabel(slot), 'Tools');
  assert.equal(chipCount(slot), undefined);
  assert.equal(chip.getAttribute('aria-label'), 'Tools for this chat: 2 of 2 on');
  assert.equal(chip.classList.contains('composer-tools-chip--off'), false);
  await tools.handleToggleChange({ detail: { id: 'tool-target:files', checked: false } });
  assert.equal(chipLabel(slot), 'Tools');
  assert.equal(chipCount(slot), '1 off');
  assert.equal(chip.classList.contains('composer-tools-chip--off'), true);
  assert.equal(chip.getAttribute('aria-label'), 'Tools for this chat: 1 of 2 on');
  await tools.handleToggleChange({ detail: { id: 'tool-target:files', checked: true } });
  assert.equal(chipCount(slot), undefined, 'a toggle back on leaves nothing off');
  await controller.resetToDefaults();
  assert.equal(chip.classList.contains('composer-tools-chip--off'), false);
});

test('lockdown shows Offline on the chip with no off count and prefixes the tally', async (t) => {
  const { state, controller, slot, tools } = setup(t);
  state.features = { featureFlags: { session_offline_lockdown: true } };
  state.sessions[0].lockdown = true;
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files', available: true, lockdownAvailable: true },
    { name: 'web_search', surfaceFamily: 'web', available: true, lockdownAvailable: false }]);
  await tools.handleToggleChange({ detail: { id: 'tool-target:files', checked: false } });
  assert.equal(chipLabel(slot), 'Offline');
  assert.equal(chipCount(slot), undefined);
  assert.equal(slot.querySelector('#composerToolsChip').classList.contains('composer-tools-chip--off'), false);
  assert.equal(slot.querySelector('[data-chat-panel-tally]').textContent, 'Offline · 0 of 2 on');
});

test('the head tally counts rows that are on and usable against every row', (t) => {
  const { controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files' }, { name: 'web_search', surfaceFamily: 'web' },
    { name: 'image_generate', surfaceFamily: 'images', available: false, reason: 'config disabled' }]);
  tools.render();
  assert.equal(slot.querySelector('[data-chat-panel-tally]').textContent, '2 of 3 on');
});

test('clicking a row flips it exactly once, as does clicking its switch; a blocked row does nothing', async (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files', available: true },
    { name: 'web_search', surfaceFamily: 'web', available: true },
    { name: 'image_generate', surfaceFamily: 'images', available: false, reason: 'config disabled' }]);
  const calls = spyToggles(controller);
  tools.render(); bindPanel(dom, slot, tools);
  row(slot, 'files').querySelector('.composer-tool-label').click();
  await flush();
  assert.deepEqual(calls, [['files', false]]);
  assert.equal(track(slot, 'files').getAttribute('aria-checked'), 'false');
  assert.equal(row(slot, 'files').dataset.on, 'false');
  track(slot, 'web').click();
  await flush();
  assert.deepEqual(calls, [['files', false], ['web', false]]);
  row(slot, 'images').querySelector('.composer-tool-label').click();
  row(slot, 'images').click();
  await flush();
  assert.equal(calls.length, 2, 'blocked rows never reach the controller');
  assert.equal(row(slot, 'images').dataset.blocked, 'true');
  assert.equal(track(slot, 'images').disabled, true);
});

test('the count button expands a row to its tools, marks asks first, and leaves the preference alone', async (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files', available: true },
    { name: 'special_member', surfaceFamily: 'files', available: true, approvalDefault: 'ask' }]);
  const calls = spyToggles(controller);
  tools.render(); bindPanel(dom, slot, tools);
  const files = row(slot, 'files');
  const count = files.querySelector('[data-chat-panel-members="files"]');
  const members = files.querySelector('.composer-tool-members');
  assert.equal(count.textContent, '2 tools');
  assert.equal(count.getAttribute('aria-label'), 'Show the tools in ' + files.querySelector('.composer-tool-label').textContent);
  assert.equal(count.getAttribute('aria-controls'), members.id);
  assert.equal(count.getAttribute('aria-expanded'), 'false');
  assert.equal(members.hidden, true);
  count.click();
  assert.equal(count.getAttribute('aria-expanded'), 'true');
  assert.equal(members.hidden, false);
  assert.deepEqual([...members.querySelectorAll('code')].map((node) => node.textContent), ['read_file', 'special_member']);
  assert.equal(members.querySelectorAll('.composer-tool-warn').length, 1);
  assert.match(members.textContent, /special_member asks first/);
  tools.render();
  assert.equal(members.hidden, false, 'a re-render keeps the expanded state');
  members.click();
  assert.equal(members.hidden, false, 'clicking the tool names does not collapse or toggle anything');
  count.click();
  assert.equal(count.getAttribute('aria-expanded'), 'false');
  assert.equal(members.hidden, true);
  assert.deepEqual(calls, []);
});

test('a single-tool row says "1 tool"', (t) => {
  const { controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'web_search', surfaceFamily: 'web' }]);
  tools.render();
  assert.equal(slot.querySelector('[data-chat-panel-members="web"]').textContent, '1 tool');
});

test('an MCP connection row reads "MCP server", expands to its tools, and is found by a member name', (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([...manyFamilies, { name: 'create_issue', connectionId: 'mcp:github', sourceKind: 'mcp', serverName: 'GitHub' }]);
  tools.render(); bindPanel(dom, slot, tools);
  const github = row(slot, 'mcp:github');
  assert.equal(github.querySelector('.composer-tool-sub').textContent, 'MCP server');
  assert.equal(github.querySelector('.composer-tool-icon svg').getAttribute('viewBox'), '0 0 16 16');
  github.querySelector('[data-chat-panel-members]').click();
  assert.match(github.querySelector('.composer-tool-members').textContent, /create_issue/);
  const input = slot.querySelector('[data-chat-panel-filter]');
  github.querySelector('[data-chat-panel-members]').click();
  type(dom, input, 'create_issue');
  assert.equal(github.hidden, false);
  assert.equal(row(slot, 'files').hidden, true);
  assert.equal(github.querySelector('.composer-tool-members').hidden, false, 'a member-only match shows the tools');
});

test('the search appears from eight rows and is cleared when it hides', (t) => {
  const { dom, controller, slot, tools } = setup(t);
  const input = slot.querySelector('[data-chat-panel-filter]');
  controller.setAvailableTools(manyFamilies.slice(0, 8)); tools.render(); bindPanel(dom, slot, tools);
  assert.equal(input.hidden, false);
  type(dom, input, 'file');
  assert.equal(row(slot, 'web').hidden, true);
  controller.setAvailableTools(manyFamilies.slice(0, 7)); tools.render();
  assert.equal(input.hidden, true);
  assert.equal(input.value, '');
  assert.ok([...slot.querySelectorAll('.composer-tool-row')].every((node) => !node.hidden), 'rows return when the query is dropped');
});

test('a member-only match shows the members while the query stands, then restores the expanded state', (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'special_member', surfaceFamily: 'files' }, { name: 'edit_file', surfaceFamily: 'files' }, ...manyFamilies.slice(1)]);
  tools.render(); bindPanel(dom, slot, tools);
  const files = row(slot, 'files');
  const members = files.querySelector('.composer-tool-members');
  const count = files.querySelector('[data-chat-panel-members]');
  assert.equal(members.hidden, true);
  const input = slot.querySelector('[data-chat-panel-filter]');
  type(dom, input, 'SPECIAL_member ');
  assert.equal(files.hidden, false);
  assert.equal(members.hidden, false);
  assert.equal(count.getAttribute('aria-expanded'), 'true');
  assert.ok([...slot.querySelectorAll('.composer-tool-row')].filter((node) => node !== files).every((node) => node.hidden));
  assert.equal(slot.querySelector('#composerChatPanelList section[hidden]') !== null, true, 'sections without a visible row hide');
  count.click();
  assert.equal(members.hidden, true, 'the count button collapses a row the search opened');
  assert.equal(count.getAttribute('aria-expanded'), 'false');
  count.click();
  assert.equal(members.hidden, false, 'and opens it again');
  count.click();
  type(dom, input, '');
  assert.equal(members.hidden, true, 'the persisted expanded state is untouched');
  assert.equal(count.getAttribute('aria-expanded'), 'false');
});

test('a label match does not open the members; filtering keeps the focused input', (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools(manyFamilies); tools.render();
  const input = slot.querySelector('[data-chat-panel-filter]');
  input.focus();
  type(dom, input, 'web');
  assert.equal(row(slot, 'web').querySelector('.composer-tool-members').hidden, true);
  assert.equal(dom.window.document.activeElement, input);
});

test('a query with no match shows the empty line, and clears away with the query', (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools(manyFamilies); tools.render(); bindPanel(dom, slot, tools);
  const empty = slot.querySelector('[data-chat-panel-empty]');
  const input = slot.querySelector('[data-chat-panel-filter]');
  assert.equal(empty.hidden, true);
  type(dom, input, ' zzz ');
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, 'No tool matches “zzz”.');
  assert.ok([...slot.querySelectorAll('#composerChatPanelList section')].every((node) => node.hidden));
  type(dom, input, '');
  assert.equal(empty.hidden, true);
});

test('a section whose rows are all blocked for one reason shows it once on the label', (t) => {
  const { dom, controller, slot, tools } = setup(t);
  const navigations = [];
  controller.setAvailableTools([
    { name: 'read_file', surfaceFamily: 'files', available: false, reason: 'workspace requirement missing' },
    { name: 'git_status', surfaceFamily: 'git', available: false, reason: 'workspace requirement missing' },
    { name: 'web_search', surfaceFamily: 'web', available: true }]);
  tools.render(); bindPanel(dom, slot, tools, (...args) => navigations.push(args));
  const label = slot.querySelector('#composerChatPanelList section .composer-chat-section-label');
  assert.match(label.textContent, /^In this project · Needs a project · Choose project$/);
  const fixes = slot.querySelectorAll('[data-tool-fix="project"]');
  assert.equal(fixes.length, 1, 'the reason and fix appear once for the section');
  assert.equal(label.contains(fixes[0]), true);
  assert.equal(fixes[0].textContent, 'Choose project');
  assert.equal(label.lastChild.previousSibling.textContent, ' · ', 'the separator sits outside the fix button');
  for (const id of ['files', 'git']) {
    const sub = row(slot, id).querySelector('.composer-tool-sub');
    assert.doesNotMatch(sub.textContent, /Needs a project/);
    assert.ok(sub.textContent.length > 0, 'rows keep their description');
  }
  let pillClicks = 0;
  const pill = dom.window.document.createElement('button');
  pill.addEventListener('click', () => { pillClicks += 1; });
  slot.querySelector('#composerProjectPillSlot').appendChild(pill);
  fixes[0].click();
  assert.equal(pillClicks, 1);
});

test('a lone blocked row names its reason on its own line; the separator is outside the fix button', (t) => {
  const { controller, slot, tools } = setup(t);
  controller.setAvailableTools([
    { name: 'read_file', surfaceFamily: 'files', available: false, reason: 'workspace requirement missing' },
    { name: 'web_search', surfaceFamily: 'web', available: true }]);
  tools.render();
  const sub = row(slot, 'files').querySelector('.composer-tool-sub');
  assert.equal(sub.textContent, 'Needs a project · Choose project');
  assert.equal(sub.querySelector('.composer-tool-warn').textContent, 'Needs a project');
  const fix = sub.querySelector('[data-tool-fix="project"]');
  assert.equal(fix.textContent, 'Choose project');
  assert.equal(fix.previousSibling.textContent, ' · ');
  assert.equal(slot.querySelector('#composerChatPanelList section .composer-chat-section-label').textContent, 'In this project');
});

test('a partly available row adds an amber "ready" count after its description', (t) => {
  const { controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files', available: true },
    { name: 'edit_file', surfaceFamily: 'files', available: false, reason: 'config disabled' }]);
  tools.render();
  const sub = row(slot, 'files').querySelector('.composer-tool-sub');
  assert.equal(sub.querySelector('.composer-tool-warn').textContent, '1 of 2 ready');
  assert.match(sub.textContent, / · 1 of 2 ready$/);
  assert.doesNotMatch(sub.textContent, /ask first/);
  assert.equal(row(slot, 'files').dataset.blocked, 'false');
});

test('inventory refresh keeps focused controls connected and removes obsolete controls on blur', (t) => {
  const { controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files' }]); tools.render();
  const switchTrack = slot.querySelector('[data-inv-toggle]'); switchTrack.focus();
  controller.setAvailableTools([{ name: 'web_search', surfaceFamily: 'web' }]); tools.render();
  assert.equal(switchTrack.isConnected, true);
  switchTrack.blur(); tools.render();
  assert.equal(switchTrack.isConnected, false);
});

test('inventory refresh retains registry order in the one list', (t) => {
  const { slot, tools, controller } = setup(t);
  controller.setAvailableTools([{ name: 'web_search', surfaceFamily: 'web' }, { name: 'git_status', surfaceFamily: 'git' }]); tools.render();
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files' }, { name: 'web_search', surfaceFamily: 'web' }, { name: 'git_status', surfaceFamily: 'git' }]); tools.render();
  assert.deepEqual([...slot.querySelectorAll('.composer-tool-row')].map((node) => node.dataset.toolTarget), ['files', 'git', 'web']);
  const list = slot.querySelector('#composerChatPanelList');
  assert.equal(list.lastElementChild.className, 'composer-chat-always-on', 'sections stay ahead of the trailing lines');
});

test('a Settings-off family offers Turn on, which opens the Settings tools section', (t) => {
  const { dom, slot, tools, controller } = setup(t);
  const navigations = [];
  controller.setAvailableTools([{ name: 'image_generate', surfaceFamily: 'images', available: false, reason: 'config disabled' },
    { name: 'run_command', surfaceFamily: 'terminal', available: false, reason: 'model/runtime does not support tool calling' }]);
  tools.render(); bindPanel(dom, slot, tools, (...args) => navigations.push(args));
  const terminal = row(slot, 'terminal');
  assert.equal(terminal.querySelector('[data-tool-fix]'), null, 'other reasons show as sent, with no fix');
  assert.match(terminal.querySelector('.composer-tool-sub').textContent, /does not support tool calling/);
  slot.querySelector('#composerToolsChip').click();
  const fix = row(slot, 'images').querySelector('[data-tool-fix="settings"]');
  assert.equal(fix.textContent, 'Turn on');
  fix.click();
  assert.deepEqual(navigations, [['tools', { source: 'composer_chat_panel' }]]);
  assert.equal(slot.querySelector('#composerChatPanel').hidden, true);
});

test('Tool settings closes the panel and opens the Settings tools section', (t) => {
  const { dom, slot, tools, controller } = setup(t);
  const navigations = [];
  controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files' }]);
  tools.render(); bindPanel(dom, slot, tools, (...args) => navigations.push(args));
  slot.querySelector('#composerToolsChip').click();
  slot.querySelector('[data-chat-panel-action="settings"]').click();
  assert.deepEqual(navigations, [['tools', { source: 'composer_chat_panel' }]]);
  assert.equal(slot.querySelector('#composerChatPanel').hidden, true);
});

test('arrow keys move focus between the search and the enabled switches, wrapping at the ends', (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([...manyFamilies.filter((entry) => entry.surfaceFamily !== 'images'),
    { name: 'image_generate', surfaceFamily: 'images', available: false, reason: 'config disabled' }]);
  tools.render(); bindPanel(dom, slot, tools);
  slot.querySelector('#composerToolsChip').click();
  const input = slot.querySelector('[data-chat-panel-filter]');
  const key = (value) => dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const enabled = [...slot.querySelectorAll('.composer-tool-row [data-inv-toggle]')].filter((node) => !node.disabled);
  const rowCount = slot.querySelectorAll('.composer-tool-row').length;
  assert.equal(dom.window.document.activeElement, input);
  key('ArrowDown');
  assert.equal(dom.window.document.activeElement, enabled[0]);
  key('ArrowDown');
  assert.equal(dom.window.document.activeElement, enabled[1]);
  key('ArrowUp'); key('ArrowUp');
  assert.equal(dom.window.document.activeElement, input);
  key('ArrowUp');
  assert.equal(dom.window.document.activeElement, enabled[enabled.length - 1], 'wraps from the search to the last switch');
  key('ArrowDown');
  assert.equal(dom.window.document.activeElement, input, 'wraps from the last switch to the search');
  enabled[1].closest('.composer-tool-row').querySelector('[data-chat-panel-members]').focus();
  key('ArrowDown');
  assert.equal(dom.window.document.activeElement, enabled[2], 'from a count button, ArrowDown goes to the next row');
  type(dom, input, 'git');
  inventory.popover.close(slot.querySelector('#composerChatPanel'));
  assert.equal(input.value, '', 'a panel closed without the chip (Escape, click-away) keeps no query');
  assert.equal(track(slot, 'images').disabled, true);
  assert.ok(!enabled.includes(track(slot, 'images')), 'blocked switches are skipped');
  assert.equal(enabled.length, rowCount - 1);
});

test('opening the panel focuses the first enabled switch when the search is hidden, and drops an old query', (t) => {
  const { dom, controller, slot, tools } = setup(t);
  controller.setAvailableTools([{ name: 'image_generate', surfaceFamily: 'images', available: false, reason: 'config disabled' },
    { name: 'read_file', surfaceFamily: 'files' }]);
  tools.render(); bindPanel(dom, slot, tools);
  slot.querySelector('#composerToolsChip').click();
  assert.equal(dom.window.document.activeElement, track(slot, 'files'));
  const key = (value) => dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  key('ArrowDown');
  assert.equal(dom.window.document.activeElement, track(slot, 'files'), 'a single enabled switch wraps onto itself');
  slot.querySelector('#composerToolsChip').click();
  assert.equal(slot.querySelector('#composerChatPanel').hidden, true);
  controller.setAvailableTools(manyFamilies); tools.render();
  const input = slot.querySelector('[data-chat-panel-filter]');
  slot.querySelector('#composerToolsChip').click();
  type(dom, input, 'web');
  slot.querySelector('#composerToolsChip').click();
  assert.equal(input.value, '', 'closing through the chip drops the query');
  slot.querySelector('#composerToolsChip').click();
  assert.equal(dom.window.document.activeElement, input, 'the search takes focus when shown');
  assert.ok([...slot.querySelectorAll('.composer-tool-row')].every((node) => !node.hidden));
});

test('reset visibility follows overrides, and reset restores defaults and focuses the first enabled switch', async (t) => {
  const { slot, dom, tools } = setup(t);
  await tools.refresh(); bindPanel(dom, slot, tools);
  const reset = slot.querySelector('[data-chat-panel-action="reset"]');
  assert.equal(reset.hidden, true);
  track(slot, 'files').click();
  await flush();
  assert.equal(reset.hidden, false);
  assert.equal(chipCount(slot), '1 off');
  reset.focus();
  reset.click();
  await flush();
  assert.equal(reset.hidden, true);
  assert.equal(track(slot, 'files').getAttribute('aria-checked'), 'true');
  assert.equal(dom.window.document.activeElement, track(slot, 'files'), 'focus lands on a switch, not the body');
  assert.equal(chipCount(slot), undefined);
});

test('a session switch closes the open panel and drops the query', (t) => {
  const { dom, state, slot, tools, controller } = setup(t);
  state.sessions.push({ id: 'b', tool_category_overrides: {}, tool_connection_overrides: {} });
  controller.setAvailableTools(manyFamilies);
  tools.render(); bindPanel(dom, slot, tools);
  slot.querySelector('#composerToolsChip').click();
  const panel = slot.querySelector('#composerChatPanel');
  type(dom, slot.querySelector('[data-chat-panel-filter]'), 'web');
  assert.equal(panel.hidden, false);
  state.currentSessionId = 'b';
  tools.render();
  assert.equal(panel.hidden, true);
  assert.equal(slot.querySelector('[data-chat-panel-filter]').value, '');
  assert.ok([...slot.querySelectorAll('.composer-tool-row')].every((node) => !node.hidden));
});
