// new-test-file: the steer bubble spans the tree projector, row projector, row index and article
// markup; it needs the whole hydrated render path, which no existing test file builds.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createArticleMarkupPipeline } = require('../renderer/chat/renderer-render-pipeline-article-markup');
const { createTurnShellRenderer } = require('../renderer/chat/renderer-turn-shell');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');
const { createTranscriptActionRenderer } = require('../renderer/chat/renderer-transcript-actions');
const { buildMessageActionModel, resolveRegenerateRequest } = require('../renderer/chat/chat-bubble-action-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { indexRowsByRenderMessageId } = require('../renderer/chat/renderer-render-message-index-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The dispatcher finds the coalesce helpers through a global the script tag sets in the app.
globalThis.rendererTurnArticleCoalesceUtils = require('../renderer/chat/renderer-turn-article-coalesce-utils');

const actionRenderer = createTranscriptActionRenderer({ buildMessageActionModel, escapeHtml });

function createPipeline() {
  const shellRenderer = createTurnShellRenderer({ escapeHtml });
  const rowRender = createTurnRowRenderUtils({
    escapeHtml,
    renderMarkdown: (text) => `<p>${escapeHtml(text)}</p>`,
    renderMessageAttachments: (message) => (Array.isArray(message && message.attachments) ? message.attachments : [])
      .map((attachment) => `<span class="test-attachment">${escapeHtml(attachment.displayName)}</span>`).join(''),
    renderToolCallBlock: (message) => `<div class="tool-block" data-tool-message-id="${escapeHtml(message.id)}"></div>`,
  });
  return createArticleMarkupPipeline({
    state: { currentSessionId: 'session-steer', ui: {} },
    constants: { MESSAGE_STATUS: { STREAMING: 'streaming' } },
    callbacks: {
      escapeHtml,
      renderMarkdown: (text) => `<p>${escapeHtml(text)}</p>`,
      buildMessageShellArticle: shellRenderer.buildMessageShellArticle,
      buildMessageBodyShell: (_id, innerHtml) => innerHtml,
      buildAssistantContentShell: (_id, innerHtml) => innerHtml,
      buildTurnRowListMarkup: rowRender.buildTurnRowListMarkup,
      getMessageFromCollection(messageId, messages, projectionContext) {
        return projectionContext?.messageById?.get?.(messageId)
          || (Array.isArray(messages) ? messages.find((m) => m && m.id === messageId) : null)
          || null;
      },
      deriveActionTargetMessageId(turn, rows) {
        const last = [...rows].reverse().find((row) => row.kind === 'assistant_text');
        return last ? last.primary_message_id : '';
      },
      buildAssistantMetaLabel: () => '',
      buildMessageTokenMeta: contextUsageUtils.buildMessageTokenMeta,
      formatMessageTokenMeta: contextUsageUtils.formatMessageTokenMeta,
      combineMessageMetaLabels: contextUsageUtils.combineMessageMetaLabels,
      renderMessageHoverRow: actionRenderer.renderMessageHoverRow,
      recordTurnArticleRolloutSignal() { return { logged: false, count: 0 }; },
    },
  });
}

const TURN = 'turn_steer';
const MESSAGES = [
  { id: 'user_open', role: 'user', content: 'Fix the parser', status: 'complete', turn_id: TURN },
  { id: 'assistant_first', role: 'assistant', content: 'Reading the parser.', status: 'complete', turn_id: TURN },
  { id: 'tool_use_call_1', role: 'assistant', kind: 'tool_use', status: 'complete', turn_id: TURN, content: 'Read parser.js',
    tool_call: { call_id: 'call_1', tool_name: 'Read', status: 'completed', parent_stream_id: TURN } },
  { id: 'tool_result_call_1', role: 'tool', kind: 'tool_result', status: 'complete', turn_id: TURN, content: 'ok',
    tool_result: { call_id: 'call_1', tool_name: 'Read', parent_stream_id: TURN } },
  { id: 'steer_outbox_9', role: 'user', kind: 'steer', status: 'complete', turn_id: TURN, content: 'Use the other file',
    outbox_item_id: 'outbox_9', attachments: [] },
  { id: 'assistant_after', role: 'assistant', content: 'Switching to the other file.', status: 'complete', turn_id: TURN },
];

function buildContext(messages) {
  const tree = projectTurnTree({ messages });
  const rowsByTurnId = new Map();
  const turnById = new Map();
  const turnIdByMessageId = new Map();
  for (const turn of tree.turns) {
    turnById.set(turn.turn_id, turn);
    rowsByTurnId.set(turn.turn_id, projectTurnRows(turn.events, {}));
    for (const id of turn.source_message_ids) turnIdByMessageId.set(id, turn.turn_id);
  }
  return {
    messageById: new Map(messages.map((message) => [message.id, message])),
    turnById,
    turnIdByMessageId,
    rowsByTurnId,
    rowsByRenderMessageId: indexRowsByRenderMessageId(rowsByTurnId),
    viewModelByTurnId: new Map(),
    activeStreamingMessageId: '',
  };
}

function renderTranscript(messages = MESSAGES) {
  const pipeline = createPipeline();
  const context = buildContext(messages);
  return messages
    .map((message) => pipeline.buildMessageArticleMarkup(message, messages, 'assistant_after', 'assistant_after', '', null, context))
    .join('\n');
}

test('a hydrated steer row renders inside its turn, between the tool row and the next reply', () => {
  const html = renderTranscript();
  const tool = html.indexOf('data-row-kind="tool_call"');
  const bubble = html.indexOf('Use the other file');
  const reply = html.indexOf('Switching to the other file.');
  assert.ok(tool !== -1 && bubble !== -1 && reply !== -1, html);
  assert.ok(tool < bubble && bubble < reply, 'tool row, then the bubble, then the reply');
  assert.equal(html.split('Use the other file').length - 1, 1, 'one bubble, not a standalone copy as well');
  const turnArticles = html.split('data-turn-id="turn_steer"').length - 1;
  assert.equal(turnArticles, 1, 'the whole turn stays one article');
});

test('the steer bubble carries one muted caption and a hover row that offers Copy only', () => {
  const html = renderTranscript();
  assert.equal(html.split('Sent while Jenny was working').length - 1, 1);
  assert.match(html, /class="chat-entry__steer-caption"/);
  const bubbleAt = html.indexOf('Use the other file');
  const captionAt = html.indexOf('Sent while Jenny was working');
  assert.ok(captionAt > bubbleAt, 'the caption sits under the bubble');
  const steerBlock = html.slice(html.indexOf('chat-steer-entry'), html.indexOf('Switching to the other file.'));
  assert.match(steerBlock, /data-message-action="copy"/);
  assert.doesNotMatch(steerBlock, /data-message-action="(edit|regenerate|branch|elaborate|retry)"/);
});

test('a steer row outside any coalesced turn still renders once, with its caption and Copy only', () => {
  const messages = [
    { id: 'user_open', role: 'user', content: 'Hi', status: 'complete' },
    { id: 'steer_outbox_9', role: 'user', kind: 'steer', status: 'complete', content: 'Also this', turn_id: 'turn_x' },
  ];
  const pipeline = createPipeline();
  const html = pipeline.buildMessageArticleMarkup(messages[1], messages, '', '', '', null, null);
  assert.equal(html.split('Also this').length - 1, 1);
  assert.match(html, /Sent while Jenny was working/);
  assert.match(html, /data-message-action="copy"/);
  assert.doesNotMatch(html, /data-message-action="(edit|branch|regenerate)"/);
  const ordinary = pipeline.buildMessageArticleMarkup(messages[0], messages, '', '', '', null, null);
  assert.doesNotMatch(ordinary, /Sent while Jenny was working/);
  assert.match(ordinary, /data-message-action="edit"/);
});

test('regenerating a steered turn replays the opening prompt, never the steer message', () => {
  const request = resolveRegenerateRequest('assistant_after', MESSAGES, { latestReplyAssistantMessageId: 'assistant_after' });
  assert.equal(request.allowed, true);
  assert.equal(request.sourceMessageId, 'user_open');
  assert.equal(request.prompt, 'Fix the parser');
});

test('an image-only steer renders its attachments and the caption with no bubble text and no crash', () => {
  const messages = MESSAGES.map((message) => (message.id === 'steer_outbox_9'
    ? { ...message, content: '', attachments: [{ displayName: 'screenshot.png', kind: 'image' }] }
    : message));
  const html = renderTranscript(messages);
  const steerStart = html.indexOf('chat-steer-entry');
  const steerBlock = html.slice(steerStart, html.indexOf('data-message-action="copy"', steerStart) + 40);
  assert.match(steerBlock, /class="test-attachment">screenshot\.png</);
  assert.match(steerBlock, /Sent while Jenny was working/);
  assert.doesNotMatch(steerBlock, /class="chat-bubble/, 'no empty text bubble');
  assert.match(steerBlock, /data-message-action="copy"/);
});
