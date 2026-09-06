const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

/*
 * Settings section binder wiring for Personality. Split out of
 * personality-ui-utils.test.js to keep both files under the size ratchet.
 *
 * These cover the two affordances the binder owns rather than the controller:
 * the section-scoped Ctrl+S (which must not start a second concurrent save,
 * and must not fall through to the browser's Save Page) and the Clear confirm
 * dialog (which must never be skipped silently).
 */

const SECTION_HTML = `
  <section data-settings-section="personality">
    <span id="personalityStatus"></span>
    <div id="personalityFormHost"></div>
    <span id="personalityTokenLine"></span>
    <div id="personalityExactHost"></div>
    <div id="personalityExactPanelHost"></div>
    <div id="personalityActions"></div>
  </section>`;

const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');

function createBinderHarness(t, options = {}) {
  const dom = new JSDOM(`${SECTION_HTML}<div id="outside"><input id="elsewhere"></div>`);
  const { document } = dom.window;
  const state = {
    personality: { dirty: true, saving: false, actionStatus: '', loadStatus: '' },
    memoryContextFiles: { dirty: false, actionStatus: '' },
  };
  const calls = { save: 0, clear: 0, openFolder: 0, renders: 0 };
  const listeners = [];
  const cleanups = [];
  const binders = createSettingsSectionBinders({
    state,
    windowRef: dom.window,
    constants: {},
    getLazySectionDom: (sectionId) => (sectionId === 'personality'
      ? {
        personalityFormHost: document.getElementById('personalityFormHost'),
        personalityActions: document.getElementById('personalityActions'),
      }
      : { memoryNotesActions: document.getElementById('personalityActions') }),
    callbacks: {
      renderPersonalityEditor: () => { calls.renders += 1; },
      renderMemoryContextFiles: () => { calls.renders += 1; },
      handlePersonalitySave: async () => {
        calls.save += 1;
        state.personality.saving = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.personality.saving = false;
        state.personality.dirty = false;
      },
      handlePersonalityReset: async () => { calls.clear += 1; },
      handlePersonalityOpenFolder: async () => { calls.openFolder += 1; },
      saveMemoryContextFile: async () => {},
      resetMemoryContextFile: async () => {},
      toErrorMessage: (error, fallback) => String((error && error.message) || fallback),
      ...options.callbacks,
    },
  });
  binders.bindSection('personality', {
    registerSectionListener: (target, eventName, handler) => {
      if (!target) return;
      target.addEventListener(eventName, handler);
      listeners.push([target, eventName, handler]);
    },
    finalizeSectionBindings: () => true,
    markSectionBound: () => {},
    addCleanup: (fn) => cleanups.push(fn),
  });
  t.after(() => {
    for (const [target, eventName, handler] of listeners) target.removeEventListener(eventName, handler);
    for (const fn of cleanups) fn();
    dom.window.close();
  });
  return { calls, document, dom, state };
}

function pressCtrlS(harness, targetId) {
  const event = new harness.dom.window.KeyboardEvent('keydown', {
    key: 's', ctrlKey: true, bubbles: true, cancelable: true,
  });
  harness.document.getElementById(targetId).dispatchEvent(event);
  return event;
}

test('Ctrl+S inside the Personality section saves exactly once, even pressed twice', async (t) => {
  const harness = createBinderHarness(t);

  const first = pressCtrlS(harness, 'personalityFormHost');
  assert.equal(first.defaultPrevented, true, 'Ctrl+S must not fall through to Save Page');
  // `dirty` is still true while the write is in flight; the saving flag is the
  // only thing standing between a double tap and two concurrent writes.
  assert.equal(harness.state.personality.saving, true);
  pressCtrlS(harness, 'personalityFormHost');
  assert.equal(harness.calls.save, 1, 'a second Ctrl+S during the save is swallowed');

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.calls.save, 1);
  assert.equal(harness.state.personality.dirty, false);
});

test('Ctrl+S is swallowed but does nothing when the section is clean', async (t) => {
  const harness = createBinderHarness(t);
  harness.state.personality.dirty = false;

  const event = pressCtrlS(harness, 'personalityFormHost');
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.calls.save, 0);
});

test('Ctrl+S with focus outside the Personality section never saves', async (t) => {
  const harness = createBinderHarness(t);

  const event = pressCtrlS(harness, 'elsewhere');
  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.calls.save, 0);
});

test('Clear says so instead of silently doing nothing when the confirm dialog is unavailable', async (t) => {
  const harness = createBinderHarness(t);
  // The jsdom harness has no rendererIdeConfirmDialog, so createConfirmDialog
  // returns null -- the path this test exists to cover.
  harness.document.getElementById('personalityActions').innerHTML =
    '<button data-action="personality-clear">Clear</button>';
  harness.document.querySelector('[data-action="personality-clear"]')
    .dispatchEvent(new harness.dom.window.Event('click', { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.calls.clear, 0, 'both files must never be wiped without a confirm');
  assert.equal(harness.state.personality.actionStatus, 'Clear is unavailable.');
});
