'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const section = require('../renderer/shell/renderer-settings-compaction-section');
const support = require('../renderer/shell/renderer-settings-support');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function registerListener(target, name, handler, options) { target.addEventListener(name, handler, options); }

// Awaits the callback so the window global outlives every await inside it.
async function withHarness(tuning, setTuning, run) {
  const previousWindow = globalThis.window;
  const dom = new JSDOM('<div id="contextCompactionTuning"></div>');
  const container = dom.window.document.getElementById('contextCompactionTuning');
  const state = { compactionTuning: tuning };
  const calls = [];
  const errors = [];
  dom.window.jennyShell = { compaction: { getTuning: async () => tuning, setTuning: (payload) => { calls.push(payload); return setTuning(payload, calls.length); } } };
  globalThis.window = dom.window;
  const render = () => {
    container.innerHTML = support.buildCompactionTuningMarkup({
      customPromptValue: String(state.compactionTuning?.customPrompt || ''),
      statusMessage: state.compactionTuningActivity?.message || '',
      statusTone: state.compactionTuningActivity?.tone || 'info',
    });
  };
  const controller = new dom.window.AbortController();
  section.bindCompactionSection({
    container, state, renderSettings: render, registerListener, listenerOptions: { signal: controller.signal },
    showSessionActionError: (error, title) => errors.push([title, error?.message]),
  });
  render();
  const field = () => container.querySelector('#compactionPromptField');
  const edit = async (value) => {
    field().value = value;
    field().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    await flush();
  };
  try {
    return await run({ dom, container, state, calls, errors, field, edit, controller });
  } finally {
    controller.abort();
    globalThis.window = previousWindow;
  }
}
const applied = (payload) => Promise.resolve({ status: 'applied', state: { customPrompt: payload.customPrompt, revision: 7 } });

test('an edit saves the guidance once, adopts the echoed tuning state and says so', () => withHarness({ customPrompt: '' }, applied, async ({ container, state, calls, field, edit }) => {
  assert.equal(field().tagName, 'TEXTAREA');
  assert.equal(container.querySelector('[data-action="reset-compaction-prompt"]'), null, 'the private reset button is gone');
  await edit('Keep file paths.');
  assert.deepEqual(calls, [{ customPrompt: 'Keep file paths.' }]);
  assert.deepEqual(state.compactionTuning, { customPrompt: 'Keep file paths.', revision: 7 });
  assert.equal(field().value, 'Keep file paths.');
  assert.equal(field().disabled, false);
  assert.match(container.querySelector('#compactionTuningStatus').textContent, /applied/i);
  assert.ok(container.querySelector('[data-setting-revert="compactionPromptField"]'), 'a set prompt offers Revert');
}));

test('Revert clears the guidance through the same save', () => withHarness({ customPrompt: 'Keep file paths.' }, applied, async ({ container, state, calls, field }) => {
  container.querySelector('[data-setting-revert="compactionPromptField"]').click();
  await flush();
  await flush();
  assert.deepEqual(calls, [{ customPrompt: '' }]);
  assert.equal(state.compactionTuning.customPrompt, '');
  assert.equal(field().value, '');
  assert.equal(container.querySelector('[data-setting-revert="compactionPromptField"]'), null);
}));

test('a save the service does not apply restores the acknowledged guidance and shows the reason', () => withHarness(
  { customPrompt: 'Old guidance.' },
  () => Promise.resolve({ status: 'rejected', reason: 'model_busy', state: { customPrompt: 'Old guidance.', revision: 3 } }),
  async ({ container, state, field, edit }) => {
    await edit('New guidance.');
    assert.equal(field().value, 'Old guidance.');
    assert.deepEqual(state.compactionTuning, { customPrompt: 'Old guidance.', revision: 3 });
    assert.match(container.querySelector('[data-settings-field="compactionPromptField"] .settings-field-error').textContent, /Not applied: model busy/);
    assert.match(container.querySelector('#compactionTuningStatus').textContent, /Not applied: model busy/);
  }
));

test('an applied answer that echoes different text is an error, and the row shows what the service holds', () => withHarness(
  { customPrompt: 'Old guidance.' },
  () => Promise.resolve({ status: 'applied', state: { customPrompt: 'Something else.' } }),
  async ({ container, state, field, edit }) => {
    await edit('New guidance.');
    assert.equal(field().value, 'Something else.');
    assert.equal(state.compactionTuning.customPrompt, 'Something else.');
    assert.ok(container.querySelector('[data-settings-field="compactionPromptField"] .settings-field-error').textContent);
  }
));

