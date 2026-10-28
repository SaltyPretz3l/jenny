'use strict';

// A scratchpad autosave echo repaints only the pad card; an echo that also moved
// another home section still repaints the whole dashboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createDashboardManager } = require('../renderer/features/renderer-dashboard-manager.js');
const dashboardRegistryModule = require('../renderer/features/renderer-dashboard-registry.js');
const scratchpadWidgetModule = require('../renderer/features/renderer-dashboard-widgets-scratchpad.js');
const scratchpadActionsModule = require('../renderer/features/renderer-dashboard-scratchpad-actions.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

function homeConfig() {
  return {
    links: [],
    widgets: { order: [], hidden: [] },
    layout: { railWidth: 360 },
    scratchpad: {
      notes: [{ id: 'note-1', title: 'Note 1', text: 'start', updatedAt: '', appendLog: false }],
      activeNoteId: 'note-1',
      settings: { rows: 6, font: 'prose', captureMode: 'append', markdown: false, globalCapture: true },
      pins: [],
    },
    calendar: { feeds: [] },
    focusMode: false,
    showContextualTips: true,
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a scratchpad-only echo repaints the pad card, not the rest of Home', async () => {
  const dom = new JSDOM('<main><div id="homeInfoStrip"></div><section id="homeDashboardGrid"></section></main>');
  const documentRef = dom.window.document;
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  let calendarRenders = 0;
  let echoExtra = {};
  const state = { ui: { activeView: 'home' }, homeConfig: homeConfig() };
  try {
    const manager = createDashboardManager({
      state,
      documentRef,
      shell: {
        home: {
          updateConfig: async (patch) => ({
            ...state.homeConfig,
            ...echoExtra,
            scratchpad: { ...state.homeConfig.scratchpad, ...patch.scratchpad },
          }),
        },
      },
      dom: { homeInfoStrip: documentRef.getElementById('homeInfoStrip'), homeDashboardGrid: documentRef.getElementById('homeDashboardGrid') },
      modules: {
        dashboardRegistry: dashboardRegistryModule,
        dashboardWidgetsScratchpad: scratchpadWidgetModule,
        dashboardScratchpadActions: scratchpadActionsModule,
        dashboardCalendar: {
          createCalendarWidget: () => ({ id: 'calendar', title: 'Calendar', render: () => { calendarRenders += 1; } }),
        },
      },
      callbacks: { appendClientLog: () => {} },
    });
    manager.bind();
    manager.render();
    await settle(); // the first render's async state priming repaints too
    const baseline = calendarRenders;
    assert.ok(baseline >= 1, 'the calendar card painted');

    const textarea = documentRef.getElementById('homeScratchpadInput');
    textarea.value = 'typed';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    textarea.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
    await settle();
    assert.equal(state.homeConfig.scratchpad.notes[0].text, 'typed');
    assert.equal(calendarRenders, baseline, 'the calendar card was not repainted');

    // An echo that also carries a concurrent change to another section is still
    // an acknowledged save, and repaints everything.
    echoExtra = { focusMode: true };
    textarea.value = 'typed again';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    textarea.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
    await settle();
    manager.dispose();
    assert.equal(state.homeConfig.scratchpad.notes[0].text, 'typed again');
    assert.equal(state.homeConfig.focusMode, true);
    assert.ok(calendarRenders > baseline, 'the calendar card was repainted');
  } finally {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  }
});
