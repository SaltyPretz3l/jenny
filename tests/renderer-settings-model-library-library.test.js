'use strict';

// new-test-file: the section test file is at its line cap; these cover the Library group (search, chips, sort, keyed rows, preview, Running now).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  flush, state, click, harness, rowKeys,
} = require('./helpers/model-library-section-harness');


test('the library toolbar is one search line with scope chips and a sort; no Recommended chip exists', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  assert.ok(h.card.querySelector('.mlib-searchline [data-model-library-section-input="search"]'));
  assert.equal(h.card.querySelector('[data-model-library-section-input="pull-tag"]'), null, 'the separate pull field is gone');
  assert.equal(h.card.querySelector('[data-model-library-section-action="add-gguf"]'), null, 'Add GGUF file shows only with llama-server on');
  assert.equal(h.card.querySelector('[data-inv-chip="recommended"]'), null);
  assert.equal(h.card.querySelector('[data-inv-chip="installed"]'), null);
  assert.equal(h.card.querySelector('[data-inv-chip="scope-all"] .inv-chip-count').textContent, '2');
  assert.equal(h.card.querySelector('[data-inv-chip="scope-mine"] .inv-chip-count').textContent, '1');
  assert.equal(h.card.querySelector('[data-inv-chip="scope-get"] .inv-chip-count').textContent, '1');
  assert.equal(h.card.querySelector('[data-inv-chip="scope-all"]').getAttribute('aria-pressed'), 'true');
  assert.ok(h.card.querySelector('[data-inv-segmented="modelLibrarySort"]'));
  assert.equal(h.card.querySelector('[data-model-library-section-action="refresh"]').getAttribute('aria-label'), 'Refresh catalog');
  assert.ok(h.card.querySelector('.mrow-cols .inv-tooltip-pin'), 'the VRAM needed caption carries its help');

  const flagged = state();
  flagged.features.featureFlags.llama_server_acceleration = true;
  const withGguf = harness(t, { state: flagged });
  withGguf.controller.bind();
  await flush();
  assert.ok(withGguf.card.querySelector('.mlib-searchline [data-model-library-section-action="add-gguf"]'));
});

test('scope chips and Show more switch the rows; the catalog collapses to one line until asked for', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  assert.deepEqual(rowKeys(h), ['installed:1b']);
  assert.match(h.card.querySelector('.mp-more--inlist').textContent, /1 more models fit this PC/);
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="show-catalog"]'));
  assert.deepEqual(rowKeys(h), ['installed:1b', 'recommended:3b']);
  assert.match(h.card.querySelector('.mrow-sep').textContent, /Not on this PC yet/);
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="hide-catalog"]'));
  assert.deepEqual(rowKeys(h), ['installed:1b']);
  click(h.windowRef, h.card.querySelector('[data-inv-chip="scope-get"]'));
  assert.deepEqual(rowKeys(h), ['recommended:3b']);
  assert.equal(h.card.querySelector('[data-inv-chip="scope-get"]').getAttribute('aria-pressed'), 'true');
  click(h.windowRef, h.card.querySelector('[data-inv-chip="scope-mine"]'));
  assert.deepEqual(rowKeys(h), ['installed:1b']);
  assert.equal(h.card.querySelector('.mp-more--inlist'), null);
});

test('typing in the search field filters in place, keeps the input node focused with its caret, and the Pull row is the one primary button', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  assert.equal(h.card.querySelectorAll('.btn--primary').length, 0, 'no primary button at rest');

  const input = h.card.querySelector('[data-model-library-section-input="search"]');
  input.focus();
  input.value = 'recomm';
  input.setSelectionRange(2, 4, 'forward');
  input.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));

  assert.equal(h.card.querySelector('[data-model-library-section-input="search"]'), input, 'the same input node');
  assert.equal(h.document.activeElement, input);
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 4);
  assert.deepEqual(rowKeys(h), ['recommended:3b']);
  assert.equal(h.card.querySelector('[data-inv-chip="scope-mine"] .inv-chip-count').textContent, '0', 'counts follow the query');

  input.value = 'qwen3:8b';
  input.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));
  assert.equal(h.card.querySelectorAll('.btn--primary').length, 1);
  assert.ok(h.card.querySelector('.mrow--pull [data-model-library-section-action="pull-tag"].btn--primary'));
  assert.equal(h.card.querySelector('.mrow-list').firstElementChild.classList.contains('mrow--pull'), true);

  input.value = 'zzz';
  input.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));
  assert.match(h.card.querySelector('.mp-empty').textContent, /Nothing matches “zzz”/);
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="clear-search"]'));
  assert.equal(input.value, '');
  assert.deepEqual(rowKeys(h), ['installed:1b']);
});

