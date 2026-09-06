'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const inventory = {
  actionButton: require('../renderer/inventory/action-button'),
  textField: require('../renderer/inventory/text-field'),
  popover: require('../renderer/inventory/popover'),
};
const utils = require('../renderer/chat/renderer-composer-model-picker-utils');
const formatUtils = require('../renderer/shell/renderer-model-library-format-utils');
const { createComposerModelPicker } = require('../renderer/chat/renderer-composer-model-picker');

function model(id, engineType = 'ollama', extra = {}) {
  return { id, engine_type: engineType, ...extra };
}

function createHarness(t, {
  catalog = [],
  preferredModel = '',
  backendModel = '',
  activeModel = '',
  selectIds = catalog.map((entry) => entry.id),
  effortSupported = false,
  effortOptions = [{ value: 'default', label: 'Use default' }],
  effort = 'default',
  locked = false,
} = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="composerModelPillSlot">
      <button id="composerModelPill" class="inv-chip composer-model-pill" aria-haspopup="dialog" aria-expanded="false" aria-controls="composerModelPopover"><span class="inv-chip-label">Model</span></button>
      <div class="inv-popover composer-model-popover" id="composerModelPopover" data-inv-popover="composer-model" role="dialog" aria-modal="false" aria-label="Model and reasoning effort" hidden>
        <div class="composer-model-picker" data-composer-model-picker></div>
        <div class="composer-model-carriers" hidden>
          <label class="composer-select-shell composer-select-model" for="composerModelSelect">
            <span class="composer-model-popover-label">Model</span>
            <select id="composerModelSelect" aria-label="Model selector"></select>
            <span class="sr-only" id="composerModelDisabledReason"></span>
          </label>
          <label class="composer-select-shell composer-select-effort" for="composerEffortSelect">
            <span class="composer-model-popover-label">Reasoning effort</span>
            <select id="composerEffortSelect" aria-label="Reasoning effort selector"></select>
            <span class="sr-only" id="composerEffortDisabledReason"></span>
          </label>
        </div>
      </div>
    </div>
  </body></html>`);
  const { document } = dom.window;
  // Production installs the Escape / click-away delegation on document; a
  // picker click that detaches its own target would read as an outside click.
  inventory.popover.initPopoverHandlers(document);
  const modelSelect = document.getElementById('composerModelSelect');
  modelSelect.append(new dom.window.Option('Use backend default', ''));
  selectIds.forEach((id) => modelSelect.append(new dom.window.Option(id, id)));
  modelSelect.value = preferredModel;
  if (locked) modelSelect.setAttribute('aria-disabled', 'true');

  const effortSelect = document.getElementById('composerEffortSelect');
  effortOptions.forEach((option) => {
    effortSelect.append(new dom.window.Option(option.label, option.value));
  });
  effortSelect.value = effort;
  effortSelect.dataset.reasoningSupported = effortSupported ? 'true' : 'false';

  const state = {
    status: { model: backendModel },
    modelList: { data: catalog, active_model: activeModel },
  };
  const picker = createComposerModelPicker({
    state,
    documentRef: document,
    inventory,
    utils,
    formatUtils,
  });
  picker.bind();
  t.after(() => {
    picker.dispose();
    dom.window.close();
  });
  return {
    dom,
    document,
    state,
    picker,
    pill: document.getElementById('composerModelPill'),
    popoverEl: document.getElementById('composerModelPopover'),
    host: document.querySelector('[data-composer-model-picker]'),
    modelSelect,
    effortSelect,
  };
}

function openPicker(harness) {
  inventory.popover.open(harness.popoverEl, { trigger: harness.pill });
}

function modelButton(host, id) {
  return [...host.querySelectorAll('[data-picker-model]')]
    .find((button) => button.dataset.pickerModel === id);
}

function press(dom, target, key) {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
}

test('opening renders defaults, engine groups, and the search threshold', (t) => {
  const mixedCatalog = Array.from({ length: 9 }, (_, index) => (
    index < 5 ? model(`local-${index}`) : model(`server-${index}`, 'vllm')
  ));
  const mixed = createHarness(t, {
    catalog: mixedCatalog,
    backendModel: 'local-0',
  });
  openPicker(mixed);

  const defaultRow = modelButton(mixed.host, '');
  assert.match(defaultRow.textContent, /Default/);
  assert.match(defaultRow.textContent, /local-0/);
  assert.deepEqual(
    [...mixed.host.querySelectorAll('.composer-model-picker-group')]
      .map((group) => group.textContent),
    ['Ollama', 'vLLM'],
  );
  assert.ok(mixed.host.querySelector('[data-picker-search]'));

  const single = createHarness(t, {
    catalog: Array.from({ length: 8 }, (_, index) => model(`single-${index}`)),
  });
  openPicker(single);
  assert.equal(single.host.querySelector('.composer-model-picker-group'), null);
  assert.equal(single.host.querySelector('[data-picker-search]'), null);
});

test('rows render loaded state, strict capabilities, size, and unavailability', (t) => {
  const sizeBytes = 2 * 1024 * 1024 * 1024;
  const catalog = [
    model('vision-model', 'ollama', {
      size: sizeBytes,
      parameter_size: '12B',
      quantization_level: 'Q6',
      capabilities: { vision: true, thinking: true, insert: true },
    }),
    model('offline-model', 'vllm', {
      available: false,
      reason: 'runtime missing',
      capabilities: { vision: false, thinking: false, insert: false },
    }),
  ];
  const harness = createHarness(t, { catalog, backendModel: 'vision-model:latest' });
  openPicker(harness);

  const loadedRow = modelButton(harness.host, 'vision-model');
  const offlineRow = modelButton(harness.host, 'offline-model');
  assert.ok(loadedRow.querySelector('.composer-model-picker-loaded'));
  assert.equal(offlineRow.querySelector('.composer-model-picker-loaded'), null);
  assert.deepEqual(
    [...loadedRow.querySelectorAll('.composer-model-picker-glyph')]
      .map((glyph) => glyph.getAttribute('aria-label')),
    ['Vision', 'Thinking', 'Code completion'],
  );
  assert.equal(offlineRow.querySelector('.composer-model-picker-glyph'), null);
  assert.equal(loadedRow.querySelector('.composer-model-picker-size').textContent,
    formatUtils.formatHumanSize(sizeBytes));
  assert.equal(loadedRow.querySelector('.composer-model-picker-size').title, '12B · Q6');
  assert.equal(offlineRow.disabled, true);
  assert.equal(offlineRow.getAttribute('aria-disabled'), 'true');
  assert.match(offlineRow.title, /runtime missing/);
});

test('model clicks drive the carrier once, close, and reject stale catalog ids', (t) => {
  const harness = createHarness(t, {
    catalog: [model('alpha'), model('beta')],
    preferredModel: 'alpha',
    backendModel: 'alpha',
  });
  let changes = 0;
  let bubbled = false;
  harness.modelSelect.addEventListener('change', (event) => {
    changes += 1;
    bubbled = event.bubbles;
  });
  openPicker(harness);
  modelButton(harness.host, 'beta').click();
  assert.equal(harness.modelSelect.value, 'beta');
  assert.equal(changes, 1);
  assert.equal(bubbled, true);
  assert.equal(harness.popoverEl.hidden, true);
  assert.strictEqual(harness.document.activeElement, harness.pill);

  openPicker(harness);
  modelButton(harness.host, 'beta').click();
  assert.equal(changes, 1);
  assert.equal(harness.popoverEl.hidden, true);

  const stale = createHarness(t, {
    catalog: [model('kept'), model('catalog-only')],
    preferredModel: 'kept',
    selectIds: ['kept'],
  });
  let staleChanges = 0;
  stale.modelSelect.addEventListener('change', () => { staleChanges += 1; });
  openPicker(stale);
  modelButton(stale.host, 'catalog-only').click();
  assert.equal(stale.modelSelect.value, 'kept');
  assert.equal(staleChanges, 0);
  assert.equal(stale.popoverEl.hidden, false);
});

test('thinking segments reflect support and drive the effort carrier', (t) => {
  const harness = createHarness(t, {
    catalog: [model('thinker', 'ollama', {
      capabilities: { default_reasoning_effort: 'high' },
    })],
    preferredModel: 'thinker',
    effortSupported: false,
    effortOptions: [
      { value: 'default', label: 'Use default' },
      { value: 'none', label: 'Off' },
    ],
  });
  openPicker(harness);
  assert.equal(harness.host.querySelector('.composer-model-picker-thinking'), null);

  harness.effortSelect.dataset.reasoningSupported = 'true';
  harness.picker.render();
  const segments = [...harness.host.querySelectorAll('[data-picker-effort]')];
  assert.deepEqual(segments.map((segment) => segment.textContent), ['Default', 'Off']);
  assert.deepEqual(segments.map((segment) => segment.getAttribute('aria-checked')), ['true', 'false']);
  assert.equal(segments[0].title, 'Model default (High)');

  let changes = 0;
  harness.effortSelect.addEventListener('change', () => { changes += 1; });
  segments[1].focus();
  segments[1].click();
  assert.equal(harness.effortSelect.value, 'none');
  assert.equal(changes, 1);
  assert.equal(harness.popoverEl.hidden, false, 'segment click must not read as click-away');
  assert.equal(harness.document.activeElement, segments[1], 'focus stays on the clicked segment');
  assert.deepEqual(
    [...harness.host.querySelectorAll('[data-picker-effort]')]
      .map((segment) => segment.getAttribute('aria-checked')),
    ['false', 'true'],
  );
});

test('keyboard navigation starts at search, wraps options, and selects with Enter', (t) => {
  const catalog = Array.from({ length: 9 }, (_, index) => model(`choice-${index}`));
  const harness = createHarness(t, { catalog });
  openPicker(harness);
  const search = harness.host.querySelector('[data-picker-search]');
  const options = [...harness.host.querySelectorAll('[data-picker-model]:not([disabled])')];

  press(harness.dom, search, 'ArrowDown');
  assert.strictEqual(harness.document.activeElement, options[0]);
  press(harness.dom, options[0], 'ArrowUp');
  assert.strictEqual(harness.document.activeElement, options.at(-1));
  press(harness.dom, options.at(-1), 'ArrowDown');
  assert.strictEqual(harness.document.activeElement, options[0]);
  press(harness.dom, options[0], 'ArrowDown');
  assert.strictEqual(harness.document.activeElement, options[1]);
  press(harness.dom, options[1], 'Enter');
  assert.equal(harness.modelSelect.value, 'choice-0');
  assert.equal(harness.popoverEl.hidden, true);
});

test('search filters catalog rows, reports no match, and resets on close', (t) => {
  const catalog = [model('qwen-small'), model('qwen-large')]
    .concat(Array.from({ length: 7 }, (_, index) => model(`other-${index}`)));
  const harness = createHarness(t, { catalog });
  openPicker(harness);
  let search = harness.host.querySelector('[data-picker-search]');
  search.value = 'qwen';
  search.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(
    [...harness.host.querySelectorAll('[data-picker-model]')]
      .map((button) => button.dataset.pickerModel),
    ['', 'qwen-small', 'qwen-large'],
  );

  search = harness.host.querySelector('[data-picker-search]');
  search.value = 'no-such-model';
  search.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  assert.ok(harness.host.querySelector('.composer-model-picker-empty'));
  assert.ok(modelButton(harness.host, ''));

  inventory.popover.close(harness.popoverEl);
  openPicker(harness);
  assert.equal(harness.host.querySelector('[data-picker-search]').value, '');
  assert.equal(harness.host.querySelectorAll('[data-picker-model]').length, catalog.length + 1);
});

test('syncPill formats model and effort and tracks loaded state', (t) => {
  const gemma = 'gemma4:12b-qat-ud-q4-k-xl';
  const ornith = 'ornith15:9b-q6-256k';
  const harness = createHarness(t, {
    catalog: [model(gemma), model(ornith)],
    preferredModel: gemma,
    backendModel: gemma,
    effortSupported: true,
    effortOptions: [
      { value: 'default', label: 'Use default' },
      { value: 'high', label: 'High' },
    ],
  });

  harness.picker.syncPill();
  assert.equal(harness.pill.querySelector('.inv-chip-label').textContent, 'gemma4 · 12b-qat');
  assert.strictEqual(harness.pill.firstChild, harness.pill.querySelector('.composer-model-pill-dot'));

  harness.effortSelect.value = 'high';
  harness.picker.syncPill();
  assert.equal(harness.pill.querySelector('.inv-chip-label').textContent,
    'gemma4 · 12b-qat · High');
  assert.match(harness.pill.title, /Thinking: High/);
  assert.equal(harness.pill.getAttribute('aria-label'),
    `Model and reasoning effort. ${harness.pill.title}`);

  harness.modelSelect.value = '';
  harness.effortSelect.value = 'default';
  harness.state.status.model = ornith;
  harness.picker.syncPill();
  assert.equal(harness.pill.querySelector('.inv-chip-label').textContent, 'Default · ornith15');
  assert.ok(harness.pill.querySelector('.composer-model-pill-dot'));

  harness.state.status.model = '';
  harness.state.modelList.active_model = ornith;
  harness.picker.syncPill();
  assert.equal(harness.pill.querySelector('.inv-chip-label').textContent, 'Default · ornith15');
  assert.equal(harness.pill.querySelector('.composer-model-pill-dot'), null);
});

test('signature gating preserves identity and focused search across a rebuild', (t) => {
  const catalog = [model('qwen-one')]
    .concat(Array.from({ length: 8 }, (_, index) => model(`other-${index}`)));
  const harness = createHarness(t, { catalog });
  harness.picker.render();
  const firstChild = harness.host.firstElementChild;
  harness.picker.render();
  assert.strictEqual(harness.host.firstElementChild, firstChild);

  const oldSearch = harness.host.querySelector('[data-picker-search]');
  oldSearch.focus();
  oldSearch.value = 'qwen';
  oldSearch.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  const newSearch = harness.host.querySelector('[data-picker-search]');
  assert.notStrictEqual(newSearch, oldSearch);
  assert.strictEqual(harness.document.activeElement, newSearch);
  assert.equal(newSearch.value, 'qwen');
  assert.equal(newSearch.selectionStart, 4);
  assert.equal(newSearch.selectionEnd, 4);
});

test('locked model carrier disables every option and suppresses changes', (t) => {
  const harness = createHarness(t, {
    catalog: [model('alpha'), model('beta')],
    preferredModel: 'alpha',
    locked: true,
  });
  let changes = 0;
  harness.modelSelect.addEventListener('change', () => { changes += 1; });
  openPicker(harness);

  const options = [...harness.host.querySelectorAll('[data-picker-model]')];
  assert.ok(options.length > 0);
  assert.ok(options.every((button) => button.disabled));
  modelButton(harness.host, 'beta').click();
  assert.equal(harness.modelSelect.value, 'alpha');
  assert.equal(changes, 0);
});

test('an effort-only lock disables the segments and drops clicks', (t) => {
  const harness = createHarness(t, {
    catalog: [model('thinker')],
    preferredModel: 'thinker',
    effortSupported: true,
    effortOptions: [
      { value: 'default', label: 'Use default' },
      { value: 'none', label: 'Off' },
    ],
  });
  openPicker(harness);
  assert.ok(harness.host.querySelectorAll('[data-picker-effort]:not([disabled])').length === 2);

  // A save in flight locks only the effort carrier; the model stays unlocked.
  harness.effortSelect.setAttribute('aria-disabled', 'true');
  harness.picker.render();
  const segments = [...harness.host.querySelectorAll('[data-picker-effort]')];
  assert.ok(segments.every((segment) => segment.disabled));
  let changes = 0;
  harness.effortSelect.addEventListener('change', () => { changes += 1; });
  segments[1].click();
  assert.equal(harness.effortSelect.value, 'default');
  assert.equal(changes, 0);
});

test('a saved model missing from the catalog still renders as the selected row', (t) => {
  const harness = createHarness(t, {
    catalog: [model('alpha')],
    selectIds: ['alpha', 'old:7b'],
    preferredModel: 'old:7b',
  });
  openPicker(harness);
  const retained = modelButton(harness.host, 'old:7b');
  assert.ok(retained, 'retained row rendered');
  assert.ok(retained.classList.contains('is-active'));
  assert.equal(retained.getAttribute('aria-selected'), 'true');
  assert.match(retained.title, /not in the current catalog/);
  assert.equal(modelButton(harness.host, '').getAttribute('aria-selected'), 'false');
});

test('metadata-only catalog changes re-render group labels and tooltips', (t) => {
  const harness = createHarness(t, {
    catalog: [model('alpha', 'vllm'), model('beta', 'ollama')],
    preferredModel: 'alpha',
  });
  openPicker(harness);
  assert.deepEqual(
    [...harness.host.querySelectorAll('.composer-model-picker-group')].map((el) => el.textContent),
    ['Ollama', 'vLLM'],
  );
  harness.state.modelList.data = [model('alpha', 'ollama'), model('beta', 'ollama')];
  harness.picker.render();
  assert.equal(harness.host.querySelector('.composer-model-picker-group'), null, 'single group hides labels');

  harness.state.modelList.data = [
    model('alpha', 'ollama', { size: 4096, parameter_size: '7B' }),
    model('beta', 'ollama'),
  ];
  harness.picker.render();
  assert.equal(modelButton(harness.host, 'alpha').querySelector('.composer-model-picker-size').title, '7B');
  harness.state.modelList.data[0].parameter_size = '8B';
  harness.picker.render();
  assert.equal(modelButton(harness.host, 'alpha').querySelector('.composer-model-picker-size').title, '8B');
});

test('a rebuild restores focus to the option that had it', (t) => {
  const harness = createHarness(t, {
    catalog: [model('alpha'), model('beta')],
    preferredModel: 'alpha',
  });
  openPicker(harness);
  modelButton(harness.host, 'beta').focus();
  harness.state.status.model = 'beta';
  harness.picker.render();
  const rebuilt = modelButton(harness.host, 'beta');
  assert.ok(rebuilt.querySelector('.composer-model-picker-loaded'), 'rebuild happened');
  assert.equal(harness.document.activeElement, rebuilt);
});
