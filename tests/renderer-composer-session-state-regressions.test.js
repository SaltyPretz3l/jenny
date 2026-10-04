'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createComposerSessionState,
} = require('../renderer/chat/renderer-composer-session-state');

test('identity-duplicate attachment releases its distinct unretained managed asset', () => {
  const released = [];
  const state = {
    currentSessionId: 'session_b',
    composerSessionState: new Map([['session_a', {
      sessionId: 'session_a',
      attachments: [{ path: 'C:/x.txt', assetPath: 'asset-old' }],
      generation: 0,
      draftRevision: 0,
    }]]),
  };
  const controller = createComposerSessionState({
    state,
    releaseAssets: (paths) => released.push(...paths),
  });

  const result = controller.commitAttachmentResult(
    { sessionId: 'session_a', generation: 0 },
    { accepted: [{ path: 'C:/x.txt', assetPath: 'asset-new' }] },
  );

  assert.deepEqual(result, { target: 'origin', addedCount: 0, droppedForCapacity: 0 });
  assert.deepEqual(released, ['asset-new']);
  assert.deepEqual(state.composerSessionState.get('session_a').attachments, [
    { path: 'C:/x.txt', assetPath: 'asset-old' },
  ]);
});

test('rekey collision preserves target draft while merging and releasing source attachments', () => {
  const released = [];
  const targetAttachments = Array.from({ length: 7 }, (_, index) => ({
    path: `C:/target-${index}.txt`, assetPath: `asset-target-${index}`,
  }));
  const state = {
    currentSessionId: 'other',
    composerSessionState: new Map([
      ['local', {
        sessionId: 'local',
        text: 'source draft',
        selectionStart: 2,
        selectionEnd: 3,
        attachments: [
          { path: 'C:/source-kept.txt', assetPath: 'asset-source-kept' },
          { path: 'C:/source-dropped.txt', assetPath: 'asset-source-dropped' },
        ],
      }],
      ['real', {
        sessionId: 'real',
        text: 'target draft',
        selectionStart: 5,
        selectionEnd: 5,
        attachments: targetAttachments,
      }],
    ]),
  };
  const controller = createComposerSessionState({
    state,
    releaseAssets: (paths) => released.push(...paths),
  });

  assert.equal(controller.rekeySession('local', 'real'), true);

  const target = state.composerSessionState.get('real');
  assert.equal(state.composerSessionState.has('local'), false);
  assert.equal(target.text, 'target draft');
  assert.deepEqual([target.selectionStart, target.selectionEnd], [5, 5]);
  assert.equal(target.attachments.length, 8);
  assert.equal(target.attachments.at(-1).assetPath, 'asset-source-kept');
  assert.deepEqual(released, ['asset-source-dropped']);
});

// Split view W2-2b: the session-keyed queue helpers. The live queue
// (state.attachments.queued) belongs to the session pane 0's composer shows;
// with one pane that is currentSessionId, so pane 0 is today's path exactly.
function twoPaneState(focusedPaneId) {
  return {
    currentSessionId: focusedPaneId === 1 ? 'session_b' : 'session_a',
    panes: { panes: [{ paneId: 0, sessionId: 'session_a' }, { paneId: 1, sessionId: 'session_b' }], focusedPaneId, splitRatio: 0.5 },
    attachments: { queued: [{ id: 'a1', assetPath: 'asset-a1' }], dragDepth: 0 },
    sessions: [{ id: 'session_b', composer_draft: 'persisted b draft' }],
  };
}

test('W2-2b helpers alias the live queue for the current session (one pane) and never create its record', () => {
  const live = [{ id: 'x1', assetPath: 'asset-x1' }];
  const state = { currentSessionId: 'session_a', attachments: { queued: live, dragDepth: 0 } };
  const controller = createComposerSessionState({ state });

  assert.equal(controller.getQueuedAttachments('session_a'), live, 'the read IS the live array');
  assert.equal(controller.getQueuedAttachments(), live, 'no session id means the live queue');
  const next = [{ id: 'x2', assetPath: 'asset-x2' }];
  assert.equal(controller.setQueuedAttachments('session_a', next), next);
  assert.equal(state.attachments.queued, next, 'the write replaces the live array by reference');
  const appended = controller.appendQueuedAttachments('session_a', [{ id: 'x3', path: 'C:/x3.txt' }]);
  assert.equal(appended.addedCount, 1);
  assert.deepEqual(state.attachments.queued.map((entry) => entry.id), ['x2', 'x3']);
  assert.deepEqual(controller.removeQueuedAttachment('session_a', 'x2').map((entry) => entry.id), ['x2']);
  assert.deepEqual(state.attachments.queued.map((entry) => entry.id), ['x3']);
  assert.deepEqual(controller.clearQueuedAttachments('session_a').map((entry) => entry.id), ['x3']);
  assert.deepEqual(state.attachments.queued, []);
  assert.equal(state.composerSessionState instanceof Map ? state.composerSessionState.has('session_a') : false, false,
    'the live session\'s helpers never touch its record');
});

