const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const { normalizeCompanionState } = require('../renderer/features/renderer-companion-state-utils.js');
const dashboardLoops = require('../renderer/features/renderer-dashboard-loops.js');
const { createDashboardManager } = require('../renderer/features/renderer-dashboard-manager.js');
const dashboardRegistryModule = require('../renderer/features/renderer-dashboard-registry.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');
const pageMenuModule = require('../renderer/features/renderer-dashboard-page-menu.js');

function createDom() {
  const dom = new JSDOM('<main><div id="homeInfoStrip" hidden></div><section id="homeDashboardGrid"></section></main>');
  return {
    documentRef: dom.window.document,
    grid: dom.window.document.getElementById('homeDashboardGrid'),
    infoStrip: dom.window.document.getElementById('homeInfoStrip'),
  };
}

// The focus/edit controls live in the page menu beside the ask pill now; the
// menu content is rebuilt on every open, so tests reopen it to read fresh
// pressed states after a flip.
function openPageMenu(documentRef) {
  const trigger = documentRef.getElementById('homePageMenuTrigger');
  assert.ok(trigger, 'the ask region renders the page-menu trigger');
  trigger.dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));
  const popover = documentRef.getElementById('homePageMenuPopover');
  assert.equal(popover.hidden, false, 'the page menu opens from its trigger');
  return popover;
}

