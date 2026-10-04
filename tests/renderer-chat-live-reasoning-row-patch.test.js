'use strict';

// HB-010 (dogfood 2026-09-28): after a long row-model turn's tool batches, every
// reasoning delta of the live segment took the keyed-morph fallback and rebuilt
// the whole turn article markup (11 fps, 29 long tasks in 5 s on a 65-row turn).
// The live segment message carries every reasoning phase of the stream, so the
// message-level stack the patch compared against never lined up with the
// one-phase live row. This replays the real wire (the shape
// renderer-plan-decision-live-timeline.test.js uses) through the real renderer
// and pins the contract: a reasoning-only delta writes no turn-scope DOM (no
// timeline_dom_write on any lane) and paints the live row in place.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');

const SESSION_ID = 'sess_hb010_live_reasoning';
const STREAM_ID = 'stream_hb010_live_reasoning';
const PRIOR_ITERATIONS = 10;

function reasoningPhase(iteration) {
  return {
    phase_id: `phase_reasoning_${STREAM_ID}_iter${iteration}_1`,
    phase_kind: 'reasoning',
    thinking_id: `think_${STREAM_ID}_iter${iteration}`,
    iteration,
    summary: 'Reasoning through the turn',
  };
}

function reasoningPhaseEvent(type, iteration) {
  const phase = reasoningPhase(iteration);
  return {
    type, phaseId: phase.phase_id, phaseKind: 'reasoning', thinkingId: phase.thinking_id, iteration,
    summary: phase.summary, phase,
  };
}

// Entries carry no thinking id, as the llama-server (Bonsai) wire persisted
// them: the message-level widget then groups them apart from their phase.
function reasoningDelta(iteration, text) {
  const phase = reasoningPhase(iteration);
  return {
    type: 'delta', content: '', channel: 'reasoning', thinkingId: phase.thinking_id, phase,
    reasoning: { source: 'provider', entriesDelta: [{ id: `reasoning_${iteration}`, text }] },
  };
}

// The real wire for a tool batch: 'pending' per call, then per call a tool_use
// phase, 'running' naming the next segment, and the result with its phase.
function toolBatch(iteration) {
  const calls = [`call_${iteration}_a`, `call_${iteration}_b`];
  const out = calls.map((callId) => ({ type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: callId }, status: 'pending' }));
  for (const callId of calls) {
    const usePhase = { type: 'phase_started', phaseId: `phase_tool_use_${STREAM_ID}_${callId}`, phaseKind: 'tool_use', toolCallId: callId, toolName: 'read_file' };
    const resultPhase = { type: 'phase_started', phaseId: `phase_tool_result_${STREAM_ID}_${callId}`, phaseKind: 'tool_result', toolCallId: callId, toolName: 'read_file' };
    out.push(
      usePhase,
      { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: callId }, status: 'running',
        next_assistant_message_id: `assistant_${STREAM_ID}_seg${iteration}` },
      { ...usePhase, type: 'phase_completed' },
      resultPhase,
      { type: 'tool_result', callId, toolName: 'read_file', status: 'success', content: `contents of ${callId}`, isError: false },
      { ...resultPhase, type: 'phase_completed' },
    );
  }
  return out;
}

function timelineDomWrites(window) {
  const meta = window.__rendererState.ui.chatTimelineRowModelMetaBySession?.get(SESSION_ID);
  return Number(meta?.telemetry_counters?.timeline_dom_write || 0);
}

