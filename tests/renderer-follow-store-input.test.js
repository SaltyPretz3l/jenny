'use strict';

// The Follow Jenny store and the input a tool event or an approval carries:
// the snapshot of a tool event is cut and never replaces streamed text; only an
// approval shown exactly does.

const test = require('node:test');
const assert = require('node:assert/strict');

require('../renderer/chat/renderer-follow-store');
const {
  makeStore, toolUse, approval, stream, clipped, EXACT, TOO_LARGE,
} = require('./helpers/follow-store-harness');

test('a tool event ends a streamed call whose text stopped short, without replacing it', () => {
  const { store } = makeStore();
  stream(store, 'c1', ['{"content":"par']);
  store.noteStreamEvent(toolUse('c1', { path: 'late/path.txt', content: 'partial and done' }));
  const call = store.getCall('c1');
  assert.equal(call.path, 'late/path.txt', 'a path that never arrived is taken from the event');
  assert.equal(call.content, 'par');
  assert.equal(call.contentDone, true, 'nothing more arrives, so the draft stops showing a caret');
  assert.equal(call.authoritative, true);
});

test('an approval shown exactly replaces the streamed text; one too large to show keeps it', () => {
  const { store } = makeStore();
  // A fragment the sidecar cut corrupted the decode; the exact approval is what will be written.
  stream(store, 'c1', ['{"path":"a.txt","content":"helXX"corrupted']);
  store.noteStreamEvent(approval('c1', { path: 'a.txt', content: 'hello world\n' }, EXACT));
  const exact = store.getCall('c1');
  assert.equal(exact.phase, 'waiting');
  assert.equal(exact.content, 'hello world\n');
  assert.equal(exact.contentDone, true);

  const large = 'L'.repeat(40000);
  stream(store, 'c2', [`{"path":"big.txt","content":"${large}"}`]);
  store.noteStreamEvent(approval('c2', { path: 'big.txt', content: clipped(large) }, TOO_LARGE));
  const kept = store.getCall('c2');
  assert.equal(kept.phase, 'waiting');
  assert.equal(kept.content.length, 40000);
  assert.equal(kept.tooLarge, false);

  // An exact_approval with no hash is not exact.
  stream(store, 'c3', ['{"path":"c.txt","content":"streamed"}']);
  store.noteStreamEvent(approval('c3', { path: 'c.txt', content: 'other' }, { exact_approval: { sha256: '' } }));
  assert.equal(store.getCall('c3').content, 'streamed');
});

test('a withdrawn approval is a paused run: the call waits until it is asked again or its stream ends', () => {
  const { store } = makeStore();
  store.noteStreamEvent(approval('c1', { path: 'a', content: 'x' }, EXACT));
  const call = store.getCall('c1');
  assert.equal(call.phase, 'waiting');
  assert.equal(call.source, 'whole');
  assert.equal(call.authoritative, true);
  store.noteStreamEvent({ type: 'tool_approval_withdrawn', streamId: 'st1', sessionId: 's1', callId: 'c1', toolName: 'write_file', reason: 'runtime_pause' });
  assert.equal(call.phase, 'waiting');
  store.noteStreamEvent(approval('c1', { path: 'a', content: 'xy' }, EXACT));
  assert.equal(call.phase, 'waiting');
  assert.equal(call.content, 'xy');
  store.noteStreamEvent({ type: 'complete', streamId: 'st1' });
  assert.equal(call.phase, 'stopped');
});

test('a whole call: a tool event with no deltas names the file and carries no text', () => {
  const { store } = makeStore();
  store.noteStreamEvent({ type: 'tool_use', sessionId: 's1', streamId: 'st1', toolName: 'write_file', toolCallId: 'w1', input: { file_path: ' w.txt', file_content: 'twelve chars' } });
  const call = store.getCall('w1');
  assert.equal(call.source, 'whole');
  assert.equal(call.phase, 'arriving');
  assert.equal(call.authoritative, true);
  assert.equal(call.path, 'w.txt');
  assert.equal(call.pathDone, true);
  assert.equal(call.content, '', 'the snapshot may be cut or redacted, so it is never shown as the file');
  assert.equal(call.contentDone, false);
  assert.equal(call.tooLarge, false);
  assert.equal(call.bytes, 0);
  assert.equal(call.revision, 1);
});