test('the Pull row pulls the trimmed query on click and on Enter', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  const input = h.card.querySelector('[data-model-library-section-input="search"]');
  input.value = '  ghost:7b ';
  input.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="pull-tag"]'));
  assert.equal(h.calls.filter((entry) => entry[0] === 'startOllamaPull').length, 1);
  assert.equal(h.calls.find((entry) => entry[0] === 'startOllamaPull')[1].model, 'ghost:7b');

  input.value = 'hf.co/a/b:Q4';
  input.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));
  input.dispatchEvent(new h.windowRef.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(h.calls.filter((entry) => entry[0] === 'startOllamaPull').length, 2);
  input.value = 'plain';
  input.dispatchEvent(new h.windowRef.Event('input', { bubbles: true }));
  input.dispatchEvent(new h.windowRef.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(h.calls.filter((entry) => entry[0] === 'startOllamaPull').length, 2, 'Enter on a non-tag query pulls nothing');
});

test('Add GGUF file opens the llama-server drawer from the button', async (t) => {
  const flagged = state();
  flagged.features.featureFlags.llama_server_acceleration = true;
  const opened = [];
  const previous = globalThis.modelLibraryServices;
  globalThis.modelLibraryServices = { shared: () => ({ register() {}, unregister() {}, refresh() {}, has: (id) => id === 'llama-server', open: (id, anchor) => opened.push([id, anchor.getAttribute('data-model-library-section-action')]) }) };
  t.after(() => { globalThis.modelLibraryServices = previous; });
  const h = harness(t, { state: flagged });
  h.controller.bind();
  await flush();
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="add-gguf"]'));
  assert.deepEqual(opened, [['llama-server', 'add-gguf']]);
});

test('sort Size reorders the rows by VRAM needed', async (t) => {
  const h = harness(t, {
    models: { async list() { return { data: [{ id: 'installed:1b', size: 1024, engine_type: 'ollama' }, { id: 'aaa:7b', size: 4096, engine_type: 'ollama' }] }; } },
  });
  h.controller.bind();
  await flush();
  assert.deepEqual(rowKeys(h), ['aaa:7b', 'installed:1b'], 'name order by default');
  const size = h.card.querySelector('[data-inv-segmented="modelLibrarySort"] [data-value="size"]');
  click(h.windowRef, size);
  assert.deepEqual(rowKeys(h), ['installed:1b', 'aaa:7b'], 'a known VRAM need sorts before an unknown one');
});

test('a refresh with unchanged data keeps every row node', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="show-catalog"]'));
  const before = [...h.card.querySelectorAll('.mrow-list > *')];
  assert.equal(before.length, 3);
  await h.controller.refresh({ force: true });
  const after = [...h.card.querySelectorAll('.mrow-list > *')];
  assert.equal(after.length, before.length);
  after.forEach((node, index) => assert.equal(node, before[index], `list child ${index} kept`));
});

test('a pull-progress tick repaints only its row and two ticks in one frame paint once', async (t) => {
  const h = harness(t);
  const frames = [];
  h.windowRef.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  h.windowRef.cancelAnimationFrame = () => {};
  h.controller.bind();
  await flush();
  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="show-catalog"]'));
  const sibling = h.card.querySelector('[data-model-key="installed:1b"]');
  click(h.windowRef, h.card.querySelector('[data-model-key="recommended:3b"] [data-model-card-action="pull"]'));
  const startCall = h.calls.find((entry) => entry[0] === 'startOllamaPull');
  const send = (percent) => h.progressListener()({ requestId: startCall[1].requestId, status: 'pulling', percent });

  send(10);
  frames.shift()();
  const pulling = h.card.querySelector('[data-model-key="recommended:3b"]');
  send(20);
  send(30);
  assert.equal(frames.length, 1, 'two ticks ask for one frame');
  assert.equal(h.card.querySelector('[data-model-key="recommended:3b"]'), pulling, 'nothing painted before the frame');
  frames.shift()();
  const painted = h.card.querySelector('[data-model-key="recommended:3b"]');
  assert.notEqual(painted, pulling, 'the pulling row repainted');
  assert.match(painted.querySelector('.model-card-pull-state').textContent, /30%/);
  assert.equal(h.card.querySelector('[data-model-key="installed:1b"]'), sibling, 'the other row kept its node');
  assert.equal(frames.length, 0);
});