// The Daybook cut (plus owner feedback wave 2, which retired the Tests card)
// left calendar / scratchpad / open-loops as the only Home widgets, and the
// real calendar and scratchpad descriptors each need
// the full inventory global surface plus a live shell to render. The manager
// tests below exercise the MANAGER's layout machinery (registration order, edit
// toolbars, reorder/hide persistence, the hidden strip), which is entirely
// widget-agnostic — so they register the real surviving widget IDS through the
// manager's real module slots with trivial render bodies. The widgets' own
// rendering is covered by tests/renderer-dashboard-calendar.test.js and
// tests/renderer-dashboard-scratchpad*.test.js.
function stubWidgetModules(overrides = {}) {
  const render = (body) => { body.textContent = 'x'; };
  return {
    dashboardRegistry: dashboardRegistryModule,
    // Real modules: widgets-core owns the info strip (and its ask region) and
    // page-menu owns the [⋯] popover holding the edit/focus items these tests
    // click. Without them the strip never paints and no controls exist.
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

test('info strip renders clock, greeting, and configured weather', () => {
  const { infoStrip } = createDom();
  const renderer = widgetsCore.createInfoStripRenderer({
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
  });
  renderer.render(infoStrip, {
    state: {
      weather: {
        available: true,
        configured: true,
        tempC: 21.4,
        tempF: 70.5,
        description: 'partly cloudy',
        units: 'metric',
      },
    },
  });

  assert.equal(infoStrip.hidden, false);
  assert.equal(infoStrip.querySelector('.home-info-strip__time').textContent, '8:05 AM');
  assert.match(infoStrip.querySelector('.home-info-strip__date').textContent, /June 11|11/);
  assert.equal(infoStrip.querySelector('.home-info-strip__greeting').textContent, 'Good morning');
  assert.equal(infoStrip.querySelector('.home-info-strip__weather').textContent, '21°C · partly cloudy');
});

test('info strip digest composes next event, open loops, and next run', () => {
  const { infoStrip } = createDom();
  const renderer = widgetsCore.createInfoStripRenderer({
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
  });
  renderer.render(infoStrip, {
    state: {
      calendar: {
        instances: [
          { title: 'Past', start: '2026-06-11T07:00', end: '2026-06-11T07:30', allDay: false },
          { title: 'Offsite', start: '2026-06-11T00:00', end: '2026-06-12T00:00', allDay: true },
          { title: 'Standup', start: '2026-06-11T09:15', end: '2026-06-11T09:30', allDay: false },
        ],
      },
      companion: { openLoopsBoard: { counts: { active: 3 } } },
      scheduler: { upcoming: [{ label: 'nightly memory', eta: 'in 2h' }] },
    },
  });

  assert.equal(
    infoStrip.querySelector('.home-info-strip__digest').textContent,
    'Next: Standup at 9:15 AM · 3 open loops · Next run: nightly memory in 2h'
  );
});

test('info strip digest degrades per segment and disappears when empty', () => {
  const { infoStrip } = createDom();
  const renderer = widgetsCore.createInfoStripRenderer({
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
  });

  // Calendar absent + 1 loop: pluralization and partial composition.
  renderer.render(infoStrip, {
    state: { companion: { openLoopsBoard: { counts: { active: 1 } } } },
  });
  assert.equal(infoStrip.querySelector('.home-info-strip__digest').textContent, '1 open loop');

  // Next event on a future day carries its weekday instead of "at".
  const digest = widgetsCore.formatTodayDigest(
    { calendar: { instances: [{ title: 'Review', start: '2026-06-12T14:00', end: '2026-06-12T15:00', allDay: false }] } },
    new Date(2026, 5, 11, 8, 5)
  );
  assert.match(digest, /^Next: Review Fri 2 PM$/);

  // Nothing to say: the digest div is omitted entirely.
  renderer.render(infoStrip, { state: {} });
  assert.equal(infoStrip.querySelector('.home-info-strip__digest'), null);
});

test('info strip digest tiers up today with then + more-today', () => {
  const digest = widgetsCore.formatTodayDigest(
    {
      calendar: {
        instances: [
          { title: 'Standup', start: '2026-06-11T09:15', end: '2026-06-11T09:30', allDay: false },
          { title: 'Review', start: '2026-06-11T11:00', end: '2026-06-11T11:30', allDay: false },
          { title: '1:1', start: '2026-06-11T14:00', end: '2026-06-11T14:30', allDay: false },
          { title: 'Tomorrow', start: '2026-06-12T09:00', end: '2026-06-12T09:30', allDay: false },
        ],
      },
    },
    new Date(2026, 5, 11, 8, 5)
  );
  assert.equal(digest, 'Next: Standup at 9:15 AM · then Review 11 AM · +1 more today');
});

test('info strip omits weather while unconfigured and honors imperial units', () => {
  const { infoStrip } = createDom();
  const renderer = widgetsCore.createInfoStripRenderer({
    nowProvider: () => new Date(2026, 5, 11, 23, 40),
  });

  renderer.render(infoStrip, { state: { weather: { available: false, configured: false } } });
  assert.equal(infoStrip.querySelector('.home-info-strip__weather'), null);
  assert.equal(infoStrip.querySelector('.home-info-strip__greeting').textContent, 'Up late');

  renderer.render(infoStrip, {
    state: {
      weather: { available: true, tempC: 21, tempF: 69.8, description: 'clear', units: 'imperial' },
    },
  });
  assert.equal(infoStrip.querySelector('.home-info-strip__weather').textContent, '70°F · clear');
});

// The page-menu trigger/rows themselves are covered by
// tests/renderer-home-page-menu.test.js (split for the 600-line ratchet);
// the manager tests below exercise the items through the real strip
// delegation via openPageMenu().

test('greeting picks the right time-of-day bucket', () => {
  const at = (hour) => new Date(2026, 5, 11, hour, 0);
  assert.equal(widgetsCore.pickGreeting(at(6)), 'Good morning');
  assert.equal(widgetsCore.pickGreeting(at(13)), 'Good afternoon');
  assert.equal(widgetsCore.pickGreeting(at(19)), 'Good evening');
  assert.equal(widgetsCore.pickGreeting(at(2)), 'Up late');
  assert.equal(widgetsCore.formatClockTime(new Date(2026, 5, 11, 0, 7)), '12:07 AM');
  assert.equal(widgetsCore.formatClockTime(new Date(2026, 5, 11, 12, 30)), '12:30 PM');
});

test('open loops widget adopts the live companion panel without rebuilding it', () => {
  const dom = new JSDOM(''
    + '<div id="homeView">'
    + '<section id="homeOpenLoopsPanel" hidden><div id="homeOpenLoopList"></div></section>'
    + '<section id="homeDashboardGrid"></section>'
    + '</div>');
  const documentRef = dom.window.document;
  const widget = dashboardLoops.createOpenLoopsWidget();
  const body = documentRef.createElement('div');
  documentRef.getElementById('homeDashboardGrid').append(body);
  const panel = documentRef.getElementById('homeOpenLoopsPanel');
  const innerList = documentRef.getElementById('homeOpenLoopList');

  widget.render(body, { documentRef });
  assert.equal(panel.parentNode, body, 'panel moved into the card body');
  assert.equal(panel.hidden, false);
  assert.equal(documentRef.getElementById('homeOpenLoopList'), innerList, 'companion element refs stay live');
  assert.ok(documentRef.getElementById('homeView').contains(panel), 'panel stays under the #homeView delegation root');

  widget.render(body, { documentRef });
  assert.equal(panel.parentNode, body, 'repeat renders leave the adopted node in place');
  assert.equal(documentRef.getElementById('homeOpenLoopList'), innerList);
});

test('agent-task action starts a session with a title-and-notes draft', async (t) => {
  const dom = new JSDOM('<div id="homeView"><section id="homeOpenLoopsPanel"><button data-companion-action-id="start_task_session:task-1">Start a session</button></section></div>');
  const calls = [];
  const previous = globalThis.rendererTaskSessionActions;
  t.after(() => { globalThis.rendererTaskSessionActions = previous; });
  globalThis.rendererTaskSessionActions = { start: async (options) => calls.push(options) };
  const loop = { title: 'Ship WO-10c', body: 'Keep the brief unsent.', actions: [{ id: 'start_task_session:task-1' }] };
  const widget = dashboardLoops.createOpenLoopsWidget();
  const body = dom.window.document.createElement('div');
  widget.render(body, { documentRef: dom.window.document,
    state: { companion: { openLoopsBoard: { active: [loop] } } } });
  body.querySelector('button').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ title: 'Ship WO-10c', initialPrompt: 'Ship WO-10c\n\nKeep the brief unsent.' }]);
  assert.equal(dashboardLoops.buildTaskBrief({ title: 'Title only', body: '  ' }), 'Title only');
});

