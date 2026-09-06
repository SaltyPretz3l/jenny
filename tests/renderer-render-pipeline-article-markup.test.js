const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createArticleMarkupPipeline,
} = require('../renderer/chat/renderer-render-pipeline-article-markup');
const {
  createTurnRowRenderUtils,
} = require('../renderer/chat/renderer-turn-row-render-utils');
const stringUtils = require('../renderer/shared/string-utils');
const {
  resolveResumeTailAssistantMessageId,
} = require('../renderer/chat/renderer-message-index-utils');

test('article selection refreshes after clearing the current session selection set', () => {
  const selectedMessageIdsBySession = new Map([
    ['session-1', new Set(['message-1'])],
  ]);
  const state = {
    currentSessionId: 'session-1',
    ui: { selectionMode: true, selectedMessageIdsBySession },
  };
  const pipeline = createArticleMarkupPipeline({
    state,
    callbacks: {
      buildMessageShellArticle({ selectionMode, selected }) {
        return { selectionMode, selected };
      },
    },
  });
  const message = {
    id: 'message-1',
    role: 'user',
    status: 'complete',
    content: 'Selected prompt',
  };

  assert.deepEqual(
    pipeline.buildMessageArticleMarkup(message, [message]),
    { selectionMode: true, selected: true }
  );

  selectedMessageIdsBySession.delete('session-1');

  assert.deepEqual(
    pipeline.buildMessageArticleMarkup(message, [message]),
    { selectionMode: true, selected: false }
  );
});

test('collapsed reasoning predicts materially less height than expanded reasoning-only markup', (t) => {
  const previousDocument = global.document;
  const previousPretextLayout = global.pretextLayout;
  const previousRendererPretextUtils = global.rendererPretextUtils;
  const pretextModulePath = require.resolve('../renderer/features/renderer-pretext-utils.js');
  const dom = new JSDOM('<!doctype html><div id="thread-column"></div>');
  const predictionOptions = [];
  let turnMarkup = '';

  t.after(() => {
    delete require.cache[pretextModulePath];
    global.document = previousDocument;
    global.pretextLayout = previousPretextLayout;
    global.rendererPretextUtils = previousRendererPretextUtils;
    dom.window.close();
  });

  global.document = dom.window.document;
  global.pretextLayout = {
    prepare(text, font) { return { text, font }; },
    layout(prepared) { return { height: prepared.text.length }; },
    clearCache() {},
  };
  delete require.cache[pretextModulePath];
  const pretextUtils = require(pretextModulePath);
  global.rendererPretextUtils = {
    ...pretextUtils,
    isEnabled() { return true; },
    resolveDefaultFontString() { return 'normal normal 400 15px sans-serif'; },
    resolveElementWidth() { return 760; },
    predictHtmlContentHeight(...args) {
      predictionOptions.push(args[5]);
      return pretextUtils.predictHtmlContentHeight(...args);
    },
  };

  const pipeline = createArticleMarkupPipeline({
    state: { features: { featureFlags: { pretext_layout: true } } },
    dom: { chatThreadColumn: dom.window.document.getElementById('thread-column') },
    callbacks: { buildTurnRowListMarkup() { return turnMarkup; } },
  });
  const reasoningBody = 'reasoning detail '.repeat(3000);
  const rows = [{ kind: 'reasoning' }];
  const turn = { turn_id: 'reasoning-prediction' };

  turnMarkup = `<div class="reasoning-row-panel"><span>Reasoning</span><div class="reasoning-row-panel-body chat-bubble-markdown">${reasoningBody}</div></div>`;
  const collapsedHeight = pipeline.maybePredictTurnHeight(turn, rows, [], {});
  turnMarkup = `<div class="reasoning-row-panel expanded"><span>Reasoning</span><div class="reasoning-row-panel-body chat-bubble-markdown">${reasoningBody}</div></div>`;
  const expandedHeight = pipeline.maybePredictTurnHeight(turn, rows, [], {});

  assert.ok(collapsedHeight * 100 < expandedHeight, `${collapsedHeight} should be materially smaller than ${expandedHeight}`);
  assert.match(predictionOptions[0].excludeSelector, /reasoning-row-panel:not\(\.expanded\)/);
});

// The Resume affordance stamps the session id onto the button and the interaction
// controller refuses to send when it is empty, so this seam -- the turn-article
// callers never pass sessionId -- is the difference between a working button and
// an inert one. Both new renderer test files build their own row-list options, so
// only a test that goes THROUGH buildTurnArticleMarkup can see it.
function captureTurnRowListOptions(renderOptions, stateOverrides = {}) {
  let captured = null;
  const pipeline = createArticleMarkupPipeline({
    state: { currentSessionId: 'session-42', ui: {}, ...stateOverrides },
    callbacks: {
      buildTurnRowListMarkup(_rows, _messages, options) {
        captured = options;
        return '<div data-turn-row-list="true"></div>';
      },
      buildMessageShellArticle({ innerHtml }) { return innerHtml; },
    },
  });
  pipeline.buildTurnArticleMarkup(
    { turn_id: 'turn-1', source_message_ids: ['assistant-1'] },
    [{ row_id: 'row-1', turn_id: 'turn-1', kind: 'assistant_text', primary_message_id: 'assistant-1' }],
    [{ id: 'assistant-1', role: 'assistant', status: 'complete', content: 'Stopped.', resumable_stop: 'tool_cap' }],
    renderOptions
  );
  return captured;
}

