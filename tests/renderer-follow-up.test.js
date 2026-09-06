const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');
const { syncFollowUpOpenLoops } = require('./helpers/renderer-shell-harness-companion');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

const FOLLOW_UP_REPLY = [
  'We still need to verify the final migration and run the policy checks before handoff.',
  'Capture the packaging smoke result, compare the manifest and atlas checks, and leave a short note about any follow-up risk so the next review has enough context to continue without rediscovering the same state.',
  'Once those checks are green, the migration handoff can move forward cleanly.',
].join(' ');

function clipMessagePreview(value, maxLength = 120) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trim()}...`
    : normalized;
}

test('renderer follow-up harness orders deferred loops by parsed timestamps', () => {
  const companionState = syncFollowUpOpenLoops({
    followUps: [
      {
        id: 'later-instant',
        status: 'deferred',
        deferredUntil: '2026-03-20T09:30:00Z',
      },
      {
        id: 'earlier-instant',
        status: 'deferred',
        deferredUntil: '2026-03-20T10:00:00+02:00',
      },
    ],
  });

  assert.deepEqual(
    companionState.openLoopsBoard.deferred.map((followUp) => followUp.followUpId),
    ['earlier-instant', 'later-instant'],
    'deferred follow-ups must be ordered by their parsed timestamps'
  );
});

test('renderer follow up action captures an assistant reply as an open loop and updates Home', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = payload.sessionId || 'session-1';
          if (!state.sessions.find((session) => session.id === sessionId)) {
            state.sessions = [{
              id: sessionId,
              title: 'New Chat',
              conversation_mode: payload.conversationMode || 'chat',
              preferred_model: payload.preferredModel || 'gpt-test',
              reasoning_effort: payload.reasoningEffort || 'default',
              context_preferences: {
                history_scope: payload?.contextPreferences?.historyScope || 'session',
                include_personality: payload?.contextPreferences?.includePersonality !== false,
                include_memory: payload?.contextPreferences?.includeMemory !== false,
              },
              interactive_round_count: 0,
              interactive_sequence_state: 'idle',
              pending_question_batch: null,
              updated_at: new Date().toISOString(),
            }];
          }
          state.messagesBySession.set(sessionId, [
            {
              id: 'user_stream-followup-1',
              role: 'user',
              content: payload.visiblePrompt || payload.prompt,
              status: 'complete',
            },
            {
              id: 'assistant_stream-followup-1',
              role: 'assistant',
              content: '',
              status: 'streaming',
              streamId: 'stream-followup-1',
              finalizedAt: null,
            },
          ]);
          return {
            sessionId,
            streamId: 'stream-followup-1',
          };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Summarize the migration status';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  shell.__state.messagesBySession.set('session-1', [
    {
      id: 'user_stream-followup-1',
      role: 'user',
      content: 'Summarize the migration status',
      status: 'complete',
    },
    {
      id: 'assistant_stream-followup-1',
      role: 'assistant',
      content: FOLLOW_UP_REPLY,
      status: 'complete',
      streamId: 'stream-followup-1',
      finalizedAt: new Date().toISOString(),
    },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-followup-1',
    content: FOLLOW_UP_REPLY,
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 30);

  const followUpButton = window.document.querySelector(
    '[data-message-action="follow-up"][data-message-id="assistant_stream-followup-1"]'
  );
  assert.ok(followUpButton);

  followUpButton.click();
  await waitForUi(window, 30);

  assert.equal(shell.__state.companionCalls.addFollowUp.length, 1);
  assert.equal(
    shell.__state.companionCalls.addFollowUp[0].label,
    clipMessagePreview(FOLLOW_UP_REPLY, 60)
  );
  assert.equal(
    shell.__state.companionCalls.addFollowUp[0].body,
    clipMessagePreview(FOLLOW_UP_REPLY, 120)
  );
  assert.equal(shell.__state.companionCalls.addFollowUp[0].sessionId, 'session-1');
  assert.equal(shell.__state.companionCalls.addFollowUp[0].status, 'active');
  assert.match(
    window.document.getElementById('toastViewport').textContent || '',
    /saved to open loops/i
  );

  window.document.getElementById('homeTopRailTab').click();
  await waitForUi(window, 30);

  assert.match(
    window.document.getElementById('homeOpenLoopList').textContent,
    /We still need to verify the final migration/i
  );
});
