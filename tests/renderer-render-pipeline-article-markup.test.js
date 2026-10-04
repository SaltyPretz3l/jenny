const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createArticleMarkupPipeline,
} = require('../renderer/chat/renderer-render-pipeline-article-markup');
const {
  createTurnRowRenderUtils,
} = require('../renderer/chat/renderer-turn-row-render-utils');
const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');
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
    ui: { selectionModePaneId: 0, selectedMessageIdsBySession }, // pane 0 (a bag without paneId) owns the mode
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

test('split view W3-1: a pane that does not own selection mode renders no selection chrome', () => {
  const selectedMessageIdsBySession = new Map([['session-1', new Set(['message-1'])]]);
  const state = { currentSessionId: 'session-1', ui: { selectionModePaneId: 1, selectedMessageIdsBySession } };
  const build = (callbacks) => createArticleMarkupPipeline({
    state,
    callbacks: { buildMessageShellArticle: ({ selectionMode, selected }) => ({ selectionMode, selected }), ...callbacks },
  });
  const message = { id: 'message-1', role: 'user', status: 'complete', content: 'Selected prompt' };
  assert.deepEqual(build({}).buildMessageArticleMarkup(message, [message]), { selectionMode: false, selected: false },
    'pane 0 (the default) renders no handle while pane 1 owns the mode');
  assert.deepEqual(build({ isPaneSelecting: () => state.ui.selectionModePaneId === 1 }).buildMessageArticleMarkup(message, [message]),
    { selectionMode: true, selected: true }, 'the owning pane renders its handles');
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

// The answers stylesheet and the prediction's exclusion selector both key on the
// row list's data-turn-live marker, which follows the projection context's
// liveTurnId (the whole in-flight turn, tool gaps included), never the turn
// phase. The article and its height prediction must build the same marker.
function installPretextStubs(t) {
  const previous = {
    document: global.document,
    pretextLayout: global.pretextLayout,
    rendererPretextUtils: global.rendererPretextUtils,
    rendererTurnPhase: global.rendererTurnPhase,
  };
  const pretextModulePath = require.resolve('../renderer/features/renderer-pretext-utils.js');
  const dom = new JSDOM('<!doctype html><div id="thread-column"></div>');
  t.after(() => {
    delete require.cache[pretextModulePath];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
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
  const predictions = [];
  global.rendererPretextUtils = {
    ...pretextUtils,
    isEnabled() { return true; },
    resolveDefaultFontString() { return 'normal normal 400 15px sans-serif'; },
    resolveElementWidth() { return 760; },
    predictHtmlContentHeight(...args) {
      predictions.push({ markup: args[1], options: args[5] });
      return pretextUtils.predictHtmlContentHeight(...args);
    },
  };
  return { dom, predictions };
}

// The real row-list builder, so the marker comes from the production rule.
function createRealRowListPipeline(dom, rowListCalls) {
  const rowList = createTurnRowListUtils({
    buildRowBodyMarkup: (row) => `<div class="row-body">${row.payload.text}</div>`,
  });
  return createArticleMarkupPipeline({
    state: { currentSessionId: 'session-42', ui: {}, features: { featureFlags: { pretext_layout: true } } },
    dom: { chatThreadColumn: dom.window.document.getElementById('thread-column') },
    callbacks: {
      buildTurnRowListMarkup(rows, messages, options) {
        rowListCalls.push(options);
        return rowList.buildTurnRowListMarkup(rows, messages, options);
      },
      buildMessageShellArticle({ innerHtml, predictedHeight }) { return { innerHtml, predictedHeight }; },
    },
  });
}

const ANSWERS_TURN_ROWS = [
  { row_id: 'row-r', turn_id: 'turn-1', kind: 'reasoning', primary_message_id: 'assistant-1', payload: { text: 'reasoning detail '.repeat(400) } },
  { row_id: 'row-t', turn_id: 'turn-1', kind: 'assistant_text', primary_message_id: 'assistant-1', payload: { text: 'Answer.' } },
];

function buildAnswersTurnArticle(pipeline, transcriptView, liveTurnId) {
  return pipeline.buildTurnArticleMarkup(
    { turn_id: 'turn-1', source_message_ids: ['assistant-1'] },
    ANSWERS_TURN_ROWS,
    [{ id: 'assistant-1', role: 'assistant', status: 'complete', content: '' }],
    { transcriptView, projectionContext: { liveTurnId, viewModelByTurnId: new Map([['turn-1', {}]]) } }
  );
}

test('the height prediction builds its row list with the same live-turn marker as the article', (t) => {
  const { dom, predictions } = installPretextStubs(t);
  // A preamble or a tool result reads 'done' mid-turn: the phase must not decide.
  global.rendererTurnPhase = { deriveTurnPhase() { return 'done'; } };
  const rowListCalls = [];
  const article = buildAnswersTurnArticle(createRealRowListPipeline(dom, rowListCalls), 'answers', 'turn-1');

  assert.equal(rowListCalls.length, 1, 'a settled article builds the row list once and predicts from that markup');
  assert.equal(rowListCalls[0].turnLive, true, 'the in-flight turn is live though its phase reads done');
  assert.equal(rowListCalls[0].transcriptView, 'answers');
  assert.equal(predictions.length, 1);
  assert.ok(article.innerHtml.includes(predictions[0].markup), 'the prediction measures the row list of the article itself, live-turn marker included');
  assert.match(predictions[0].markup, /^<div class="turn-row-list"[^>]*data-turn-live="true"/);
  assert.match(article.innerHtml, /class="turn-row-list"[^>]*data-turn-live="true"/);
});

test('skipHeightPrediction builds the row list once and stamps no predicted height (stream-reveal row-list builder)', (t) => {
  const { dom, predictions } = installPretextStubs(t);
  global.rendererTurnPhase = { deriveTurnPhase() { return 'done'; } };
  const rowListCalls = [];
  const pipeline = createRealRowListPipeline(dom, rowListCalls);
  const article = pipeline.buildTurnArticleMarkup(
    { turn_id: 'turn-1', source_message_ids: ['assistant-1'] },
    ANSWERS_TURN_ROWS,
    [{ id: 'assistant-1', role: 'assistant', status: 'complete', content: '' }],
    { transcriptView: 'thinking', skipHeightPrediction: true, projectionContext: { liveTurnId: 'turn-1', viewModelByTurnId: new Map([['turn-1', {}]]) } }
  );
  assert.equal(rowListCalls.length, 1, 'no second row-list build for a prediction the caller discards');
  assert.equal(predictions.length, 0, 'pretext is never consulted');
  assert.equal(article.predictedHeight, null);
  assert.match(article.innerHtml, /class="turn-row-list"[^>]*data-turn-live="true"/, 'the row list itself is unchanged');
});

// The streaming article rewrite keeps the prediction AND takes the segments;
// the prediction's second row-list build must not double the sink (a repeated
// segment would be reconciled as an extra row: 252 -> 395 rows on the long
// managed-turn scenario, timeline-perf 2026-09-30).
test('a segment sink with the height prediction on receives each row once', (t) => {
  const { dom, predictions } = installPretextStubs(t);
  global.rendererTurnPhase = { deriveTurnPhase() { return 'done'; } };
  const rowListCalls = [];
  const pipeline = createRealRowListPipeline(dom, rowListCalls);
  const rowListSegmentSink = [];
  pipeline.buildTurnArticleMarkup(
    { turn_id: 'turn-1', source_message_ids: ['assistant-1'] },
    ANSWERS_TURN_ROWS,
    [{ id: 'assistant-1', role: 'assistant', status: 'complete', content: '' }],
    { transcriptView: 'thinking', rowListSegmentSink, projectionContext: { liveTurnId: 'turn-1', viewModelByTurnId: new Map([['turn-1', {}]]) } }
  );
  assert.equal(rowListCalls.length, 1, 'the settled prediction reuses the article row list, so no second build feeds the sink');
  assert.equal(rowListCalls[0].rowListSegmentSink, rowListSegmentSink, 'the sink of the caller reaches the one build');
  assert.equal(predictions.length, 1);
  const ids = rowListSegmentSink.map((segment) => `${segment.kind}:${segment.id}`);
  assert.equal(new Set(ids).size, ids.length, `each segment once: ${ids.join(', ')}`);
  assert.equal(ids.length, ANSWERS_TURN_ROWS.length);
});

// Option parity for the reuse: the article build and the old standalone
// prediction build agree for a settled turn, so the predicted height is the
// number the two-build path produced (maybePredictTurnHeight without a
// prebuilt row list still builds its own).
test('a settled article predicts the same height from its own row list as the standalone two-build prediction', (t) => {
  const { dom, predictions } = installPretextStubs(t);
  global.rendererTurnPhase = { deriveTurnPhase() { return 'done'; } };
  const pipeline = createRealRowListPipeline(dom, []);
  const turn = { turn_id: 'turn-1', source_message_ids: ['assistant-1'] };
  const messages = [{ id: 'assistant-1', role: 'assistant', status: 'complete', content: '' }];
  for (const [transcriptView, liveTurnId] of [['thinking', ''], ['answers', ''], ['answers', 'turn-1']]) {
    const projectionContext = { liveTurnId, viewModelByTurnId: new Map([['turn-1', {}]]) };
    const before = predictions.length;
    const article = pipeline.buildTurnArticleMarkup(turn, ANSWERS_TURN_ROWS, messages, { transcriptView, projectionContext });
    assert.equal(predictions.length, before + 1, `${transcriptView}/${liveTurnId}: one prediction`);
    const twoBuild = pipeline.maybePredictTurnHeight(turn, ANSWERS_TURN_ROWS, messages, {
      transcriptView, projectionContext, turnPhase: 'done', turnLive: liveTurnId === 'turn-1', sessionId: 'session-42',
    });
    assert.ok(article.predictedHeight > 0);
    assert.equal(article.predictedHeight, twoBuild, `${transcriptView}/${liveTurnId}: same predicted height as the standalone build`);
    assert.equal(predictions[before].markup, predictions.at(-1).markup, 'the standalone build measured the same markup');
  }
});

// A streaming article's row list carries the streaming bubble markup the
// standalone prediction build never had, so it keeps its own prediction build.
test('a streaming article keeps the separate prediction build and still feeds the sink once per row', (t) => {
  const { dom, predictions } = installPretextStubs(t);
  global.rendererTurnPhase = { deriveTurnPhase() { return 'running'; } };
  const rowListCalls = [];
  const pipeline = createRealRowListPipeline(dom, rowListCalls);
  const rowListSegmentSink = [];
  pipeline.buildTurnArticleMarkup(
    { turn_id: 'turn-1', source_message_ids: ['assistant-1'] },
    ANSWERS_TURN_ROWS,
    [{ id: 'assistant-1', role: 'assistant', status: 'streaming', content: '' }],
    {
      transcriptView: 'thinking', isStreaming: true, rowListSegmentSink,
      projectionContext: { liveTurnId: 'turn-1', activeStreamingMessageId: 'assistant-1', viewModelByTurnId: new Map([['turn-1', {}]]) },
    }
  );
  assert.equal(rowListCalls.length, 2, 'the streaming prediction builds its own row list');
  assert.equal(rowListCalls[1].rowListSegmentSink, null, 'and never feeds the sink of the caller');
  assert.equal(predictions.length, 1);
  const ids = rowListSegmentSink.map((segment) => `${segment.kind}:${segment.id}`);
  assert.equal(new Set(ids).size, ids.length, `each segment once: ${ids.join(', ')}`);
});

test('a historical turn whose phase still reads running_tool is not live: only liveTurnId marks a turn', (t) => {
  const { dom } = installPretextStubs(t);
  global.rendererTurnPhase = { deriveTurnPhase() { return 'running_tool'; } };
  const rowListCalls = [];
  const article = buildAnswersTurnArticle(createRealRowListPipeline(dom, rowListCalls), 'answers', 'turn-2');
  assert.doesNotMatch(article.innerHtml, /data-turn-live/);
  assert.deepEqual(rowListCalls.map((options) => options.turnLive), [false]);
});

// TV-7e: the real ANSWERS_VIEW_PREDICTION_OPTIONS exclusion through the real
// pretext predictHtmlContentHeight. A settled Answers turn drops its reasoning
// rows (the stylesheet hides them); the live turn keeps its header line.
test('the Answers height prediction excludes a settled turn\'s reasoning rows and keeps the live turn\'s', (t) => {
  const { dom, predictions } = installPretextStubs(t);
  global.rendererTurnPhase = { deriveTurnPhase() { return 'done'; } };
  const pipeline = createRealRowListPipeline(dom, []);

  const settledAnswers = buildAnswersTurnArticle(pipeline, 'answers', '').predictedHeight;
  assert.match(predictions.at(-1).options.excludeSelector,
    /\.turn-row-list:not\(\[data-turn-live="true"\]\) \.chat-row\[data-row-kind="reasoning"\]/);
  const liveAnswers = buildAnswersTurnArticle(pipeline, 'answers', 'turn-1').predictedHeight;
  const settledThinking = buildAnswersTurnArticle(pipeline, 'thinking', '').predictedHeight;
  assert.ok(settledAnswers > 0, 'the answer row is still predicted');
  assert.ok(settledAnswers * 10 < liveAnswers, `settled Answers (${settledAnswers}) drops the reasoning the live turn (${liveAnswers}) keeps`);
  assert.equal(liveAnswers, settledThinking, 'the live Answers turn predicts like Thinking');
});

// liveTurnId spans the in-flight turn through the tool gap (no streaming
// message, no pending stream) via the hydration pipeline's stream-ownership
// check on the NEWEST turn only: an older turn with an unresolved tool never
// reads live, and the terminal (lifecycle settling) clears it.
test('liveTurnId: only the newest in-flight turn is live; a historical unresolved tool never is', () => {
  const { createProjectionContextPipeline } = require('../renderer/chat/renderer-render-pipeline-projection-context');
  const { createHydrationPipeline } = require('../renderer/chat/renderer-render-pipeline-hydration');
  const state = {
    currentSessionId: 'session-1',
    pendingStreams: new Map(),
    ui: { chatSendLifecycleBySession: new Map() },
  };
  const hydration = createHydrationPipeline({ state, callbacks: { getRegisteredStreamIdForSession: () => null } });
  const oldTurn = { turn_id: 'turn-old', source_message_ids: ['assistant-old'], primary_assistant_message_id: 'assistant-old' };
  const newTurn = { turn_id: 'turn-new', source_message_ids: ['assistant-new'], primary_assistant_message_id: 'assistant-new' };
  let oldTurnToolState = 'running';
  const pipeline = createProjectionContextPipeline({
    state,
    callbacks: {
      projectTurnTree: () => ({ turns: [] }),
      projectTurnRows: () => [],
      buildHydratedTurnProjection: () => ({
        turnTree: { turns: [oldTurn, newTurn] },
        turnById: new Map([['turn-old', oldTurn], ['turn-new', newTurn]]),
        turnIdByMessageId: new Map([['assistant-old', 'turn-old'], ['assistant-new', 'turn-new']]),
        rowsByTurnId: new Map([
          ['turn-old', [{ kind: 'tool_call', turn_id: 'turn-old', tool_call_id: 'call-old', payload: { state: oldTurnToolState } }]],
          ['turn-new', []],
        ]),
        rowByPrimaryMessageId: new Map(),
        rowsByRenderMessageId: new Map(),
        viewModelByTurnId: new Map(),
      }),
      isTurnStreamLive: hydration.isTurnStreamLive,
    },
  });
  const messages = [
    { id: 'assistant-old', role: 'assistant', status: 'complete', content: '' },
    { id: 'assistant-new', role: 'assistant', status: 'complete', content: 'Preamble.' },
  ];
  const liveTurnId = () => pipeline.buildProjectionContext(messages, null, {}, {}).liveTurnId;

  for (const toolState of ['running', 'interrupted']) {
    oldTurnToolState = toolState;
    state.ui.chatSendLifecycleBySession.set('session-1', 'idle');
    assert.equal(liveTurnId(), '', `idle: an old ${toolState} tool is not live`);
    state.ui.chatSendLifecycleBySession.set('session-1', 'streaming');
    assert.equal(liveTurnId(), 'turn-new', `tool gap: the newest turn is live, never the old ${toolState} one`);
    state.ui.chatSendLifecycleBySession.set('session-1', 'settling');
    assert.equal(liveTurnId(), '', 'the terminal flips the lifecycle to settling: nothing is live');
  }
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

// 2026-09-27 gate N4: message bodies carry dir="auto" so English keeps LTR
// punctuation under the Arabic locale; the article chrome carries no dir.
test('legacy article bubbles take the direction of their text', () => {
  const pipeline = createArticleMarkupPipeline({
    state: { currentSessionId: 'session-1', ui: {} },
    callbacks: {
      escapeHtml: stringUtils.escapeHtml,
      renderMarkdown: (text) => `<p>${stringUtils.escapeHtml(text)}</p>`,
      buildMessageShellArticle({ innerHtml }) { return `<article class="chat-entry">${innerHtml}</article>`; },
      buildMessageBodyShell: (_id, innerHtml) => innerHtml,
      buildAssistantContentShell: (_id, innerHtml) => innerHtml,
    },
  });
  const messages = [
    { id: 'user-1', role: 'user', status: 'complete', content: 'What changed?' },
    { id: 'assistant-1', role: 'assistant', status: 'complete', content: 'nothing at all.' },
  ];
  for (const message of messages) {
    const document = new JSDOM(pipeline.buildMessageArticleMarkup(message, messages)).window.document;
    const bubble = document.querySelector('.chat-bubble');
    assert.ok(bubble, `${message.role} renders a bubble`);
    assert.equal(bubble.getAttribute('dir'), 'auto', `${message.role} bubble`);
    assert.equal(document.querySelector('.chat-entry').hasAttribute('dir'), false, 'the article chrome inherits');
  }
});

test('source_citations: the per-message fallback strips settled [web:N] markers only when the flag is on', () => {
  const markupFor = (enabled) => {
    const pipeline = createArticleMarkupPipeline({
      state: { currentSessionId: 'session-1', features: { featureFlags: { source_citations: enabled } } },
    });
    const message = { id: 'assistant-1', role: 'assistant', status: 'complete', content: 'Built in 1889 [web:1].' };
    return pipeline.buildMessageInnerMarkup(message, [message], 'assistant-other').innerHtml;
  };
  assert.match(markupFor(true), /Built in 1889\./);
  assert.doesNotMatch(markupFor(true), /web:1/);
  assert.match(markupFor(false), /Built in 1889 \[web:1\]\./);
});
