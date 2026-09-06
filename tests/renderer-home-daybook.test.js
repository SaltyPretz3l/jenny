/* Daybook layout controller: rail width (drag + keyboard), the corner grip's
 * second axis (scratchpad rows), the hero ask pill, and the two regressions
 * this wave is most likely to reintroduce:
 *
 *  C5 — home.updateConfig merges ONE level deep, so a rows write MUST spread
 *       the whole scratchpad section or it silently drops font / captureMode /
 *       markdown / globalCapture (and notes / pins with them).
 *  C6 — the manager's 30s clock repaint rewrites the info strip with
 *       innerHTML. The ask pill must live OUTSIDE that markup or every tick
 *       eats the user's half-typed question and the caret with it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const daybookModule = require('../renderer/features/renderer-dashboard-daybook.js');
const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const dashboardRegistryModule = require('../renderer/features/renderer-dashboard-registry.js');
const { createDashboardManager } = require('../renderer/features/renderer-dashboard-manager.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

const RAIL_WIDTH_MIN = 280;
const RAIL_WIDTH_MAX = 720;
const RAIL_WIDTH_DEFAULT = 360;

function createDom({ rows = 6 } = {}) {
  const dom = new JSDOM(''
    + '<main><div class="home-daybook" id="homeDaybook">'
    + '<div id="homeInfoStrip" hidden></div>'
    + '<section id="homeDashboardGrid"></section>'
    + '<div id="homeRailResizer" role="separator" tabindex="0"></div>'
    + '<div id="homeRailGrip" aria-hidden="true"></div>'
    + `<div id="homeDashboardRail"><textarea id="homeScratchpadInput" rows="${rows}"></textarea></div>`
    + '</div>'
    + '<textarea id="chatInput"></textarea></main>');
  const documentRef = dom.window.document;
  const byId = (id) => documentRef.getElementById(id);
  return {
    dom,
    window: dom.window,
    documentRef,
    daybook: byId('homeDaybook'),
    grid: byId('homeDashboardGrid'),
    rail: byId('homeDashboardRail'),
    resizer: byId('homeRailResizer'),
    grip: byId('homeRailGrip'),
    infoStrip: byId('homeInfoStrip'),
    textarea: byId('homeScratchpadInput'),
  };
}

function defaultScratchpad(rows = 6) {
  return {
    notes: [{ id: 'note-1', title: 'Note 1', text: 'kept', updatedAt: '', appendLog: false }],
    activeNoteId: 'note-1',
    pins: ['note-1'],
    settings: {
      rows,
      font: 'mono',
      captureMode: 'prepend',
      markdown: true,
      globalCapture: false,
    },
  };
}

// A pointer event JSDOM can construct: it has no PointerEvent, so MouseEvent
// plus a pointerId rider carries everything the controller reads.
function pointer(window, type, { x = 0, y = 0, button = 0 } = {}) {
  const event = new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

function buildController({ dom, homeConfig, updateConfig, timers = null }) {
  const updates = [];
  const controller = daybookModule.createDaybookController({
    documentRef: dom.documentRef,
    shell: {
      home: {
        updateConfig: async (patch) => {
          updates.push(patch);
          return typeof updateConfig === 'function' ? updateConfig(patch) : null;
        },
      },
    },
    dom: {
      homeDaybook: dom.daybook,
      homeDashboardRail: dom.rail,
      homeRailResizer: dom.resizer,
      homeRailGrip: dom.grip,
      homeInfoStrip: dom.infoStrip,
    },
    getHomeConfig: () => homeConfig,
    appendClientLog: () => {},
    setTimeoutImpl: timers ? timers.set : undefined,
    clearTimeoutImpl: timers ? timers.clear : undefined,
  });
  return { controller, updates };
}

const widthOf = (daybook) => daybook.style.getPropertyValue('--home-rail-width');

test('open-loop title and notes fields opt into spellcheck', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dom = new JSDOM(html);
  const title = dom.window.document.getElementById('homeOpenLoopTitleInput');
  const notes = dom.window.document.getElementById('homeOpenLoopNotesInput');

  assert.ok(title, 'the open-loop title field exists');
  assert.ok(notes, 'the open-loop notes field exists');
  assert.equal(title.getAttribute('spellcheck'), 'true', 'the open-loop title is delegated-menu eligible');
  assert.equal(notes.getAttribute('spellcheck'), 'true', 'the open-loop notes are delegated-menu eligible');
  dom.window.close();
});

test('rail drag writes the CSS var live and persists ON POINTERUP ONLY', async (t) => {
  const dom = createDom();
  const homeConfig = { layout: { railWidth: 400 }, scratchpad: defaultScratchpad() };
  const { controller, updates } = buildController({ dom, homeConfig });
  t.after(() => controller.dispose());

  assert.equal(widthOf(dom.daybook), '400px', 'the persisted width paints on construction');

  dom.resizer.dispatchEvent(pointer(dom.window, 'pointerdown', { x: 500, y: 0 }));
  // Dragging the separator LEFT grows the right-hand rail.
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 460, y: 0 }));
  assert.equal(widthOf(dom.daybook), '440px');
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 430, y: 0 }));
  assert.equal(widthOf(dom.daybook), '470px');
  assert.deepEqual(updates, [], 'NOTHING is written to config mid-drag');

  dom.window.dispatchEvent(pointer(dom.window, 'pointerup', { x: 430, y: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [{ layout: { railWidth: 470 } }], 'exactly one write, on pointerup');
  assert.equal(widthOf(dom.daybook), '470px');

  // A drag that ends where it started writes nothing at all.
  dom.resizer.dispatchEvent(pointer(dom.window, 'pointerdown', { x: 100, y: 0 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 60, y: 0 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 100, y: 0 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointerup', { x: 100, y: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.length, 1, 'a no-op drag is not a write');
});

test('rail drag clamps at both ends', async (t) => {
  const dom = createDom();
  const homeConfig = { layout: { railWidth: RAIL_WIDTH_DEFAULT }, scratchpad: defaultScratchpad() };
  const { controller, updates } = buildController({ dom, homeConfig });
  t.after(() => controller.dispose());

  dom.resizer.dispatchEvent(pointer(dom.window, 'pointerdown', { x: 1000, y: 0 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 0, y: 0 }));
  assert.equal(widthOf(dom.daybook), `${RAIL_WIDTH_MAX}px`, 'clamps at the max');
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 2000, y: 0 }));
  assert.equal(widthOf(dom.daybook), `${RAIL_WIDTH_MIN}px`, 'clamps at the min');
  dom.window.dispatchEvent(pointer(dom.window, 'pointerup', { x: 2000, y: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [{ layout: { railWidth: RAIL_WIDTH_MIN } }]);
});

test('keyboard resize steps 16px per arrow, Home resets, and persistence debounces', async (t) => {
  const dom = createDom();
  const pending = [];
  const timers = {
    set: (fn) => { pending.push(fn); return pending.length; },
    clear: (id) => { if (id) pending[id - 1] = null; },
  };
  const homeConfig = { layout: { railWidth: 400 }, scratchpad: defaultScratchpad() };
  const { controller, updates } = buildController({ dom, homeConfig, timers });
  t.after(() => controller.dispose());

  const key = (name) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    dom.resizer.dispatchEvent(event);
    return event;
  };

  // ArrowLeft moves the separator left, which WIDENS the right-hand rail.
  const left = key('ArrowLeft');
  assert.equal(widthOf(dom.daybook), '416px');
  assert.equal(left.defaultPrevented, true);
  key('ArrowRight');
  key('ArrowRight');
  assert.equal(widthOf(dom.daybook), '384px');
  assert.equal(updates.length, 0, 'key presses do not write immediately');

  key('Home');
  assert.equal(widthOf(dom.daybook), `${RAIL_WIDTH_DEFAULT}px`);
  assert.equal(dom.resizer.getAttribute('aria-valuenow'), String(RAIL_WIDTH_DEFAULT));
  assert.equal(dom.resizer.getAttribute('aria-valuemin'), String(RAIL_WIDTH_MIN));
  assert.equal(dom.resizer.getAttribute('aria-valuemax'), String(RAIL_WIDTH_MAX));

  // Every earlier timer was cancelled; only the last one is still armed.
  const armed = pending.filter(Boolean);
  assert.equal(armed.length, 1, 'a held key coalesces into one pending write');
  armed[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [{ layout: { railWidth: RAIL_WIDTH_DEFAULT } }]);

  // Unrelated keys are ignored, and a key at the ceiling is not a write.
  const other = key('Enter');
  assert.equal(other.defaultPrevented, false);
});

test('the corner grip drives BOTH axes and clamps rows to 3..30', async (t) => {
  const dom = createDom({ rows: 6 });
  const homeConfig = { layout: { railWidth: 360 }, scratchpad: defaultScratchpad(6) };
  const { controller, updates } = buildController({ dom, homeConfig });
  t.after(() => controller.dispose());

  // RAIL_ROW_PX = 22: +110px of vertical travel is +5 rows, and dragging left
  // widens at the same time.
  dom.grip.dispatchEvent(pointer(dom.window, 'pointerdown', { x: 500, y: 200 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 480, y: 310 }));
  assert.equal(dom.textarea.rows, 11, 'rows follow dy / 22');
  assert.equal(widthOf(dom.daybook), '380px', 'width follows dx at the same time');
  assert.deepEqual(updates, [], 'nothing persists mid-drag');

  // Far past the ceiling, then far past the floor.
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 480, y: 2000 }));
  assert.equal(dom.textarea.rows, 30);
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 480, y: -2000 }));
  assert.equal(dom.textarea.rows, 3);

  dom.window.dispatchEvent(pointer(dom.window, 'pointerup', { x: 480, y: -2000 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.length, 2, 'one width write + one rows write');
  assert.deepEqual(updates[0], { layout: { railWidth: 380 } });
  assert.equal(updates[1].scratchpad.settings.rows, 3);
});

/* C5 REGRESSION. updateHomeConfig merges one level deep: a rows patch shaped
 * {scratchpad:{settings:{rows}}} REPLACES the whole scratchpad section. */
