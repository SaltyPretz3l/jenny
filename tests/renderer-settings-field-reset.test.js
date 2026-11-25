'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { createSettingsFieldReset } = require('../renderer/shell/renderer-settings-field-reset.js');
const actionButton = require('../renderer/inventory/action-button.js');

function buildDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <section class="settings-card" data-settings-section="appearance">
        <h3>Appearance</h3>
        <div class="settings-field-row">
          <div class="settings-field-row-text"><label for="appearancePaletteSelect">Palette</label></div>
          <label class="select-shell">
            <select id="appearancePaletteSelect">
              <option value="midnight">Midnight</option>
              <option value="obsidian" selected>Obsidian</option>
            </select>
          </label>
        </div>
        <div class="settings-field-row">
          <div class="settings-field-row-text"><label for="appearanceSurfaceEffectSelect">Surface effect</label></div>
          <label class="select-shell">
            <select id="appearanceSurfaceEffectSelect">
              <option value="none" selected>None</option>
              <option value="circuit-trace">Circuit Trace</option>
            </select>
          </label>
        </div>
        <div class="settings-actions">
          <button id="appearanceResetButton" class="settings-secondary" type="button">Reset Appearance</button>
        </div>
      </section>
    </body></html>`,
    { pretendToBeVisual: true, url: 'http://localhost/' }
  );
  return { dom, documentRef: dom.window.document };
}

function createHarness(dom, documentRef, options) {
  const opts = options || {};
  const onAfterResetCalls = [];
  const logs = [];
  const resetActionCalls = { appearance: 0, chatZoom: 0 };
  const resetActions = Object.assign(
    {
      appearance: () => { resetActionCalls.appearance += 1; return Promise.resolve(); },
      chatZoom: () => { resetActionCalls.chatZoom += 1; return Promise.resolve(); },
    },
    opts.resetActions
  );
  const fieldReset = createSettingsFieldReset({
    documentRef,
    actionButton,
    onAfterReset: () => onAfterResetCalls.push(true),
    log: (message) => logs.push(message),
    resetActions,
    confirmLabels: opts.confirmLabels,
    confirmDetails: opts.confirmDetails,
  });
  return {
    fieldReset, onAfterResetCalls, logs, resetActionCalls,
  };
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── per-field Revert belongs to the shared binding ─────────────────────

test("mount() adds no per-field reset affordance: Revert is the shared binding's", () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  assert.equal(documentRef.querySelector('[data-action$="SelectReset"]'), null);
  assert.equal(documentRef.querySelectorAll('.settings-field-reset').length, 0);
  assert.equal(harness.fieldReset.getSectionEntries().length, 1, 'only the section reset mounts');

  dom.window.close();
});

// ── section reset: the confirm strip ────────────────────────────────────

const stripOf = (documentRef) => documentRef.querySelector('.projects-confirm');

test('the first click on a section reset trigger opens the confirm strip under the button instead of resetting', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef, { confirmLabels: { appearance: 'Reset Appearance to its defaults?' },
    confirmDetails: { appearance: 'Your theme goes back to its defaults.' } });
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();

  assert.equal(harness.resetActionCalls.appearance, 0, 'not reset yet -- only asked');
  const strip = stripOf(documentRef);
  assert.equal(strip.previousElementSibling, trigger.closest('.settings-actions'), 'under the button');
  assert.equal(strip.getAttribute('role'), 'group');
  assert.equal(strip.querySelector('strong').textContent, 'Reset Appearance to its defaults?');
  assert.match(strip.textContent, /Your theme goes back to its defaults\./);
  assert.equal(strip.querySelector('[data-action="confirm"]').textContent.trim(), 'Reset Appearance');
  assert.ok(strip.querySelector('[data-action="confirm"]').className.includes('btn--danger'), 'the danger button');
  assert.ok(strip.querySelector('[data-action="cancel"]'), 'Cancel shown');
  assert.equal(documentRef.activeElement, strip.querySelector('[data-action="cancel"]'), 'the safe answer holds focus');

  dom.window.close();
});

test('Confirm performs the resetActions callback for that section and calls onAfterReset, then removes the strip', async () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  stripOf(documentRef).querySelector('[data-action="confirm"]').click();
  await flushAsync();

  assert.equal(harness.resetActionCalls.appearance, 1);
  assert.equal(harness.onAfterResetCalls.length, 1);
  assert.equal(stripOf(documentRef), null, 'strip gone after confirm settles');

  dom.window.close();
});

test('Cancel removes the strip without invoking the reset action, and a second click does not stack strips', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  trigger.click();
  assert.equal(documentRef.querySelectorAll('.projects-confirm').length, 1);
  stripOf(documentRef).querySelector('[data-action="cancel"]').click();

  assert.equal(harness.resetActionCalls.appearance, 0);
  assert.equal(stripOf(documentRef), null);

  dom.window.close();
});

test('Escape cancels and focus returns to the button that opened the strip', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.focus();
  trigger.click();
  const cancel = stripOf(documentRef).querySelector('[data-action="cancel"]');
  assert.equal(documentRef.activeElement, cancel);

  cancel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(stripOf(documentRef), null, 'Escape closes the strip');
  assert.equal(harness.resetActionCalls.appearance, 0);
  assert.equal(documentRef.activeElement, trigger, 'focus returns to the trigger');

  dom.window.close();
});

test('a confirmed reset that leaves the trigger disabled hands focus to the page heading', async () => {
  const { dom, documentRef } = buildDom();
  const trigger = documentRef.getElementById('appearanceResetButton');
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  trigger.focus();
  trigger.click();
  const confirm = stripOf(documentRef).querySelector('[data-action="confirm"]');
  confirm.focus();
  confirm.click();
  // What the app's repaint does once the page is back at its defaults.
  trigger.disabled = true;
  await flushAsync();

  assert.equal(harness.resetActionCalls.appearance, 1);
  assert.equal(documentRef.activeElement, documentRef.querySelector('.settings-card h3'), 'focus does not fall to the page body');

  dom.window.close();
});

test('the strip has no timer: it stays until answered, and a click elsewhere leaves it open', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  documentRef.getElementById('appearanceResetButton').click();
  documentRef.body.click();

  assert.ok(stripOf(documentRef), 'still open');
  assert.equal(harness.resetActionCalls.appearance, 0);

  dom.window.close();
});

// ── section reset: single in-flight guard ──────────────────────

test('rapid confirm/confirm/cancel while a reset is in flight is idempotent: the action fires exactly once', async () => {
  const { dom, documentRef } = buildDom();
  let resolveAction;
  let callCount = 0;
  const pendingAction = new Promise((resolve) => { resolveAction = resolve; });
  const harness = createHarness(dom, documentRef, {
    resetActions: {
      appearance: () => { callCount += 1; return pendingAction; },
    },
  });
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  const confirmBtn = stripOf(documentRef).querySelector('[data-action="confirm"]');
  const cancelBtn = stripOf(documentRef).querySelector('[data-action="cancel"]');

  confirmBtn.click();
  assert.equal(callCount, 1);
  // Rapid repeat clicks while in flight: no-ops (guarded by entry.inFlight).
  confirmBtn.click();
  cancelBtn.click();
  assert.equal(callCount, 1, 'the action only ran once');
  assert.ok(stripOf(documentRef), 'the strip stays mid-flight');

  resolveAction();
  await flushAsync();

  assert.equal(harness.onAfterResetCalls.length, 1);
  assert.equal(stripOf(documentRef), null);

  dom.window.close();
});

test('a resetActions rejection logs but still disarms and does not call onAfterReset', async () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef, {
    resetActions: { appearance: () => Promise.reject(new Error('storage unavailable')) },
  });
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  stripOf(documentRef).querySelector('[data-action="confirm"]').click();
  await flushAsync();

  assert.equal(harness.onAfterResetCalls.length, 0);
  assert.match(harness.logs.join('\n'), /storage unavailable/);
  assert.equal(stripOf(documentRef), null, 'the strip closes even on failure');

  dom.window.close();
});

test('a failed reset is shown inline beside the trigger until the next arm', async () => {
  const { dom, documentRef } = buildDom();
  let fail = true;
  const harness = createHarness(dom, documentRef, {
    resetActions: { appearance: () => (fail ? Promise.reject(new Error('storage unavailable')) : Promise.resolve()) },
  });
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  const container = trigger.closest('.settings-actions');
  trigger.click();
  stripOf(documentRef).querySelector('[data-action="confirm"]').click();
  await flushAsync();

  const alert = container.querySelector('.settings-reset-error');
  assert.ok(alert, 'the failure is on screen');
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.match(alert.textContent, /Could not reset: storage unavailable/);

  fail = false;
  trigger.click();
  assert.equal(container.querySelector('.settings-reset-error'), null, 'the next arm clears it');
  stripOf(documentRef).querySelector('[data-action="confirm"]').click();
  await flushAsync();
  assert.equal(container.querySelector('.settings-reset-error'), null, 'a successful reset shows no error');

  dom.window.close();
});

test('a reset action that throws synchronously is shown inline too', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef, {
    resetActions: { appearance: () => { throw new Error('boom'); } },
  });
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  const container = trigger.closest('.settings-actions');
  trigger.click();
  stripOf(documentRef).querySelector('[data-action="confirm"]').click();

  assert.match(container.querySelector('.settings-reset-error').textContent, /boom/);
  assert.equal(trigger.hidden, false);
  harness.fieldReset.dispose();
  assert.equal(container.querySelector('.settings-reset-error'), null, 'dispose removes it');

  dom.window.close();
});

// ── dispose ──────────────────────────────────────────────────────────────

test('dispose() removes listeners and any still-open confirm strip', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  assert.ok(stripOf(documentRef));

  harness.fieldReset.dispose();

  assert.equal(stripOf(documentRef), null);
  // Clicking the (now unbound) trigger no longer opens anything.
  trigger.click();
  assert.equal(stripOf(documentRef), null);

  dom.window.close();
});

// ── review finding (2026-07-09): arm() without the action-button builder ──

test('when the actionButton builder is unavailable, a section-reset click falls back to a direct (pre-two-step) reset instead of arming with no Confirm/Cancel', async () => {
  const { dom, documentRef } = buildDom();
  const resetActionCalls = { appearance: 0 };
  const fieldReset = createSettingsFieldReset({
    documentRef,
    actionButton: null, // explicit override: builder unavailable
    resetActions: {
      appearance: () => { resetActionCalls.appearance += 1; return Promise.resolve(); },
    },
  });
  fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  await flushAsync();

  assert.equal(resetActionCalls.appearance, 1, 'reset ran directly');
  assert.equal(stripOf(documentRef), null, 'no strip without a builder');

  fieldReset.dispose();
  dom.window.close();
});