test('a whole call: an exact approval carries the text, one too large to show carries none', () => {
  const { store } = makeStore();
  store.noteStreamEvent(approval('w1', { file_path: ' w.txt', file_content: 'twelve chars' }, EXACT));
  const call = store.getCall('w1');
  assert.equal(call.source, 'whole');
  assert.equal(call.phase, 'waiting');
  assert.equal(call.path, 'w.txt');
  assert.equal(call.content, 'twelve chars');
  assert.equal(call.contentStarted, true);
  assert.equal(call.contentDone, true);
  assert.equal(call.bytes, 12);

  store.noteStreamEvent(approval('w2', { path: 'big.txt', content: clipped('B'.repeat(40000)) }, TOO_LARGE));
  const large = store.getCall('w2');
  assert.equal(large.phase, 'waiting');
  assert.equal(large.path, 'big.txt');
  assert.equal(large.content, '');
  assert.equal(large.tooLarge, true);
});

test('a whole call with no input yet has zero bytes and is filled when the exact input arrives', () => {
  const { store } = makeStore();
  store.noteStreamEvent(toolUse('w1', undefined));
  const call = store.getCall('w1');
  assert.equal(call.bytes, 0);
  assert.equal(call.authoritative, false);
  store.noteStreamEvent(toolUse('w1', { path: 'p', content: 'abc' }, { status: 'pending_approval', ...EXACT }));
  assert.equal(call.bytes, 3);
  assert.equal(call.content, 'abc');
});

test('an edit_file whole call with the top level form and with a batch', () => {
  const { store } = makeStore();
  store.noteStreamEvent({ type: 'tool_use', sessionId: 's1', streamId: 'st1', toolName: 'edit_file', callId: 'e1', ...EXACT, input: { file_path: 'f.js', old_string: 'a', new_string: 'bb', replace_all: true } });
  const single = store.getCall('e1');
  assert.equal(single.mode, 'edit');
  assert.deepEqual(single.edits, [{ oldText: 'a', oldDone: true, newText: 'bb', newStarted: true, newDone: true, replaceAll: true }]);
  assert.equal(single.bytes, 3);

  store.noteStreamEvent({
    type: 'tool_use', sessionId: 's1', streamId: 'st1', toolName: 'edit_file', callId: 'e2', ...EXACT,
    input: { path: 'g.js', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q', replace_all: 'yes' }, 7] },
  });
  const batch = store.getCall('e2');
  assert.equal(batch.path, 'g.js');
  assert.equal(batch.edits.length, 3);
  assert.equal(batch.edits[1].replaceAll, false);
  assert.deepEqual(batch.edits[2], { oldText: '', oldDone: true, newText: '', newStarted: true, newDone: true, replaceAll: false });
});

test('non-string values in the input become empty text', () => {
  const { store } = makeStore();
  store.noteStreamEvent(toolUse('c1', { path: 5, content: { a: 1 } }, EXACT));
  const call = store.getCall('c1');
  assert.equal(call.path, '');
  assert.equal(call.content, '');
  assert.equal(call.contentDone, true);
});

test('tooLarge: an exact input past maxChars is flagged and the earlier fields stay', () => {
  const { store } = makeStore({ maxChars: 30 });
  stream(store, 'c1', ['{"path":"p","content":"abc']);
  store.noteStreamEvent(toolUse('c1', { path: 'p', content: 'x'.repeat(31) }, EXACT));
  const call = store.getCall('c1');
  assert.equal(call.tooLarge, true);
  assert.equal(call.authoritative, true);
  assert.equal(call.content, 'abc');
  assert.equal(call.pathDone, true);

  store.noteStreamEvent({ type: 'tool_use', sessionId: 's1', streamId: 'st1', toolName: 'edit_file', callId: 'e1', ...EXACT, input: { file_path: 'f', old_string: 'o'.repeat(20), new_string: 'n'.repeat(20) } });
  const edit = store.getCall('e1');
  assert.equal(edit.tooLarge, true);
  assert.deepEqual(edit.edits, []);
  assert.equal(edit.bytes, 40);
});
