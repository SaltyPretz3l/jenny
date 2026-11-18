'use strict';

// Shared harness for the Settings > Team page tests (row 123, slice 1g-1) and the
// Team tab tests (slice 1g-2): a JSDOM page with the real inventory modules, a fresh
// copy of the team modules (one shared store), and a stubbed `window.jennyShell.team`
// whose `answers[method]` is a value or a function of the payload. Console calls and
// localStorage writes are recorded so a test can prove a code never reaches them.
// `shell(h)` adds the real top rail, the tab gate and the app shortcuts on top.

const { JSDOM } = require('jsdom');
// Main's own payload check: a bridge call main would refuse fails the test at its teardown (slice 2c fix list M5).
// Loaded at the first call, so a test that makes none loads no services/team module (team-off.test.js).
const mainRefuses = (name, payload) => {
  const { METHODS, validatePayload } = require('../../services/team/ipc-methods');
  return Object.hasOwn(METHODS, name) && !validatePayload(name, payload).ok;
};

const TEAM = 'team_AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'team_BBBBBBBBBBBBBBBBBBBBBB';
const ME = 'member_me';
const DOT = 'member_dot';
const MAYA = 'member_maya';
const DESK = 'device_desk';
const LAPTOP = 'device_laptop';
const CODE = 'jteam1_SECRETINVITECODEforTEST';
const DEVICE_CODE = 'jteam1_DEVICECODEforTEST';
// The store waits this long after a push before it re-reads lists (renderer-team-store.js).
const PUSH_SETTLE_MS = 250;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush() { for (let i = 0; i < 8; i += 1) await settle(); }
// After a push: past the store's trailing delay, then the reads it started.
async function pushed() { await new Promise((resolve) => setTimeout(resolve, PUSH_SETTLE_MS + 30)); await flush(); }
// Under mocked timers `flush` (a setTimeout) would never return; the stubbed bridge only needs microtasks.
async function micro() { for (let i = 0; i < 60; i += 1) await Promise.resolve(); }

const snapshot = (over = {}) => ({ team_id: TEAM, team_name: 'Studio', state: 'online', reason: null, code: null, since: 1,
  member_id: ME, device_id: DESK, display_name: 'Olive Owner', role: 'owner', member_state: 'active', ...over });
// A team hosted elsewhere that this person joined as Dot.
const memberTeam = (over = {}) => snapshot({ team_id: OTHER, team_name: 'Dot lab', role: 'member', member_id: DOT, display_name: 'Dot', ...over });
const hostState = (over = {}) => ({ state: 'running', team_id: TEAM, team_name: 'Studio', deployed: true, reason: null, since: 1, ...over });
const NONE = Object.freeze({ state: 'stopped', team_id: null, team_name: null, deployed: false, reason: null, since: 1 });
const device = (id, label, over = {}) => ({ device_id: id, member_id: ME, label, state: 'active', fingerprint: '7f3a91c205',
  created_at: 1, last_seen_at: Date.UTC(2026, 10, 9, 12), ...over });
const ROSTER = Object.freeze([
  { member_id: ME, display_name: 'Olive Owner', role: 'owner', state: 'active', devices: [device(DESK, 'Desk')] },
  { member_id: DOT, display_name: 'Dot', role: 'member', state: 'active', devices: [device('device_dot', 'Dot PC', { member_id: DOT })] },
  { member_id: MAYA, display_name: 'Maya Okafor', role: 'member', state: 'pending', devices: [device('device_maya', 'Maya laptop', { member_id: MAYA })] },
]);
const SECTION = '../../renderer/shell/renderer-settings-team-section';
const STORE = '../../renderer/team/renderer-team-store';
const CHAT_STORE = '../../renderer/team/renderer-team-chat-store';
const TAB = '../../renderer/team/renderer-team-tab';
const MODEL_STORE = '../../renderer/team/renderer-team-model-store';
const MODULES = ['strings', 'view', 'owner-view', 'gpu', 'network', 'lifecycle', 'models'].map((name) => `../../renderer/shell/renderer-settings-team-${name}`)
  .concat(SECTION, STORE, CHAT_STORE, TAB, MODEL_STORE, '../../renderer/team/renderer-team-tab-gate',
    ...['channels', 'dm-picker', 'gpus', 'tab-view', 'message-row', 'pop', 'marks', 'receipts', 'pins', 'files', 'timeline', 'attach', 'notice', 'chat-writes', 'message-actions', 'composer', 'presence', 'thread-data', 'thread', 'link', 'search', 'notify', 'export', 'palette', 'server', 'start', 'overview'].map((name) => `../../renderer/team/renderer-team-${name}`));

