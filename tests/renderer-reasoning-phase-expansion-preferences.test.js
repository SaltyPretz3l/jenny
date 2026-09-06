'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

delete global.rendererAppLifecyclePreferences;
require('../renderer/app/renderer-app-lifecycle-preferences');

const { createReasoningPhaseExpansionController } = global.rendererAppLifecyclePreferences;

function makeStorage(initialValue = '') {
  let value = initialValue;
  let writeCount = 0;
  return {
    getItem() { return value; },
    setItem(_key, nextValue) { value = String(nextValue || ''); writeCount += 1; },
    read() { return value; },
    writes() { return writeCount; },
  };
}

function makeController({ initialValue = '', thinkingController = null } = {}) {
  const storage = makeStorage(initialValue);
  const state = { ui: { reasoningPhaseExpansionBySession: new Map() } };
  const controller = createReasoningPhaseExpansionController({
    state,
    storage,
    storageKey: 'reasoning-expansion-test',
    getThinkingController: () => thinkingController,
  });
  return { controller, state, storage };
}

test('reasoning disclosure preferences load with bounded session and phase retention', () => {
  const payload = {};
  for (let sessionIndex = 0; sessionIndex < 130; sessionIndex += 1) {
    const phaseEntries = {};
    const entryCount = sessionIndex === 129 ? 520 : 2;
    for (let phaseIndex = 0; phaseIndex < entryCount; phaseIndex += 1) {
      phaseEntries[`message_${phaseIndex}::phase_${phaseIndex}`] = phaseIndex % 2 === 0;
    }
    payload[`session_${sessionIndex}`] = phaseEntries;
  }
  const { controller } = makeController({ initialValue: JSON.stringify(payload) });

  const loaded = controller.loadReasoningPhaseExpansionPreferences();

  assert.equal(loaded.size, 128, 'oldest excess sessions are evicted');
  assert.equal(loaded.has('session_0'), false);
  assert.equal(loaded.get('session_129').size, 512, 'oldest excess phase overrides are evicted');
  assert.equal(loaded.get('session_129').has('message_0::phase_0'), false);
  assert.equal(loaded.get('session_129').has('message_519::phase_519'), true);
});

test('setting disclosure preferences evicts the oldest per-session override', () => {
  const { controller, state } = makeController();

  for (let index = 0; index < 520; index += 1) {
    controller.setReasoningPhaseExpandedPreference(
      'session_live',
      `message_${index}`,
      `phase_${index}`,
      true,
      { defaultExpanded: false },
    );
  }

  const sessionStore = state.ui.reasoningPhaseExpansionBySession.get('session_live');
  assert.equal(sessionStore.size, 512);
  assert.equal(sessionStore.has('message_0::phase_0'), false);
  assert.equal(sessionStore.has('message_519::phase_519'), true);
});

test('batch disclosure preferences serialize once for hundreds of updates', () => {
  const { controller, state, storage } = makeController();
  const entries = Array.from({ length: 240 }, (_, index) => ({
    messageId: `message_${index}`,
    phaseKey: `phase_${index}`,
    expanded: true,
    defaultExpanded: false,
  }));

  assert.equal(controller.setReasoningPhaseExpandedPreferences('session_live', entries), entries.length);
  assert.equal(storage.writes(), 1);
  assert.equal(state.ui.reasoningPhaseExpansionBySession.get('session_live').size, entries.length);

  assert.equal(controller.setReasoningPhaseExpandedPreferences('session_live', entries.map((entry) => ({
    ...entry,
    expanded: false,
  }))), entries.length);
  assert.equal(storage.writes(), 2);
  assert.equal(state.ui.reasoningPhaseExpansionBySession.has('session_live'), false);
});

test('sync prunes disclosure preferences for messages no longer in the session', () => {
  const phaseExpansionState = new Map();
  const payload = {
    session_live: {
      'message_keep::phase_1': true,
      'message_gone::phase_2': false,
    },
  };
  const { controller, state, storage } = makeController({
    initialValue: JSON.stringify(payload),
    thinkingController: { phaseExpansionState },
  });
  state.ui.reasoningPhaseExpansionBySession = controller.loadReasoningPhaseExpansionPreferences();

  controller.syncPersistedReasoningPhaseExpansionState('session_live', [{ id: 'message_keep' }]);

  const sessionStore = state.ui.reasoningPhaseExpansionBySession.get('session_live');
  assert.deepEqual([...sessionStore.entries()], [['message_keep::phase_1', true]]);
  assert.deepEqual([...phaseExpansionState.entries()], [['message_keep::phase_1', true]]);
  assert.equal(storage.read().includes('message_gone'), false);
});
