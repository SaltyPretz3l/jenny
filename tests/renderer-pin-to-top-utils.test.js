const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const pinToTopUtils = require('../renderer/chat/renderer-pin-to-top-utils.js');

function createRafHarness() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    requestAnimationFrame(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      callbacks.delete(id);
    },
    flush(timestamp = 16) {
      const pending = Array.from(callbacks.entries());
      callbacks.clear();
      pending.forEach(([, callback]) => callback(timestamp));
    },
  };
}

function createResizeObserverHarness() {
  const observers = [];

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }

    observe(target) {
      this.targets.add(target);
    }

    unobserve(target) {
      this.targets.delete(target);
    }

    disconnect() {
      this.targets.clear();
    }
  }

  return {
    ResizeObserver: FakeResizeObserver,
    flush(targets = null) {
      observers.forEach((observer) => {
        const entries = Array.from(observer.targets)
          .filter((target) => !targets || targets.includes(target))
          .map((target) => ({ target }));
        if (entries.length) {
          observer.callback(entries);
        }
      });
    },
  };
}

function withPinControllerEnv(callback) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const { window } = dom;
  const { document } = window;
  const raf = createRafHarness();
  const resizeObserver = createResizeObserverHarness();

  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  const previousResizeObserver = global.ResizeObserver;

  global.window = window;
  global.document = document;
  global.requestAnimationFrame = raf.requestAnimationFrame;
  global.cancelAnimationFrame = raf.cancelAnimationFrame;
  global.ResizeObserver = resizeObserver.ResizeObserver;

  try {
    callback({ window, document, raf, resizeObserver });
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
    global.ResizeObserver = previousResizeObserver;
    window.close();
  }
}

function buildRect(nextRect) {
  const safeRect = nextRect && typeof nextRect === 'object' ? nextRect : {};
  const top = Number.isFinite(Number(safeRect.top)) ? Number(safeRect.top) : 0;
  const bottom = Number.isFinite(Number(safeRect.bottom)) ? Number(safeRect.bottom) : top;
  const left = Number.isFinite(Number(safeRect.left)) ? Number(safeRect.left) : 0;
  const right = Number.isFinite(Number(safeRect.right)) ? Number(safeRect.right) : left;
  return {
    top,
    bottom,
    left,
    right,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function createPinHarness(doc) {
  const scrollListeners = { added: [], removed: [] };
  const scrollContainer = doc.createElement('div');
  const timelineContainer = doc.createElement('div');

  scrollContainer.appendChild(timelineContainer);
  doc.body.appendChild(scrollContainer);

  scrollContainer.getBoundingClientRect = () => ({
    top: 0,
    bottom: 500,
    left: 0,
    right: 500,
    width: 500,
    height: 500,
  });

  const nativeAddEventListener = scrollContainer.addEventListener.bind(scrollContainer);
  const nativeRemoveEventListener = scrollContainer.removeEventListener.bind(scrollContainer);
  scrollContainer.addEventListener = (eventName, handler, options) => {
    scrollListeners.added.push({ eventName, handler, options });
    return nativeAddEventListener(eventName, handler, options);
  };
  scrollContainer.removeEventListener = (eventName, handler, options) => {
    scrollListeners.removed.push({ eventName, handler, options });
    return nativeRemoveEventListener(eventName, handler, options);
  };

  function addUserEntry(messageId, text, rects) {
    const entry = doc.createElement('article');
    const bubble = doc.createElement('div');
    const safeRects = rects && typeof rects === 'object' ? rects : {};
    let currentEntryRect = buildRect({
      top: safeRects.entryTop != null ? safeRects.entryTop : (safeRects.entryBottom != null ? safeRects.entryBottom - 40 : 0),
      bottom: safeRects.entryBottom != null ? safeRects.entryBottom : 0,
      left: safeRects.entryLeft != null ? safeRects.entryLeft : 0,
      right: safeRects.entryRight != null ? safeRects.entryRight : 300,
    });

    entry.className = 'chat-entry user';
    entry.setAttribute('data-message-role', 'user');
    entry.dataset.messageId = messageId;
    entry.getBoundingClientRect = () => currentEntryRect;

    bubble.className = 'chat-bubble';
    bubble.textContent = text;
    entry.appendChild(bubble);
    timelineContainer.appendChild(entry);

    return {
      entry,
      bubble,
      setEntryRect(nextRect) {
        currentEntryRect = buildRect({ ...currentEntryRect, ...nextRect });
      },
      setBottom(nextBottom) {
        const entryHeight = currentEntryRect.height || 40;
        currentEntryRect = buildRect({
          top: nextBottom - entryHeight,
          bottom: nextBottom,
          left: currentEntryRect.left,
          right: currentEntryRect.right,
        });
      },
    };
  }

  return {
    scrollContainer,
    timelineContainer,
    scrollListeners,
    addUserEntry,
  };
}

test('pin-to-top controller binds once, renders nothing, and dispose removes listeners idempotently', () => {
  withPinControllerEnv(({ document }) => {
    const harness = createPinHarness(document);
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
    });

    controller.bind();
    controller.bind();

    // scroll-W4a: the controller is renderless — it must never create overlay DOM.
    assert.equal(document.querySelector('.chat-pin-overlay'), null);
    assert.equal(harness.scrollListeners.added.length, 1);
    assert.equal(harness.scrollListeners.added[0].eventName, 'scroll');

    controller.dispose();
    assert.equal(harness.scrollListeners.removed.length, 1);
    assert.equal(harness.scrollListeners.removed[0].eventName, 'scroll');

    controller.dispose();
    assert.equal(harness.scrollListeners.removed.length, 1);
  });
});