// Chat fixtures (slice 2a-5a): the team channel, members with presence, and host message records.
const CHAN = 'chan_team';
const chatChannel = (over = {}) => ({ channel_id: CHAN, kind: 'team', archived: false, rev: 1, last_seq: 0, floor_seq: 1,
  last_read_seq: 0, notify: 'all', unread: 0, unread_capped: false, mention: false, ...over });
const chatMember = (member_id, display_name, over = {}) => ({ member_id, display_name, role: 'member', state: 'online', last_seen_at: null, ...over });
const CHAT_MEMBERS = Object.freeze([chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot')]);
const msgId = (seq) => 'msg_' + String(seq).padStart(26, '0');
// One hour ago by default, a minute apart per seq, so consecutive messages by one author form a run.
const BASE_MS = Date.now() - 3_600_000;
const message = (seq, over = {}) => ({ id: msgId(seq), channel_id: CHAN, seq, rev: seq, author: { kind: 'member', member_id: DOT },
  created_at: new Date(BASE_MS + seq * 60_000).toISOString(), edited_at: null, text: `Message ${seq}`, thread_root_id: null,
  reply_count: 0, last_reply_at: null, mentions: [], refs: [], attachments: [], edits: [], reactions: {}, pinned: null,
  deleted: null, served_by: null, ...over });
const overview = (over = {}) => ({ ok: true, channels: [chatChannel()], outbox: [], members: CHAT_MEMBERS, reaction_emoji: ['👍'], ...over });
const SHELL_GLOBALS = ['rendererTopRailUtils', 'rendererTopNavShellController', 'scriptLoaderUtils', 'rendererSettingsScriptManifest'];

// The members here must all be in the real barrel, renderer/inventory/index.js (the text field is not: it is its own global).
function inventory() {
  const action = require('../../renderer/inventory/action-button');
  return {
    settingsField: require('../../renderer/inventory/settings-field'),
    selectField: require('../../renderer/inventory/select-field'),
    actionButton: action.actionButton || action,
    segmentedControl: require('../../renderer/inventory/segmented-control'),
    emptyNote: require('../../renderer/inventory/empty-note'),
    statusRow: require('../../renderer/inventory/status-row'),
    toggleSwitch: require('../../renderer/inventory/toggle-switch').toggleSwitch,
    popover: require('../../renderer/inventory/popover'),
    progressBar: require('../../renderer/inventory/progress-bar'),
  };
}

// The same queries against either root: the Settings page (`h.q`) or the Team view (`h.view.q`).
function scope(root) {
  const q = (s) => root.querySelector(s);
  return {
    q,
    qa: (s) => [...root.querySelectorAll(s)],
    text: () => root.textContent.replace(/\s+/g, ' ').trim(),
    click: (selector) => q(selector).click(),
  };
}

// `models: true` (slice 6-7) makes the model store a page global, as the manifests load it; left out, nothing asks main
// for model state and the method lists of the older tests stay as they were.
function harness({ host = NONE, teams = [], answers = {}, show = true, models = false } = {}) {
  const dom = new JSDOM('<!doctype html><body><nav id="topRail" class="toprail hidden"><div id="topRailTabs" role="tablist"></div><span id="topRailIndicator"></span></nav>'
    + '<div id="titlebarSettingsSlot"></div><section id="teamSettingsSection"><div id="teamSettingsBody"></div></section>'
    + '<section class="main-view team-view view-offscreen" id="teamView" inert aria-hidden="true"></section></body>',
    { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const saved = {};
  for (const key of ['window', 'document', 'inventory', 'inventoryContextMenu', 'inventoryTextField', 'rendererSettingsTeamSection', 'rendererTeamExport', 'rendererTeamModelStore', ...SHELL_GLOBALS]) saved[key] = globalThis[key];
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.inventory = inventory();
  globalThis.inventoryContextMenu = require('../../renderer/inventory/context-menu');
  globalThis.inventoryTextField = require('../../renderer/inventory/text-field');
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
  // The export module is a page global wherever Settings > Team loads (the manifest loads it first).
  globalThis.rendererTeamExport = require('../../renderer/team/renderer-team-export');
  const section = require(SECTION);
  const store = require(STORE).getTeamStore();
  const chat = require(CHAT_STORE).getChatStore();
  const tab = require(TAB);
  if (models) globalThis.rendererTeamModelStore = require(MODEL_STORE);
  const calls = [];
  const refusedPayloads = [];
  // Like the real bridge, a push reaches every subscriber.
  // `listeners.state` / `.host` is null with no subscriber, else a function that sends to all of them.
  const subscribers = { state: new Set(), host: new Set(), chat: new Set(), model: new Set() };
  const sender = (set) => (set.size ? (payload) => { for (const fn of [...set]) fn(payload); } : null);
  const listeners = { get state() { return sender(subscribers.state); }, get host() { return sender(subscribers.host); },
    get chat() { return sender(subscribers.chat); }, get model() { return sender(subscribers.model); } };
  const subscribe = (set) => (fn) => { set.add(fn); return () => { set.delete(fn); }; };
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
    chatOverview: () => overview(),
    chatHistory: () => ({ ok: true, messages: [], has_more: false }),
    chatMarkRead: (payload) => ({ ok: true, last_read_seq: payload.seq }),
    chatSetNotify: (payload) => ({ ok: true, level: payload.level }),
  };
  const bridge = new Proxy({}, {
    get(_target, name) {
      if (name === 'onState') return subscribe(subscribers.state);
      if (name === 'onHostState') return subscribe(subscribers.host);
      if (name === 'onChat') return subscribe(subscribers.chat);
      if (name === 'onModel') return subscribe(subscribers.model);
      return (...args) => {
        calls.push({ method: name, payload: args[0], argc: args.length });
        if (mainRefuses(name, args[0])) refusedPayloads.push(name);
        const answer = Object.hasOwn(answers, name) ? answers[name] : base[name];
        return Promise.resolve(typeof answer === 'function' ? answer(args[0]) : (answer ?? { ok: true }));
      };
    },
  });
  const copied = [];
  window.jennyShell = { team: bridge, clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve(); } } };
  window.markdownUtils = require('../../renderer/shared/markdown-utils');
  const container = window.document.getElementById('teamSettingsSection');
  const teamView = window.document.getElementById('teamView');
  const opened = [];
  const cleanups = [];
  if (show) section.showTeamSection({ container });
  const restore = () => {
    cleanups.splice(0).forEach((fn) => fn());
    // Slice 2c: waiting files (the hour's timer) and the pictures' cache are module state, as the gate's teardown clears them.
    for (const name of ['attach', 'files']) require.cache[require.resolve(`../../renderer/team/renderer-team-${name}`)]?.exports.disposeAll();
    section.leaveTeamSection();
    tab.hideTeamTab();
    chat.dispose();
    if (models) require(MODEL_STORE).peekModelStore()?.dispose();
    store.dispose();
    for (const [level, fn] of Object.entries(consoleSaved)) console[level] = fn;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
    if (refusedPayloads.length) throw new Error('main would refuse these payloads: ' + refusedPayloads.splice(0).join(', '));
  };
  const page = scope(container);
  const type = (selector, value) => {
    const input = page.q(selector);
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const choose = (selector, value) => {
    const select = page.q(selector);
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const sent = (method) => calls.filter((call) => call.method === method);
  return {
    window, container, calls, listeners, section, restore, type, choose, sent, stored, logged, copied,
    store, chat, tab, teamView, opened, cleanups, ...page,
    // The Team view, with the same queries as the Settings page above.
    view: scope(teamView),
    showTab: () => tab.showTeamTab({ container: teamView, openSettings: (id) => { opened.push(id); } }),
    // Every bridge call's method name, sorted; `methodNames` lists each name once.
    methods: () => calls.map((call) => call.method).sort(),
    methodNames: () => [...new Set(calls.map((call) => call.method))].sort(),
    headings: () => [...container.querySelectorAll('.settings-group-heading')].map((h) => h.firstChild.textContent.trim()),
  };
}

// The real top rail, tab gate and app shortcuts over a harness window. `flag: null` is the boot seed
// (no `team` key yet). Scripts "load" by requiring the module the manifest names; a src in `failing`
// does not load. With `layout: true` a view switch runs the real lifecycle navigation and the real
// chrome pipeline's `renderLayout`, as in the app.
function shell(h, { flag = true, activeView = 'chat', resolved = true, layout = false, failing: failingSrcs = [], teamData } = {}) {
  const { window } = h;
  const doc = window.document;
  const manifest = require('../../renderer/shell/renderer-settings-script-manifest');
  const names = new Map([...manifest.teamSection, ...(manifest.teamTab || []), ...(manifest.teamStore || []), ...(manifest.teamGate || []), ...(manifest.teamChat || [])]);
  const requested = [];
  const failing = new Set(failingSrcs);
  // `teamData`: what main said about team data on disk (E50); left out, the payload could not tell.
  const state = { ui: { activeView }, features: { featureFlags: flag === null ? {} : { team: flag }, availabilityResolved: resolved,
    ...(teamData === undefined ? {} : { teamData }) } };
  globalThis.rendererTopRailUtils = require('../../renderer/shell/renderer-toprail-utils');
  window.rendererSettingsScriptManifest = manifest;
  window.scriptLoaderUtils = { ensureScript({ src, isReady }) {
    requested.push(src);
    if (failing.has(src)) return Promise.resolve(false);
    const name = names.get(src);
    if (name && !window[name]) window[name] = require(`../../${src}`);
    return Promise.resolve(typeof isReady === 'function' ? isReady() : true);
  } };
  const views = [];
  const persisted = [];
  let switchView = (id) => { state.ui.activeView = id; controller.applyViewChrome(); };
  const setActiveView = (id) => { views.push(id); switchView(id); };
  const controller = require('../../renderer/shell/renderer-top-nav-shell').createTopNavShellController({
    state, windowRef: window, documentRef: doc,
    dom: { topRail: doc.getElementById('topRail'), topRailTabs: doc.getElementById('topRailTabs'), topRailIndicator: doc.getElementById('topRailIndicator') },
    callbacks: { setActiveView },
    teamTab: { afterPaint: (fn) => fn() },
  });
  controller.setTeamTabActions?.({ openSettings: (id) => { h.opened.push(id); } });
  globalThis.rendererTopNavShellController = controller;
  window.rendererTopNavShellController = controller;
  let renderLayout = () => {};
  if (layout) {
    const chromePath = require.resolve('../../renderer/chat/renderer-render-pipeline-chrome');
    delete require.cache[chromePath]; // it binds `window` when it loads
    const pipeline = require(chromePath).createChromePipeline({ state, dom: {}, callbacks: {} });
    renderLayout = () => pipeline.renderLayout();
    const fwd = new Proxy({ applyViewChrome: () => controller.applyViewChrome(), renderLayout }, { get: (target, name) => target[name] || (() => {}) });
    const navigation = require('../../renderer/shell/renderer-lifecycle-navigation').createLifecycleNavigation({
      state, fwd, persistActiveView: (id) => { persisted.push(id); }, markStartupAudit() {}, appendClientLog() {}, refreshDiagnosticsWorkspace: () => Promise.resolve() });
    switchView = (id) => navigation.setActiveView(id);
    // The navigation focuses the composer on a frame when Chat shows; no frame runs here.
    const savedRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    h.cleanups.push(() => { globalThis.requestAnimationFrame = savedRaf; pipeline.dispose?.(); delete require.cache[chromePath]; });
  }
  const shortcuts = require('../../renderer/shell/renderer-global-shortcuts').createGlobalShortcutsController({
    windowRef: window, documentRef: doc, callbacks: { setActiveView } });
  shortcuts.bind();
  h.cleanups.push(() => { shortcuts.dispose(); controller.dispose(); });
  controller.applyViewChrome();
  renderLayout();
  const press = (key, { alt = false } = {}) => {
    const event = new window.KeyboardEvent('keydown', { key, code: `Digit${key}`, ctrlKey: true, altKey: alt, bubbles: true, cancelable: true });
    doc.body.dispatchEvent(event);
    return event;
  };
  const teamTab = () => doc.getElementById('teamTopRailTab');
  return { state, controller, requested, failing, views, persisted, press, teamTab, renderLayout,
    tabs: () => [...doc.querySelectorAll('#topRailTabs .toprail-tab')].map((el) => el.dataset.tabId),
    count: () => { const el = teamTab()?.querySelector('.toprail-tab__count'); return el && !el.hidden ? el.textContent : ''; } };
}

// JSDOM has no layout. This gives the timeline (`.team-scroll`) a height of 400 px, 40 px per message
// row and 20 px per other row, and a scroll position clamped like a browser's; the window has focus.
// With `narrow`, the view is under 720 px: on the list screen the channel is `display: none`, so the log
// measures 0 and ignores scrolling, as team-chat.css makes it.
function layout(h, { focused = true, narrow = false } = {}) {
  const { window } = h;
  const proto = window.HTMLElement.prototype;
  const tops = new WeakMap();
  const hidden = (el) => narrow && el.closest('.team-shell')?.dataset.screen === 'list';
  const isScroll = (el) => el.classList.contains('team-scroll') && !hidden(el);
  const height = (el) => [...el.children].reduce((sum, child) => sum + (child.classList.contains('team-msg') ? 40 : 20), 0);
  const max = (el) => Math.max(0, height(el) - 400);
  const saved = ['scrollHeight', 'clientHeight', 'scrollTop'].map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)]);
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return isScroll(this) ? height(this) : 0; } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return isScroll(this) ? 400 : 0; } });
  Object.defineProperty(proto, 'scrollTop', { configurable: true,
    get() { return isScroll(this) ? Math.min(tops.get(this) || 0, max(this)) : 0; },
    set(value) { if (isScroll(this)) tops.set(this, Math.max(0, Math.min(Number(value) || 0, max(this)))); } });
  const doc = window.document;
  let focus = focused;
  doc.hasFocus = () => focus;
  h.cleanups.push(() => {
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(proto, name, descriptor); else delete proto[name]; }
    delete doc.hasFocus;
  });
  return {
    setFocus(value) { focus = value; window.dispatchEvent(new window.Event(value ? 'focus' : 'blur')); },
    scroll(el, top) { el.scrollTop = top; el.dispatchEvent(new window.Event('scroll')); },
    atBottom: (el) => el.scrollTop >= max(el),
    max,
  };
}

