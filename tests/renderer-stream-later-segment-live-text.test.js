'use strict';

// A later text segment of a tool turn must keep painting while it streams
// (dogfood B15: with thinking off, the segment after a tool result showed its
// first two words and then nothing until the next tool call rendered).
// Through the real shell; wire shapes follow
// tests/renderer-answers-tool-runs-harness.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');

const SESSION_ID = 'sess_later_segment_text';

function toolEvents(streamId, index) {
  const callId = `call_${streamId}_${index}`;
  const usePhase = { type: 'phase_started', phaseId: `phase_tool_use_${streamId}_${callId}`, phaseKind: 'tool_use', toolCallId: callId, toolName: 'read_file' };
  const resultPhase = { type: 'phase_started', phaseId: `phase_tool_result_${streamId}_${callId}`, phaseKind: 'tool_result', toolCallId: callId, toolName: 'read_file' };
  return [
    { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: `${callId}.js` }, status: 'pending' },
    usePhase,
    { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: `${callId}.js` }, status: 'running',
      next_assistant_message_id: `assistant_${streamId}_seg${index}` },
    { ...usePhase, type: 'phase_completed' },
    resultPhase,
    { type: 'tool_result', callId, toolName: 'read_file', status: 'success', content: `contents of ${callId}`, isError: false, durationMs: 1500 },
    { ...resultPhase, type: 'phase_completed' },
  ];
}

function textPhaseStarted(iteration) {
  const phase = { phase_id: `phase_text_iter${iteration}`, phase_kind: 'text', iteration };
  return { type: 'phase_started', phaseId: phase.phase_id, phaseKind: 'text', iteration, phase };
}

function textDelta(iteration, content) {
  return { type: 'delta', content, phase: { phase_id: `phase_text_iter${iteration}`, phase_kind: 'text', iteration } };
}

async function loadApp(t) {
  let streamCount = 0;
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: buildFeatureFlagDefaults() } },
    chat: {
      async startStream(_payload, { state }) {
        streamCount += 1;
        if (!state.sessions.some((session) => session.id === SESSION_ID)) {
          state.sessions = [{ id: SESSION_ID, title: 'Later segment', conversation_mode: 'chat', preferred_model: 'gpt-test',
            updated_at: new Date().toISOString(), linked_session_ids: [],
            context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
          state.messagesBySession.set(SESSION_ID, []);
        }
        return { sessionId: SESSION_ID, streamId: `stream_seg_${streamCount}` };
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
    const streamId = `stream_seg_${streamCount}`;
    let aggregate = '';
    const emit = async (payload, settleMs = 5) => {
      const full = { sessionId: SESSION_ID, streamId, ...payload };
      // The backend's aggregate restarts at each tool-continuation reset.
      if (payload.type === 'stream_reset') aggregate = '';
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

  return { window, document, send };
}

const FIRST_SEGMENT = 'Both tests fail as baseline. Let me trace the parser.\n\n';
const NEW_WORDS = ['Confirmed ', 'the ', 'mechanics. ', 'The ', 'date ', 'parser ', 'drops ', 'a ', 'row. ', 'Let ', 'me ', 'trace ', 'it.'];

function continuationReset(streamId, segmentIndex) {
  return { type: 'stream_reset', reason: 'tool_continuation', next_assistant_message_id: `assistant_${streamId}_seg${segmentIndex}`,
    preserve_prior_segments: true, discard_scope: 'none' };
}

async function streamSecondSegment(t, pieces) {
  const { window, document, send } = await loadApp(t);
  const { streamId, emit } = await send('fix the tests');
  await emit(textPhaseStarted(1), 20);
  await emit(textDelta(1, FIRST_SEGMENT), 20);
  for (const payload of toolEvents(streamId, 1)) await emit(payload, 10);
  await emit(continuationReset(streamId, 1), 10);

  await emit(textPhaseStarted(2), 20);
  // Provider rate: the bridge hands over a coalesced delta every ~16 ms, then
  // the next call's arguments start composing with no gap.
  for (const piece of pieces) await emit(textDelta(2, piece), 2);
  const composing = `call_${streamId}_2`;
  for (let step = 1; step <= 6; step += 1) {
    await emit({ type: 'tool_input_delta', toolCallId: composing, toolName: 'run_command',
      argumentsDelta: '{"command": "python -c ', argumentsBytes: step * 105, sequence: step }, 100);
  }
  // What the reader sees: the segment's own row in the turn's row list. The
  // timeline also holds a hidden thread-compat anchor per message, and the
  // text landing THERE is the defect, so the whole-timeline text proves nothing.
  const row = document.querySelector(
    `#chatTimeline [data-turn-row-list] .chat-row[data-row-kind="assistant_text"][data-source-message-id="assistant_${streamId}_seg1"]`);
  assert.ok(row, 'the later segment has its own text row');
  const anchorText = [...document.querySelectorAll('#chatTimeline .thread-compat-anchor')]
    .map((anchor) => anchor.textContent.trim()).join('');
  return { rowText: row.textContent.replace(/\s+/g, ' ').trim(), anchorText };
}

test('a later text segment keeps painting in its own row while it streams, before the next tool call', async (t) => {
  const { rowText, anchorText } = await streamSecondSegment(t, NEW_WORDS);
  assert.equal(rowText, 'Confirmed the mechanics. The date parser drops a row. Let me trace it.');
  assert.equal(anchorText, '', 'nothing is painted into a hidden anchor');
});

// The dogfood turn: the model opened each segment by repeating its previous
// segment word for word, then went on.
test('a later segment that starts by repeating the previous one paints the words after the repeat', async (t) => {
  const repeat = ['Both ', 'tests ', 'fail ', 'as ', 'baseline. ', 'Let ', 'me ', 'trace ', 'the ', 'parser.\n\n'];
  const { rowText, anchorText } = await streamSecondSegment(t, [...repeat, ...NEW_WORDS]);
  assert.ok(rowText.startsWith('Both tests fail as baseline. Let me trace the parser.'), rowText);
  assert.ok(rowText.endsWith('The date parser drops a row. Let me trace it.'), rowText);
  assert.equal(anchorText, '', 'nothing is painted into a hidden anchor');
});
