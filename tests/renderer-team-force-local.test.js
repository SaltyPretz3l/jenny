'use strict';

// Force local means no team networking, in the renderer (row 123, owner decision E64): Settings > Team and the Team
// tab say the owner's state line, every control that would host, join, reach a team or share the GPU is greyed with
// that line as its reason and sends nothing, a held team stays listed; turning Force local on asks first (Settings >
// Offline and quick settings) only while this PC's team server runs, and the sentence under the switch shows only
// while the Team feature applies.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { harness, flush, hostState, memberTeam, NONE } = require('./helpers/team-settings-harness');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch.js');
const offlineUtils = require('../renderer/features/renderer-offline-utils');

const LINE = 'Team is off while Force local is on. Nothing is sent to or from this PC.';
const QUESTION = 'Turn on Force local? The team server on this PC stops and everyone is disconnected until you turn it off.';
const NOTE = 'Also turns Team off on this PC: no hosting, no joined teams, no shared GPU.';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const heldTeam = () => memberTeam({ state: 'force_local', role: null, member_state: null, reason: 'team_force_local' });
function heldPage(t, host) {
  const team = heldTeam();
  const h = harness({ host, teams: [team], answers: { status: () => ({ ok: true, teams: [team], sharing: null, pools: {}, force_local: true }) } });
  t.after(h.restore);
  return h;
}

// ---------------------------------------------------------------- 9. Settings > Team and the Team tab

test('9. Settings > Team: the state line on the server line and the held row; greyed controls carry it and send nothing', async (t) => {
  const h = heldPage(t, hostState({ state: 'stopped', force_local: true, key: 'ok', direct_port: 45123, internet: null }));
  await flush();
  assert.equal(h.q('.team-set-status .settings-page-status-value').textContent, LINE, 'the server line');
  const row = h.q('[data-team-joined] .team-set-person');
  assert.equal(row.querySelector('.team-set-person__name').textContent, 'Dot lab', 'the held team is listed by name');
  assert.equal(row.querySelector('.team-set-person__fact').textContent, LINE, 'its connection words');
  for (const action of ['start', 'leave', 'join']) {
    const button = h.q(`[data-team-action="${action}"]`);
    assert.ok(button, action);
    assert.equal(button.disabled, true, `${action} greyed, not hidden`);
    assert.equal(button.getAttribute('title'), LINE, `${action} says why`);
    button.click();
  }
  for (const id of ['teamNet', 'teamShareGpu']) {
    const track = h.q(`[data-inv-toggle="${id}"]`);
    assert.ok(track, id);
    assert.equal(track.disabled, true, `${id} greyed`);
    assert.equal(track.closest('.inv-toggle').getAttribute('title'), LINE, `${id} says why`);
    track.click();
  }
  await flush();
  for (const method of ['hostDeploy', 'join', 'leave', 'shareSet', 'hostInternet']) assert.deepEqual(h.sent(method), [], `${method} not sent`);
});

test('9. Settings > Team with no hosted team: Deploy and Restore are greyed with the state line', async (t) => {
  const h = heldPage(t, { ...NONE, force_local: true });
  await flush();
  for (const action of ['deploy', 'restore-open']) {
    const button = h.q(`[data-team-action="${action}"]`);
    assert.ok(button, action);
    assert.equal(button.disabled, true, action);
    assert.equal(button.getAttribute('title'), LINE, action);
  }
});

test('9. the Team tab: a held team is the whole-view state line with no composer', async (t) => {
  const h = heldPage(t, hostState({ state: 'stopped', force_local: true }));
  h.showTab();
  await flush();
  assert.equal(h.view.q('.team-state h2').textContent, LINE);
  assert.equal(h.view.q('.team-composer__input'), null, 'no composer');
  assert.equal(/not running/.test(h.view.text()), false);
});

