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

test('readCurrentMaxHeightPx prefers the computed interpolated height and otherwise measures', () => {
  const el = { scrollHeight: 420, offsetHeight: 140, style: { maxHeight: '0px' } };
  assert.equal(motionHeightUtils.readCurrentMaxHeightPx(el, { getComputedStyle: () => ({ maxHeight: '135.5px' }) }), 135.5);
  for (const maxHeight of ['none', '', '50%']) {
    assert.equal(motionHeightUtils.readCurrentMaxHeightPx(el, { getComputedStyle: () => ({ maxHeight }) }), 420);
  }
  assert.equal(motionHeightUtils.readCurrentMaxHeightPx(el, null), 420);
  assert.equal(motionHeightUtils.readCurrentMaxHeightPx(null, null), 0);
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
  const timers = [];
  dom.window.setTimeout = (cb) => { timers.push(cb); return timers.length; };
  dom.window.clearTimeout = (id) => { timers[id - 1] = null; };
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
    dom, frames, timers, bindings, state, threadScroll,
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

function createLegacyToggleHarness(t, reducedMotion = false) {
  const dom = new JSDOM(`<div id="timeline"><div class="tool-call-block">
    <button class="tool-call-header" aria-expanded="true" aria-controls="details"></button>
    <div id="details" class="tool-call-details expanded">body</div></div></div>`);
  t.after(() => dom.window.close());
  dom.window.matchMedia = () => ({ matches: reducedMotion });
  const frames = [];
  const timers = [];
  dom.window.setTimeout = (cb) => { timers.push(cb); return timers.length; };
  dom.window.clearTimeout = (id) => { timers[id - 1] = null; };
  const details = dom.window.document.getElementById('details');
  Object.defineProperty(details, 'scrollHeight', { configurable: true, get: () => 420 });
  return { dom, frames, timers, details, header: dom.window.document.querySelector('button'),
    toggle: captureToggleToolDetails(dom, frames) };
}

test('reduced-motion legacy tool toggles schedule no frames or timers and keep expansion unconstrained', (t) => {
  const h = createLegacyToggleHarness(t, true);
  h.toggle(h.header, false);
  h.toggle(h.header, true);
  h.frames.splice(0).forEach((cb) => cb());
  assert.equal(h.details.style.maxHeight, 'none', 'reduced-motion expansion stays unconstrained after frames');
  assert.equal(h.timers.length, 0, 'reduced motion must schedule no timers');
  h.toggle(h.header, false);
  assert.equal(h.details.hidden, true);
  assert.equal(h.details.classList.contains('expanded'), false);
  assert.equal(h.details.style.maxHeight, '');
  assert.equal(h.frames.length, 0);
});

test('legacy tool collapse then expand within one frame stays expanded and visible', (t) => {
  const h = createLegacyToggleHarness(t);
  h.toggle(h.header, false);
  h.toggle(h.header, true);
  h.frames.splice(0).forEach((cb) => cb());
  h.timers.splice(0).forEach((cb) => cb && cb());
  assert.equal(h.details.classList.contains('expanded'), true, 'latest tool expand must keep .expanded');
  assert.equal(h.details.hidden, false);
  assert.equal(h.details.style.maxHeight, 'none');
});

test('legacy tool reopen reverses from the live computed collapse height', (t) => {
  const h = createLegacyToggleHarness(t);
  h.toggle(h.header, false);
  h.frames.splice(0).forEach((cb) => cb());
  const original = h.dom.window.getComputedStyle.bind(h.dom.window);
  h.dom.window.getComputedStyle = (el) => el === h.details ? { maxHeight: '135.5px' } : original(el);
  h.toggle(h.header, true);
  assert.equal(h.details.style.maxHeight, '135.5px');
  h.frames.splice(0).forEach((cb) => cb());
  assert.equal(h.details.style.maxHeight, '420px');
});

test('legacy tool expand then collapse ignores the stale expansion frame', (t) => {
  const h = createLegacyToggleHarness(t);
  h.toggle(h.header, true);
  h.toggle(h.header, false);
  const pin = h.details.style.maxHeight;
  h.frames.shift()();
  assert.equal(h.details.style.maxHeight, pin);
  h.frames.splice(0).forEach((cb) => cb());
  h.timers.splice(0).forEach((cb) => cb && cb());
  assert.equal(h.details.hidden, true);
  assert.equal(h.details.classList.contains('expanded'), false);
});

test('minimal tool reopen reverses from the live height and fences stale frames', () => {
  const h = createMinimalRowHarness(true);
  try {
    trackHeight(h.body, 'none', 420);
    h.toggle.click();
    h.dom.window.getComputedStyle = () => ({ maxHeight: '135.5px' });
    h.toggle.click();
    assert.equal(h.body.style.maxHeight, '135.5px');
    h.frames.splice(0).forEach((cb) => cb());
    h.timers.splice(0).forEach((cb) => cb && cb());
    assert.equal(h.body.style.maxHeight, 'none');
    h.toggle.click();
    h.toggle.click();
    h.toggle.click();
    h.frames.splice(0).forEach((cb) => cb());
    assert.equal(h.body.style.maxHeight, '0px');
    h.timers.splice(0).forEach((cb) => cb && cb());
    assert.equal(h.body.style.maxHeight, '');
  } finally { h.bindings.dispose(); h.dom.window.close(); }
});

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
  const timers = [];
  global.requestAnimationFrame = (cb) => frames.push(cb);
  dom.window.setTimeout = (cb) => { timers.push(cb); return timers.length; };
  dom.window.clearTimeout = (id) => { timers[id - 1] = null; };
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
  timers.splice(0).forEach((cb) => cb && cb());

  log.length = 0;
  collapsible.toggle(trigger, true);
  frames.splice(0).forEach((cb) => cb());
  assertOrdered(log, ['write:0px', 'read', 'write:250px']);
});

