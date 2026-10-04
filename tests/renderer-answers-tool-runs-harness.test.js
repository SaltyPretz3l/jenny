'use strict';

// Answers tool runs (NEXT_STEPS row 21) through the real shell. The jsdom
// harness loads no stylesheet, so this proves the run rows, member stamps,
// expansion state, the live summary and node reuse across the render lanes;
// layout and the no-bounce claim are the owner's real-app gate. Wire shapes
// follow tests/renderer-transcript-view-harness.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');

const SESSION_ID = 'sess_answers_tool_runs';

function toolEvents(streamId, index) {
  const callId = `call_${streamId}_${index}`;
  const usePhase = { type: 'phase_started', phaseId: `phase_tool_use_${streamId}_${callId}`, phaseKind: 'tool_use', toolCallId: callId, toolName: 'read_file' };
  const resultPhase = { type: 'phase_started', phaseId: `phase_tool_result_${streamId}_${callId}`, phaseKind: 'tool_result', toolCallId: callId, toolName: 'read_file' };
  return {
    callId,
    start: [
      { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: `${callId}.js` }, status: 'pending' },
      usePhase,
      { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: `${callId}.js` }, status: 'running',
        next_assistant_message_id: `assistant_${streamId}_seg${index}` },
    ],
    finish: [
      { ...usePhase, type: 'phase_completed' },
      resultPhase,
      { type: 'tool_result', callId, toolName: 'read_file', status: 'success', content: `contents of ${callId}`, isError: false, durationMs: 1500 },
      { ...resultPhase, type: 'phase_completed' },
    ],
  };
}

function textPhaseStarted(iteration) {
  const phase = { phase_id: `phase_text_iter${iteration}`, phase_kind: 'text', iteration };
  return { type: 'phase_started', phaseId: phase.phase_id, phaseKind: 'text', iteration, phase };
}

function textDelta(iteration, content) {
  return { type: 'delta', content, phase: { phase_id: `phase_text_iter${iteration}`, phase_kind: 'text', iteration } };
}

