// new-test-file: Running now (buildRunningNow and its preview controller) is a new surface; the section test file is far past the 600-line cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const renderModule = require('../renderer/shell/model-library/model-library-section-render');

const { buildRunningNow, createRunningNow } = renderModule;

const GPU = { detected: true, name: 'RTX 5090', vramMb: 32563, budgetMb: 30000, ramAvailableMb: 9011, type: 'cuda' };

function activeCard(overrides = {}) {
  return {
    key: 'qwen:27b', tag: 'qwen:27b', displayName: 'Qwen 27B NVFP4', installed: true, active: true,
    selectedEngine: 'llama-server', engineType: 'openai-compatible', contextLength: 131072,
    mtp: { enabled: true }, servingPort: 8033, vramRequiredMb: 22630, fitSource: 'observed',
    ...overrides,
  };
}

function build(input = {}) {
  const html = buildRunningNow({
    merged: { cards: [activeCard()], hardware: GPU },
    activation: { status: 'idle', key: '', message: '' },
    activeModelId: 'qwen:27b',
    preferredModel: '',
    hardwarePending: false,
    preview: null,
    ...input,
  });
  return JSDOM.fragment(html);
}

const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();
const widthOf = (node) => parseFloat(node.style.width);

test('a loaded model shows its name, meta, Unload and Tune, and a measured bar with ticks', () => {
  const frag = build();
  const root = frag.querySelector('.mm');
  assert.ok(root);
  assert.ok(!root.classList.contains('mm--loading') && !root.classList.contains('mm--idle'));
  assert.equal(text(frag.querySelector('.mm-name')), 'Qwen 27B NVFP4');
  assert.equal(frag.querySelector('.mm-name').getAttribute('title'), 'qwen:27b');
  assert.equal(text(frag.querySelector('.mm-meta')), 'llama-server · 128K context · MTP · port 8033');
  const unload = frag.querySelector('.mm-actions [data-model-card-action="unload"]');
  const tune = frag.querySelector('.mm-actions [data-model-card-action="tune"]');
  assert.equal(unload.getAttribute('data-model-tag'), 'qwen:27b');
  assert.equal(tune.getAttribute('data-model-tag'), 'qwen:27b');
  assert.equal(unload.disabled, false);
  assert.ok(Math.abs(widthOf(frag.querySelector('.mm-fill')) - 69.5) < 0.1);
  assert.deepEqual([...frag.querySelectorAll('.mm-tick')].map((tick) => text(tick)), ['8', '16', '24']);
  assert.equal(frag.querySelector('.mm-bar').getAttribute('role'), 'img');
  assert.equal(frag.querySelector('.mm-bar').getAttribute('aria-label'), 'GPU memory: 22.1 GB in use of 31.8 GB');
  assert.equal(text(frag.querySelector('.mm-legend > span:first-child')), '22.1 GB in use · measured');
  assert.equal(frag.querySelector('.mm-legend > span:first-child b').textContent, '22.1 GB');
  assert.equal(text(frag.querySelector('.mm-free')), '9.7 GB free');
  assert.equal(text(frag.querySelector('.mm-gpu')), 'RTX 5090 · 31.8 GB VRAM · 8.8 GB RAM available');
});

test('an estimated need says so, an Ollama model has no port, and ticks stay inside a small card', () => {
  const frag = build({
    merged: {
      cards: [activeCard({ selectedEngine: 'ollama', engineType: 'ollama', mtp: {}, fitSource: 'estimated', vramRequiredMb: 6144 })],
      hardware: { ...GPU, vramMb: 12288 },
    },
  });
  assert.equal(text(frag.querySelector('.mm-meta')), 'Ollama · 128K context');
  assert.equal(text(frag.querySelector('.mm-legend > span:first-child')), '6 GB in use · estimated');
  assert.deepEqual([...frag.querySelectorAll('.mm-tick')].map((tick) => text(tick)), ['8']);
  assert.equal(widthOf(frag.querySelector('.mm-fill')), 50);
});

test('model names are escaped', () => {
  const frag = build({ merged: { cards: [activeCard({ displayName: '<img src=x onerror=1>' })], hardware: GPU } });
  assert.equal(frag.querySelector('img'), null);
  assert.equal(text(frag.querySelector('.mm-name')), '<img src=x onerror=1>');
});

