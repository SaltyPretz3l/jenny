'use strict';

// The suggest_next_step card through the real renderer shell (jsdom): a live stream delivers the call and
// its result metadata, the card waits for the reply to finish, a click sends the action's message through
// the pane's send path, and a newer message settles every live card. Layout is the owner's real-app gate.
// Wire shapes follow tests/renderer-answers-tool-runs-harness.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');
const suggestNextStepTool = require('../services/tools/builtin/suggest-next-step-tool');
const { normalizePersistedToolResultMetadata } = require('../services/backend/tool-result-diff-metadata');

const SESSION_ID = 'sess_next_step';
const INPUT = {
  recap: 'Fixed the parser; the 14 parser tests pass.',
  question: 'Commit this now?',
  actions: [
    { label: 'Commit', message: 'Commit the parser fix.' },
    { label: 'Show diff', message: 'Show me the diff first.' },
  ],
};
const TERMINAL = { type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' };

const textPhase = (iteration) => ({ type: 'phase_started', phaseId: `phase_text_iter${iteration}`, phaseKind: 'text', iteration,
  phase: { phase_id: `phase_text_iter${iteration}`, phase_kind: 'text', iteration } });
const textDelta = (iteration, content) => ({ type: 'delta', content, phase: { phase_id: `phase_text_iter${iteration}`, phase_kind: 'text', iteration } });

async function loadApp(t) {
  const startPayloads = [];
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: buildFeatureFlagDefaults() } },
    chat: {
      async startStream(payload, { state }) {
        startPayloads.push(payload);
        if (!state.sessions.some((session) => session.id === SESSION_ID)) {
          state.sessions = [{ id: SESSION_ID, title: 'Next step', conversation_mode: 'chat', preferred_model: 'gpt-test',
            updated_at: new Date().toISOString(), linked_session_ids: [],
            context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
          state.messagesBySession.set(SESSION_ID, []);
        }
        return { sessionId: SESSION_ID, streamId: `stream_next_${startPayloads.length}` };
      },
    },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const document = window.document;

  async function typeAndSend(text) {
    const input = document.getElementById('chatInput');
    input.value = text;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.getElementById('sendButton').click();
    await waitForUi(window, 30);
  }

  async function send(text) {
    await typeAndSend(text);
    const streamId = `stream_next_${startPayloads.length}`;
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

  // The tool result as the live stream carries it: the metadata the real tool returned, through the
  // persistence allowlist the backend applies before it reaches the renderer.
  async function nextStepTurn(prompt, { finish = true } = {}) {
    const { metadata } = await suggestNextStepTool.execute(INPUT, {});
    const { streamId, emit } = await send(prompt);
    const callId = `call_next_${streamId}`;
    await emit(textPhase(1), 20);
    await emit(textDelta(1, 'Parser is fixed.'), 20);
    await emit({ type: 'tool_use', callId, toolName: 'suggest_next_step', summary: 'Suggested a next step', input: INPUT, status: 'pending' }, 10);
    await emit({ type: 'tool_use', callId, toolName: 'suggest_next_step', summary: 'Suggested a next step', input: INPUT, status: 'running',
      next_assistant_message_id: `assistant_${streamId}_seg2` }, 10);
    await emit({ type: 'tool_result', callId, toolName: 'suggest_next_step', status: 'success', content: 'The next-step card is shown.',
      isError: false, durationMs: 3, metadata: normalizePersistedToolResultMetadata(metadata) }, 40);
    await emit(textPhase(3), 20);
    await emit(textDelta(3, 'All done.'), 20);
    if (finish) await emit(TERMINAL, 80);
    return { callId, streamId, emit };
  }

  const waitUntil = async (predicate, label) => {
    for (let waited = 0; !predicate(); waited += 10) {
      assert.ok(waited < 3000, `timed out waiting for ${label}`);
      await waitForUi(window, 10);
    }
  };
  return { window, document, startPayloads, typeAndSend, nextStepTurn, waitUntil };
}

const cards = (document) => [...document.querySelectorAll('#chatTimeline .next-step-card')];
const buttons = (card) => [...card.querySelectorAll('.next-step-action')];

test('the live result draws the card at the end of the reply; its buttons wait for the stream to finish', async (t) => {
  const { document, nextStepTurn, waitUntil } = await loadApp(t);
  await nextStepTurn('Fix the parser', { finish: false });
  await waitUntil(() => cards(document).length === 1, 'the card');
  const [card] = cards(document);
  assert.equal(card.querySelector('.next-step-recap').textContent, INPUT.recap, 'the live metadata reaches the row');
  assert.equal(card.getAttribute('data-state'), 'live');
  assert.deepEqual(buttons(card).map((button) => button.disabled), [true, true], 'disabled while the reply streams');
  assert.equal(document.querySelector('#chatTimeline .tool-call-row[data-tool-call-id]'), null, 'no generic tool row for the call');
});

test('after the reply finishes the buttons enable and a click sends the action message once', async (t) => {
  const { document, startPayloads, nextStepTurn, waitUntil } = await loadApp(t);
  await nextStepTurn('Fix the parser');
  await waitUntil(() => buttons(cards(document)[0] || document.body).length === 2 && !buttons(cards(document)[0])[0].disabled, 'enabled buttons');
  const card = cards(document)[0];
  assert.equal(card.closest('.chat-row').parentElement.classList.contains('turn-row-list'), true, 'a direct row of the turn list');
  assert.equal(card.closest('.chat-row').getAttribute('data-run-member'), null);

  const before = startPayloads.length;
  // A real pointer hovers first: the app tooltip layer moves `title` to data-tooltip on mouseenter.
  buttons(card)[0].dispatchEvent(new card.ownerDocument.defaultView.MouseEvent('mouseenter'));
  buttons(card)[0].click();
  assert.equal(card.getAttribute('data-state'), 'picked');
  buttons(card)[0]?.click();
  await waitForUi(card.ownerDocument.defaultView, 80);
  assert.equal(startPayloads.length, before + 1, 'exactly one send');
  assert.equal(startPayloads[before].prompt ?? startPayloads[before].message ?? startPayloads[before].content, 'Commit the parser fix.');
  const settled = cards(document)[0];
  assert.equal(settled.getAttribute('data-state'), 'picked');
  assert.equal(settled.querySelector('.next-step-receipt').textContent, 'You chose Commit');
  assert.equal(settled.querySelector('.next-step-action'), null);
});

test('a message typed in the composer settles the live card as passed', async (t) => {
  const { document, typeAndSend, nextStepTurn, waitUntil } = await loadApp(t);
  await nextStepTurn('Fix the parser');
  await waitUntil(() => cards(document).length === 1 && !buttons(cards(document)[0])[0]?.disabled, 'live card');
  await typeAndSend('Something else entirely');
  await waitUntil(() => cards(document)[0]?.getAttribute('data-state') !== 'live', 'the card to settle');
  const card = cards(document)[0];
  assert.equal(card.getAttribute('data-state'), 'passed');
  assert.equal(card.querySelector('.next-step-action'), null);
  assert.equal(card.querySelector('.next-step-question'), null);
});
