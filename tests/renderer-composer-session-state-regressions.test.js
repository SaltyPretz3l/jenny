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
