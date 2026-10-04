'use strict';

// Transcript views (docs/plans/TRANSCRIPT_VIEWS.md) through the real shell.
// The jsdom harness loads no stylesheet, so this proves attributes, expansion
// defaults, materialization and render lanes; layout is the owner's real-app
// gate. The wire shapes are the ones renderer-chat-live-reasoning-row-patch
// replays (row-model turn: reasoning phase, tool batch, text, terminal).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');

const SESSION_ID = 'sess_transcript_views';

function reasoningPhase(streamId, iteration) {
  return {
    phase_id: `phase_reasoning_${streamId}_iter${iteration}_1`,
    phase_kind: 'reasoning',
    thinking_id: `think_${streamId}_iter${iteration}`,
    iteration,
    summary: 'Reasoning through the turn',
  };
}

function reasoningPhaseEvent(streamId, type, iteration) {
  const phase = reasoningPhase(streamId, iteration);
  return {
    type, phaseId: phase.phase_id, phaseKind: 'reasoning', thinkingId: phase.thinking_id, iteration,
    summary: phase.summary, phase,
  };
}

function reasoningDelta(streamId, iteration, text) {
  const phase = reasoningPhase(streamId, iteration);
  return {
    type: 'delta', content: '', channel: 'reasoning', thinkingId: phase.thinking_id, phase,
    reasoning: { source: 'provider', entriesDelta: [{ id: `reasoning_${streamId}_${iteration}`, text }] },
  };
}

function toolBatch(streamId, iteration) {
  const callId = `call_${streamId}_${iteration}`;
  const usePhase = { type: 'phase_started', phaseId: `phase_tool_use_${streamId}_${callId}`, phaseKind: 'tool_use', toolCallId: callId, toolName: 'read_file' };
  const resultPhase = { type: 'phase_started', phaseId: `phase_tool_result_${streamId}_${callId}`, phaseKind: 'tool_result', toolCallId: callId, toolName: 'read_file' };
  return [
    { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: callId }, status: 'pending' },
    usePhase,
    { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: callId }, status: 'running',
      next_assistant_message_id: `assistant_${streamId}_seg${iteration}` },
    { ...usePhase, type: 'phase_completed' },
    resultPhase,
    { type: 'tool_result', callId, toolName: 'read_file', status: 'success', content: `contents of ${callId}`, isError: false },
    { ...resultPhase, type: 'phase_completed' },
  ];
}

function textPhaseStarted(streamId, iteration) {
  const phase = { phase_id: `phase_text_${streamId}_iter${iteration}_2`, phase_kind: 'text', iteration };
  return { type: 'phase_started', phaseId: phase.phase_id, phaseKind: 'text', iteration, phase };
}

function textDelta(streamId, iteration, content) {
  return { type: 'delta', content, phase: { phase_id: `phase_text_${streamId}_iter${iteration}_2`, phase_kind: 'text', iteration } };
}

