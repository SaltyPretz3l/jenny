// new-test-file: the existing tools-slot test file would pass the 600-line cap; these cases need only the Computer bridge stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createComposerV2ToggleController } = require('../renderer/chat/renderer-composer-v2-toggle');
const { createComposerToolsSlot } = require('../renderer/chat/renderer-composer-tools-slot');
const inventory = {
  toggleSwitch: (({ toggleSwitch, setChecked, setDisabled }) => Object.assign(toggleSwitch, { setChecked, setDisabled }))(require('../renderer/inventory/toggle-switch')),
  chip: require('../renderer/inventory/chip'),
  popover: require('../renderer/inventory/popover'),
  actionButton: require('../renderer/inventory/action-button'),
};

const PANEL = `<span id="composerChatChipHost"></span>
<div class="inv-popover composer-chat-panel" id="composerChatPanel" data-inv-popover="composer-chat" role="dialog" hidden>
  <span data-chat-panel-tally></span><input type="search" data-chat-panel-filter hidden>
  <div id="composerChatPanelList"><p data-chat-panel-empty hidden></p></div>
  <button type="button" data-chat-panel-action="reset" hidden>Reset to defaults</button>
</div>`;
function setup(t) {
  const dom = new JSDOM('<div id="slot">' + PANEL + '</div>');
  t.after(() => dom.window.close());
  dom.window.inventory = inventory;
  const state = { currentSessionId: 'a', features: { tools: {} }, sessions: [{ id: 'a', tool_category_overrides: {}, tool_connection_overrides: {} }] };
  const controller = createComposerV2ToggleController({ state, persistSessionToolPreference: async () => {} });
  dom.window.jennyShell = { tools: { list: async () => [] } };
  const slot = dom.window.document.getElementById('slot');
  return { dom, state, controller, slot, tools: createComposerToolsSlot({ state, windowRef: dom.window, slot, controller }) };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const row = (slot, id) => slot.querySelector(`.composer-tool-row[data-tool-target="${id}"]`);
const track = (slot, id) => slot.querySelector(`[data-inv-toggle="tool-target:${id}"]`);
function spyToggles(controller) {
  const calls = [];
  const setToggle = controller.setToggle;
  controller.setToggle = (...args) => { calls.push(args); return setToggle(...args); };
  return calls;
}
function bindPanel(dom, slot, tools) {
  const { bindInteractiveComposerEvents } = require('../renderer/chat/renderer-chat-event-interactive-bindings');
  bindInteractiveComposerEvents({ composerWrap: slot, interactiveDelegateRoot: dom.window.document.createElement('div'),
    registerListener: (el, type, handler, opts) => el.addEventListener(type, handler, opts),
    handleComposerToggleChange: tools.handleToggleChange, openSettingsSection: () => {} });
  require('../renderer/inventory/toggle-switch').initToggleHandlers(dom.window.document);
}

// Row 196 C4/C5: the Computer row's Electron reasons and this chat's granted programs.
async function computerSetup(t, { status, grants = [], withRow = true, on = true, bridge = true } = {}) {
  const ctx = setup(t);
  const log = { revoked: [], statusReads: 0, grantReads: 0, onStatus: null };
  const list = grants.slice();
  if (bridge) {
    ctx.dom.window.jennyShell.computerUse = {
      status: async () => { log.statusReads += 1; return status; },
      grants: async () => { log.grantReads += 1; return { ok: true, grants: list.map((grant) => ({ ...grant })) }; },
      revoke: async (args) => { log.revoked.push(args); list.splice(list.findIndex((grant) => grant.path === args.path), 1); return { ok: true, revoked: true }; },
      onStatus: (callback) => { log.onStatus = callback; return () => {}; },
    };
  }
  ctx.controller.setAvailableTools([{ name: 'read_file', surfaceFamily: 'files', available: true },
    ...(withRow ? [{ name: 'computer', surfaceFamily: 'computer_use', available: true }] : [])]);
  ctx.tools.render(); // hydrates the chat first, so the toggle below is not dropped
  if (on && withRow) await ctx.controller.setToggle('computer_use', true);
  ctx.tools.render();
  return { ...ctx, log, sub: () => row(ctx.slot, 'computer_use')?.querySelector('.composer-tool-sub') };
}
const grantLines = (slot) => [...row(slot, 'computer_use').querySelectorAll('.composer-tool-grant')];
const grantNames = (slot) => grantLines(slot).map((line) => line.querySelector('.composer-tool-grant-name').textContent);
const noGrantsList = (slot) => row(slot, 'computer_use').querySelector('.composer-tool-grants')?.hidden ?? true;
const GRANTS = [{ name: 'Notepad', path: 'C:\\Windows\\notepad.exe', viewOnly: false }, { name: 'Calculator', path: 'C:\\Windows\\calc.exe', viewOnly: true }];

test('a sandbox reason greys the Computer row with the reason and a Tool settings link', async (t) => {
  const { slot, tools, sub } = await computerSetup(t, { status: { ok: true, available: false, reason: 'sandbox' }, grants: GRANTS });
  assert.equal(row(slot, 'computer_use').dataset.blocked, 'false');
  await tools.refreshComputer();
  assert.equal(row(slot, 'computer_use').dataset.blocked, 'true');
  assert.equal(sub().querySelector('.composer-tool-warn').textContent, 'Off while the command sandbox is on');
  assert.equal(sub().querySelector('[data-tool-fix="settings"]').textContent, 'Tool settings');
  assert.equal(track(slot, 'computer_use').disabled, true);
  assert.equal(track(slot, 'computer_use').getAttribute('aria-checked'), 'false');
  assert.equal(noGrantsList(slot), true, 'a blocked row lists no programs');
});

test('strict safety links to Tool settings, and a model off this computer has no link', async (t) => {
  const strict = await computerSetup(t, { status: { ok: true, reason: 'strict_safety' } });
  await strict.tools.refreshComputer();
  assert.equal(strict.sub().querySelector('.composer-tool-warn').textContent, 'Off in strict safety mode');
  assert.ok(strict.sub().querySelector('[data-tool-fix="settings"]'));
  const cloud = await computerSetup(t, { status: { ok: true, reason: 'engine_not_local' } });
  await cloud.tools.refreshComputer();
  assert.equal(row(cloud.slot, 'computer_use').dataset.blocked, 'true');
  assert.equal(cloud.sub().querySelector('.composer-tool-warn').textContent, 'Needs a model on this computer');
  assert.equal(cloud.sub().querySelector('[data-tool-fix]'), null);
});

test('off the Windows platform the row shows blocked even with no computer tool', async (t) => {
  const { slot, tools, sub } = await computerSetup(t, { status: { ok: true, reason: 'not_windows' }, withRow: false });
  assert.equal(row(slot, 'computer_use'), null);
  await tools.refreshComputer();
  assert.equal(row(slot, 'computer_use').dataset.blocked, 'true');
  assert.equal(row(slot, 'computer_use').querySelector('.composer-tool-label').textContent, 'Computer');
  assert.equal(sub().textContent, 'Windows only for now');
  assert.equal(track(slot, 'computer_use').disabled, true);
});

test('a disabled status leaves the sidecar reason alone', async (t) => {
  const ctx = setup(t);
  ctx.dom.window.jennyShell.computerUse = { status: async () => ({ ok: true, reason: 'disabled' }), grants: async () => ({ ok: false }) };
  ctx.controller.setAvailableTools([{ name: 'computer', surfaceFamily: 'computer_use', available: false, reason: 'config disabled' }]);
  ctx.tools.render();
  await ctx.tools.refreshComputer();
  const sub = row(ctx.slot, 'computer_use').querySelector('.composer-tool-sub');
  assert.equal(sub.querySelector('.composer-tool-warn').textContent, 'Off in Settings');
  assert.equal(sub.querySelector('[data-tool-fix]').textContent, 'Turn on');
});

test('the list shows each program, marks view only, and Revoke removes its line without flipping the row', async (t) => {
  const { dom, controller, slot, tools, log } = await computerSetup(t, { status: { ok: true, reason: null }, grants: GRANTS });
  const calls = spyToggles(controller);
  bindPanel(dom, slot, tools);
  await tools.refreshComputer();
  const lines = grantLines(slot);
  assert.deepEqual(grantNames(slot), ['Notepad', 'Calculator']);
  assert.equal(lines[0].querySelector('.composer-tool-grant-kind'), null);
  assert.equal(lines[1].querySelector('.composer-tool-grant-kind').textContent, 'View only');
  assert.equal(lines[1].title, 'C:\\Windows\\calc.exe');
  assert.equal(slot.querySelector('.composer-tool-grants-label').textContent, 'Allowed in this chat');
  const revoke = lines[1].querySelector('.composer-chat-link');
  assert.equal(revoke.getAttribute('aria-label'), 'Revoke Calculator');
  revoke.click();
  await flush();
  assert.deepEqual(log.revoked, [{ sessionId: 'a', path: 'C:\\Windows\\calc.exe' }]);
  assert.deepEqual(grantNames(slot), ['Notepad']);
  assert.deepEqual(calls, [], 'Revoke does not toggle the Computer row');
  assert.equal(row(slot, 'computer_use').dataset.on, 'true');
});

test('with no programs the list says Jenny asks the first time', async (t) => {
  const { slot, tools } = await computerSetup(t, { status: { ok: true, reason: null }, grants: [] });
  await tools.refreshComputer();
  assert.equal(slot.querySelector('.composer-tool-grants-empty').textContent, 'No programs yet. Jenny asks the first time it needs one.');
  assert.equal(grantLines(slot).length, 0);
});

test('a row that is off shows no list, and a missing bridge leaves the row as it was', async (t) => {
  const off = await computerSetup(t, { status: { ok: true, reason: null }, grants: GRANTS, on: false });
  await off.tools.refreshComputer();
  assert.equal(noGrantsList(off.slot), true);
  const none = await computerSetup(t, { bridge: false });
  await none.tools.refreshComputer();
  assert.equal(row(none.slot, 'computer_use').dataset.blocked, 'false');
  assert.equal(noGrantsList(none.slot), true);
  assert.equal(none.sub().textContent, 'Use the mouse and keyboard in programs you grant');
});

test('opening the panel and a status push refresh the row; a turn change re-reads this chat\'s programs', async (t) => {
  const { dom, slot, log, sub } = await computerSetup(t, { status: { ok: true, reason: null }, grants: GRANTS });
  const turnListeners = [];
  dom.window.rendererComputerStepDisplay = { turnState: { subscribe: (fn) => { turnListeners.push(fn); return () => {}; } } };
  const panel = slot.querySelector('#composerChatPanel');
  panel.hidden = false;
  panel.dispatchEvent(new dom.window.CustomEvent('inv-popover-toggle', { bubbles: true, detail: { open: true } }));
  await flush();
  assert.equal(log.statusReads, 1);
  assert.equal(grantLines(slot).length, 2);
  log.onStatus({ ok: true, reason: 'sandbox' });
  assert.equal(row(slot, 'computer_use').dataset.blocked, 'true');
  assert.match(sub().textContent, /command sandbox/);
  log.onStatus({ ok: true, reason: null });
  assert.equal(row(slot, 'computer_use').dataset.blocked, 'false');
  const reads = log.grantReads;
  turnListeners[0]('other', { state: 'idle' });
  await flush();
  assert.equal(log.grantReads, reads, 'another chat changes nothing here');
  turnListeners[0]('a', { state: 'thinking', action: 'click' });
  await flush();
  assert.equal(log.grantReads, reads, 'a click cannot change the grants');
  turnListeners[0]('a', { state: 'thinking', action: 'open' });
  await flush();
  assert.equal(log.grantReads, reads + 1, 'an open step can');
});
