const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMarkdown,
  buildPlainText,
  buildJson,
  formatTimestamp,
  shortTimestamp,
  roleLabel,
  escapeMarkdownToken,
  EXPORT_FORMAT_VERSION,
} = require('../renderer/shared/conversation-format-utils');

function makeUserMessage(overrides = {}) {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'Hello Jenny.',
    timestamp: '2026-05-12T10:30:00.000Z',
    ...overrides,
  };
}

function makeAssistantMessage(overrides = {}) {
  return {
    id: 'msg-2',
    role: 'assistant',
    content: 'Hi! Here is **bold** text.',
    timestamp: '2026-05-12T10:31:00.000Z',
    ...overrides,
  };
}

/* ── buildMarkdown ── */

test('buildMarkdown emits role + timestamp header per message', () => {
  const out = buildMarkdown([makeUserMessage(), makeAssistantMessage()]);
  assert.match(out, /^## You · 2026-05-12 10:30Z/m);
  assert.match(out, /^## Jenny · 2026-05-12 10:31Z/m);
});

test('buildMarkdown includes raw content for each message', () => {
  const out = buildMarkdown([makeUserMessage(), makeAssistantMessage()]);
  assert.ok(out.includes('Hello Jenny.'));
  assert.ok(out.includes('Hi! Here is **bold** text.'));
});

test('buildMarkdown returns empty string for empty input', () => {
  assert.equal(buildMarkdown([]), '');
  assert.equal(buildMarkdown(null), '');
  assert.equal(buildMarkdown(undefined), '');
});

test('buildMarkdown skips question_batch and interactive_round_recap by default', () => {
  const messages = [
    makeUserMessage(),
    makeAssistantMessage({ id: 'msg-3', kind: 'question_batch', content: 'should be skipped' }),
    makeAssistantMessage({ id: 'msg-4', kind: 'interactive_round_recap', content: 'also skipped' }),
    makeAssistantMessage({ id: 'msg-5', content: 'kept' }),
  ];
  const out = buildMarkdown(messages);
  assert.ok(!out.includes('should be skipped'));
  assert.ok(!out.includes('also skipped'));
  assert.ok(out.includes('kept'));
});

test('buildMarkdown renders attachment names when present', () => {
  const message = makeUserMessage({
    attachments: [
      { id: 'a1', kind: 'image', displayName: 'screenshot.png' },
      { id: 'a2', kind: 'text', displayName: 'notes.md' },
    ],
  });
  const out = buildMarkdown([message]);
  assert.ok(out.includes('**Attachments:** screenshot.png, notes.md'));
});

test('buildMarkdown suppresses attachment line when includeAttachmentNames is false', () => {
  const message = makeUserMessage({
    attachments: [{ id: 'a1', kind: 'image', displayName: 'screenshot.png' }],
  });
  const out = buildMarkdown([message], { includeAttachmentNames: false });
  assert.ok(!out.includes('Attachments:'));
});

test('buildMarkdown inlines reasoning entries as blockquote when includeReasoning is true', () => {
  const message = makeAssistantMessage({
    reasoning: {
      entries: [{ text: 'First thought.' }, { text: 'Second thought.\nWith newline.' }],
    },
  });
  const out = buildMarkdown([message], { includeReasoning: true });
  assert.ok(out.includes('> First thought.'));
  assert.ok(out.includes('> Second thought.'));
  assert.ok(out.includes('> With newline.'));
});

test('buildMarkdown defaults includeReasoning to false', () => {
  const message = makeAssistantMessage({
    reasoning: { entries: [{ text: 'secret reasoning' }] },
  });
  const out = buildMarkdown([message]);
  assert.ok(!out.includes('secret reasoning'));
});

test('buildMarkdown prefers visible_segments when present', () => {
  const message = makeAssistantMessage({
    content: 'fallback ignored',
    visible_segments: [{ text: 'first ' }, { text: 'second' }],
  });
  const out = buildMarkdown([message]);
  assert.ok(out.includes('first second'));
  assert.ok(!out.includes('fallback ignored'));
});

test('buildMarkdown falls back to message.content when visible_segments is empty', () => {
  const message = makeAssistantMessage({
    content: 'used content',
    visible_segments: [],
  });
  const out = buildMarkdown([message]);
  assert.ok(out.includes('used content'));
});

test('buildMarkdown emits header without timestamp when missing', () => {
  const message = makeUserMessage({ timestamp: '' });
  const out = buildMarkdown([message]);
  assert.match(out, /^## You\n/m);
});

test('buildMarkdown escapes pipe and newline in header tokens', () => {
  const message = makeUserMessage({ role: 'weird|role\nbreak' });
  const out = buildMarkdown([message]);
  // role is lowercased to weird|role\nbreak then label() title-cases just first char
  assert.ok(out.includes('Weird\\|role break'));
});

/* ── buildPlainText ── */

test('buildPlainText emits flat [role HH:MM] prefix per message', () => {
  const out = buildPlainText([makeUserMessage(), makeAssistantMessage()]);
  assert.match(out, /^\[You 10:30\]/m);
  assert.match(out, /^\[Jenny 10:31\]/m);
  assert.ok(out.includes('Hello Jenny.'));
  assert.ok(out.includes('Hi! Here is **bold** text.'));
});

test('buildPlainText skips question_batch and interactive_round_recap by default', () => {
  const messages = [
    makeUserMessage(),
    makeAssistantMessage({ kind: 'question_batch', content: 'skip-me' }),
  ];
  const out = buildPlainText(messages);
  assert.ok(!out.includes('skip-me'));
});

test('buildPlainText renders attachment list line', () => {
  const message = makeUserMessage({
    attachments: [{ displayName: 'a.png' }, { displayName: 'b.png' }],
  });
  const out = buildPlainText([message]);
  assert.ok(out.includes('Attachments: a.png, b.png'));
});

test('buildPlainText returns empty string for empty inputs', () => {
  assert.equal(buildPlainText([]), '');
  assert.equal(buildPlainText(null), '');
});

test('buildPlainText omits time portion when timestamp is missing', () => {
  const message = makeUserMessage({ timestamp: '' });
  const out = buildPlainText([message]);
  assert.match(out, /^\[You\]/m);
});

/* ── buildJson ── */

test('buildJson emits envelope with format, version, and exported_at', () => {
  const json = buildJson([], { id: 's-1', title: 'Test', created_at: '2026-05-01T00:00:00.000Z' });
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, 'jenny-turn-event-log');
  assert.equal(parsed.format_version, EXPORT_FORMAT_VERSION);
  assert.ok(typeof parsed.exported_at === 'string');
  assert.equal(parsed.session.id, 's-1');
  assert.equal(parsed.session.title, 'Test');
  assert.equal(parsed.session.created_at, '2026-05-01T00:00:00.000Z');
});

test('buildJson defaults scope to "all" when messageIdScope is empty', () => {
  const events = [{ kind: 'assistant_text', primary_message_id: 'm-1' }];
  const json = buildJson(events, {});
  const parsed = JSON.parse(json);
  assert.equal(parsed.scope, 'all');
  assert.deepEqual(parsed.messageIdScope, []);
  assert.deepEqual(parsed.turnEvents, events);
});

test('buildJson filters events to messageIdScope when scope is selected', () => {
  const events = [
    { kind: 'assistant_text', primary_message_id: 'm-1' },
    { kind: 'assistant_text', primary_message_id: 'm-2' },
    { kind: 'tool_call', payload: { message_id: 'm-3' } },
    { kind: 'system', primary_message_id: '' },
  ];
  const json = buildJson(events, {}, { messageIdScope: ['m-1', 'm-3'] });
  const parsed = JSON.parse(json);
  assert.equal(parsed.scope, 'selected');
  assert.deepEqual(parsed.messageIdScope, ['m-1', 'm-3']);
  assert.equal(parsed.turnEvents.length, 2);
  assert.equal(parsed.turnEvents[0].primary_message_id, 'm-1');
  assert.equal(parsed.turnEvents[1].payload.message_id, 'm-3');
});

test('buildJson honors explicit scope:"all" even when messageIdScope is populated', () => {
  const events = [{ primary_message_id: 'm-1' }, { primary_message_id: 'm-2' }];
  const json = buildJson(events, {}, { messageIdScope: ['m-1'], scope: 'all' });
  const parsed = JSON.parse(json);
  assert.equal(parsed.scope, 'all');
  assert.equal(parsed.turnEvents.length, 2);
});

test('buildJson pretty-prints with 2-space indentation', () => {
  const json = buildJson([], { id: 's' });
  assert.ok(json.includes('\n  "format"'));
  assert.ok(json.includes('\n  "session"'));
});

test('buildJson is idempotent under parse-then-reserialize for the envelope shape', () => {
  const events = [{ kind: 'k', primary_message_id: 'm-1', payload: { foo: 1 } }];
  const json1 = buildJson(events, { id: 's', title: 't', created_at: '2026-01-01T00:00:00Z' });
  const parsed = JSON.parse(json1);
  delete parsed.exported_at;
  const json2 = JSON.stringify(parsed, null, 2);
  const re = JSON.parse(json2);
  assert.equal(re.format, 'jenny-turn-event-log');
  assert.deepEqual(re.turnEvents, events);
});

/* ── Helpers ── */

test('formatTimestamp returns ISO-like UTC string', () => {
  assert.equal(formatTimestamp('2026-05-12T10:30:00.000Z'), '2026-05-12 10:30Z');
});

test('formatTimestamp returns empty string for empty input', () => {
  assert.equal(formatTimestamp(''), '');
  assert.equal(formatTimestamp(null), '');
  assert.equal(formatTimestamp(undefined), '');
});

test('formatTimestamp falls back to raw value for unparseable input', () => {
  assert.equal(formatTimestamp('not-a-date'), 'not-a-date');
});

test('shortTimestamp returns HH:MM in UTC', () => {
  assert.equal(shortTimestamp('2026-05-12T05:07:00.000Z'), '05:07');
});

test('roleLabel maps roles to human labels', () => {
  assert.equal(roleLabel('user'), 'You');
  assert.equal(roleLabel('assistant'), 'Jenny');
  assert.equal(roleLabel('system'), 'System');
  assert.equal(roleLabel('tool'), 'Tool');
  assert.equal(roleLabel(''), 'Message');
  assert.equal(roleLabel('custom'), 'Custom');
});

test('escapeMarkdownToken collapses newlines and escapes pipes', () => {
  assert.equal(escapeMarkdownToken('a|b\nc'), 'a\\|b c');
});