const TERMINAL = { type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' };

async function loadApp(t) {
  let streamCount = 0;
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: { ...buildFeatureFlagDefaults(), chat_timeline_render_telemetry: true } } },
    chat: {
      async startStream(_payload, { state }) {
        streamCount += 1;
        if (!state.sessions.some((session) => session.id === SESSION_ID)) {
          state.sessions = [{ id: SESSION_ID, title: 'Transcript views', conversation_mode: 'chat', preferred_model: 'gpt-test',
            updated_at: new Date().toISOString(), linked_session_ids: [],
            context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
          state.messagesBySession.set(SESSION_ID, []);
        }
        return { sessionId: SESSION_ID, streamId: `stream_tv_${streamCount}` };
      },
    },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const document = window.document;

  function makeEmitter(streamId) {
    let aggregate = '';
    return async (payload, settleMs = 5) => {
      const full = { sessionId: SESSION_ID, streamId, ...payload };
      if (payload.type === 'delta') {
        aggregate += payload.content || '';
        full.aggregate = aggregate;
      }
      await shell.__emitChat(full);
      await waitForUi(window, settleMs);
    };
  }

  async function send(text) {
    const input = document.getElementById('chatInput');
    input.value = text;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.getElementById('sendButton').click();
    await waitForUi(window, 30);
    const streamId = `stream_tv_${streamCount}`;
    const emit = makeEmitter(streamId);
    await emit({ type: 'started' });
    return { streamId, emit };
  }

  // One settled turn: reasoning phase, one tool call, a text answer.
  async function streamSettledTurn(text) {
    const { streamId, emit } = await send(text);
    await emit(reasoningPhaseEvent(streamId, 'phase_started', 1));
    await emit(reasoningDelta(streamId, 1, 'Planning the answer.'), 40);
    await emit(reasoningPhaseEvent(streamId, 'phase_completed', 1));
    for (const payload of toolBatch(streamId, 1)) await emit(payload);
    await emit(textPhaseStarted(streamId, 2), 40);
    await emit(textDelta(streamId, 2, 'The answer.'), 40);
    await emit(TERMINAL, 80);
    return streamId;
  }

  return { app, window, shell, document, send, streamSettledTurn };
}

const rows = (root, kind) => [...root.querySelectorAll(`.chat-row[data-row-kind="${kind}"]`)];
const toolRows = (root) => [...root.querySelectorAll('.tool-call-row')];

test('Answers: the pane timeline carries the view, reasoning rows stay in the DOM, tools collapse, the live turn is marked', async (t) => {
  const { window, document, streamSettledTurn, send } = await loadApp(t);
  await streamSettledTurn('first question');
  const timeline = document.getElementById('chatTimeline');
  assert.equal(timeline.dataset.transcriptView, 'thinking', 'the default view is Thinking');
  assert.equal(rows(timeline, 'reasoning').length, 1, 'precondition: the settled turn has a reasoning row');
  assert.equal(document.querySelector('.turn-row-list[data-turn-live="true"]'), null, 'a settled turn is not live');

  const controller = window.rendererTranscriptViewController;
  assert.equal(controller.setView(SESSION_ID, 'answers'), 'answers');
  await waitForUi(window, 60);

  assert.equal(timeline.dataset.transcriptView, 'answers', 'the pane timeline stamps the view');
  assert.equal(rows(timeline, 'reasoning').length, 1, 'Answers hides via CSS: the row is still rendered');
  for (const row of toolRows(timeline)) {
    assert.equal(row.getAttribute('data-expanded'), 'false', 'tool cards collapse in Answers');
  }

  const { streamId, emit } = await send('second question');
  await emit(reasoningPhaseEvent(streamId, 'phase_started', 1));
  await emit(reasoningDelta(streamId, 1, 'Thinking about it.'), 40);
  await emit(reasoningDelta(streamId, 1, 'Thinking about it more.'), 40);
  const liveLists = [...document.querySelectorAll('.turn-row-list[data-turn-live="true"]')];
  assert.equal(liveLists.length, 1, 'exactly the streaming turn is marked live');
  assert.equal(rows(liveLists[0], 'reasoning').length, 1, 'the live reasoning row exists for the header-only line');
  const liveHeader = liveLists[0].querySelector('[data-reasoning-toggle]');
  assert.equal(liveHeader.disabled, true, 'the header line is not clickable in Answers (po-review C1)');
  assert.equal(liveHeader.hasAttribute('aria-expanded'), false, 'no toggle semantics are announced (TV-6)');
  liveHeader.click();
  assert.equal(liveLists[0].querySelector('.reasoning-row-block.expanded'), null, 'a click opens nothing');
  assert.equal(JSON.parse(window.localStorage.getItem('jenny.reasoningPhaseExpansionBySession.v1') || '{}')[SESSION_ID], undefined, 'a click writes no reasoning override');
  await emit(reasoningPhaseEvent(streamId, 'phase_completed', 1));
  await emit(textPhaseStarted(streamId, 2), 40);
  await emit(textDelta(streamId, 2, 'Second answer.'), 40);
  await emit(TERMINAL, 120);
  assert.equal(document.querySelector('.turn-row-list[data-turn-live="true"]'), null, 'the marker leaves with the terminal');
  assert.equal(timeline.dataset.transcriptView, 'answers', 'the view survives the turn');
  assert.equal(window.localStorage.getItem('jenny.transcriptViewBySession.v1'), JSON.stringify({ [SESSION_ID]: 'answers' }));
});

// TV-1: the Answers live-turn marker spans the whole in-flight turn. The
// preamble text and the tool result used to read as a 'done' phase, dropping
// the marker (and every live reasoning row with it) until the next reasoning
// token. Each lane must carry it: full renders, the forced full render inside
// the tool gap, the live reasoning patch and the stream-reveal row-list morph.
test('Answers: the live-turn marker holds through preamble, tool gap and every render lane until the terminal', async (t) => {
  const { window, document, streamSettledTurn, send } = await loadApp(t);
  await streamSettledTurn('first question');
  window.rendererTranscriptViewController.setView(SESSION_ID, 'answers');
  await waitForUi(window, 60);
  const timeline = document.getElementById('chatTimeline');
  const liveLists = () => [...document.querySelectorAll('.turn-row-list[data-turn-live="true"]')];
  const assertLive = (step) => {
    const lists = liveLists();
    assert.equal(lists.length, 1, `${step}: exactly the in-flight turn is marked live`);
    assert.equal(lists[0], newestList(), `${step}: the marker sits on the newest turn`);
  };
  // A patch lane keeps this sentinel; a full render replaces the timeline.
  const plantSentinel = () => {
    const sentinel = document.createElement('i');
    sentinel.setAttribute('data-test-sentinel', 'true');
    timeline.appendChild(sentinel);
  };
  const sentinelSurvived = () => document.querySelector('[data-test-sentinel]') !== null;
  const newestList = () => [...timeline.querySelectorAll('.turn-row-list')].pop();
  // Stream-reveal patches flush on a frame: wait for the delta's paint, not a fixed tick.
  const waitUntil = async (predicate, label) => {
    for (let waited = 0; !predicate(); waited += 10) {
      assert.ok(waited < 3000, `timed out waiting for ${label}`);
      await waitForUi(window, 10);
    }
  };

  const { streamId, emit } = await send('second question');
  await emit(reasoningPhaseEvent(streamId, 'phase_started', 1));
  await emit(reasoningDelta(streamId, 1, 'Planning the lookup.'), 40);
  await emit(reasoningDelta(streamId, 1, 'Planning the lookup. Which file?'), 40);
  await waitUntil(() => rows(newestList(), 'reasoning').length === 1, 'the live turn article');
  assertLive('reasoning');
  await emit(reasoningPhaseEvent(streamId, 'phase_completed', 1));
  assertLive('reasoning completed');
  await emit(textPhaseStarted(streamId, 2), 40);
  await emit(textDelta(streamId, 2, 'Let me read the file.'), 40);
  assertLive('preamble text');

  const [pending, usePhase, running, useDone, resultPhase, result, resultDone] = toolBatch(streamId, 3);
  for (const payload of [pending, usePhase, running]) await emit(payload, 20);
  assertLive('tool running');
  for (const payload of [useDone, resultPhase, result, resultDone]) await emit(payload, 20);
  assertLive('tool result');
  assert.ok(rows(liveLists()[0], 'reasoning').length >= 1, 'the live turn keeps its reasoning row through the gap');

  // Forced full renders inside the gap (no streaming message, no pending
  // stream): a view switch commits only through one, and back again.
  for (const view of ['thinking', 'answers']) {
    plantSentinel();
    window.rendererTranscriptViewController.setView(SESSION_ID, view);
    await waitForUi(window, 40);
    assert.equal(sentinelSurvived(), false, `precondition: the ${view} switch in the gap was a full render`);
    assertLive(`forced full render in the tool gap (${view})`);
  }

  await emit(reasoningPhaseEvent(streamId, 'phase_started', 4));
  let reasoning = 'Reading the result.';
  await emit(reasoningDelta(streamId, 4, reasoning), 40);
  assertLive('reasoning 2');
  reasoning += ' Checking the relevant part.';
  await emit(reasoningDelta(streamId, 4, reasoning), 40);
  assertLive('reasoning 2, second delta');
  // The live reasoning patch rewrites rows, not the list: it must re-sync the
  // list's own marker. Strip it, patch, and require it back without a full render.
  plantSentinel();
  liveLists()[0].removeAttribute('data-turn-live');
  reasoning += ' The file has what we need.';
  await emit(reasoningDelta(streamId, 4, reasoning), 40);
  await waitUntil(() => newestList().textContent.includes('what we need'), 'the reasoning patch');
  assert.equal(sentinelSurvived(), true, 'precondition: the reasoning delta took a patch lane');
  assertLive('reasoning 2 patch');
  await emit(reasoningPhaseEvent(streamId, 'phase_completed', 4));
  assertLive('reasoning 2 completed');

  // The answer's first delta opens its assistant_text row in place: the
  // stream-reveal row-list morph, which also writes children only.
  await emit(textPhaseStarted(streamId, 5), 40);
  const textRowsBefore = rows(newestList(), 'assistant_text').length;
  plantSentinel();
  liveLists()[0].removeAttribute('data-turn-live');
  await emit(textDelta(streamId, 5, 'The answer'), 40);
  await waitUntil(() => rows(newestList(), 'assistant_text').length === textRowsBefore + 1, 'the morph to open the answer row');
  assert.equal(sentinelSurvived(), true, 'precondition: the answer delta took a patch lane');
  assertLive('answer text (row-list morph)');
  liveLists()[0].removeAttribute('data-turn-live');
  await emit(textDelta(streamId, 5, ' is in the file.'), 40);
  await waitUntil(() => newestList().textContent.includes('is in the file.'), 'the answer patch');
  assert.equal(sentinelSurvived(), true, 'precondition: the next answer delta patched the bubble');
  assertLive('answer text patch');

  await emit(TERMINAL, 120);
  await waitUntil(() => document.querySelector('.turn-row-list[data-turn-live]') === null, 'the marker to leave with the terminal');
});

test('Everything: settled reasoning expands and tool details materialize; Thinking collapses both again', async (t) => {
  const { window, document, streamSettledTurn } = await loadApp(t);
  await streamSettledTurn('first question');
  const timeline = document.getElementById('chatTimeline');
  const controller = window.rendererTranscriptViewController;

  controller.setView(SESSION_ID, 'everything');
  await waitForUi(window, 60);
  assert.equal(timeline.dataset.transcriptView, 'everything');
  const reasoningRow = rows(timeline, 'reasoning')[0];
  assert.ok(reasoningRow, 'the reasoning row rendered');
  assert.equal(reasoningRow.querySelector('.reasoning-row-toggle, [aria-expanded]')?.getAttribute('aria-expanded'), 'true', 'settled reasoning opens in Everything');
  assert.ok(toolRows(timeline).length >= 1, 'precondition: a tool row rendered');
  for (const row of toolRows(timeline)) {
    assert.equal(row.getAttribute('data-expanded'), 'true', 'tool cards open in Everything');
    assert.equal(row.getAttribute('data-tool-details-materialized'), 'true', 'details are materialized, not lazy');
  }

  controller.setView(SESSION_ID, 'thinking');
  await waitForUi(window, 60);
  assert.equal(timeline.dataset.transcriptView, 'thinking');
  assert.equal(rows(timeline, 'reasoning')[0].querySelector('[aria-expanded]')?.getAttribute('aria-expanded'), 'false', 'settled reasoning collapses again');
  for (const row of toolRows(timeline)) {
    assert.equal(row.getAttribute('data-expanded'), 'false');
  }
});

test('switching mid-stream forces exactly one full render, then deltas return to the patch lane and settled phases stay open', async (t) => {
  const { window, document, send } = await loadApp(t);
  const { streamId, emit } = await send('stream and switch');
  // Two settled phases before the live one: Everything must keep them open
  // through the live reasoning patch that follows the switch.
  for (const iteration of [1, 2]) {
    await emit(reasoningPhaseEvent(streamId, 'phase_started', iteration));
    await emit(reasoningDelta(streamId, iteration, `Planning step ${iteration}.`), 40);
    await emit(reasoningPhaseEvent(streamId, 'phase_completed', iteration));
  }
  await emit(reasoningPhaseEvent(streamId, 'phase_started', 3));
  let text = 'Live thoughts.';
  await emit(reasoningDelta(streamId, 3, text), 40);
  text += ' More live thoughts.';
  await emit(reasoningDelta(streamId, 3, text), 40);

  const timeline = document.getElementById('chatTimeline');
  const sentinel = document.createElement('i');
  sentinel.setAttribute('data-test-sentinel', 'true');
  timeline.appendChild(sentinel);
  const metricsModule = window.rendererStreamClientMetricsModule.getShared();
  // take() resets the stream's counters and drops its entry; the next delta
  // recreates it so the switch's render is counted.
  metricsModule.take(streamId);
  text += ' Still thinking.';
  await emit(reasoningDelta(streamId, 3, text), 40);

  window.rendererTranscriptViewController.setView(SESSION_ID, 'everything');
  await waitForUi(window, 60);
  assert.equal(document.querySelector('[data-test-sentinel]'), null, 'the switch replaced the timeline (a full render)');

  const deltas = 6;
  for (let index = 0; index < deltas; index += 1) {
    text += ` Checking pass ${index}.`;
    await emit(reasoningDelta(streamId, 3, text), 40);
  }
  await waitForUi(window, 120);
  const metrics = metricsModule.take(streamId);
  assert.equal(metrics?.full_renders || 0, 1, `one full render for the switch, none per delta (${JSON.stringify(metrics?.full_render_reasons || {})})`);
  assert.deepEqual(Object.keys(metrics?.full_render_reasons || {}), ['force']);
  assert.ok((metrics?.stream_reveal_patches_applied || 0) >= deltas / 2, `the deltas were patched (${JSON.stringify(metrics)})`);

  const reasoningRows = rows(timeline, 'reasoning');
  assert.equal(reasoningRows.length, 3, 'one row per phase');
  for (const row of reasoningRows.slice(0, 2)) {
    assert.equal(row.querySelector('[aria-expanded]')?.getAttribute('aria-expanded'), 'true', 'settled phases stay open in Everything through the live patch');
  }
  assert.match(reasoningRows[2].textContent, /pass 5\./, 'the last delta is painted in the live row');
  await emit(TERMINAL, 80);
});

test('a view switch clears that session\'s per-row overrides and no others', async (t) => {
  const { window, document, streamSettledTurn } = await loadApp(t);
  await streamSettledTurn('first question');
  const timeline = document.getElementById('chatTimeline');
  const toolUtils = window.rendererTurnRowToolRenderUtils;
  const buildToolRowKey = window.rendererToolCallUtils?.buildToolRowKey || require('../renderer/chat/tool-call-utils.js').buildToolRowKey;
  const row = toolRows(timeline)[0];
  assert.ok(row, 'precondition: a tool row rendered');
  const rowKey = row.getAttribute('data-tool-row-key');
  toolUtils.setToolRowExpansion(rowKey, true);
  const otherKey = buildToolRowKey({ sessionId: 'sess_other', turnId: 'turn-1', rowId: 'row-1', callId: 'call-1' });
  toolUtils.setToolRowExpansion(otherKey, false);

  window.rendererTranscriptViewController.setView(SESSION_ID, 'answers');
  await waitForUi(window, 60);
  assert.equal(toolUtils.getToolRowExpansion(rowKey), undefined, 'the switched session forgets its override');
  assert.equal(toolUtils.getToolRowExpansion(otherKey), false, 'another session keeps its override');
  assert.equal(toolRows(timeline)[0].getAttribute('data-expanded'), 'false', 'the view default wins after the switch');
  assert.equal(window.__rendererState.ui.reasoningPhaseExpansionBySession.has(SESSION_ID), false, 'reasoning overrides are dropped too');
});

/* ── split view: each pane renders its own session's view ── */

function buildSummary(id, title) {
  return {
    id, title, session_type: 'chat', conversation_mode: 'chat', preferred_model: 'gpt-test', reasoning_effort: 'default',
    plan_mode: false, pinned: false, archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [], interactive_round_count: 0, interactive_sequence_state: 'idle', pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function transcript(sessionId, text) {
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Question for ${text}`, status: 'complete' },
    {
      id: `assistant_${sessionId}`, role: 'assistant', content: `Answer from ${text}.`, status: 'complete', finalizedAt: new Date().toISOString(),
      reasoning: { available: true, status: 'complete', source: 'provider', entries: [{ id: `r_${sessionId}`, text: `Thinking for ${text}.` }] },
    },
  ];
}

test('split view: switching pane 1\'s session view leaves pane 0 byte-identical, and each pane stamps its own view', async (t) => {
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha'), buildSummary('session-b', 'Beta')],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b'] },
    sessionMessagePayloads: {
      'session-a': { data: transcript('session-a', 'pane zero') },
      'session-b': { data: transcript('session-b', 'pane one') },
    },
  } });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const tab = doc.querySelector('.workspace-rail-tab[data-session-id="session-b"]');
  assert.ok(tab, 'precondition: session-b is an open rail tab');
  tab.dispatchEvent(new window.MouseEvent('contextmenu', { clientX: 5, clientY: 5, bubbles: true }));
  const openBeside = [...doc.querySelectorAll('.workspace-tab-context-menu-item')].find((item) => item.textContent === 'Open beside');
  assert.ok(openBeside, 'the tab menu offers Open beside');
  openBeside.click();
  await waitForUi(window, 150);
  const pane1 = window.rendererAppPaneComposition.getPaneComposition().getPane(1);
  assert.ok(pane1, 'pane 1 is mounted');
  const pane0Timeline = doc.getElementById('chatTimeline');
  const pane1Timeline = pane1.dom.chatTimeline;
  assert.equal(pane0Timeline.dataset.transcriptView, 'thinking');
  assert.equal(pane1Timeline.dataset.transcriptView, 'thinking');

  const controller = window.rendererTranscriptViewController;
  const pane0Before = pane0Timeline.innerHTML;
  controller.setView('session-b', 'everything');
  await waitForUi(window, 80);
  assert.equal(pane1Timeline.dataset.transcriptView, 'everything', "pane 1 shows its session's view");
  assert.equal(pane0Timeline.dataset.transcriptView, 'thinking', 'pane 0 keeps the default');
  assert.equal(pane0Timeline.innerHTML, pane0Before, "pane 0's timeline is byte-identical across pane 1's switch");
  assert.equal(pane1Timeline.querySelector('.chat-row[data-row-kind="reasoning"] [aria-expanded]')?.getAttribute('aria-expanded'), 'true',
    "pane 1's settled reasoning opens in Everything");

  const pane1Before = pane1Timeline.innerHTML;
  controller.setView('session-a', 'answers');
  await waitForUi(window, 80);
  assert.equal(pane0Timeline.dataset.transcriptView, 'answers');
  assert.equal(pane1Timeline.dataset.transcriptView, 'everything');
  assert.equal(pane1Timeline.innerHTML, pane1Before, "pane 1's timeline is byte-identical across pane 0's switch");
  assert.equal(controller.getView('session-a'), 'answers');
  assert.equal(controller.getView('session-b'), 'everything');
});

/* ── the cluster control in the real shell ── */

test('the pane cluster control switches the view through its menu and its icon follows the render', async (t) => {
  const { window, document, streamSettledTurn } = await loadApp(t);
  await streamSettledTurn('first question');
  const button = document.querySelector('#chatPane0 [data-transcript-view-toggle]');
  assert.ok(button, 'pane 0 built its transcript view control');
  assert.equal(button.dataset.transcriptView, 'thinking');
  assert.equal(document.getElementById('timelineCollapseExpandToggle'), null, 'the bulk toggle is gone');

  button.click();
  const items = [...document.querySelectorAll('.inv-context-menu [role="menuitemradio"]')];
  assert.equal(items.length, 3, 'the menu opened with the three views');
  items[0].click();
  await waitForUi(window, 80);
  assert.equal(document.getElementById('chatTimeline').dataset.transcriptView, 'answers');
  assert.equal(button.dataset.transcriptView, 'answers', 'the render notice synced the icon');
  assert.match(button.getAttribute('aria-label'), /Answers/);
  assert.equal(window.rendererTranscriptViewController.getView(SESSION_ID), 'answers');
});