test('Unload and Tune lock while a runtime action runs, and Tune is local-only', () => {
  const frag = build({ activation: { status: 'running', key: 'qwen:27b', message: '' } });
  assert.ok(!frag.querySelector('.mm').classList.contains('mm--loading'), 'unloading the active model is not a load');
  assert.equal(frag.querySelector('[data-model-card-action="unload"]').disabled, true);
  const hosted = build({
    merged: { cards: [activeCard({ selectedEngine: '', engineType: 'OpenRouter', servingPort: 0, mtp: {} })], hardware: GPU },
  });
  assert.equal(hosted.querySelector('[data-model-card-action="tune"]'), null);
  assert.ok(hosted.querySelector('[data-model-card-action="unload"]'));
  assert.equal(text(hosted.querySelector('.mm-meta')), "OpenRouter · runs on the provider's servers");
  assert.equal(hosted.querySelector('.mm-bar'), null, 'a hosted model has no GPU bar');
});

test('loading shows the starting engine with no buttons and no Cancel', () => {
  const loading = activeCard({ key: 'big:70b', tag: 'big:70b', displayName: 'Big 70B', active: false, selectedEngine: 'ninfer', vramRequiredMb: 16384 });
  const frag = build({
    merged: { cards: [loading], hardware: GPU },
    activation: { status: 'running', key: 'big:70b', message: '' },
    activeModelId: '',
  });
  assert.ok(frag.querySelector('.mm').classList.contains('mm--loading'));
  assert.equal(text(frag.querySelector('.mm-name')), 'Big 70B');
  assert.equal(text(frag.querySelector('.mm-meta')), 'Starting on NInfer…');
  assert.equal(frag.querySelector('.mm-actions button'), null);
  assert.ok(!/cancel/i.test(text(frag.querySelector('.mm'))));
  assert.ok(Math.abs(widthOf(frag.querySelector('.mm-fill')) - 50.3) < 0.1);
  assert.equal(text(frag.querySelector('.mm-legend > span:first-child')), 'Reserving about 16 GB');
  assert.equal(text(frag.querySelector('.mm-free')), '15.8 GB will stay free');
});

test('idle says nothing is loaded, hints the preferred model, and leaves the whole bar free', () => {
  const idle = { merged: { cards: [], hardware: GPU }, activeModelId: '' };
  const frag = build({ ...idle, preferredModel: 'qwen3.8-27b-nvfp4' });
  assert.ok(frag.querySelector('.mm').classList.contains('mm--idle'));
  assert.equal(text(frag.querySelector('.mm-name--idle')), 'Nothing loaded');
  assert.equal(text(frag.querySelector('.mm-meta')), 'Pick a model below, or Jenny loads qwen3.8-27b-nvfp4 with your next message.');
  assert.equal(frag.querySelector('.mm-actions button'), null);
  assert.equal(widthOf(frag.querySelector('.mm-fill')), 0);
  assert.equal(text(frag.querySelector('.mm-free')), '31.8 GB free');
  assert.equal(text(build(idle).querySelector('.mm-meta')), 'Pick a model below.');
});

test('a known model id without a card still shows the name and offers Unload', () => {
  const frag = build({ merged: { cards: [], hardware: GPU }, activeModelId: 'mystery:7b' });
  assert.equal(text(frag.querySelector('.mm-name')), 'mystery:7b');
  assert.equal(frag.querySelector('[data-model-card-action="unload"]').getAttribute('data-model-tag'), 'mystery:7b');
  assert.equal(frag.querySelector('[data-model-card-action="tune"]'), null);
  assert.equal(frag.querySelector('.mm-bar'), null, 'no card, no numbers to draw');
  assert.equal(frag.querySelector('.mm-free'), null);
  assert.ok(text(frag.querySelector('.mm-gpu')).startsWith('RTX 5090'));
});