test('C5: a rows persist preserves font, captureMode, markdown, and globalCapture', async (t) => {
  const dom = createDom({ rows: 6 });
  const homeConfig = { layout: { railWidth: 360 }, scratchpad: defaultScratchpad(6) };
  const { controller, updates } = buildController({ dom, homeConfig });
  t.after(() => controller.dispose());

  dom.grip.dispatchEvent(pointer(dom.window, 'pointerdown', { x: 0, y: 0 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 0, y: 66 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointerup', { x: 0, y: 66 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(updates.length, 1, 'only the rows write (width never moved)');
  const patch = updates[0].scratchpad;
  assert.equal(patch.settings.rows, 9);
  // The whole sibling set survives the one-level-deep merge.
  assert.equal(patch.settings.font, 'mono');
  assert.equal(patch.settings.captureMode, 'prepend');
  assert.equal(patch.settings.markdown, true);
  assert.equal(patch.settings.globalCapture, false);
  // ...and so does everything else in the section the patch replaces.
  assert.deepEqual(patch.notes, homeConfig.scratchpad.notes);
  assert.equal(patch.activeNoteId, 'note-1');
  assert.deepEqual(patch.pins, ['note-1']);
});

/* C6 REGRESSION. The clock timer rewrites the strip every 30s. */
test('C6: the 30s repaint preserves the ask pill value AND the caret', async (t) => {
  const dom = createDom();
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  t.after(() => {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  });

  const intervalCallbacks = [];
  const state = { ui: { activeView: 'home' }, homeConfig: { links: [], focusMode: false } };
  const manager = createDashboardManager({
    state,
    documentRef: dom.documentRef,
    shell: null,
    dom: {
      homeInfoStrip: dom.infoStrip,
      homeDashboardGrid: dom.grid,
      homeDaybook: dom.daybook,
      homeDashboardRail: dom.rail,
      homeRailResizer: dom.resizer,
      homeRailGrip: dom.grip,
    },
    modules: {
      dashboardRegistry: dashboardRegistryModule,
      dashboardWidgetsCore: widgetsCore,
      dashboardDaybook: daybookModule,
    },
    callbacks: { appendClientLog: () => {} },
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
    setIntervalImpl: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    clearIntervalImpl: () => {},
  });
  t.after(() => manager.dispose());
  manager.bind();
  manager.render();

  const pill = dom.documentRef.getElementById('homeAskPill');
  assert.ok(pill, 'the strip builds the ask field');
  // W13: a real multi-line field with NO cap. The old <input maxlength="500">
  // ate 400 characters of a 900-character paste with no signal at all, and the
  // composer this feeds has no cap either.
  assert.equal(pill.tagName, 'TEXTAREA', 'an inventory text field, not a raw control');
  assert.equal(pill.hasAttribute('maxlength'), false, 'nothing is ever truncated');
  assert.equal(pill.getAttribute('rows'), '1', 'it GROWS from one line, never flashes three');
  assert.equal(pill.getAttribute('placeholder'), 'Ask Jenny…');
  assert.equal(pill.getAttribute('spellcheck'), 'true', 'parity with #chatInput');

  pill.value = 'what did I mis';
  pill.focus();
  assert.equal(dom.documentRef.activeElement, pill);

  // The manager's 30s clock tick — the exact repaint path that used to nuke it.
  assert.equal(intervalCallbacks.length, 1);
  intervalCallbacks[0]();

  const after = dom.documentRef.getElementById('homeAskPill');
  assert.equal(after, pill, 'the SAME input node survives the repaint');
  assert.equal(after.value, 'what did I mis', 'the half-typed question survives');
  assert.equal(dom.documentRef.activeElement, after, 'and so does focus');
  // The chrome around it DID repaint.
  assert.equal(dom.infoStrip.querySelector('.home-info-strip__time').textContent, '8:05 AM');
});

test('ask line: Enter appends below an existing draft, switches view, and clears', async (t) => {
  const dom = createDom();
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  t.after(() => {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  });

  const views = [];
  const inputEvents = [];
  const chatInput = dom.documentRef.getElementById('chatInput');
  chatInput.value = 'existing draft   \n';
  chatInput.addEventListener('input', (event) => inputEvents.push(event.bubbles));

  const state = { ui: { activeView: 'home' }, homeConfig: { links: [], focusMode: false } };
  const manager = createDashboardManager({
    state,
    documentRef: dom.documentRef,
    shell: null,
    dom: {
      homeInfoStrip: dom.infoStrip,
      homeDashboardGrid: dom.grid,
      homeDaybook: dom.daybook,
      homeDashboardRail: dom.rail,
      homeRailResizer: dom.resizer,
      homeRailGrip: dom.grip,
    },
    modules: {
      dashboardRegistry: dashboardRegistryModule,
      dashboardWidgetsCore: widgetsCore,
      dashboardDaybook: daybookModule,
    },
    callbacks: { appendClientLog: () => {}, setActiveView: (view) => views.push(view) },
  });
  t.after(() => manager.dispose());
  manager.bind();
  manager.render();

  const pill = dom.documentRef.getElementById('homeAskPill');
  const press = (key, init = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...init,
    });
    pill.dispatchEvent(event);
    return event;
  };

  pill.value = 'why is the build red?';
  const enter = press('Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(chatInput.value, 'existing draft\n\nwhy is the build red?');
  assert.deepEqual(inputEvents, [true], 'one BUBBLING input event so the composer resizes');
  assert.deepEqual(views, ['chat']);
  assert.equal(dom.documentRef.activeElement, chatInput, 'focus lands in the composer');
  assert.equal(pill.value, '', 'the pill clears');

  // Empty Enter navigates and focuses but writes nothing.
  pill.value = '   ';
  press('Enter');
  assert.equal(chatInput.value, 'existing draft\n\nwhy is the build red?', 'no composer write');
  assert.equal(inputEvents.length, 1, 'and no second input event');
  assert.deepEqual(views, ['chat', 'chat']);
  assert.equal(pill.value, '');

  // W13: Shift+Enter is a NEWLINE (composer parity). It must not preventDefault
  // - the textarea inserts the character itself - and must not ask anything.
  pill.value = 'draft';
  const shifted = press('Enter', { shiftKey: true });
  assert.equal(shifted.defaultPrevented, false, 'the textarea gets to insert the newline');
  assert.equal(chatInput.value, 'existing draft\n\nwhy is the build red?', 'no composer write');
  assert.equal(pill.value, 'draft', 'and the draft is untouched');
  assert.deepEqual(views, ['chat', 'chat'], 'Shift+Enter never navigates');

  // W13: Ctrl+Enter is the review path - it hands the text to the composer, it
  // just never fires the send. Without the ask-config module the manager
  // degrades to prefill-and-navigate for BOTH keys, so here Enter and
  // Ctrl+Enter look alike; the send/no-send split is pinned in
  // tests/renderer-home-ask-config.test.js against the real launcher.
  pill.value = 'draft';
  const drafted = press('Enter', { ctrlKey: true });
  assert.equal(drafted.defaultPrevented, true);
  assert.equal(chatInput.value, 'existing draft\n\nwhy is the build red?\n\ndraft');
  assert.equal(pill.value, '');
  assert.deepEqual(views, ['chat', 'chat', 'chat']);

  /* F3: Escape used to run `target.value = ''` unconditionally, so dismissing
   * the settings panel while the field had focus destroyed the draft with no
   * undo. It blurs now, and NEVER clears. */
  pill.value = 'abandoned';
  pill.focus();
  assert.equal(dom.documentRef.activeElement, pill);
  press('Escape');
  assert.equal(pill.value, 'abandoned', 'Escape preserves the draft');
  assert.notEqual(dom.documentRef.activeElement, pill, 'it gives the field up instead');
  assert.deepEqual(views, ['chat', 'chat', 'chat'], 'Escape never navigates');
});

/* Stale-config regression: a homeConfig written by the pre-Daybook build lists
 * only ids that no longer exist. Those ids must be inert — no reorder, no
 * ghost hidden strip — and the surviving widgets must paint in registration
 * order across both columns. */
test('a homeConfig naming only removed widget ids still paints the Daybook', () => {
  const dom = createDom();
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  const render = (body) => { body.textContent = 'x'; };
  const state = {
    ui: { activeView: 'home', dashboardEditMode: true },
    homeConfig: {
      links: [],
      focusMode: false,
      widgets: {
        order: ['resources', 'links', 'reminders', 'model-status', 'recent-sessions'],
        hidden: ['workspace-git', 'scheduler'],
      },
    },
  };
  try {
    const manager = createDashboardManager({
      state,
      documentRef: dom.documentRef,
      shell: null,
      dom: {
        homeInfoStrip: dom.infoStrip,
        homeDashboardGrid: dom.grid,
        homeDaybook: dom.daybook,
        homeDashboardRail: dom.rail,
        homeRailResizer: dom.resizer,
        homeRailGrip: dom.grip,
      },
      modules: {
        dashboardRegistry: dashboardRegistryModule,
        dashboardWidgetsCore: widgetsCore,
        dashboardDaybook: daybookModule,
        dashboardWidgetsScratchpad: {
          createScratchpadWidget: () => ({ id: 'scratchpad', title: 'Scratchpad', render }),
        },
        dashboardScratchpadActions: { createScratchpadActions: () => ({}) },
        dashboardCalendar: {
          createCalendarWidget: () => ({ id: 'calendar', title: 'Calendar', render }),
        },
        dashboardLoops: { createOpenLoopsWidget: () => ({ id: 'open-loops', title: 'Open Loops', render }) },
      },
      callbacks: { appendClientLog: () => {} },
    });
    const counts = manager.render();

    assert.deepEqual(counts, { rendered: 3, skipped: 0, failed: 0 });
    assert.deepEqual(
      Array.from(dom.grid.children).map((card) => card.dataset.widgetId),
      ['calendar', 'open-loops'],
      'main column keeps registration order'
    );
    assert.deepEqual(
      Array.from(dom.rail.children).map((card) => card.dataset.widgetId),
      ['scratchpad']
    );
    // Every hidden id is unknown, so edit mode grows NO restore strip.
    assert.equal(dom.documentRef.getElementById('homeDashboardHiddenStrip'), null);
    manager.dispose();
  } finally {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  }
});

/* The echoed config round-trip: applyHomeConfigPayload rebuilds
 * state.homeConfig field by field, so a `layout` it forgets to carry would
 * make the next paint snap the rail back to 360 right after a resize. */
test('a persisted railWidth survives the config echo and the next paint', async (t) => {
  const dom = createDom();
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  t.after(() => {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  });

  const state = { ui: { activeView: 'home' } };
  const served = {
    links: [],
    weather: {},
    widgets: { order: [], hidden: [] },
    scratchpad: { ...defaultScratchpad(), pins: [] },
    calendar: {},
    layout: { railWidth: 520 },
    focusMode: false,
    showContextualTips: true,
  };
  const manager = createDashboardManager({
    state,
    documentRef: dom.documentRef,
    shell: {
      home: {
        // The service echoes the FULL normalized config, layout included.
        updateConfig: async (patch) => Object.assign(served, patch),
      },
    },
    dom: {
      homeInfoStrip: dom.infoStrip,
      homeDashboardGrid: dom.grid,
      homeDaybook: dom.daybook,
      homeDashboardRail: dom.rail,
      homeRailResizer: dom.resizer,
      homeRailGrip: dom.grip,
    },
    modules: {
      dashboardRegistry: dashboardRegistryModule,
      dashboardWidgetsCore: widgetsCore,
      dashboardDaybook: daybookModule,
    },
    callbacks: { appendClientLog: () => {} },
  });
  t.after(() => manager.dispose());
  manager.bind();

  // Drag to 600, which persists and echoes back through the manager.
  dom.resizer.dispatchEvent(pointer(dom.window, 'pointerdown', { x: 500, y: 0 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 400, y: 0 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointerup', { x: 400, y: 0 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.homeConfig.layout.railWidth, 460, 'the echo carries layout into state');
  assert.equal(widthOf(dom.daybook), '460px', 'and the repaint does not snap back to 360');

  manager.render();
  assert.equal(widthOf(dom.daybook), '460px', 'a later paint holds it too');
});

test('dispose unbinds every listener the controller installed', () => {
  const dom = createDom();
  const homeConfig = { layout: { railWidth: 360 }, scratchpad: defaultScratchpad() };
  const { controller, updates } = buildController({ dom, homeConfig });
  controller.dispose();

  dom.resizer.dispatchEvent(pointer(dom.window, 'pointerdown', { x: 500, y: 0 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointermove', { x: 400, y: 0 }));
  dom.window.dispatchEvent(pointer(dom.window, 'pointerup', { x: 400, y: 0 }));
  dom.resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  dom.grip.dispatchEvent(pointer(dom.window, 'pointerdown', { x: 0, y: 0 }));

  assert.equal(widthOf(dom.daybook), '360px', 'no width moves after dispose');
  assert.deepEqual(updates, [], 'and nothing is written');
});