test('unavailable task-session action is contained and logged', (t) => {
  const dom = new JSDOM('<div id="homeView"><section id="homeOpenLoopsPanel"><button data-companion-action-id="start_task_session:task-1">Start a session</button></section></div>');
  const previousActions = globalThis.rendererTaskSessionActions;
  const previousError = globalThis.console.error;
  const errors = [];
  t.after(() => {
    globalThis.rendererTaskSessionActions = previousActions;
    globalThis.console.error = previousError;
    dom.window.close();
  });
  globalThis.rendererTaskSessionActions = null;
  globalThis.console.error = (message) => errors.push(message);
  const loop = { title: 'Ship WO-10c', actions: [{ id: 'start_task_session:task-1' }] };
  const body = dom.window.document.createElement('div');
  dashboardLoops.createOpenLoopsWidget().render(body, { documentRef: dom.window.document,
    state: { companion: { openLoopsBoard: { active: [loop] } } } });
  let fellThrough = false;
  dom.window.document.getElementById('homeView').addEventListener('click', () => { fellThrough = true; });
  const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  body.querySelector('button').dispatchEvent(click);

  assert.equal(click.defaultPrevented, true);
  assert.equal(fellThrough, false);
  assert.deepEqual(errors, ['Task session unavailable.']);
});

test('open loops widget degrades to a note when the panel is missing', () => {
  const dom = new JSDOM('<div></div>');
  const documentRef = dom.window.document;
  const widget = dashboardLoops.createOpenLoopsWidget();
  const body = documentRef.createElement('div');
  widget.render(body, { documentRef });
  assert.match(body.textContent, /Open Loops are unavailable\./);
});

