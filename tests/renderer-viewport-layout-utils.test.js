const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createViewportLayoutUtils,
} = require('../renderer/shell/renderer-viewport-layout-utils');

function setRect(element, rect) {
  element.getBoundingClientRect = () => ({ ...rect });
}

test('viewport layout utils measure safe offset and gutter widths', () => {
  const dom = new JSDOM(`
    <main id="chatView">
      <div id="effects"><div id="left"></div><div id="right"></div></div>
      <section id="stage"><div id="column"></div></section>
      <form id="composer"></form>
    </main>
  `);
  const documentRef = dom.window.document;
  const chatView = documentRef.getElementById('chatView');
  const chatSurfaceEffects = documentRef.getElementById('effects');
  const chatSurfaceEffectLeft = documentRef.getElementById('left');
  const chatSurfaceEffectRight = documentRef.getElementById('right');
  const chatThreadStage = documentRef.getElementById('stage');
  const chatThreadColumn = documentRef.getElementById('column');
  const composerWrap = documentRef.getElementById('composer');
  setRect(chatView, { height: 600 });
  setRect(chatThreadStage, { top: 0, bottom: 400, height: 400 });
  setRect(composerWrap, { top: 420, height: 80 });
  setRect(chatSurfaceEffects, { left: 0, right: 800 });
  setRect(chatThreadColumn, { left: 160, right: 640 });
  const state = { currentSessionId: 's1', ui: { activeView: 'chat', chatMode: 'thread' } };
  const syncCalls = [];

  const layout = createViewportLayoutUtils({
    state,
    dom: {
      chatView,
      chatSurfaceEffects,
      chatSurfaceEffectLeft,
      chatSurfaceEffectRight,
      chatThreadStage,
      chatThreadColumn,
      composerWrap,
    },
    callbacks: {
      getCurrentSessionMessages() { return [{ id: 'm1' }]; },
      scheduleMessageViewportSync(messages, options) {
        syncCalls.push({ messages, options });
      },
    },
  });

  layout.initializeComposerLayoutObserver();
  assert.equal(layout.getComposerSafeOffset(), 48);
  assert.equal(chatView.style.getPropertyValue('--composer-safe-offset'), '48px');
  assert.equal(chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-left-width'), '160px');
  assert.equal(chatSurfaceEffects.style.getPropertyValue('--chat-surface-effect-right-width'), '160px');

  layout.updateComposerSafeOffset({ force: true, syncViewport: true });
  assert.equal(syncCalls.length, 1);
  assert.deepEqual(syncCalls[0].options, {
    preserveFollowLatest: true,
    preserveSurfaceEffectWidths: false,
  });
});

function withFakeResizeObserverAndRaf(run) {
  let roCallback = null;
  const rafQueue = [];
  const originalRO = global.ResizeObserver;
  const originalRaf = global.requestAnimationFrame;
  const originalCancel = global.cancelAnimationFrame;
  global.ResizeObserver = class {
    constructor(cb) { roCallback = cb; }
    observe() {}
    disconnect() {}
  };
  global.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  global.cancelAnimationFrame = (handle) => { if (handle) { rafQueue[handle - 1] = null; } };
  try {
    return run({
      fireResize() { if (roCallback) { roCallback(); } },
      pendingFrames() { return rafQueue.filter(Boolean).length; },
      flushFrames() {
        for (let i = 0; i < rafQueue.length; i += 1) {
          const cb = rafQueue[i];
          rafQueue[i] = null;
          if (cb) { cb(); }
        }
      },
    });
  } finally {
    global.ResizeObserver = originalRO;
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancel;
  }
}

test('composer ResizeObserver coalesces a burst of callbacks into one frame', () => {
  withFakeResizeObserverAndRaf((raf) => {
    const layout = createViewportLayoutUtils({ state: { ui: {} }, dom: { composerWrap: {} } });
    layout.initializeComposerLayoutObserver();

    // A burst of observer callbacks within one frame must schedule exactly one rAF.
    raf.fireResize();
    raf.fireResize();
    raf.fireResize();
    assert.equal(raf.pendingFrames(), 1, 'three RO callbacks coalesce into a single pending frame');
    assert.ok(layout.composerLayoutRuntime.pendingResizeFrame, 'a frame handle is tracked for cancellation');

    raf.flushFrames();
    assert.equal(layout.composerLayoutRuntime.pendingResizeFrame, 0, 'the handle clears after the frame runs');

    // After the frame drains, a fresh burst schedules a new single frame.
    raf.fireResize();
    assert.equal(raf.pendingFrames(), 1, 'the next burst re-arms one frame');
  });
});

test('disposing the composer layout observer cancels a pending resize frame', () => {
  withFakeResizeObserverAndRaf((raf) => {
    const layout = createViewportLayoutUtils({ state: { ui: {} }, dom: { composerWrap: {} } });
    layout.initializeComposerLayoutObserver();

    raf.fireResize();
    assert.equal(raf.pendingFrames(), 1);

    layout.disposeComposerLayoutObserver();
    assert.equal(layout.composerLayoutRuntime.pendingResizeFrame, 0, 'dispose clears the tracked handle');
    assert.equal(raf.pendingFrames(), 0, 'dispose cancels the queued frame so it never fires post-dispose');
  });
});
