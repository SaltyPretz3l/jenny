const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScene } = require('../renderer/features/setup-scenes/scene-model-library');

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

function diagnostics() {
  return {
    hardwareProfile: {
      gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 12000 },
      memory: { total_mb: 32000, available_mb: 24000 },
    },
    memory: { totalMb: 32000, availableMb: 24000 },
    modelRecommendations: [
      {
        pullTag: 'catalog:3b', displayName: 'Catalog model', params: '3B',
        recommended: true, fitsInVram: true, vramRequiredMb: 3000,
      },
      {
        pullTag: 'other:1b', displayName: 'Other fit', params: '1B',
        recommended: false, fitsInVram: true, vramRequiredMb: 1000,
      },
      {
        pullTag: 'installed:1b', displayName: 'Installed model', params: '1B',
        recommended: false, fitsInVram: true, vramRequiredMb: 1000,
      },
    ],
  };
}

function click(windowRef, element) {
  element.dispatchEvent(new windowRef.MouseEvent('click', { bubbles: true }));
}

function harness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const { window: windowRef } = dom;
  const root = windowRef.document.getElementById('root');
  const calls = [];
  let progressListener = null;
  const models = {
    async list() {
      calls.push(['list']);
      return { data: [{ id: 'installed:1b', size: 1024, engine_type: 'ollama' }] };
    },
    async listOllamaTags() {
      calls.push(['listOllamaTags']);
      return { data: [] };
    },
    ...(options.models || {}),
  };
  const offline = {
    async getDiagnostics() {
      calls.push(['getDiagnostics']);
      return diagnostics();
    },
    ...(options.offline || {}),
  };
  windowRef.jennyShell = { models, offline };
  const setupService = {
    subscribePullProgress(listener) {
      progressListener = listener;
      calls.push(['subscribePullProgress']);
      return () => calls.push(['unsubscribePullProgress']);
    },
    async startOllamaPull(payload) {
      calls.push(['startOllamaPull', payload]);
      return { requestId: payload.requestId, status: 'running' };
    },
    async cancelOllamaPull(payload) {
      calls.push(['cancelOllamaPull', payload]);
      return { cancelled: true };
    },
    ...(options.setupService || {}),
  };
  const scene = createScene({
    state: options.state || {},
    shellState: options.shellState || { status: {}, offline: {} },
    windowRef,
    setupService,
    persistPreferredModel: options.persistPreferredModel || (async (tag) => {
      calls.push(['persistPreferredModel', tag]);
      return { preferredLocalModel: tag };
    }),
    markStep: options.markStep || (async (name, status) => calls.push(['markStep', name, status])),
    closeModal: options.closeModal || (() => calls.push(['closeModal'])),
    appendClientLog: (...entry) => calls.push(['log', ...entry]),
    showToastMessage: (message) => calls.push(['toast', message]),
  });
  scene.mount(root);
  t.after(() => {
    scene.dispose();
    dom.window.close();
  });
  return {
    scene,
    root,
    windowRef,
    calls,
    progress: () => progressListener,
  };
}

function pullRequest(h) {
  return h.calls.find((entry) => entry[0] === 'startOllamaPull')[1];
}

test('installed cards render first and best-fit badge is fixture-driven', async (t) => {
  const h = harness(t);
  await flush();

  const cards = [...h.root.querySelectorAll('.model-card')];
  assert.deepEqual(cards.map((card) => card.querySelector('.model-card-name').textContent), [
    'Installed model', 'Catalog model', 'Other fit',
  ]);
  assert.match(cards[1].textContent, /Best fit for your GPU/);
  assert.doesNotMatch(cards[2].textContent, /Best fit|Recommended/);
});

test('an installed non-catalog model with a fit estimate renders an estimated fit label', async (t) => {
  const h = harness(t, {
    models: {
      async list() {
        return {
          data: [
            { id: 'installed:1b', size: 1024, engine_type: 'ollama' },
            { id: 'private/estimated:q4', size: 4096, engine_type: 'ollama' },
          ],
        };
      },
    },
    offline: {
      async getDiagnostics() {
        return {
          ...diagnostics(),
          modelFitEstimates: [{
            modelId: 'private/estimated:q4',
            vramRequiredMb: 3000,
            fits: true,
            fitsInVram: true,
          }],
        };
      },
    },
  });
  await flush();

  const cards = [...h.root.querySelectorAll('.model-card')];
  const estimatedCard = cards.find((el) => el.textContent.includes('private/estimated:q4'));
  assert.ok(estimatedCard);
  assert.match(estimatedCard.textContent, /estimated/);
});

