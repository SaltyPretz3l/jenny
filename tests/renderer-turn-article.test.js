const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createRenderPipeline } = require('../renderer/chat/renderer-render-pipeline-utils');
const { createArticleMarkupPipeline } = require('../renderer/chat/renderer-render-pipeline-article-markup');
const { createTranscriptThinkingRenderer } = require('../renderer/chat/renderer-transcript-thinking');
const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createPipeline(options = {}) {
  const state = {
    currentSessionId: 'session-turn-article',
    ui: {
      threadBranchesCollapsedBySession: new Map(),
      chatTimelineRowModelBySession: new Map(),
      chatTimelineLiveStateBySession: new Map(),
      chatTimelineRowModelMetaBySession: new Map(),
    },
    messagesBySession: new Map(),
  };
  return createRenderPipeline({
    state,
    constants: {
      MESSAGE_STATUS: { STREAMING: 'streaming' },
      ACTIVITY_SCOPE: {},
      staticModel: '',
    },
    dom: {},
    controllers: {
      thinkingController: {
        isPhaseExpanded() { return false; },
        getPhaseToggleA11y(messageId, thinkingId) {
          return {
            panelId: `reasoning-panel-${messageId}-${thinkingId || 'default'}`,
            ariaControls: `reasoning-panel-${messageId}-${thinkingId || 'default'}`,
            ariaExpanded: 'false',
          };
        },
      },
      reducedMotionQuery: { matches: false },
      thinkingIndicator: null,
    },
    runtime: {
      uiRuntime: {
        projectionContextBySession: new Map(),
        toolRowProjectionFallbacksBySession: new Map(),
        toolRowProjectionFailuresBySession: new Map(),
      },
      spriteRuntime: {},
    },
    callbacks: {
      escapeHtml,
      getCurrentSessionMessages() { return []; },
      getCurrentVisibleMessages() { return []; },
      getVisibleSessionMessages() { return []; },
      getLatestAssistantMessageId() { return ''; },
      getLatestReplyAssistantMessageId() { return ''; },
      getLatestUserMessageId() { return ''; },
      resolveRegenerateRequest() { return null; },
      buildAssistantMetaLabel(message) { return `meta:${String(message?.id || '')}`; },
      shouldShowThinkingToggle(message) {
        return Array.isArray(message?.reasoning?.entries) && message.reasoning.entries.length > 0;
      },
      renderMessageAttachments() { return ''; },
      renderToolCallBlock(message, _messages, options) {
        return `<div class="tool-block" data-tool-message-id="${escapeHtml(message.id)}" data-tool-call-id="${escapeHtml(options?.projectedToolRow?.payload?.tool_call_id || '')}"></div>`;
      },
      buildInteractiveRecapViewModel() { return null; },
      renderInteractiveRoundRecap() { return ''; },
      renderProactiveSuggestionBlock() { return ''; },
      renderSlashCommandOutput() { return ''; },
      renderThinkingWidget(message) {
        return `<div class="thinking-widget" data-message-id="${escapeHtml(message.id)}">${escapeHtml(message.reasoning?.entries?.map((entry) => entry.text).join('|') || '')}</div>`;
      },
      renderAgentStatusWidget() { return ''; },
      renderAssistantFailureNotice() { return ''; },
      renderContextCompactedNotice() { return ''; },
      renderMessageHoverRow(message, _actionOptions, metaLabel) {
        return `<div class="message-hover-row" data-action-target-message-id="${escapeHtml(message.id)}" data-meta-label="${escapeHtml(metaLabel || '')}"></div>`;
      },
      isSendBusy() { return false; },
      isAnySendBusy() { return false; },
      isSessionStreaming() { return false; },
      hasPendingToolApprovalForSession() { return false; },
      getActiveStreamSessionId() { return ''; },
      isSendPreflightPending() { return false; },
      updateTokenDisplay() {},
      isInteractiveRoundRecapExpanded() { return false; },
      pruneInteractiveRoundRecapExpansionState() {},
      setFollowLatest() {},
      scheduleMessageViewportSync() {},
      normalizeConversationMode() { return 'chat'; },
      getPendingQuestionBatch() { return null; },
      hasStalePendingQuestionBatch() { return false; },
      getActivitySnapshot() { return null; },
      getMostRecentActivity() { return null; },
      isActivityBusy() { return false; },
      applyActivityAttributes() {},
      renderComposerInteractivePanel() { return ''; },
      closeComposerPopover() {},
      syncComposerInputHeight() {},
      setComposerHoloState() {},
      updateComposerSafeOffset() {},
      renderSessions() {},
      renderWorkspaceChrome() {},
      renderSettings() {},
      renderArtifactsPanel() {},
      renderArtifactReviewPanel() {},
      getArtifactsForSession() { return []; },
      selectArtifact() {},
      isArtifactReviewVisible() { return false; },
      renderContextPanel() {},
      renderHomePanel() {},
      shouldRenderHomePanel() { return false; },
      renderAttachmentTray() {},
      renderComposerStatusNotice() {},
      renderToastViewport() {},
      renderComposerPopover() {},
      renderCommandPopover() {},
      clearActivity() {},
      failActivity() {},
      beginActivity() {},
      getCurrentRuntimePreferences() { return {}; },
      syncComposerModelSelectWidth() {},
      renderComposerEnhancements() {},
      renderMarkdown(text) { return `<p>${escapeHtml(text)}</p>`; },
      renderStreamingMarkdownUnits(text) {
        return { html: `<p>${escapeHtml(text)}</p>`, units: [], fingerprints: [], changedStartIndex: -1 };
      },
      publishLifecycleStatus() {},
      renderBackendBanner() {},
      getChatSendLifecycle() { return 'idle'; },
      getChatTimelineRowModelEnabled() { return false; },
      recordChatTimelineRolloutSignal() { return { logged: false, count: 0 }; },
      rollbackChatTimelineRowModel() { return false; },
      refreshActiveSurfaceEffect() {},
      appendClientLog() {},
      renderHeader() {},
      renderPrompts() {},
      stopFallbackRotation() {},
    },
  });
}

