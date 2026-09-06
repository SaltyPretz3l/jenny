const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const { createDashboardManager } = require('../renderer/features/renderer-dashboard-manager.js');
const dashboardRegistryModule = require('../renderer/features/renderer-dashboard-registry.js');
const daybookModule = require('../renderer/features/renderer-dashboard-daybook.js');
const pageMenuModule = require('../renderer/features/renderer-dashboard-page-menu.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

/* ---------------------------------------------------------------------------
 * Daybook slot routing: the registry paints each widget into the host named by
 * its slot (ctx.slotHosts), and keeps every other guarantee — order, hidden,
 * flags, per-card containment — host-agnostic. Split out of
 * renderer-dashboard-widgets.test.js to keep both files under the 600-line
 * test-file ratchet.
 * ------------------------------------------------------------------------- */

// Same rationale as renderer-dashboard-widgets.test.js: the manager test
// exercises layout machinery, which is widget-agnostic, so the real surviving
// widget IDS render through the manager's real module slots with trivial
// bodies. dashboardWidgetsCore and dashboardPageMenu are real modules — they
// own the info strip and the [⋯] page menu holding the focus item the
// Daybook test clicks.
function stubWidgetModules(overrides = {}) {
  const render = (body) => { body.textContent = 'x'; };
  return {
    dashboardRegistry: dashboardRegistryModule,
    dashboardWidgetsCore: widgetsCore,
    dashboardPageMenu: pageMenuModule,
    dashboardWidgetsScratchpad: {
      createScratchpadWidget: () => ({ id: 'scratchpad', title: 'Scratchpad', render }),
    },
    dashboardScratchpadActions: { createScratchpadActions: () => ({}) },
    dashboardCalendar: {
      createCalendarWidget: () => ({ id: 'calendar', title: 'Calendar', render }),
    },
    ...overrides,
  };
}

function createDaybookDom() {
  const dom = new JSDOM(''
    + '<main><div class="home-daybook" id="homeDaybook">'
    + '<div id="homeInfoStrip" hidden></div>'
    + '<section id="homeDashboardGrid"></section>'
    + '<div id="homeRailResizer" role="separator" tabindex="0"></div>'
    + '<div id="homeRailGrip" aria-hidden="true"></div>'
    + '<div id="homeDashboardRail"></div>'
    + '</div></main>');
  const documentRef = dom.window.document;
  const byId = (id) => documentRef.getElementById(id);
  return {
    documentRef,
    daybook: byId('homeDaybook'),
    grid: byId('homeDashboardGrid'),
    rail: byId('homeDashboardRail'),
    resizer: byId('homeRailResizer'),
    grip: byId('homeRailGrip'),
    infoStrip: byId('homeInfoStrip'),
  };
}

const idsIn = (host) => Array.from(host.children).map((card) => card.dataset.widgetId);

test('registry routes widgets to their slot host and keeps order per column', () => {
  const { documentRef, grid, rail } = createDaybookDom();
  const registry = dashboardRegistryModule.createDashboardRegistry({ documentRef });
  const render = (body) => { body.textContent = 'x'; };
  registry.register({ id: 'pad', title: 'Pad', slot: 'rail', render });
  registry.register({ id: 'agenda', title: 'Agenda', render });
  registry.register({ id: 'loops', title: 'Loops', slot: 'main', render });
  registry.register({ id: 'notes', title: 'Notes', slot: 'rail', render });

  // slot is whitelisted, not passed through: an unknown value falls back.
  assert.ok(registry.register({ id: 'odd', title: 'Odd', slot: 'sidebar', render }));
  assert.deepEqual(
    registry.list().map((widget) => `${widget.id}:${widget.slot}`),
    ['pad:rail', 'agenda:main', 'loops:main', 'notes:rail', 'odd:main']
  );

  const counts = registry.renderInto(grid, { slotHosts: { main: grid, rail } });
  assert.deepEqual(counts, { rendered: 5, skipped: 0, failed: 0 });
  assert.deepEqual(idsIn(grid), ['agenda', 'loops', 'odd']);
  assert.deepEqual(idsIn(rail), ['pad', 'notes']);

  // A steady-state repaint churns nothing in either column.
  const settledMain = Array.from(grid.children);
  const settledRail = Array.from(rail.children);
  registry.renderInto(grid, { slotHosts: { main: grid, rail } });
  assert.deepEqual(Array.from(grid.children), settledMain);
  assert.deepEqual(Array.from(rail.children), settledRail);
});

test('a slot change MOVES the card instead of duplicating it', () => {
  const { documentRef, grid, rail } = createDaybookDom();
  const render = (body) => { body.textContent = 'x'; };
  const build = (padSlot) => {
    const registry = dashboardRegistryModule.createDashboardRegistry({ documentRef });
    registry.register({ id: 'pad', title: 'Pad', slot: padSlot, render });
    registry.register({ id: 'agenda', title: 'Agenda', render });
    return registry;
  };
  const ctx = { slotHosts: { main: grid, rail } };

  build('main').renderInto(grid, ctx);
  assert.deepEqual(idsIn(grid), ['pad', 'agenda']);
  const movedCard = grid.querySelector('[data-widget-id="pad"]');

  // Same DOM, a registry that now calls the pad a rail widget.
  build('rail').renderInto(grid, ctx);
  assert.deepEqual(idsIn(grid), ['agenda'], 'the old host lets go');
  assert.deepEqual(idsIn(rail), ['pad'], 'the new host receives it');
  assert.equal(rail.querySelector('[data-widget-id="pad"]'), movedCard, 'the SAME node moved');
  assert.equal(documentRef.querySelectorAll('[data-widget-id="pad"]').length, 1, 'no duplicate');
});

test('orphan sweep clears retired cards from every slot host', () => {
  const { documentRef, grid, rail } = createDaybookDom();
  const render = (body) => { body.textContent = 'x'; };
  const stale = (host, id) => {
    const card = documentRef.createElement('section');
    card.className = 'dashboard-card';
    card.dataset.widgetId = id;
    host.append(card);
  };
  stale(grid, 'retired-main');
  stale(rail, 'retired-rail');

  const registry = dashboardRegistryModule.createDashboardRegistry({ documentRef });
  registry.register({ id: 'pad', title: 'Pad', slot: 'rail', render });
  registry.register({ id: 'agenda', title: 'Agenda', render });
  registry.renderInto(grid, { slotHosts: { main: grid, rail } });

  assert.deepEqual(idsIn(grid), ['agenda']);
  assert.deepEqual(idsIn(rail), ['pad']);
});

test('a rail widget with no slotHosts falls back to the single grid host', () => {
  const { documentRef, grid, rail } = createDaybookDom();
  const registry = dashboardRegistryModule.createDashboardRegistry({ documentRef });
  const render = (body) => { body.textContent = 'x'; };
  registry.register({ id: 'pad', title: 'Pad', slot: 'rail', render });
  registry.register({ id: 'agenda', title: 'Agenda', render });

  // No slotHosts: pre-Daybook behavior, every card in registration order in
  // the one host, and the rail element untouched.
  registry.renderInto(grid, { widgetsConfig: { order: ['agenda'], hidden: [] } });
  assert.deepEqual(idsIn(grid), ['agenda', 'pad']);
  assert.equal(rail.children.length, 0);

  // Hidden semantics stay host-agnostic once slots are in play.
  registry.register({ id: 'hidden', title: 'Hidden', slot: 'rail', render });
  const counts = registry.renderInto(grid, {
    slotHosts: { main: grid, rail },
    widgetsConfig: { order: [], hidden: ['agenda', 'hidden'] },
  });
  assert.deepEqual(counts, { rendered: 1, skipped: 2, failed: 0 });
  assert.deepEqual(idsIn(grid), []);
  assert.deepEqual(idsIn(rail), ['pad']);
});

test('a rail widget that throws is contained to its own card', () => {
  const { documentRef, grid, rail } = createDaybookDom();
  const registry = dashboardRegistryModule.createDashboardRegistry({ documentRef });
  registry.register({
    id: 'pad',
    title: 'Pad',
    slot: 'rail',
    render() { throw new Error('pad exploded'); },
  });
  registry.register({ id: 'agenda', title: 'Agenda', render: (body) => { body.textContent = 'ok'; } });

  const counts = registry.renderInto(grid, { slotHosts: { main: grid, rail } });
  assert.deepEqual(counts, { rendered: 1, skipped: 0, failed: 1 });
  assert.equal(rail.querySelector('[data-widget-id="pad"]').dataset.widgetState, 'error');
  assert.equal(grid.querySelector('[data-widget-id="agenda"] .dashboard-card__body').textContent, 'ok');
});

test('the manager parks the scratchpad in the rail and dims the whole Daybook', async () => {
  const { documentRef, daybook, grid, rail, infoStrip } = createDaybookDom();
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  const state = {
    ui: { activeView: 'home' },
    homeConfig: { links: [], focusMode: false, layout: { railWidth: 420 } },
  };
  try {
    const manager = createDashboardManager({
      state,
      documentRef,
      shell: { home: { updateConfig: async (patch) => ({ ...state.homeConfig, ...patch }) } },
      dom: {
        homeInfoStrip: infoStrip,
        homeDashboardGrid: grid,
        homeDaybook: daybook,
        homeDashboardRail: rail,
        homeRailResizer: documentRef.getElementById('homeRailResizer'),
        homeRailGrip: documentRef.getElementById('homeRailGrip'),
      },
      modules: { ...stubWidgetModules(), dashboardDaybook: daybookModule },
      inventory: { popover: inventoryPopover },
      callbacks: { appendClientLog: () => {} },
    });
    manager.bind();
    manager.render();

    assert.deepEqual(idsIn(grid), ['calendar']);
    assert.deepEqual(idsIn(rail), ['scratchpad']);
    // The daybook controller adopts the persisted width on paint.
    assert.equal(daybook.style.getPropertyValue('--home-rail-width'), '420px');

    // Focus mode dims the whole Daybook (both columns), not just the main
    // grid. The control now lives in the [⋯] page menu beside the ask pill.
    const trigger = documentRef.getElementById('homePageMenuTrigger');
    assert.ok(trigger, 'the ask region renders the page-menu trigger');
    trigger.dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));
    documentRef.getElementById('homePageMenuPopover')
      .querySelector('[data-dashboard-focus-toggle]')
      .dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(daybook.dataset.focusMode, 'on');
    assert.equal(grid.dataset.focusMode, undefined, 'the grid is no longer the dim host');

    await manager.dispose();
  } finally {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  }
});