test('a preview draws a ghost and rewrites the legend; over capacity it says so; null restores it', () => {
  const fits = build({ preview: { key: 'a', vramRequiredMb: 8192, fitSource: 'estimated', displayName: 'Small model' } });
  const ghost = fits.querySelector('.mm-ghost');
  assert.ok(Math.abs(widthOf(ghost) - 25.2) < 0.1);
  assert.ok(!ghost.classList.contains('mm-ghost--over'));
  assert.equal(text(fits.querySelector('.mm-preview')), 'Small model would use about 8 GB · 23.8 GB left free');
  assert.equal(fits.querySelector('.mm-preview b').textContent, 'Small model');

  const measured = build({ preview: { key: 'a', vramRequiredMb: 8192, fitSource: 'observed', displayName: 'Small model' } });
  assert.equal(text(measured.querySelector('.mm-preview')), 'Small model would use 8 GB · 23.8 GB left free');

  const over = build({ preview: { key: 'b', vramRequiredMb: 40960, fitSource: 'estimated', displayName: 'Huge' } });
  assert.ok(over.querySelector('.mm-ghost').classList.contains('mm-ghost--over'));
  assert.equal(widthOf(over.querySelector('.mm-ghost')), 100);
  assert.equal(text(over.querySelector('.mm-preview')), 'Huge would use about 40 GB · 8.2 GB more than this card has');

  const long = build({ preview: { key: 'c', vramRequiredMb: 1024, fitSource: 'estimated', displayName: 'x'.repeat(50) } });
  assert.equal(long.querySelector('.mm-preview b').textContent, `${'x'.repeat(33)}…`);

  const cleared = build({ preview: null });
  assert.equal(cleared.querySelector('.mm-ghost'), null);
  assert.equal(cleared.querySelector('.mm-preview'), null);
  assert.equal(text(cleared.querySelector('.mm-legend > span:first-child')), '22.1 GB in use · measured');
});

test('no ghost while loading', () => {
  const frag = build({
    merged: { cards: [activeCard({ active: false })], hardware: GPU },
    activation: { status: 'running', key: 'qwen:27b', message: '' },
    activeModelId: '',
    preview: { key: 'a', vramRequiredMb: 8192, fitSource: 'estimated', displayName: 'Small model' },
  });
  assert.equal(frag.querySelector('.mm-ghost'), null);
  assert.equal(frag.querySelector('.mm-preview'), null);
});

test('undetected or pending hardware hides the bar and says why', () => {
  const none = build({ merged: { cards: [activeCard()], hardware: { detected: false } } });
  assert.equal(none.querySelector('.mm-bar'), null);
  assert.equal(none.querySelector('.mm-ghost'), null);
  assert.equal(text(none.querySelector('.mm-gpu')), 'Hardware not detected');
  assert.ok(none.querySelector('[data-model-card-action="unload"]'));
  const pending = build({ merged: { cards: [activeCard()], hardware: { detected: false } }, hardwarePending: true });
  assert.equal(text(pending.querySelector('.mm-gpu')), 'Checking hardware…');
  const noVram = build({ merged: { cards: [activeCard()], hardware: { detected: true, type: 'cpu', vramMb: 0 } } });
  assert.equal(noVram.querySelector('.mm-bar'), null);
});

test('the controller repaints only when the markup changed, follows preview events, and stops on dispose', () => {
  const dom = new JSDOM('<section id="card"><div id="host"></div></section>');
  const { document, CustomEvent } = dom.window;
  const host = document.getElementById('host');
  const card = document.getElementById('card');
  let cards = [activeCard()];
  const controller = createRunningNow({
    documentRef: document,
    host: () => host,
    card: () => card,
    isDisposed: () => false,
    getMerged: () => ({ cards, hardware: GPU }),
    hardwarePending: () => false,
    activationState: () => ({ status: 'idle', key: '', message: '' }),
    activeModel: () => 'qwen:27b',
    preferredModel: () => '',
  });
  controller.render();
  const root = host.firstElementChild;
  assert.equal(text(root.querySelector('.mm-name')), 'Qwen 27B NVFP4');
  controller.render();
  assert.equal(host.firstElementChild, root, 'unchanged markup keeps the node');

  controller.bind();
  controller.bind();
  const preview = (detail) => card.dispatchEvent(new CustomEvent('jenny:model-library-preview', { bubbles: true, detail }));
  preview({ key: 'a', vramRequiredMb: 8192, fitSource: 'estimated', displayName: 'Small model' });
  assert.ok(host.querySelector('.mm-ghost'));
  assert.match(text(host.querySelector('.mm-preview')), /^Small model would use about 8 GB/);
  preview(null);
  assert.equal(host.querySelector('.mm-ghost'), null);

  cards = [];
  controller.render();
  assert.ok(host.querySelector('.mm--idle') === null, 'the status model id keeps it out of idle');

  controller.dispose();
  preview({ key: 'a', vramRequiredMb: 8192, fitSource: 'estimated', displayName: 'Small model' });
  assert.equal(host.querySelector('.mm-ghost'), null, 'a disposed controller ignores the event');
});

