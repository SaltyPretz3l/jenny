'use strict';

// The running image's live progress: ephemeral DOM patches of the pending figure.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const figure = require('../renderer/inventory/artifact-figure');
const { createImageRenderProgress } = require('../renderer/chat/renderer-stream-image-render-progress');

const PREVIEW_A = 'data:image/png;base64,QUFB';
const PREVIEW_B = 'data:image/png;base64,QkJC';

function pendingMarkup(callId) {
  return figure.renderPendingFigure({ callId, width: 1664, height: 928, title: 'Lighthouse', prompt: 'A lighthouse at dusk',
    labels: { phase: 'Starting…', stop: 'Stop' } });
}

function makeTimeline(callId = 'call-1') {
  const dom = new JSDOM(`<div id="chatTimeline"><div class="chat-row">${pendingMarkup(callId)}</div></div>`);
  const timeline = dom.window.document.getElementById('chatTimeline');
  return { dom, timeline, pending: () => timeline.querySelector('[data-inv-image-render]') };
}

function progress(phase, extra = {}) {
  return { sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1', phase, ...extra };
}

const read = (pending) => ({
  phase: pending.querySelector('.inv-artifact-figure-phase').textContent,
  step: pending.querySelector('.inv-artifact-figure-step').textContent,
  progress: pending.style.getPropertyValue('--inv-render-progress'),
  preview: pending.querySelector('.inv-artifact-figure-preview').getAttribute('src'),
  hasPreview: pending.hasAttribute('data-inv-render-preview'),
});

test('each phase repaints the pending figure: words, step, progress and the newest preview', () => {
  const { timeline, pending } = makeTimeline();
  const render = createImageRenderProgress({ getChatTimeline: () => timeline });

  assert.equal(render.apply(progress('gpu')), true);
  assert.deepEqual(read(pending()), { phase: 'Freeing the GPU', step: '', progress: '0', preview: null, hasPreview: false });
  render.apply(progress('load'));
  assert.equal(read(pending()).phase, 'Loading the image model');

  render.apply(progress('sample', { step: 4, steps: 20, preview: PREVIEW_A }));
  assert.deepEqual(read(pending()), { phase: 'Drawing', step: ' · 4 of 20', progress: '0.2', preview: PREVIEW_A, hasPreview: true });
  // A step without a new frame keeps the last frame.
  render.apply(progress('sample', { step: 6, steps: 20 }));
  assert.deepEqual(read(pending()), { phase: 'Drawing', step: ' · 6 of 20', progress: '0.3', preview: PREVIEW_A, hasPreview: true });
  render.apply(progress('sample', { step: 8, steps: 20, preview: PREVIEW_B }));
  assert.equal(read(pending()).preview, PREVIEW_B);

  render.apply(progress('decode'));
  assert.deepEqual(read(pending()), { phase: 'Finishing', step: '', progress: '1', preview: PREVIEW_B, hasPreview: true });
});

test('only the live phase words are announced; the step count is not', () => {
  const { pending } = makeTimeline();
  assert.equal(pending().querySelector('.inv-artifact-figure-phase').getAttribute('role'), 'status');
  assert.equal(pending().querySelector('.inv-artifact-figure-step').getAttribute('aria-hidden'), 'true');
});

test('progress that lands before the row renders, or a re-render that replaces the figure, is painted by the observer', async () => {
  const dom = new JSDOM('<div id="chatTimeline"></div>');
  const timeline = dom.window.document.getElementById('chatTimeline');
  const render = createImageRenderProgress({ getChatTimeline: () => timeline });
  render.apply(progress('sample', { step: 10, steps: 20, preview: PREVIEW_A }));

  timeline.innerHTML = pendingMarkup('call-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(read(timeline.querySelector('[data-inv-image-render]')),
    { phase: 'Drawing', step: ' · 10 of 20', progress: '0.5', preview: PREVIEW_A, hasPreview: true });

  timeline.innerHTML = pendingMarkup('call-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(read(timeline.querySelector('[data-inv-image-render]')).step, ' · 10 of 20');
});

test('a newer stream of the same session drops the older render of a reused call id', async () => {
  const { timeline, pending } = makeTimeline();
  const render = createImageRenderProgress({ getChatTimeline: () => timeline });
  render.apply(progress('sample', { step: 18, steps: 20, preview: PREVIEW_A }));
  render.apply(progress('load', { streamId: 'stream-2' }));
  assert.equal(read(pending()).phase, 'Loading the image model');
  // Once the newer stream settles, nothing of the older render is left to repaint a fresh figure.
  render.settleStream('stream-2');
  timeline.innerHTML = pendingMarkup('call-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(read(pending()).phase, 'Starting…');
});

test('settled calls and streams are forgotten; bad payloads and other calls are ignored', async () => {
  const { timeline, pending } = makeTimeline();
  const render = createImageRenderProgress({ getChatTimeline: () => timeline });
  assert.equal(render.apply(progress('explode')), false);
  assert.equal(render.apply({ phase: 'load' }), false);
  render.apply({ ...progress('load'), callId: 'other-call' });
  assert.equal(read(pending()).phase, 'Starting…');
  // A non-PNG preview is never set as an image source.
  render.apply(progress('sample', { step: 1, steps: 2, preview: 'javascript:alert(1)' }));
  assert.equal(read(pending()).preview, null);

  render.settle({ callId: 'call-1', streamId: 'stream-1' });
  timeline.innerHTML = pendingMarkup('call-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(read(pending()).phase, 'Starting…');

  render.apply(progress('load'));
  render.settleStream('stream-1');
  timeline.innerHTML = pendingMarkup('call-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(read(pending()).phase, 'Starting…');

  render.dispose();
  assert.equal(render.apply(progress('load')), false);
});
