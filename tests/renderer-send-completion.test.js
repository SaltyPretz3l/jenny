'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const COMPLETION_SOURCE = path.join(ROOT, 'renderer/chat/renderer-send-completion.js');
const SEND_UTILS_SOURCE = path.join(ROOT, 'renderer/chat/renderer-send-utils.js');

const { createSendCompletion } = require('../renderer/chat/renderer-send-completion');

test('send completion module is directly discoverable through CommonJS', () => {
  assert.equal(typeof createSendCompletion, 'function');

  const completion = createSendCompletion({
    state: {},
    navigationIntent: {},
    constants: {},
    callbacks: {},
    helpers: {},
  });

  assert.deepEqual(
    Object.keys(completion).sort(),
    ['completeAcceptedSend', 'completeFailedSend', 'finalizeSend']
  );
  assert.equal(typeof completion.completeAcceptedSend, 'function');
  assert.equal(typeof completion.completeFailedSend, 'function');
  assert.equal(typeof completion.finalizeSend, 'function');
});

test('send completion module publishes the same browser factory', () => {
  const browserContext = vm.createContext({});
  vm.runInContext(fs.readFileSync(COMPLETION_SOURCE, 'utf8'), browserContext, {
    filename: COMPLETION_SOURCE,
  });

  assert.equal(typeof browserContext.rendererSendCompletion?.createSendCompletion, 'function');
});

test('browser send utils fail clearly when completion has not loaded', () => {
  const fn = () => {};
  const flowHelpers = {
    adoptPersistedUserMessageId: fn,
    annotateUserSendFailureInStore: fn,
    buildDurableFailureMessage: fn,
    buildOptimisticAttachmentMetadata: fn,
    buildSendFailureMetadata: fn,
    clearQueuedSendInState: fn,
    cloneJsonLike: fn,
    cloneQueuedAttachments: fn,
    clipSessionTitle: fn,
    createOptimisticSessionId: fn,
    createSendQueueGuards: fn,
    createTraceToken: fn,
    getQueuedSendFromState: fn,
    getOrCreateSendOutbox: fn,
    reconcileAcceptedRegenerate: fn,
    rejectBusyPluginCommand: fn,
    resolveMessageCopyText: fn,
    stashQueuedSendInState: fn,
    summarizeDurableFailurePreview: fn,
  };
  const browserContext = vm.createContext({
    rendererSendFlowHelpers: flowHelpers,
    rendererSendMessageActions: { createSendMessageActions: fn },
    rendererNavigationIntent: { getOrCreateNavigationIntentOwner: fn },
    rendererSendOutboxDispatch: { createQueuedSendDispatcher: fn },
    rendererSendPreflightUtils: { createSendPreflightUtils: fn },
  });

  assert.throws(
    () => vm.runInContext(fs.readFileSync(SEND_UTILS_SOURCE, 'utf8'), browserContext, {
      filename: SEND_UTILS_SOURCE,
    }),
    /renderer-send-completion must load before renderer\/chat\/renderer-send-utils\.js/
  );
});