test('a missing host is not an error', () => {
  const dom = new JSDOM('<section id="card"></section>');
  const controller = createRunningNow({
    documentRef: dom.window.document, host: () => null, card: () => dom.window.document.getElementById('card'),
    isDisposed: () => false, getMerged: () => ({ cards: [], hardware: GPU }), hardwarePending: () => false,
    activationState: () => ({ status: 'idle', key: '', message: '' }), activeModel: () => '', preferredModel: () => '',
  });
  controller.render();
  controller.bind();
  controller.dispose();
});

test('a repaint keeps keyboard focus on the Running now button that had it', () => {
  const dom = new JSDOM('<section id="card"><div id="host"></div></section>');
  const { document, CustomEvent } = dom.window;
  const host = document.getElementById('host');
  const card = document.getElementById('card');
  const controller = createRunningNow({
    documentRef: document, host: () => host, card: () => card, isDisposed: () => false,
    getMerged: () => ({ cards: [activeCard()], hardware: GPU }), hardwarePending: () => false,
    activationState: () => ({ status: 'idle', key: '', message: '' }), activeModel: () => 'qwen:27b', preferredModel: () => '',
  });
  controller.render();
  controller.bind();
  host.querySelector('[data-model-card-action="tune"]').focus();
  card.dispatchEvent(new CustomEvent('jenny:model-library-preview', { bubbles: true, detail: { key: 'a', vramRequiredMb: 4096, fitSource: 'estimated', displayName: 'Small' } }));
  assert.ok(host.querySelector('.mm-ghost'), 'the preview repainted the group');
  assert.equal(document.activeElement, host.querySelector('[data-model-card-action="tune"]'));
});

test('a preview patches the bar and legend in place: buttons and the fill keep their nodes', () => {
  const dom = new JSDOM('<section id="card"><div id="host"></div></section>');
  const { document, CustomEvent } = dom.window;
  const host = document.getElementById('host');
  const card = document.getElementById('card');
  const controller = createRunningNow({
    documentRef: document, host: () => host, card: () => card, isDisposed: () => false,
    getMerged: () => ({ cards: [activeCard()], hardware: GPU }), hardwarePending: () => false,
    activationState: () => ({ status: 'idle', key: '', message: '' }), activeModel: () => 'qwen:27b', preferredModel: () => '',
  });
  controller.render();
  controller.bind();
  const unload = host.querySelector('[data-model-card-action="unload"]');
  const fill = host.querySelector('.mm-fill');
  const preview = (detail) => card.dispatchEvent(new CustomEvent('jenny:model-library-preview', { bubbles: true, detail }));
  preview({ key: 'a', vramRequiredMb: 4096, fitSource: 'estimated', displayName: 'Small' });
  const ghost = host.querySelector('.mm-ghost');
  assert.ok(ghost);
  preview({ key: 'b', vramRequiredMb: 40000, fitSource: 'estimated', displayName: 'Huge' });
  assert.equal(host.querySelector('.mm-ghost'), ghost, 'the ghost node is reused, so its width transition plays');
  assert.ok(ghost.classList.contains('mm-ghost--over'));
  assert.match(text(host.querySelector('.mm-preview')), /^Huge would use about/);
  preview(null);
  assert.equal(host.querySelector('.mm-ghost'), null);
  assert.equal(host.querySelector('[data-model-card-action="unload"]'), unload);
  assert.equal(host.querySelector('.mm-fill'), fill);
});
