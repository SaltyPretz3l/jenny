'use strict';

/* Split view W1-3 -- the divider between the two conversation panes.
 *
 * The module is standalone: every dependency is injected, so these tests drive
 * it over a minimal jsdom fragment (`#chatView` > `#chatPane0`,
 * `#chatPaneResizer`, a second pane) with a fake requestAnimationFrame that
 * only runs when the test says so.
 *
 * Performance is the point of this slice (addendum section 8.3), so the load-bearing
 * cases are the first ones: fifty pointer moves inside one frame produce ONE
 * write pair, and the whole gesture reads `getBoundingClientRect` exactly once.
 * The rest pin the contract W1-4 wires against: the model (setSplitRatio) is
 * the single source of the clamped ratio, persistence happens once per
 * finished gesture and never per move, and a cancelled drag never leaves a
 * half-applied value.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createHarness, roundTo4 } = require('./helpers/pane-resizer-harness');

const MODULE_PATH = path.join(__dirname, '..', 'renderer', 'chat', 'renderer-chat-pane-resizer.js');
const PANE_MODEL_PATH = path.join(__dirname, '..', 'renderer', 'shell', 'renderer-pane-model.js');

const resizerModule = require('../renderer/chat/renderer-chat-pane-resizer');
const paneModel = require('../renderer/shell/renderer-pane-model');

const { createChatPaneResizer, KEYBOARD_STEP, HOME_RATIO, END_RATIO, MIN_PANE_WIDTH_PX } = resizerModule;

test('exports the factory and the keyboard constants', () => {
  assert.equal(typeof createChatPaneResizer, 'function');
  assert.equal(KEYBOARD_STEP, 0.02);
  assert.equal(HOME_RATIO, 0.5);
  assert.equal(END_RATIO, 0.8);
});

test('coalescing: fifty moves inside one frame schedule one frame and write one pair; one rect read per gesture', (t) => {
  const h = createHarness(t);
  const down = h.pointer('pointerdown', { clientX: 500 });
  assert.equal(down.defaultPrevented, true, 'pointerdown must preventDefault');
  assert.equal(h.record.rectReads, 1, 'pointerdown reads the width once');

  for (let i = 1; i <= 50; i += 1) h.pointer('pointermove', { clientX: 500 + i * 2 });
  assert.equal(h.record.scheduled, 1, 'fifty moves inside one frame schedule exactly one frame');
  assert.equal(h.record.setSplitRatio.length, 0, 'nothing is applied before the frame runs');
  assert.equal(h.record.setProperty.length, 0, 'no style write before the frame runs');

  assert.equal(h.runFrames(), 1);
  assert.deepEqual(h.record.setSplitRatio, [0.6], 'the frame applies the LAST pending ratio once');
  assert.deepEqual(h.record.setProperty, [['--chat-pane-a', '0.6fr'], ['--chat-pane-b', '0.4fr']]);
  assert.equal(h.valueNow(), '60');

  h.pointer('pointerup', { clientX: 600 });
  assert.equal(h.record.rectReads, 1, 'no getBoundingClientRect after pointerdown, for the whole gesture');
  assert.equal(h.record.setProperty.length, 2, 'pointerup with nothing pending writes nothing more');
  assert.deepEqual(h.record.setSplitRatio, [0.6]);

  // A second burst in a later frame schedules exactly one more frame.
  h.pointer('pointerdown', { clientX: 600 });
  for (let i = 0; i < 50; i += 1) h.pointer('pointermove', { clientX: 400 });
  assert.equal(h.record.scheduled, 2);
  h.runFrames();
  assert.deepEqual(h.record.setSplitRatio, [0.6, 0.4]);
  assert.equal(h.record.setProperty.length, 4);
  assert.equal(h.record.rectReads, 2, 'one read per gesture');
});

test('an injected measureWidth is the only width read; chatView rect is never touched', (t) => {
  // W1-4c passes the two panes plus the divider, so an open artifact or
  // context column never slows the divider behind the pointer.
  let measured = 0;
  const h = createHarness(t, { deps: { measureWidth: () => { measured += 1; return 500; } } });
  h.pointer('pointerdown', { clientX: 100 });
  h.pointer('pointermove', { clientX: 150 });
  h.runFrames();
  assert.equal(measured, 1, 'measureWidth runs once, at pointerdown');
  assert.equal(h.record.rectReads, 0, 'the chat view rect is not read when measureWidth is injected');
  assert.deepEqual(h.record.setSplitRatio, [0.6], '50px over 500px from 0.5 is 0.6');
  h.pointer('pointerup', { clientX: 150 });
  assert.equal(measured, 1);
});

test('ratio maths: +100px over 1000px from 0.5 is 0.6, and 0.4 under RTL', (t) => {
  const ltr = createHarness(t);
  ltr.pointer('pointerdown', { clientX: 300 });
  ltr.pointer('pointermove', { clientX: 400 });
  ltr.runFrames();
  assert.deepEqual(ltr.record.setSplitRatio, [0.6]);
  assert.equal(ltr.paneA(), '0.6fr');

  const rtl = createHarness(t, { rtl: true });
  rtl.pointer('pointerdown', { clientX: 300 });
  rtl.pointer('pointermove', { clientX: 400 });
  rtl.runFrames();
  assert.deepEqual(rtl.record.setSplitRatio, [0.4]);
  assert.equal(rtl.paneA(), '0.4fr');
  assert.equal(rtl.paneB(), '0.6fr');
  assert.equal(rtl.valueNow(), '40');
});

test('clamping is the model\'s: a move to 0.95 renders what setSplitRatio kept', (t) => {
  const h = createHarness(t);
  h.pointer('pointerdown', { clientX: 0 });
  h.pointer('pointermove', { clientX: 450 });
  h.runFrames();
  assert.deepEqual(h.record.setSplitRatio, [0.95], 'the module hands the model its unclamped number');
  assert.equal(h.paneA(), '0.8fr');
  assert.equal(h.paneB(), '0.2fr');
  assert.equal(h.valueNow(), '80');

  h.pointer('pointermove', { clientX: -450 });
  h.runFrames();
  assert.equal(h.paneA(), '0.2fr');
  assert.equal(h.paneB(), '0.8fr');
  assert.equal(h.valueNow(), '20');
  h.pointer('pointerup', { clientX: -450 });
  assert.deepEqual(h.record.persisted, [0.2], 'the persisted ratio is the clamped one');
});

test('pointerup persists once with the final ratio, clears the drag state and releases capture', (t) => {
  const h = createHarness(t);
  h.pointer('pointerdown', { clientX: 500, pointerId: 7 });
  assert.deepEqual(h.record.captured, [7]);
  assert.equal(h.resizerEl.classList.contains('dragging'), true);
  assert.equal(h.chatViewEl.getAttribute('data-pane-resizing'), '');
  assert.equal(h.resizer.isDragging(), true);

  h.pointer('pointermove', { clientX: 550, pointerId: 7 });
  h.runFrames();
  h.pointer('pointermove', { clientX: 620, pointerId: 7 });
  assert.deepEqual(h.record.persisted, [], 'never persists during pointermove');

  // The final move is still pending when the pointer lifts: pointerup cancels
  // the frame and applies it itself.
  h.pointer('pointerup', { clientX: 620, pointerId: 7 });
  assert.equal(h.record.cancelled.length, 1, 'the pending frame is cancelled');
  assert.equal(h.frames.size, 0);
  assert.deepEqual(h.record.setSplitRatio, [0.55, 0.62]);
  assert.equal(h.paneA(), '0.62fr');
  assert.deepEqual(h.record.persisted, [0.62], 'persists exactly once, with the final ratio');
  assert.deepEqual(h.record.released, [7]);
  assert.equal(h.resizerEl.classList.contains('dragging'), false);
  assert.equal(h.chatViewEl.hasAttribute('data-pane-resizing'), false);
  assert.equal(h.resizer.isDragging(), false);

  h.pointer('pointerup', { clientX: 620, pointerId: 7 });
  assert.deepEqual(h.record.persisted, [0.62], 'a stray second pointerup does not persist again');
});

test('pointercancel restores the start ratio and persists it once', (t) => {
  const h = createHarness(t, { startRatio: 0.45 });
  h.pointer('pointerdown', { clientX: 500 });
  h.pointer('pointermove', { clientX: 700 });
  h.runFrames();
  assert.equal(h.paneA(), '0.65fr');
  h.pointer('pointermove', { clientX: 750 });
  h.pointer('pointercancel', { clientX: 750 });
  assert.equal(h.frames.size, 0, 'the pending frame is cancelled');
  assert.deepEqual(h.record.setSplitRatio, [0.65, 0.45], 'the cancel writes the START ratio back');
  assert.equal(h.paneA(), '0.45fr');
  assert.equal(h.paneB(), '0.55fr');
  assert.equal(h.valueNow(), '45');
  assert.deepEqual(h.record.persisted, [0.45]);
  assert.deepEqual(h.record.released, [1]);
  assert.equal(h.resizerEl.classList.contains('dragging'), false);
  assert.equal(h.chatViewEl.hasAttribute('data-pane-resizing'), false);
});

test('Escape during a drag restores the start ratio, persists once and stops propagation', (t) => {
  const h = createHarness(t);
  const bubbled = [];
  h.chatViewEl.addEventListener('keydown', (event) => bubbled.push(event.key));
  h.pointer('pointerdown', { clientX: 500 });
  h.pointer('pointermove', { clientX: 600 });
  h.runFrames();
  assert.equal(h.paneA(), '0.6fr');

  const escape = h.key('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual(bubbled, [], 'Escape during a drag does not reach the rest of the app');
  assert.deepEqual(h.record.setSplitRatio, [0.6, 0.5]);
  assert.equal(h.paneA(), '0.5fr');
  assert.deepEqual(h.record.persisted, [0.5]);
  assert.deepEqual(h.record.released, [1]);
  assert.equal(h.resizer.isDragging(), false);

  // Outside a drag Escape is not the resizer's: it propagates untouched.
  const idle = h.key('Escape');
  assert.equal(idle.defaultPrevented, false);
  assert.deepEqual(bubbled, ['Escape']);
  assert.deepEqual(h.record.persisted, [0.5]);
});

test('lostpointercapture finishes at the last applied ratio without restoring', (t) => {
  const h = createHarness(t);
  h.pointer('pointerdown', { clientX: 500 });
  h.pointer('pointermove', { clientX: 580 });
  h.runFrames();
  h.pointer('pointermove', { clientX: 900 });
  h.pointer('lostpointercapture', { clientX: 900 });
  assert.equal(h.frames.size, 0);
  assert.deepEqual(h.record.setSplitRatio, [0.58], 'the unapplied pending move is dropped, the start is not restored');
  assert.equal(h.paneA(), '0.58fr');
  assert.deepEqual(h.record.persisted, [0.58]);
  assert.equal(h.resizer.isDragging(), false);
  assert.equal(h.chatViewEl.hasAttribute('data-pane-resizing'), false);
});

test('a non-primary button does nothing and a foreign pointer id is ignored', (t) => {
  const h = createHarness(t);
  const secondary = h.pointer('pointerdown', { clientX: 500, button: 2 });
  assert.equal(secondary.defaultPrevented, false);
  assert.equal(h.record.rectReads, 0);
  assert.deepEqual(h.record.captured, []);
  assert.equal(h.resizerEl.classList.contains('dragging'), false);
  assert.equal(h.chatViewEl.hasAttribute('data-pane-resizing'), false);
  assert.equal(h.resizer.isDragging(), false);

  h.pointer('pointerdown', { clientX: 500, pointerId: 1 });
  h.pointer('pointermove', { clientX: 700, pointerId: 2 });
  assert.equal(h.record.scheduled, 0, 'a move from another pointer schedules nothing');
  h.pointer('pointerup', { clientX: 700, pointerId: 2 });
  assert.equal(h.resizer.isDragging(), true, 'a pointerup from another pointer does not end the drag');
  assert.deepEqual(h.record.persisted, []);
  h.pointer('pointercancel', { pointerId: 2 });
  h.pointer('lostpointercapture', { pointerId: 2 });
  assert.equal(h.resizer.isDragging(), true);
  assert.deepEqual(h.record.setSplitRatio, []);
});

test('keyboard: arrows step 0.02, Home 0.5, End 0.8, each persisted once and synchronously', (t) => {
  const h = createHarness(t);
  const right = h.key('ArrowRight');
  assert.equal(right.defaultPrevented, true);
  assert.equal(h.record.scheduled, 0, 'no frame for a key: one key, one write');
  assert.deepEqual(h.record.setSplitRatio, [0.52]);
  assert.equal(h.paneA(), '0.52fr');
  assert.equal(h.valueNow(), '52');
  assert.deepEqual(h.record.persisted, [0.52]);

  h.key('ArrowLeft');
  h.key('ArrowLeft');
  assert.deepEqual(h.record.setSplitRatio, [0.52, 0.5, 0.48]);
  assert.deepEqual(h.record.persisted, [0.52, 0.5, 0.48]);

  h.key('End');
  assert.equal(h.paneA(), '0.8fr');
  h.key('ArrowRight');
  assert.equal(h.paneA(), '0.8fr', 'a step past the edge renders the model\'s clamp');
  assert.equal(roundTo4(h.record.setSplitRatio.at(-1)), 0.82);
  h.key('Home');
  assert.equal(h.paneA(), '0.5fr');
  assert.deepEqual(h.record.persisted, [0.52, 0.5, 0.48, 0.8, 0.8, 0.5]);
  assert.equal(h.record.setProperty.length, 12, 'six keys, six write pairs');
});

test('keyboard arrows are inverted under RTL', (t) => {
  const h = createHarness(t, { rtl: true });
  h.key('ArrowLeft');
  assert.deepEqual(h.record.setSplitRatio, [0.52]);
  h.key('ArrowRight');
  h.key('ArrowRight');
  assert.deepEqual(h.record.setSplitRatio, [0.52, 0.5, 0.48]);
  h.setRtl(false);
  h.key('ArrowLeft');
  assert.equal(roundTo4(h.record.setSplitRatio.at(-1)), 0.46, 'direction is read per key, not cached at bind');
});

test('keys during a drag and unrelated keys are ignored and not preventDefaulted', (t) => {
  const h = createHarness(t);
  for (const name of ['a', 'Enter', 'ArrowUp', 'ArrowDown', 'Tab']) {
    const event = h.key(name);
    assert.equal(event.defaultPrevented, false, `${name} is not the resizer's`);
  }
  assert.deepEqual(h.record.setSplitRatio, []);

  h.pointer('pointerdown', { clientX: 500 });
  for (const name of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    const event = h.key(name);
    assert.equal(event.defaultPrevented, false, `${name} during a drag is ignored`);
  }
  assert.deepEqual(h.record.setSplitRatio, []);
  assert.deepEqual(h.record.persisted, []);
  assert.equal(h.resizer.isDragging(), true);
});

test('a zero or non-finite width aborts the drag without changing anything', (t) => {
  for (const width of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const h = createHarness(t, { width });
    const down = h.pointer('pointerdown', { clientX: 500 });
    h.pointer('pointermove', { clientX: 600 });
    h.pointer('pointerup', { clientX: 600 });
    assert.equal(h.record.scheduled, 0, `width ${width}: no frame scheduled`);
    assert.deepEqual(h.record.setProperty, [], `width ${width}: no property written`);
    assert.deepEqual(h.record.setSplitRatio, []);
    assert.deepEqual(h.record.persisted, []);
    assert.deepEqual(h.record.captured, []);
    assert.equal(h.resizerEl.classList.contains('dragging'), false);
    assert.equal(h.chatViewEl.hasAttribute('data-pane-resizing'), false);
    assert.equal(h.resizer.isDragging(), false);
    assert.equal(down.defaultPrevented, true, 'the primary press is still claimed');
  }
});

test('sync() renders getSplitRatio() without writing the model or persisting', (t) => {
  const h = createHarness(t);
  h.model.ratio = 0.3;
  h.resizer.sync();
  assert.equal(h.paneA(), '0.3fr');
  assert.equal(h.paneB(), '0.7fr');
  assert.equal(h.valueNow(), '30');
  assert.deepEqual(h.record.setSplitRatio, []);
  assert.deepEqual(h.record.persisted, []);
});

test('dispose() cancels a pending frame, clears the drag state, removes every listener and is idempotent', (t) => {
  const h = createHarness(t);
  h.pointer('pointerdown', { clientX: 500 });
  h.pointer('pointermove', { clientX: 600 });
  assert.equal(h.frames.size, 1);

  h.resizer.dispose();
  assert.equal(h.record.cancelled.length, 1, 'the pending frame is cancelled');
  assert.equal(h.frames.size, 0);
  assert.equal(h.resizerEl.classList.contains('dragging'), false);
  assert.equal(h.chatViewEl.hasAttribute('data-pane-resizing'), false);
  assert.equal(h.resizer.isDragging(), false);
  assert.deepEqual(h.record.persisted, [], 'dispose never persists');

  h.resizer.dispose();
  assert.equal(h.record.cancelled.length, 1, 'a second dispose is a no-op');

  const down = h.pointer('pointerdown', { clientX: 500 });
  h.pointer('pointermove', { clientX: 700 });
  const arrow = h.key('ArrowRight');
  h.key('Escape');
  assert.equal(down.defaultPrevented, false, 'no pointerdown listener after dispose');
  assert.equal(arrow.defaultPrevented, false, 'no keydown listener after dispose');
  assert.equal(h.record.rectReads, 1);
  assert.equal(h.record.scheduled, 1);
  assert.deepEqual(h.record.setSplitRatio, []);
  assert.deepEqual(h.record.setProperty, []);
  assert.equal(h.resizerEl.classList.contains('dragging'), false);
});

test('bind() is idempotent: a second bind does not double the listeners', (t) => {
  const h = createHarness(t);
  h.resizer.bind();
  h.key('ArrowRight');
  assert.deepEqual(h.record.setSplitRatio, [0.52]);
  assert.deepEqual(h.record.persisted, [0.52]);
});

test('bind() writes the aria range from the pane model, or from injected bounds', (t) => {
  const h = createHarness(t);
  assert.equal(h.resizerEl.getAttribute('aria-valuemin'), String(paneModel.MIN_SPLIT_RATIO * 100));
  assert.equal(h.resizerEl.getAttribute('aria-valuemax'), String(paneModel.MAX_SPLIT_RATIO * 100));

  const custom = createHarness(t, { deps: { minRatio: 0.25, maxRatio: 0.75 } });
  assert.equal(custom.resizerEl.getAttribute('aria-valuemin'), '25');
  assert.equal(custom.resizerEl.getAttribute('aria-valuemax'), '75');
});

/* Gate F3 (2026-09-27): at the ratio floor alone (0.2) pane 0 was 156px at the
 * gate's width, below anything its composer can lay out while streaming. The
 * divider now keeps both panes at least MIN_PANE_WIDTH_PX wide. */
