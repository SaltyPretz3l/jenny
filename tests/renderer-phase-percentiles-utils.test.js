const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  PHASE_ORDER,
  buildPhaseTimingView,
  classifyBackendPhase,
  deriveVerdict,
  phaseLabel,
} = require('../renderer/shell/renderer-phase-percentiles-utils.js');

function tableOf(payload) {
  const view = buildPhaseTimingView(payload);
  return { view, doc: new JSDOM(view.markup).window.document };
}

test('the timing view lists only measured steps, in pipeline order, and counts them', () => {
  const { view, doc } = tableOf({
    phases: {
      completion_to_terminal_persist: { count: 4, p50: 10, p95: 20, p99: 30 },
      click_to_optimistic_render: { count: 5, p50: 1, p95: 2, p99: 3 },
      provider_request_start_to_first_chunk: { count: 0, p50: 9, p95: 9, p99: 9 },
      custom_step: { count: 2, p50: 7, p95: 8, p99: 9 },
    },
    targets: { click_to_optimistic_render: { p50: 5, p95: 10 } },
  });
  assert.deepEqual(Array.from(doc.querySelectorAll('tbody tr')).map((row) => row.cells[0].textContent),
    ['Click to optimistic render', 'Completion to terminal persist', 'Custom Step']);
  assert.equal(view.measured, 3);
  assert.equal(view.total, PHASE_ORDER.length + 1, 'the pipeline plus the extra step the payload names');
  assert.equal(view.chats, 5, 'the busiest step counts the chats');
});

test('nothing measured builds no table at all', () => {
  for (const payload of [null, undefined, {}, { phases: {}, targets: {} }, { phases: { click_to_optimistic_render: { count: 0 } } }]) {
    const view = buildPhaseTimingView(payload);
    assert.equal(view.markup, '');
    assert.equal(view.measured, 0);
    assert.equal(view.chats, 0);
  }
});

test('step labels follow the interface language and unknown steps are humanized', () => {
  assert.equal(phaseLabel('provider_request_start_to_first_chunk'), 'Provider start to first chunk');
  assert.equal(phaseLabel('some_new_step'), 'Some New Step');
});

test('the verdict compares both percentiles with the target and never guesses without one', () => {
  const target = { p50: 100, p95: 400 };
  assert.equal(deriveVerdict({ count: 1, p50: 100, p95: 400 }, target), 'pass');
  assert.equal(deriveVerdict({ count: 1, p50: 140, p95: 400 }, target), 'warn');
  assert.equal(deriveVerdict({ count: 1, p50: 100, p95: 700 }, target), 'fail');
  assert.equal(deriveVerdict({ count: 0, p50: 1, p95: 1 }, target), 'empty');
  assert.equal(deriveVerdict({ count: 1, p50: null, p95: null }, target), 'empty');
  assert.equal(deriveVerdict({ count: 1, p50: 1, p95: 1 }, {}), 'empty');
});

test('backend phases classify into the groups the Overview reasons about', () => {
  assert.equal(classifyBackendPhase('ready'), 'ready');
  assert.equal(classifyBackendPhase(' Initialized '), 'ready');
  assert.equal(classifyBackendPhase('model_loading'), 'loading');
  assert.equal(classifyBackendPhase('model_acquiring'), 'acquiring');
  assert.equal(classifyBackendPhase('model_unavailable'), 'model_unavailable');
  assert.equal(classifyBackendPhase('crashed'), 'unavailable');
  assert.equal(classifyBackendPhase('sidecar_spawned'), 'starting');
  assert.equal(classifyBackendPhase(undefined), 'unknown');
});