test('production external-scroll mode attaches no native scroll listener', () => {
  withPinControllerEnv(({ document }) => {
    const harness = createPinHarness(document);
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
      listenForScroll: false,
    });

    controller.bind();
    assert.equal(harness.scrollListeners.added.length, 0);
    controller.handleScrollFrame();
    controller.dispose();
    assert.equal(harness.scrollListeners.removed.length, 0);
  });
});

test('pin-to-top controller reports prompt state through onStateChange', () => {
  withPinControllerEnv(({ document, raf }) => {
    const harness = createPinHarness(document);
    const stateChanges = [];
    harness.addUserEntry('u1', 'A pinned prompt for orientation', {
      entryBottom: 40,
    });
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
      onStateChange(nextState) {
        stateChanges.push(nextState);
      },
    });

    controller.bind();
    raf.flush();

    assert.equal(stateChanges.at(-1).visible, true);
    assert.equal(stateChanges.at(-1).messageId, 'u1');
    assert.equal(stateChanges.at(-1).text, 'A pinned prompt for orientation');

    const changeCountAfterFirstSync = stateChanges.length;
    controller.handleScroll();
    raf.flush();
    assert.equal(stateChanges.length, changeCountAfterFirstSync);

    controller.dispose();
    assert.equal(stateChanges.at(-1).visible, false);
  });
});

test('pin-to-top controller reports no pin until a prompt is crossed and normalizes clamped preview text', () => {
  withPinControllerEnv(({ document, raf }) => {
    const harness = createPinHarness(document);
    const longText = `Other - I'll tell you about it\n\nI'm new to this, want simple setup\tRunning locally. ${'Long prompt text '.repeat(20)}`;
    const normalized = longText.replace(/\s+/g, ' ').trim();
    let pinState = null;
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
      onStateChange(nextState) { pinState = nextState; },
    });
    const firstEntry = harness.addUserEntry('user-1', longText, {
      entryBottom: 132,
    });
    const secondEntry = harness.addUserEntry('user-2', 'Second prompt', {
      entryBottom: 152,
    });

    controller.bind();
    raf.flush();

    assert.equal(pinState, null);

    firstEntry.setBottom(80);
    controller.handleScroll();
    raf.flush();

    assert.equal(pinState.messageId, 'user-1');
    assert.equal(pinState.text, normalized.slice(0, 200) + '\u2026');

    secondEntry.setBottom(70);
    controller.handleScroll();
    raf.flush();

    assert.equal(pinState.messageId, 'user-2');
    assert.equal(pinState.text, 'Second prompt');
  });
});

test('cached prompt text survives DOM virtualization before the prompt crosses the pin threshold', () => {
  withPinControllerEnv(({ document, raf }) => {
    const harness = createPinHarness(document);
    const prompt = harness.addUserEntry('user-cached', 'Keep this prompt available', {
      entryTop: 120,
      entryBottom: 160,
    });
    let pinState = null;
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
      onStateChange(nextState) { pinState = nextState; },
    });
    controller.bind();
    raf.flush();
    assert.equal(pinState, null);

    prompt.entry.innerHTML = '<div class="chat-entry-virtualized"><span class="sr-only">summary</span></div>';
    prompt.setEntryRect({ top: 20, bottom: 60 });
    controller.handleScroll();
    raf.flush();

    assert.equal(pinState.messageId, 'user-cached');
    assert.equal(pinState.text, 'Keep this prompt available');
  });
});