// The Team tab open on #team over the harness bridge, the chat store held (the gate holds it in the
// app, also while the tab is hidden) and the layout stub giving the timeline a height.
async function openChat({ messages = [], outbox = [], channel = {}, members, answers = {}, teams = [memberTeam()], host, focused = true, narrow = false } = {}) {
  const h = harness({ show: false, host, teams, answers: {
    chatOverview: overview({ channels: [chatChannel(channel)], outbox, ...(members ? { members } : {}) }),
    chatHistory: { ok: true, messages, has_more: false },
    chatPost: { ok: true, entry_id: 'out_new' },
    ...answers,
  } });
  const box = layout(h, { focused, narrow });
  h.cleanups.push(h.chat.use());
  h.showTab();
  await flush();
  return { h, box, scroller: () => h.view.q('.team-scroll') };
}

// Answers the test releases itself, in order: `release(answer)` answers the oldest call still waiting.
function heldAnswers(value) {
  const queue = [];
  const gate = { calls: [], answer: (payload) => { gate.calls.push(payload); return new Promise((resolve) => queue.push(resolve)); },
    release: (answer = value) => queue.shift()(answer) };
  return gate;
}

// ---------------------------------------------------------------- shared by the chat test files

// The timers armed and not yet cleared or run (installed over the mocked timers). `keep(ms)` picks the ones counted
// (JSDOM arms a 0 ms timer for its selection events when a field is focused; the stores bound their calls).
function liveTimers(t, { keep = () => true } = {}) {
  const live = new Set();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => { const id = set(() => { live.delete(id); fn(...args); }, ms); if (keep(Number(ms) || 0)) live.add(id); return id; };
  globalThis.clearTimeout = (id) => { live.delete(id); clear(id); };
  t.after(() => { globalThis.setTimeout = set; globalThis.clearTimeout = clear; });
  return live;
}
const menu = (h) => h.window.document.querySelector('.inv-context-menu');
const menuLabels = (h) => [...menu(h).querySelectorAll('.inv-context-menu-item')].map((el) => el.textContent.trim());
function type(h, text, el = h.view.q('.team-composer__input')) {
  el.value = text;
  el.dispatchEvent(new h.window.Event('input', { bubbles: true }));
}
function key(h, el, name, over = {}) {
  const event = new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...over });
  el.dispatchEvent(event);
  return event;
}

