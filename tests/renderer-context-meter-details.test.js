'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const details = require('../renderer/chat/renderer-context-meter-details');

test('ring click dismisses tooltip state before opening the details popover', (t) => {
  const dom = new JSDOM('<div id="wrap"><button data-inv-chip="composer-context-ring"></button>'
    + '<div id="composerContextDetailsPopover" hidden></div></div>');
  const calls = [];
  global.inventory = {
    tooltip: {
      unpin() { calls.push('unpin'); },
      hide() { calls.push('hide'); },
    },
    popover: {
      toggle(popover) {
        calls.push('toggle');
        popover.hidden = false;
      },
    },
  };
  t.after(() => {
    details.dispose();
    delete global.inventory;
  });

  const ring = dom.window.document.querySelector('[data-inv-chip="composer-context-ring"]');
  assert.equal(details.handleClick({
    event: { target: ring },
    composerWrap: dom.window.document.getElementById('wrap'),
    state: { currentSessionId: 'session-1' },
  }), true);
  assert.deepEqual(calls, ['unpin', 'hide', 'toggle']);
});

test('short viewports place the popover above the trigger with a scrollable height', () => {
  const layout = details.computePopoverLayout(
    { top: 240, bottom: 272, right: 788 },
    { width: 320, height: 360 },
    { left: 0, top: 0, width: 800, height: 300 },
  );

  assert.deepEqual(layout, {
    left: 468,
    top: 12,
    maxHeight: 220,
    placeAbove: true,
  });
});

test('positionPopover applies viewport-clamped coordinates and internal scrolling', (t) => {
  const dom = new JSDOM('<div id="slot"><button id="ring"></button><div id="popover"></div></div>', {
    pretendToBeVisual: true,
  });
  const document = dom.window.document;
  const slot = document.getElementById('slot');
  const ring = document.getElementById('ring');
  const popover = document.getElementById('popover');
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 300 });
  Object.defineProperty(popover, 'offsetParent', { configurable: true, value: slot });
  slot.getBoundingClientRect = () => ({ left: 400, top: 200 });
  ring.getBoundingClientRect = () => ({ top: 240, bottom: 272, right: 788 });
  popover.getBoundingClientRect = () => ({ width: 320, height: 360 });
  t.after(() => details.dispose());

  assert.equal(details.positionPopover(popover, ring), true);
  assert.equal(popover.style.left, '68px');
  assert.equal(popover.style.top, '-188px');
  assert.equal(popover.style.maxHeight, '220px');
  assert.equal(popover.style.overflowY, 'auto');

  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 600 });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  assert.equal(popover.style.top, '80px', 'resize flips below when that side has more room');
  assert.equal(popover.style.maxHeight, '308px');

  details.dispose();
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 200 });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  assert.equal(popover.style.top, '80px', 'dispose removes viewport repositioning');
});

test('next-turn detail copy distinguishes estimate and discloses narrowing', () => {
  const copy = details.formatSummary({
    status: 'estimated', history_scope: 'recent', history_message_count: 12,
    available_history_message_count: 30, automatic_narrowing: true,
    compaction_snapshot_present: true,
    context_categories: { personality: true, approved_memory: true, attachments: 2 },
  });
  assert.match(copy, /^Last 6 turns:/);
  assert.match(copy, /Automatic narrowing will omit 18 older message/);
  assert.match(copy, /bounded compacted snapshot/);
  assert.doesNotMatch(copy, /tool output/i);
});

test('malformed summary fails closed without rendering supplied content', () => {
  assert.equal(details.formatSummary({ status: 'bad', content: 'poison' }), 'Next-turn estimate is unavailable.');
  assert.doesNotMatch(details.formatSummary({
    status: 'estimated', history_scope: 'session', history_message_count: 'NaN',
    available_history_message_count: Infinity, automatic_narrowing: true,
  }), /NaN|Infinity/);
});

test('preview passes only bounded live draft metadata to canonical request shaping', async (t) => {
  const dom = new JSDOM('<div id="popover"><p data-next-turn-context-summary></p></div>');
  const calls = [];
  global.jennyShell = { chat: { async getNextTurnContextSummary(...args) {
    calls.push(args);
    return {
      status: 'estimated', history_scope: 'session', history_message_count: 2,
      available_history_message_count: 2, automatic_narrowing: false,
      context_categories: { attachments: 64, active_file: true, mentions: true },
    };
  } } };
  global.rendererIdeActiveFileContext = { isArmed: () => true };
  global.rendererIdeMentionAutocomplete = { collectMentionPaths: () => ['src/app.js'] };
  t.after(() => {
    delete global.jennyShell;
    delete global.rendererIdeActiveFileContext;
    delete global.rendererIdeMentionAutocomplete;
  });
  const state = { currentSessionId: 'session-1', attachments: { queued: Array(80).fill({}) } };
  await details.loadPreview(dom.window.document.getElementById('popover'), state);
  assert.deepEqual(calls[0], ['session-1', {
    attachment_count: 64, has_active_file: true, has_mentions: true,
  }]);
  assert.match(dom.window.document.querySelector('[data-next-turn-context-summary]').textContent,
    /64 attachment/i);
  assert.equal(dom.window.document.querySelector('[data-next-turn-context-summary]')
    .hasAttribute('data-context-preview-pending'), false);
});

test('rejected preview cannot overwrite a newly active session', async (t) => {
  const dom = new JSDOM('<div id="popover"><p data-next-turn-context-summary></p></div>');
  let rejectRequest;
  global.jennyShell = {
    chat: {
      getNextTurnContextSummary: () => new Promise((_resolve, reject) => { rejectRequest = reject; }),
    },
  };
  t.after(() => {
    details.dispose();
    delete global.jennyShell;
  });
  const state = { currentSessionId: 'session-1', attachments: { queued: [] } };
  const output = dom.window.document.querySelector('[data-next-turn-context-summary]');
  const pending = details.loadPreview(dom.window.document.getElementById('popover'), state);
  state.currentSessionId = 'session-2';
  output.textContent = 'session-2 preview';
  output.dataset.contextPreviewPending = 'session-2';

  rejectRequest(new Error('session-1 failed'));
  await pending;

  assert.equal(output.textContent, 'session-2 preview');
  assert.equal(output.dataset.contextPreviewPending, 'session-2');
});

test('dispose fences a delayed preview result', async (t) => {
  const dom = new JSDOM('<div id="popover"><p data-next-turn-context-summary></p></div>');
  let release;
  global.jennyShell = { chat: { getNextTurnContextSummary: () => new Promise((resolve) => { release = resolve; }) } };
  t.after(() => { delete global.jennyShell; });
  const output = dom.window.document.querySelector('[data-next-turn-context-summary]');
  const promise = details.loadPreview(dom.window.document.getElementById('popover'), {
    currentSessionId: 'session-1', attachments: { queued: [] },
  });
  assert.equal(output.dataset.contextPreviewPending, 'true');
  details.dispose();
  release({
    status: 'estimated', history_scope: 'session', history_message_count: 99,
    available_history_message_count: 99, context_categories: {},
  });
  await promise;
  assert.equal(output.textContent, 'Calculating from the canonical session…');
});
