'use strict';

// Reflection window and fingerprint (agentic memory v2, row 58 W2): Electron
// builds the bounded window and the opaque fingerprint that fences apply.

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  buildReflectionWindow,
  locateCursor,
  windowFingerprint,
} = require('../services/backend/memory-reflection-window');

const user = (id, content) => ({ id, role: 'user', content });
const assistant = (id, content) => ({ id, role: 'assistant', content });

function history() {
  return [user('u1', 'I live in Lisbon.'), assistant('a1', 'Nice.'), user('u2', 'I prefer tea.'), assistant('a2', 'Noted.')];
}

test('the fingerprint is the contract formula over [id, role, sha256(content)]', () => {
  const messages = history();
  const hex = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const expected = `sha256:${hex(JSON.stringify(messages.slice(0, 2).map(m => [m.id, m.role, hex(m.content)])))}`;
  assert.equal(windowFingerprint(messages, 1), expected);
  assert.equal(windowFingerprint(messages, 4), null, 'an end past the history has no fingerprint');
  assert.equal(windowFingerprint(messages, -1), null);
});

test('the fingerprint changes on edit, truncation, regeneration and branch', () => {
  const base = history();
  const fingerprint = windowFingerprint(base, 3);
  const edited = history();
  edited[0] = user('u1', 'I live in Porto.');
  assert.notEqual(windowFingerprint(edited, 3), fingerprint, 'edit');
  assert.equal(windowFingerprint(base.slice(0, 3), 3), null, 'truncation leaves no message at the end index');
  const regenerated = history();
  regenerated[3] = assistant('a2-retry', 'Noted.');
  assert.notEqual(windowFingerprint(regenerated, 3), fingerprint, 'regeneration');
  const branched = [...history().slice(0, 2), user('u2b', 'I prefer coffee.'), assistant('a2b', 'Noted.')];
  assert.notEqual(windowFingerprint(branched, 3), fingerprint, 'branch');
  assert.equal(windowFingerprint(history(), 3), fingerprint, 'unchanged history keeps the fingerprint');
});

test('a cursor is located and verified; a mismatch or missing id reads as absent', () => {
  const messages = history();
  const cursor = { last_message_id: 'a1', window_fingerprint: windowFingerprint(messages, 1) };
  assert.equal(locateCursor(messages, cursor), 1);
  const edited = history();
  edited[0] = user('u1', 'I live in Porto.');
  assert.equal(locateCursor(edited, cursor), -1, 'history before the cursor changed');
  assert.equal(locateCursor(messages, { ...cursor, last_message_id: 'gone' }), -1);
  assert.equal(locateCursor(messages, null), -1);
});