test('pull progress patches only the matching request and card', async (t) => {
  const h = harness(t);
  await flush();
  const installedBefore = h.root.querySelector('[data-model-key="installed:1b"]');
  const targetBefore = h.root.querySelector('[data-model-key="catalog:3b"]');

  click(h.windowRef, targetBefore.querySelector('[data-model-card-action="pull"]'));
  const targetRunning = h.root.querySelector('[data-model-key="catalog:3b"]');
  h.progress()({ requestId: 'not-the-request', status: 'running', percent: 88 });
  assert.equal(h.root.querySelector('[data-model-key="catalog:3b"]'), targetRunning);

  h.progress()({ requestId: pullRequest(h).requestId, status: 'running', percent: 42 });
  const targetPatched = h.root.querySelector('[data-model-key="catalog:3b"]');
  assert.notEqual(targetPatched, targetRunning);
  assert.match(targetPatched.textContent, /42%/);
  assert.equal(h.root.querySelector('[data-model-key="installed:1b"]'), installedBefore);
});

test('pull failure shows the real error and never marks the step done', async (t) => {
  const h = harness(t);
  await flush();
  click(h.windowRef, h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="pull"]'));

  h.progress()({
    requestId: pullRequest(h).requestId,
    status: 'failed',
    error: 'no space left on device',
  });
  await flush();

  const card = h.root.querySelector('[data-model-key="catalog:3b"]');
  assert.match(card.textContent, /no space left on device/);
  assert.ok(card.querySelector('[data-model-card-action="pull"]'));
  assert.equal(h.calls.some((entry) => entry[0] === 'markStep'), false);
});

test('cancel failure remains visible and honest', async (t) => {
  const h = harness(t, {
    setupService: {
      async cancelOllamaPull(payload) {
        h.calls.push(['cancelOllamaPull', payload]);
        return { cancelled: false, error: 'process is still running' };
      },
    },
  });
  await flush();
  click(h.windowRef, h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="pull"]'));
  click(h.windowRef, h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="cancel"]'));
  await flush();

  const card = h.root.querySelector('[data-model-key="catalog:3b"]');
  assert.match(card.textContent, /Cancel failed/);
  assert.match(card.textContent, /process is still running/);
  assert.ok(card.querySelector('[data-model-card-action="cancel"]'));
});

test('confirmed cancel returns the card to pullable', async (t) => {
  const h = harness(t);
  await flush();
  click(h.windowRef, h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="pull"]'));
  click(h.windowRef, h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="cancel"]'));
  await flush();

  const card = h.root.querySelector('[data-model-key="catalog:3b"]');
  assert.ok(card.querySelector('[data-model-card-action="pull"]'));
  assert.equal(card.querySelector('[data-model-card-action="cancel"]'), null);
  assert.doesNotMatch(card.textContent, /Cancel failed/);
});

test('double Use persists and marks once, without starting a pull', async (t) => {
  const h = harness(t);
  await flush();
  const use = h.root.querySelector('[data-model-key="installed:1b"] [data-model-card-action="use"]');
  click(h.windowRef, use);
  click(h.windowRef, use);
  await flush();

  assert.equal(h.calls.filter((entry) => entry[0] === 'persistPreferredModel').length, 1);
  assert.deepEqual(h.calls.filter((entry) => entry[0] === 'markStep'), [
    ['markStep', 'localModel', 'done'],
  ]);
  assert.equal(h.calls.some((entry) => entry[0] === 'startOllamaPull'), false);
});

test('Use reports a busy coordinator without disturbing the active pull', async (t) => {
  const h = harness(t);
  await flush();
  click(h.windowRef, h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="pull"]'));
  click(h.windowRef, h.root.querySelector('[data-model-key="installed:1b"] [data-model-card-action="use"]'));

  assert.deepEqual(h.calls.filter((entry) => entry[0] === 'toast'), [
    ['toast', 'Finish or cancel the model operation first.'],
  ]);
  assert.equal(h.calls.filter((entry) => entry[0] === 'startOllamaPull').length, 1);
  assert.equal(h.calls.some((entry) => entry[0] === 'persistPreferredModel'), false);
  assert.ok(h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="cancel"]'));
});

