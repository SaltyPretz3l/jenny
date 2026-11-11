'use strict';

// Shared harness for the Settings > Team page tests (row 123, slice 1g-1): a JSDOM
// page with the real inventory modules, a fresh copy of the four team modules, and
// a stubbed `window.jennyShell.team` whose `answers[method]` is a value or a
// function of the payload. Console calls and localStorage writes are recorded so a
// test can prove a code never reaches them.

const { JSDOM } = require('jsdom');

const TEAM = 'team_AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'team_BBBBBBBBBBBBBBBBBBBBBB';
const ME = 'member_me';
const DOT = 'member_dot';
const MAYA = 'member_maya';
const DESK = 'device_desk';
const LAPTOP = 'device_laptop';
const CODE = 'jteam1_SECRETINVITECODEforTEST';
const DEVICE_CODE = 'jteam1_DEVICECODEforTEST';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush() { for (let i = 0; i < 8; i += 1) await settle(); }

const snapshot = (over = {}) => ({ team_id: TEAM, team_name: 'Studio', state: 'online', reason: null, code: null, since: 1,
  member_id: ME, device_id: DESK, display_name: 'Olive Owner', role: 'owner', member_state: 'active', ...over });
const hostState = (over = {}) => ({ state: 'running', team_id: TEAM, team_name: 'Studio', deployed: true, reason: null, since: 1, ...over });
const NONE = Object.freeze({ state: 'stopped', team_id: null, team_name: null, deployed: false, reason: null, since: 1 });
const device = (id, label, over = {}) => ({ device_id: id, member_id: ME, label, state: 'active', fingerprint: '7f3a91c205',
  created_at: 1, last_seen_at: Date.UTC(2026, 10, 9, 12), ...over });
const ROSTER = Object.freeze([
  { member_id: ME, display_name: 'Olive Owner', role: 'owner', state: 'active', devices: [device(DESK, 'Desk')] },
  { member_id: DOT, display_name: 'Dot', role: 'member', state: 'active', devices: [device('device_dot', 'Dot PC', { member_id: DOT })] },
  { member_id: MAYA, display_name: 'Maya Okafor', role: 'member', state: 'pending', devices: [device('device_maya', 'Maya laptop', { member_id: MAYA })] },
]);
const MODULES = ['strings', 'view', 'owner-view', 'section'].map((name) => `../../renderer/shell/renderer-settings-team-${name}`);

function inventory() {
  const action = require('../../renderer/inventory/action-button');
  return {
    settingsField: require('../../renderer/inventory/settings-field'),
    selectField: require('../../renderer/inventory/select-field'),
    textField: require('../../renderer/inventory/text-field'),
    actionButton: action.actionButton || action,
    segmentedControl: require('../../renderer/inventory/segmented-control'),
    emptyNote: require('../../renderer/inventory/empty-note'),
  };
}

function harness({ host = NONE, teams = [], answers = {}, show = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><section id="teamSettingsSection"><div id="teamSettingsBody"></div></section></body>',
    { url: 'https://jenny.invalid/' });
  const { window } = dom;
  const saved = {};
  for (const key of ['window', 'document', 'inventory', 'inventoryContextMenu', 'rendererSettingsTeamSection']) saved[key] = globalThis[key];
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.inventory = inventory();
  globalThis.inventoryContextMenu = require('../../renderer/inventory/context-menu');
  const stored = [];
  const setItem = window.localStorage.setItem.bind(window.localStorage);
  window.localStorage.setItem = (key, value) => { stored.push(`${key}=${value}`); setItem(key, value); };
  const logged = [];
  const consoleSaved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    consoleSaved[level] = console[level];
    console[level] = (...args) => { logged.push(args.map(String).join(' ')); };
  }
  for (const path of MODULES) delete require.cache[require.resolve(path)];
  const section = require(MODULES[3]);
  const calls = [];
  const listeners = { state: null, host: null };
  const base = {
    hostStatus: () => ({ ok: true, host }),
    status: () => ({ ok: true, teams }),
    members: () => ({ ok: true, team: { team_id: TEAM, name: 'Studio' }, members: ROSTER }),
    inviteList: () => ({ ok: true, invites: [] }),
    deviceList: () => ({ ok: true, devices: [device(DESK, 'Desk')] }),
    auditRead: () => ({ ok: true, entries: [], next_cursor: null }),
    inviteCreate: () => ({ ok: true, invite_id: 'invite_one', expires_at: Date.UTC(2026, 10, 11, 14, 5) }),
    inviteReveal: () => ({ ok: true, invite: CODE }),
    deviceInvite: () => ({ ok: true, invite_id: 'invite_dev', expires_at: 3, invite: DEVICE_CODE }),
  };
  const bridge = new Proxy({}, {
    get(_target, name) {
      if (name === 'onState') return (fn) => { listeners.state = fn; return () => { listeners.state = null; }; };
      if (name === 'onHostState') return (fn) => { listeners.host = fn; return () => { listeners.host = null; }; };
      return (...args) => {
        calls.push({ method: name, payload: args[0], argc: args.length });
        const answer = Object.hasOwn(answers, name) ? answers[name] : base[name];
        return Promise.resolve(typeof answer === 'function' ? answer(args[0]) : (answer ?? { ok: true }));
      };
    },
  });
  const copied = [];
  window.jennyShell = { team: bridge, clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } } };
  const container = window.document.getElementById('teamSettingsSection');
  if (show) section.showTeamSection({ container });
  const restore = () => {
    section.leaveTeamSection();
    for (const [level, fn] of Object.entries(consoleSaved)) console[level] = fn;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  };
  const q = (s) => container.querySelector(s);
  const type = (selector, value) => {
    const input = q(selector);
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const choose = (selector, value) => {
    const select = q(selector);
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const sent = (method) => calls.filter((call) => call.method === method);
  return {
    window, container, calls, listeners, section, restore, q, type, choose, sent, stored, logged, copied,
    click: (selector) => q(selector).click(),
    text: () => container.textContent.replace(/\s+/g, ' '),
    qa: (s) => [...container.querySelectorAll(s)],
    headings: () => [...container.querySelectorAll('.settings-group-heading')].map((h) => h.firstChild.textContent.trim()),
  };
}

module.exports = {
  TEAM, OTHER, ME, DOT, MAYA, DESK, LAPTOP, CODE, DEVICE_CODE,
  flush, snapshot, hostState, NONE, device, ROSTER, inventory, harness,
};