function createArticleMarkupHarness(options = {}) {
  const recordTurnArticleRolloutSignal = typeof options.recordTurnArticleRolloutSignal === 'function'
    ? options.recordTurnArticleRolloutSignal
    : () => ({ logged: false, count: 0 });
  return createArticleMarkupPipeline({
    state: { currentSessionId: 'session-article-harness', ui: options.ui || {} },
    constants: { MESSAGE_STATUS: { STREAMING: 'streaming' } },
    callbacks: {
      escapeHtml,
      renderMarkdown: options.renderMarkdown || function renderMarkdown(text) { return `<p>${escapeHtml(text)}</p>`; },
      buildMessageShellArticle({ className, innerHtml }) {
        return `<article class="chat-message ${escapeHtml(className)}">${innerHtml}</article>`;
      },
      buildMessageBodyShell(_messageId, innerHtml) { return innerHtml; },
      buildAssistantMetaLabel(message) {
        return String(message?.role || '') === 'assistant' ? `meta:${String(message?.id || '')}` : '';
      },
      buildMessageTokenMeta: contextUsageUtils.buildMessageTokenMeta,
      formatMessageTokenMeta: contextUsageUtils.formatMessageTokenMeta,
      combineMessageMetaLabels: contextUsageUtils.combineMessageMetaLabels,
      renderMessageHoverRow(message, _actionOptions, metaLabel) {
        return `<div class="message-hover-row" data-action-target-message-id="${escapeHtml(message.id)}" data-meta-label="${escapeHtml(metaLabel || '')}"></div>`;
      },
      recordTurnArticleRolloutSignal,
    },
  });
}

function createProjectionContext(messages, turn, options = {}) {
  const viewModelByTurnId = new Map();
  if (options.viewModel) viewModelByTurnId.set(turn.turn_id, options.viewModel);
  return {
    messageById: new Map(messages.map((message) => [message.id, message])),
    turnById: new Map([[turn.turn_id, turn]]),
    turnIdByMessageId: new Map(turn.source_message_ids.map((messageId) => [messageId, turn.turn_id])),
    viewModelByTurnId,
    activeStreamingMessageId: String(options.activeStreamingMessageId || ''),
  };
}

test('predicted-height cleanup preserves virtualized placeholder geometry', (t) => {
  const dom = new JSDOM('<!doctype html><div id="timeline"></div>');
  t.after(() => dom.window.close());
  const timeline = dom.window.document.getElementById('timeline');
  const mounted = dom.window.document.createElement('article');
  mounted.dataset.predictedHeight = '180';
  mounted.style.minHeight = '180px';
  const virtualized = dom.window.document.createElement('article');
  virtualized.dataset.predictedHeight = '900';
  virtualized.dataset.virtualized = 'true';
  virtualized.style.minHeight = '900px';
  timeline.append(mounted, virtualized);
  const pipeline = createArticleMarkupPipeline({ dom: { chatTimeline: timeline } });

  pipeline.schedulePredictedHeightCleanup();

  assert.equal(mounted.style.minHeight, '', 'mounted prediction is temporary');
  assert.equal(virtualized.style.minHeight, '900px', 'placeholder geometry remains owned by the virtualizer');
});