test('Pull reports a busy coordinator without disturbing the active pull', async (t) => {
  const h = harness(t);
  await flush();
  click(h.windowRef, h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="pull"]'));
  click(h.windowRef, h.root.querySelector('[data-model-key="other:1b"] [data-model-card-action="pull"]'));

  assert.deepEqual(h.calls.filter((entry) => entry[0] === 'toast'), [
    ['toast', 'Finish or cancel the model operation first.'],
  ]);
  assert.equal(h.calls.filter((entry) => entry[0] === 'startOllamaPull').length, 1);
  assert.ok(h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="cancel"]'));
  assert.ok(h.root.querySelector('[data-model-key="other:1b"] [data-model-card-action="pull"]'));
});

test('null preferred-model persistence logs WARN and still completes Use', async (t) => {
  const h = harness(t, { persistPreferredModel: async () => null });
  await flush();
  click(h.windowRef, h.root.querySelector('[data-model-key="installed:1b"] [data-model-card-action="use"]'));
  await flush();

  const warning = h.calls.find((entry) => entry[0] === 'log'
    && entry[1] === 'WARN'
    && entry[2] === 'setup.persist_preferred_model_unavailable');
  assert.ok(warning);
  assert.deepEqual(h.calls.filter((entry) => entry[0] === 'markStep'), [
    ['markStep', 'localModel', 'done'],
  ]);
});

test('pull success persists, marks done, and closes', async (t) => {
  const h = harness(t);
  await flush();
  click(h.windowRef, h.root.querySelector('[data-model-key="catalog:3b"] [data-model-card-action="pull"]'));
  h.progress()({ requestId: pullRequest(h).requestId, status: 'completed', percent: 100 });
  await flush();

  assert.deepEqual(h.calls.filter((entry) => entry[0] === 'persistPreferredModel'), [
    ['persistPreferredModel', 'catalog:3b'],
  ]);
  assert.deepEqual(h.calls.filter((entry) => entry[0] === 'markStep'), [
    ['markStep', 'localModel', 'done'],
  ]);
  assert.equal(h.calls.filter((entry) => entry[0] === 'closeModal').length, 1);
});

test('skip marks exactly localModel skipped then closes; Back only closes', async (t) => {
  const skipped = harness(t);
  await flush();
  click(skipped.windowRef, skipped.root.querySelector('[data-step-modal-action="skip"]'));
  await flush();
  assert.deepEqual(skipped.calls.filter((entry) => entry[0] === 'markStep'), [
    ['markStep', 'localModel', 'skipped'],
  ]);
  assert.equal(skipped.calls.filter((entry) => entry[0] === 'closeModal').length, 1);

  const backed = harness(t);
  await flush();
  click(backed.windowRef, backed.root.querySelector('[data-step-modal-action="close"]'));
  assert.equal(backed.calls.some((entry) => entry[0] === 'markStep'), false);
  assert.equal(backed.calls.filter((entry) => entry[0] === 'closeModal').length, 1);
});

test('dispose mid-persist suppresses post-dispose mark and render', async (t) => {
  let resolvePersist;
  const pendingPersist = new Promise((resolve) => { resolvePersist = resolve; });
  const marks = [];
  const h = harness(t, {
    persistPreferredModel: () => pendingPersist,
    markStep: async (...args) => marks.push(args),
  });
  await flush();
  click(h.windowRef, h.root.querySelector('[data-model-key="installed:1b"] [data-model-card-action="use"]'));
  h.scene.dispose();
  const htmlAtDispose = h.root.innerHTML;
  resolvePersist({});
  await flush();

  assert.deepEqual(marks, []);
  assert.equal(h.root.innerHTML, htmlAtDispose);
});

test('diagnostics degradation still renders installed cards', async (t) => {
  const h = harness(t, {
    offline: { async getDiagnostics() { throw new Error('diagnostics offline'); } },
  });
  await flush();

  assert.ok(h.root.querySelector('[data-model-key="installed:1b"]'));
  assert.match(h.root.textContent, /diagnostics offline/);
});
