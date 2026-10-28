const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildWakeRequest } = require('../services/chat-messaging-wake');
const { normalizeRequestApplicationTurn } = require('../services/backend/application-turns');
const { assertRegenerateAnchorAdmissible } = require('../services/backend/chat-turn-admission');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { createManagedChatServiceStub } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const actions = require('../renderer/chat/chat-bubble-action-utils');
const { resolveHandoffPreparationErrorNotice } = require('../renderer/chat/renderer-turn-row-model-utils');
const { createArticleMarkupPipeline } = require('../renderer/chat/renderer-render-pipeline-article-markup');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const stringUtils = require('../renderer/shared/string-utils');

// Owner pick A (/po-review quiet system turns, 2026-10-27): an app-started turn is not the
// person's message. Wake and New session preparation turns draw no row (the mail card or the
// proposal card says why they ran), a child's auto-resume keeps one quiet line, and Retry/Edit
// never replay an app label as an ordinary prompt.

test('a wake request is marked; only known markers cross into a chat request', () => {
  const request = buildWakeRequest({ destination: 'session-jenny', kind: 'report' }, { run_mode: 'ask' }, 'Review latest commits');
  assert.equal(request.applicationTurn, 'wake');
  assert.equal(request.visiblePrompt, 'Woken by a report from Review latest commits');
  assert.equal(normalizeRequestApplicationTurn('wake'), 'wake');
  assert.equal(normalizeRequestApplicationTurn('auto_resume'), 'auto_resume');
  assert.equal(normalizeRequestApplicationTurn('handoff_preparation'), '', 'preparation is marked only by its trusted field');
  assert.equal(normalizeRequestApplicationTurn('anything'), '');
});

test('the persisted user row of a wake turn carries application_turn', async () => {
  const service = createManagedChatServiceStub({ featureFlags: { canonical_bridge: true, canonical_turn_events: true } });
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'The review finished.', sequence: 1 } });
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn', response_text: 'The review finished.', completion_source: 'model' } });
      return { status: 'completed', response_text: 'The review finished.', completion_source: 'model' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_wake_marker', prompt: 'A chat linked to you finished a turn.',
    visiblePrompt: 'Woken by a report from Review', attachments: [], applicationTurn: 'wake',
    runtimePreferredModel: 'mock-v1', normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1', reasoning_effort: 'default', conversation_mode: 'chat', pending_question_batch: null,
      interactive_sequence_state: 'idle', interactive_round_count: 0, plan_mode: false,
    },
  });
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  const userRow = service.sessionMessages.find((message) => message.role === 'user');
  assert.equal(userRow.application_turn, 'wake');
  assert.equal(userRow.content, 'Woken by a report from Review');
});

test('Retry and Edit of a wake or auto-resume anchor are refused; ordinary anchors pass', () => {
  const store = (messages) => ({ sessionStore: { getSession: () => ({ messages }) } });
  for (const kind of ['wake', 'auto_resume']) {
    assert.throws(
      () => assertRegenerateAnchorAdmissible(store([{ id: 'u1', role: 'user', application_turn: kind }]), 's', 'u1'),
      (error) => error.code === 'application_turn_retry_refused' && error.retryable === false && error.message === 'Send a message to continue.',
    );
  }
  assert.throws(() => assertRegenerateAnchorAdmissible(store([{ id: 'u1', role: 'user', application_turn: 'handoff_preparation' }]), 's', 'u1'),
    (error) => error.code === 'handoff_preparation_retry_refused');
  assert.doesNotThrow(() => assertRegenerateAnchorAdmissible(store([{ id: 'u1', role: 'user', content: 'hi' }]), 's', 'u1'));
});

test('the renderer offers no Edit or Retry on an app-started turn', () => {
  const anchor = { id: 'u1', role: 'user', content: 'Woken by a report from Review', application_turn: 'wake', status: 'complete' };
  const reply = { id: 'a1', role: 'assistant', content: 'The review finished.', status: 'complete' };
  const messages = [anchor, reply];
  assert.equal(actions.applicationTurnOf(anchor), 'wake');
  assert.equal(actions.applicationTurnOf({ ...anchor, role: 'assistant' }), '');
  assert.equal(actions.applicationTurnOf({ ...anchor, application_turn: 'other' }), '');
  const regenerate = actions.resolveRegenerateRequest('a1', messages, { latestReplyAssistantMessageId: 'a1' });
  assert.equal(regenerate.allowed, false);
  assert.equal(regenerate.reason, 'Send a message to continue.');
  const model = actions.buildMessageActionModel(anchor, { messages });
  assert.equal(model.actions.edit.visible, false);
  assert.equal(resolveHandoffPreparationErrorNotice({ id: 'a1' }, [{ ...anchor, application_turn: 'auto_resume' }, reply]), true,
    'a failed app-started turn shows no Retry on its error card');
  assert.equal(resolveHandoffPreparationErrorNotice({ id: 'a1' }, [{ ...anchor, application_turn: undefined }, reply]), false);
});