test('turn article builder renders a plain assistant turn with canonical article and row attributes', () => {
  const pipeline = createPipeline();
  const turn = {
    turn_id: 'turn_plain',
    primary_assistant_message_id: 'assistant_plain',
    source_message_ids: ['user_plain', 'assistant_plain'],
  };
  const rows = [{
    row_id: 'row:plain',
    turn_id: 'turn_plain',
    kind: 'assistant_text',
    primary_message_id: 'assistant_plain',
    payload: { text: 'Hello from the turn article.', segment_group_index: 0 },
  }];
  const messages = [
    { id: 'user_plain', role: 'user', content: 'Hi', status: 'complete' },
    { id: 'assistant_plain', role: 'assistant', content: 'Hello from the turn article.', status: 'complete' },
  ];

  const html = pipeline.buildTurnArticleMarkup(turn, rows, messages, {
    projectionContext: createProjectionContext(messages, turn),
  });

  assert.match(html, /data-message-id="assistant_plain"/);
  assert.match(html, /data-turn-id="turn_plain"/);
  assert.match(html, /data-row-id="turn_plain:assistant_text:0"/);
  assert.match(html, /data-action-target-message-id="assistant_plain"/);
});

test('legacy user article rendering does not emit rollout warning signals', () => {
  const signals = [];
  const pipeline = createArticleMarkupHarness({
    recordTurnArticleRolloutSignal(signal, details) {
      signals.push({ signal, details });
      return { logged: true, count: signals.length };
    },
  });
  const userMessage = {
    id: 'user_legacy_normal',
    role: 'user',
    content: 'Hello Jenny',
    status: 'complete',
  };

  pipeline.buildMessageArticleMarkup(
    userMessage,
    [userMessage],
    '',
    '',
    '',
    null,
    null
  );

  assert.deepEqual(signals, []);
});

test('legacy user articles render Markdown with breaks while editing keeps raw source', () => {
  const calls = [];
  const renderMarkdown = (text, options) => {
    calls.push({ text, options });
    return '<p><strong>rendered</strong><br>line</p>';
  };
  const message = { id: 'user_markdown', role: 'user', content: '**raw**\nline', status: 'complete' };
  const normal = createArticleMarkupHarness({ renderMarkdown }).buildMessageArticleMarkup(
    message, [message], '', '', '', null, null
  );
  const editing = createArticleMarkupHarness({
    renderMarkdown,
    ui: { editingMessageId: 'user_markdown', editingDraftText: '**raw**\nline' },
  }).buildMessageArticleMarkup(message, [message], '', '', '', null, null);

  assert.deepEqual(calls, [{ text: '**raw**\nline', options: { breaks: true } }]);
  assert.match(normal, /chat-bubble chat-bubble-markdown/);
  assert.match(normal, /<strong>rendered<\/strong><br>line/);
  assert.match(editing, /\*\*raw\*\*/);
  assert.doesNotMatch(editing, /<strong>rendered<\/strong>/);
});

test('turn article builder targets hover actions at the last assistant text row in segmented turns', () => {
  const pipeline = createPipeline();
  const turn = {
    turn_id: 'turn_segmented',
    primary_assistant_message_id: 'assistant_seg0',
    source_message_ids: ['user_seg', 'assistant_seg0', 'tool_use_seg', 'assistant_seg1'],
  };
  const rows = [
    {
      row_id: 'row:seg0',
      turn_id: 'turn_segmented',
      kind: 'assistant_text',
      primary_message_id: 'assistant_seg0',
      payload: { text: 'First half', segment_group_index: 0 },
    },
    {
      row_id: 'row:tool',
      turn_id: 'turn_segmented',
      kind: 'tool_step',
      primary_message_id: 'tool_use_seg',
      tool_call_id: 'call_seg',
      payload: { tool_call_id: 'call_seg', state: 'completed' },
    },
    {
      row_id: 'row:seg1',
      turn_id: 'turn_segmented',
      kind: 'assistant_text',
      primary_message_id: 'assistant_seg1',
      payload: { text: 'Second half', segment_group_index: 1 },
    },
  ];
  const messages = [
    { id: 'assistant_seg0', role: 'assistant', content: 'First half', status: 'complete' },
    { id: 'tool_use_seg', role: 'assistant', kind: 'tool_use', status: 'complete', tool_call: { call_id: 'call_seg' } },
    { id: 'assistant_seg1', role: 'assistant', content: 'Second half', status: 'complete' },
  ];

  const html = pipeline.buildTurnArticleMarkup(turn, rows, messages, {
    projectionContext: createProjectionContext(messages, turn),
  });

  assert.match(html, /data-message-id="assistant_seg0"/);
  assert.match(html, /data-action-target-message-id="assistant_seg1"/);
});

