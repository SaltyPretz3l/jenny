'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPreparedContextHistory, buildPreparedMessages } = require('../services/backend/chat-stream-reasoning');
const { attachmentHistoryNote } = require('../services/backend/chat-attachment-history-note');

const SESSION = { history_scope: 'session' };

function image(displayName) {
  return { id: `img-${displayName}`, kind: 'image', displayName, assetPath: `images/${displayName}` };
}

test('a replayed user row names the files attached to it and says they are not shown again', () => {
  const history = buildPreparedContextHistory([
    { id: 'u1', role: 'user', content: 'whats this?', attachments: [image('pikachu.png')] },
    { id: 'a1', role: 'assistant', content: 'A cartoon mouse.' },
  ], SESSION);
  assert.deepEqual(history, [
    { role: 'user', content: 'whats this?\n\n[Attached to this message earlier, not shown again: pikachu.png (image)]' },
    { role: 'assistant', content: 'A cartoon mouse.' },
  ]);
});

test('an attachment-only user row is kept as the note instead of being dropped', () => {
  const history = buildPreparedContextHistory([
    { id: 'u1', role: 'user', content: '', attachments: [image('hills.png')] },
  ], SESSION);
  assert.deepEqual(history, [
    { role: 'user', content: '[Attached to this message earlier, not shown again: hills.png (image)]' },
  ]);
});

test('every attachment kind is named, including kinds this module has never seen', () => {
  const note = attachmentHistoryNote([
    { kind: 'text', displayName: 'notes.txt' },
    { kind: 'audio', displayName: 'memo.wav' },
    { kind: 'video', displayName: 'clip.mp4' },
    { displayName: 'untyped.md' },
  ]);
  assert.equal(note,
    '[Attached to this message earlier, not shown again: notes.txt (text file), memo.wav (audio), '
      + 'clip.mp4 (video), untyped.md (text file)]');
});

test('the note is bounded: long names are cut, whitespace collapsed, extra files counted', () => {
  const many = Array.from({ length: 11 }, (_, index) => image(`p${index}.png`));
  assert.match(attachmentHistoryNote(many), /p7\.png \(image\) and 3 more\]$/);
  const longName = `${'a'.repeat(120)}.png`;
  const note = attachmentHistoryNote([{ kind: 'image', displayName: `line\none ${longName}` }]);
  assert.ok(!note.includes('\n'));
  assert.ok(note.includes(`line one ${'a'.repeat(70)}…`));
});

test('assistant rows and rows without attachments are unchanged', () => {
  const rows = [
    { id: 'a1', role: 'assistant', content: 'here is your picture', attachments: [image('gen.png')] },
    { id: 'u1', role: 'user', content: 'plain' },
    { id: 'u2', role: 'user', content: 'empty list', attachments: [] },
  ];
  assert.deepEqual(buildPreparedContextHistory(rows, SESSION).map((message) => message.content),
    ['here is your picture', 'plain', 'empty list']);
});

test('a steer row (row 180) keeps its attachment note in later history', () => {
  const rows = [{ id: 'steer_outbox_a', role: 'user', kind: 'steer', content: 'use this one', attachments: [image('ref.png')] }];
  const [message] = buildPreparedContextHistory(rows, SESSION);
  assert.match(message.content, /^use this one\n\n\[.*ref\.png \(image\)/);
});

test('the current prompt is not noted: its files are sent with this turn', () => {
  const messages = buildPreparedMessages([], 'describe it', {
    contextPreferences: SESSION,
    attachments: [{ kind: 'text', displayName: 'a.txt', promptName: 'a.txt', text: 'body' }],
  });
  assert.equal(messages.length, 1);
  assert.ok(!messages[0].content.includes('not shown again'));
  assert.ok(messages[0].content.includes('--- file: a.txt ---'));
});
