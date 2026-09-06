'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('dismissed-memory sessions evict oldest use and rekey merges keep the fingerprint cap', (t) => {
  const actionPath = require.resolve('../renderer/features/renderer-memory-actions-utils');
  const managerPath = require.resolve('../renderer/features/renderer-memory-utils');
  const originalAction = require.cache[actionPath];
  const originalManager = require.cache[managerPath];
  let helpers;
  require.cache[actionPath] = {
    id: actionPath,
    filename: actionPath,
    loaded: true,
    exports: {
      createMemoryActionController(options) {
        helpers = options.helpers;
        return {};
      },
    },
  };
  delete require.cache[managerPath];
  t.after(() => {
    if (originalAction) require.cache[actionPath] = originalAction;
    else delete require.cache[actionPath];
    if (originalManager) require.cache[managerPath] = originalManager;
    else delete require.cache[managerPath];
  });

  const { createMemoryManager } = require(managerPath);
  const manager = createMemoryManager({
    state: {
      ui: {}, backend: {},
      memoryManager: { memories: [], draftsById: new Map(), pendingCandidates: [] },
    },
    registerCleanup() {},
  });

  for (let index = 0; index < 200; index += 1) {
    helpers.rememberDismissedMemoryFingerprint(`session-${index}`, `fingerprint-${index}`);
  }
  assert.ok(helpers.getDismissedMemoryFingerprints('session-0'), 'reading a session refreshes its recency');
  helpers.rememberDismissedMemoryFingerprint('session-200', 'fingerprint-200');
  assert.ok(helpers.getDismissedMemoryFingerprints('session-0'), 'the recently used oldest session is retained');
  assert.equal(helpers.getDismissedMemoryFingerprints('session-1'), null, 'the oldest unused session is evicted');

  manager.resetMemorySuggestionState();
  for (let index = 0; index < 32; index += 1) {
    helpers.rememberDismissedMemoryFingerprint('target', `target-${index}`);
    helpers.rememberDismissedMemoryFingerprint('source', `source-${index}`);
  }
  manager.rekeyDismissedMemorySession('source', 'target');
  const merged = helpers.getDismissedMemoryFingerprints('target');
  assert.equal(merged.size, 32, 'rekey preserves the per-session fingerprint cap');
  assert.equal(merged.has('source-31'), true, 'the newest merged fingerprint is retained');
  assert.equal(merged.has('target-0'), false, 'the oldest merged fingerprint is evicted');
});
