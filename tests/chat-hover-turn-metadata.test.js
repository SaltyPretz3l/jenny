const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAssistantMetaLabel, normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const model = require('../renderer/chat/renderer-context-usage-model');
const { normalizeMessageFields } = require('../services/backend/message-normalization');
const format = value => value;
const { JSDOM } = require('jsdom');
const { createTranscriptActionRenderer } = require('../renderer/chat/renderer-transcript-actions');
const { buildMessageActionModel } = require('../renderer/chat/chat-bubble-action-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { buildTurnEventFromStreamPayload } = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');

test('long metadata is focusable, fully exposed, escaped, and retains action targets', () => {
  const renderer = createTranscriptActionRenderer({ buildMessageActionModel, escapeHtml });
  const text = 'Completed · <model> "long" '.repeat(30);
  const html = renderer.renderMessageHoverRow({ id: 'reply', role: 'assistant', status: 'complete', content: 'Answer' }, { latestReplyAssistantMessageId: 'reply' }, text);
  const dom = new JSDOM(html);
  try {
    const meta = dom.window.document.querySelector('.chat-hover-meta');
    meta.focus();
    assert.equal(dom.window.document.activeElement, meta);
    assert.equal(meta.textContent, text.trim());
    assert.equal(meta.title, text.trim());
    assert.equal(meta.getAttribute('aria-label'), text.trim());
    assert.equal(meta.querySelector('model'), null);
    for (const button of dom.window.document.querySelectorAll('[data-message-action]')) {
      assert.equal(button.dataset.messageId, 'reply');
    }
    const css = require('fs').readFileSync(require('path').join(__dirname, '../styles/chat-hover-actions-v2.css'), 'utf8');
    assert.match(css, /\.chat-hover-meta:focus\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
    assert.match(css, /\.chat-entry:focus-within \.chat-hover-row/);
  } finally { dom.window.close(); }
});
const { createArticleMarkupPipeline } = require('../renderer/chat/renderer-render-pipeline-article-markup');
const usage = require('../renderer/chat/renderer-context-usage-utils');
const { buildMessageProjectionFingerprint } = require('../renderer/chat/renderer-message-index-utils');

function footer(messages, turn, target = 'b') {
  let result;
  const pipeline = createArticleMarkupPipeline({ callbacks: {
    getMessageFromCollection: id => messages.find(message => message.id === id),
    deriveActionTargetMessageId: () => target,
    buildAssistantMetaLabel,
    buildMessageTokenMeta: model.buildMessageTokenMeta,
    formatMessageTokenMeta: usage.formatMessageTokenMeta,
    formatMessageTerminalTimestamp: format,
    renderMessageHoverRow: (message, options, label) => { result = { target: message.id, label }; return ''; },
  } });
  pipeline.buildTurnArticleMarkup(turn, [{ kind: 'assistant_text', primary_message_id: target }], messages, {});
  return result;
}

test('article uses terminal event time independently of copy target and survives edits/deletion/session changes', () => {
  const messages = [
    { id: 'a', role: 'assistant', status: 'complete', content: '12345678', model_used: 'one' },
    { id: 'b', role: 'assistant', status: 'complete', content: '1234', model_used: 'two', finalizedAt: '2026-09-08T10:00:00Z' },
  ];
  const turn = { turn_id: 'turn', source_message_ids: ['a', 'b'], events: [{ kind: 'complete', status: 'complete', completed_at: '2026-09-08T11:00:00Z' }] };
  const result = footer(messages, turn);
  assert.equal(result.target, 'b');
  assert.match(result.label, /Completed 2026-09-08T11:00:00Z/);
  assert.match(result.label, /one, two/);
  assert.match(result.label, /~3 visible-reply tokens est\. \(whole turn\)/);
  assert.match(footer([{ ...messages[0], content: '1234' }, messages[1]], turn).label, /~2 visible-reply/);
  assert.match(footer([messages[1]], turn).label, /~1 visible-reply/);
  assert.match(footer([{ ...messages[1], model_used: '', content: '123456789' }], turn).label, /Model unknown · ~3/);
});

test('failed and stopped turn events override completed action messages without losing estimates', () => {
  const messages = [{ id: 'b', role: 'assistant', status: 'complete', content: '1234', model_used: 'saved', finalizedAt: '2026-09-08T10:00:00Z' }];
  for (const [status, label] of [['error', 'Failed'], ['cancelled', 'Stopped']]) {
    const result = footer(messages, { turn_id: 't', source_message_ids: ['b'], events: [{ kind: 'error', terminal_status: status, completed_at: '2026-09-08T11:00:00Z' }] });
    assert.equal(result.target, 'b');
    assert.match(result.label, new RegExp(label + ' 2026-09-08T11:00:00Z'));
    assert.match(result.label, /~1 visible-reply/);
  }
});

test('raw completion events and missing event dates never become failed or invented completion dates', () => {
  const messages = [{ id: 'b', role: 'assistant', status: 'complete', content: '1234', timestamp: '2026-09-08T09:00:00Z', finalizedAt: '2026-09-08T10:00:00Z' }];
  const turn = { source_message_ids: ['b'], events: [{ type: 'turn_completed', ts: '2026-09-08T11:00:00Z' }] };
  assert.match(footer(messages, turn).label, /Completed 2026-09-08T11:00:00Z/);
  turn.events = [{ kind: 'complete', completed_at: 'invalid' }];
  assert.match(footer(messages, turn).label, /Completed 2026-09-08T10:00:00Z/);
  assert.doesNotMatch(footer(messages, turn).label, /09:00|invalid/);

  turn.events = [{ kind: 'complete', completed_at: 'invalid', payload: { completed_at: '2026-09-08T11:00:00Z' } }];
  assert.match(footer(messages, turn).label, /Completed 2026-09-08T11:00:00Z/);

  turn.events = [{ kind: 'complete', completed_at: 'invalid', payload: { completed_at: 'also-invalid' }, ts: 'invalid' }];
  assert.match(footer([{ ...messages[0], finalizedAt: 'also-invalid' }], turn).label, /Completed · message time 2026-09-08T09:00:00Z/);
  assert.doesNotMatch(footer([{ ...messages[0], finalizedAt: 'also-invalid' }], turn).label, /invalid/);
});

test('production terminal events and legacy error projection retain completion provenance', () => {
  const message = {
    id: 'b', role: 'assistant', status: 'complete', content: '1234',
    streamId: 'stream-terminal-footer', timestamp: '2026-09-08T09:00:00Z',
    finalizedAt: '2026-09-08T10:00:00Z', model_used: 'saved',
  };
  const context = {
    turn_id: 'stream-terminal-footer', primary_assistant_message_id: 'b',
    event_id: 'terminal-footer', ordinal: 1,
  };
  const cases = [
    ['complete', undefined, 'Completed'],
    ['error', 'error', 'Failed'],
    ['error', 'cancelled', 'Stopped'],
  ];
  for (const [type, terminal_status, prefix] of cases) {
    const event = buildTurnEventFromStreamPayload({ type, streamId: context.turn_id, terminal_status }, context);
    const label = footer([message], { source_message_ids: ['b'], events: [event] }).label;
    assert.match(label, new RegExp(`${prefix} 2026-09-08T10:00:00Z`));
  }

  const legacy = projectTurnTree(normalizeChatMessages([
    { id: 'u', role: 'user', content: 'Go', streamId: 'stream-legacy-footer' },
    { ...message, streamId: 'stream-legacy-footer', status: 'error', terminal_status: 'cancelled' },
  ])).turns[0];
  assert.ok(legacy.events.some((event) => event.kind === 'assistant_error'));
  const legacyLabel = footer([{ ...message, status: 'error', terminal_status: 'cancelled' }], legacy).label;
  assert.match(legacyLabel, /Stopped 2026-09-08T10:00:00Z/);

  const invalidEventLabel = footer([message], {
    source_message_ids: ['b'],
    events: [{ kind: 'error', terminal_status: 'error', completed_at: 'not-a-date' }],
  }).label;
  assert.match(invalidEventLabel, /Failed 2026-09-08T10:00:00Z/);
  assert.doesNotMatch(invalidEventLabel, /not-a-date|09:00/);
});

test('footer fields invalidate only the changed message projection', () => {
  const message = { id: 'cache', role: 'assistant', status: 'complete', content: 'same' };
  const original = buildMessageProjectionFingerprint(message);
  const sibling = { id: 'sibling', role: 'assistant', content: 'untouched' };
  const stable = buildMessageProjectionFingerprint(sibling);
  for (const field of ['model_used', 'timestamp', 'terminal_status', 'finalizedAt']) {
    assert.notEqual(buildMessageProjectionFingerprint({ ...message, [field]: 'changed' }), original);
    assert.equal(buildMessageProjectionFingerprint(sibling), stable);
  }
});

test('turn metadata counts visible assistant text once and excludes machinery', () => {
  const messages = [
    { id: 'u', role: 'user', content: 'not counted' },
    { id: 'a', role: 'assistant', content: 'duplicate', visible_segments: [{ text: '12345678' }], reasoning: 'hidden' },
    { id: 't', role: 'assistant', kind: 'tool_use', content: 'hidden' },
    { id: 'b', role: 'assistant', content: '1234' },
    { id: 'e', role: 'assistant', kind: 'assistant_error', content: 'notice' },
  ];
  assert.equal(model.buildMessageTokenMeta(messages, ['a', 't', 'b', 'b', 'e']).get('b').messageTokens, 3);
});

test('missing model never inherits session model', () => {
  assert.equal(normalizeMessageFields({ role: 'assistant' }, 'unproven').model_used, '');
  assert.equal(normalizeMessageFields({ role: 'assistant', model_used: 'saved' }, 'other').model_used, 'saved');
});

test('turn label discloses multiple models and message-time fallback', () => {
  const label = buildAssistantMetaLabel({ role: 'assistant', status: 'complete', timestamp: '2026-09-08T12:00:00Z' }, format,
    [{ model_used: 'one' }, { model_used: 'two' }]);
  assert.match(label, /message time/i);
  assert.match(label, /one.*two/);
});

test('invalid terminal date is not presented as a completion time', () => {
  const label = buildAssistantMetaLabel({ role: 'assistant', status: 'error', terminal_status: 'cancelled', finalizedAt: 'invalid' }, format);
  assert.match(label, /Stopped/);
  assert.doesNotMatch(label, /invalid/);
  assert.match(label, /unknown/i);
});