test('HB-010: reasoning deltas on a long row-model turn patch the live row without any turn-scope write', async (t) => {
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: { ...buildFeatureFlagDefaults(), chat_timeline_render_telemetry: true } } },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: SESSION_ID, title: 'HB-010', conversation_mode: 'chat', preferred_model: 'gpt-test',
          updated_at: new Date().toISOString(), linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
        state.messagesBySession.set(SESSION_ID, []);
        return { sessionId: SESSION_ID, streamId: STREAM_ID };
      },
    },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const document = window.document;
  let aggregate = '';
  const emit = async (payload, settleMs = 5) => {
    const full = { sessionId: SESSION_ID, streamId: STREAM_ID, ...payload };
    if (payload.type === 'delta') {
      aggregate += payload.content || '';
      full.aggregate = aggregate;
    }
    await shell.__emitChat(full);
    await waitForUi(window, settleMs);
  };

  const input = document.getElementById('chatInput');
  input.value = 'reconcile the statements';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('sendButton').click();
  await waitForUi(window, 30);
  await emit({ type: 'started' });

  for (let iteration = 1; iteration <= PRIOR_ITERATIONS; iteration += 1) {
    await emit(reasoningPhaseEvent('phase_started', iteration));
    await emit(reasoningDelta(iteration, `Planning step ${iteration}.`));
    await emit(reasoningPhaseEvent('phase_completed', iteration));
    for (const payload of toolBatch(iteration)) await emit(payload);
    await waitForUi(window, 30);
  }

  const live = PRIOR_ITERATIONS + 1;
  await emit(reasoningPhaseEvent('phase_started', live));
  let text = 'Now I have all the APIs.';
  // Opening the live row is legitimately structural: the row appears, and the
  // segment message gains its first reasoning entry (the 'R' in the structure
  // signature) one delta later. One write per segment, never per delta.
  await emit(reasoningDelta(live, text), 40);
  text += ' Let me write the tests.';
  await emit(reasoningDelta(live, text), 40);
  const earlierReasoningRow = document.querySelector('.chat-row[data-row-kind="reasoning"]');
  const earlierToolRow = document.querySelector('.chat-row[data-row-kind="tool_call"]');
  assert.ok(earlierReasoningRow && earlierToolRow, 'the prior segments rendered as rows');
  const writesBefore = timelineDomWrites(window);
  window.rendererStreamClientMetricsModule.getShared().take(STREAM_ID);

  const deltas = 8;
  for (let index = 0; index < deltas; index += 1) {
    text += ` Checking the parser, pass ${index}.`;
    await emit(reasoningDelta(live, text), 40);
  }
  // Let the last rAF-batched render land before reading the counters.
  await waitForUi(window, 120);

  const metrics = window.rendererStreamClientMetricsModule.getShared().take(STREAM_ID);
  assert.equal(
    timelineDomWrites(window) - writesBefore,
    0,
    'a reasoning-only delta must not rebuild the turn row list, the article, or the transcript'
  );
  assert.equal(metrics?.full_renders || 0, 0, `no full render per delta (${JSON.stringify(metrics?.full_render_reasons || {})})`);
  assert.ok((metrics?.stream_reveal_patches_applied || 0) >= deltas / 2, `the deltas were patched (${JSON.stringify(metrics)})`);

  const reasoningRows = [...document.querySelectorAll('.chat-row[data-row-kind="reasoning"]')];
  assert.equal(reasoningRows.length, live, 'one reasoning row per phase');
  const liveRow = reasoningRows[reasoningRows.length - 1];
  assert.equal(liveRow.getAttribute('data-source-message-id'), `assistant_${STREAM_ID}_seg${PRIOR_ITERATIONS}`);
  assert.match(liveRow.textContent, /pass 7\./, 'the last delta is painted in the live row');
  assert.equal(liveRow.querySelector('.reasoning-row-name')?.textContent.trim(), 'Thinking',
    'the live row keeps its own header, not the message-level "Step N"');
  assert.equal(document.querySelectorAll('.reasoning-row-group-label').length, 0, 'no whole-message step group is written into the turn');
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="reasoning"]'), earlierReasoningRow, 'earlier rows are untouched');
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="tool_call"]'), earlierToolRow);
  assert.doesNotMatch(earlierReasoningRow.textContent, /pass 7/, 'the delta never lands in an earlier segment');

  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' }, 80);
});

function textPhaseStarted(iteration) {
  const phase = { phase_id: `phase_text_${STREAM_ID}_iter${iteration}_2`, phase_kind: 'text', iteration };
  return { type: 'phase_started', phaseId: phase.phase_id, phaseKind: 'text', iteration, phase };
}

function textDelta(iteration, content) {
  return { type: 'delta', content, phase: { phase_id: `phase_text_${STREAM_ID}_iter${iteration}_2`, phase_kind: 'text', iteration } };
}