test('9. the Team tab with no team row while the host is held says the state line, not "not running"', async (t) => {
  const h = harness({ host: hostState({ state: 'stopped', force_local: true }), teams: [] });
  t.after(h.restore);
  h.showTab();
  await flush();
  assert.equal(h.view.q('.team-state h2').textContent, LINE);
});

// Every control a hold greys, listed here apart from the constant so a dropped entry is caught.
const HELD = ['deploy', 'start', 'join', 'recover', 'confirm-recover', 'restore-open', 'restore-pick', 'restore-go', 'new-open',
  'new-go', 'net-save', 'net-on', 'net-code', 'share-start', 'leave', 'confirm-leave', 'cancel-request', 'enter-code', 'reconnect',
  'device-invite', 'leave-export'];

test('9/13. every held action is greyed with the state line; none is greyed while Force local is off', () => {
  const view = require('../renderer/shell/renderer-settings-team-view');
  assert.deepEqual([...view.HELD_ACTIONS].sort(), [...HELD].sort(), 'the constant is exactly the held list');
  const dom = new JSDOM('<!doctype html><body></body>');
  const saved = globalThis.inventory;
  globalThis.inventory = { actionButton: require('../renderer/inventory/action-button.js') };
  try {
    for (const [forceLocal, greyed] of [[true, true], [false, false]]) {
      for (const action of HELD) {
        dom.window.document.body.innerHTML = view.button({ forceLocal, isBusy: () => false }, action, 'x');
        const button = dom.window.document.querySelector('button');
        assert.equal(button.disabled, greyed, `${action} (Force local ${forceLocal})`);
        assert.equal(button.getAttribute('title'), greyed ? LINE : null, `${action} says why`);
      }
    }
  } finally {
    globalThis.inventory = saved;
  }
});

// A click that reaches the page's handler although the control is disabled (`click()` on a disabled button does not).
function poke(h, element) {
  element.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
}

test('13. Reclaim, Restore, Start a new team, the internet switch and form and the GPU switch: greyed, and a direct click sends nothing', async (t) => {
  const cases = [
    { host: hostState({ state: 'running', force_local: true }), teams: [], action: 'recover', after: '[data-team-action="confirm-recover"]', method: 'hostRecover' },
    { host: { ...NONE, force_local: true }, teams: [heldTeam()], action: 'restore-open', after: '[data-team-action="restore-pick"]', method: 'hostRestorePick' },
    { host: hostState({ state: 'stopped', force_local: true, key: 'missing' }), teams: [heldTeam()], action: 'new-open', after: '[data-team-action="new-go"]', method: 'hostStartNew' },
  ];
  for (const c of cases) {
    const h = harness({ host: c.host, teams: c.teams, answers: { status: () => ({ ok: true, teams: c.teams, sharing: null, pools: {}, force_local: true }) } });
    try {
      await flush();
      const button = h.q(`[data-team-action="${c.action}"]`);
      assert.ok(button, c.action);
      assert.equal(button.disabled, true, c.action);
      assert.equal(button.getAttribute('title'), LINE, c.action);
      poke(h, button);
      await flush();
      assert.equal(h.q(c.after), null, `${c.action}: nothing opened`);
      assert.deepEqual(h.sent(c.method), [], `${c.action}: ${c.method} not sent`);
    } finally {
      h.restore();
    }
  }
  const h = heldPage(t, hostState({ state: 'stopped', force_local: true, key: 'ok', direct_port: 45123,
    internet: { public_address: 'team.example.org', relay_url: null, has_token: false } }));
  await flush();
  for (const id of ['teamNet', 'teamShareGpu']) {
    const track = h.q(`[data-inv-toggle="${id}"]`);
    assert.equal(track.disabled, true, id);
    assert.equal(track.closest('.inv-toggle').getAttribute('title'), LINE, id);
    poke(h, track);
  }
  await flush();
  assert.equal(h.q('[data-team-action="net-on"]'), null, 'the internet switch opened nothing');
  assert.equal(h.q('[data-team-action="share-start"]'), null, 'the GPU switch opened nothing');
  const address = h.q('#teamNetAddr');
  assert.ok(address, 'the internet form');
  address.value = 'other.example.org';
  address.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await flush();
  const save = h.q('[data-team-action="net-save"]');
  assert.ok(save, 'an edited form offers Save');
  assert.equal(save.disabled, true);
  assert.equal(save.getAttribute('title'), LINE);
  poke(h, save);
  await flush();
  for (const method of ['hostInternet', 'shareSet']) assert.deepEqual(h.sent(method), [], `${method} not sent`);
});

