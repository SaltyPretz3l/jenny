const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  bindApprovalBatchUx,
  createApprovalReconciliationController,
} = require('../renderer/chat/renderer-approval-batch-utils');

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function createApprovalDom() {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div id="timeline">'
      + '<article class="chat-thread-node" data-thread-message-id="turn-1">'
      + '<div class="chat-thread-children">'
      + '<div class="approval-gap-row" data-approval-status="pending" data-tool-call-id="call-1" data-approval-id="approval-stream-a-call-1"></div>'
      + '<div class="approval-gap-row" data-approval-status="pending" data-tool-call-id="call-2" data-approval-id="approval-stream-a-call-2"></div>'
      + '</div>'
      + '</article>'
      + '</div>'
      + '</body>',
    { pretendToBeVisual: true }
  );
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(callback, 0);
  dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
  return dom;
}

test('approval batch leaves rows pending when approve IPC returns false', async () => {
  const dom = createApprovalDom();
  const { window } = dom;
  const errors = [];
  const approvals = [];
  const controller = bindApprovalBatchUx({
    scopeRoot: window.document.getElementById('timeline'),
    document: window.document,
    callbacks: {
      async approveOne(callId) {
        approvals.push(callId);
        return false;
      },
      async denyOne() {
        throw new Error('unexpected deny');
      },
      onError(action, callId, error) {
        errors.push({ action, callId, message: String(error && error.message || error) });
      },
    },
  });

  controller.sync();
  await flush();
  const button = window.document.querySelector('[data-approval-batch-action="approve-all-once"]');
  assert.ok(button);
  button.click();
  await flush();

  assert.deepEqual(approvals, ['approval-stream-a-call-1', 'approval-stream-a-call-2']);
  assert.equal(window.document.querySelectorAll('[data-approval-resolved="true"]').length, 0);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /returned false/);
  controller.dispose();
});

test('approval batch resolves only successful rows when mixed batch results occur', async () => {
  const dom = createApprovalDom();
  const { window } = dom;
  const errors = [];
  const controller = bindApprovalBatchUx({
    scopeRoot: window.document.getElementById('timeline'),
    document: window.document,
    callbacks: {
      async approveOne(callId) {
        if (callId === 'approval-stream-a-call-2') {
          throw new Error('approval rejected by backend');
        }
        return true;
      },
      async denyOne() {
        throw new Error('unexpected deny');
      },
      onError(action, callId, error) {
        errors.push({ action, callId, message: String(error && error.message || error) });
      },
    },
  });

  controller.sync();
  await flush();
  window.document.querySelector('[data-approval-batch-action="approve-all"]').click();
  await flush();

  assert.equal(
    window.document.querySelector('[data-tool-call-id="call-1"]').getAttribute('data-approval-resolved'),
    'true'
  );
  assert.notEqual(
    window.document.querySelector('[data-tool-call-id="call-2"]').getAttribute('data-approval-resolved'),
    'true'
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].callId, 'approval-stream-a-call-2');
  controller.dispose();
});

test('replacement batch banners stay busy while slower rows are still in flight', async (t) => {
  const dom = createApprovalDom();
  const { window } = dom;
  const previousWindow = globalThis.window;
  const previousMutationObserver = globalThis.MutationObserver;
  globalThis.window = window;
  globalThis.MutationObserver = window.MutationObserver;
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.MutationObserver = previousMutationObserver;
  });
  const thirdRow = window.document.createElement('div');
  thirdRow.className = 'approval-gap-row';
  thirdRow.setAttribute('data-approval-status', 'pending');
  thirdRow.setAttribute('data-tool-call-id', 'call-3');
  thirdRow.setAttribute('data-approval-id', 'approval-stream-a-call-3');
  window.document.querySelector('.chat-thread-children').appendChild(thirdRow);
  const calls = [];
  const never = new Promise(() => {});
  const controller = bindApprovalBatchUx({
    scopeRoot: window.document.getElementById('timeline'),
    document: window.document,
    callbacks: {
      approveOne(callId) {
        calls.push(callId);
        return callId === 'approval-stream-a-call-1' ? Promise.resolve(true) : never;
      },
      async denyOne() { return true; },
    },
  });

  await flush();
  window.document.querySelector('[data-approval-batch-action="approve-all"]').click();
  await flush();

  const replacementBanner = window.document.querySelector('.approval-batch-banner');
  assert.equal(replacementBanner.getAttribute('data-pending-count'), '2');
  assert.equal(replacementBanner.getAttribute('data-approval-batch-busy'), 'true');
  assert.equal(
    replacementBanner.querySelector('[data-approval-batch-action="approve-all"]').disabled,
    true
  );
  replacementBanner.querySelector('[data-approval-batch-action="approve-all"]').click();
  await Promise.resolve();
  assert.deepEqual(calls, [
    'approval-stream-a-call-1',
    'approval-stream-a-call-2',
    'approval-stream-a-call-3',
  ]);
  controller.dispose();
});

