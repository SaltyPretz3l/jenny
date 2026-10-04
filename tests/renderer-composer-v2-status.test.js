const test = require('node:test');
const assert = require('node:assert/strict');

const { createComposerV2StatusController } = require('../renderer/chat/renderer-composer-v2-status');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');

test('composer status delegates stream wrappers to the multi-stream controller', () => {
  const previousController = global.rendererMultiStreamController;
  const state = {
    currentSessionId: 'session-1',
    attachments: {},
    ui: {},
    pendingToolApprovals: new Map(),
    activeStreamId: '',
    activeStreamSessionId: '',
    sendPreflight: null,
  };
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });
  global.rendererMultiStreamController = multiStreamController;

  try {
    const controller = createComposerV2StatusController({
      state,
      callbacks: {
        appendClientLog() {},
        getRendererElapsedMs() { return 0; },
      },
    });

    multiStreamController.registerStream('session-1', 'stream-1');
    multiStreamController.registerStream('session-2', 'stream-2');
    multiStreamController.registerPreflight('session-1', { pending: true, sessionId: 'session-1', streamId: '' });

    assert.equal(controller.isSessionStreaming('session-1'), true);
    assert.equal(controller.isAnySendBusy(), true);
    assert.equal(controller.isSendBusy(), true);
    assert.deepEqual(controller.getStreamingSessionIds().sort(), ['session-1', 'session-2']);
  } finally {
    global.rendererMultiStreamController = previousController;
  }
});

test('composer status only treats the active session as busy while background sessions stream', () => {
  const previousController = global.rendererMultiStreamController;
  const state = {
    currentSessionId: 'session-1',
    attachments: {},
    ui: {},
    pendingToolApprovals: new Map(),
    activeStreamId: '',
    activeStreamSessionId: '',
    sendPreflight: null,
  };
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });
  global.rendererMultiStreamController = multiStreamController;

  try {
    const controller = createComposerV2StatusController({
      state,
      callbacks: {
        appendClientLog() {},
        getRendererElapsedMs() { return 0; },
      },
    });

    multiStreamController.registerStream('session-2', 'stream-2');
    multiStreamController.registerPreflight('session-2', {
      pending: true,
      sessionId: 'session-2',
      streamId: '',
    });

    assert.equal(controller.isSessionStreaming('session-1'), false);
    assert.equal(controller.isSessionStreaming('session-2'), true);
    assert.equal(controller.isSendBusy(), false);
    assert.equal(controller.isAnySendBusy(), true);
  } finally {
    global.rendererMultiStreamController = previousController;
  }
});

// Phase 10 Track A5 — syncLegacyBusySnapshots bridges the multiStreamController
// (authoritative) to the legacy state fields (state.activeStreamSessionId,
// state.activeStreamId, state.sendPreflight) that 9+ chat-side consumers still
// read. The bridge is private but is fired from each mutation site in the
// controller; if a future change adds a write-point without calling sync, the
// legacy fields silently desync. These tests pin the bridge invariant after
// each representative mutation so the regression is caught immediately.

function buildBridgeHarness() {
  const previousController = global.rendererMultiStreamController;
  const state = {
    currentSessionId: 'session-bridge-1',
    attachments: {},
    ui: {},
    pendingToolApprovals: new Map(),
    activeStreamId: '',
    activeStreamSessionId: '',
    sendPreflight: null,
  };
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });
  global.rendererMultiStreamController = multiStreamController;
  const controller = createComposerV2StatusController({
    state,
    callbacks: {
      appendClientLog() {},
      getRendererElapsedMs() { return 0; },
    },
  });
  return {
    state,
    controller,
    multiStreamController,
    restore() {
      global.rendererMultiStreamController = previousController;
    },
  };
}

function assertBridgeInvariant(state, multiStreamController, label) {
  const expectedActiveSessionId = multiStreamController.isSessionStreaming(state.currentSessionId)
    ? state.currentSessionId
    : String(multiStreamController.getStreamingSessionIds()[0] || '');
  const expectedActiveStreamId = expectedActiveSessionId
    ? String(multiStreamController.getStreamIdForSession(expectedActiveSessionId) || '')
    : '';
  const expectedPreflightSessionId = multiStreamController.getPreflight?.(state.currentSessionId)
    ? state.currentSessionId
    : String(multiStreamController.getPreflightSessionIds?.()[0] || '');
  const expectedPreflight = expectedPreflightSessionId
    ? (multiStreamController.getPreflight?.(expectedPreflightSessionId) || null)
    : null;
  assert.equal(
    state.activeStreamSessionId,
    expectedActiveSessionId,
    `${label}: state.activeStreamSessionId must mirror multiStreamController authority`
  );
  assert.equal(
    state.activeStreamId,
    expectedActiveStreamId,
    `${label}: state.activeStreamId must mirror multiStreamController authority`
  );
  assert.equal(
    state.sendPreflight,
    expectedPreflight,
    `${label}: state.sendPreflight must mirror multiStreamController authority`
  );
}

