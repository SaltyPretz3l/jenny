const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const stringUtils = require('../renderer/shared/string-utils');
const {
  RESUMABLE_STOP_KINDS,
  buildResumeAffordanceMarkup,
} = require('../renderer/chat/renderer-resume-turn-affordance');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const { computeDerivedMessageState } = require('../renderer/chat/renderer-message-index-utils');

function createRenderer() {
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml: stringUtils.escapeHtml,
    renderMarkdown: (text) => `<p>${stringUtils.escapeHtml(text)}</p>`,
  });
}

function buildAssistantRowMarkup({
  message,
  messages = [message],
  assistantPhase = 'final_answer',
  resumeTailMessageId = message && message.id,
  isStreaming = false,
  resumeSendBusy = false,
} = {}) {
  const renderer = createRenderer();
  return renderer.buildTurnRowListMarkup([{
    row_id: `row:${message?.id || 'assistant'}`,
    turn_id: `turn:${message?.id || 'assistant'}`,
    kind: 'assistant_text',
    primary_message_id: message?.id || '',
    assistant_phase: assistantPhase,
    payload: {
      text: message?.content || 'Stopped on a budget.',
      segment_group_index: 0,
    },
  }], messages, {
    sessionId: 'session-1',
    resumeTailMessageId,
    resumeSendBusy,
    isStreaming,
  });
}

test('all supported stop kinds render and invalid inputs return an empty string', () => {
  assert.equal(Object.isFrozen(RESUMABLE_STOP_KINDS), true);
  assert.deepEqual(RESUMABLE_STOP_KINDS, [
    'tool_cap',
    'max_iterations',
    'diminishing_returns',
    'context_budget',
  ]);
  for (const kind of RESUMABLE_STOP_KINDS) {
    const markup = buildResumeAffordanceMarkup({ kind, messageId: 'assistant-1' });
    assert.match(markup, new RegExp(`data-resume-kind="${kind}"`));
  }
  assert.equal(buildResumeAffordanceMarkup({ kind: 'unknown', messageId: 'assistant-1' }), '');
  assert.equal(buildResumeAffordanceMarkup({ kind: '', messageId: 'assistant-1' }), '');
  assert.equal(buildResumeAffordanceMarkup({ kind: null, messageId: 'assistant-1' }), '');
  assert.equal(buildResumeAffordanceMarkup({ kind: 'tool_cap' }), '');
});

test('resume markup exposes the frozen dispatcher contract without a live region', () => {
  const markup = buildResumeAffordanceMarkup({
    kind: 'max_iterations',
    messageId: 'assistant-2',
    sessionId: 'session-2',
  });
  const document = new JSDOM(markup).window.document;
  const group = document.querySelector('.resume-turn-affordance');
  const button = group.querySelector('.resume-turn-action');

  assert.equal(group.getAttribute('data-resume-turn'), 'assistant-2');
  assert.equal(group.getAttribute('data-resume-kind'), 'max_iterations');
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(button.getAttribute('data-action'), 'resume-turn');
  assert.equal(button.getAttribute('data-resume-message-id'), 'assistant-2');
  assert.equal(button.getAttribute('data-resume-session-id'), 'session-2');
  assert.equal(group.hasAttribute('aria-live'), false);
  assert.equal(button.hasAttribute('aria-live'), false);
});

test('disabled resume markup produces a disabled action button', () => {
  const document = new JSDOM(buildResumeAffordanceMarkup({
    kind: 'diminishing_returns',
    messageId: 'assistant-3',
    disabled: true,
  })).window.document;
  assert.equal(document.querySelector('[data-action="resume-turn"]').disabled, true);

  const message = {
    id: 'assistant-busy',
    role: 'assistant',
    status: 'complete',
    resumable_stop: 'diminishing_returns',
  };
  const rowDocument = new JSDOM(buildAssistantRowMarkup({
    message,
    resumeSendBusy: true,
  })).window.document;
  assert.equal(rowDocument.querySelector('[data-action="resume-turn"]').disabled, true);
});

