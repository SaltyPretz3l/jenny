'use strict';

// Addressed session messages in the timeline (row 59 checkpoint 4, slice S6): the persisted
// role:'context' rows project to one `session_message` row kind, render as attributed cards
// before the turn's user prompt, stay out of every human-intent surface and count in the
// context estimate only when they were included.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const rows = require('../renderer/chat/renderer-session-message-rows');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { buildTranscriptThreadTree } = require('../renderer/chat/renderer-thread-tree-utils');
const { createArticleMarkupPipeline } = require('../renderer/chat/renderer-render-pipeline-article-markup');
const contextUsage = require('../renderer/chat/renderer-context-usage-model');
const { isBranchableMessage } = require('../renderer/chat/renderer-chat-branch-utils');
const { buildMessageActionModel } = require('../renderer/chat/chat-bubble-action-utils');
const stringUtils = require('../renderer/shared/string-utils');

const MESSAGE_ID = '3b1f8f0e-7a3c-4a55-9d0e-0a6f1f3f2c11';
const SOURCE_ID = 'session-source';
const BODY = 'The 8-bit cache keeps 178 tok/s at 150k.\nUse 150k with the 8-bit cache rather than 64k.';

function envelope(overrides = {}) {
  return {
    schema_version: 1,
    message_id: MESSAGE_ID,
    source_session_id: SOURCE_ID,
    source_session_incarnation: 'inc-source',
    source_project_id: 'project-jenny',
    destination_session_id: 'session-dest',
    destination_session_incarnation: 'inc-dest',
    destination_project_id: null,
    source_turn_id: null,
    kind: 'user_message',
    created_at: '2026-10-15T15:38:00.000Z',
    body: BODY,
    body_sha256: 'a'.repeat(64),
    report: null,
    ...overrides,
  };
}

function includedRow(overrides = {}) {
  return {
    id: `ctx_${MESSAGE_ID}`,
    role: 'context',
    kind: 'session_message',
    content: BODY,
    session_message: envelope(),
    turn_id: 'stream_beta',
    timestamp: '2026-10-15T15:41:00.000Z',
    event_seq: 4,
    ...overrides,
  };
}

function receiptRow(overrides = {}) {
  return {
    id: `ctxr_${MESSAGE_ID}`,
    role: 'context',
    kind: 'session_message_receipt',
    content: BODY,
    session_message: envelope(),
    disposition: 'discarded',
    timestamp: '2026-10-15T15:45:00.000Z',
    event_seq: 9,
    ...overrides,
  };
}

const SESSIONS = [{ id: SOURCE_ID, title: 'Benchmark the 128k setting', project_id: 'project-jenny', session_incarnation: 'inc-source' }];
const deps = {
  escapeHtml: stringUtils.escapeHtml,
  getSessions: () => SESSIONS,
  getProjectName: (id) => (id === 'project-jenny' ? 'jenny' : ''),
  formatTime: (value) => (value ? `T(${String(value).slice(11, 16)})` : ''),
};

function card(message, overrides) {
  const html = rows.renderSessionMessage(message, { ...deps, ...overrides });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return { html, doc, card: doc.querySelector('.session-message-card') };
}

test('both persisted shapes project to one session_message row with the disposition in the payload', () => {
  const included = rows.buildSessionMessageRow(includedRow());
  assert.equal(included.kind, 'session_message');
  assert.equal(included.primary_message_id, `ctx_${MESSAGE_ID}`);
  assert.equal(included.render_message_id, `ctx_${MESSAGE_ID}`);
  assert.equal(included.turn_id, 'stream_beta');
  assert.equal(included.payload.disposition, 'included');
  assert.equal(included.payload.content, BODY);
  assert.equal(included.payload.envelope.source_session_id, SOURCE_ID);

  const discarded = rows.buildSessionMessageRow(receiptRow());
  assert.equal(discarded.kind, 'session_message');
  assert.equal(discarded.payload.disposition, 'discarded');
  assert.equal(discarded.turn_id, '');

  assert.equal(rows.buildSessionMessageRow({ id: 'u', role: 'user', content: 'hi' }), null);
  assert.equal(rows.buildSessionMessageRow({ id: 'c', role: 'context', kind: 'other', content: 'x' }), null);
  assert.equal(rows.isSessionMessageRecord(includedRow()), true);
  assert.equal(rows.isSessionMessageRecord({ role: 'assistant', kind: 'session_message' }), false);
});

