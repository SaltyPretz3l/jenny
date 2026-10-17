'use strict';

/* Row 59 linked chats: the direct chat start (edits, failure retries and hosts without the runtime)
 * honors the same first-turn fence as runtime submission: a child created but not yet admitted
 * starts no other turn. */

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { BackendService } = require('../services/backend/backend-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.after(cleanupTrackedResources);

test('a direct chat start in a linked child waiting for its first turn is refused before it starts', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linked-fence-'));
  trackDirectory(userDataPath);
  const service = new BackendService({ userDataPath, safeStorage: createFakeSafeStorage(), defaultModel: 'mock-v1' });
  const asked = [];
  service.chatProposals = { linkedFirstTurnBlock: (sessionId, key) => {
    asked.push([sessionId, key]);
    return sessionId === 'sess_child' ? 'linked_first_turn_pending' : null;
  } };
  let started = 0;
  service._resolveModel = async () => { started += 1; throw new Error('not reached'); };
  await assert.rejects(service.startChatStream({ sessionId: 'sess_child', prompt: 'hello' }),
    (error) => error.code === 'linked_first_turn_pending');
  await assert.rejects(service.editAndRegenerate({ sessionId: 'sess_child', editedMessageId: 'msg_1', prompt: 'hello' }),
    (error) => error.code === 'linked_first_turn_pending');
  assert.deepEqual(asked, [['sess_child', null], ['sess_child', null]], 'a direct start never carries a first-turn key');
  assert.equal(started, 0, 'nothing started');
});
