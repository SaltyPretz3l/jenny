'use strict';

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

test('startup without a model does not permanently disable effort after model restoration', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = {
    models: {
      list: async () => ({
        data: [{
          id: 'gpt-5.6-sol',
          capabilities: {
            reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            default_reasoning_effort: 'low',
          },
        }],
      }),
    },
  };
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const model = window.document.getElementById('composerModelSelect');
  const effort = window.document.getElementById('composerEffortSelect');
  assert.equal(effort.disabled, true);
  assert.equal(effort.closest('.composer-select-shell').hidden, true);

  model.append(new window.Option('GPT-5.6 Sol', 'gpt-5.6-sol'));
  model.value = 'gpt-5.6-sol';
  window.reasoningEffortControls.reconcile();

  assert.equal(effort.disabled, false);
  assert.equal(effort.closest('.composer-select-shell').hidden, false);
  assert.deepEqual([...effort.options].map((option) => option.value), [
    'default', 'low', 'medium', 'high', 'xhigh', 'max',
  ]);
  window.reasoningEffortControls.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.close();
});

test('a stale unsupported effort resets to the session default without remaining selectable', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = { models: { list: async () => ({ available: true, data: [] }) } };
  const effort = window.document.getElementById('composerEffortSelect');
  effort.append(new window.Option('High', 'high'));
  effort.value = 'high';
  let changes = 0;
  effort.addEventListener('change', () => { changes += 1; });
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(effort.value, 'default');
  assert.equal(effort.closest('.composer-select-shell').hidden, true);
  assert.equal(changes, 0);
  window.reasoningEffortControls.dispose();
  dom.window.close();
});

test('opening the composer popover reconciles a programmatically switched conversation model', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = { models: { list: async () => ({ data: [] }) } };
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const model = window.document.getElementById('composerModelSelect');
  model.append(new window.Option('GPT-5.5', 'gpt-5.5'));
  model.value = 'gpt-5.5';
  window.document.getElementById('composerModelPillSlot').dispatchEvent(
    new window.Event('pointerdown', { bubbles: true }),
  );

  const effort = window.document.getElementById('composerEffortSelect');
  assert.equal(effort.disabled, false);
  assert.deepEqual([...effort.options].map((option) => option.value), [
    'default', 'low', 'medium', 'high', 'xhigh',
  ]);
  window.reasoningEffortControls.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.close();
});

