'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const motionHeightUtils = require('../renderer/shared/motion-height-utils');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');

function trackHeight(element, initialMaxHeight, height = 250) {
  const log = [];
  let maxHeight = initialMaxHeight;
  Object.defineProperty(element.style, 'maxHeight', {
    configurable: true,
    get() { return maxHeight; },
    set(value) { maxHeight = String(value); log.push(`write:${value}`); },
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get() { log.push('measure'); return height; },
  });
  Object.defineProperty(element, 'offsetHeight', {
    configurable: true,
    get() { log.push('read'); return height; },
  });
  return log;
}

function assertOrdered(log, expected) {
  let cursor = -1;
  for (const entry of expected) {
    cursor = log.indexOf(entry, cursor + 1);
    assert.notEqual(cursor, -1, `${entry} must follow the prior transition step: ${log.join(', ')}`);
  }
}

test('measureCollapseStartPx returns the larger rendered height and handles a missing element', () => {
  assert.equal(motionHeightUtils.measureCollapseStartPx({ scrollHeight: 120, offsetHeight: 140 }), 140);
  assert.equal(motionHeightUtils.measureCollapseStartPx(null), 0);
});

test('resolveCollapseStartPx parses inline px and otherwise measures the element', () => {
  assert.equal(motionHeightUtils.resolveCollapseStartPx({ style: { maxHeight: '42.5px' } }), 42.5);
  assert.equal(motionHeightUtils.resolveCollapseStartPx({
    style: { maxHeight: 'none' }, scrollHeight: 160, offsetHeight: 150,
  }), 160);
});

test('pinHeightForTransition writes the bounded pin before forcing a layout read', () => {
  const log = [];
  const element = {
    style: { set maxHeight(value) { log.push(`write:${value}`); } },
    get offsetHeight() { log.push('read'); return 100; },
  };
  motionHeightUtils.pinHeightForTransition(element, -10);
  assert.deepEqual(log, ['write:0px', 'read']);
});

function createMinimalRowHarness(expanded) {
  const dom = new JSDOM(`<!doctype html><body><div id="thread-scroll"><div id="timeline">
    <div class="tool-call-row--minimal" data-expanded="${expanded}">
      <div role="button" data-tool-row-toggle="true" aria-expanded="${expanded}">Toggle</div>
      <div class="tool-call-row-body"></div>
    </div></div></div></body>`);
  const frames = [];
  dom.window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  dom.window.setTimeout = () => 1;
  dom.window.clearTimeout = () => {};
  const timeline = dom.window.document.getElementById('timeline');
  const threadScroll = dom.window.document.getElementById('thread-scroll');
  threadScroll.scrollTop = 137;
  const state = { ui: { followLatest: false } };
  const deps = new Proxy({
    chatTimeline: timeline,
    state,
    thinkingController: {},
    getToolDetailsTransitionMs: () => 220,
  }, { get: (target, property) => (property in target ? target[property] : () => {}) });
  const bindings = createTranscriptEventBindings(deps);
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });
  return {
    dom, frames, bindings, state, threadScroll,
    body: timeline.querySelector('.tool-call-row-body'),
    toggle: timeline.querySelector('[data-tool-row-toggle]'),
  };
}

test('minimal tool-row collapse commits its measured pin before the rAF target', () => {
  const harness = createMinimalRowHarness(true);
  const log = trackHeight(harness.body, 'none');
  harness.toggle.click();
  harness.frames.shift()();
  assertOrdered(log, ['write:250px', 'read', 'write:0px']);
  harness.bindings.dispose();
  harness.dom.window.close();
});

test('minimal tool-row expand commits zero before the measured rAF target', () => {
  const harness = createMinimalRowHarness(false);
  const log = trackHeight(harness.body, '', 420);
  harness.toggle.click();
  harness.frames.shift()();
  assertOrdered(log, ['write:0px', 'read', 'write:420px']);
  assert.equal(harness.threadScroll.scrollTop, 137, 'tool expansion does not write the reader scroll position');
  assert.equal(harness.state.ui.followLatest, false, 'tool expansion does not relatch follow-latest');
  harness.bindings.dispose();
  harness.dom.window.close();
});

