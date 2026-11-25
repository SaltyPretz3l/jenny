'use strict';

// The live run panel over a JSDOM page, a recording fake bridge, a fake mediaDevices and a hand-driven clock.
const { JSDOM } = require('jsdom');

const actionButton = require('../../renderer/inventory/action-button');
const popover = require('../../renderer/inventory/popover');
const textField = require('../../renderer/inventory/text-field');
const toggleSwitch = require('../../renderer/inventory/toggle-switch');
const panelModule = require('../../renderer/chat/renderer-live-run-panel');

const settle = () => new Promise((resolve) => setImmediate(resolve));

const STATES = ['idle', 'building', 'build_failed', 'starting', 'ended_early', 'no_window', 'running', 'minimized', 'closed', 'stopping', 'close_refused'];
const snap = (state, extra = {}) => ({
  projectId: 'p1', state, generation: 1, chatId: 'c1', sourceId: null, hwnd: null, exitCode: null, buildTail: '', reason: null, ...extra,
});
const COMMAND = { build: 'cargo build', program: 'target\\client.exe', args: ['--windowed', '--size 1280x720'], cwd: '', env: { SAVE: 'C:\\s' }, watch: ['src'] };
const confirmed = (extra = {}) => ({ status: 'confirmed', command: COMMAND, confirmedAt: 1, ...extra });

// A promise the test settles by hand.
function gate() {
  const out = {};
  out.promise = new Promise((resolve) => { out.resolve = resolve; });
  return out;
}

function setup(options = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <aside id="artifactReviewPanel" class="artifact-review-panel hidden">
      <div class="artifact-panel-header"><div data-artifact-panel-title-slot></div><div class="artifact-panel-header-actions"><button id="artifactReviewCollapseButton">x</button></div></div>
      <div id="content"></div>
    </aside></body>`, { pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const panelEl = doc.getElementById('artifactReviewPanel');
  const ctx = {
    window, doc, panelEl, surface: { previewContent: doc.getElementById('content') },
    calls: [], events: [], opens: [], toggles: 0, inserts: [], sends: [], streams: [], clock: 0, timers: [], nextTimer: 1,
    offState: 0, offKeep: 0, visibility: 'visible', layout: { width: 340, room: 1400, sets: [] },
    state: {
      currentSessionId: 'c1',
      sessions: [{ id: 'c1', project_id: 'p1', title: 'Combat balance' }, { id: 'c2', project_id: 'p1', title: 'Map editor' }, { id: 'c3', project_id: 'p2', title: 'Elsewhere' }],
      features: { featureFlags: {} },
    },
    answers: { get: { ok: true, command: confirmed(), run: null }, output: { ok: true, lines: [], droppedBytes: 0 }, armCapture: { ok: true, sourceId: 'w1' } },
    gates: {},
  };
  const method = (name) => (payload) => {
    ctx.calls.push([name, payload]);
    ctx.events.push(`call:${name}`);
    const answer = ctx.answers[name] ?? { ok: true };
    const wait = ctx.gates[name];
    return (wait ? wait.promise : Promise.resolve()).then(() => (typeof answer === 'function' ? answer(payload) : answer)).then((value) => {
      ctx.events.push(`done:${name}`);
      return value;
    });
  };
  const bridge = Object.fromEntries(['get', 'confirmCommand', 'start', 'restart', 'stop', 'showWindow', 'armCapture', 'output'].map((name) => [name, method(name)]));
  bridge.onState = (fn) => { ctx.pushState = fn; return () => { ctx.offState += 1; }; };
  bridge.onKeepLastFrame = (fn) => { ctx.pushKeep = fn; return () => { ctx.offKeep += 1; }; };
  if (options.restartSwitch !== false) bridge.setRestartAfterChanges = method('setRestartAfterChanges');
  const track = () => { const t = { stopped: false, stop() { t.stopped = true; } }; return t; };
  const windowRef = {
    document: doc, innerWidth: 1400, innerHeight: 900, MutationObserver: window.MutationObserver,
    inventory: { actionButton, popover }, inventoryTextField: textField,
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => { const id = ctx.nextTimer++; ctx.timers.push({ id, fn, at: ctx.clock + ms }); return id; },
    clearTimeout: (id) => { ctx.timers = ctx.timers.filter((timer) => timer.id !== id); },
    jennyShell: { runView: bridge },
    rendererSendChatPrompt: (text) => ctx.sends.push(text),
    navigator: { mediaDevices: { getDisplayMedia: (constraints) => {
      ctx.events.push('gdm');
      const t = track();
      ctx.streams.push({ constraints, track: t });
      return Promise.resolve({ getTracks: () => [t] });
    } } },
  };
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => ctx.visibility });
  ctx.windowRef = windowRef;
  ctx.showRail = (mode) => { panelEl.dataset.artifactReviewMode = mode; panelEl.classList.remove('hidden'); };
  ctx.panel = panelModule.createLiveRunPanel({
    state: ctx.state, windowRef, dom: { artifactReviewPanel: panelEl }, now: () => ctx.clock,
    openArtifactRail: (mode, opts) => { ctx.opens.push([mode, opts]); ctx.showRail(mode); },
    renderArtifactReviewPanel: () => ctx.panel.renderRailContent(ctx.surface),
    toggleArtifactReview: () => { ctx.toggles += 1; panelEl.classList.add('hidden'); },
    getPanelSessionId: () => ctx.state.currentSessionId,
    insertIntoComposer: (payload) => { ctx.inserts.push(payload); return true; },
    getLayoutHost: () => (options.layout === false ? null : { size: {
      get: () => ({ width: ctx.layout.width, room: ctx.layout.room }),
      set: (px) => { ctx.layout.sets.push(px); ctx.layout.width = px; return true; },
    } }),
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,AAAA' }),
  });
  ctx.panel.bind();
  toggleSwitch.initToggleHandlers(doc);
  // The clock moves in whole steps; each due timer runs once, after the clock reaches it.
  ctx.tick = async (ms) => {
    ctx.clock += ms;
    const due = ctx.timers.filter((timer) => timer.at <= ctx.clock);
    ctx.timers = ctx.timers.filter((timer) => timer.at > ctx.clock);
    due.forEach((timer) => timer.fn());
    await settle();
  };
  ctx.open = async () => { ctx.panel.open(); await settle(); await settle(); };
  ctx.push = async (snapshot) => { ctx.pushState(snapshot); await settle(); await settle(); };
  ctx.loadWith = async (run, command = confirmed()) => {
    ctx.answers.get = { ok: true, command, run };
    await ctx.open();
  };
  ctx.hide = async () => { panelEl.classList.add('hidden'); await settle(); };
  ctx.show = async () => { panelEl.classList.remove('hidden'); await settle(); };
  ctx.named = (name) => ctx.calls.filter((call) => call[0] === name);
  ctx.text = (selector = '.lv-shell') => doc.querySelector(selector)?.textContent || '';
  ctx.bar = (action) => doc.querySelector(`.artifact-panel-header [data-live-action="${action}"]`);
  ctx.body = (action) => doc.querySelector(`.lv-shell [data-live-action="${action}"]`);
  ctx.click = async (node) => { node.click(); await settle(); await settle(); };
  ctx.key = (node, key) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  ctx.field = (name) => doc.querySelector(`[data-lv-field="${name}"]`);
  ctx.setField = (name, value) => { ctx.field(name).value = value; };
  ctx.stateLine = () => doc.querySelector('.lv-line .bu-status-text')?.textContent || '';
  ctx.close = () => ctx.panel.dispose();
  return ctx;
}

module.exports = { settle, gate, setup, snap, confirmed, COMMAND, STATES };