test('25. the Server line is the state line while held, on a PC that never hosted and while the hold stops the server', async (t) => {
  for (const host of [{ ...NONE, force_local: true }, hostState({ state: 'stopping', force_local: true }), hostState({ state: 'running', force_local: true })]) {
    const h = harness({ host, teams: [] });
    try {
      await flush();
      assert.equal(h.q('.team-set-status .settings-page-status-value')?.textContent, LINE, `${host.state}, deployed ${host.deployed}`);
    } finally {
      h.restore();
    }
  }
  const off = harness({ host: NONE, teams: [] });
  t.after(off.restore);
  await flush();
  assert.equal(off.q('.team-set-status'), null, 'no Server line for a PC that never hosted, Force local off');
});

// ---------------------------------------------------------------- 10. the question and the sentence

// A window with the team bridge and a confirm dialog the test answers.
function fakeWindow({ host = { state: 'running' }, answer = false, statusThrows = false, stored = undefined } = {}) {
  const asked = [];
  const statusCalls = [];
  const win = {
    ...(stored === undefined ? {} : { rendererTeamStore: { getTeamStore: () => ({ snapshot: () => ({ host: stored }) }) } }),
    jennyShell: { team: { hostStatus: async () => { statusCalls.push(1); if (statusThrows) throw new Error('down'); return { ok: true, host }; } } },
    rendererIdeConfirmDialog: { createIdeConfirmDialog: () => ({ confirm: async (config) => { asked.push(config); return answer; }, dispose() {} }) },
    inventoryHelpOverlay: { createHelpOverlay: () => ({}) },
    rendererOfflineUtils: offlineUtils,
  };
  return { win, asked, statusCalls };
}
const teamOn = (over = {}) => ({ features: { featureFlags: { team: true }, teamData: true }, ...over });

test('10. the question: only while the host runs, with the owner\'s words; a stopped, unreadable or off team switches at once', async () => {
  const running = fakeWindow({ answer: false });
  assert.equal(await offlineUtils.confirmForceLocal({ state: teamOn(), win: running.win }), false, 'Cancel');
  assert.equal(running.asked.length, 1);
  assert.equal(running.asked[0].message, QUESTION);
  assert.deepEqual([running.asked[0].confirmLabel, running.asked[0].cancelLabel], ['Turn on', 'Cancel']);
  assert.equal(await offlineUtils.confirmForceLocal({ state: teamOn(), win: fakeWindow({ answer: true }).win }), true, 'confirmed');
  for (const [name, made, state] of [
    ['stopped host', fakeWindow({ host: { state: 'stopped' } }), teamOn()],
    ['unreadable host state', fakeWindow({ statusThrows: true }), teamOn()],
    ['team flag off', fakeWindow(), { features: { featureFlags: { team: false } } }],
    ['no team data', fakeWindow(), { features: { featureFlags: { team: true }, teamData: false } }],
  ]) {
    assert.equal(await offlineUtils.confirmForceLocal({ state, win: made.win }), true, name);
    assert.equal(made.asked.length, 0, `${name}: no question`);
  }
});