test('a save the service could not roll back keeps the text the service still holds', () => withHarness(
  { customPrompt: '' },
  (payload) => Promise.resolve({ status: 'degraded', reason: 'rollback_persistence_failed', state: { customPrompt: payload.customPrompt, revision: 4 } }),
  async ({ container, state, field, edit }) => {
    await edit('New guidance.');
    assert.equal(state.compactionTuning.customPrompt, 'New guidance.', 'the stored prompt, not the renderer baseline');
    assert.equal(field().value, 'New guidance.');
    assert.ok(container.querySelector('[data-setting-revert="compactionPromptField"]'), 'a stored prompt keeps its Revert');
    assert.match(container.querySelector('[data-settings-field="compactionPromptField"] .settings-field-error').textContent, /rollback persistence failed/);
  }
));

test('guidance that cannot be edited cannot be reverted either', () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.getElementById('host');
  host.innerHTML = support.buildCompactionTuningMarkup({ customPromptValue: 'Keep file paths.', disabled: true });
  assert.equal(host.querySelector('#compactionPromptField').disabled, true);
  assert.equal(host.querySelector('[data-setting-revert="compactionPromptField"]').disabled, true);
});

test('an applied answer without an echoed prompt does not acknowledge a Revert', () => withHarness(
  { customPrompt: 'Old guidance.' },
  () => Promise.resolve({ status: 'applied' }),
  async ({ container, state, field }) => {
    container.querySelector('[data-setting-revert="compactionPromptField"]').click();
    await flush();
    await flush();
    assert.equal(field().value, 'Old guidance.');
    assert.equal(state.compactionTuning.customPrompt, 'Old guidance.');
    assert.ok(container.querySelector('[data-settings-field="compactionPromptField"] .settings-field-error').textContent);
  }
));

test('surrounding whitespace is dropped before the save, as the service stores it', () => withHarness(
  { customPrompt: '' },
  (payload) => Promise.resolve({ status: 'applied', state: { customPrompt: payload.customPrompt.trim() } }),
  async ({ state, calls, errors, field, edit }) => {
    await edit('  Keep file paths.\n');
    assert.deepEqual(calls, [{ customPrompt: 'Keep file paths.' }]);
    assert.equal(state.compactionTuning.customPrompt, 'Keep file paths.');
    assert.equal(field().value, 'Keep file paths.');
    assert.deepEqual(errors, []);
  }
));

test('a failed call and a missing bridge both keep the acknowledged guidance', () => withHarness(
  { customPrompt: 'Old guidance.' },
  () => Promise.reject(new Error('ipc down')),
  async ({ dom, container, state, field, edit }) => {
    await edit('New guidance.');
    assert.equal(field().value, 'Old guidance.');
    assert.equal(state.compactionTuning.customPrompt, 'Old guidance.');
    assert.match(container.querySelector('[data-settings-field="compactionPromptField"] .settings-field-error').textContent, /ipc down/);
    dom.window.jennyShell.compaction = {};
    await edit('Another try.');
    assert.equal(field().value, 'Old guidance.');
    assert.match(container.querySelector('#compactionTuningStatus').textContent, /unavailable/i);
  }
));

test('a second edit made while the first is saving is written after it, not dropped', () => {
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  return withHarness(
    { customPrompt: '' },
    (payload, n) => (n === 1 ? first.then(() => ({ status: 'applied', state: { customPrompt: payload.customPrompt } })) : applied(payload)),
    async ({ dom, state, calls, field }) => {
      field().value = 'One.';
      field().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await flush();
      // The field is busy while its write is in flight; a programmatic edit still queues.
      field().value = 'Two.';
      field().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await flush();
      assert.equal(calls.length, 1, 'writes are serialized');
      release();
      await flush();
      await flush();
      await flush();
      assert.deepEqual(calls, [{ customPrompt: 'One.' }, { customPrompt: 'Two.' }]);
      assert.equal(state.compactionTuning.customPrompt, 'Two.');
      assert.equal(field().value, 'Two.');
    }
  );
});