test('approval batch sync keeps an unchanged banner node in place', async () => {
  const dom = createApprovalDom();
  const { window } = dom;
  const controller = bindApprovalBatchUx({
    scopeRoot: window.document.getElementById('timeline'),
    document: window.document,
    callbacks: {
      async approveOne() { return true; },
      async denyOne() { return true; },
    },
  });

  controller.sync();
  await flush();
  const firstBanner = window.document.querySelector('.approval-batch-banner');
  assert.ok(firstBanner);
  assert.equal(firstBanner.getAttribute('data-pending-count'), '2');

  controller.sync();
  await flush();

  assert.equal(window.document.querySelector('.approval-batch-banner'), firstBanner);
  controller.dispose();
});

test('UIUX-045: dispose() before the initial scheduled sync frame runs cancels it (no post-dispose DOM mutation)', async () => {
  // bindApprovalBatchUx schedules a sync frame synchronously at bind time
  // (line: scheduleSync() right before the return). Disposing before that
  // frame fires used to leave the scheduled rAF/setTimeout in flight --
  // dispose() only tore down the click listener and MutationObserver, so
  // the stale frameTick still ran afterwards and mutated scopeRoot
  // (appended an approval-batch-banner) even though the controller was
  // already disposed.
  const dom = createApprovalDom();
  const { window } = dom;
  const controller = bindApprovalBatchUx({
    scopeRoot: window.document.getElementById('timeline'),
    document: window.document,
    callbacks: {
      async approveOne() { return true; },
      async denyOne() { return true; },
    },
  });

  controller.dispose();
  await flush();

  assert.equal(
    window.document.querySelector('.approval-batch-banner'),
    null,
    'no banner should be created by a sync frame that fires after dispose()'
  );
});

test('UIUX-045: dispose() after sync() has scheduled but not yet run also cancels the frame', async () => {
  const dom = createApprovalDom();
  const { window } = dom;
  const controller = bindApprovalBatchUx({
    scopeRoot: window.document.getElementById('timeline'),
    document: window.document,
    callbacks: {
      async approveOne() { return true; },
      async denyOne() { return true; },
    },
  });
  await flush();
  // Drain the initial bind-time scheduleSync() so the banner from a clean
  // sync exists, then remove a row via direct DOM mutation (simulating a
  // resolve) and immediately dispose before the MutationObserver's
  // rescheduled frame can run.
  window.document.querySelector('.approval-gap-row').remove();
  controller.dispose();
  const bannerAfterDispose = window.document.querySelector('.approval-batch-banner');
  await flush();

  assert.equal(
    window.document.querySelector('.approval-batch-banner'),
    bannerAfterDispose,
    'a sync scheduled just before dispose() must not mutate the banner afterwards'
  );
});

test('approval reconciliation rehydrates authoritative state and releases a still-pending row', async () => {
  const dom = createApprovalDom();
  const row = dom.window.document.querySelector('.approval-gap-row');
  let scheduled;
  let rehydrated = 0;
  let busy = true;
  const controller = createApprovalReconciliationController({
    scopeRoot: dom.window.document.getElementById('timeline'),
    getCurrentSessionId: () => 'session-1',
    getActiveTurnState: async () => ({ pending_approval: { approval_id: 'approval-stream-a-call-1' } }),
    rehydrateSession: async () => { rehydrated += 1; },
    setBlockBusy: (_block, value) => { busy = value; },
    setTimeoutFn: (callback) => { scheduled = callback; return 1; },
    clearTimeoutFn: () => {},
  });
  controller.start({ sessionId: 'session-1', reference: 'approval-stream-a-call-1', row, block: row });
  await scheduled();
  assert.equal(rehydrated, 1);
  assert.equal(busy, false);
  assert.equal(row.getAttribute('data-approval-reconciliation'), 'pending');
  controller.dispose();
});