test('9 (perf). the question reads the host state the team store holds; main is asked only when it holds none', async () => {
  const held = fakeWindow({ stored: { state: 'running' }, host: { state: 'stopped' }, answer: true });
  assert.equal(await offlineUtils.confirmForceLocal({ state: teamOn(), win: held.win }), true);
  assert.equal(held.asked.length, 1, 'asked from the stored running host');
  assert.equal(held.statusCalls.length, 0, 'hostStatus not called');
  const stoppedHeld = fakeWindow({ stored: { state: 'stopped' } });
  assert.equal(await offlineUtils.confirmForceLocal({ state: teamOn(), win: stoppedHeld.win }), true);
  assert.deepEqual([stoppedHeld.asked.length, stoppedHeld.statusCalls.length], [0, 0], 'a stored stopped host: no question, no call');
  const none = fakeWindow({ stored: null, answer: true });
  assert.equal(await offlineUtils.confirmForceLocal({ state: teamOn(), win: none.win }), true);
  assert.deepEqual([none.asked.length, none.statusCalls.length], [1, 1], 'nothing stored: main asked once');
});

function offlineBinder(state, win, calls) {
  const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');
  const dom = new JSDOM('<!doctype html><body><div id="host">' + toggleSwitchModule.toggleSwitch({ id: 'offlineLocalOnlyToggle', checked: false, label: 'x' }) + '</div></body>');
  const host = dom.window.document.getElementById('host');
  const binders = createSettingsSectionBinders({ state, windowRef: win, constants: {},
    callbacks: { showSessionActionError: () => {}, handleOfflineModeChange: async (enabled) => { calls.push(enabled); state.offline = { mode: enabled ? 'local_only' : 'disabled' }; return state.offline; } },
    getLazySectionDom: (id) => (id === 'offline' ? { offlineLocalOnlyList: host } : {}) });
  binders.bindSection('offline', { registerSectionListener: (target, type, handler) => target?.addEventListener(type, handler), finalizeSectionBindings: () => true });
  const track = () => host.querySelector('[data-inv-toggle="offlineLocalOnlyToggle"]');
  return { track, flip: () => toggleSwitchModule.toggle(track(), true), host };
}

test('10. Settings > Offline: Cancel leaves the mode off and the switch drawn off; confirm writes the mode once', async () => {
  const cancel = fakeWindow({ answer: false });
  const calls = [];
  const state = { ...teamOn(), offline: { mode: 'disabled' } };
  const b = offlineBinder(state, cancel.win, calls);
  b.flip();
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(cancel.asked.length, 1, 'asked');
  assert.deepEqual(calls, [], 'nothing written');
  assert.equal(b.track().getAttribute('aria-checked'), 'false', 'drawn off');
  assert.equal(b.host.querySelector('.inv-toggle-error')?.textContent || '', '', 'no error under it');
  const go = fakeWindow({ answer: true });
  const written = [];
  const yes = offlineBinder({ ...teamOn(), offline: { mode: 'disabled' } }, go.win, written);
  yes.flip();
  for (let i = 0; i < 5; i += 1) await settle();
  assert.deepEqual(written, [true], 'written once');
  assert.equal(yes.track().getAttribute('aria-checked'), 'true');
});

test('10. Settings > Offline with a stopped host or the team flag off: no question, written at once', async () => {
  for (const [made, state] of [[fakeWindow({ host: { state: 'stopped' } }), teamOn()], [fakeWindow(), { features: { featureFlags: { team: false } } }]]) {
    const calls = [];
    const b = offlineBinder({ ...state, offline: { mode: 'disabled' } }, made.win, calls);
    b.flip();
    for (let i = 0; i < 5; i += 1) await settle();
    assert.equal(made.asked.length, 0);
    assert.deepEqual(calls, [true]);
  }
});

