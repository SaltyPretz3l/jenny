const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

// Home dashboard manager review fixes (2026-10-25): column-local reorder,
// focus-mode revert, and the calendar push/reply repaint dedupe.
const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const { createDashboardManager } = require('../renderer/features/renderer-dashboard-manager.js');
const dashboardRegistryModule = require('../renderer/features/renderer-dashboard-registry.js');
const pageMenuModule = require('../renderer/features/renderer-dashboard-page-menu.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryPopover = require('../renderer/inventory/popover.js');

function createDom() {
  const dom = new JSDOM('<main><div id="homeInfoStrip" hidden></div><section id="homeDashboardGrid"></section></main>');
  return {
    documentRef: dom.window.document,
    grid: dom.window.document.getElementById('homeDashboardGrid'),
    infoStrip: dom.window.document.getElementById('homeInfoStrip'),
  };
}

function stubWidgetModules(overrides = {}) {
  const render = (body) => { body.textContent = 'x'; };
  return {
    dashboardRegistry: dashboardRegistryModule,
    dashboardWidgetsCore: widgetsCore,
    dashboardPageMenu: pageMenuModule,
    dashboardWidgetsScratchpad: { createScratchpadWidget: () => ({ id: 'scratchpad', title: 'Scratchpad', render }) },
    dashboardScratchpadActions: { createScratchpadActions: () => ({}) },
    dashboardCalendar: { createCalendarWidget: () => ({ id: 'calendar', title: 'Calendar', render }) },
    ...overrides,
  };
}

test('edit layout reorders within a card column and keeps hidden ids in the saved order', async () => {
  const { documentRef, grid, infoStrip } = createDom();
  const rail = documentRef.createElement('aside');
  documentRef.body.appendChild(rail);
  const updates = [];
  const state = {
    ui: { activeView: 'home', dashboardEditMode: true },
    homeConfig: { widgets: { order: [], hidden: [] } },
  };
  const manager = createDashboardManager({
    state,
    documentRef,
    shell: { home: { updateConfig: async (patch) => { updates.push(patch); return null; } } },
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid, homeDashboardRail: rail },
    actionButton: inventoryActionButton,
    modules: stubWidgetModules(),
    inventory: { popover: inventoryPopover },
    callbacks: { appendClientLog: () => {} },
  });
  manager.registry.register({ id: 'probe', title: 'Probe', render: (body) => { body.textContent = 'p'; } });
  const click = (el) => el.dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));
  manager.bind();
  manager.render();
  // The scratchpad sits in the rail: Calendar is first in the main column, so
  // "up" has no main-column neighbour and must not swap across columns.
  click(grid.querySelector('[data-widget-edit="up"][data-widget-id="calendar"]'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, []);

  state.homeConfig = { widgets: { order: [], hidden: ['scratchpad'] } };
  manager.render();
  click(grid.querySelector('[data-widget-edit="up"][data-widget-id="probe"]'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [{ widgets: { order: ['scratchpad', 'probe', 'calendar'] } }]);
  manager.dispose();
});

test('a refused focus-mode write restores the prior mode', async () => {
  const { documentRef, grid, infoStrip } = createDom();
  const state = { ui: { activeView: 'home' }, homeConfig: { widgets: { order: [], hidden: [] }, focusMode: false } };
  const manager = createDashboardManager({
    state,
    documentRef,
    shell: { home: { updateConfig: async () => { throw new Error('home_config_write_failed'); } } },
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: stubWidgetModules(),
    inventory: { popover: inventoryPopover },
    callbacks: { appendClientLog: () => {} },
  });
  manager.bind();
  manager.render();
  const win = documentRef.defaultView;
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true }));
  assert.equal(state.homeConfig.focusMode, true, 'optimistic flip');
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, repeat: true }));
  assert.equal(state.homeConfig.focusMode, true, 'auto-repeat of the held chord is ignored');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.homeConfig.focusMode, false);
  assert.equal(grid.dataset.focusMode, undefined);
  manager.dispose();
});

test('an identical calendar snapshot (push then invoke reply) repaints Home once', () => {
  const { documentRef, grid, infoStrip } = createDom();
  let push = null;
  let calendarRenders = 0;
  const manager = createDashboardManager({
    state: { ui: { activeView: 'home' } },
    documentRef,
    shell: { calendar: { onChanged: (fn) => { push = fn; return () => {}; } } },
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: stubWidgetModules({
      dashboardCalendar: { createCalendarWidget: () => ({ id: 'calendar', title: 'Calendar', render: () => { calendarRenders += 1; } }) },
    }),
    callbacks: { appendClientLog: () => {} },
  });
  manager.bind();
  const snapshot = (generatedAt) => ({ generatedAt, instances: [{ instanceId: 'a', start: '2026-06-11T09:00', end: '2026-06-11T10:00' }] });
  push(snapshot('g1'));
  push(snapshot('g2'));
  assert.equal(calendarRenders, 1, 'only generatedAt differs: one paint');
  push({ ...snapshot('g3'), instances: [] });
  assert.equal(calendarRenders, 2);
  manager.dispose();
});