test('pixel floor: the default keeps both panes at least MIN_PANE_WIDTH_PX wide, by keyboard and by drag', (t) => {
  assert.equal(MIN_PANE_WIDTH_PX, 320);
  const h = createHarness(t, { deps: { minPaneWidth: undefined, measureWidth: () => 870 } });
  for (let i = 0; i < 20; i += 1) h.key('ArrowLeft');
  const floor = roundTo4(MIN_PANE_WIDTH_PX / 870);
  assert.equal(h.model.ratio, floor, 'twenty ArrowLefts stop at 320/870, not at the model\'s 0.2');
  assert.ok(h.model.ratio * 870 >= MIN_PANE_WIDTH_PX - 0.05, 'pane 0 keeps the floor');
  assert.equal(h.resizerEl.getAttribute('aria-valuemin'), String(Math.round(floor * 100)));
  assert.equal(h.resizerEl.getAttribute('aria-valuemax'), String(Math.round((1 - floor) * 100)));
  assert.equal(h.record.persisted.at(-1), floor, 'the persisted ratio is the floored one');
  h.key('End');
  assert.equal(h.model.ratio, roundTo4(1 - floor), 'End stops where pane 1 keeps the floor');

  h.pointer('pointerdown', { clientX: 400 });
  h.pointer('pointermove', { clientX: -400 });
  h.runFrames();
  assert.equal(h.model.ratio, floor, 'a drag past the floor renders the floor');
  h.pointer('pointerup', { clientX: -400 });
  assert.equal(h.record.persisted.at(-1), floor);
});

