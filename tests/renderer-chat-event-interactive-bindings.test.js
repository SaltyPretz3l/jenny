const test = require('node:test');
const assert = require('node:assert/strict');

const { bindInteractiveComposerEvents } = require('../renderer/chat/renderer-chat-event-interactive-bindings');

// Pure-function harness: capture (root, type, handler) per registerListener call
// and synthesize events whose target.closest() resolves to fake panel elements.
// No jsdom needed (the module only reads event.target.closest + dataset), so the
// t.after/dispose conventions are N/A here.
function makeHarness(extraHandlers) {
  const registered = [];
  const calls = [];
  const root = { __id: 'timelineRoot' };
  const composerWrap = { __id: 'composerWrap' };
  const handlers = Object.assign({
    handleInteractiveOptionSelect: (...a) => calls.push(['option', a]),
    handleInteractiveOtherConfirm: (...a) => calls.push(['otherConfirm', a]),
    handleInteractiveSubmit: (...a) => { calls.push(['submit', a]); return Promise.resolve(); },
    handleInteractiveSkip: (...a) => { calls.push(['skip', a]); return Promise.resolve(); },
    handleInteractiveSkipQuestion: (...a) => calls.push(['skipQuestion', a]),
    handleInteractiveSkipAll: (...a) => calls.push(['skipAll', a]),
    handleInteractiveOtherInputChange: (...a) => calls.push(['otherInput', a]),
    handleComposerToggleChange: (...a) => calls.push(['toggle', a]),
    showComposerActionError: () => {},
    getPendingQuestionBatch: () => ({ batch_id: 'qb_live' }),
  }, extraHandlers || {});

  bindInteractiveComposerEvents(Object.assign({
    composerWrap,
    interactiveDelegateRoot: root,
    registerListener: (el, type, handler, opts) => registered.push({ el, type, handler, opts }),
    listenerOptions: { passive: false },
  }, handlers));

  const getHandler = (el, type) => registered.find((r) => r.el === el && r.type === type)?.handler;
  return { registered, calls, root, composerWrap, getHandler };
}

function fakeEvent(closestMap, extra) {
  return Object.assign({
    target: { closest: (sel) => (Object.prototype.hasOwnProperty.call(closestMap, sel) ? closestMap[sel] : null) },
    preventDefault: () => {},
  }, extra || {});
}

test('interactive bindings: click/input/keydown delegate on the timeline root, inv-toggle-change on composerWrap', () => {
  const h = makeHarness();
  const onRoot = (type) => h.registered.some((r) => r.el === h.root && r.type === type);
  assert.ok(onRoot('click'), 'click registered on timeline root');
  assert.ok(onRoot('input'), 'input registered on timeline root');
  assert.ok(onRoot('keydown'), 'keydown registered on timeline root');
  // inv-toggle-change is composer-specific and stays on composerWrap.
  assert.ok(
    h.registered.some((r) => r.el === h.composerWrap && r.type === 'inv-toggle-change'),
    'inv-toggle-change registered on composerWrap'
  );
  // B3: the Tools-chip popover delegation is the ONE composerWrap click
  // listener; interactive-panel clicks stay on the delegate root.
  const wrapClicks = h.registered.filter((r) => r.el === h.composerWrap && r.type === 'click');
  assert.equal(wrapClicks.length, 1, 'only the tools-chip delegation click is bound on composerWrap');
  wrapClicks[0].handler(fakeEvent({
    '[data-inv-chip="composer-tools"]': null,
    '[data-interactive-option]': { dataset: { batchId: 'qb_live', questionId: 'q1', optionId: 'optA' } },
  }));
  assert.equal(h.calls.length, 0, 'composerWrap click handler ignores interactive-panel targets');
});

test('interactive bindings: a click on an inline [data-interactive-option] dispatches handleInteractiveOptionSelect', () => {
  const h = makeHarness();
  const click = h.getHandler(h.root, 'click');
  click(fakeEvent({
    '[data-interactive-option]': { dataset: { batchId: 'qb_live', questionId: 'q1', optionId: 'optA' } },
  }));
  const optionCall = h.calls.find((c) => c[0] === 'option');
  assert.ok(optionCall, 'handleInteractiveOptionSelect fired');
  assert.deepEqual(optionCall[1], ['qb_live', 'q1', 'optA']);
});

test('interactive bindings: Enter confirms the other-input, but the IME composition guard blocks keyCode 229 / isComposing', () => {
  const h = makeHarness();
  const keydown = h.getHandler(h.root, 'keydown');
  const otherInput = { '[data-interactive-other-input]': { dataset: { batchId: 'qb_live', questionId: 'q1' } } };

  // IME commit keystroke (keyCode 229) must NOT confirm.
  keydown(fakeEvent(otherInput, { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 }));
  // IME composition in progress must NOT confirm.
  keydown(fakeEvent(otherInput, { key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 }));
  assert.equal(h.calls.filter((c) => c[0] === 'otherConfirm').length, 0, 'IME guard blocks confirm');

  // A real Enter confirms.
  keydown(fakeEvent(otherInput, { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }));
  const confirm = h.calls.find((c) => c[0] === 'otherConfirm');
  assert.ok(confirm, 'real Enter confirms the other-input');
  assert.deepEqual(confirm[1], ['qb_live', 'q1']);
});
