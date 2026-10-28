const test = require('node:test');
const assert = require('node:assert/strict');

const { startManagedSidecarChatStream } = require('../../services/backend/managed-sidecar-chat');
const { createManagedChatServiceStub } = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

// A turn-ending tool (propose_session, complete_session_handoff) runs no later generation, so the
// sidecar's chat.done repeats the preamble the model wrote before the call. The tool boundary has
// already persisted that preamble as a segment; applying chat.done's text again stored it twice
// (seen live 2026-10-27 in the primary chat: "..._seg1" and "..._seg2" with identical content).
const PROPOSAL_ID = `proposal_${'a'.repeat(64)}`;
const PREAMBLE = 'The new chat failed on its first turn. Retrying the spawn now.';

async function runTurn({ deltas, responseText }) {
  const service = createManagedChatServiceStub({ featureFlags: { canonical_bridge: true, canonical_turn_events: true } });
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      const notify = (method, params) => options.onNotification({ method, params });
      deltas.forEach((delta, index) => notify('chat.token', { delta, sequence: index + 1 }));
      notify('tool.executing', { tool_call_id: 'call_propose', tool_name: 'propose_session', arguments: {} });
      notify('tool.result', {
        tool_call_id: 'call_propose', tool_name: 'propose_session', success: true, content: 'Offer shown.',
        metadata: { turn_boundary: 'awaiting_proposal', proposal_id: PROPOSAL_ID },
      });
      notify('chat.done', {
        stop_reason: 'end_turn', response_text: responseText, completion_source: 'model',
        completion_reason: 'awaiting_proposal', proposal_id: PROPOSAL_ID,
      });
      return { status: 'completed', response_text: responseText, completion_source: 'model' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_turn_boundary_preamble',
    prompt: 'Spawn a chat', visiblePrompt: 'Spawn a chat', attachments: [],
    runtimePreferredModel: 'mock-v1', normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1', reasoning_effort: 'default', conversation_mode: 'chat', pending_question_batch: null,
      interactive_sequence_state: 'idle', interactive_round_count: 0, plan_mode: false,
    },
  });
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  const assistantText = service.sessionMessages
    .filter((message) => message.role === 'assistant' && !message.kind && String(message.content || '').trim())
    .map((message) => message.content);
  const events = (name) => service.serviceLogs.filter((entry) => entry.event === name);
  const complete = service.emittedEvents.map((entry) => entry.payload).filter((payload) => payload?.type === 'complete');
  return {
    assistantText, complete,
    mismatch: events('chat.terminal_response_text_mismatch'), skipped: events('chat.terminal_response_text_already_persisted'),
  };
}

test('a streamed preamble before a turn-ending tool is stored once', async () => {
  const outcome = await runTurn({ deltas: ['The new chat failed on its first turn. ', 'Retrying the spawn now.'], responseText: PREAMBLE });
  assert.deepEqual(outcome.assistantText, [PREAMBLE]);
  assert.equal(outcome.mismatch.length, 0);
  assert.equal(outcome.skipped.length, 1);
  // The renderer paints complete.content into the bubble after the tool boundary; resending the
  // persisted preamble there showed it twice live (2026-10-27).
  assert.equal(outcome.complete.length, 1);
  assert.equal(outcome.complete[0].content, '');
});

test('a preamble that never streamed (no deltas) still lands from chat.done', async () => {
  const outcome = await runTurn({ deltas: [], responseText: PREAMBLE });
  assert.deepEqual(outcome.assistantText, [PREAMBLE]);
  assert.equal(outcome.skipped.length, 0);
  assert.equal(outcome.complete[0]?.content, PREAMBLE);
});

test('a turn-ending tool with no preamble stores no assistant text', async () => {
  const outcome = await runTurn({ deltas: [], responseText: '' });
  assert.deepEqual(outcome.assistantText, []);
});