test('turn article builder keeps reasoning rows ahead of assistant text rows', () => {
  const pipeline = createPipeline();
  const turn = {
    turn_id: 'turn_reasoning',
    primary_assistant_message_id: 'assistant_reasoning',
    source_message_ids: ['assistant_reasoning'],
  };
  const rows = [
    {
      row_id: 'row:reasoning',
      turn_id: 'turn_reasoning',
      kind: 'reasoning',
      primary_message_id: 'assistant_reasoning',
      payload: {
        phase_id: 'phase_reasoning',
        thinking_id: 'think_reasoning',
        entries: [{ text: 'Think first' }],
      },
    },
    {
      row_id: 'row:text',
      turn_id: 'turn_reasoning',
      kind: 'assistant_text',
      primary_message_id: 'assistant_reasoning',
      payload: { text: 'Answer second', segment_group_index: 0 },
    },
  ];
  const messages = [
    { id: 'assistant_reasoning', role: 'assistant', content: 'Answer second', status: 'complete' },
  ];

  const html = pipeline.buildTurnArticleMarkup(turn, rows, messages, {
    projectionContext: createProjectionContext(messages, turn),
  });

  assert.ok(html.indexOf('turn_reasoning:reasoning:phase_reasoning') < html.indexOf('turn_reasoning:assistant_text:0'));
});

test('turn article builder renders single-tool turns with canonical tool row identity', () => {
  const pipeline = createPipeline();
  const turn = {
    turn_id: 'turn_tool',
    primary_assistant_message_id: 'tool_use_1',
    source_message_ids: ['tool_use_1', 'assistant_after_tool'],
  };
  const rows = [
    {
      row_id: 'row:tool',
      turn_id: 'turn_tool',
      kind: 'tool_step',
      primary_message_id: 'tool_use_1',
      tool_call_id: 'call_1',
      payload: { tool_call_id: 'call_1', state: 'completed' },
    },
    {
      row_id: 'row:text',
      turn_id: 'turn_tool',
      kind: 'assistant_text',
      primary_message_id: 'assistant_after_tool',
      payload: { text: 'Tool finished.', segment_group_index: 0 },
    },
  ];
  const messages = [
    { id: 'tool_use_1', role: 'assistant', kind: 'tool_use', status: 'complete', tool_call: { call_id: 'call_1' } },
    { id: 'assistant_after_tool', role: 'assistant', content: 'Tool finished.', status: 'complete' },
  ];

  const html = pipeline.buildTurnArticleMarkup(turn, rows, messages, {
    projectionContext: createProjectionContext(messages, turn),
  });

  assert.match(html, /data-message-id="tool_use_1"/);
  assert.match(html, /data-row-id="turn_tool:tool_step:call_1"/);
  assert.match(html, /data-tool-call-id="call_1"/);
});