test('canonical catalog snapshot restores Qwen3.8 effort controls after unavailable startup', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = {
    models: { list: async () => ({ available: false, data: [] }) },
  };
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const model = window.document.getElementById('composerModelSelect');
  const option = new window.Option('Qwen3.8 27B Q3_K_S', 'qwen3.8:27b-q3-k-s');
  option.dataset.engineType = 'ollama';
  model.append(option);
  model.value = option.value;
  window.reasoningEffortControls.reconcile();
  assert.equal(window.document.getElementById('composerEffortSelect').disabled, true);

  const applied = window.reasoningEffortControls.applyModelCatalog({
    available: true,
    data: [{
      id: 'qwen3.8:27b-q3-k-s',
      engine_type: 'ollama',
      capabilities: {
        thinking: true,
        reasoning_effort: true,
        reasoning_efforts: ['none', 'low', 'medium', 'high', 'max'],
        default_reasoning_effort: 'medium',
      },
    }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(applied, true);
  const effort = window.document.getElementById('composerEffortSelect');
  assert.equal(effort.disabled, false);
  assert.deepEqual(
    [...effort.options].map((entry) => entry.value),
    ['default', 'none', 'low', 'medium', 'high', 'max'],
  );

  assert.equal(
    window.reasoningEffortControls.applyModelCatalog({ available: false, data: [] }),
    false,
  );
  window.reasoningEffortControls.reconcile();
  assert.equal(window.document.getElementById('composerEffortSelect').disabled, false);

  window.reasoningEffortControls.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.close();
});

test('Composer model changes refresh capabilities and preserve the selected effort', async () => {
  const dom = createDocument();
  const { window } = dom;
  let catalogAvailable = false;
  let listCalls = 0;
  window.jennyShell = {
    models: {
      list: async () => {
        listCalls += 1;
        return catalogAvailable
          ? {
            available: true,
            data: [{
              id: 'qwen3.8:27b-q3-k-s',
              engine_type: 'ollama',
              capabilities: {
                reasoning_efforts: ['none', 'low', 'medium', 'high', 'max'],
                default_reasoning_effort: 'medium',
              },
            }],
          }
          : { available: false, data: [] };
      },
    },
  };
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const composerModel = window.document.getElementById('composerModelSelect');
  const composerOption = new window.Option('Unknown model', 'unknown-model');
  composerOption.dataset.engineType = 'ollama';
  composerModel.append(composerOption);
  composerModel.value = composerOption.value;

  const qwenOption = new window.Option('Qwen3.8', 'qwen3.8:27b-q3-k-s');
  qwenOption.dataset.engineType = 'ollama';
  composerModel.append(qwenOption);
  composerModel.value = qwenOption.value;
  catalogAvailable = true;
  window.reasoningEffortControls.applyModelCatalog(await window.jennyShell.models.list());
  await new Promise((resolve) => setTimeout(resolve, 0));

  const composerEffort = window.document.getElementById('composerEffortSelect');
  assert.equal(composerEffort.disabled, false);
  composerEffort.value = 'high';
  composerModel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(composerEffort.value, 'high');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(listCalls >= 3);
  assert.equal(composerEffort.value, 'high');

  window.reasoningEffortControls.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.close();
});

test('same model id keeps Ollama and ChatGPT reasoning capabilities isolated', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = {
    models: {
      list: async () => ({
        data: [
          {
            id: 'shared-model',
            engine_type: 'ollama',
            capabilities: {
              reasoning_efforts: ['none', 'low', 'medium', 'high', 'max'],
              default_reasoning_effort: 'medium',
            },
          },
          {
            id: 'shared-model',
            engine_type: 'chatgpt',
            capabilities: {
              reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
              default_reasoning_effort: 'medium',
            },
          },
        ],
      }),
    },
  };
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const model = window.document.getElementById('composerModelSelect');
  const ollamaOption = new window.Option('Ollama', 'shared-model');
  ollamaOption.dataset.engineType = 'ollama';
  model.append(ollamaOption);

  model.selectedIndex = 0;
  window.reasoningEffortControls.reconcile();
  const effort = window.document.getElementById('composerEffortSelect');
  assert.deepEqual([...effort.options].map((option) => option.value), [
    'default', 'none', 'low', 'medium', 'high', 'max',
  ]);

  ollamaOption.dataset.engineType = 'chatgpt';
  window.reasoningEffortControls.reconcile();
  assert.deepEqual([...effort.options].map((option) => option.value), [
    'default', 'low', 'medium', 'high', 'xhigh',
  ]);

  window.reasoningEffortControls.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.close();
});

test('llama-server Qwen3.8 exposes its native effort choices', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = {
    models: {
      list: async () => ({
        data: [{
          id: 'qwen3.8:27b-q3-k-s',
          engine_type: 'openai-compatible',
          capabilities: {
            thinking: true,
            reasoning_effort: true,
            reasoning_efforts: ['none', 'low', 'medium', 'xhigh'],
            default_reasoning_effort: 'medium',
          },
        }],
      }),
    },
  };
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const model = window.document.getElementById('composerModelSelect');
  const modelOption = new window.Option('Qwen3.8 27B Q3_K_S', 'qwen3.8:27b-q3-k-s');
  modelOption.dataset.engineType = 'openai-compatible';
  model.append(modelOption);
  model.value = 'qwen3.8:27b-q3-k-s';
  window.reasoningEffortControls.reconcile();

  const effort = window.document.getElementById('composerEffortSelect');
  assert.equal(effort.disabled, false);
  assert.deepEqual(
    [...effort.options].map((option) => option.value),
    ['default', 'none', 'low', 'medium', 'xhigh'],
  );

  window.reasoningEffortControls.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.close();
});

const BONSAI_ID = 'ternary-bonsai-2-27b-pq2_0';
const BONSAI_CATALOG = {
  available: true,
  data: [{
    id: BONSAI_ID,
    engine_type: 'openai-compatible',
    capabilities: {
      thinking: true,
      reasoning_effort: true,
      reasoning_efforts: ['none', 'medium', 'xhigh'],
      default_reasoning_effort: 'medium',
    },
  }],
};

function useDefaultModelSelect(window, backendModel = BONSAI_ID) {
  const model = window.document.getElementById('composerModelSelect');
  model.append(new window.Option('Use default', ''));
  model.value = '';
  model.dataset.backendModel = backendModel;
  model.dataset.backendEngineType = 'openai-compatible';
  return model;
}

test('"Use default" offers the backend model\'s efforts', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = { models: { list: async () => BONSAI_CATALOG } };
  useDefaultModelSelect(window);
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const effort = window.document.getElementById('composerEffortSelect');
  assert.equal(effort.dataset.reasoningSupported, 'true');
  assert.equal(effort.closest('.composer-select-shell').hidden, false);
  assert.deepEqual([...effort.options].map((option) => option.value), [
    'default', 'none', 'medium', 'xhigh',
  ]);
  window.reasoningEffortControls.dispose();
  dom.window.close();
});