test('focus mode: page-menu item and hotkey flip the grid dataset and persist', async () => {
  const { documentRef, grid, infoStrip } = createDom();
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  const updates = [];
  const state = {
    ui: { activeView: 'home' },
    homeConfig: { links: [], focusMode: false },
  };
  try {
    const manager = createDashboardManager({
      state,
      documentRef,
      shell: {
        home: {
          updateConfig: async (patch) => {
            updates.push(patch);
            return { ...state.homeConfig, ...patch };
          },
        },
      },
      dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
      modules: {
        dashboardRegistry: dashboardRegistryModule,
        dashboardWidgetsCore: widgetsCore,
        dashboardPageMenu: pageMenuModule,
      },
      inventory: { popover: inventoryPopover },
      callbacks: { appendClientLog: () => {} },
    });
    manager.bind();
    manager.render();

    const toggle = openPageMenu(documentRef).querySelector('[data-dashboard-focus-toggle]');
    assert.ok(toggle, 'the page menu renders the focus item');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');

    toggle.dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(grid.dataset.focusMode, 'on');
    assert.deepEqual(updates, [{ focusMode: true }]);
    // The item click closed the menu; a reopen rebuilds it with fresh state,
    // and the trigger itself stays lit while the mode is on.
    assert.equal(documentRef.getElementById('homePageMenuPopover').hidden, true);
    assert.ok(
      documentRef.getElementById('homePageMenuTrigger')
        .classList.contains('home-page-menu__trigger--active')
    );
    assert.equal(
      openPageMenu(documentRef).querySelector('[data-dashboard-focus-toggle]')
        .getAttribute('aria-pressed'),
      'true'
    );
    documentRef.getElementById('homePageMenuTrigger').dispatchEvent(
      new documentRef.defaultView.MouseEvent('click', { bubbles: true })
    );

    // Ctrl+Shift+F flips it back; plain keys and editable targets are ignored.
    const win = documentRef.defaultView;
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(grid.dataset.focusMode, undefined);
    assert.equal(updates.length, 2);

    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'f' }));
    state.ui.activeView = 'chat';
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates.length, 2, 'no flip off-Home or without modifiers');

    manager.dispose();
  } finally {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  }
});