// HB-010 follow-up (dogfood 2026-09-28, Ornith 1.5): once the live reasoning
// patch succeeded, the first answer delta took the surgical "content just
// appeared" branch and inserted a bare streaming bubble INSIDE the reasoning
// row. The answer streamed there with no assistant_text row, then popped in
// all at once at the terminal render.
async function streamAnswerAfterReasoning(t, priorIterations) {
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: { ...buildFeatureFlagDefaults(), chat_timeline_render_telemetry: true } } },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: SESSION_ID, title: 'HB-010 answer', conversation_mode: 'chat', preferred_model: 'gpt-test',
          updated_at: new Date().toISOString(), linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
        state.messagesBySession.set(SESSION_ID, []);
        return { sessionId: SESSION_ID, streamId: STREAM_ID };
      },
    },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const document = window.document;
  let aggregate = '';
  const emit = async (payload, settleMs = 5) => {
    const full = { sessionId: SESSION_ID, streamId: STREAM_ID, ...payload };
    if (payload.type === 'delta') {
      aggregate += payload.content || '';
      full.aggregate = aggregate;
    }
    await shell.__emitChat(full);
    await waitForUi(window, settleMs);
  };

  const input = document.getElementById('chatInput');
  input.value = 'give me an overview';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('sendButton').click();
  await waitForUi(window, 30);
  await emit({ type: 'started' });

  for (let iteration = 1; iteration <= priorIterations; iteration += 1) {
    await emit(reasoningPhaseEvent('phase_started', iteration));
    await emit(reasoningDelta(iteration, `Planning step ${iteration}.`));
    await emit(reasoningPhaseEvent('phase_completed', iteration));
    for (const payload of toolBatch(iteration)) await emit(payload);
    await waitForUi(window, 30);
  }

  const live = priorIterations + 1;
  await emit(reasoningPhaseEvent('phase_started', live));
  let reasoning = 'I have what I need.';
  await emit(reasoningDelta(live, reasoning), 40);
  reasoning += ' Time to write the answer.';
  await emit(reasoningDelta(live, reasoning), 40);
  await emit(reasoningPhaseEvent('phase_completed', live), 40);
  await emit(textPhaseStarted(live), 40);

  const writesBefore = timelineDomWrites(window);
  window.rendererStreamClientMetricsModule.getShared().take(STREAM_ID);
  const deltas = 8;
  for (let index = 0; index < deltas; index += 1) {
    await emit(textDelta(live, `Answer part ${index}. `), 40);
  }
  await waitForUi(window, 120);
  const metrics = window.rendererStreamClientMetricsModule.getShared().take(STREAM_ID);

  const bubbles = [...document.querySelectorAll('[data-streaming-bubble="true"]')];
  assert.equal(bubbles.length, 1, 'one live answer bubble');
  const answerRow = bubbles[0].closest('.chat-row');
  assert.equal(answerRow?.getAttribute('data-row-kind'), 'assistant_text',
    'the answer streams in its own assistant_text row, not inside the reasoning row');
  assert.match(answerRow.textContent, /Answer part 7\./, 'the last answer delta is painted before the terminal');
  for (const row of document.querySelectorAll('.chat-row[data-row-kind="reasoning"]')) {
    assert.equal(row.querySelector('.chat-bubble'), null, 'no answer bubble inside a reasoning row');
  }
  assert.ok(timelineDomWrites(window) - writesBefore <= 1,
    'opening the answer row is one structural write; later answer deltas patch in place');
  assert.equal(metrics?.full_renders || 0, 0, `no full render per answer delta (${JSON.stringify(metrics?.full_render_reasons || {})})`);

  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' }, 80);
  assert.equal(document.querySelectorAll('.chat-row[data-row-kind="assistant_text"]').length, 1, 'one answer row after the terminal');
}

test('HB-010 follow-up: an answer after the live reasoning on a tool turn streams in its own row', async (t) => {
  await streamAnswerAfterReasoning(t, 3);
});

test('HB-010 follow-up: a think-then-answer turn with no tools streams the answer in its own row', async (t) => {
  await streamAnswerAfterReasoning(t, 0);
});