test('inventory collapsible reverses from the live computed height mid-transition', (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = { window: global.window, document: global.document, raf: global.requestAnimationFrame };
  global.window = dom.window;
  global.document = dom.window.document;
  const frames = [];
  const timers = [];
  global.requestAnimationFrame = (cb) => frames.push(cb);
  dom.window.setTimeout = (cb) => { timers.push(cb); return timers.length; };
  dom.window.clearTimeout = (id) => { timers[id - 1] = null; };
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
  trackHeight(content, 'none');
  const original = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = (el) => (el === content ? { maxHeight: '135.5px' } : original(el));

  collapsible.toggle(trigger, false);
  frames.splice(0).forEach((cb) => cb());
  assert.equal(content.style.maxHeight, '0px');
  collapsible.toggle(trigger, true);
  assert.equal(content.style.maxHeight, '135.5px', 're-expand mid-collapse starts from the live height, not 0');
  frames.splice(0).forEach((cb) => cb());
  assert.equal(content.style.maxHeight, '250px');
  collapsible.toggle(trigger, false);
  assert.equal(content.style.maxHeight, '135.5px', 'collapse mid-expand starts from the live height, not the target');
  frames.splice(0).forEach((cb) => cb());
  assert.equal(content.style.maxHeight, '0px');
  timers.splice(0).forEach((cb) => cb && cb());
  assert.equal(content.hidden, true);
});

test('inventory collapsible fences both frame directions and reduced motion schedules no work', (t) => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: global.window, document: global.document, raf: global.requestAnimationFrame };
  global.window = dom.window; global.document = dom.window.document;
  const frames = []; const timers = [];
  global.requestAnimationFrame = (cb) => frames.push(cb);
  dom.window.setTimeout = (cb) => { timers.push(cb); return timers.length; };
  dom.window.clearTimeout = (id) => { timers[id - 1] = null; };
  let reducedMotion = false;
  dom.window.matchMedia = () => ({ matches: reducedMotion });
  t.after(() => {
    global.window = previous.window; global.document = previous.document;
    global.requestAnimationFrame = previous.raf; dom.window.close();
  });
  const collapsible = require('../renderer/inventory/collapsible');
  const root = dom.window.document.getElementById('root');
  root.innerHTML = collapsible.trigger({ id: 'panel', open: true, children: 'Toggle' })
    + collapsible.content({ id: 'panel', open: true, children: 'Body' });
  const trigger = root.querySelector('[data-inv-collapsible]');
  const content = root.querySelector('#panel');
  trackHeight(content, 'none');
  collapsible.toggle(trigger, false); collapsible.toggle(trigger, true);
  frames.splice(0).forEach((cb) => cb()); timers.splice(0).forEach((cb) => cb && cb());
  assert.equal(content.classList.contains('expanded'), true);
  assert.equal(content.hidden, false);
  assert.equal(content.style.maxHeight, 'none');
  collapsible.toggle(trigger, true); collapsible.toggle(trigger, false);
  const pin = content.style.maxHeight;
  frames.shift()();
  assert.equal(content.style.maxHeight, pin, 'stale inventory expansion frame must not write');
  frames.splice(0).forEach((cb) => cb()); timers.splice(0).forEach((cb) => cb && cb());
  assert.equal(content.hidden, true);
  reducedMotion = true;
  collapsible.toggle(trigger, true);
  assert.equal(content.style.maxHeight, 'none');
  collapsible.toggle(trigger, false);
  assert.equal(content.classList.contains('expanded'), false);
  assert.equal(content.style.maxHeight, '');
  assert.equal(frames.length, 0);
  assert.equal(timers.length, 0);
});