test('W2-2b helpers act on the record for any other session, leaving the live queue untouched', () => {
  const live = [{ id: 'a1', assetPath: 'asset-a1' }];
  const state = {
    currentSessionId: 'session_a',
    attachments: { queued: live, dragDepth: 0 },
    sessions: [{ id: 'session_b', composer_draft: 'persisted b draft' }],
  };
  const controller = createComposerSessionState({ state });

  assert.deepEqual(controller.getQueuedAttachments('session_b'), []);
  assert.equal(state.composerSessionState.has('session_b'), false, 'a read creates no record');
  controller.appendQueuedAttachments('session_b', [{ id: 'b1', assetPath: 'asset-b1' }]);
  const record = state.composerSessionState.get('session_b');
  assert.deepEqual(record.attachments.map((entry) => entry.id), ['b1']);
  assert.equal(record.text, 'persisted b draft', 'a created record keeps the persisted draft restore would have used');
  assert.equal(record.draftRevision, 1, 'a record write is a draft mutation');
  assert.equal(controller.getQueuedAttachments('session_b'), record.attachments);
  controller.removeQueuedAttachment('session_b', 'b1');
  assert.deepEqual(record.attachments, []);
  assert.equal(state.attachments.queued, live, 'the live queue keeps its identity');
  assert.deepEqual(live.map((entry) => entry.id), ['a1']);
});

test('W2-2b with two panes the live queue is pane 0\'s even while pane 1 is focused', () => {
  const state = twoPaneState(1);
  const live = state.attachments.queued;
  const controller = createComposerSessionState({ state, getChatInput: () => ({ value: 'pane zero text', selectionStart: 0, selectionEnd: 0 }) });

  assert.equal(controller.getQueueSessionId(), 'session_a');
  assert.equal(controller.getQueuedAttachments('session_a'), live);
  controller.appendQueuedAttachments('session_b', [{ id: 'b1', assetPath: 'asset-b1' }]);
  assert.equal(state.attachments.queued, live, 'pane 1\'s add left pane 0\'s queue identity alone');

  // A capture of pane 1's (focused) session no longer reads pane 0's DOM/queue.
  const record = controller.captureActive('session_b', 'send_receipt_begin');
  assert.deepEqual(record.attachments.map((entry) => entry.id), ['b1']);
  assert.equal(record.text, 'persisted b draft', 'pane 0\'s #chatInput text is not captured into pane 1\'s session');
  // A capture of pane 0's session still moves the live queue by reference.
  assert.equal(controller.captureActive('session_a', 'input').attachments, live);
});

test('W2-2b an attachment op for pane 1\'s session merges into pane 1\'s queue through mergeActive', () => {
  const state = twoPaneState(0);
  const live = state.attachments.queued;
  const controller = createComposerSessionState({ state });
  const token = controller.beginAttachmentOp('session_b');
  assert.equal(token.sessionId, 'session_b');
  const merged = [];
  const result = controller.commitAttachmentResult(token, { accepted: [{ id: 'b1' }] }, {
    mergeActive: (payload, sessionId) => merged.push([payload.accepted.length, sessionId]),
  });
  assert.deepEqual(result, { target: 'active' });
  assert.deepEqual(merged, [[1, 'session_b']], 'the merge is told whose queue it lands in');
  assert.equal(state.attachments.queued, live);
  // The default op (pane 0's bindings) is pane 0's session, not the focused one.
  state.currentSessionId = 'session_b';
  state.panes = { ...state.panes, focusedPaneId: 1 };
  assert.equal(controller.beginAttachmentOp().sessionId, 'session_a');
});

test('W2-2b capture/restore are unchanged with one pane (by-reference capture, restore writes the live queue)', () => {
  const live = [{ id: 'a1', assetPath: 'asset-a1' }];
  const input = { value: 'draft a', selectionStart: 7, selectionEnd: 7, setSelectionRange() {} };
  const state = { currentSessionId: 'session_a', attachments: { queued: live, dragDepth: 0 }, sessions: [] };
  const controller = createComposerSessionState({ state, getChatInput: () => input });
  const record = controller.captureActive('session_a', 'session_switch');
  assert.equal(record.attachments, live, 'captured by reference');
  state.currentSessionId = 'session_c';
  controller.restoreForSession('session_c');
  assert.deepEqual(state.attachments.queued, []);
  assert.equal(input.value, '');
  state.currentSessionId = 'session_a';
  controller.restoreForSession('session_a');
  assert.equal(state.attachments.queued, live, 'restore hands back the same array');
  assert.equal(input.value, 'draft a');
});