test('turn-article rows receive the rendered session id for the Resume affordance', () => {
  const captured = captureTurnRowListOptions({
    resumeTailMessageId: 'assistant-1',
    followUpDisabledReason: '',
  });

  assert.equal(captured.sessionId, 'session-42');
  assert.equal(captured.resumeTailMessageId, 'assistant-1');
  assert.equal(captured.resumeSendBusy, false);
});

test('turn-article rows mark Resume send-busy from the follow-up action blocker', () => {
  const captured = captureTurnRowListOptions({
    resumeTailMessageId: 'assistant-1',
    followUpDisabledReason: 'Wait for the current response to finish before trying that.',
  });

  assert.equal(captured.resumeSendBusy, true);
});

test('a budget-stopped tail renders a Resume button carrying a usable session id', () => {
  const rowRenderUtils = createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml: stringUtils.escapeHtml,
    renderMarkdown: (text) => `<p>${stringUtils.escapeHtml(text)}</p>`,
  });
  let rowListHtml = '';
  const pipeline = createArticleMarkupPipeline({
    state: { currentSessionId: 'session-42', ui: {} },
    callbacks: {
      buildTurnRowListMarkup(rows, messages, options) {
        rowListHtml = rowRenderUtils.buildTurnRowListMarkup(rows, messages, options);
        return rowListHtml;
      },
      buildMessageShellArticle({ innerHtml }) { return innerHtml; },
    },
  });

  pipeline.buildTurnArticleMarkup(
    { turn_id: 'turn-1', source_message_ids: ['assistant-1'] },
    [{
      row_id: 'row-1', turn_id: 'turn-1', kind: 'assistant_text',
      primary_message_id: 'assistant-1', assistant_phase: 'final_answer',
      payload: { text: 'Stopped.', segment_group_index: 0 },
    }],
    [{ id: 'assistant-1', role: 'assistant', status: 'complete', content: 'Stopped.', resumable_stop: 'tool_cap' }],
    { resumeTailMessageId: 'assistant-1', followUpDisabledReason: '' }
  );

  const document = new JSDOM(rowListHtml).window.document;
  const button = document.querySelector('[data-action="resume-turn"]');
  assert.ok(button, 'the budget-stopped tail must render a Resume button');
  assert.equal(button.getAttribute('data-resume-session-id'), 'session-42');
  assert.equal(button.getAttribute('data-resume-message-id'), 'assistant-1');
});

test('a trailing proactive suggestion does not steal the resume tail through the article path', () => {
  const messages = [
    { id: 'assistant-1', role: 'assistant', status: 'complete', content: 'Stopped.', resumable_stop: 'tool_cap' },
    { id: 'suggestion-1', role: 'assistant', kind: 'proactive_suggestion', status: 'complete', content: 'Try this' },
  ];
  const rows = [{
    row_id: 'row-1', turn_id: 'turn-1', kind: 'assistant_text',
    primary_message_id: 'assistant-1', assistant_phase: 'final_answer',
    payload: { text: 'Stopped.', segment_group_index: 0 },
  }];
  const turn = { turn_id: 'turn-1', source_message_ids: ['assistant-1'], primary_assistant_message_id: 'assistant-1' };
  let captured = null;
  const pipeline = createArticleMarkupPipeline({
    state: { currentSessionId: 'session-42', ui: {} },
    callbacks: {
      resolveResumeTailAssistantMessageId,
      buildTurnRowListMarkup(_rows, _messages, options) {
        captured = options;
        return '<div data-turn-row-list="true"></div>';
      },
      buildMessageShellArticle({ innerHtml }) { return innerHtml; },
      getMessageFromCollection(id) { return messages.find((message) => message.id === id) || null; },
      canRenderProjectedTurnArticle: () => true,
    },
  });

  // Arg 3 is the id the pipeline normally uses for retry/streaming targeting; the
  // suggestion HAS taken it, which is exactly the state that used to hide Resume.
  pipeline.buildMessageArticleMarkup(messages[0], messages, 'suggestion-1', 'assistant-1', '', null, {
    messageById: new Map(messages.map((message) => [message.id, message])),
    turnIdByMessageId: new Map([['assistant-1', 'turn-1'], ['suggestion-1', 'turn-1']]),
    turnById: new Map([['turn-1', turn]]),
    rowsByTurnId: new Map([['turn-1', rows]]),
    rowsByRenderMessageId: new Map([['assistant-1', rows]]),
    activeTurnId: '',
  });

  assert.ok(captured, 'the turn article must reach the row-list builder');
  assert.equal(captured.resumeTailMessageId, 'assistant-1');
  assert.equal(captured.sessionId, 'session-42');
});
