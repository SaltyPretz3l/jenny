const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createStreamPhaseStateUtils,
} = require('../renderer/chat/renderer-stream-handler-phase-state');

function createHarness() {
  const utils = createStreamPhaseStateUtils({
    streamPhaseState: new Map(),
    state: {},
    normalizeId: (value) => String(value || '').trim(),
    normalizeString: (value) => String(value || '').trim(),
    normalizePhaseSummary: (value) => String(value || '').trim(),
    getSessionMessages: () => [],
    setSessionMessages: () => {},
  });
  return utils;
}

test('newer iterations restart completion while same-iteration updates remain sticky', () => {
  const { updateStreamPhaseState } = createHarness();
  const phase = {
    streamId: 'stream_1',
    phaseId: 'phase_1',
    phaseKind: 'reasoning',
    thinkingId: 'think_1',
  };

  updateStreamPhaseState({ ...phase, iteration: 1 }, true);
  let phases = updateStreamPhaseState({ ...phase, iteration: 2 }, false);
  assert.equal(phases[0].completed, false);

  updateStreamPhaseState({ ...phase, iteration: 2 }, true);
  phases = updateStreamPhaseState({ ...phase, iteration: 2 }, false);
  assert.equal(phases[0].completed, true);
});

test('a newer iteration drops the prior iteration summary until it supplies its own', () => {
  const { updateStreamPhaseState } = createHarness();
  const phase = {
    streamId: 'stream_1',
    phaseId: 'phase_1',
    phaseKind: 'reasoning',
    thinkingId: 'think_1',
  };

  updateStreamPhaseState({ ...phase, iteration: 1, summary: 'Investigated the bug' }, true);
  let phases = updateStreamPhaseState({ ...phase, iteration: 2 }, false);
  assert.equal(phases[0].summary, undefined);
  assert.equal(phases[0].completed, false);

  // Same-iteration updates keep the last summary sticky, as before.
  phases = updateStreamPhaseState({ ...phase, iteration: 2, summary: 'Applying the fix' }, false);
  assert.equal(phases[0].summary, 'Applying the fix');
  phases = updateStreamPhaseState({ ...phase, iteration: 2 }, true);
  assert.equal(phases[0].summary, 'Applying the fix');
});