test('pixel floor: too narrow for two floors holds an even split; zoom above 1 raises it; 0 turns it off', (t) => {
  const narrow = createHarness(t, { deps: { minPaneWidth: 320, measureWidth: () => 600 } });
  narrow.key('ArrowLeft');
  assert.equal(narrow.model.ratio, 0.5, 'never past an even split');
  narrow.key('End');
  assert.equal(narrow.model.ratio, 0.5);

  const zoomed = createHarness(t, { deps: { minPaneWidth: 320, measureWidth: () => 1000 } });
  zoomed.document.documentElement.style.setProperty('--font-scale', '1.25');
  zoomed.chatViewEl.style.setProperty('--font-scale', '1.25');
  for (let i = 0; i < 20; i += 1) zoomed.key('ArrowLeft');
  assert.equal(zoomed.model.ratio, 0.4, '320px at zoom 1.25 is 400px of 1000px');

  const off = createHarness(t, { deps: { minPaneWidth: 0, measureWidth: () => 870 } });
  for (let i = 0; i < 20; i += 1) off.key('ArrowLeft');
  assert.equal(off.model.ratio, paneModel.MIN_SPLIT_RATIO, 'without a floor the model\'s clamp is the only one');
});

test('the module never touches hidden, never reads the document by id and never reads state', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const code = source.replace(new RegExp('/\\*[\\s\\S]*?\\*/', 'g'), '').replace(new RegExp('//.*', 'g'), '');
  for (const forbidden of ['getElementById', 'querySelector', 'state.', '.hidden', "'hidden'", 'localStorage', 'workspace.updateState']) {
    assert.equal(code.includes(forbidden), false, `the module must not contain ${forbidden}`);
  }
  assert.equal((code.match(new RegExp('getBoundingClientRect', 'g')) || []).length, 1, 'exactly one layout read site');
});

