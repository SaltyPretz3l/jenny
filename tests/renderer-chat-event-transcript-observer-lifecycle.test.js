'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createTranscriptEventBindings,
} = require('../renderer/chat/renderer-chat-event-transcript-bindings');

function buildHarness(t) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="chatTimeline">'
      + '<div class="approval-gap-row" data-tool-call-id="call-1">'
      + '<div class="tool-approval-block" data-tool-call-id="call-1">'
      + '<button class="tool-approve-btn" data-tool-call-id="call-1">Allow</button>'
      + '<button class="tool-deny-btn" data-tool-call-id="call-1">Deny</button>'
      + '</div></div><div class="approval-gap-row" data-tool-call-id="call-2">'
      + '<button class="tool-approve-btn" data-tool-call-id="call-2">Allow</button>'
      + '</div></div><textarea id="chatInput"></textarea></body>'
  );
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  t.after(() => { globalThis.window = previousWindow; });

  const observers = [];
  class RecordingMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  dom.window.MutationObserver = RecordingMutationObserver;
  const rowTimeouts = [];
  dom.window.setTimeout = (callback) => {
    rowTimeouts.push(callback);
    return rowTimeouts.length;
  };
  dom.window.clearTimeout = () => {};
  dom.window.jennyShell = {
    tools: {
      approve: async () => true,
      deny: async () => true,
    },
    chat: { getActiveTurnState: async () => ({ active: true }) },
  };

  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const state = { currentSessionId: 'session-1' };
  const bindings = createTranscriptEventBindings({
    chatTimeline,
    state,
    appendClientLog() {},
    showComposerActionError() {},
    resolveToolCallId(target) {
      return target.closest('[data-tool-call-id]')?.getAttribute('data-tool-call-id') || '';
    },
    toggleToolDetails() {},
    getToolDetailsTransitionMs: () => 0,
    refreshRecoveredSession: async () => {},
    approvalReconcileSetTimeout: () => 1,
    approvalReconcileClearTimeout() {},
  });
  bindings.bindTranscriptEvents((element, eventName, handler, options) => {
    element?.addEventListener?.(eventName, handler, options);
  });
  return { bindings, chatTimeline, observers, rowTimeouts };
}

async function clickAllow(harness) {
  harness.chatTimeline.querySelector('[data-tool-call-id="call-1"] .tool-approve-btn').click();
  await Promise.resolve();
  await Promise.resolve();
}

test('an approval-row removal observer disconnects on its real timeout without DOM mutations', async (t) => {
  const harness = buildHarness(t);
  await clickAllow(harness);

  assert.equal(harness.rowTimeouts.length, 1, 'the row watcher owns an independent timeout');
  const rowObserver = harness.observers.at(-1);
  assert.equal(rowObserver.disconnected, false);
  harness.rowTimeouts[0]();
  assert.equal(rowObserver.disconnected, true);
  harness.bindings.dispose();
});

test('dispose disconnects every outstanding approval-row removal observer', async (t) => {
  const harness = buildHarness(t);
  await clickAllow(harness);
  const rowObserver = harness.observers.at(-1);

  harness.bindings.dispose();

  assert.equal(rowObserver.disconnected, true);
});
