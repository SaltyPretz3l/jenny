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

function createFakeTimers() {
  let idCounter = 0;
  const pending = new Map();
  return {
    setTimeoutFn: (fn) => {
      const id = (idCounter += 1);
      pending.set(id, fn);
      return id;
    },
    clearTimeoutFn: (id) => { pending.delete(id); },
    fireAll: () => {
      const fns = Array.from(pending.values());
      pending.clear();
      fns.forEach((fn) => fn());
    },
    pendingCount: () => pending.size,
  };
}

function createHarness(dom, documentRef, options) {
  const opts = options || {};
  const onAfterResetCalls = [];
  const logs = [];
  const timers = createFakeTimers();
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
    armTimeoutMs: 5000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return {
    fieldReset, onAfterResetCalls, logs, timers, resetActionCalls,
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

// ── two-step section reset: arm ─────────────────────────────────────────

test('the first click on a section reset trigger ARMS an inline confirm group instead of resetting immediately', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();

  assert.equal(harness.resetActionCalls.appearance, 0, 'not reset yet -- only armed');
  assert.equal(trigger.hidden, true);
  const container = trigger.closest('.settings-actions');
  assert.equal(container.classList.contains('settings-reset-confirm'), true);
  assert.equal(container.getAttribute('data-armed'), 'true');
  assert.ok(container.querySelector('[data-action="confirm"]'), 'Confirm affordance shown');
  assert.ok(container.querySelector('[data-action="cancel"]'), 'Cancel affordance shown');
  assert.match(container.querySelector('.settings-reset-confirm-label').textContent, /Reset all\?/);

  dom.window.close();
});

test('Confirm performs the resetActions callback for that section and calls onAfterReset, then disarms', async () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  const container = trigger.closest('.settings-actions');
  container.querySelector('[data-action="confirm"]').click();
  await flushAsync();

  assert.equal(harness.resetActionCalls.appearance, 1);
  assert.equal(harness.onAfterResetCalls.length, 1);
  assert.equal(container.classList.contains('settings-reset-confirm'), false, 'disarmed after confirm settles');
  assert.equal(trigger.hidden, false);

  dom.window.close();
});

test('Cancel disarms without invoking the reset action', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  const container = trigger.closest('.settings-actions');
  container.querySelector('[data-action="cancel"]').click();

  assert.equal(harness.resetActionCalls.appearance, 0);
  assert.equal(container.classList.contains('settings-reset-confirm'), false);
  assert.equal(trigger.hidden, false);

  dom.window.close();
});

test('clicking outside the armed confirm group disarms it', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  documentRef.body.click();

  assert.equal(harness.resetActionCalls.appearance, 0);
  const container = trigger.closest('.settings-actions');
  assert.equal(container.classList.contains('settings-reset-confirm'), false);
  assert.equal(trigger.hidden, false);

  dom.window.close();
});

test('the 5s arm timeout disarms an untouched confirm group', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  assert.equal(harness.timers.pendingCount(), 1);

  harness.timers.fireAll();

  const container = trigger.closest('.settings-actions');
  assert.equal(container.classList.contains('settings-reset-confirm'), false);
  assert.equal(trigger.hidden, false);
  assert.equal(harness.resetActionCalls.appearance, 0);

  dom.window.close();
});

// ── two-step section reset: single in-flight guard ──────────────────────

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
  const container = trigger.closest('.settings-actions');
  const confirmBtn = container.querySelector('[data-action="confirm"]');
  const cancelBtn = container.querySelector('[data-action="cancel"]');

  confirmBtn.click();
  assert.equal(callCount, 1);
  // Rapid repeat clicks while in flight: no-ops (guarded by entry.inFlight).
  confirmBtn.click();
  cancelBtn.click();
  assert.equal(callCount, 1, 'the action only ran once');
  assert.equal(container.classList.contains('settings-reset-confirm'), true, 'still armed/pending mid-flight');

  resolveAction();
  await flushAsync();

  assert.equal(harness.onAfterResetCalls.length, 1);
  assert.equal(container.classList.contains('settings-reset-confirm'), false);

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
  const container = trigger.closest('.settings-actions');
  container.querySelector('[data-action="confirm"]').click();
  await flushAsync();

  assert.equal(harness.onAfterResetCalls.length, 0);
  assert.match(harness.logs.join('\n'), /storage unavailable/);
  assert.equal(container.classList.contains('settings-reset-confirm'), false, 'disarmed even on failure');

  dom.window.close();
});

// ── dispose ──────────────────────────────────────────────────────────────

test('dispose() removes listeners and any still-armed confirm group', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const trigger = documentRef.getElementById('appearanceResetButton');
  trigger.click();
  const container = trigger.closest('.settings-actions');
  assert.equal(container.classList.contains('settings-reset-confirm'), true);

  harness.fieldReset.dispose();

  assert.equal(container.classList.contains('settings-reset-confirm'), false);
  assert.equal(trigger.hidden, false);
  // Clicking the (now unbound) trigger no longer arms anything.
  trigger.click();
  assert.equal(container.classList.contains('settings-reset-confirm'), false);

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
  assert.equal(trigger.hidden, false, 'trigger never hidden/stranded');
  const container = trigger.closest('.settings-actions');
  assert.equal(container.getAttribute('data-armed'), null, 'never armed');

  fieldReset.dispose();
  dom.window.close();
});