test('the included card is attributed, plain and states when the turn included it', () => {
  const { card: el, doc } = card(includedRow());
  assert.equal(el.dataset.sessionMessageState, 'included');
  assert.equal(el.dataset.sessionMessageId, `ctx_${MESSAGE_ID}`);
  assert.equal(el.getAttribute('role'), 'group');
  assert.equal(el.getAttribute('aria-label'), 'Message from Benchmark the 128k setting');

  const chip = doc.querySelector('button.session-message-from');
  assert.ok(chip, 'the From chip is a button when the source chat exists');
  assert.equal(chip.dataset.sessionMessageOpen, SOURCE_ID);
  assert.equal(chip.querySelector('.session-message-from-label').textContent, 'From');
  assert.equal(chip.querySelector('.session-message-from-title').textContent, 'Benchmark the 128k setting');
  assert.equal(chip.getAttribute('aria-label'), 'Open chat Benchmark the 128k setting');

  assert.equal(doc.querySelector('.session-message-meta').textContent, '· jenny · T(15:38)');
  assert.equal(doc.querySelector('.session-message-body').textContent, BODY, 'the body keeps its line breaks verbatim');
  assert.equal(doc.querySelector('.session-message-body').children.length, 0, 'no markdown, no inline markup');
  const status = doc.querySelector('.session-message-status');
  assert.equal(status.dataset.tone, 'ok');
  assert.equal(status.querySelector('.session-message-state').textContent, 'Included in the turn at T(15:41)');
  assert.equal(doc.querySelector('.session-message-status button'), null, 'the status line carries no actions');
});

test('the discard receipt says the model never saw it', () => {
  const { card: el, doc } = card(receiptRow());
  assert.equal(el.dataset.sessionMessageState, 'discarded');
  assert.equal(doc.querySelector('.session-message-status').dataset.tone, 'muted');
  assert.equal(doc.querySelector('.session-message-state').textContent, 'Discarded · never shown to the model');
  assert.equal(doc.querySelector('.session-message-body').textContent, BODY);
  assert.equal(doc.querySelector('button.session-message-from').dataset.sessionMessageOpen, SOURCE_ID);
});

test('a deleted or replaced source reads "Deleted chat" and its chip is not a link', () => {
  for (const overrides of [
    { getSessions: () => [] },
    { getSessions: () => [{ ...SESSIONS[0], session_incarnation: 'inc-recreated' }] },
  ]) {
    const { doc, card: el } = card(includedRow(), overrides);
    assert.equal(doc.querySelector('button'), null, 'no button without a source to open');
    assert.equal(doc.querySelector('[data-session-message-open]'), null);
    const chip = doc.querySelector('.session-message-from--static');
    assert.ok(chip);
    assert.equal(chip.querySelector('.session-message-from-title').textContent, 'Deleted chat');
    assert.equal(el.getAttribute('aria-label'), 'Message from Deleted chat');
    assert.equal(doc.querySelector('.session-message-body').textContent, BODY, 'the text is still readable');
  }
});

test('General sources, untitled sources and unknown project names degrade quietly', () => {
  const general = card(includedRow(), { getSessions: () => [{ id: SOURCE_ID, title: '', project_id: '' }] });
  assert.equal(general.doc.querySelector('.session-message-from-title').textContent, 'Untitled chat');
  assert.equal(general.doc.querySelector('.session-message-meta').textContent, '· General · T(15:38)');
  const unknownProject = card(includedRow(), { getProjectName: () => '' });
  assert.equal(unknownProject.doc.querySelector('.session-message-meta').textContent, '· T(15:38)');
});