// The thread column's fixtures (2a-6a): the root is message 2 (by Dot) with two replies, 3 and 4.
const ROOT = msgId(2);
const rootMsg = (over = {}) => message(2, { text: 'the root', reply_count: 2, last_reply_at: new Date().toISOString(), ...over });
const reply = (seq, over = {}) => message(seq, { thread_root_id: ROOT, text: 'reply ' + seq, created_at: new Date(Date.now() - (100 - seq) * 1000).toISOString(), ...over });
const threadAnswer = (over = {}) => ({ ok: true, root: rootMsg(), replies: [reply(3), reply(4)], has_more: false, ...over });
const byRoot = (over = {}) => (p) => (p.root_id === ROOT ? threadAnswer(over) : { ok: true, root: message(Number(p.root_id.slice(-2)), { text: 'other root' }), replies: [], has_more: false });
function openThreadChat({ answers = {}, messages = [message(1), rootMsg()], ...rest } = {}) {
  return openChat({ messages, ...rest, answers: { chatThread: byRoot(), ...answers } });
}
const threadOf = (h) => h.view.q('aside.team-thread');
const threadIds = (h) => h.view.qa('aside.team-thread .team-msg[data-message-id]').map((el) => el.dataset.messageId);
const channelRow = (h, seq) => h.view.q(`[data-team-region="timeline"] .team-msg[data-message-id="${msgId(seq)}"]`);
async function openThreadFrom(h, seq = 2) { channelRow(h, seq).querySelector('.team-thread-link, [data-team-msg-action="reply"]').click(); await flush(); }
const chatPush = (h, payload) => h.listeners.chat({ team_id: OTHER, ...payload });
// Chat search: the field, and a host match a minute apart per seq.
const searchField = (h) => h.view.q('.team-search .inv-text-field-control');
const MATCH_MS = Date.now();
const searchMatch = (seq, over = {}) => ({ channel_id: CHAN, message_id: msgId(seq), seq, root_id: null, author: { kind: 'member', member_id: DOT },
  created_at: new Date(MATCH_MS - (100 - seq) * 60_000).toISOString(), excerpt: `Message ${seq}`, ...over });