test('syncLegacyBusySnapshots bridge: read-only checks (isSessionStreaming etc.) also re-sync', (t) => {
  // The bridge is invoked from BOTH read and write paths so a stale
  // pre-sync value can never leak to consumers that only read.
  const harness = buildBridgeHarness();
  t.after(() => harness.restore());

  harness.multiStreamController.registerStream('session-bridge-1', 'stream-bridge-1');
  // Mutate state.activeStreamSessionId directly to simulate desync.
  harness.state.activeStreamSessionId = 'session-stale';
  harness.state.activeStreamId = 'stream-stale';
  // First read through the controller must re-sync.
  harness.controller.isSessionStreaming('session-bridge-1');
  assertBridgeInvariant(
    harness.state,
    harness.multiStreamController,
    'after isSessionStreaming on a registered stream'
  );
});

test('composer status preserves warning tone for paste and attachment notices', () => {
  const state = {
    currentSessionId: 'session-1',
    attachments: {},
    ui: {},
    pendingToolApprovals: new Map(),
    activeStreamId: '',
    activeStreamSessionId: '',
    sendPreflight: null,
  };
  const controller = createComposerV2StatusController({
    state,
    callbacks: {
      appendClientLog() {},
      getRendererElapsedMs() { return 0; },
    },
  });

  controller.setComposerStatusNotice('Large paste added.', { tone: 'warning' });

  assert.equal(state.ui.composerStatusNoticeTone, 'warning');
});

test('split view W3-1: a notice records the session it belongs to; unkeyed and cleared notices carry none', () => {
  const state = { currentSessionId: 'session-1', attachments: {}, ui: {}, pendingToolApprovals: new Map() };
  const controller = createComposerV2StatusController({
    state,
    callbacks: { appendClientLog() {}, getRendererElapsedMs() { return 0; } },
  });
  controller.setComposerStatusNotice('Large paste added.', { tone: 'warning', owner: 'composer:paste-size', sessionId: ' session-2 ' });
  assert.equal(state.ui.composerStatusNoticeSessionId, 'session-2');
  controller.setComposerStatusNotice('Compacting context…', { owner: 'compaction:session-1' });
  assert.equal(state.ui.composerStatusNoticeSessionId, '', 'a writer that names no session stays unkeyed (pane 0\'s)');
  controller.setComposerStatusNotice('Large paste added.', { owner: 'composer:paste-size', sessionId: 'session-2' });
  controller.clearComposerStatusNotice();
  assert.equal(state.ui.composerStatusNoticeSessionId, '');
});

test('split view W3-1: setting or dropping a keyed notice routes a composer sync to its session', () => {
  const synced = [];
  const state = { currentSessionId: 'session-1', attachments: {}, ui: {}, pendingToolApprovals: new Map() };
  const controller = createComposerV2StatusController({
    state,
    callbacks: { appendClientLog() {}, getRendererElapsedMs() { return 0; }, renderSessionComposer: (id) => synced.push(id) },
  });
  controller.setComposerStatusNotice('Paste is too large.', { owner: 'composer:paste-size', sessionId: 'session-2' });
  assert.deepEqual(synced, ['session-2'], 'the pane showing session-2 paints the notice now');
  controller.setComposerStatusNotice('Compacting context…', { owner: 'compaction:session-1' });
  assert.deepEqual(synced, ['session-2', 'session-2'], 'an unkeyed replacement clears it from that pane');
  controller.clearComposerStatusNotice();
  assert.deepEqual(synced, ['session-2', 'session-2'], 'nothing keyed, nothing routed');
  controller.setComposerStatusNotice('Paste is too large.', { owner: 'composer:paste-size', sessionId: 'session-2' });
  controller.clearComposerStatusNotice({ owner: 'composer:paste-size' });
  assert.deepEqual(synced, ['session-2', 'session-2', 'session-2', 'session-2']);
});