test('pin-to-top controller recomputes pin state on layout changes without requiring a manual scroll', () => {
  withPinControllerEnv(({ document, raf, resizeObserver }) => {
    const harness = createPinHarness(document);
    let pinState = null;
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
      onStateChange(nextState) { pinState = nextState; },
    });

    const pinnedEntry = harness.addUserEntry('user-1', 'Pinned prompt', {
      entryTop: 130,
      entryBottom: 170,
    });
    controller.bind();
    raf.flush();
    assert.equal(pinState, null);

    // A layout change (streaming growth) moves the prompt above the threshold;
    // the ResizeObserver on the timeline must trigger the recompute by itself.
    pinnedEntry.setEntryRect({ top: 20, bottom: 60 });
    resizeObserver.flush([harness.timelineContainer]);
    raf.flush();
    assert.equal(pinState.messageId, 'user-1');
  });
});

function spyFullTimelineScan(harness) {
  let count = 0;
  const real = harness.timelineContainer.querySelectorAll.bind(harness.timelineContainer);
  harness.timelineContainer.querySelectorAll = (selector) => { count += 1; return real(selector); };
  return () => count;
}

test('B5: refreshScoped does a scoped re-scan with NO whole-timeline querySelectorAll when no new user node appears', () => {
  withPinControllerEnv(({ document, raf }) => {
    const harness = createPinHarness(document);
    harness.addUserEntry('m1', 'first', { entryBottom: 100 });
    harness.addUserEntry('m2', 'second', { entryBottom: 200 });
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
    });
    controller.bind();
    controller.refresh();
    raf.flush(); // collectPinnableElements -> cache = [m1, m2]

    const fullScans = spyFullTimelineScan(harness);
    // A patched assistant subtree contains no pinnable (user-role) node.
    const assistant = document.createElement('article');
    assistant.className = 'chat-entry assistant';
    assistant.setAttribute('data-message-role', 'assistant');
    assistant.dataset.messageId = 'a1';
    harness.timelineContainer.appendChild(assistant);

    controller.refreshScoped(assistant);
    raf.flush();
    assert.equal(fullScans(), 0, 'a stream patch with no new user node must not re-scan the whole timeline');
  });
});

test('B5: refreshScoped falls back to a full re-scan when a NEW user-role node appears in the patched subtree (C7)', () => {
  withPinControllerEnv(({ document, raf }) => {
    const harness = createPinHarness(document);
    harness.addUserEntry('m1', 'first', { entryBottom: 100 });
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
    });
    controller.bind();
    controller.refresh();
    raf.flush(); // cache = [m1]

    const fullScans = spyFullTimelineScan(harness);
    // A newly-promoted interactive row surfaces as a user-role node in the patched subtree.
    const promoted = harness.addUserEntry('m2', 'promoted', { entryBottom: 200 }).entry;

    controller.refreshScoped(promoted);
    raf.flush();
    assert.ok(fullScans() >= 1, 'a new user-role node must trigger the full collectPinnableElements fallback');
  });
});

test('B5: refreshScoped(null) falls back to a full refresh', () => {
  withPinControllerEnv(({ document, raf }) => {
    const harness = createPinHarness(document);
    harness.addUserEntry('m1', 'first', { entryBottom: 100 });
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
    });
    controller.bind();
    controller.refresh();
    raf.flush();

    const fullScans = spyFullTimelineScan(harness);
    controller.refreshScoped(null);
    raf.flush();
    assert.ok(fullScans() >= 1, 'refreshScoped(null) must do a full re-scan');
  });
});

test('5,000-prompt active-pin lookup uses logarithmic row rectangle reads', () => {
  withPinControllerEnv(({ document, raf }) => {
    const harness = createPinHarness(document);
    let rowRectReads = 0;
    let pinState = null;
    const count = 5000;
    for (let index = 0; index < count; index += 1) {
      const item = harness.addUserEntry(`prompt-${index}`, `Prompt ${index}`, {
        entryTop: index * 40,
        entryBottom: (index + 1) * 40,
      });
      const rect = item.entry.getBoundingClientRect();
      item.entry.getBoundingClientRect = () => {
        rowRectReads += 1;
        return rect;
      };
    }
    const controller = pinToTopUtils.createPinToTopController({
      scrollContainer: harness.scrollContainer,
      timelineContainer: harness.timelineContainer,
      onStateChange(nextState) { pinState = nextState; },
    });

    controller.bind();
    raf.flush();
    const budget = Math.ceil(Math.log2(count)) + 6;
    assert.ok(rowRectReads <= budget, `${rowRectReads} reads must be <= ${budget}`);
    assert.equal(pinState.messageId, 'prompt-1');
  });
});