test('turn article builder preserves distinct tool call ids across multi-tool turns', () => {
  const pipeline = createPipeline();
  const turn = {
    turn_id: 'turn_multi_tool',
    primary_assistant_message_id: 'assistant_multi',
    source_message_ids: ['assistant_multi', 'tool_use_1', 'tool_use_2'],
  };
  const rows = [
    {
      row_id: 'row:text',
      turn_id: 'turn_multi_tool',
      kind: 'assistant_text',
      primary_message_id: 'assistant_multi',
      payload: { text: 'Two tools ran.', segment_group_index: 0 },
    },
    {
      row_id: 'row:tool1',
      turn_id: 'turn_multi_tool',
      kind: 'tool_step',
      primary_message_id: 'tool_use_1',
      tool_call_id: 'call_1',
      payload: { tool_call_id: 'call_1', state: 'completed' },
    },
    {
      row_id: 'row:tool2',
      turn_id: 'turn_multi_tool',
      kind: 'tool_step',
      primary_message_id: 'tool_use_2',
      tool_call_id: 'call_2',
      payload: { tool_call_id: 'call_2', state: 'completed' },
    },
  ];
  const messages = [
    { id: 'assistant_multi', role: 'assistant', content: 'Two tools ran.', status: 'complete' },
    { id: 'tool_use_1', role: 'assistant', kind: 'tool_use', status: 'complete', tool_call: { call_id: 'call_1' } },
    { id: 'tool_use_2', role: 'assistant', kind: 'tool_use', status: 'complete', tool_call: { call_id: 'call_2' } },
  ];

  const html = pipeline.buildTurnArticleMarkup(turn, rows, messages, {
    projectionContext: createProjectionContext(messages, turn),
  });

  assert.match(html, /data-row-id="turn_multi_tool:tool_step:call_1"/);
  assert.match(html, /data-row-id="turn_multi_tool:tool_step:call_2"/);
  assert.equal((html.match(/data-row-id="turn_multi_tool:tool_step:/g) || []).length, 2);
});

test('turn article builder returns an empty row list but still emits the article shell for empty turns', () => {
  const pipeline = createPipeline();
  const turn = {
    turn_id: 'turn_empty',
    primary_assistant_message_id: 'assistant_empty',
    source_message_ids: ['assistant_empty'],
  };
  const messages = [
    { id: 'assistant_empty', role: 'assistant', content: '', status: 'complete' },
  ];

  const html = pipeline.buildTurnArticleMarkup(turn, [], messages, {
    projectionContext: createProjectionContext(messages, turn),
  });

  assert.match(html, /data-message-id="assistant_empty"/);
  assert.match(html, /data-turn-row-list="true"/);
});

function buildPlanObjectTurnFixture() {
  const turn = {
    turn_id: 'turn_plan_object',
    primary_assistant_message_id: 'assistant_plan_final',
    source_message_ids: ['user_plan', 'assistant_plan_final'],
  };
  const planRow = {
    row_id: 'row:plan',
    turn_id: 'turn_plan_object',
    kind: 'plan_object',
    primary_message_id: 'assistant_plan_final',
    render_message_id: 'assistant_plan_final',
    payload: {
      plan_id: 'plan_1',
      summary: 'Write the ballerina script',
      status: 'completed',
      steps: [{ summary: 'Create the file', status: 'completed' }],
    },
  };
  const textRow = {
    row_id: 'row:text',
    turn_id: 'turn_plan_object',
    kind: 'assistant_text',
    primary_message_id: 'assistant_plan_final',
    render_message_id: 'assistant_plan_final',
    payload: { text: 'Plan executed.', segment_group_index: 0 },
  };
  const messages = [
    { id: 'user_plan', role: 'user', content: 'Plan it', status: 'complete' },
    { id: 'assistant_plan_final', role: 'assistant', content: 'Plan executed.', status: 'complete' },
  ];
  return { turn, rows: [planRow, textRow], messages };
}

test('plan-mode turns with a plan_object row route to the projected article path, not legacy', () => {
  const signals = [];
  const pipeline = createArticleMarkupHarness({
    recordTurnArticleRolloutSignal(signal, details) {
      signals.push({ signal, details });
      return { logged: true, count: signals.length };
    },
  });
  const { turn, rows, messages } = buildPlanObjectTurnFixture();
  const projectionContext = {
    ...createProjectionContext(messages, turn),
    rowsByTurnId: new Map([['turn_plan_object', rows]]),
    rowsByRenderMessageId: new Map([['assistant_plan_final', rows]]),
  };

  pipeline.buildMessageArticleMarkup(messages[1], messages, '', '', '', null, projectionContext);

  assert.deepEqual(
    signals.filter((entry) => entry.signal === 'legacy_message_article_markup_render'),
    [],
    'a plan_object row must not push the whole turn onto the legacy article path'
  );

  // Inverse guard: a genuinely-unknown row kind still routes to legacy.
  const unknownRows = rows.map((row) => (row.kind === 'plan_object' ? { ...row, kind: 'mystery_kind' } : row));
  const unknownContext = {
    ...createProjectionContext(messages, turn),
    rowsByTurnId: new Map([['turn_plan_object', unknownRows]]),
    rowsByRenderMessageId: new Map([['assistant_plan_final', unknownRows]]),
  };
  pipeline.buildMessageArticleMarkup(messages[1], messages, '', '', '', null, unknownContext);
  assert.equal(
    signals.filter((entry) => entry.signal === 'legacy_message_article_markup_render').length,
    1,
    'unknown row kinds must still fall back to the legacy article path'
  );
});

test('turn_activity_envelope coalesces a multi-message turn into one article + compat anchors', (t) => {
  // The coalesce branch reads the flag off document.documentElement.dataset;
  // stand up a minimal fake document for the duration of this test.
  const hadDocument = 'document' in globalThis;
  const priorDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: { turnActivityEnvelope: 'true' } } };
  // In the app the coalesce helpers self-register via their script tag; under
  // node the UMD wrapper exports instead, so publish them for the dispatcher.
  const priorCoalesceUtils = globalThis.rendererTurnArticleCoalesceUtils;
  globalThis.rendererTurnArticleCoalesceUtils = require('../renderer/chat/renderer-turn-article-coalesce-utils');
  t.after(() => {
    if (hadDocument) {
      globalThis.document = priorDocument;
    } else {
      delete globalThis.document;
    }
    globalThis.rendererTurnArticleCoalesceUtils = priorCoalesceUtils;
  });

  // Dispatcher-level harness with REAL shell + row-list deps so the coalesced
  // article markup is asserted end to end (createPipeline exposes only the
  // turn-article builder, not the dispatcher).
  const { createTurnShellRenderer } = require('../renderer/chat/renderer-turn-shell');
  const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');
  const shellRenderer = createTurnShellRenderer({ escapeHtml });
  const rowList = createTurnRowListUtils({
    escapeHtml,
    normalizeId: (value) => String(value == null ? '' : value).trim(),
    buildRowBodyMarkup: (row) => `<div class="chat-bubble-markdown">${escapeHtml(String(row?.payload?.text || row?.kind || ''))}</div>`,
    isStreamingRow: () => false,
  });
  const pipeline = createArticleMarkupPipeline({
    state: { currentSessionId: 'session-coalesce', ui: {} },
    constants: { MESSAGE_STATUS: { STREAMING: 'streaming' } },
    callbacks: {
      escapeHtml,
      renderMarkdown(text) { return `<p>${escapeHtml(text)}</p>`; },
      buildMessageShellArticle: shellRenderer.buildMessageShellArticle,
      buildTurnRowListMarkup: rowList.buildTurnRowListMarkup,
      getMessageFromCollection(messageId, messages, projectionContext) {
        return projectionContext?.messageById?.get?.(messageId)
          || (Array.isArray(messages) ? messages.find((m) => m && m.id === messageId) : null)
          || null;
      },
      deriveActionTargetMessageId() { return 'seg_final'; },
      buildAssistantMetaLabel() { return ''; },
      buildMessageTokenMeta: contextUsageUtils.buildMessageTokenMeta,
      formatMessageTokenMeta: contextUsageUtils.formatMessageTokenMeta,
      combineMessageMetaLabels: contextUsageUtils.combineMessageMetaLabels,
      renderMessageHoverRow() { return ''; },
      recordTurnArticleRolloutSignal() { return { logged: false, count: 0 }; },
    },
  });
  const turn = {
    turn_id: 'turn_coalesce',
    primary_assistant_message_id: 'seg_final',
    source_message_ids: ['user_c', 'seg_holder', 'seg_final'],
  };
  const reasoningRow = {
    row_id: 'row:c-reason',
    turn_id: 'turn_coalesce',
    kind: 'reasoning',
    primary_message_id: 'seg_holder',
    render_message_id: 'seg_holder',
    phase_id: 'phase_c1',
    payload: { phase_id: 'phase_c1', entries: [{ id: 'e1', text: 'thinking' }] },
  };
  const answerRow = {
    row_id: 'row:c-answer',
    turn_id: 'turn_coalesce',
    kind: 'assistant_text',
    primary_message_id: 'seg_final',
    render_message_id: 'seg_final',
    payload: { text: 'Answer.', segment_group_index: 0 },
  };
  const rows = [reasoningRow, answerRow];
  const messages = [
    { id: 'user_c', role: 'user', content: 'Do it', status: 'complete' },
    { id: 'seg_holder', role: 'assistant', content: '', status: 'complete' },
    { id: 'seg_final', role: 'assistant', content: 'Answer.', status: 'complete' },
  ];
  const projectionContext = {
    ...createProjectionContext(messages, turn),
    rowsByTurnId: new Map([['turn_coalesce', rows]]),
    rowsByRenderMessageId: new Map([
      ['seg_holder', [reasoningRow]],
      ['seg_final', [answerRow]],
    ]),
  };

  // Anchor (first assistant render message) hosts the WHOLE turn.
  const anchorHtml = pipeline.buildMessageArticleMarkup(messages[1], messages, '', '', '', null, projectionContext);
  assert.match(anchorHtml, /data-message-id="seg_holder"/);
  assert.match(anchorHtml, /data-row-id="row:c-reason"|turn_coalesce:reasoning/);
  assert.match(anchorHtml, /Answer\./, 'the final answer row must render inside the coalesced article');

  // The other assistant message of the turn collapses to a compat anchor.
  const siblingHtml = pipeline.buildMessageArticleMarkup(messages[2], messages, '', '', '', null, projectionContext);
  assert.match(siblingHtml, /thread-compat-anchor/);
  assert.doesNotMatch(siblingHtml, /Answer\./);

  // Envelope siblings render DOTLESS: the coalesced article's own rows carry
  // the rail landmarks, so a sibling landmark dot would strand a lone rail
  // dot below the turn (the trailing rail-dot defect).
  assert.match(siblingHtml, /data-thread-compat-enveloped="true"/);
  assert.doesNotMatch(siblingHtml, /chat-row-node-dot/);

  // tool_result compat anchors agree with their turn's coalesced shape…
  const toolResultMessage = { id: 'tool_result_c', role: 'tool', kind: 'tool_result', content: 'ok', status: 'complete' };
  projectionContext.turnIdByMessageId.set('tool_result_c', 'turn_coalesce');
  projectionContext.messageById.set('tool_result_c', toolResultMessage);
  const toolResultHtml = pipeline.buildMessageArticleMarkup(toolResultMessage, messages, '', '', '', null, projectionContext);
  assert.match(toolResultHtml, /data-thread-compat-enveloped="true"/);
  assert.doesNotMatch(toolResultHtml, /chat-row-node-dot/);

  // …and keep the legacy tool-parent rail-gap dot when the envelope is off.
  globalThis.document.documentElement.dataset.turnActivityEnvelope = 'false';
  const legacyToolResultHtml = pipeline.buildMessageArticleMarkup(toolResultMessage, messages, '', '', '', null, projectionContext);
  globalThis.document.documentElement.dataset.turnActivityEnvelope = 'true';
  assert.match(legacyToolResultHtml, /chat-row-node-dot/);
  assert.doesNotMatch(legacyToolResultHtml, /data-thread-compat-enveloped/);
});

test('projected turn article renders legacy plan_object as a collapsed receipt', () => {
  const pipeline = createPipeline();
  const { turn, rows, messages } = buildPlanObjectTurnFixture();

  const html = pipeline.buildTurnArticleMarkup(turn, rows, messages, {
    projectionContext: createProjectionContext(messages, turn),
  });

  assert.match(html, /data-turn-id="turn_plan_object"/);
  assert.match(html, /plan-document-receipt/);
  assert.match(html, /data-row-id="turn_plan_object:plan_object:plan_1"/);
  assert.match(html, /Create the file/);
});

test('F8: legacy user message articles include estimated token hover meta', () => {
  const pipeline = createArticleMarkupHarness();
  const messages = [
    { id: 'user_tokens', role: 'user', content: '12345678', status: 'complete' },
    { id: 'assistant_tokens', role: 'assistant', content: '123456789', status: 'complete' },
  ];

  const model = pipeline.buildMessageInnerMarkup(
    messages[0],
    messages,
    '',
    'assistant_tokens',
    '',
    null,
    null
  );

  assert.match(model.innerHtml, /data-meta-label="~2 tokens est\. · ~2 cumulative"/);
});

test('F8: projected turn article hover meta preserves assistant meta and appends token estimates', () => {
  const pipeline = createPipeline();
  const turn = {
    turn_id: 'turn_tokens',
    primary_assistant_message_id: 'assistant_tokens',
    source_message_ids: ['user_tokens', 'assistant_tokens'],
  };
  const rows = [{
    row_id: 'row:tokens',
    turn_id: 'turn_tokens',
    kind: 'assistant_text',
    primary_message_id: 'assistant_tokens',
    payload: { text: '123456789', segment_group_index: 0 },
  }];
  const messages = [
    { id: 'user_tokens', role: 'user', content: '12345678', status: 'complete' },
    { id: 'assistant_tokens', role: 'assistant', content: '123456789', status: 'complete' },
  ];

  const html = pipeline.buildTurnArticleMarkup(turn, rows, messages, {
    projectionContext: createProjectionContext(messages, turn),
  });

  assert.match(html, /data-meta-label="meta:assistant_tokens · ~3 tokens est\. · ~5 cumulative"/);
});

test('F8 hardening: token meta cache refreshes when same message array is mutated', () => {
  const pipeline = createArticleMarkupHarness();
  const messages = [
    { id: 'user_cache', role: 'user', content: '1234', status: 'complete' },
    { id: 'assistant_cache', role: 'assistant', content: '1234', status: 'complete' },
  ];

  const first = pipeline.buildMessageInnerMarkup(
    messages[1],
    messages,
    '',
    'assistant_cache',
    '',
    null,
    null
  );
  assert.match(first.innerHtml, /data-meta-label="meta:assistant_cache · ~1 tokens est\. · ~2 cumulative"/);

  messages[0].content = '123456789012';
  const second = pipeline.buildMessageInnerMarkup(
    messages[1],
    messages,
    '',
    'assistant_cache',
    '',
    null,
    null
  );

  assert.match(second.innerHtml, /data-meta-label="meta:assistant_cache · ~1 tokens est\. · ~4 cumulative"/);
});

test('context compaction notice renders single-event savings without a count chip', () => {
  const renderer = createTranscriptThinkingRenderer({ escapeHtml });
  const html = renderer.renderContextCompactedNotice({
    context_compacted: {
      summaryStatus: 'created', phase: 'preflight', tokensBefore: 5000, tokensAfter: 3200,
      summaryPersisted: true,
    },
  });

  assert.match(html, /5,000 → 3,200 tokens · 1,800 saved/);
  assert.doesNotMatch(html, /context-compacted-notice-count/);
  assert.match(html, /Summarized older context with the model/);
  assert.match(html, /Before sending the request/);
  assert.match(html, /Summary saved for future turns/);
  assert.match(html, /Your transcript is intact\. Compaction only changes what is sent to the model\./);
});

test('context compaction notice aggregates three events and renders an ordered disclosure breakdown', () => {
  const renderer = createTranscriptThinkingRenderer({ escapeHtml });
  const html = renderer.renderContextCompactedNotice({
    context_compacted: { tokensBefore: 3000, tokensAfter: 2500 },
    context_compactions: [
      { summaryStatus: 'created', phase: 'preflight', tokensBefore: 5000, tokensAfter: 4000 },
      { summaryStatus: 'not_applicable', phase: 'tool_loop', tokensBefore: 4000, tokensAfter: 3000 },
      {
        summaryStatus: 'failed', phase: 'tool_loop', tokensBefore: 3000, tokensAfter: 2500,
        droppedMessages: 7, droppedBytes: 2048, inputComplete: false,
      },
    ],
  });

  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector('.context-compacted-notice-count')?.textContent, '×3');
  assert.match(html, /3,000 → 2,500 tokens · 2,500 saved/);
  assert.ok(dom.window.document.querySelector('details.context-compacted-notice-details'));
  assert.equal(dom.window.document.querySelectorAll('.context-compacted-notice-breakdown-item').length, 3);
  assert.match(html, /Summarizer failed; used a bounded fallback/);
  assert.match(html, /Mid-task, inside the tool loop/);
  assert.match(html, /Folded 7 messages \/ 2,048 bytes/);
  assert.match(html, /Some older messages were omitted from the summarizer input/);
  assert.match(html, /Your transcript is intact\. Compaction only changes what is sent to the model\./);
});

test('context compaction notice escapes untrusted values in its single root status element', () => {
  const renderer = createTranscriptThinkingRenderer({ escapeHtml });
  const html = renderer.renderContextCompactedNotice({
    context_compacted: {
      strategy: 'narrowed', reasonCode: '<img src=x>', historyScopeFallback: '<img src=x>',
      summaryStatus: 'unknown', phase: 'preflight',
    },
  });
  const dom = new JSDOM(html);
  const document = dom.window.document;

  assert.equal(document.body.children.length, 1);
  assert.equal(document.body.firstElementChild?.className, 'context-compacted-notice');
  // The live region is the one-line status only; the <details> breakdown sits
  // outside it so an atomic re-announcement never reads the whole list.
  const status = document.querySelector('.context-compacted-notice-status');
  assert.equal(status?.getAttribute('role'), 'status');
  assert.equal(status?.getAttribute('aria-live'), 'polite');
  assert.equal(document.body.firstElementChild?.getAttribute('role'), null);
  assert.equal(status?.querySelector('details'), null, 'the disclosure is not inside the live region');
  assert.equal(document.querySelector('img'), null);
});