test('edit layout: toolbar reveals, hide/reorder persist, hidden strip restores', async () => {
  const { documentRef, grid, infoStrip } = createDom();
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  const updates = [];
  const state = {
    ui: { activeView: 'home' },
    homeConfig: {
      links: [], weather: {}, widgets: { order: [], hidden: [] },
      scratchpad: { notes: [], activeNoteId: '', settings: {}, pins: [] },
      calendar: {}, focusMode: false, showContextualTips: true,
    },
  };
  const click = (el) => el.dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));
  try {
    const manager = createDashboardManager({
      state,
      documentRef,
      shell: {
        home: {
          updateConfig: async (patch) => {
            updates.push(patch);
            const widgets = { ...state.homeConfig.widgets, ...patch.widgets };
            return { ...state.homeConfig, widgets };
          },
        },
      },
      dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
      modules: stubWidgetModules(),
      inventory: { popover: inventoryPopover },
      callbacks: { appendClientLog: () => {} },
    });
    manager.bind();
    manager.render();
    assert.equal(grid.querySelector('.dashboard-card__edit'), null, 'no toolbars outside edit mode');

    click(openPageMenu(documentRef).querySelector('[data-dashboard-edit-toggle]'));
    assert.equal(grid.querySelectorAll('.dashboard-card__edit').length, 2, 'every card grows a toolbar');

    // Move calendar earlier: persisted as the full visible sequence.
    click(grid.querySelector('[data-widget-edit="up"][data-widget-id="calendar"]'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates[0], { widgets: { order: ['calendar', 'scratchpad'] } });
    assert.deepEqual(
      Array.from(grid.children).map((card) => card.dataset.widgetId),
      ['calendar', 'scratchpad']
    );

    // Hide scratchpad: card drops, restore strip appears below the grid.
    click(grid.querySelector('[data-widget-edit="hide"][data-widget-id="scratchpad"]'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates[1], { widgets: { hidden: ['scratchpad'] } });
    assert.deepEqual(Array.from(grid.children).map((card) => card.dataset.widgetId), ['calendar']);
    const strip = documentRef.getElementById('homeDashboardHiddenStrip');
    assert.ok(strip, 'hidden strip rendered');
    assert.match(strip.textContent, /Scratchpad/);

    // Restore it from the strip.
    click(strip.querySelector('[data-widget-edit="show"][data-widget-id="scratchpad"]'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates[2], { widgets: { hidden: [] } });
    assert.equal(documentRef.getElementById('homeDashboardHiddenStrip'), null, 'strip leaves when empty');

    // Leaving edit mode clears the toolbars.
    click(openPageMenu(documentRef).querySelector('[data-dashboard-edit-toggle]'));
    assert.equal(grid.querySelector('.dashboard-card__edit'), null);

    manager.dispose();
  } finally {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  }
});

test('normalizeCompanionState preserves the structured workspaceGit field', () => {
  const normalized = normalizeCompanionState({
    workspaceGit: {
      available: true,
      branch: ' main ',
      recentCommits: ['abc one', '', 'def two', 'g3', 'g4', 'g5', 'g6-over-cap'],
      summary: ' Git: branch main; clean. ',
    },
  });
  assert.equal(normalized.workspaceGit.available, true);
  assert.equal(normalized.workspaceGit.branch, 'main');
  assert.equal(normalized.workspaceGit.recentCommits.length, 5);
  assert.equal(normalized.workspaceGit.summary, 'Git: branch main; clean.');

  const empty = normalizeCompanionState({});
  assert.deepEqual(empty.workspaceGit, { available: false, branch: '', recentCommits: [], summary: '' });
});

test('widgets config reorders and hides cards; unknown ids are inert', () => {
  const { documentRef, grid } = createDom();
  const registry = dashboardRegistryModule.createDashboardRegistry({ documentRef });
  const render = (body) => { body.textContent = 'x'; };
  registry.register({ id: 'alpha', title: 'Alpha', render });
  registry.register({ id: 'beta', title: 'Beta', render });
  registry.register({ id: 'gamma', title: 'Gamma', render });

  // Reorder: configured ids lead in config order; the rest keep registration order.
  registry.renderInto(grid, { widgetsConfig: { order: ['gamma', 'alpha'], hidden: [] } });
  assert.deepEqual(
    Array.from(grid.children).map((card) => card.dataset.widgetId),
    ['gamma', 'alpha', 'beta']
  );

  // Hide drops the card; unknown ids in both lists are ignored.
  registry.renderInto(grid, { widgetsConfig: { order: ['ghost-widget'], hidden: ['beta', 'not-real'] } });
  assert.deepEqual(
    Array.from(grid.children).map((card) => card.dataset.widgetId),
    ['alpha', 'gamma']
  );
  assert.deepEqual(
    registry.listRenderableIds({ widgetsConfig: { order: [], hidden: ['beta'] } }),
    ['alpha', 'gamma']
  );

  // Empty config falls back to registration order, and the hidden card returns.
  registry.renderInto(grid, { widgetsConfig: { order: [], hidden: [] } });
  assert.deepEqual(
    Array.from(grid.children).map((card) => card.dataset.widgetId),
    ['alpha', 'beta', 'gamma']
  );
});

test('repaints with identical widgets config keep DOM nodes settled', () => {
  const { documentRef, grid } = createDom();
  const registry = dashboardRegistryModule.createDashboardRegistry({ documentRef });
  const render = (body) => { body.textContent = 'x'; };
  registry.register({ id: 'alpha', title: 'Alpha', render });
  registry.register({ id: 'beta', title: 'Beta', render });

  const ctx = { widgetsConfig: { order: ['beta'], hidden: [] } };
  registry.renderInto(grid, ctx);
  const settled = Array.from(grid.children);
  registry.renderInto(grid, ctx);
  assert.deepEqual(Array.from(grid.children), settled, 'no node churn on steady-state repaint');
  assert.deepEqual(
    Array.from(grid.children).map((card) => card.dataset.widgetId),
    ['beta', 'alpha']
  );
});

test('dashboard manager passes homeConfig.widgets through to the registry', () => {
  const { documentRef, grid, infoStrip } = createDom();
  const state = {
    ui: { activeView: 'home' },
    homeConfig: { links: [], widgets: { order: ['calendar'], hidden: ['scratchpad'] } },
  };
  const manager = createDashboardManager({
    state,
    documentRef,
    shell: null,
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: stubWidgetModules(),
    callbacks: { appendClientLog: () => {} },
  });
  manager.render();
  assert.deepEqual(
    Array.from(grid.children).map((card) => card.dataset.widgetId),
    ['calendar']
  );
  manager.dispose();
});

test('dashboard manager registers the surviving widgets and paints the info strip', () => {
  const { documentRef, grid, infoStrip } = createDom();
  const state = { ui: { activeView: 'home' }, tick: 0 };
  const intervalCallbacks = [];
  let now = new Date(2026, 5, 11, 15, 30);
  let calendarRenders = 0;
  const manager = createDashboardManager({
    state,
    documentRef,
    shell: null,
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: stubWidgetModules({
      dashboardCalendar: {
        createCalendarWidget: () => ({
          id: 'calendar',
          title: 'Calendar',
          render(body, ctx) {
            calendarRenders += 1;
            body.textContent = String(ctx?.state?.tick ?? '');
          },
        }),
      },
    }),
    callbacks: { appendClientLog: () => {} },
    nowProvider: () => now,
    setIntervalImpl: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    clearIntervalImpl: () => {},
  });

  assert.deepEqual(manager.registry.list().map((widget) => widget.id), ['scratchpad', 'calendar']);
  const counts = manager.render();
  assert.deepEqual(counts, { rendered: 2, skipped: 0, failed: 0 });
  assert.equal(calendarRenders, 1);
  assert.equal(infoStrip.hidden, false);
  assert.equal(infoStrip.querySelector('.home-info-strip__greeting').textContent, 'Good afternoon');
  assert.deepEqual(
    Array.from(grid.children).map((card) => card.dataset.widgetId),
    ['scratchpad', 'calendar']
  );

  manager.bind();
  assert.equal(intervalCallbacks.length, 1, 'bind starts the clock update interval');
  state.tick = 7;
  now = new Date(2026, 5, 11, 15, 31);
  intervalCallbacks[0]();
  assert.equal(
    infoStrip.querySelector('.home-info-strip__time').textContent,
    '3:31 PM',
    'clock tick updates only the clock text'
  );
  assert.equal(calendarRenders, 1, 'clock tick does not repaint dashboard widgets');
  assert.equal(
    grid.querySelector('[data-widget-id="calendar"] .dashboard-card__body').textContent,
    '0'
  );
  manager.dispose();
});

// The manager still owns reminder persistence (upsert/remove with echo
// verification) even though the reminders widget left Home in the Daybook cut;
// the agenda wave becomes its caller and brings its own coverage.
test('dashboard manager exposes reminder actions for the Daybook agenda', () => {
  const { documentRef, grid, infoStrip } = createDom();
  const manager = createDashboardManager({
    state: { ui: { activeView: 'home' } },
    documentRef,
    shell: null,
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: { dashboardRegistry: dashboardRegistryModule },
    callbacks: { appendClientLog: () => {} },
  });
  assert.equal(typeof manager.reminderActions.upsert, 'function');
  assert.equal(typeof manager.reminderActions.remove, 'function');
  manager.dispose();
});

test('reminder upsert rejects an acknowledgement that does not echo the request', async () => {
  const { documentRef, grid, infoStrip } = createDom();
  const state = {
    ui: { activeView: 'home' },
    proactive: {
      reminders: [
        { id: 'r1', label: 'First', prompt: 'One', enabled: true, createdAt: '2026-08-18T10:00:00.000Z' },
        { id: 'r2', label: 'Second', prompt: 'Two', enabled: true, createdAt: '2026-08-18T11:00:00.000Z' },
      ],
    },
  };
  const prior = state.proactive.reminders;
  const manager = createDashboardManager({
    state,
    documentRef,
    shell: {
      proactive: {
        // Drops the untouched sibling's content: a silent data loss the echo
        // check is there to catch.
        upsertReminder: async (reminder) => ({
          proactive: { reminders: [{ ...reminder, createdAt: prior[0].createdAt }, { id: prior[1].id }] },
        }),
        deleteReminder: async () => ({ proactive: { reminders: [prior[1], prior[1]] } }),
      },
    },
    dom: { homeInfoStrip: infoStrip, homeDashboardGrid: grid },
    modules: { dashboardRegistry: dashboardRegistryModule },
    callbacks: { appendClientLog: () => {} },
  });

  await assert.rejects(
    () => manager.reminderActions.upsert({ ...prior[0], label: 'Renamed' }),
    /acknowledgement did not match/
  );
  await assert.rejects(
    () => manager.reminderActions.remove('r1'),
    /deletion was not acknowledged/
  );
  assert.equal(state.proactive.reminders, prior, 'a rejected echo never mutates local state');
  manager.dispose();
});
