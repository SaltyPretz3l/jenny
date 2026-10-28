'use strict';

// Boot-milestone audit marks (row 62 instrumentation): process-start (main),
// first-contentful-paint / composer-interactive (probe), shell-hydrated
// (curtain controller), session-list-painted / last-chat-restored (session
// lifecycle). All are audit-only: nothing here changes boot behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createStartupAudit } = require('../services/main/startup-audit');

const PROBE_PATH = path.resolve(__dirname, '../renderer/shared/startup-audit-renderer-probe.js');

function withGlobals(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = Object.prototype.hasOwnProperty.call(globalThis, key) ? globalThis[key] : undefined;
    globalThis[key] = overrides[key];
  }
  const restore = () => {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function loadProbe(extraGlobals = {}) {
  const globals = {
    document: { currentScript: { dataset: { startupAuditPhase: 'mark' } }, readyState: 'loading', scripts: [] },
    jennyShell: { diagnostics: {} },
    __jennyStartupAudit: undefined,
    performance: { now: () => 5, timeOrigin: 1_000_000, mark() {} },
    ...extraGlobals,
  };
  return withGlobals(globals, () => {
    delete require.cache[PROBE_PATH];
    require(PROBE_PATH);
    const audit = globalThis.__jennyStartupAudit;
    delete require.cache[PROBE_PATH];
    return audit;
  });
}

// --- main: process-start --------------------------------------------------

test('process-start is emitted with the Electron creation time, before main-entry', () => {
  const logs = [];
  const audit = createStartupAudit({
    env: { JENNY_COLD_START_AUDIT: '1', JENNY_COLD_START_AUDIT_RUN_ID: 'run-1' },
    log: (...entry) => logs.push(entry),
    processRef: { getCreationTime: () => 1234.4 },
  });
  audit.emitMainEntryMark({ mainModuleEntryAt: 1500, appStartupStartedAt: 1900 });
  assert.deepEqual(logs.map((entry) => entry[2].mark), ['process-start', 'main-entry']);
  assert.equal(logs[0][2].ts_ms, 1234);
  assert.equal(logs[0][2].basis, 'process.getCreationTime');
  assert.equal(logs[0][2].audit_run_id, 'run-1');
});

test('process-start is skipped when the runtime has no creation time, and when the audit is off', () => {
  for (const processRef of [{}, { getCreationTime: () => null }, { getCreationTime: () => { throw new Error('x'); } }]) {
    const logs = [];
    const audit = createStartupAudit({ env: { JENNY_COLD_START_AUDIT: '1' }, log: (...e) => logs.push(e), processRef });
    audit.emitProcessStartMark();
    assert.equal(logs.length, 0);
  }
  const logs = [];
  const audit = createStartupAudit({ env: {}, log: (...e) => logs.push(e), processRef: { getCreationTime: () => 99 } });
  audit.emitMainEntryMark({ mainModuleEntryAt: 1, appStartupStartedAt: 2 });
  assert.equal(logs.length, 0);
});

// --- renderer probe ---------------------------------------------------------

test('markOnce records a milestone once and mark honours a captured timestamp', () => {
  const audit = loadProbe();
  assert.equal(audit.markOnce('session-list-painted', { sessionCount: 3 }), true);
  assert.equal(audit.markOnce('session-list-painted', { sessionCount: 4 }), false);
  audit.mark('late-observed', {}, { tsMs: 4242.6 });
  assert.equal(audit.marks.filter((entry) => entry.mark === 'session-list-painted').length, 1);
  assert.equal(audit.marks[0].details.sessionCount, 3);
  assert.equal(audit.marks.at(-1).ts_ms, 4243);
});

test('first-contentful-paint is observed only once the audit is enabled, at the paint time', () => {
  const observers = [];
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(options) { this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const audit = loadProbe({ PerformanceObserver: FakeObserver });
  withGlobals({ PerformanceObserver: FakeObserver, performance: { now: () => 5, timeOrigin: 1_000_000, mark() {} } }, () => {
    audit.enable({ enabled: false });
    assert.equal(observers.length, 0, 'a disabled audit installs no observer');
    audit.enable({ enabled: true, runId: 'r' });
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].options, { type: 'paint', buffered: true });
    observers[0].callback({ getEntries: () => [
      { name: 'first-paint', startTime: 100 },
      { name: 'first-contentful-paint', startTime: 180.4 },
    ] });
  });
  const fcp = audit.marks.filter((entry) => entry.mark === 'first-contentful-paint');
  assert.equal(fcp.length, 1);
  assert.equal(fcp[0].ts_ms, 1_000_180);
  assert.equal(observers[0].disconnected, true);
});

function fakeComposerDocument(input) {
  return { body: {}, getElementById: (id) => (id === 'chatInput' ? input : null) };
}

test('composer-interactive marks immediately when the composer is usable', () => {
  const audit = loadProbe();
  const input = { disabled: false, readOnly: false, closest: () => null, getClientRects: () => [{}] };
  audit.markComposerInteractive(fakeComposerDocument(input), 'curtain-removed');
  audit.markComposerInteractive(fakeComposerDocument(input), 'curtain-removed');
  const marks = audit.marks.filter((entry) => entry.mark === 'composer-interactive');
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].details, { source: 'curtain-removed' });
});