const TERMINAL = { type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' };

async function loadApp(t) {
  let streamCount = 0;
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: buildFeatureFlagDefaults() } },
    chat: {
      async startStream(_payload, { state }) {
        streamCount += 1;
        if (!state.sessions.some((session) => session.id === SESSION_ID)) {
          state.sessions = [{ id: SESSION_ID, title: 'Tool runs', conversation_mode: 'chat', preferred_model: 'gpt-test',
            updated_at: new Date().toISOString(), linked_session_ids: [],
            context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
          state.messagesBySession.set(SESSION_ID, []);
        }
        return { sessionId: SESSION_ID, streamId: `stream_runs_${streamCount}` };
      },
    },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const document = window.document;

  async function send(text) {
    const input = document.getElementById('chatInput');
    input.value = text;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.getElementById('sendButton').click();
    await waitForUi(window, 30);
    const streamId = `stream_runs_${streamCount}`;
    let aggregate = '';
    const emit = async (payload, settleMs = 5) => {
      const full = { sessionId: SESSION_ID, streamId, ...payload };
      if (payload.type === 'delta') {
        aggregate += payload.content || '';
        full.aggregate = aggregate;
      }
      await shell.__emitChat(full);
      await waitForUi(window, settleMs);
    };
    await emit({ type: 'started' });
    return { streamId, emit };
  }

  const waitUntil = async (predicate, label) => {
    for (let waited = 0; !predicate(); waited += 10) {
      assert.ok(waited < 3000, `timed out waiting for ${label}`);
      await waitForUi(window, 10);
    }
  };

  return { window, document, send, waitUntil };
}

const timelineOf = (document) => document.getElementById('chatTimeline');
const runRows = (root) => [...root.querySelectorAll('.chat-row[data-row-kind="tool_run"]')];
const memberRows = (root) => [...root.querySelectorAll('.chat-row[data-run-member="step"]')];

async function streamThreeToolTurn(send) {
  const { streamId, emit } = await send('look around');
  await emit(textPhaseStarted(1), 20);
  await emit(textDelta(1, 'Let me look.'), 20);
  for (const index of [2, 3, 4]) {
    const tool = toolEvents(streamId, index);
    for (const payload of [...tool.start, ...tool.finish]) await emit(payload, 10);
  }
  await emit(textPhaseStarted(5), 20);
  await emit(textDelta(5, 'Found it.'), 20);
  await emit(TERMINAL, 80);
}

test('Answers folds a settled run into one summary row; Thinking renders no run', async (t) => {
  const { window, document, send } = await loadApp(t);
  await streamThreeToolTurn(send);
  const timeline = timelineOf(document);
  assert.equal(timeline.dataset.transcriptView, 'thinking');
  assert.equal(runRows(timeline).length, 0, 'the default view emits no run rows');
  assert.equal(timeline.querySelectorAll('[data-run-id]').length, 0, 'the default view stamps no run attributes');

  window.rendererTranscriptViewController.setView(SESSION_ID, 'answers');
  await waitForUi(window, 60);
  const [summary] = runRows(timeline);
  assert.ok(summary, 'Answers emits the run summary');
  assert.equal(runRows(timeline).length, 1);
  assert.equal(summary.querySelector('.tool-run-summary').textContent, 'Read 3 files');
  assert.equal(summary.querySelector('.tool-run-row').getAttribute('data-tool-run-state'), 'ok');
  assert.equal(summary.querySelector('.tool-result-duration')?.textContent, '4.5s', 'the summary totals the steps (3 x 1.5s)');
  const members = memberRows(timeline);
  assert.equal(members.length, 3);
  assert.equal(summary.nextElementSibling, members[0], 'the summary sits directly before its first step');
  assert.ok(members.every((row) => row.getAttribute('data-run-expanded') === 'false'), 'the run starts collapsed');
  assert.ok(members.every((row) => row.parentElement === summary.parentElement), 'members stay flat siblings of the summary');
});

test('the run toggle expands in place, survives a re-render and resets on a view switch', async (t) => {
  const { window, document, send } = await loadApp(t);
  await streamThreeToolTurn(send);
  window.rendererTranscriptViewController.setView(SESSION_ID, 'answers');
  await waitForUi(window, 60);
  const timeline = timelineOf(document);
  runRows(timeline)[0].querySelector('[data-tool-run-toggle]').click();
  assert.equal(runRows(timeline)[0].querySelector('[data-tool-run-toggle]').getAttribute('aria-expanded'), 'true');
  assert.ok(memberRows(timeline).every((row) => row.getAttribute('data-run-expanded') === 'true'), 'every step opens');

  // A second turn re-renders the thread from fresh markup: the keyed morph
  // drops any attribute the new markup lacks, so the planted marker proves the
  // first run's row was rebuilt, and its state must come from the override.
  runRows(timeline)[0].setAttribute('data-test-stale-marker', 'true');
  await streamThreeToolTurn(send);
  const firstRun = runRows(timeline)[0];
  assert.equal(firstRun.hasAttribute('data-test-stale-marker'), false, 'precondition: the first run was re-rendered');
  assert.equal(runRows(timeline).length, 2, 'the second turn adds its own run');
  assert.equal(firstRun.getAttribute('data-run-expanded'), 'true', 'a re-render keeps the override');
  assert.equal(runRows(timeline)[1].getAttribute('data-run-expanded'), 'false', 'the new run starts collapsed');
  const firstRunId = firstRun.getAttribute('data-run-id');
  assert.ok(memberRows(timeline).filter((row) => row.getAttribute('data-run-id') === firstRunId)
    .every((row) => row.getAttribute('data-run-expanded') === 'true'));

  window.rendererTranscriptViewController.setView(SESSION_ID, 'thinking');
  await waitForUi(window, 60);
  window.rendererTranscriptViewController.setView(SESSION_ID, 'answers');
  await waitForUi(window, 60);
  assert.equal(runRows(timeline)[0].getAttribute('data-run-expanded'), 'false', 'a view switch resets the run');

  const toggle = runRows(timeline)[0].querySelector('[data-tool-run-toggle]');
  toggle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(runRows(timeline)[0].getAttribute('data-run-expanded'), 'true', 'Enter toggles the run');
});

test('a live run keeps one summary line, reuses the first step node and settles in place', async (t) => {
  const { window, document, send, waitUntil } = await loadApp(t);
  await streamThreeToolTurn(send);
  window.rendererTranscriptViewController.setView(SESSION_ID, 'answers');
  await waitForUi(window, 60);
  const timeline = timelineOf(document);
  const newestList = () => [...timeline.querySelectorAll('.turn-row-list')].pop();

  const { streamId, emit } = await send('look again');
  await emit(textPhaseStarted(1), 20);
  await emit(textDelta(1, 'Checking.'), 20);
  const first = toolEvents(streamId, 2);
  for (const payload of [...first.start, ...first.finish]) await emit(payload, 10);
  await waitUntil(() => newestList().querySelector(`.chat-row[data-tool-call-id="${first.callId}"]`), 'the first step');
  const firstNode = newestList().querySelector(`.chat-row[data-tool-call-id="${first.callId}"]`);
  assert.equal(runRows(newestList()).length, 0, 'one step is not a run');

  const second = toolEvents(streamId, 3);
  for (const payload of second.start) await emit(payload, 10);
  await waitUntil(() => runRows(newestList()).length === 1, 'the run summary');
  const summary = runRows(newestList())[0];
  assert.equal(newestList().querySelector(`.chat-row[data-tool-call-id="${first.callId}"]`), firstNode,
    'the first step node is reused, not cloned, when the run forms');
  assert.equal(summary.querySelector('.tool-run-row').getAttribute('data-tool-run-state'), 'live');
  assert.match(summary.querySelector('.tool-run-summary').textContent, /call_stream_runs_2_3\.js/, 'the live label names the running step');
  assert.match(summary.textContent, /1 done/);

  for (const payload of second.finish) await emit(payload, 10);
  await waitUntil(() => runRows(newestList())[0]?.querySelector('.tool-run-row')?.getAttribute('data-tool-run-state') === 'ok',
    'the run to settle');
  assert.equal(runRows(newestList())[0].querySelector('.tool-run-summary').textContent, 'Read 2 files');

  await emit(textPhaseStarted(4), 20);
  await emit(textDelta(4, 'Same answer.'), 20);
  await emit(TERMINAL, 80);
  assert.equal(runRows(newestList()).length, 1, 'the settled turn keeps its one run');
  assert.equal(newestList().querySelector(`.chat-row[data-tool-call-id="${first.callId}"]`)?.getAttribute('data-run-member'), 'step');
});

// A run that forms around a tool the user already opened (one tool's details
// open, then a second tool arrives) must keep that tool visible.
async function openFirstToolThenAddSecond(t) {
  const { window, document, send, waitUntil } = await loadApp(t);
  await streamThreeToolTurn(send);
  window.rendererTranscriptViewController.setView(SESSION_ID, 'answers');
  await waitForUi(window, 60);
  const timeline = timelineOf(document);
  const newestList = () => [...timeline.querySelectorAll('.turn-row-list')].pop();
  const rowFor = (callId) => newestList().querySelector(`.chat-row[data-tool-call-id="${callId}"]`);

  const { streamId, emit } = await send('look again');
  await emit(textPhaseStarted(1), 20);
  await emit(textDelta(1, 'Checking.'), 20);
  const first = toolEvents(streamId, 2);
  for (const payload of [...first.start, ...first.finish]) await emit(payload, 10);
  await waitUntil(() => rowFor(first.callId), 'the first step');
  const firstNode = rowFor(first.callId);
  assert.equal(runRows(newestList()).length, 0, 'one step is not a run');

  firstNode.querySelector('[data-tool-row-toggle]').click();
  await waitForUi(window, 20);
  assert.equal(rowFor(first.callId).querySelector('.tool-call-row--minimal').getAttribute('data-expanded'), 'true',
    'precondition: the user opened the first tool');

  const second = toolEvents(streamId, 3);
  for (const payload of second.start) await emit(payload, 10);
  await waitUntil(() => runRows(newestList()).length === 1, 'the run summary');
  return { window, newestList, rowFor, first, firstNode, second, streamId, emit, waitUntil };
}

test('a run forming around an opened tool starts expanded and keeps that tool visible', async (t) => {
  const { newestList, rowFor, first, firstNode } = await openFirstToolThenAddSecond(t);
  const summary = runRows(newestList())[0];
  assert.equal(summary.querySelector('[data-tool-run-toggle]').getAttribute('aria-expanded'), 'true');
  assert.equal(summary.getAttribute('data-run-expanded'), 'true');
  assert.equal(rowFor(first.callId), firstNode, 'the opened tool node is reused when the run forms');
  assert.equal(firstNode.getAttribute('data-run-member'), 'step');
  assert.equal(firstNode.getAttribute('data-run-expanded'), 'true', 'the opened tool is not hidden as a run member');
  assert.equal(firstNode.querySelector('.tool-call-row--minimal').getAttribute('data-expanded'), 'true');
});

test('closing the opened tool afterwards keeps the run expanded for later tools', async (t) => {
  const { window, newestList, rowFor, first, second, streamId, emit, waitUntil } = await openFirstToolThenAddSecond(t);
  rowFor(first.callId).querySelector('[data-tool-row-toggle]').click();
  await waitForUi(window, 20);
  assert.equal(rowFor(first.callId).querySelector('.tool-call-row--minimal').getAttribute('data-expanded'), 'false');

  for (const payload of second.finish) await emit(payload, 10);
  const third = toolEvents(streamId, 4);
  for (const payload of [...third.start, ...third.finish]) await emit(payload, 10);
  await waitUntil(() => newestList().querySelector(`.chat-row[data-tool-call-id="${third.callId}"]`), 'the third step');
  assert.equal(runRows(newestList()).length, 1);
  assert.equal(runRows(newestList())[0].getAttribute('data-run-expanded'), 'true', 'the seeded choice survives');
  const members = memberRows(newestList());
  assert.equal(members.length, 3);
  assert.ok(members.every((row) => row.getAttribute('data-run-expanded') === 'true'), 'closing one tool does not hide the run');
});

test('an explicit run collapse wins over an opened member when another tool arrives', async (t) => {
  const { newestList, first, second, streamId, emit, waitUntil } = await openFirstToolThenAddSecond(t);
  runRows(newestList())[0].querySelector('[data-tool-run-toggle]').click();
  assert.ok(memberRows(newestList()).every((row) => row.getAttribute('data-run-expanded') === 'false'), 'the run collapses');

  for (const payload of second.finish) await emit(payload, 10);
  const third = toolEvents(streamId, 4);
  for (const payload of third.start) await emit(payload, 10);
  await waitUntil(() => newestList().querySelector(`.chat-row[data-tool-call-id="${third.callId}"]`), 'the third step');
  assert.equal(newestList().querySelector(`.chat-row[data-tool-call-id="${first.callId}"] .tool-call-row--minimal`)
    .getAttribute('data-expanded'), 'true', 'precondition: the first tool is still open');
  assert.equal(runRows(newestList())[0].getAttribute('data-run-expanded'), 'false');
  assert.equal(runRows(newestList())[0].querySelector('[data-tool-run-toggle]').getAttribute('aria-expanded'), 'false');
  const members = memberRows(newestList());
  assert.equal(members.length, 3);
  assert.ok(members.every((row) => row.getAttribute('data-run-expanded') === 'false'), 'the explicit collapse still wins');
});
