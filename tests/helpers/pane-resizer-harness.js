'use strict';

/* Test harness for renderer/chat/renderer-chat-pane-resizer.js: a minimal jsdom
 * fragment (#chatView > #chatPane0, #chatPaneResizer, a second pane), a fake
 * requestAnimationFrame that only runs when the test says so, and a fake pane
 * model that clamps exactly as normalizePaneLayout does. Shared by
 * renderer-pane-resizer.test.js (the divider contract) and
 * renderer-pane-resizer-floor.test.js (the pixel floor). */

const { JSDOM } = require('jsdom');

const { createChatPaneResizer } = require('../../renderer/chat/renderer-chat-pane-resizer');
const paneModel = require('../../renderer/shell/renderer-pane-model');

const FRAGMENT = [
  '<!doctype html><html><body>',
  '<div class="chat-view" id="chatView">',
  '<div class="chat-pane" id="chatPane0" data-pane-id="0"></div>',
  '<div class="chat-pane-resizer artifact-review-resizer" id="chatPaneResizer" role="separator"',
  ' aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="50" tabindex="-1"></div>',
  '<div class="chat-pane" data-pane-id="1"></div>',
  '</div>',
  '</body></html>',
].join('');

function roundTo4(value) {
  return Math.round(value * 10000) / 10000;
}

function createHarness(t, options = {}) {
  const dom = new JSDOM(FRAGMENT);
  const { window } = dom;
  const { document } = window;
  const chatViewEl = document.getElementById('chatView');
  const resizerEl = document.getElementById('chatPaneResizer');

  const record = {
    rectReads: 0,
    setSplitRatio: [],
    persisted: [],
    setProperty: [],
    captured: [],
    released: [],
    scheduled: 0,
    cancelled: [],
  };

  const width = Object.prototype.hasOwnProperty.call(options, 'width') ? options.width : 1000;
  chatViewEl.getBoundingClientRect = () => {
    record.rectReads += 1;
    return { left: 0, top: 0, right: width, bottom: 600, width, height: 600, x: 0, y: 0 };
  };

  const nativeSetProperty = chatViewEl.style.setProperty.bind(chatViewEl.style);
  chatViewEl.style.setProperty = (name, value, priority) => {
    record.setProperty.push([name, value]);
    return nativeSetProperty(name, value, priority);
  };

  // jsdom has no pointer capture: stub both and record the calls.
  resizerEl.setPointerCapture = (pointerId) => { record.captured.push(pointerId); };
  resizerEl.releasePointerCapture = (pointerId) => { record.released.push(pointerId); };

  const frames = new Map();
  let nextFrameId = 1;
  function requestAnimationFrame(callback) {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    record.scheduled += 1;
    return id;
  }
  function cancelAnimationFrame(id) {
    record.cancelled.push(id);
    frames.delete(id);
  }
  function runFrames() {
    const pending = Array.from(frames.entries());
    frames.clear();
    for (const [, callback] of pending) callback(16);
    return pending.length;
  }

  // The fake model clamps exactly as normalizePaneLayout does, so the module
  // can be shown to render the KEPT value rather than its own number.
  const model = { ratio: typeof options.startRatio === 'number' ? options.startRatio : 0.5 };
  let rtl = Boolean(options.rtl);

  const resizer = createChatPaneResizer({
    resizerEl,
    chatViewEl,
    getSplitRatio: () => model.ratio,
    setSplitRatio(ratio) {
      record.setSplitRatio.push(ratio);
      model.ratio = paneModel.normalizePaneLayout({ panes: [{}], splitRatio: ratio }).splitRatio;
      return model.ratio;
    },
    onPersist(ratio) { record.persisted.push(ratio); },
    requestAnimationFrame,
    cancelAnimationFrame,
    isRtl: () => rtl,
    // The model-contract tests below run without the pixel floor; the floor
    // tests pass their own minPaneWidth.
    minPaneWidth: 0,
    ...options.deps,
  });
  resizer.bind();

  t.after(() => {
    resizer.dispose();
    window.close();
  });

  function pointer(type, init = {}) {
    const event = new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: init.pointerId ?? 1,
      clientX: init.clientX ?? 0,
      button: init.button ?? 0,
    });
    resizerEl.dispatchEvent(event);
    return event;
  }

  function key(name, target = resizerEl) {
    const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  return {
    window,
    document,
    chatViewEl,
    resizerEl,
    resizer,
    record,
    model,
    frames,
    runFrames,
    pointer,
    key,
    setRtl(value) { rtl = value; },
    paneA: () => chatViewEl.style.getPropertyValue('--chat-pane-a'),
    paneB: () => chatViewEl.style.getPropertyValue('--chat-pane-b'),
    valueNow: () => resizerEl.getAttribute('aria-valuenow'),
  };
}

module.exports = { FRAGMENT, roundTo4, createHarness };