function captureToggleToolDetails(dom, frames) {
  let toggleToolDetails = null;
  const bindingStub = {
    createTranscriptEventBindings(deps) {
      toggleToolDetails = deps.toggleToolDetails;
      return { bindTranscriptEvents() {}, dispose() {} };
    },
  };
  const context = {
    console,
    document: dom.window.document,
    window: dom.window,
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    rendererMotionHeightUtils: motionHeightUtils,
    rendererAsyncFence: require('../renderer/shared/async-fence'),
    rendererEnterKeydownUtils: require('../renderer/chat/renderer-enter-keydown-utils'),
    rendererChatEventTranscriptBindings: bindingStub,
    rendererChatEventSettingsBindings: {
      createSettingsEventBindings: () => ({ bindSettingsEvents() {} }),
    },
    rendererChatEventInteractiveBindings: { bindInteractiveComposerEvents() {} },
    rendererChatBackendRecoveryUtils: {},
    rendererWindowControlsUtils: {},
    rendererRenderPipelineThreadStateUtils: {},
  };
  context.globalThis = context;
  const source = fs.readFileSync(path.join(__dirname, '../renderer/chat/renderer-chat-event-utils.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'renderer-chat-event-utils.js' });
  const timeline = dom.window.document.getElementById('timeline');
  context.rendererChatEventUtils.createChatEventBindings({
    state: { ui: {} },
    constants: { TOAST_SOURCE: { chatStream: 'chat' }, ACTIVITY_SCOPE: {} },
    dom: new Proxy({ chatTimeline: timeline }, { get: (target, property) => target[property] || null }),
    callbacks: new Proxy({}, { get: () => () => {} }),
    controllers: new Proxy({ thinkingController: {} }, { get: (target, property) => target[property] || null }),
  });
  return toggleToolDetails;
}

test('legacy tool-details collapse commits its measured pin before the rAF target', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="timeline"><div class="tool-call-block">
    <button class="tool-call-header" aria-expanded="true" aria-controls="details"></button>
    <div id="details" class="tool-call-details expanded"></div>
  </div></div></body>`);
  const frames = [];
  dom.window.setTimeout = () => 1;
  dom.window.clearTimeout = () => {};
  const details = dom.window.document.getElementById('details');
  const log = trackHeight(details, 'none');
  const toggleToolDetails = captureToggleToolDetails(dom, frames);
  toggleToolDetails(dom.window.document.querySelector('.tool-call-header'), false);
  frames.shift()();
  assertOrdered(log, ['write:250px', 'read', 'write:0px']);
  dom.window.close();
});

test('legacy tool-details expansion measures complete content without changing reader scroll state', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="thread-scroll"><div id="timeline"><div class="tool-call-block">
    <button class="tool-call-header" aria-expanded="false" aria-controls="details"></button>
    <div id="details" class="tool-call-details" hidden><div class="file-diff" data-expanded="true"><div class="file-diff-body">diff</div></div></div>
  </div></div></div></body>`);
  const frames = [];
  dom.window.setTimeout = () => 1;
  dom.window.clearTimeout = () => {};
  const details = dom.window.document.getElementById('details');
  const threadScroll = dom.window.document.getElementById('thread-scroll');
  threadScroll.scrollTop = 211;
  const log = trackHeight(details, '', 420);
  const toggleToolDetails = captureToggleToolDetails(dom, frames);

  toggleToolDetails(dom.window.document.querySelector('.tool-call-header'), true);
  frames.shift()();

  assertOrdered(log, ['measure', 'write:0px', 'read', 'measure', 'write:420px']);
  assert.equal(threadScroll.scrollTop, 211);
  assert.equal(details.hidden, false);
  dom.window.close();
});

test('inventoryCollapsible.toggle pins the start height and reads layout before the rAF target write', (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = { window: global.window, document: global.document, raf: global.requestAnimationFrame };
  global.window = dom.window;
  global.document = dom.window.document;
  const frames = [];
  global.requestAnimationFrame = (cb) => frames.push(cb);
  t.after(() => {
    global.window = previous.window;
    global.document = previous.document;
    global.requestAnimationFrame = previous.raf;
    dom.window.close();
  });
  const collapsible = require('../renderer/inventory/collapsible');
  const root = dom.window.document.getElementById('root');
  root.innerHTML = collapsible.trigger({ id: 'inv-panel', children: 'Toggle', open: true })
    + collapsible.content({ id: 'inv-panel', children: 'Body', open: true });
  const trigger = root.querySelector('[data-inv-collapsible]');
  const content = root.querySelector('#inv-panel');
  const log = trackHeight(content, 'none');

  collapsible.toggle(trigger, false);
  frames.splice(0).forEach((cb) => cb());
  assertOrdered(log, ['write:250px', 'read', 'write:0px']);

  log.length = 0;
  collapsible.toggle(trigger, true);
  frames.splice(0).forEach((cb) => cb());
  assertOrdered(log, ['write:0px', 'read', 'write:250px']);
});