test('tail final-answer assistant row renders Resume from the source message', () => {
  const message = {
    id: 'assistant-tail',
    role: 'assistant',
    status: 'complete',
    content: 'Reply resume to continue.',
    resumable_stop: 'tool_cap',
  };
  const html = buildAssistantRowMarkup({ message });

  assert.match(html, /class="resume-turn-affordance"/);
  assert.match(html, /data-resume-turn="assistant-tail"/);
});

test('interactive recap after the reply does not steal the resumable tail', () => {
  const reply = {
    id: 'assistant-reply',
    role: 'assistant',
    status: 'complete',
    content: 'Budget reached.',
    resumable_stop: 'max_iterations',
  };
  const messages = [
    reply,
    {
      id: 'assistant-recap',
      role: 'assistant',
      kind: 'interactive_round_recap',
      status: 'complete',
      content: 'Interactive recap',
    },
  ];
  const derived = computeDerivedMessageState(messages);
  const html = buildAssistantRowMarkup({
    message: reply,
    messages,
    resumeTailMessageId: derived.latestAssistantMessageId,
  });

  assert.equal(derived.latestAssistantMessageId, 'assistant-reply');
  assert.match(html, /data-resume-turn="assistant-reply"/);
});

test('an earlier budget-stopped assistant row does not render after a newer assistant turn', () => {
  const earlier = {
    id: 'assistant-earlier',
    role: 'assistant',
    status: 'complete',
    content: 'Earlier stop.',
    resumable_stop: 'context_budget',
  };
  const messages = [
    earlier,
    { id: 'assistant-newer', role: 'assistant', status: 'cancelled', content: 'Newer turn.' },
  ];
  const derived = computeDerivedMessageState(messages);
  const html = buildAssistantRowMarkup({
    message: earlier,
    messages,
    resumeTailMessageId: derived.latestAssistantMessageId,
  });

  assert.equal(derived.latestAssistantMessageId, 'assistant-newer');
  assert.doesNotMatch(html, /resume-turn-affordance/);
});

test('Resume is limited to the final-answer row of a multi-segment turn', () => {
  const message = {
    id: 'assistant-commentary',
    role: 'assistant',
    status: 'complete',
    content: 'Intermediate update.',
    resumable_stop: 'tool_cap',
  };

  assert.doesNotMatch(
    buildAssistantRowMarkup({ message, assistantPhase: 'commentary' }),
    /resume-turn-affordance/
  );
});

test('Resume is hidden while the assistant row is streaming', () => {
  const message = {
    id: 'assistant-streaming',
    role: 'assistant',
    status: 'streaming',
    content: 'Still working.',
    resumable_stop: 'tool_cap',
  };

  assert.doesNotMatch(
    buildAssistantRowMarkup({ message, isStreaming: true }),
    /resume-turn-affordance/
  );
});

test('rehydrated message data renders Resume without any live stream event', () => {
  const persistedMessage = {
    id: 'assistant-rehydrated',
    role: 'assistant',
    status: 'complete',
    content: 'Persisted response.',
    resumable_stop: 'diminishing_returns',
  };
  const html = buildAssistantRowMarkup({ message: persistedMessage });

  assert.match(html, /data-resume-kind="diminishing_returns"/);
  assert.doesNotMatch(html, /aria-live/);
});

test('message ids are escaped in both resume dispatcher attributes', () => {
  const messageId = 'assistant"<unsafe';
  const markup = buildResumeAffordanceMarkup({
    kind: 'context_budget',
    messageId,
    sessionId: 'session-escape',
  });
  const document = new JSDOM(markup).window.document;
  const group = document.querySelector('.resume-turn-affordance');
  const button = group.querySelector('[data-action="resume-turn"]');

  assert.match(markup, /assistant&quot;&lt;unsafe/);
  assert.equal(group.getAttribute('data-resume-turn'), messageId);
  assert.equal(button.getAttribute('data-resume-message-id'), messageId);
  assert.equal(document.querySelector('unsafe'), null);
});
