'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { createSettingsFieldReset } = require('../renderer/shell/renderer-settings-field-reset.js');
const { createSettingsAdapter } = require('../renderer/shell/renderer-settings-persistence-adapters.js');
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

const DEFAULTS = { paletteId: 'midnight', surfaceEffectId: 'none' };

function createFakeAppearanceAdapter(overrides) {
  let current = { paletteId: 'obsidian', surfaceEffectId: 'none' };
  const writes = [];
  const spec = Object.assign(
    {
      id: 'appearance',
      read: () => current,
      write: (value) => {
        writes.push(value);
        current = value;
        return value;
      },
      getDefault: () => Object.assign({}, DEFAULTS),
    },
    overrides
  );
  const adapter = createSettingsAdapter(spec);
  return {
    adapter,
    writes,
    getCurrent: () => current,
    setCurrent: (v) => { current = v; },
  };
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
  const { adapter, writes, getCurrent, setCurrent } = createFakeAppearanceAdapter(opts.adapterOverrides);
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
    adapters: { appearance: adapter },
    actionButton,
    onAfterReset: () => onAfterResetCalls.push(true),
    log: (message) => logs.push(message),
    resetActions,
    armTimeoutMs: 5000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return {
    fieldReset, adapter, writes, getCurrent, setCurrent, onAfterResetCalls, logs, timers, resetActionCalls,
  };
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fieldButton(documentRef, selectId) {
  return documentRef.querySelector('[data-action="' + selectId + 'Reset"]');
}

// ── per-field reset: visibility ────────────────────────────────────────

test('per-field reset button is hidden when the field is already at its default, shown when it differs', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  // paletteId 'obsidian' != default 'midnight' -> visible.
  assert.equal(fieldButton(documentRef, 'appearancePaletteSelect').hidden, false);
  assert.equal(fieldButton(documentRef, 'appearanceSurfaceEffectSelect').hidden, true);

  dom.window.close();
});

test('per-field reset mounts on the title line of the row text column, right after the label, not beside the select', () => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <section class="settings-card" data-settings-section="appearance">
        <div class="settings-field-row">
          <div class="settings-field-row-text">
            <label class="settings-field-label" for="appearancePaletteSelect">Palette</label>
            <p class="settings-field-description">The color scheme.</p>
          </div>
          <label class="select-shell"><select id="appearancePaletteSelect"><option value="midnight">Midnight</option><option value="obsidian" selected>Obsidian</option></select></label>
        </div>
        <div class="settings-actions"><button id="appearanceResetButton" type="button">Reset Appearance</button></div>
      </section>
    </body></html>`,
    { pretendToBeVisual: true, url: 'http://localhost/' }
  );
  const documentRef = dom.window.document;
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();
  const button = fieldButton(documentRef, 'appearancePaletteSelect');
  assert.ok(button);
  const textColumn = documentRef.querySelector('.settings-field-row-text');
  assert.equal(button.parentElement, textColumn, 'lives in the text column');
  assert.equal(textColumn.children[0].className, 'settings-field-label');
  assert.equal(textColumn.children[1], button, 'immediately after the label');
  assert.equal(textColumn.children[2].className, 'settings-field-description', 'description still follows');
  assert.equal(documentRef.querySelector('.select-shell + .settings-field-reset'), null, 'not beside the select');
  assert.match(button.textContent, /Reset/);
  assert.ok(button.classList.contains('settings-field-reset'));
  dom.window.close();
});

test('per-field reset buttons carry an accessible label naming the field', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  const btn = fieldButton(documentRef, 'appearancePaletteSelect');
  assert.match(btn.getAttribute('aria-label'), /Palette/);
  assert.equal(btn.tagName, 'BUTTON');

  dom.window.close();
});

// ── per-field reset: click writes {key: default} + calls onAfterReset ──

test('clicking a per-field reset button writes {...current, [key]: default} through the appearance adapter and calls onAfterReset', async () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  fieldButton(documentRef, 'appearancePaletteSelect').click();
  await flushAsync();

  assert.deepEqual(harness.writes, [{ paletteId: 'midnight', surfaceEffectId: 'none' }]);
  assert.equal(harness.onAfterResetCalls.length, 1);
  // Now at default -> button hides itself.
  assert.equal(fieldButton(documentRef, 'appearancePaletteSelect').hidden, true);

  dom.window.close();
});

test('a per-field reset write failure logs and does not call onAfterReset', async () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef, {
    adapterOverrides: { write: () => Promise.reject(new Error('disk full')) },
  });
  harness.fieldReset.mount();

  fieldButton(documentRef, 'appearancePaletteSelect').click();
  await flushAsync();

  assert.equal(harness.onAfterResetCalls.length, 0);
  assert.equal(harness.logs.length, 1);
  assert.match(harness.logs[0], /disk full/);

  dom.window.close();
});

// ── per-field reset: syncVisibility ─────────────────────────────────────

test('syncVisibility() re-evaluates every field button against a value changed externally (not via this module)', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  assert.equal(fieldButton(documentRef, 'appearanceSurfaceEffectSelect').hidden, true);
  harness.setCurrent({ paletteId: 'obsidian', surfaceEffectId: 'circuit-trace' });
  // Not yet re-synced.
  assert.equal(fieldButton(documentRef, 'appearanceSurfaceEffectSelect').hidden, true);

  harness.fieldReset.syncVisibility();
  assert.equal(fieldButton(documentRef, 'appearanceSurfaceEffectSelect').hidden, false);

  dom.window.close();
});

test('a native "change" event on a watched select re-syncs that field\'s visibility automatically', () => {
  const { dom, documentRef } = buildDom();
  const harness = createHarness(dom, documentRef);
  harness.fieldReset.mount();

  harness.setCurrent({ paletteId: 'obsidian', surfaceEffectId: 'circuit-trace' });
  const select = documentRef.getElementById('appearanceSurfaceEffectSelect');
  select.dispatchEvent(new documentRef.defaultView.Event('change', { bubbles: true }));

  assert.equal(fieldButton(documentRef, 'appearanceSurfaceEffectSelect').hidden, false);

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
    adapters: { appearance: createFakeAppearanceAdapter().adapter },
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

test('Chat width is per-field resettable: the button appears on Wide and writes chatWidthId back to default', async () => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <section class="settings-card" data-settings-section="appearance">
        <div class="settings-field-row">
          <div class="settings-field-row-text"><label for="appearanceChatWidthSelect">Chat width</label></div>
          <label class="select-shell">
            <select id="appearanceChatWidthSelect">
              <option value="default">Default</option>
              <option value="wide" selected>Wide</option>
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
  const documentRef = dom.window.document;
  const harness = createHarness(dom, documentRef, {
    adapterOverrides: {
      read: () => ({ paletteId: 'midnight', chatWidthId: 'wide' }),
      getDefault: () => ({ paletteId: 'midnight', chatWidthId: 'default' }),
    },
  });
  harness.fieldReset.mount();

  const button = fieldButton(documentRef, 'appearanceChatWidthSelect');
  assert.ok(button, 'Chat width is registered in APPEARANCE_FIELD_MAP');
  assert.equal(button.hidden, false, 'Wide differs from the default, so reset is offered');

  button.click();
  await flushAsync();

  assert.deepEqual(harness.writes, [{ paletteId: 'midnight', chatWidthId: 'default' }]);
  assert.equal(harness.onAfterResetCalls.length, 1);

  dom.window.close();
});