function quickSettings(state, win) {
  const { createQuickSettingsModal } = require('../renderer/shell/renderer-quick-settings-modal.js');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const documentRef = dom.window.document;
  toggleSwitchModule.initToggleHandlers(documentRef);
  Object.assign(dom.window, win);
  const toggleSwitch = toggleSwitchModule.toggleSwitch;
  Object.assign(toggleSwitch, { setChecked: toggleSwitchModule.setChecked, toggle: toggleSwitchModule.toggle });
  const writes = [];
  let current = { mode: 'disabled', preferredLocalModel: '' };
  const offline = { read: () => current, write: (value) => { writes.push(value); current = value; return Promise.resolve(value); } };
  const controller = createQuickSettingsModal({ documentRef, windowRef: dom.window, overlayManager: { open: () => true, close: () => true },
    state: { modelList: { data: [] }, offline: { resolved: true, mode: 'disabled', localChatReady: true }, ui: {}, ...state },
    adapters: { appearance: { read: () => ({}), write: async () => ({}) }, zoom: { read: () => 100, write: async () => 100 }, offline },
    runtimePrefs: { getCurrent: () => ({}) }, inventory: { toggleSwitch, selectField: require('../renderer/inventory/select-field.js'),
      segmentedControl: require('../renderer/inventory/segmented-control.js'), actionButton: require('../renderer/inventory/action-button.js') },
    appearanceUtils: require('../renderer/shared/appearance-utils.js'), chatZoomUtils: require('../renderer/chat/chat-zoom-utils.js'),
    statusChipUtils: require('../renderer/shell/renderer-status-chip-utils.js'), offlineUtils });
  controller.open();
  const slot = documentRef.querySelector('[data-slot="model"]');
  const track = () => slot.querySelector('[data-inv-toggle="quickSettingsLocalOnly"]');
  return { slot, track, writes, click: () => track().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) };
}

test('10. quick settings: the question while the host runs; Cancel draws the switch back off, confirm writes once', async () => {
  const cancel = fakeWindow({ answer: false });
  const q = quickSettings(teamOn(), cancel.win);
  q.click();
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(cancel.asked.length, 1);
  assert.deepEqual(q.writes, []);
  assert.equal(q.track().getAttribute('aria-checked'), 'false');
  const go = fakeWindow({ answer: true });
  const yes = quickSettings(teamOn(), go.win);
  yes.click();
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(yes.writes.length, 1);
  assert.equal(yes.writes[0].mode, 'local_only');
  const stopped = fakeWindow({ host: { state: 'stopped' } });
  const at = quickSettings(teamOn(), stopped.win);
  at.click();
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(stopped.asked.length, 0);
  assert.equal(at.writes.length, 1);
});

test('10. the sentence under the switch: present with the team flag on, absent with it off (Settings > Offline and quick settings)', () => {
  assert.equal(offlineUtils.forceLocalTeamNote(teamOn()), NOTE);
  assert.equal(offlineUtils.forceLocalTeamNote({ features: { featureFlags: { team: false } } }), '');
  const on = quickSettings(teamOn(), fakeWindow().win);
  assert.ok(on.slot.textContent.includes(NOTE), 'quick settings with the flag on');
  const off = quickSettings({ features: { featureFlags: { team: false } } }, fakeWindow().win);
  assert.equal(off.slot.textContent.includes(NOTE), false, 'quick settings with the flag off');
  for (const [state, shown] of [[teamOn(), true], [{ features: { featureFlags: { team: false } } }, false]]) {
    const dom = new JSDOM('<!doctype html><body><div id="list"></div></body>');
    const saved = { document: globalThis.document, inventory: globalThis.inventory };
    globalThis.document = dom.window.document;
    globalThis.inventory = { toggleSwitch: toggleSwitchModule.toggleSwitch };
    try {
      const list = dom.window.document.getElementById('list');
      const manager = offlineUtils.createOfflineManager({ state: { ...state, offline: { mode: 'disabled', resolved: true } },
        dom: { offlineLocalOnlyList: list }, callbacks: { appendClientLog: () => {}, renderSettings: () => {} } });
      manager.renderOfflineManager();
      assert.equal(list.textContent.includes(NOTE), shown, `Settings > Offline, flag ${shown ? 'on' : 'off'}`);
    } finally {
      globalThis.document = saved.document;
      globalThis.inventory = saved.inventory;
    }
  }
});
