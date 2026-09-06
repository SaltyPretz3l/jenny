// Full-render attribution pin (chat timeline flicker RCA, 2026-08-26).
//
// The 2026-08-26 owner run charged 32 of 46 full renders to
// `cannot_patch:no_streaming_message`, which reads as "the stream-reveal patch
// path was blocked" and sent the read hunting a bug in a resolver that had
// never run. It is not a patch failure. `describePatchBlock` returns
// `no_streaming_message` as its FIRST guard, before it looks at the timeline,
// the session, the signature or the marker -- so the string means only "no
// message currently has status 'streaming'", i.e. nothing was live to patch.
//
// Same defect class as the `row_count_sanity` false positive: a diagnostic
// comparing two populations that do not correspond, then reporting the
// mismatch in the vocabulary of a real fault.
//
// These pin the attribution, and that the replacement names WHY the tail is
// not live from a BOUNDED set -- `full_render_reasons` is a histogram keyed by
// this string and must never grow with transcript size.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRenderLadder } = require('../renderer/chat/renderer-render-pipeline-render-ladder.js');

// Mirrors production: describePatchBlock checks `!streamingMessage` first and
// returns before consulting anything else, so a caller-supplied block string is
// the honest stand-in for that probe's output.
function buildLadder({ patchBlock = '', messages = [], gates = {} } = {}) {
  return createRenderLadder({
    state: { currentSessionId: 'session-ladder' },
    uiRuntime: {},
    appendClientLog: () => {},
    timelineVisibilityTracker: null,
    recordTurnArticleRolloutSignal: () => {},
    describeDomWrite: null,
    describeStreamRevealPatchBlock: () => patchBlock,
    forceFullRender: gates.forceFullRender === true,
    projectionRevisionChanged: gates.projectionRevisionChanged === true,
    recapExpansionChanged: gates.recapExpansionChanged === true,
    threadExpansionChanged: gates.threadExpansionChanged === true,
    messages,
    latestAssistantMessageId: '',
    structureSignature: 0,
    derived: { streamingMessage: null },
    renderReason: 'stream_delta',
  });
}

const assistant = (status, kind = '') => ({ id: 'a1', role: 'assistant', status, kind });

test('a render with nothing streaming is not charged as a blocked patch path', () => {
  const ladder = buildLadder({
    patchBlock: 'no_streaming_message',
    messages: [{ id: 'u1', role: 'user' }, assistant('complete')],
  });

  const reason = ladder.resolveFullRenderReason('final_full_render');

  assert.ok(
    !reason.startsWith('cannot_patch:'),
    `nothing was streaming, so no patch path was blocked -- got ${reason}`
  );
  assert.equal(reason, 'no_live_stream:tail_settled');
});

test('a settled assistant tail is named as settled, not as a missing message', () => {
  const ladder = buildLadder({
    patchBlock: 'no_streaming_message',
    messages: [{ id: 'u1', role: 'user' }, assistant('complete')],
  });

  assert.equal(ladder.resolveFullRenderReason('final_full_render'), 'no_live_stream:tail_settled');
});

test('a transcript with no assistant row yet is distinguishable from a settled one', () => {
  const ladder = buildLadder({
    patchBlock: 'no_streaming_message',
    messages: [{ id: 'u1', role: 'user' }],
  });

  assert.equal(ladder.resolveFullRenderReason('final_full_render'), 'no_live_stream:no_assistant');
});

test('a streaming tail the derived state rejected is named as an eligibility miss', () => {
  // This is the case worth catching: a message IS streaming, but
  // computeDerivedMessageState refused it (ineligible kind, or a newer
  // stream-target row won). Charging it the same as "no assistant yet" would
  // hide a real row-identity bug inside a benign-looking bucket.
  const ladder = buildLadder({
    patchBlock: 'no_streaming_message',
    messages: [{ id: 'u1', role: 'user' }, assistant('streaming', 'question_batch')],
  });

  assert.equal(ladder.resolveFullRenderReason('final_full_render'), 'no_live_stream:tail_not_eligible');
});

test('an errored tail keeps its own bucket', () => {
  const ladder = buildLadder({
    patchBlock: 'no_streaming_message',
    messages: [{ id: 'u1', role: 'user' }, assistant('error')],
  });

  assert.equal(ladder.resolveFullRenderReason('final_full_render'), 'no_live_stream:tail_error');
});

test('a genuinely blocked patch path still reports cannot_patch unchanged', () => {
  for (const block of ['no_timeline', 'session_mismatch', 'signature_mismatch', 'streaming_id_mismatch']) {
    const ladder = buildLadder({
      patchBlock: block,
      messages: [{ id: 'u1', role: 'user' }, assistant('streaming')],
    });
    assert.equal(ladder.resolveFullRenderReason('final_full_render'), 'cannot_patch:' + block);
  }
});

test('the earlier ladder gates still win over the stream-liveness classification', () => {
  const gates = [
    ['forceFullRender', 'force'],
    ['projectionRevisionChanged', 'projection_revision'],
    ['recapExpansionChanged', 'recap_expansion'],
    ['threadExpansionChanged', 'thread_expansion'],
  ];
  for (const [gate, expected] of gates) {
    const ladder = buildLadder({
      patchBlock: 'no_streaming_message',
      messages: [{ id: 'u1', role: 'user' }],
      gates: { [gate]: true },
    });
    assert.equal(ladder.resolveFullRenderReason('final_full_render'), expected);
  }
});

test('the reason vocabulary stays bounded and carries no transcript content', () => {
  const permitted = new Set([
    'no_live_stream:no_assistant',
    'no_live_stream:tail_settled',
    'no_live_stream:tail_error',
    'no_live_stream:tail_not_eligible',
  ]);
  // A histogram key that can absorb message text or ids would grow without
  // bound in client_timing, which is exactly what the bounded-vocabulary
  // comment on fullRenderReasons forbids.
  const statuses = ['', 'complete', 'streaming', 'error', 'cancelled'];
  const seen = new Set();
  for (const status of statuses) {
    const ladder = buildLadder({
      patchBlock: 'no_streaming_message',
      messages: [{ id: 'secret-id', role: 'assistant', status, content: 'SECRET TEXT' }],
    });
    const reason = ladder.resolveFullRenderReason('final_full_render');
    seen.add(reason);
    assert.ok(permitted.has(reason), `unbounded reason ${reason}`);
    assert.ok(!reason.includes('SECRET'), 'reason leaked message content');
    assert.ok(!reason.includes('secret-id'), 'reason leaked a message id');
  }
  assert.ok(seen.size >= 3, `expected the buckets to discriminate, saw ${[...seen].join(', ')}`);
});