test('UMD: loading the file through a <script> sets window.rendererChatPaneResizer', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const load = (file) => {
    const script = document.createElement('script');
    script.textContent = fs.readFileSync(file, 'utf8');
    document.body.appendChild(script);
  };
  load(PANE_MODEL_PATH);
  load(MODULE_PATH);
  const api = dom.window.rendererChatPaneResizer;
  assert.equal(typeof api?.createChatPaneResizer, 'function');
  assert.equal(api.KEYBOARD_STEP, 0.02);
  assert.equal(api.HOME_RATIO, 0.5);
  assert.equal(api.END_RATIO, 0.8);

  // In the browser the bounds resolve through window.rendererPaneModel.
  const resizerEl = document.createElement('div');
  const chatViewEl = document.createElement('div');
  document.body.append(chatViewEl, resizerEl);
  const controller = api.createChatPaneResizer({
    resizerEl,
    chatViewEl,
    getSplitRatio: () => 0.5,
    setSplitRatio: (ratio) => ratio,
    onPersist() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  controller.bind();
  assert.equal(resizerEl.getAttribute('aria-valuemin'), '20');
  assert.equal(resizerEl.getAttribute('aria-valuemax'), '80');
  controller.sync();
  assert.equal(chatViewEl.style.getPropertyValue('--chat-pane-a'), '0.5fr');
  controller.dispose();
});
