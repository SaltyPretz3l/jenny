'use strict';

// F18 (1.2.0 gate A4 attempts 3 and 4): Pause at a write_file approval, Resume
// (main re-offers the call on a new stream), Allow once, the reply finishes.
// The paused leg's first Thought row must survive the resumed reply's terminal.
// The terminal's carried canonical log holds only the resumed stream's events
// (9 in the gate run, as here); the paused leg's events are persisted only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');
const fixture = require('./fixtures/resumed-paused-turn-session.json');

const SESSION_ID = fixture.session_id;
const A = fixture.paused_stream_id;
const B = fixture.resumed_stream_id;
const TURN_ID = fixture.turn_id;
const CALL_ID = 'Zhw6w8VNX1D0WsSjuVANLKI3W6TRF2or';
const INPUT = { path: 'a4-twelve.txt', content: 'twelve' };
const FIRST_THOUGHT = 'The user wants me to call write_file exactly once with specific arguments. Let me do that.';
const SECOND_THOUGHT = 'The tool call succeeded. The user asked me to write nothing else before the tool call, and I did exactly that. Now I should give a brief confirmation.';
const ANSWER = 'Done. Wrote `twelve` (6 bytes) to `a4-twelve.txt`.';
// The resumed stream's collector carries the user prompt and its own events.
const CARRIED_EVENTS = fixture.turn_events.filter((event) => event.event_seq >= 4);

function reasoningLeg(streamId, iteration, entryId, text) {
  const phaseId = `phase_reasoning_${streamId}_iter${iteration}_1`;
  const thinkingId = `think_${streamId}_iter${iteration}`;
  return [
    { type: 'phase_started', streamId, phaseId, phaseKind: 'reasoning', thinkingId },
    { type: 'delta', streamId, content: '', aggregate: '', thinkingId,
      reasoning: { source: 'provider', entriesDelta: [{ id: entryId, text, thinkingId }] } },
    { type: 'phase_completed', streamId, phaseId, phaseKind: 'reasoning', thinkingId },
  ];
}

test('a resumed paused turn keeps the paused leg\'s first Thought after the reply finishes', async (t) => {
  let persisted = { data: [], turn_events: [], turn_event_log_version: fixture.turn_event_log_version, active_turn: null };
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: buildFeatureFlagDefaults() } },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: SESSION_ID, title: 'A4', conversation_mode: 'chat', preferred_model: 'gpt-test',
          updated_at: new Date().toISOString(), linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
        state.messagesBySession.set(SESSION_ID, []);
        return { sessionId: SESSION_ID, streamId: A, turnId: TURN_ID };
      },
    },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  shell.sessions.getMessages = async () => JSON.parse(JSON.stringify(persisted));
  const emit = async (payload) => {
    await shell.__emitChat({ sessionId: SESSION_ID, turnId: TURN_ID, ...payload });
    await waitForUi(window, 40);
  };

  const input = doc.getElementById('chatInput');
  input.value = fixture.messages[0].content;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);

  // Paused leg: reasoning, then the write_file call waits for approval. Pause
  // ends this stream with no terminal event.
  await emit({ type: 'started', streamId: A });
  for (const payload of reasoningLeg(A, 1, 'reasoning_1790271701331_0_b283e9', FIRST_THOUGHT)) await emit(payload);
  await emit({ type: 'tool_use', streamId: A, callId: CALL_ID, toolName: 'write_file', summary: 'Write a4-twelve.txt',
    input: INPUT, status: 'pending_approval' });
  await emit({ type: 'tool_approval_needed', streamId: A, callId: CALL_ID, approvalId: 'approval-a',
    toolName: 'write_file', input: INPUT });

  // Resumed leg: main re-offers the call on a new stream; Allow once; the reply.
  await emit({ type: 'started', streamId: B });
  await emit({ type: 'tool_use', streamId: B, callId: CALL_ID, toolName: 'write_file', summary: 'Write a4-twelve.txt',
    input: INPUT, status: 'pending_approval' });
  await emit({ type: 'tool_approval_needed', streamId: B, callId: CALL_ID, approvalId: 'approval-b',
    toolName: 'write_file', input: INPUT });
  await emit({ type: 'tool_result', streamId: B, callId: CALL_ID, toolName: 'write_file', status: 'success',
    output: 'Wrote 6 bytes to a4-twelve.txt' });
  for (const payload of reasoningLeg(B, 2, 'reasoning_1790271721464_0_5336e6', SECOND_THOUGHT)) await emit(payload);
  await emit({ type: 'delta', streamId: B, content: ANSWER, aggregate: ANSWER });

  persisted = { data: fixture.messages, turn_events: fixture.turn_events,
    turn_event_log_version: fixture.turn_event_log_version, active_turn: null };
  await emit({ type: 'complete', streamId: B, content: ANSWER, canonicalTurnEvents: CARRIED_EVENTS });
  await waitForUi(window, 300);

  const turnText = [...doc.querySelectorAll('#chatTimeline .chat-entry')]
    .filter((entry) => !entry.classList.contains('user'))
    .map((entry) => entry.textContent.replace(/\s+/g, ' '))
    .join(' ');
  const firstThought = turnText.indexOf('The user wants me to call write_file exactly once');
  const writeRow = turnText.indexOf('a4-twelve.txt');
  const secondThought = turnText.indexOf('The tool call succeeded.');
  const answer = turnText.indexOf('Done. Wrote twelve');
  assert.ok(firstThought >= 0, 'the paused leg\'s first Thought row survives');
  assert.ok(writeRow > firstThought, 'the Write row follows the first Thought');
  assert.ok(secondThought > writeRow, 'the resumed leg\'s Thought follows the Write row');
  assert.ok(answer > secondThought, 'the answer ends the turn');

  const staleDeletions = (window.__rendererState.logs || [])
    .filter((entry) => entry?.data?.signal === 'stale_row_deletion');
  assert.equal(staleDeletions.length, 0,
    `the terminal reconcile deletes no row: ${JSON.stringify(staleDeletions.map((entry) => entry.data.staleRowKeys))}`);
  const hoverMeta = [...doc.querySelectorAll('#chatTimeline .chat-hover-meta')].at(-1);
  assert.match(hoverMeta?.getAttribute('title') || '', /^Completed /, 'the settled turn still reads Completed');
});
