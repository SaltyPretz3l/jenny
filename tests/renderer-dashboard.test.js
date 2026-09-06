const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createDashboardRegistry } = require('../renderer/features/renderer-dashboard-registry.js');
const { createDashboardManager } = require('../renderer/features/renderer-dashboard-manager.js');
const dashboardRegistryModule = require('../renderer/features/renderer-dashboard-registry.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');

function createDom() {
  const dom = new JSDOM('<main><div id="homeInfoStrip" hidden></div><section id="homeDashboardGrid"></section></main>');
  return {
    documentRef: dom.window.document,
    grid: dom.window.document.getElementById('homeDashboardGrid'),
    infoStrip: dom.window.document.getElementById('homeInfoStrip'),
  };
}

function createLogCapture() {
  const entries = [];
  return {
    entries,
    appendClientLog: (level, event, details) => {
      entries.push({ level, event, details });
    },
  };
}

function createFakeShell() {
  const listeners = { scheduler: [], weather: [], stats: [] };
  const makeSubscribe = (bucket) => (callback) => {
    listeners[bucket].push(callback);
    return () => {
      listeners[bucket] = listeners[bucket].filter((entry) => entry !== callback);
    };
  };
  return {
    listeners,
    shell: {
      scheduler: {
        getState: async () => ({
          upcoming: [{ id: 'task-1', label: 'Nightly health check', eta: 'in 2h' }],
          running: [],
          generatedAt: '2026-06-11T00:00:00.000Z',
          relevant: true,
          lifecycle: { phase: 'running', qualifyingTaskCount: 1 },
        }),
        onChanged: makeSubscribe('scheduler'),
      },
      weather: {
        getState: async () => ({
          available: true,
          configured: true,
          tempC: 21,
          tempF: 69.8,
          description: 'clear',
        }),
        onChanged: makeSubscribe('weather'),
      },
      home: {
        // applyHomeConfigPayload() adopts a payload only if it is a COMPLETE
        // home config (links/weather/widgets/calendar/focusMode/
        // showContextualTips plus a full scratchpad); anything short is dropped
        // and state.homeConfig silently keeps its empty defaults. Model the real
        // shape here rather than the two fields this test reads.
        getConfig: async () => ({
          links: [{ id: 'group-1', name: 'Lab', tiles: [] }],
          weather: { lat: 30.1, lon: -95.5, units: 'metric' },
          widgets: {},
          scratchpad: { notes: [], activeNoteId: '', settings: {}, pins: [] },
          calendar: {},
          focusMode: false,
          showContextualTips: true,
        }),
      },
      system: {
        onStats: makeSubscribe('stats'),
      },
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('dashboard registry renders registered widgets as cards in registration order', () => {
  const { documentRef, grid } = createDom();
  const log = createLogCapture();
  const registry = createDashboardRegistry({ documentRef, appendClientLog: log.appendClientLog });

  assert.equal(registry.register({ id: 'alpha', title: 'Alpha', render: (body) => { body.textContent = 'a'; } }), true);
  assert.equal(registry.register({ id: 'beta', title: 'Beta', render: (body) => { body.textContent = 'b'; } }), true);

  const counts = registry.renderInto(grid, { state: {} });
  assert.deepEqual(counts, { rendered: 2, skipped: 0, failed: 0 });
  const cards = Array.from(grid.children);
  assert.deepEqual(cards.map((card) => card.dataset.widgetId), ['alpha', 'beta']);
  assert.equal(cards[0].querySelector('.dashboard-card__title').textContent, 'Alpha');
  assert.equal(cards[0].querySelector('.dashboard-card__body').textContent, 'a');
  assert.deepEqual(log.entries, []);
});

test('dashboard registry rejects invalid descriptors and duplicate ids', () => {
  const { documentRef } = createDom();
  const log = createLogCapture();
  const registry = createDashboardRegistry({ documentRef, appendClientLog: log.appendClientLog });

  assert.equal(registry.register({ id: 'no render', title: 'Bad' }), false);
  assert.equal(registry.register({ id: 'bad id!', render: () => {} }), false);
  assert.equal(registry.register({ id: 'dupe', render: () => {} }), true);
  assert.equal(registry.register({ id: 'dupe', render: () => {} }), false);
  assert.deepEqual(registry.list().map((widget) => widget.id), ['dupe']);
  assert.deepEqual(
    log.entries.map((entry) => entry.event),
    ['home.dashboard_widget_rejected', 'home.dashboard_widget_rejected', 'home.dashboard_widget_duplicate']
  );
});

test('dashboard registry contains a throwing widget to its own card', () => {
  const { documentRef, grid } = createDom();
  const log = createLogCapture();
  const registry = createDashboardRegistry({ documentRef, appendClientLog: log.appendClientLog });
  registry.register({ id: 'boom', title: 'Boom', render: () => { throw new Error('widget exploded'); } });
  registry.register({ id: 'steady', title: 'Steady', render: (body) => { body.textContent = 'ok'; } });

  const counts = registry.renderInto(grid, { state: {} });
  assert.deepEqual(counts, { rendered: 1, skipped: 0, failed: 1 });
  const boomCard = grid.children[0];
  assert.equal(boomCard.dataset.widgetState, 'error');
  assert.match(boomCard.querySelector('.dashboard-card__body').textContent, /hit an error/);
  assert.equal(grid.children[1].querySelector('.dashboard-card__body').textContent, 'ok');
  assert.equal(log.entries[0].event, 'home.dashboard_widget_render_failed');
  assert.equal(log.entries[0].details.widgetId, 'boom');
  assert.match(log.entries[0].details.message, /widget exploded/);
});

test('dashboard registry clears render keys on the error path so retries actually run', () => {
  const { documentRef, grid } = createDom();
  const registry = createDashboardRegistry({ documentRef, appendClientLog: () => {} });
  let failNext = false;
  registry.register({
    id: 'keyed',
    title: 'Keyed',
    render: (body) => {
      if (body.dataset.keyedRenderKey === 'stable') {
        return;
      }
      if (failNext) {
        throw new Error('transient failure');
      }
      body.textContent = 'content';
      body.dataset.keyedRenderKey = 'stable';
    },
  });

  registry.renderInto(grid, { state: {} });
  const body = grid.children[0].querySelector('.dashboard-card__body');
  assert.equal(body.textContent, 'content');

  // A repaint after a failure must not be skipped by the stale key: the error
  // path replaced the body content, so the promised retry has to re-render.
  body.dataset.keyedRenderKey = '';
  failNext = true;
  registry.renderInto(grid, { state: {} });
  assert.match(body.textContent, /hit an error/);
  assert.equal(body.dataset.keyedRenderKey, undefined);

  failNext = false;
  registry.renderInto(grid, { state: {} });
  assert.equal(body.textContent, 'content');
  assert.equal(grid.children[0].dataset.widgetState, undefined);
});

test('dashboard registry repaints idempotently, reusing existing card nodes', () => {
  const { documentRef, grid } = createDom();
  const registry = createDashboardRegistry({ documentRef });
  let renders = 0;
  registry.register({ id: 'alpha', render: () => { renders += 1; } });

  registry.renderInto(grid, { state: {} });
  const firstCard = grid.children[0];
  registry.renderInto(grid, { state: {} });
  assert.equal(grid.children.length, 1);
  assert.equal(grid.children[0], firstCard);
  assert.equal(renders, 2);

  const stray = documentRef.createElement('section');
  stray.dataset.widgetId = 'unregistered';
  grid.append(stray);
  registry.renderInto(grid, { state: {} });
  assert.deepEqual(Array.from(grid.children).map((card) => card.dataset.widgetId), ['alpha']);
});

test('dashboard manager seeds state slices and primes them over the bridge on first render', async () => {
  const { documentRef, grid, infoStrip } = createDom();
  const { shell } = createFakeShell();
  const state = { ui: { activeView: 'home' } };
  let probeRenders = 0;
  const manager = createDashboardManager({
    state,
    documentRef,
    shell,
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: { dashboardRegistry: dashboardRegistryModule },
    callbacks: { appendClientLog: () => {} },
  });
  manager.registry.register({ id: 'probe', render: () => { probeRenders += 1; } });

  assert.deepEqual(state.scheduler, {
    upcoming: [], running: [], generatedAt: '', relevant: false, lifecycle: null,
  });
  assert.equal(state.weather.configured, false);
  assert.deepEqual(state.homeConfig.links, []);

  const counts = manager.render();
  assert.deepEqual(counts, { rendered: 1, skipped: 0, failed: 0 });
  assert.equal(probeRenders, 1);

  await settle();
  assert.equal(state.scheduler.upcoming.length, 1);
  assert.equal(state.scheduler.upcoming[0].label, 'Nightly health check');
  assert.equal(state.weather.tempC, 21);
  assert.equal(state.homeConfig.links[0].name, 'Lab');
  assert.equal(probeRenders, 2, 'prime resolution repaints the active home view');

  manager.render();
  await settle();
  assert.equal(probeRenders, 3, 'subsequent renders paint once without re-priming');
});

test('dashboard edit controls describe move and hide actions in tooltips', () => {
  const { documentRef, grid, infoStrip } = createDom();
  const state = { ui: { activeView: 'home', dashboardEditMode: true } };
  const manager = createDashboardManager({
    state,
    documentRef,
    shell: null,
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: { dashboardRegistry: dashboardRegistryModule },
    actionButton: inventoryActionButton,
    callbacks: { appendClientLog: () => {} },
  });
  manager.registry.register({ id: 'probe', title: 'Probe', render: () => {} });
  manager.render();

  assert.equal(grid.querySelector('[data-widget-edit="up"]').title, 'Move Probe earlier');
  assert.equal(grid.querySelector('[data-widget-edit="down"]').title, 'Move Probe later');
  assert.equal(grid.querySelector('[data-widget-edit="hide"]').title, 'Hide Probe');
});

test('dashboard manager applies change events and repaints only while home is active', async () => {
  const { documentRef, grid, infoStrip } = createDom();
  const { shell, listeners } = createFakeShell();
  const state = { ui: { activeView: 'home' } };
  let probeRenders = 0;
  const manager = createDashboardManager({
    state,
    documentRef,
    shell,
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: { dashboardRegistry: dashboardRegistryModule },
    callbacks: { appendClientLog: () => {} },
  });
  manager.registry.register({ id: 'probe', render: () => { probeRenders += 1; } });
  manager.bind();
  manager.bind();
  assert.equal(listeners.scheduler.length, 1, 'bind subscribes once');
  assert.equal(listeners.stats.length, 0, 'Home does not subscribe to system stats');

  listeners.scheduler[0]({ upcoming: [], running: [{ id: 'run-1', label: 'Sweep' }], generatedAt: 'g2' });
  assert.equal(state.scheduler.running[0].label, 'Sweep');
  assert.equal(probeRenders, 1);

  state.ui.activeView = 'chat';
  listeners.weather[0]({ tempC: 5 });
  assert.equal(state.weather.tempC, 5, 'state stays fresh while home is inactive');
  assert.equal(probeRenders, 1, 'no repaint while home is inactive');

  manager.dispose();
  assert.equal(listeners.scheduler.length, 0);
  assert.equal(listeners.weather.length, 0);
  assert.equal(listeners.stats.length, 0);
});

test('dashboard manager does not repaint for system-stats events', () => {
  const { documentRef, grid, infoStrip } = createDom();
  const { shell, listeners } = createFakeShell();
  const state = { ui: { activeView: 'home' } };
  let probeRenders = 0;
  const manager = createDashboardManager({
    state,
    documentRef,
    shell,
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: { dashboardRegistry: dashboardRegistryModule },
    callbacks: { appendClientLog: () => {} },
  });
  manager.registry.register({ id: 'probe', render: () => { probeRenders += 1; } });
  manager.bind();

  assert.equal(listeners.stats.length, 0, 'no stats listener is registered');
  for (const listener of listeners.stats) listener({ cpuPercent: 10 });
  assert.equal(probeRenders, 0, 'a stats event has no dashboard paint path');
});

test('dashboard manager render is a safe no-op without a grid element', () => {
  const state = { ui: { activeView: 'home' } };
  const manager = createDashboardManager({
    state,
    documentRef: null,
    shell: null,
    dom: {},
    modules: { dashboardRegistry: dashboardRegistryModule },
    callbacks: { appendClientLog: () => {} },
  });
  assert.equal(manager.render(), null);
});

test('dashboard manager disposal fences the initial refresh and rejects later renders', async () => {
  const { documentRef, grid, infoStrip } = createDom();
  const pending = [];
  const read = () => new Promise((resolve) => pending.push(resolve));
  const state = { ui: { activeView: 'home' } };
  let probeRenders = 0;
  const manager = createDashboardManager({
    state,
    documentRef,
    shell: {
      scheduler: { getState: read },
      weather: { getState: read },
      home: { getConfig: read, getAiJournal: read },
      proactive: { getState: read },
      calendar: { getState: read },
    },
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: { dashboardRegistry: dashboardRegistryModule },
    callbacks: { appendClientLog: () => {} },
  });
  manager.registry.register({ id: 'probe', render: () => { probeRenders += 1; } });

  manager.render();
  assert.equal(probeRenders, 1);
  await manager.dispose();
  for (const resolve of pending) resolve({ upcoming: [{ id: 'late' }] });
  await settle();

  assert.equal(probeRenders, 1);
  assert.deepEqual(state.scheduler.upcoming, []);
  assert.equal(manager.render(), null);
  assert.equal(probeRenders, 1);
});
