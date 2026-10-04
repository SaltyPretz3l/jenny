'use strict';

/* CTR-010 end to end: two panes, each with settled reasoning.
 *
 * Expanding pane 0's reasoning disclosure, then letting pane 1 render (the
 * pane composition's renderSessionPane), used to wipe pane 0's entries from the
 * single shared ThinkingPanelController, so the next click on pane 0's
 * disclosure computed from the collapsed default and "opened" it again
 * (aria-expanded false -> true -> true -> true). Each pane now owns its
 * controller, so the second click closes it. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function buildSummary(id, title) {
  return {
    id,
    title,
    session_type: 'chat',
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    plan_mode: false,
    pinned: false,
    archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [],
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function transcript(sessionId, text) {
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Question for ${text}`, status: 'complete' },
    {
      id: `assistant_${sessionId}`,
      role: 'assistant',
      content: `Answer from ${text}.`,
      status: 'complete',
      finalizedAt: new Date().toISOString(),
      reasoning: {
        source: 'provider',
        status: 'complete',
        entries: [{ text: `Reasoning about ${text}`, thinkingId: `tid_${sessionId}` }],
      },
    },
  ];
}

test('rendering pane 1 does not wipe pane 0 reasoning disclosure state: the second click closes it', async (t) => {
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
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'precondition: the split opens session-b beside');
  await waitForUi(window, 150);
  const pane1 = composition.getPane(1);
  assert.ok(pane1, 'pane 1 is mounted');
  assert.equal(window.__rendererState.panes.panes[1].sessionId, 'session-b');

  const toggleIn = (timeline) => timeline.querySelector('[data-reasoning-toggle="true"]');
  const pane0Timeline = doc.getElementById('chatTimeline');
  const toggle0 = () => toggleIn(pane0Timeline);
  const toggle1 = () => toggleIn(pane1.dom.chatTimeline);
  assert.ok(toggle0(), 'precondition: pane 0 renders a reasoning disclosure');
  assert.ok(toggle1(), 'precondition: pane 1 renders a reasoning disclosure');
  assert.equal(toggle0().getAttribute('aria-expanded'), 'false');
  assert.equal(toggle1().getAttribute('aria-expanded'), 'false');

  const observed = [toggle0().getAttribute('aria-expanded')];
  toggle0().click();
  await waitForUi(window, 40);
  observed.push(toggle0().getAttribute('aria-expanded'));
  assert.equal(observed[1], 'true', 'the first click opens pane 0 disclosure');

  // Pane 1 renders (the stream handler routes a keyed messages render to it).
  assert.equal(composition.renderSessionPane('session-b', 'messages'), true);
  await waitForUi(window, 40);
  assert.equal(toggle0().getAttribute('aria-expanded'), 'true', 'pane 0 DOM is untouched by pane 1 render');

  toggle0().click();
  await waitForUi(window, 40);
  observed.push(toggle0().getAttribute('aria-expanded'));
  assert.deepEqual(observed, ['false', 'true', 'false'], 'open then closed, not open then open again');

  // Pane 1's own disclosure is independent of pane 0's.
  assert.equal(toggle1().getAttribute('aria-expanded'), 'false');
  toggle1().click();
  await waitForUi(window, 40);
  assert.equal(toggle1().getAttribute('aria-expanded'), 'true', 'pane 1 opens through its own controller');
  assert.equal(toggle0().getAttribute('aria-expanded'), 'false', 'pane 0 stays closed');
  assert.equal(composition.renderSessionPane('session-a', 'messages'), true);
  await waitForUi(window, 40);
  assert.equal(toggle1().getAttribute('aria-expanded'), 'true', 'rendering pane 0 does not wipe pane 1 either');
  // The click reached pane 1 without focusing it (no pointerdown): the saved
  // preference still belongs to pane 1's session, so its own re-render keeps it.
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'precondition: pane 0 is still the focused pane');
  assert.equal(composition.renderSessionPane('session-b', 'messages'), true);
  await waitForUi(window, 40);
  assert.equal(toggle1().getAttribute('aria-expanded'), 'true', 'pane 1 re-render restores its own saved disclosure');
  toggle1().click();
  await waitForUi(window, 40);
  assert.equal(toggle1().getAttribute('aria-expanded'), 'false');
});