test('approval reconciliation keeps a missing backend recoverable as unknown', async () => {
  const dom = createApprovalDom();
  const row = dom.window.document.querySelector('.approval-gap-row');
  let scheduled;
  let busy = true;
  const logs = [];
  const controller = createApprovalReconciliationController({
    scopeRoot: dom.window.document.getElementById('timeline'),
    getCurrentSessionId: () => 'session-1',
    getActiveTurnState: async () => { throw new Error('backend unavailable'); },
    rehydrateSession: async () => { throw new Error('session unavailable'); },
    setBlockBusy: (_block, value) => { busy = value; },
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
    setTimeoutFn: (callback) => { scheduled = callback; return 1; },
    clearTimeoutFn: () => {},
  });
  controller.start({ sessionId: 'session-1', reference: 'approval-stream-a-call-1', row, block: row });
  await scheduled();
  assert.equal(busy, false);
  assert.equal(row.getAttribute('data-approval-reconciliation'), 'unknown');
  assert.ok(logs.some((entry) => entry.event === 'approval.reconcile_recoverable'));
  controller.dispose();
});

test('approval reconciliation keeps full same-stream approval identities distinct', async () => {
  const dom = createApprovalDom();
  const rows = [...dom.window.document.querySelectorAll('.approval-gap-row')];
  const sessionId = 'sess_1754755200000_123456789abc';
  const streamId = 'stream_12345678-1234-1234-1234-123456789abc';
  const references = ['call-a', 'call-b'].map((callId) => (
    ['approval', sessionId, streamId, callId].join('_')
  ));
  const callbacks = [];
  const cleared = [];
  const controller = createApprovalReconciliationController({
    scopeRoot: dom.window.document.getElementById('timeline'),
    getCurrentSessionId: () => sessionId,
    getActiveTurnState: async () => ({ pending_approval: { approval_id: references[1] } }),
    rehydrateSession: async () => {},
    setBlockBusy: () => {},
    setTimeoutFn: (callback) => { callbacks.push(callback); return callbacks.length; },
    clearTimeoutFn: (id) => cleared.push(id),
  });
  controller.start({ sessionId, reference: references[0], row: rows[0], block: rows[0] });
  controller.start({ sessionId, reference: references[1], row: rows[1], block: rows[1] });

  assert.deepEqual(cleared, [], 'second approval must not cancel the first watchdog');
  await callbacks[0]();
  assert.equal(rows[0].getAttribute('data-approval-reconciliation'), 'unknown');
  assert.equal(rows[1].getAttribute('data-approval-reconciliation'), 'waiting');
  controller.dispose();
});

test('approval reconciliation clears bounded work on settlement, session switch, and disposal', async () => {
  const dom = createApprovalDom();
  const timeline = dom.window.document.getElementById('timeline');
  const callbacks = [];
  const cleared = [];
  let currentSessionId = 'session-1';
  const controller = createApprovalReconciliationController({
    scopeRoot: timeline,
    getCurrentSessionId: () => currentSessionId,
    setBlockBusy: () => {},
    setTimeoutFn: (callback) => { callbacks.push(callback); return callbacks.length; },
    clearTimeoutFn: (id) => cleared.push(id),
  });
  const rows = [...dom.window.document.querySelectorAll('.approval-gap-row')];
  controller.start({ sessionId: 'session-1', reference: 'approval-1', row: rows[0], block: rows[0] });
  rows[0].remove();
  await flush();
  assert.ok(cleared.includes(1), 'terminal row removal clears its timer');

  controller.start({ sessionId: 'session-1', reference: 'approval-2', row: rows[1], block: rows[1] });
  currentSessionId = 'session-2';
  await callbacks[1]();
  assert.ok(cleared.includes(2), 'session switch clears its timer');

  currentSessionId = 'session-1';
  controller.start({ sessionId: 'session-1', reference: 'approval-3', row: rows[1], block: rows[1] });
  controller.dispose();
  assert.ok(cleared.includes(3), 'disposal clears its timer');
});