test('a backend model the catalog has not seen triggers one catalog refresh', async () => {
  const dom = createDocument();
  const { window } = dom;
  let listCalls = 0;
  let catalog = { available: true, data: [] };
  window.jennyShell = { models: { list: async () => { listCalls += 1; return catalog; } } };
  const model = useDefaultModelSelect(window, '');
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const callsAfterBind = listCalls;

  // llama-server finishes loading: the backend model changes, the composer
  // stays on "Use default", and the catalog now lists the model.
  catalog = BONSAI_CATALOG;
  model.dataset.backendModel = BONSAI_ID;
  window.reasoningEffortControls.reconcile();
  window.reasoningEffortControls.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(listCalls, callsAfterBind + 1);
  const effort = window.document.getElementById('composerEffortSelect');
  assert.deepEqual([...effort.options].map((option) => option.value), [
    'default', 'none', 'medium', 'xhigh',
  ]);
  window.reasoningEffortControls.dispose();
  dom.window.close();
});

// Gate C4 F5: opening a chat must never rewrite its stored effort. The picker
// shows what the current model will run; the stored choice stays until the
// user changes it, and the request is clamped on send.
test('a saved effort the backend model lacks shows Automatic without saving over the chat', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = { models: { list: async () => BONSAI_CATALOG } };
  useDefaultModelSelect(window);
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const effort = window.document.getElementById('composerEffortSelect');
  const saved = [];
  effort.addEventListener('change', () => saved.push(effort.value));
  // renderSettings assigns a session's stale `low`; Bonsai has no Low option.
  effort.dataset.requestedEffort = 'low';
  effort.value = 'low';
  assert.equal(effort.value, '');
  window.reasoningEffortControls.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(effort.value, 'default');
  assert.deepEqual(saved, [], 'reconcile must not emit a change that persists the clamp');
  window.reasoningEffortControls.dispose();
  dom.window.close();
});

test('an unmatched saved effort is kept while the catalog does not know the model', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = { models: { list: async () => ({ available: false, data: [] }) } };
  useDefaultModelSelect(window);
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const effort = window.document.getElementById('composerEffortSelect');
  let changes = 0;
  effort.addEventListener('change', () => { changes += 1; });
  effort.dataset.requestedEffort = 'medium';
  effort.value = 'medium';
  window.reasoningEffortControls.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(changes, 0, 'startup without a catalog must not overwrite the saved effort');
  window.reasoningEffortControls.dispose();
  dom.window.close();
});

test('a valid saved effort on options still built for the previous model is kept, not saved as Automatic', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = {
    models: {
      list: async () => ({
        available: true,
        data: [
          { id: 'model-a', engine_type: 'ollama', capabilities: { reasoning_efforts: ['low', 'high'] } },
          BONSAI_CATALOG.data[0],
        ],
      }),
    },
  };
  const model = window.document.getElementById('composerModelSelect');
  const optionA = new window.Option('A', 'model-a');
  optionA.dataset.engineType = 'ollama';
  const optionB = new window.Option('Bonsai', BONSAI_ID);
  optionB.dataset.engineType = 'openai-compatible';
  model.append(optionA, optionB);
  model.value = 'model-a';
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const effort = window.document.getElementById('composerEffortSelect');
  const saved = [];
  effort.addEventListener('change', () => saved.push(effort.value));
  // Conversation switch: model B saved at xhigh, but the effort options are
  // still model A's, so the assignment leaves the select blank.
  model.value = BONSAI_ID;
  effort.dataset.requestedEffort = 'xhigh';
  effort.value = 'xhigh';
  assert.equal(effort.value, '');
  window.reasoningEffortControls.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(effort.value, 'xhigh');
  assert.deepEqual(saved, []);
  window.reasoningEffortControls.dispose();
  dom.window.close();
});

test('a preferred model missing from the options does not borrow the backend model efforts', async () => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = { models: { list: async () => BONSAI_CATALOG } };
  const model = window.document.getElementById('composerModelSelect');
  model.append(new window.Option('Other', 'other-model'));
  model.dataset.backendModel = BONSAI_ID;
  model.dataset.backendEngineType = 'openai-compatible';
  model.value = 'not-listed-yet';
  assert.equal(model.selectedOptions.length, 0);
  window.eval(profilesSource);
  window.eval(controlsSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const effort = window.document.getElementById('composerEffortSelect');
  assert.equal(effort.dataset.reasoningSupported, 'false');
  window.reasoningEffortControls.dispose();
  dom.window.close();
});
