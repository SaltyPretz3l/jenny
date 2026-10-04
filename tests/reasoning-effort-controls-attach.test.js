'use strict';

// Split view W2-2a -- reasoningEffortControls.attachCarriers (split from
// tests/reasoning-effort-controls.test.js, which stays pane 0's suite).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const profilesSource = fs.readFileSync(path.join(__dirname, '..', 'reasoning-effort-profiles.js'), 'utf8');
const controlsSource = fs.readFileSync(path.join(__dirname, '..', 'reasoning-effort-controls.js'), 'utf8');

function createDocument() {
  return new JSDOM(`<!doctype html><html><body>
    <div id="composerModelPillSlot">
      <select id="composerModelSelect"></select>
      <label class="composer-select-shell"><select id="composerEffortSelect"><option value="default">Use default</option></select></label>
    </div>
  </body></html>`, { runScripts: 'outside-only' });
}

// Split view W2-2a: a second pane's carrier pair. attachCarriers binds the
// same capture listeners, options observer and pointerdown reconcile for that
// pair; reconcile() covers pane 0's pair and every attached pair; the detach
// function removes all of it and leaves pane 0's pair alone.
test('attachCarriers reconciles a second pair and detaches cleanly, pane 0\'s pair unchanged', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = {
    models: {
      list: async () => ({
        data: [
          { id: 'gpt-5.6-sol', capabilities: { reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'low' } },
          { id: 'plain-model', capabilities: null },
        ],
      }),
    },
  };
  const doc = window.document;
  const slotB = doc.createElement('div');
  slotB.innerHTML = '<select data-pane-model></select><label class="composer-select-shell"><select data-pane-effort><option value="default">Use default</option></select></label>';
  doc.body.appendChild(slotB);
  const modelB = slotB.querySelector('[data-pane-model]');
  const effortB = slotB.querySelector('[data-pane-effort]');
  const proto = window.EventTarget.prototype;
  const originalAdd = proto.addEventListener;
  const originalRemove = proto.removeEventListener;
  const live = [];
  proto.addEventListener = function add(type, handler, options) {
    live.push({ target: this, type, handler, removed: false });
    return originalAdd.call(this, type, handler, options);
  };
  proto.removeEventListener = function remove(type, handler, options) {
    live.filter((entry) => entry.target === this && entry.type === type && entry.handler === handler).forEach((entry) => { entry.removed = true; });
    return originalRemove.call(this, type, handler, options);
  };
  try {
    window.eval(profilesSource);
    window.eval(controlsSource);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const effortA = doc.getElementById('composerEffortSelect');
    const beforeA = effortA.outerHTML;
    const liveBefore = live.length;

    assert.equal(typeof window.reasoningEffortControls.attachCarriers, 'function');
    const detach = window.reasoningEffortControls.attachCarriers({ modelSelect: modelB, effortSelect: effortB, pillSlot: slotB });
    assert.deepEqual(
      live.slice(liveBefore).map((entry) => `${entry.target === doc ? 'document' : entry.target.tagName.toLowerCase()}:${entry.type}`),
      ['select:change', 'select:change', 'document:pointerdown'],
      'the same capture listeners and pointerdown reconcile as pane 0\'s pair'
    );

    // The options observer: filling pane 1's model select reconciles pane 1's effort.
    modelB.append(new window.Option('GPT-5.6 Sol', 'gpt-5.6-sol'));
    modelB.value = 'gpt-5.6-sol';
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([...effortB.options].map((option) => option.value), ['default', 'low', 'high']);
    assert.equal(effortB.dataset.reasoningSupported, 'true');
    assert.equal(effortA.outerHTML, beforeA, 'pane 0\'s pair is untouched by pane 1\'s reconcile');

    // The pointerdown reconcile inside pane 1's pill slot picks up a programmatic switch.
    modelB.append(new window.Option('Plain', 'plain-model'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    modelB.value = 'plain-model';
    slotB.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    assert.equal(effortB.dataset.reasoningSupported, 'false');
    assert.equal(effortB.closest('.composer-select-shell').hidden, true);

    // reconcile() covers the attached pair too.
    modelB.value = 'gpt-5.6-sol';
    window.reasoningEffortControls.reconcile();
    assert.equal(effortB.dataset.reasoningSupported, 'true');

    detach();
    const leaked = live.slice(liveBefore).filter((entry) => !entry.removed).map((entry) => entry.type);
    assert.deepEqual(leaked, [], 'detach removes every listener it added');
    modelB.value = 'plain-model';
    window.reasoningEffortControls.reconcile();
    assert.equal(effortB.dataset.reasoningSupported, 'true', 'a detached pair is no longer reconciled');
    assert.equal(effortA.outerHTML, beforeA);
  } finally {
    proto.addEventListener = originalAdd;
    proto.removeEventListener = originalRemove;
    window.reasoningEffortControls.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();
  }
});

test('dispose detaches every attached pair', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = { models: { list: async () => ({ data: [{ id: 'm', capabilities: { reasoning_efforts: ['low'] } }] }) } };
  const doc = window.document;
  const modelB = doc.createElement('select');
  const effortB = doc.createElement('select');
  doc.body.append(modelB, effortB);
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  window.reasoningEffortControls.attachCarriers({ modelSelect: modelB, effortSelect: effortB, pillSlot: doc.body });
  window.reasoningEffortControls.dispose();
  modelB.append(new window.Option('M', 'm'));
  modelB.value = 'm';
  window.reasoningEffortControls.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(effortB.options.length, 0, 'a disposed control reconciles nothing');
  dom.window.close();
});