test('composer-interactive waits for a disabled, inert or hidden composer (audit on only)', () => {
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const input = { disabled: true, readOnly: false, closest: () => null, getClientRects: () => [{}] };
  const doc = fakeComposerDocument(input);
  const audit = loadProbe();
  withGlobals({ MutationObserver: FakeMutationObserver }, () => {
    audit.markComposerInteractive(doc, 'curtain-removed');
    assert.equal(observers.length, 0, 'a disabled audit does not watch the composer');
    audit.enabled = true;
    audit.markComposerInteractive(doc, 'curtain-removed');
    assert.equal(observers.length, 1);
    observers[0].callback([]);
    assert.equal(audit.marks.some((entry) => entry.mark === 'composer-interactive'), false);
    input.disabled = false;
    input.closest = () => ({});
    observers[0].callback([]);
    assert.equal(audit.marks.some((entry) => entry.mark === 'composer-interactive'), false, 'inert ancestor');
    input.closest = () => null;
    input.getClientRects = () => [];
    observers[0].callback([]);
    assert.equal(audit.marks.some((entry) => entry.mark === 'composer-interactive'), false, 'hidden composer');
    input.getClientRects = () => [{}];
    observers[0].callback([]);
  });
  const marks = audit.marks.filter((entry) => entry.mark === 'composer-interactive');
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].details, { source: 'curtain-removed', deferred: true });
  assert.equal(observers[0].disconnected, true);
  clearTimeout(audit.composerWatch.timer);
});

// --- curtain controller -----------------------------------------------------

function recordingAudit() {
  const calls = [];
  return {
    calls,
    mark(name) { calls.push(['mark', name]); },
    markOnce(name) { calls.push(['markOnce', name]); return true; },
    markComposerInteractive(doc, source) { calls.push(['composer', source, Boolean(doc)]); },
  };
}

test('the curtain controller marks shell-hydrated and composer-interactive at curtain removal', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="startupOverlay"><div class="startup-card"></div></div><textarea id="chatInput"></textarea></body>');
  const audit = recordingAudit();
  const { createLifecycleProgressController } = require('../renderer/shell/renderer-lifecycle-progress-utils.js');
  withGlobals({ __jennyStartupAudit: audit, document: dom.window.document }, () => {
    const startupOverlay = dom.window.document.getElementById('startupOverlay');
    const controller = createLifecycleProgressController({
      state: { ui: { activeView: 'chat' }, lifecycleProgress: {} },
      constants: { ACTIVITY_SCOPE: { lifecycleStartup: 's', lifecycleShutdown: 'd', lifecycleModelSwitch: 'm' } },
      dom: { startupOverlay },
      callbacks: { beginActivity() {}, resolveActivity() {}, failActivity() {}, onStartupReady() {} },
    });
    try {
      controller.notifyBootViewReady();
      assert.deepEqual(audit.calls, []);
      controller.notifyShellHydrated();
      controller.notifyShellHydrated();
      assert.deepEqual(audit.calls, [['markOnce', 'shell-hydrated']]);
      startupOverlay.dispatchEvent(new dom.window.Event('transitionend'));
      assert.deepEqual(audit.calls.slice(1), [['mark', 'shell-interactive'], ['composer', 'curtain-removed', true]]);
    } finally {
      controller.dispose();
    }
  });
  dom.window.close();
});

// --- session lifecycle --------------------------------------------------------

function createLoadSessionsHarness({ sessions, messages }) {
  const { createSessionLifecycleController } = require('../renderer/shell/renderer-session-lifecycle-utils');
  const order = [];
  const state = {
    auth: { authenticated: true },
    sessions: [],
    currentSessionId: '',
    messagesBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    pendingStreams: new Map(),
    interactiveDraftsBySession: new Map(),
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: {
        async list() { return { data: sessions }; },
        async getMessages() { return { data: messages, turn_events: [] }; },
      },
      chat: { async getActiveTurnState() { return null; } },
    },
    callbacks: {
      renderSessions: () => order.push('renderSessions'),
      renderAll: () => order.push('renderAll'),
      setSessionMessages: (id, rows) => state.messagesBySession.set(id, rows),
    },
  });
  return { controller, state, order };
}

test('loadSessions marks the painted list, then the restored chat, once each', async () => {
  const audit = loadProbe();
  const seen = [];
  const originalMarkOnce = audit.markOnce.bind(audit);
  audit.markOnce = (name, details) => {
    seen.push({ name, details });
    return originalMarkOnce(name, details);
  };
  const { controller, order } = createLoadSessionsHarness({
    sessions: [{ id: 'newest' }, { id: 'stored-active' }],
    messages: [{ id: 'm1', role: 'user', content: 'hi' }, { id: 'm2', role: 'assistant', content: 'yo' }],
  });
  await withGlobals({ __jennyStartupAudit: audit }, async () => {
    await controller.loadSessions('stored-active');
    await controller.loadSessions('stored-active');
  });
  assert.deepEqual(order.slice(0, 2), ['renderSessions', 'renderAll']);
  const milestones = audit.marks.map((entry) => ({ mark: entry.mark, details: entry.details }));
  assert.deepEqual(milestones, [
    { mark: 'session-list-painted', details: { sessionCount: 2 } },
    { mark: 'last-chat-restored', details: { sessionId: 'stored-active', messageCount: 2 } },
  ]);
  assert.equal(seen[0].name, 'session-list-painted');
});

test('loadSessions with no chats marks the list but no restored chat', async () => {
  const audit = loadProbe();
  const { controller } = createLoadSessionsHarness({ sessions: [], messages: [] });
  await withGlobals({ __jennyStartupAudit: audit }, () => controller.loadSessions(''));
  assert.deepEqual(audit.marks.map((entry) => entry.mark), ['session-list-painted']);
});