const REPORT_ENVELOPE = {
  schema_version: 1, message_id: 'msg-report', source_session_id: 'session-child', source_session_incarnation: 'inc-child',
  source_project_id: 'project-ron', destination_session_id: 'session-jenny', destination_session_incarnation: 'inc-jenny',
  destination_project_id: null, source_turn_id: null, kind: 'terminal_report', created_at: '2026-10-27T18:18:00.000Z',
  body: 'Two issues found.', body_sha256: 'a'.repeat(64), report: { outcome: 'completed' },
};

function pipelineFor(sessionRole) {
  return createArticleMarkupPipeline({
    state: {
      currentSessionId: 'session-jenny',
      sessions: [{ id: 'session-jenny', title: 'Jenny', session_role: sessionRole }, { id: 'session-child', title: 'Review latest commits' }],
      ui: {},
    },
    callbacks: {
      escapeHtml: stringUtils.escapeHtml,
      buildMessageShellArticle: ({ className, messageRole, innerHtml }) => `<article class="${className}" data-message-role="${messageRole}">${innerHtml}</article>`,
      buildMessageBodyShell: (_id, innerHtml) => innerHtml,
      renderMessageHoverRow: () => '<div class="hover-row">actions</div>',
      renderMarkdown: (text) => `<p>${text}</p>`,
    },
  });
}

function wakeTurn(kind = 'wake') {
  return normalizeChatMessages([
    { id: 'ctx_report', role: 'context', kind: 'session_message', content: 'Two issues found.', session_message: REPORT_ENVELOPE, turn_id: 'stream_wake', timestamp: '2026-10-27T18:18:31.000Z' },
    { id: 'user_wake', role: 'user', content: 'Woken by a report from Review latest commits', application_turn: kind, turn_id: 'stream_wake', timestamp: '2026-10-27T18:18:31.000Z' },
  ]);
}

test('a wake turn draws no user row and its report card says it woke Jenny', () => {
  const pipeline = pipelineFor('primary');
  const messages = wakeTurn();
  const userHtml = pipeline.buildMessageArticleMarkup(messages[1], messages);
  assert.match(userHtml, /data-thread-compat-anchor="true"/);
  assert.doesNotMatch(userHtml, /chat-bubble|hover-row|Woken by/);
  const card = new JSDOM(`<body>${pipeline.buildMessageArticleMarkup(messages[0], messages)}</body>`).window.document;
  assert.match(card.querySelector('.session-message-state').textContent, /^Woke Jenny at /);
  // Another chat woken by a report says "this chat".
  const plain = new JSDOM(`<body>${pipelineFor('').buildMessageArticleMarkup(messages[0], messages)}</body>`).window.document;
  assert.match(plain.querySelector('.session-message-state').textContent, /^Woke this chat at /);
});

test('a card admitted by an ordinary turn, or the second card of a wake, keeps "Included in the turn"', () => {
  const pipeline = pipelineFor('primary');
  const ordinary = normalizeChatMessages([wakeTurn()[0], { id: 'user_typed', role: 'user', content: 'what did it find?', turn_id: 'stream_wake' }]);
  const doc = new JSDOM(`<body>${pipeline.buildMessageArticleMarkup(ordinary[0], ordinary)}</body>`).window.document;
  assert.match(doc.querySelector('.session-message-state').textContent, /^Included in the turn at /);
  const [first, anchor] = wakeTurn();
  const second = { ...first, id: 'ctx_report_2' };
  const two = [first, second, anchor];
  const secondDoc = new JSDOM(`<body>${pipeline.buildMessageArticleMarkup(second, two)}</body>`).window.document;
  assert.match(secondDoc.querySelector('.session-message-state').textContent, /^Included in the turn at /);
});

test('a preparation turn draws no user row; an auto-resume draws one quiet note', () => {
  const pipeline = pipelineFor('primary');
  const prep = normalizeChatMessages([{ id: 'user_prep', role: 'user', content: 'Preparing a new chat', application_turn: 'handoff_preparation' }]);
  assert.match(pipeline.buildMessageArticleMarkup(prep[0], prep), /data-thread-compat-anchor="true"/);
  const resume = normalizeChatMessages([{ id: 'user_resume', role: 'user', content: 'Resumed automatically after a turn-budget stop', application_turn: 'auto_resume', timestamp: '2026-10-27T18:17:00.000Z' }]);
  const doc = new JSDOM(`<body>${pipeline.buildMessageArticleMarkup(resume[0], resume)}</body>`).window.document;
  const note = doc.querySelector('.chat-app-turn-note');
  assert.ok(note);
  assert.equal(note.getAttribute('role'), 'note');
  assert.match(note.textContent, /^Resumed automatically after a turn-budget stop/);
  assert.ok(doc.querySelector('.chat-app-turn-note-time'));
  assert.equal(doc.querySelector('article').dataset.messageRole, 'system');
  assert.equal(doc.querySelector('.hover-row, .chat-bubble'), null);
});