test('body, title and project are untrusted text: nothing becomes markup', () => {
  const evil = '<img src=x onerror="alert(1)"> <script>boom()</script> & "quoted" \'single\'';
  const { doc } = card(
    includedRow({ content: evil, session_message: envelope({ body: evil }) }),
    {
      getSessions: () => [{ id: SOURCE_ID, title: `"><b onclick="x()">${evil}`, project_id: 'p-evil' }],
      getProjectName: () => '<i>proj</i>',
    }
  );
  assert.equal(doc.querySelector('img'), null);
  assert.equal(doc.querySelector('script'), null);
  assert.equal(doc.querySelector('b'), null);
  assert.equal(doc.querySelector('i'), null);
  assert.equal(doc.querySelector('.session-message-body').textContent, evil);
  assert.equal(doc.querySelector('.session-message-from-title').textContent, `"><b onclick="x()">${evil}`);
  assert.equal(doc.querySelector('.session-message-meta').textContent, '· <i>proj</i> · T(15:38)');
  for (const attr of doc.querySelectorAll('*')) {
    for (const name of attr.getAttributeNames()) assert.equal(/^on/i.test(name), false, `${name} is not an inline handler`);
  }
});

test('the From chip opens the source chat through the injected openSession, once per click', () => {
  const dom = new JSDOM(`<body><div id="timeline">${rows.renderSessionMessage(includedRow(), deps)}${rows.renderSessionMessage(includedRow({ id: 'ctx_other' }), { ...deps, getSessions: () => [] })}</div></body>`);
  const timeline = dom.window.document.getElementById('timeline');
  const opened = [];
  const dispose = rows.bindSessionMessageCards(timeline, { openSession: (id) => opened.push(id) });
  timeline.querySelector('button.session-message-from .session-message-from-title').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, [SOURCE_ID]);
  timeline.querySelector('.session-message-from--static').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  timeline.querySelector('.session-message-body').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, [SOURCE_ID], 'only a live chip opens a chat');
  dispose();
  timeline.querySelector('button.session-message-from').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, [SOURCE_ID], 'dispose unbinds');
  assert.equal(typeof rows.bindSessionMessageCards(null, { openSession() {} }), 'function');
});

// ---- projection order with real persisted shapes -------------------------------------------

// Turn alpha answered; turn beta admitted one message: its context row sits before beta's user
// anchor (insertMessagesBefore), both stamped with beta's turn id.
function persistedConversation() {
  return [
    { id: 'user_stream_alpha', role: 'user', content: 'first', turn_id: 'stream_alpha', event_seq: 0 },
    { id: 'assistant_stream_alpha', role: 'assistant', content: 'answer one', turn_id: 'stream_alpha', event_seq: 1 },
    includedRow({ event_seq: 2 }),
    { id: 'user_stream_beta', role: 'user', content: 'second', turn_id: 'stream_beta', event_seq: 3 },
    { id: 'assistant_stream_beta', role: 'assistant', content: 'answer two', turn_id: 'stream_beta', event_seq: 4 },
    receiptRow({ id: 'ctxr_other', event_seq: 5 }),
  ];
}

const CONTEXT_IDS = [`ctx_${MESSAGE_ID}`, 'ctxr_other'];

test('context rows hold no turn row: no unknown_role notice, and the user turn is unchanged', () => {
  const result = projectTurnTree({ messages: normalizeChatMessages(persistedConversation()) });
  assert.deepEqual(result.turns.map((turn) => turn.turn_id), ['stream_alpha', 'stream_beta']);
  for (const id of CONTEXT_IDS) assert.equal(result.byMessageId[id], undefined, `${id} is not a turn message`);
  for (const turn of result.turns) {
    assert.equal(turn.events.some((event) => event.kind === 'system_notice'), false);
    assert.deepEqual(turn.events.map((event) => event.kind), ['user_prompt', 'assistant_text_segment']);
    assert.equal(turn.source_message_ids.some((id) => CONTEXT_IDS.includes(id)), false);
  }
  assert.equal(result.turns[1].primary_user_message_id, 'user_stream_beta');
});