test('S4: five answer deltas reuse the completed live reasoning stack after the first', async (t) => {
  const app = await loadRendererApp({ shell: { chat: {
    async startStream(_payload, { state }) {
      state.sessions = [{ id: SESSION_ID, title: 'S4 answer', conversation_mode: 'chat', preferred_model: 'gpt-test',
        updated_at: new Date().toISOString(), linked_session_ids: [],
        context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
      state.messagesBySession.set(SESSION_ID, []);
      return { sessionId: SESSION_ID, streamId: STREAM_ID };
    },
  } } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  let aggregate = '';
  const emit = async (payload) => {
    if (payload.type === 'delta') aggregate += payload.content || '';
    await shell.__emitChat({ sessionId: SESSION_ID, streamId: STREAM_ID, aggregate, ...payload });
    await waitForUi(window, 80);
  };
  const input = window.document.getElementById('chatInput');
  input.value = 'answer after thinking';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 40);
  await emit({ type: 'started' });
  await emit(reasoningPhaseEvent('phase_started', 1));
  await emit(reasoningDelta(1, 'A completed thought.'));
  await emit(reasoningPhaseEvent('phase_completed', 1));
  await emit(textPhaseStarted(1));

  const targets = window.rendererStreamPatchTargetUtils;
  const original = targets.buildLiveReasoningRowStackMarkup;
  let builds = 0;
  targets.buildLiveReasoningRowStackMarkup = (options) => original({ ...options,
    buildLiveReasoningRowsMarkup: () => { builds += 1; return options.buildLiveReasoningRowsMarkup(); },
  });
  t.after(() => { targets.buildLiveReasoningRowStackMarkup = original; });
  await emit(textDelta(1, 'Answer 0. '));
  // Stream paints are frame-scheduled; under a loaded Node lane one 80 ms settle
  // can end before the answer row opens, so wait for the paint itself.
  await waitUntil(window, () => window.document.querySelector('.chat-row[data-row-kind="assistant_text"] [data-streaming-bubble="true"]'),
    'the answer row to open');
  builds = 0;
  for (let index = 1; index <= 5; index += 1) await emit(textDelta(1, `Answer ${index}. `));
  await waitUntil(window, () => /Answer 5\./.test(window.document.querySelector('[data-streaming-bubble="true"]')?.textContent || ''),
    'the last answer delta to paint');
  assert.equal(builds, 0, 'answer-only deltas must not rebuild unchanged reasoning rows');
  assert.match(window.document.querySelector('[data-streaming-bubble="true"]').textContent, /Answer 5\./);
  await emit({ type: 'complete', content: aggregate, interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' });
});

async function waitUntil(window, predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await waitForUi(window, 20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// timeline-perf (dogfood G5, 2026-09-30): the HB-010 contract held on a
// 10-iteration turn while the live 43-segment turn (mid-turn commentary after
// most reasoning phases, fenced code in a third of the reasoning bodies, a
// second reasoning phase in some segments, 51 tool cards) rebuilt the whole
// row list on every reasoning delta: 84% of the renderer's time in the keyed
// morph, 275 ms frame gaps. This replays that shape and reads the bail-out
// reason the stream-reveal ladder now names.
const LONG_PRIOR_ITERATIONS = 36;

function longReasoningBody(iteration, text) {
  const paragraphs = [
    `Iteration ${iteration}: the matcher handles the L1 pairs but the exception path still double counts. ${text}`,
    'Second paragraph: check `reporting.py` and the balance formula before touching the CSV writer.',
  ];
  if (iteration % 3 === 0) {
    paragraphs.push('```python\ndef balance(rows):\n    total = 0\n    for row in rows:\n        total += row.amount\n    return total\n```');
  }
  paragraphs.push('Third paragraph with a list:\n\n- first check\n- second check\n- third check');
  return paragraphs.join('\n\n');
}

function checkpointPhase(iteration) {
  return {
    phase_id: `phase_reasoning_${STREAM_ID}_iter${iteration}_3`,
    phase_kind: 'reasoning',
    thinking_id: `think_${STREAM_ID}_iter${iteration}_cp`,
    iteration,
    summary: 'Checkpoint',
  };
}

function checkpointEvent(type, iteration) {
  const phase = checkpointPhase(iteration);
  return { type, phaseId: phase.phase_id, phaseKind: 'reasoning', thinkingId: phase.thinking_id, iteration, summary: phase.summary, phase };
}

function checkpointDelta(iteration, text) {
  const phase = checkpointPhase(iteration);
  return {
    type: 'delta', content: '', channel: 'reasoning', thinkingId: phase.thinking_id, phase,
    reasoning: { source: 'provider', entriesDelta: [{ id: `reasoning_cp_${iteration}`, text }] },
  };
}

function bigToolBatch(iteration) {
  const filler = `diff --git a/bank_recon/matcher.py b/bank_recon/matcher.py\n@@ -${iteration},7 +${iteration},9 @@\n`
    + '-    return pairs\n+    pairs = [p for p in pairs if p.amount_ok]\n+    return pairs\n'.repeat(40);
  return toolBatch(iteration).map((payload) => (payload.type === 'tool_result'
    ? { ...payload, content: `${payload.content}\n${filler}` }
    : payload));
}

async function runLongManagedTurn(t, { priorIterations = LONG_PRIOR_ITERATIONS, commentary = true, checkpoints = true } = {}) {
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: { ...buildFeatureFlagDefaults(), chat_timeline_render_telemetry: true } } },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: SESSION_ID, title: 'timeline-perf long turn', conversation_mode: 'chat', preferred_model: 'gpt-test',
          updated_at: new Date().toISOString(), linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
        state.messagesBySession.set(SESSION_ID, []);
        return { sessionId: SESSION_ID, streamId: STREAM_ID };
      },
    },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const document = window.document;
  let aggregate = '';
  const emit = async (payload, settleMs = 5) => {
    const full = { sessionId: SESSION_ID, streamId: STREAM_ID, ...payload };
    if (payload.type === 'delta') {
      aggregate += payload.content || '';
      full.aggregate = aggregate;
    }
    await shell.__emitChat(full);
    await waitForUi(window, settleMs);
  };

  const input = document.getElementById('chatInput');
  input.value = 'build the reconciler';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('sendButton').click();
  await waitForUi(window, 30);
  await emit({ type: 'started' });

  for (let iteration = 1; iteration <= priorIterations; iteration += 1) {
    await emit(reasoningPhaseEvent('phase_started', iteration));
    await emit(reasoningDelta(iteration, longReasoningBody(iteration, 'Reading the source.')));
    await emit(reasoningDelta(iteration, longReasoningBody(iteration, 'Reading the source. Now the tests.')));
    await emit(reasoningPhaseEvent('phase_completed', iteration));
    if (checkpoints && iteration % 5 === 0) {
      await emit(checkpointEvent('phase_started', iteration));
      await emit(checkpointDelta(iteration, `Checkpoint ${iteration}: the plan still holds.`));
      await emit(checkpointEvent('phase_completed', iteration));
    }
    if (commentary && iteration % 4 !== 0) {
      await emit(textPhaseStarted(iteration));
      await emit(textDelta(iteration, `Segment ${iteration}: the balance formula matches the spec; `));
      await emit(textDelta(iteration, 'moving on to the exception path.'));
    }
    for (const payload of bigToolBatch(iteration)) await emit(payload);
    await waitForUi(window, 30);
  }

  const live = priorIterations + 1;
  await emit(reasoningPhaseEvent('phase_started', live));
  let text = 'Now I have all the APIs.';
  await emit(reasoningDelta(live, text), 40);
  text += ' Let me write the tests.';
  await emit(reasoningDelta(live, text), 40);
  const rowsBefore = document.querySelectorAll('.chat-row').length;
  const earlierReasoningRow = document.querySelector('.chat-row[data-row-kind="reasoning"]');
  const earlierToolRow = document.querySelector('.chat-row[data-row-kind="tool_call"]');
  assert.ok(earlierReasoningRow && earlierToolRow, 'the prior segments rendered as rows');
  const writesBefore = timelineDomWrites(window);
  window.rendererStreamClientMetricsModule.getShared().take(STREAM_ID);

  const deltas = 8;
  for (let index = 0; index < deltas; index += 1) {
    text += ` Checking the parser, pass ${index}.`;
    await emit(reasoningDelta(live, text), 40);
  }
  await waitForUi(window, 120);
  const metrics = window.rendererStreamClientMetricsModule.getShared().take(STREAM_ID) || {};
  const liveRow = [...document.querySelectorAll('.chat-row[data-row-kind="reasoning"]')].pop();
  return { window, document, emit, metrics, rowsBefore, writesBefore, deltas, earlierReasoningRow, earlierToolRow, liveRow };
}

test('timeline-perf: reasoning deltas on a long managed turn with commentary, checkpoints and code never rebuild the row list', async (t) => {
  const run = await runLongManagedTurn(t);
  const { window, document, metrics } = run;
  const detail = JSON.stringify({
    rows: run.rowsBefore,
    row_list_morphs: metrics.row_list_morphs,
    row_list_rows_rebuilt: metrics.row_list_rows_rebuilt,
    row_list_morph_reasons: metrics.row_list_morph_reasons,
    full_render_reasons: metrics.full_render_reasons,
  });
  assert.ok(run.rowsBefore >= 100, `the turn is long (${run.rowsBefore} rows)`);
  assert.equal(metrics.row_list_morphs || 0, 0, `no row-list morph per reasoning delta: ${detail}`);
  assert.equal(timelineDomWrites(window) - run.writesBefore, 0, `a reasoning-only delta writes no turn-scope DOM: ${detail}`);
  assert.equal(metrics.full_renders || 0, 0, `no full render per delta: ${detail}`);
  assert.ok((metrics.stream_reveal_patches_applied || 0) >= run.deltas / 2, `the deltas were patched: ${detail}`);
  assert.match(run.liveRow.textContent, /pass 7\./, 'the last delta is painted in the live row');
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="reasoning"]'), run.earlierReasoningRow, 'earlier rows are untouched');
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="tool_call"]'), run.earlierToolRow);

  // A structural change on the live segment (the answer row opening) takes the
  // fallback. The first reconcile of a turn is cold (no row carries a stamp
  // yet, so every row morphs once); from then on the per-row reconcile keeps
  // the settled rows and rebuilds only the live ones, whatever the surgical
  // patch's reason for declining.
  const shared = window.rendererStreamClientMetricsModule.getShared();
  const describe = (snapshot) => JSON.stringify({
    rows: run.rowsBefore,
    row_list_morphs: snapshot.row_list_morphs,
    row_list_rows_reused: snapshot.row_list_rows_reused,
    row_list_rows_rebuilt: snapshot.row_list_rows_rebuilt,
    row_list_morph_reasons: snapshot.row_list_morph_reasons,
    full_render_reasons: snapshot.full_render_reasons,
  });
  shared.take(STREAM_ID);
  await run.emit(reasoningPhaseEvent('phase_completed', LONG_PRIOR_ITERATIONS + 1), 40);
  await run.emit(textPhaseStarted(LONG_PRIOR_ITERATIONS + 1), 40);
  await run.emit(textDelta(LONG_PRIOR_ITERATIONS + 1, 'The answer starts here. '), 40);
  await run.emit(textDelta(LONG_PRIOR_ITERATIONS + 1, 'And continues. '), 40);
  await waitForUi(window, 120);
  const cold = shared.take(STREAM_ID) || {};
  assert.equal(cold.full_renders || 0, 0, `the answer row opens without a full render: ${describe(cold)}`);
  assert.ok((cold.row_list_morphs || 0) >= 1, `the answer row opening is a structural row-list write: ${describe(cold)}`);
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="reasoning"]'), run.earlierReasoningRow, 'settled rows keep identity through the cold reconcile');
  assert.match(document.querySelector('.chat-row[data-row-kind="assistant_text"] [data-streaming-bubble="true"]')?.textContent || '', /And continues/,
    'the answer streams in its own row');

  // The next structural write (a new reasoning row after the answer text) is
  // warm: settled rows are kept, only the live rows rebuild.
  const next = LONG_PRIOR_ITERATIONS + 2;
  await run.emit(reasoningPhaseEvent('phase_started', next), 40);
  await run.emit(reasoningDelta(next, 'A second look at the parser.'), 40);
  await run.emit(reasoningDelta(next, 'A second look at the parser. It holds.'), 40);
  await waitForUi(window, 120);
  const warm = shared.take(STREAM_ID) || {};
  const warmMorphs = warm.row_list_morphs || 0;
  assert.equal(warm.full_renders || 0, 0, `the new reasoning row opens without a full render: ${describe(warm)}`);
  assert.ok(warmMorphs >= 1, `the new reasoning row is a structural row-list write: ${describe(warm)}`);
  assert.ok((warm.row_list_rows_rebuilt || 0) <= 6 * warmMorphs, `a warm reconcile rebuilds only the live rows: ${describe(warm)}`);
  assert.ok((warm.row_list_rows_reused || 0) >= 100 * warmMorphs, `a warm reconcile keeps the settled rows: ${describe(warm)}`);
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="reasoning"]'), run.earlierReasoningRow, 'settled rows keep identity through the warm reconcile');
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="tool_call"]'), run.earlierToolRow);
  assert.match([...document.querySelectorAll('.chat-row[data-row-kind="reasoning"]')].pop().textContent, /It holds/, 'the new reasoning row is painted');
  await run.emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' }, 80);
});