test('a pull terminal status paints immediately, not on the next frame', async (t) => {
  const h = harness(t);
  const frames = [];
  h.windowRef.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  h.controller.bind();
  await flush();
  click(h.windowRef, h.card.querySelector('[data-inv-chip="scope-get"]'));
  click(h.windowRef, h.card.querySelector('[data-model-key="recommended:3b"] [data-model-card-action="pull"]'));
  assert.ok(h.card.querySelector('[data-model-key="recommended:3b"] [data-model-card-action="cancel"]'), 'the start transition paints at once');
  const startCall = h.calls.find((entry) => entry[0] === 'startOllamaPull');
  h.progressListener()({ requestId: startCall[1].requestId, status: 'failed', error: 'no space' });
  assert.match(h.card.querySelector('.model-library-section-status').textContent, /no space/);
  assert.equal(h.card.querySelector('[data-model-key="recommended:3b"] [data-model-card-action="cancel"]'), null);
  assert.equal(frames.length, 0);
});

test('hovering or focusing a row announces its VRAM need for Running now; leaving clears it', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();
  const seen = [];
  h.card.addEventListener('jenny:model-library-preview', (event) => seen.push(event.detail));
  const row = h.card.querySelector('[data-model-key="installed:1b"]');
  const hover = (type, target, related) => target.dispatchEvent(new h.windowRef.MouseEvent(type, { bubbles: true, relatedTarget: related || null }));

  hover('pointerover', row.querySelector('.mrow-name'));
  hover('pointerover', row.querySelector('.mrow-meta'));
  assert.equal(seen.length, 1, 'only a changed key dispatches');
  assert.equal(seen[0].key, 'installed:1b');
  assert.equal(seen[0].displayName, 'Installed model');
  assert.equal(seen[0].vramRequiredMb, 1000);
  assert.equal(typeof seen[0].fitSource, 'string');
  hover('pointerout', row, h.document.body);
  assert.equal(seen.length, 2);
  assert.equal(seen[1], null);

  row.querySelector('[data-model-card-action="tune"]').dispatchEvent(new h.windowRef.FocusEvent('focusin', { bubbles: true }));
  assert.equal(seen.length, 3);
  assert.equal(seen[2].key, 'installed:1b');
  row.querySelector('[data-model-card-action="tune"]').dispatchEvent(new h.windowRef.FocusEvent('focusout', { bubbles: true, relatedTarget: h.document.body }));
  assert.equal(seen.length, 4);
  assert.equal(seen[3], null);
});

test('Running now shows the loaded model and a hovered Library row draws its ghost on the bar', async (t) => {
  const activeState = state();
  activeState.status.model = 'installed:1b';
  const h = harness(t, { state: activeState });
  h.controller.bind();
  await flush();
  const running = h.document.getElementById('modelRunningHost');
  assert.equal(running.querySelector('.mm-name').textContent, 'Installed model');
  assert.ok(running.querySelector('[data-model-card-action="tune"]'));
  assert.equal(running.querySelector('.mm-ghost'), null);

  click(h.windowRef, h.card.querySelector('[data-model-library-section-action="show-catalog"]'));
  const row = h.card.querySelector('[data-model-key="recommended:3b"]');
  row.dispatchEvent(new h.windowRef.MouseEvent('pointerover', { bubbles: true }));
  assert.ok(running.querySelector('.mm-ghost'), 'hovering a row previews its need');
  assert.match(running.querySelector('.mm-preview').textContent, /^Recommended model would use/);
  row.dispatchEvent(new h.windowRef.MouseEvent('pointerout', { bubbles: true, relatedTarget: h.document.body }));
  assert.equal(running.querySelector('.mm-ghost'), null);
});