test('context rows are skipped by the event-log projection too (the persisted path)', () => {
  const result = projectTurnTree({
    messages: normalizeChatMessages(persistedConversation()),
    turn_event_log_version: 1,
    turn_events: [
      { event_id: 'stream_alpha:user_prompt:0', event_seq: 0, turn_id: 'stream_alpha', kind: 'user_prompt', primary_message_id: 'user_stream_alpha', source_message_ids: ['user_stream_alpha'], payload: { content: 'first', attachments: [] } },
      { event_id: 'stream_alpha:assistant_text_segment:0', event_seq: 1, turn_id: 'stream_alpha', kind: 'assistant_text_segment', primary_message_id: 'assistant_stream_alpha', source_message_ids: ['assistant_stream_alpha'], payload: { text: 'answer one', segment_group_index: 0 } },
      { event_id: 'stream_beta:user_prompt:0', event_seq: 3, turn_id: 'stream_beta', kind: 'user_prompt', primary_message_id: 'user_stream_beta', source_message_ids: ['user_stream_beta'], payload: { content: 'second', attachments: [] } },
      { event_id: 'stream_beta:assistant_text_segment:0', event_seq: 4, turn_id: 'stream_beta', kind: 'assistant_text_segment', primary_message_id: 'assistant_stream_beta', source_message_ids: ['assistant_stream_beta'], payload: { text: 'answer two', segment_group_index: 0 } },
    ],
  });
  assert.deepEqual(result.turns.map((turn) => turn.turn_id), ['stream_alpha', 'stream_beta']);
  for (const id of CONTEXT_IDS) assert.equal(result.byMessageId[id], undefined);
  assert.equal(result.turns.every((turn) => turn.events.every((event) => event.kind !== 'system_notice')), true);
});