test('only user messages past a verified cursor are new; nothing new returns null', () => {
  const messages = [...history(), user('u3', 'My dog is Rex.'), assistant('a3', 'Hi Rex.')];
  const cursor = { last_message_id: 'a2', window_fingerprint: windowFingerprint(messages, 3) };
  const window = buildReflectionWindow(messages, cursor);
  assert.deepEqual(window.newUserIds, ['u3']);
  assert.equal(window.cursorValid, true);
  assert.equal(window.endIndex, 5);
  assert.equal(window.lastMessageId, 'a3');
  assert.equal(window.fingerprint, windowFingerprint(messages, 5));
  assert.deepEqual(window.messages.map(m => m.id), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'], 'context precedes the new message');
  const caughtUp = { last_message_id: 'a3', window_fingerprint: windowFingerprint(messages, 5) };
  assert.equal(buildReflectionWindow(messages, caughtUp), null);
});

test('a mismatched or absent cursor reprocesses the last 8 user messages', () => {
  const messages = [];
  for (let index = 1; index <= 11; index += 1) messages.push(user(`u${index}`, `Fact ${index}.`), assistant(`a${index}`, 'Ok.'));
  const stale = { last_message_id: 'a3', window_fingerprint: 'sha256:stale' };
  for (const cursor of [stale, null]) {
    const window = buildReflectionWindow(messages, cursor);
    assert.equal(window.cursorValid, false);
    assert.deepEqual(window.newUserIds, ['u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11']);
    assert.equal(window.endIndex, messages.length - 1);
  }
});

test('more than 8 new user messages: the oldest 8 run and the window ends before the ninth', () => {
  const messages = [user('u0', 'Start.'), assistant('a0', 'Ok.')];
  for (let index = 1; index <= 10; index += 1) messages.push(user(`u${index}`, `Fact ${index}.`), assistant(`a${index}`, 'Ok.'));
  const cursor = { last_message_id: 'a0', window_fingerprint: windowFingerprint(messages, 1) };
  const window = buildReflectionWindow(messages, cursor);
  assert.deepEqual(window.newUserIds, ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8']);
  assert.equal(window.pendingUserCount, 10);
  assert.equal(window.lastMessageId, 'a8', 'the window ends on the reply before the ninth new prompt');
});

test('window rules: fenced blocks over 400 chars, per-role caps, tool rows excluded', () => {
  const longFence = `\`\`\`js\n${'x'.repeat(420)}\n\`\`\``;
  const shortFence = '```js\nconst a = 1;\n```';
  const messages = [
    user('u1', `Use tabs. ${longFence} and ${shortFence}`),
    { id: 't1', role: 'tool', kind: 'tool_result', content: 'tool output' },
    { id: 'r1', role: 'assistant', kind: 'reasoning', content: 'thinking' },
    assistant('a1', 'y'.repeat(900)),
    user('u2', 'z'.repeat(2500)),
  ];
  const window = buildReflectionWindow(messages, null);
  assert.deepEqual(window.messages.map(m => m.id), ['u1', 'a1', 'u2']);
  assert.equal(window.messages[0].content, `Use tabs. [code omitted] and ${shortFence}`);
  assert.equal(window.messages[1].content.length, 600);
  assert.equal(window.messages[2].content.length, 2000);
  assert.deepEqual(Object.keys(window.messages[0]).sort(), ['content', 'id', 'role']);
});

test('caps: oldest context is trimmed first and a new user message is never trimmed', () => {
  const messages = [];
  for (let index = 1; index <= 20; index += 1) messages.push(user(`old${index}`, 'o'.repeat(1500)), assistant(`a${index}`, 'p'.repeat(600)));
  const cursorEnd = messages.length - 1;
  const cursor = { last_message_id: messages[cursorEnd].id, window_fingerprint: windowFingerprint(messages, cursorEnd) };
  for (let index = 1; index <= 7; index += 1) messages.push(user(`n${index}`, 'n'.repeat(2000)));
  const window = buildReflectionWindow(messages, cursor);
  const ids = window.messages.map(m => m.id);
  assert.ok(window.messages.length <= 24);
  // 7 x 2000 would exceed the sidecar's 12,000 total: this run takes six (every
  // context entry goes) and ends before n7, which the next run starts from.
  assert.deepEqual(ids, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  assert.deepEqual(window.newUserIds, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  assert.equal(window.lastMessageId, 'n6');
  assert.ok(window.messages.reduce((sum, m) => sum + m.content.length, 0) <= 12_000);
  assert.equal(window.pendingUserCount, 7);
  const next = buildReflectionWindow(messages, { last_message_id: 'n6',
    window_fingerprint: windowFingerprint(messages, window.endIndex) });
  assert.deepEqual(next.newUserIds, ['n7']);

  // Astral characters count twice in UTF-16, so the cut is conservative.
  const face = String.fromCodePoint(0x1F600).repeat(2000);
  const astral = buildReflectionWindow([user('e1', face), user('e2', face), user('e3', face), user('e4', face)], null);
  assert.deepEqual(astral.newUserIds, ['e1', 'e2', 'e3']);

  const small = [];
  for (let index = 1; index <= 30; index += 1) small.push(user(`s${index}`, `short ${index}`), assistant(`b${index}`, 'ok'));
  const smallCursor = { last_message_id: 'b29', window_fingerprint: windowFingerprint(small, 57) };
  const bounded = buildReflectionWindow(small, smallCursor);
  assert.equal(bounded.messages.length, 24);
  assert.deepEqual(bounded.messages.slice(-2).map(m => m.id), ['s30', 'b30'], 'the newest entries survive');
  assert.equal(bounded.messages[0].id, small[60 - 24].id, 'the oldest entries were trimmed');
});

// G4 (owner, 2026-10-15): messages sent while "Jenny takes notes" was off are
// never mined, neither as new messages nor as context.
test('notesSince drops every message dated before it from the window', () => {
  const at = (message, timestamp) => ({ ...message, timestamp });
  const since = '2026-10-15T10:00:00.000Z';
  const messages = [
    at(user('u1', 'Off-the-record one.'), '2026-10-15T09:00:00.000Z'),
    at(assistant('a1', 'Reply one.'), '2026-10-15T09:00:01.000Z'),
    user('u-undated', 'No timestamp.'),
    at(user('u2', 'I prefer tea.'), '2026-10-15T10:00:00.000Z'),
    at(assistant('a2', 'Noted.'), '2026-10-15T10:00:02.000Z'),
  ];
  const window = buildReflectionWindow(messages, null, { notesSince: since });
  assert.deepEqual(window.newUserIds, ['u2']);
  assert.deepEqual(window.messages.map(m => m.id), ['u2', 'a2']);
  assert.equal(window.pendingUserCount, 1);
  assert.equal(window.endIndex, 4);
  assert.equal(window.fingerprint, windowFingerprint(messages, 4), 'the fence still covers the whole prefix');

  assert.equal(buildReflectionWindow(messages.slice(0, 3), null, { notesSince: since }), null,
    'no user message after notesSince: nothing to reflect on');
  assert.deepEqual(buildReflectionWindow(messages, null).newUserIds, ['u1', 'u-undated', 'u2'], 'no notesSince: no filter');
  assert.deepEqual(buildReflectionWindow(messages, null, { notesSince: 'garbage' }).newUserIds, ['u1', 'u-undated', 'u2']);
});
