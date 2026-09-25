'use strict';

// F16 (1.2.0 gate A7 attempt 3): after a renderer reload the ask_user card that
// main still waits on must come back. The fixture is the real A7 session; main
// persists a turn's assistant rows only as they settle, so a reload seconds into
// the turn finds just the user prompt on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const fixture = require('./fixtures/reload-pending-ask-user-session.json');

const SESSION_ID = fixture.session_id;
const TOOL_USE = fixture.messages.find((message) => message.kind === 'tool_use');
const CALL_ID = TOOL_USE.tool_call.call_id;
const QUESTIONS = TOOL_USE.tool_call.input.questions;
const SUMMARY = { id: SESSION_ID, title: 'Season', conversation_mode: 'chat', preferred_model: 'gpt-test',
  updated_at: new Date().toISOString(), linked_session_ids: [],
  context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } };

// getManagedActiveTurnState spreads the stored active turn into the snapshot.
async function getActiveTurnState(sessionId) {
  if (sessionId !== SESSION_ID) return null;
  return { ...fixture.active_turn, session_id: SESSION_ID, state: 'streaming',
    pending_user_questions: [{ question_id: 'question_live', question_ref: 'question_ref_live',
      call_id: CALL_ID, tool_name: 'ask_user', questions: QUESTIONS }] };
}

for (const [label, messageCount, eventCount] of [
  ['just the user prompt', 1, 1],
  ['the prompt and reasoning', 2, 2],
  ['every row so far', 3, 4],
]) {
  test(`a reload with ${label} persisted brings the question card back`, async (t) => {
    const app = await loadRendererApp({ shell: {
      sessions: [SUMMARY],
      workspaceState: { activeSessionId: SESSION_ID, openSessionIds: [SESSION_ID] },
      sessionMessagePayloads: { [SESSION_ID]: {
        data: fixture.messages.slice(0, messageCount),
        turn_events: fixture.turn_events.slice(0, eventCount),
        active_turn: fixture.active_turn,
      } },
      chat: { getActiveTurnState },
    } });
    t.after(() => app.dispose());
    const { window } = app;
    await waitForUi(window, 150);
    assert.equal(window.__rendererState.currentSessionId, SESSION_ID);
    const card = window.document.querySelector('.user-questions-block');
    assert.ok(card, 'the question card is back');
    assert.match(card.textContent, /Which season do you prefer\?/);
    assert.ok(card.querySelector('button:not([disabled])'), 'the card is interactive');
  });
}

// F25 (A7 attempt 4): main persists a live turn's events only when it settles,
// so a reload while the question waits finds the Thought and ask_user messages
// on disk but no turn_events for the turn. The reloaded turn must still show
// its Thought row above the live card, as it did before the reload.
for (const [label, messageCount] of [['reasoning', 2], ['reasoning and the ask_user call', 3]]) {
  test(`a reload with ${label} persisted but no turn events keeps the Thought row above the card`, async (t) => {
    const answers = [];
    const app = await loadRendererApp({ shell: {
      sessions: [SUMMARY],
      workspaceState: { activeSessionId: SESSION_ID, openSessionIds: [SESSION_ID] },
      sessionMessagePayloads: { [SESSION_ID]: {
        data: fixture.messages.slice(0, messageCount),
        turn_events: [],
        turn_event_log_version: 1,
        active_turn: fixture.active_turn,
      } },
      chat: { getActiveTurnState },
    } });
    t.after(() => app.dispose());
    Object.assign(app.shell.chat, {
      async hasPendingUserQuestions() { return true; },
      async answerUserQuestions(ref, payload) { answers.push({ ref, payload }); return { ok: true }; },
    });
    const { window } = app;
    const doc = window.document;
    await waitForUi(window, 150);
    const entries = [...doc.querySelectorAll('#chatTimeline .chat-entry')];
    const thoughtIndex = entries.findIndex((entry) => /The user wants me to use the ask_user tool/.test(entry.textContent));
    const cardIndex = entries.findIndex((entry) => entry.querySelector('.user-questions-block'));
    assert.ok(thoughtIndex >= 0, 'the Thought row survives the reload');
    assert.ok(cardIndex >= 0, 'the question card is back');
    assert.ok(thoughtIndex <= cardIndex, 'the Thought row sits above the card');

    const card = doc.querySelector('.user-questions-block');
    const winter = card.querySelector('[data-user-question-option][value="winter"]');
    winter.closest('label').click();
    card.querySelector('.user-questions-submit-btn').click();
    await waitForUi(window, 60);
    assert.equal(answers.length, 1, 'answering still reaches main');
    assert.match(JSON.stringify(answers[0].payload), /winter/);
    assert.match(doc.getElementById('chatTimeline').textContent, /The user wants me to use the ask_user tool/);
  });
}