test('a context row renders before the turn it joined, never inside the previous turn', () => {
  const messages = normalizeChatMessages(persistedConversation());
  const tree = buildTranscriptThreadTree(messages);
  const order = tree.roots.map((node) => node.id);
  assert.deepEqual(order, ['user_stream_alpha', `ctx_${MESSAGE_ID}`, 'user_stream_beta', 'ctxr_other']);
  assert.ok(order.indexOf(`ctx_${MESSAGE_ID}`) < order.indexOf('user_stream_beta'), 'the included card precedes the turn prompt');
  assert.equal(tree.nodeById.get(`ctx_${MESSAGE_ID}`).parentId, '', 'a context row is a root, not a child of the previous answer');
  // The persisted event_seq order from insertMessagesBefore (context rows take the anchor's old
  // seq, the anchor is re-stamped after them) agrees with the array order the timeline walks.
  const seqs = persistedConversation().map((message) => message.event_seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
});

// ---- the article pipeline -------------------------------------------------------------------

function createPipeline(callbackOverrides = {}) {
  return createArticleMarkupPipeline({
    state: { currentSessionId: 'session-dest', sessions: SESSIONS, ui: {} },
    callbacks: {
      escapeHtml: stringUtils.escapeHtml,
      buildMessageShellArticle: ({ className, messageRole, innerHtml }) => `<article class="${className}" data-message-role="${messageRole}">${innerHtml}</article>`,
      buildMessageBodyShell: (_id, innerHtml) => innerHtml,
      renderMessageHoverRow: () => '<div class="hover-row">actions</div>',
      renderMarkdown: (text) => `<p>${text}</p>`,
      ...callbackOverrides,
    },
  });
}

test('the article renders the card with no hover actions, and a user message keeps its own bubble', () => {
  const pipeline = createPipeline();
  const messages = normalizeChatMessages([includedRow(), { id: 'user_stream_beta', role: 'user', content: 'second', turn_id: 'stream_beta' }]);
  const contextHtml = pipeline.buildMessageArticleMarkup(messages[0], messages);
  const doc = new JSDOM(`<body>${contextHtml}</body>`).window.document;
  assert.equal(doc.querySelector('article').dataset.messageRole, 'context');
  assert.equal(doc.querySelector('.session-message-card').dataset.sessionMessageState, 'included');
  assert.equal(doc.querySelector('.session-message-from-title').textContent, 'Benchmark the 128k setting');
  assert.equal(doc.querySelector('.hover-row'), null, 'no copy / edit / branch actions on a context card');
  assert.equal(doc.querySelector('.chat-bubble'), null, 'not the plain-bubble fallback');

  const userHtml = pipeline.buildMessageArticleMarkup(messages[1], messages);
  assert.match(userHtml, /hover-row/, 'the user message still gets its actions');
  assert.doesNotMatch(userHtml, /session-message-card/);
});

test('the injected renderSessionMessage owns the card markup (lookups come from the host)', () => {
  const pipeline = createPipeline({ renderSessionMessage: (message) => `<i data-from-host="${message.id}"></i>` });
  const message = normalizeChatMessages([receiptRow()])[0];
  assert.match(pipeline.buildMessageArticleMarkup(message, [message]), /data-from-host="ctxr_/);
});

// ---- exclusions -----------------------------------------------------------------------------

test('context rows are never a branch target and carry no hover actions', () => {
  for (const message of [includedRow(), receiptRow()]) {
    assert.equal(isBranchableMessage(message), false);
    const model = buildMessageActionModel(message, {});
    assert.equal(model.showHoverRow, false);
  }
});

// ---- context estimate -----------------------------------------------------------------------

test('the context estimate counts an included message with its envelope, never a receipt', () => {
  const user = { id: 'u', role: 'user', content: 'a'.repeat(40) };
  const withoutMail = contextUsage.estimateContextMessagesTokens([user], 'session');
  assert.equal(withoutMail, 10);
  const withIncluded = contextUsage.estimateContextMessagesTokens([includedRow(), user], 'session');
  assert.ok(withIncluded > withoutMail + Math.ceil(BODY.length / 4), 'body plus envelope fields are counted');
  assert.equal(contextUsage.estimateContextMessagesTokens([receiptRow(), user], 'session'), withoutMail, 'a discarded message was never sent');
});

test('recent scope still counts the included messages of the turns it keeps', () => {
  const list = [];
  for (let index = 0; index < 8; index += 1) {
    list.push({ id: `u${index}`, role: 'user', content: 'x'.repeat(40) });
    list.push({ id: `a${index}`, role: 'assistant', content: 'y'.repeat(40) });
    if (index === 6) list.push({ id: 'ctx-last', role: 'context', kind: 'session_message', content: 'z'.repeat(40), session_message: envelope({ body: 'z'.repeat(40) }), turn_id: 'turn-7' });
  }
  const recent = contextUsage.selectContextEstimateMessages(list, 'recent').map((message) => message.id);
  assert.ok(recent.includes('ctx-last'), 'the context row before the final prompt is in the window');
  assert.ok(recent.indexOf('ctx-last') < recent.indexOf('u7'), 'ordered before the prompt');
  assert.equal(recent.includes('u1'), false, 'older turns still fall out of the window');
});

// ---- Background rows (checkpoint 5a: kind session_handoff) -----------------------------------

const HANDOFF_BODY = 'Goal: split the 128k benchmark out.\nKnown: 8-bit cache keeps 178 tok/s.';
const PARENT_ID = SOURCE_ID;
const HANDOFF_ID = `ctxh_${'a'.repeat(64)}`;

function handoffRow(overrides = {}) {
  return {
    id: HANDOFF_ID,
    role: 'context',
    kind: 'session_handoff',
    content: HANDOFF_BODY,
    session_handoff: {
      schema_version: 1,
      proposal_id: `proposal_${'b'.repeat(64)}`,
      source_session_id: PARENT_ID,
      source_session_incarnation: 'inc-source',
      body: HANDOFF_BODY,
      body_sha256: 'c'.repeat(64),
    },
    turn_id: 'stream_first',
    timestamp: '2026-10-15T16:00:00.000Z',
    event_seq: 0,
    ...overrides,
  };
}

const PARENT_SESSIONS = SESSIONS;

test('a session_handoff row projects to its own row kind with the Background text', () => {
  const row = rows.buildSessionMessageRow(handoffRow());
  assert.equal(row.kind, 'session_handoff');
  assert.equal(row.kind, rows.ROW_KIND_HANDOFF);
  assert.equal(row.primary_message_id, HANDOFF_ID);
  assert.equal(row.turn_id, 'stream_first');
  assert.equal(row.payload.content, HANDOFF_BODY);
  assert.equal(row.payload.handoff.source_session_id, PARENT_ID);
  assert.equal(rows.isSessionMessageRecord(handoffRow()), true);
  assert.equal(rows.buildSessionMessageRow(includedRow()).kind, 'session_message', 'mail rows are unchanged');
});

test('the Background card names the parent, opens it, keeps the text plain and has no state line', () => {
  const { card: el, doc } = card(handoffRow(), { getSessions: () => PARENT_SESSIONS });
  assert.equal(el.dataset.sessionHandoffId, HANDOFF_ID);
  assert.equal(el.dataset.sessionMessageState, undefined);
  assert.equal(el.getAttribute('aria-label'), 'Background from Benchmark the 128k setting');
  const chip = doc.querySelector('button.session-message-from');
  assert.equal(chip.dataset.sessionMessageOpen, PARENT_ID);
  assert.equal(chip.querySelector('.session-message-from-label').textContent, 'Background from');
  assert.equal(chip.querySelector('.session-message-from-title').textContent, 'Benchmark the 128k setting');
  assert.equal(chip.getAttribute('aria-label'), 'Open chat Benchmark the 128k setting');
  assert.equal(doc.querySelector('.session-message-body').textContent, HANDOFF_BODY, 'newlines kept verbatim');
  assert.equal(doc.querySelector('.session-message-body').children.length, 0);
  assert.equal(doc.querySelector('.session-message-status'), null, 'no state line');
  assert.equal(doc.querySelector('.session-message-meta'), null);
});

test('a missing or replaced parent reads "Original chat unavailable" and is not a link', () => {
  for (const getSessions of [() => [], () => [{ ...PARENT_SESSIONS[0], session_incarnation: 'inc-recreated' }]]) {
    const { card: el, doc } = card(handoffRow(), { getSessions });
    assert.equal(doc.querySelector('button'), null);
    assert.equal(doc.querySelector('[data-session-message-open]'), null);
    assert.equal(doc.querySelector('.session-message-from--static .session-message-from-title').textContent, 'Original chat unavailable');
    assert.equal(el.getAttribute('aria-label'), 'Background, original chat unavailable');
    assert.equal(doc.querySelector('.session-message-body').textContent, HANDOFF_BODY, 'the Background stays readable');
  }
});

test('Background text and the parent title are untrusted: nothing becomes markup', () => {
  const evil = '<img src=x onerror="alert(1)"> <script>boom()</script> & "q"';
  const { doc } = card(handoffRow({ content: evil }), { getSessions: () => [{ ...PARENT_SESSIONS[0], title: `"><b>${evil}` }] });
  for (const selector of ['img', 'script', 'b']) assert.equal(doc.querySelector(selector), null, selector);
  assert.equal(doc.querySelector('.session-message-body').textContent, evil);
  assert.equal(doc.querySelector('.session-message-from-title').textContent, `"><b>${evil}`);
});

test('the Open-parent chip uses the same delegated listener as mail cards', () => {
  const dom = new JSDOM(`<body><div id="timeline">${rows.renderSessionMessage(handoffRow(), { ...deps, getSessions: () => PARENT_SESSIONS })}</div></body>`);
  const timeline = dom.window.document.getElementById('timeline');
  const opened = [];
  rows.bindSessionMessageCards(timeline, { openSession: (id) => opened.push(id) });
  timeline.querySelector('button.session-message-from').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, [PARENT_ID]);
});

test('the article renders the Background card with no hover actions; the first user turn is unchanged', () => {
  const pipeline = createPipeline();
  const messages = normalizeChatMessages([handoffRow(), { id: 'user_stream_first', role: 'user', content: 'start', turn_id: 'stream_first' }]);
  const doc = new JSDOM(`<body>${pipeline.buildMessageArticleMarkup(messages[0], messages)}</body>`).window.document;
  assert.equal(doc.querySelector('article').dataset.messageRole, 'context');
  assert.ok(doc.querySelector('.session-message-card--handoff'));
  assert.equal(doc.querySelector('.session-message-from-title').textContent, 'Benchmark the 128k setting', 'the pipeline passes the live summaries');
  assert.equal(doc.querySelector('.hover-row'), null);
  assert.match(pipeline.buildMessageArticleMarkup(messages[1], messages), /hover-row/);
});

test('a Background row holds no turn row and renders before the first prompt of the child', () => {
  const messages = normalizeChatMessages([handoffRow(), { id: 'user_stream_first', role: 'user', content: 'start', turn_id: 'stream_first', event_seq: 1 }, { id: 'assistant_stream_first', role: 'assistant', content: 'ok', turn_id: 'stream_first', event_seq: 2 }]);
  const result = projectTurnTree({ messages });
  assert.equal(result.byMessageId[HANDOFF_ID], undefined);
  assert.deepEqual(result.turns.map((turn) => turn.events.map((event) => event.kind)), [['user_prompt', 'assistant_text_segment']]);
  assert.deepEqual(buildTranscriptThreadTree(messages).roots.map((node) => node.id), [HANDOFF_ID, 'user_stream_first']);
});

test('a Background row is never a branch target and carries no hover actions', () => {
  assert.equal(isBranchableMessage(handoffRow()), false);
  assert.equal(buildMessageActionModel(handoffRow(), {}).showHoverRow, false);
});

test('the context estimate counts a Background row with its preamble', () => {
  const user = { id: 'u', role: 'user', content: 'a'.repeat(40) };
  const base = contextUsage.estimateContextMessagesTokens([user], 'session');
  const withHandoff = contextUsage.estimateContextMessagesTokens([handoffRow(), user], 'session');
  assert.ok(withHandoff > base + Math.ceil((HANDOFF_BODY.length + 230) / 4), 'preamble plus body are counted');
  const list = [];
  for (let index = 0; index < 8; index += 1) {
    if (index === 7) list.push(handoffRow({ id: 'ctxh-last' }));
    list.push({ id: `u${index}`, role: 'user', content: 'x'.repeat(40) });
    list.push({ id: `a${index}`, role: 'assistant', content: 'y'.repeat(40) });
  }
  const recent = contextUsage.selectContextEstimateMessages(list, 'recent').map((message) => message.id);
  assert.ok(recent.includes('ctxh-last'), 'the Background row before the final prompt is in the window');
});

test('"Started from {parent}" comes from the summary spawned_from and degrades quietly', () => {
  const child = { id: 'session-child', spawned_from: { parent_session_id: PARENT_ID, parent_session_incarnation: 'inc-source', proposal_id: `proposal_${'b'.repeat(64)}`, created_at: '2026-10-15T16:00:00.000Z' } };
  assert.equal(rows.buildStartedFromLabel(child, PARENT_SESSIONS), 'Started from Benchmark the 128k setting');
  assert.equal(rows.buildStartedFromLabel({ ...child, spawned_from: { parent_session_id: PARENT_ID } }, PARENT_SESSIONS), 'Started from Benchmark the 128k setting', 'incarnation is optional in the summary');
  assert.equal(rows.buildStartedFromLabel(child, []), 'Started from an unavailable chat');
  assert.equal(rows.buildStartedFromLabel(child, [{ ...PARENT_SESSIONS[0], session_incarnation: 'inc-new' }]), 'Started from an unavailable chat');
  assert.equal(rows.buildStartedFromLabel(child, [{ id: PARENT_ID, title: '' }]), 'Started from Untitled chat');
  assert.equal(rows.buildStartedFromLabel({ id: 'plain' }, PARENT_SESSIONS), '');
  assert.equal(rows.buildStartedFromLabel({ id: 'x', spawned_from: { parent_session_id: '' } }, PARENT_SESSIONS), '');
  assert.equal(rows.buildStartedFromLabel(null, PARENT_SESSIONS), '');
});

// ---- Terminal reports from a linked child (row 59 cp5b-1, slice B3) ----

function reportEnvelope(report, overrides = {}) {
  return envelope({
    kind: 'terminal_report',
    source_turn_id: 'turn-child-1',
    body: 'Measured 64k, 128k and 150k with the 8-bit cache. Decode held at 178 tok/s.',
    report: { outcome: 'completed', clipped: false, error_code: null, ...report },
    ...overrides,
  });
}

function reportRow(report, overrides = {}) {
  const env = reportEnvelope(report);
  return includedRow({ content: env.body, session_message: env, ...overrides });
}

test('a terminal report is a "Report from {child}" card with the outcome word, the plain body and Open chat', () => {
  const { card: el, doc } = card(reportRow({}));
  assert.equal(el.classList.contains('session-message-card--report'), true);
  assert.equal(el.dataset.reportOutcome, 'completed');
  assert.equal(el.getAttribute('aria-label'), 'Report from Benchmark the 128k setting');
  const chip = doc.querySelector('button.session-message-from');
  assert.equal(chip.querySelector('.session-message-from-label').textContent, 'Report from');
  assert.equal(chip.querySelector('.session-message-from-title').textContent, 'Benchmark the 128k setting');
  const outcome = doc.querySelector('.session-message-outcome');
  assert.equal(outcome.textContent, '· turn finished');
  assert.equal(outcome.dataset.tone, 'ok');
  assert.equal(doc.querySelector('.session-message-body').textContent, 'Measured 64k, 128k and 150k with the 8-bit cache. Decode held at 178 tok/s.');
  assert.equal(doc.querySelector('.session-message-clipped'), null, 'not clipped, no marker');
  const open = doc.querySelector('.session-message-status button[data-session-message-open]');
  assert.ok(open, 'Open chat sits in the status line');
  assert.equal(open.textContent, 'Open chat');
  assert.equal(open.dataset.sessionMessageOpen, SOURCE_ID);
  assert.equal(doc.querySelector('.session-message-state').textContent, 'Included in the turn at T(15:41)');
});

test('each outcome has its own word; failed carries the danger tone', () => {
  const words = {
    completed: ['turn finished', 'ok'],
    failed: ['turn failed', 'error'],
    cancelled: ['turn cancelled', 'muted'],
    awaiting_decision: ['waiting for a decision', 'warn'],
  };
  for (const [outcome, [word, tone]] of Object.entries(words)) {
    const { doc, card: el } = card(reportRow({ outcome, error_code: outcome === 'failed' ? 'CMP-CHAT-0001' : null }));
    assert.equal(doc.querySelector('.session-message-outcome').textContent, `· ${word}`, outcome);
    assert.equal(doc.querySelector('.session-message-outcome').dataset.tone, tone, outcome);
    assert.equal(el.dataset.reportOutcome, outcome);
  }
});

test('a clipped report says so and points at the chat for the full answer', () => {
  const { doc } = card(reportRow({ clipped: true }));
  const marker = doc.querySelector('.session-message-clipped');
  assert.ok(marker);
  assert.equal(marker.textContent, 'Clipped · open the chat for the full answer');
});

test('a report whose child is gone has no Open chat link, still reads as a report and a discarded one keeps the receipt state', () => {
  const gone = card(reportRow({}), { getSessions: () => [] });
  assert.equal(gone.doc.querySelector('button'), null);
  assert.equal(gone.doc.querySelector('.session-message-from-label').textContent, 'Report from');
  assert.equal(gone.doc.querySelector('.session-message-from-title').textContent, 'Deleted chat');
  assert.equal(gone.card.getAttribute('aria-label'), 'Report from Deleted chat');
  const env = reportEnvelope({ outcome: 'failed' });
  const discarded = card(receiptRow({ content: env.body, session_message: env }));
  assert.equal(discarded.card.dataset.sessionMessageState, 'discarded');
  assert.equal(discarded.doc.querySelector('.session-message-state').textContent, 'Discarded · never shown to the model');
  assert.equal(discarded.doc.querySelector('.session-message-outcome').textContent, '· turn failed');
});

test('a report body and child title stay untrusted text, and Open chat opens the child once', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const html = rows.renderSessionMessage(reportRow({}, { content: evil, session_message: reportEnvelope({}, { body: evil }) }), {
    ...deps, getSessions: () => [{ ...SESSIONS[0], title: evil }],
  });
  const dom = new JSDOM(`<body><div id="timeline">${html}</div></body>`);
  const timeline = dom.window.document.getElementById('timeline');
  assert.equal(timeline.querySelector('img'), null);
  assert.equal(timeline.querySelector('.session-message-body').textContent, evil);
  const opened = [];
  rows.bindSessionMessageCards(timeline, { openSession: (id) => opened.push(id) });
  timeline.querySelector('.session-message-status button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, [SOURCE_ID]);
});

test('a non-report message keeps the From chip and gets no report parts', () => {
  const { doc, card: el } = card(includedRow());
  assert.equal(el.classList.contains('session-message-card--report'), false);
  assert.equal(doc.querySelector('.session-message-outcome'), null);
  assert.equal(doc.querySelector('.session-message-status button'), null);
});
