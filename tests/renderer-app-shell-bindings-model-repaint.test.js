'use strict';
// renderer-app-shell-bindings.js onModelStateChanged: a running pull's byte
// ticks (4 Hz for the whole download) repaint the shell at most once a second;
// a pull transition (start, cancel, done, error) repaints at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

test('pull progress ticks repaint at most once a second; the trailing paint lands; cancel repaints at once', async (t) => {
  const starts = [];
  const app = await loadRendererApp({ shell: { models: {
    async list() { return { available: true, data: [] }; },
  } } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  let progress;
  shell.setup = { ...shell.setup,
    onModelPullProgress(listener) { progress = listener; return () => { progress = null; }; },
    async startOllamaPull(payload) { starts.push(payload); return { status: 'running' }; },
    async cancelOllamaPull() { return { cancelled: true }; },
  };
  window.__rendererState.modelRecommendation = { tag: 'fit:3b', downloadSizeMb: 2000 };
  window.dispatchEvent(new window.CustomEvent('jenny:model-state-changed'));
  await waitForUi(window);
  doc.querySelector('[data-hero-action="download"]').click();
  await waitForUi(window);
  const subtitle = () => doc.getElementById('heroSubtitle').textContent;
  const tick = (kb) => progress({ requestId: starts[0].requestId, percent: kb * 10, bytes: kb * 1024, totalBytes: 10240 });

  let renders = 0;
  window.addEventListener('composer-state-rendered', () => { renders += 1; });
  tick(1);
  await waitForUi(window);
  assert.match(subtitle(), /1 KB of 10 KB/, 'the first tick paints at once');
  assert.equal(renders, 1);
  for (let kb = 2; kb <= 6; kb += 1) {
    tick(kb);
    await waitForUi(window, 30);
  }
  assert.equal(renders, 1, 'ticks inside the window are held');
  assert.equal(Object.values(window.__rendererState.modelPulls)[0].completedBytes, 6 * 1024, 'state still takes every tick');
  await waitForUiState(window, () => /6 KB of 10 KB/.test(subtitle()), { timeoutMs: 1500, message: 'the held ticks end in one trailing paint' });
  assert.equal(renders, 2);

  doc.querySelector('[data-hero-action="cancel-download"]').click();
  await waitForUi(window);
  assert.equal(doc.getElementById('heroTitle').textContent, 'Pick a model to start', 'a transition repaints at once');
});
