'use strict';

// F27 (1.2.0 gate B1 attempt 5): after a turn ended in a resumable stop, its
// Resume, Edit, Branch and Regenerate stayed disabled ("Wait for the current
// response to finish...") while the app was idle. Terminal postwork keeps the
// session send-busy until its last stage (the memory suggestion round-trip,
// 96 ms and 337 ms in the gate's shell.log) returns. The postwork's own
// messages render drained inside that window and baked the busy gate into the
// markup; closing the window re-rendered only the composer, and the timeline's
// render signature did not cover the gate, so later renders were no-ops.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');
const fixture = require('./fixtures/resumed-paused-turn-session.json');

const BUDGET_STOP = "Stopped: this turn's context budget is used up. Reply 'resume' to continue.";
const BUSY = /Wait for the current response to finish/;

// The gate's memory suggestion call outlived a frame; this one does too.
async function slowMemorySuggestion() {
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  return { suggestions: [] };
}

async function loadApp(t, { sessionId, streamId, turnId, flags }) {
  const app = await loadRendererApp({ shell: {
    ...(flags ? { features: { state: { featureFlags: flags } } } : {}),
    memory: { suggestForSession: slowMemorySuggestion },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: sessionId, title: sessionId, conversation_mode: 'chat', preferred_model: 'gpt-test',
          updated_at: new Date().toISOString(), linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
        state.messagesBySession.set(sessionId, []);
        return { sessionId, streamId, ...(turnId ? { turnId } : {}) };
      },
    },
  } });
  t.after(() => app.dispose());
  return app;
}

async function send(window, text) {
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 40);
}

function assertFollowUpsEnabled(doc, { regenerate = true } = {}) {
  const resume = doc.querySelector('#chatTimeline .resume-turn-action');
  assert.ok(resume, 'the stop offers Resume');
  assert.equal(resume.disabled, false, 'Resume is enabled once the turn has settled');
  const labels = [/^Edit and resend/, /^Branch from here/, ...(regenerate ? [/^Regenerate this response/] : [])];
  for (const label of labels) {
    const button = [...doc.querySelectorAll('#chatTimeline .chat-hover-action')]
      .find((node) => label.test(node.getAttribute('title') || ''));
    assert.ok(button, `${label} is offered and not gated busy`);
    assert.equal(button.disabled, false, `${label} is enabled`);
  }
  const busy = [...doc.querySelectorAll('#chatTimeline [title]')]
    .filter((node) => BUSY.test(node.getAttribute('title') || ''));
  assert.deepEqual(busy.map((node) => node.className), [], 'no timeline control still reads busy');
}

test('a context-budget stop leaves Resume and the follow-up actions enabled', async (t) => {
  const sessionId = 'budget-stop-session';
  const streamId = 'stream-budget-stop';
  const app = await loadApp(t, { sessionId, streamId });
  const { window, shell } = app;
  const content = `Working on it.\n\n${BUDGET_STOP}`;
  const now = new Date().toISOString();
  shell.sessions.getMessages = async () => ({ data: [
    { id: `user_${streamId}`, role: 'user', content: 'Write the tutorial', timestamp: now },
    { id: `assistant_${streamId}`, role: 'assistant', content, timestamp: now, finalizedAt: now,
      parent_stream_id: streamId, resumable_stop: 'context_budget', model_used: 'gpt-test' },
  ] });
  const emit = async (payload) => {
    await shell.__emitChat({ sessionId, streamId, ...payload });
    await waitForUi(window, 40);
  };

  await send(window, 'Write the tutorial');
  await emit({ type: 'started' });
  await emit({ type: 'delta', content: 'Working on it.', aggregate: 'Working on it.' });
  await emit({ type: 'complete', content, resumableStop: 'context_budget' });
  await waitForUi(window, 500);

  assertFollowUpsEnabled(window.document);
});

test('a budget stop on an approval-resumed second stream leaves the follow-ups enabled', async (t) => {
  const sessionId = fixture.session_id;
  const A = fixture.paused_stream_id;
  const B = fixture.resumed_stream_id;
  const turnId = fixture.turn_id;
  const callId = 'Zhw6w8VNX1D0WsSjuVANLKI3W6TRF2or';
  const input = { path: 'a4-twelve.txt', content: 'twelve' };
  const content = `Done. Wrote \`twelve\` (6 bytes) to \`a4-twelve.txt\`.\n\n${BUDGET_STOP}`;
  const app = await loadApp(t, { sessionId, streamId: A, turnId, flags: buildFeatureFlagDefaults() });
  const { window, shell } = app;
  let persisted = { data: [], turn_events: [], turn_event_log_version: fixture.turn_event_log_version, active_turn: null };
  shell.sessions.getMessages = async () => JSON.parse(JSON.stringify(persisted));
  const emit = async (payload) => {
    await shell.__emitChat({ sessionId, turnId, ...payload });
    await waitForUi(window, 40);
  };

  await send(window, fixture.messages[0].content);
  // Paused leg: the call waits for approval and the stream gets no terminal.
  await emit({ type: 'started', streamId: A });
  await emit({ type: 'tool_use', streamId: A, callId, toolName: 'write_file', summary: 'Write a4-twelve.txt',
    input, status: 'pending_approval' });
  await emit({ type: 'tool_approval_needed', streamId: A, callId, approvalId: 'approval-a', toolName: 'write_file', input });
  // Resumed leg on a second stream id: Allow once, then the budget stop.
  await emit({ type: 'started', streamId: B });
  await emit({ type: 'tool_use', streamId: B, callId, toolName: 'write_file', summary: 'Write a4-twelve.txt',
    input, status: 'pending_approval' });
  await emit({ type: 'tool_approval_needed', streamId: B, callId, approvalId: 'approval-b', toolName: 'write_file', input });
  await emit({ type: 'tool_result', streamId: B, callId, toolName: 'write_file', status: 'success',
    output: 'Wrote 6 bytes to a4-twelve.txt' });
  await emit({ type: 'delta', streamId: B, content, aggregate: content });

  const messages = fixture.messages.map((message) => (message.id === `assistant_${B}`
    ? { ...message, content, resumable_stop: 'context_budget' }
    : message));
  persisted = { data: messages, turn_events: fixture.turn_events,
    turn_event_log_version: fixture.turn_event_log_version, active_turn: null };
  await emit({ type: 'complete', streamId: B, content, resumableStop: 'context_budget',
    canonicalTurnEvents: fixture.turn_events.filter((event) => event.event_seq >= 4) });
  await waitForUi(window, 500);

  assert.deepEqual([...window.__rendererState.pendingStreams.keys()], [], 'no stream of the turn is still pending');
  // Regenerate is left out: on this two-stream turn it reads "only available
  // for the latest assistant reply" with or without F27, a separate gate.
  assertFollowUpsEnabled(window.document, { regenerate: false });
});