const pushMessages = (h, messages, reset = false) => chatPush(h, { type: 'messages', channel_id: CHAN, reset, messages });

// The joiner's own key line (two-PC findings): [name, team row fields, shown], for the Team tab and the Settings joined row.
const OWN_KEY_LINE = 'Your key: 7F3A 91C2 05. The owner sees the same characters before letting you in.';
const OWN_KEY_CASES = [
  ['pending with a key', { state: 'pending', member_state: 'pending', device_fingerprint: '7f3a91c205' }, true],
  ['pending with no key', { state: 'pending', member_state: 'pending', device_fingerprint: null }, false],
  ['let in', { state: 'online', member_state: 'active', device_fingerprint: '7f3a91c205' }, false],
];

module.exports = {
  TEAM, OTHER, ME, DOT, MAYA, DESK, LAPTOP, CODE, DEVICE_CODE, CHAN, CHAT_MEMBERS,
  flush, pushed, micro, snapshot, memberTeam, hostState, NONE, device, ROSTER, inventory, harness, shell, layout,
  chatChannel, chatMember, msgId, message, overview, openChat, heldAnswers,
  liveTimers, menu, menuLabels, type, key,
  ROOT, rootMsg, reply, threadAnswer, byRoot, openThreadChat, threadOf, threadIds, channelRow, openThreadFrom, chatPush, pushMessages,
  searchField, searchMatch, OWN_KEY_LINE, OWN_KEY_CASES,
};
