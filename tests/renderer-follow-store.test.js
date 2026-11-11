'use strict';

// The Follow Jenny store: one record per write_file / edit_file call, fed by the
// chat stream events, read by the draft tab and the chat tail.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFollowStore, FOLLOWED_TOOLS } = require('../renderer/chat/renderer-follow-store');
const { getArrivingText } = require('../renderer/chat/renderer-stream-activity-tail');

const {
  makeStore, delta, toolUse, approval, stream, clipped, EXACT,
} = require('./helpers/follow-store-harness');

test('FOLLOWED_TOOLS is frozen and names the two followed tools', () => {
  assert.deepEqual({ ...FOLLOWED_TOOLS }, { write_file: 'write', edit_file: 'edit' });
  assert.equal(Object.isFrozen(FOLLOWED_TOOLS), true);
});

test('a streamed write_file call: deltas, the tool event, then the result', () => {
  const { store, events } = makeStore();
  stream(store, 'c1', ['{"pa', 'th":"src/a.txt","con', 'tent":"hel']);
  const call = store.getCall('c1');
  assert.equal(call.callId, 'c1');
  assert.equal(call.sessionId, 's1');
  assert.equal(call.streamId, 'st1');
  assert.equal(call.toolName, 'write_file');
  assert.equal(call.mode, 'write');
  assert.equal(call.source, 'stream');
  assert.equal(call.phase, 'arriving');
  assert.equal(call.authoritative, false);
  assert.equal(call.path, 'src/a.txt');
  assert.equal(call.pathDone, true);
  assert.equal(call.content, 'hel');
  assert.equal(call.contentStarted, true);
  assert.equal(call.contentDone, false);
  assert.equal(call.bytes, Buffer.byteLength('{"pa') + Buffer.byteLength('th":"src/a.txt","con') + Buffer.byteLength('tent":"hel'));
  assert.equal(call.revision, 3);
  assert.deepEqual(store.listCalls(), [call]);

  // The tool event ends the arguments. Its input is the clipped snapshot: the decoded text stands.
  const body = `lo ${'w'.repeat(900)}\n`;
  stream(store, 'c1', [`${body}"}`]);
  assert.equal(call.content, `hel${body}`);
  store.noteStreamEvent(toolUse('c1', { path: ' src/a.txt ', content: clipped(`hel${body}`) }));
  assert.equal(call.authoritative, true);
  assert.equal(call.path, 'src/a.txt');
  assert.equal(call.content, `hel${body}`, 'a 512-character snapshot never replaces the streamed text');
  assert.equal(call.contentStarted, true);
  assert.equal(call.contentDone, true);
  assert.equal(call.tooLarge, false);
  assert.equal(call.phase, 'arriving');
  const revisionAfterInput = call.revision;

  // The same tool_use again (executing) changes nothing and does not notify.
  const countBefore = events.length;
  store.noteStreamEvent(toolUse('c1', { path: 'src/a.txt', content: clipped(`hel${body}`) }, { status: 'executing' }));
  assert.equal(events.length, countBefore);
  assert.equal(call.revision, revisionAfterInput);

  // A late delta does not undo the finished fields.
  stream(store, 'c1', ['more']);
  assert.equal(call.content, `hel${body}`);

  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c1', isError: false });
  assert.equal(call.phase, 'written');
  assert.equal(store.getCall('c1'), call);
  assert.equal(events[0].type, 'updated');
  assert.equal(events[events.length - 1].phase, 'written');
});

test('a call id used again by a later reply starts a new record', () => {
  const { store, events } = makeStore();
  stream(store, 'call_0', ['{"path":"one.txt","content":"1"}']);
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'call_0' });
  const first = store.getCall('call_0');
  assert.equal(first.phase, 'written');
  stream(store, 'call_0', ['{"path":"two.txt","content":"2'], { streamId: 'st2' });
  const second = store.getCall('call_0');
  assert.notEqual(second, first);
  assert.equal(second.phase, 'arriving');
  assert.equal(second.path, 'two.txt');
  assert.equal(second.streamId, 'st2');
  assert.deepEqual(events.filter((e) => e.type === 'removed').map((e) => e.callId), ['call_0']);
  assert.deepEqual(store.listCalls(), [second]);

  // The same holds for a call that arrives whole.
  store.noteStreamEvent({ type: 'complete', streamId: 'st2' });
  store.noteStreamEvent(approval('call_0', { path: 'three.txt', content: '3' }, { streamId: 'st3', ...EXACT }));
  assert.equal(store.getCall('call_0').path, 'three.txt');
  assert.equal(store.getCall('call_0').phase, 'waiting');
});

test('a denied call', () => {
  const { store } = makeStore();
  stream(store, 'c1', ['{"path":"a","content":"x"}']);
  store.noteStreamEvent({ type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId: 'c1', input: { path: 'a', content: 'x' } });
  assert.equal(store.getCall('c1').phase, 'waiting');
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c1', approvalState: 'denied', isError: true });
  assert.equal(store.getCall('c1').phase, 'denied');
});

test('a failed call', () => {
  const { store } = makeStore();
  stream(store, 'c1', ['{"path":"a"']);
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c1', isError: true });
  assert.equal(store.getCall('c1').phase, 'failed');
});

test('approval then written', () => {
  const { store } = makeStore();
  stream(store, 'c1', ['{"path":"a","content":"x"}']);
  store.noteStreamEvent({ type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId: 'c1', input: { path: 'a', content: 'x' } });
  store.noteStreamEvent(toolUse('c1', { path: 'a', content: 'x' }, { status: 'executing' }));
  assert.equal(store.getCall('c1').phase, 'waiting');
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c1', approvalState: 'approved', isError: false });
  assert.equal(store.getCall('c1').phase, 'written');
});

test('complete and error stop a call that is still arriving or waiting, of that stream only', () => {
  const { store } = makeStore();
  stream(store, 'c1', ['{"path":"a"']);
  stream(store, 'c2', ['{"path":"b"'], { streamId: 'st2' });
  store.noteStreamEvent({ type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName: 'edit_file', callId: 'c3', input: { file_path: 'e', old_string: 'a', new_string: 'b' } });
  store.noteStreamEvent({ type: 'complete', streamId: 'st1' });
  assert.equal(store.getCall('c1').phase, 'stopped');
  assert.equal(store.getCall('c3').phase, 'stopped');
  assert.equal(store.getCall('c2').phase, 'arriving');
  store.noteStreamEvent({ type: 'error', streamId: 'st2' });
  assert.equal(store.getCall('c2').phase, 'stopped');
});

test('stream_reset releases the live calls of that stream', () => {
  const { store, events } = makeStore();
  stream(store, 'c1', ['{"path":"a"']);
  stream(store, 'c2', ['{"path":"b"'], { streamId: 'st2' });
  const removed = store.getCall('c1');
  store.noteStreamEvent({ type: 'stream_reset', streamId: 'st1' });
  assert.equal(store.getCall('c1'), null);
  assert.notEqual(store.getCall('c2'), null);
  assert.deepEqual(events.filter((e) => e.type === 'removed').map((e) => e.callId), ['c1']);
  assert.equal(removed.callId, 'c1');
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st2', toolName: 'write_file', callId: 'c2' });
  store.noteStreamEvent({ type: 'stream_reset', streamId: 'st2' });
  assert.equal(store.getCall('c2').phase, 'written');
});

test('an ended call ignores every later event', () => {
  const { store, events } = makeStore();
  stream(store, 'c1', ['{"path":"a"']);
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c1', approvalState: 'denied' });
  const call = store.getCall('c1');
  const count = events.length;
  store.noteStreamEvent(delta('c1', ',"content":"late"'));
  store.noteStreamEvent(toolUse('c1', { path: 'a', content: 'late' }));
  store.noteStreamEvent({ type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId: 'c1', input: { path: 'a' } });
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c1' });
  store.noteStreamEvent({ type: 'tool_approval_withdrawn', callId: 'c1' });
  store.noteStreamEvent({ type: 'complete', streamId: 'st1' });
  assert.equal(call.phase, 'denied');
  assert.equal(call.content, '');
  assert.equal(events.length, count);
});

test('the id adoption rule: a tool_use under another id joins the one streamed call', () => {
  const { store } = makeStore();
  stream(store, 'stream-id', ['{"path":"a.txt","content":"par']);
  store.noteStreamEvent(toolUse('engine-id', { path: 'a.txt', content: 'partial and done' }));
  assert.equal(store.listCalls().length, 1);
  const call = store.getCall('stream-id');
  assert.equal(store.getCall('engine-id'), call);
  assert.equal(call.callId, 'stream-id');
  assert.equal(call.authoritative, true);
  assert.equal(call.content, 'par');
  // from then on the store answers to both ids
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'engine-id' });
  assert.equal(call.phase, 'written');
});

test('the id adoption rule needs exactly one candidate of the same stream and tool', () => {
  const { store } = makeStore();
  stream(store, 'a', ['{"path":"1"']);
  stream(store, 'b', ['{"path":"2"']);
  store.noteStreamEvent(toolUse('other', { path: '3', content: 'z' }));
  assert.equal(store.listCalls().length, 3);
  assert.equal(store.getCall('other').source, 'whole');

  const { store: second } = makeStore();
  stream(second, 'a', ['{"path":"1"'], { streamId: 'st-x' });
  second.noteStreamEvent(toolUse('other', { path: '3', content: 'z' }));
  assert.equal(second.listCalls().length, 2);

  const { store: third } = makeStore();
  stream(third, 'a', ['{"path":"1"']);
  third.noteStreamEvent(toolUse('other', { path: '3', content: 'z' }, { toolName: 'edit_file' }));
  assert.equal(third.listCalls().length, 2);

  // an authoritative call is no longer a candidate
  const { store: fourth } = makeStore();
  stream(fourth, 'a', ['{"path":"1"']);
  fourth.noteStreamEvent(toolUse('a', { path: '1', content: 'c' }));
  fourth.noteStreamEvent(toolUse('other', { path: '3', content: 'z' }));
  assert.equal(fourth.listCalls().length, 2);
});

test('a call for a chat that is not the active one is never created', () => {
  const { store, state, events } = makeStore();
  state.active = 'other-chat';
  stream(store, 'c1', ['{"path":"a"']);
  store.noteStreamEvent(toolUse('c2', { path: 'a', content: 'x' }));
  store.noteStreamEvent({ type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId: 'c3', input: {} });
  assert.deepEqual(store.listCalls(), []);
  assert.equal(events.length, 0);
  state.active = '';
  stream(store, 'c4', ['{"path":"a"'], { sessionId: '' });
  assert.deepEqual(store.listCalls(), []);
});

test('a call that exists keeps being followed after the active chat changes', () => {
  const { store, state } = makeStore();
  stream(store, 'c1', ['{"path":"a"']);
  state.active = 'elsewhere';
  stream(store, 'c1', [',"content":"x"']);
  assert.equal(store.getCall('c1').content, 'x');
});

test('resolveSessionId supplies the session of a payload that has none', () => {
  const { store } = makeStore({ resolveSessionId: (payload) => (payload.streamId === 'st1' ? 's1' : '') });
  store.noteStreamEvent({ type: 'tool_input_delta', streamId: 'st1', toolCallId: 'c1', toolName: 'write_file', argumentsDelta: '{"path":"a"', argumentsBytes: 11 });
  assert.equal(store.getCall('c1').sessionId, 's1');
  store.noteStreamEvent({ type: 'tool_input_delta', streamId: 'st9', toolCallId: 'c9', toolName: 'write_file', argumentsDelta: '{', argumentsBytes: 1 });
  assert.equal(store.getCall('c9'), null);
});

test('with isEnabled() false nothing is held, and refreshEnabled releases what was held', () => {
  const { store, state, events } = makeStore();
  stream(store, 'c1', ['{"path":"a"']);
  assert.equal(store.listCalls().length, 1);
  state.enabled = false;
  stream(store, 'c2', ['{"path":"b"']);
  store.noteStreamEvent(toolUse('c3', { path: 'c', content: 'x' }));
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c1' });
  assert.equal(store.listCalls().length, 1);
  assert.equal(store.getCall('c1').phase, 'arriving');
  store.refreshEnabled();
  assert.deepEqual(store.listCalls(), []);
  assert.equal(events.filter((e) => e.type === 'removed').length, 1);
  state.enabled = true;
  stream(store, 'c4', ['{"path":"d"']);
  store.refreshEnabled();
  assert.equal(store.listCalls().length, 1);
});

test('tooLarge: a call past maxChars stops being decoded and keeps the fields it had', () => {
  const { store } = makeStore({ maxChars: 30 });
  stream(store, 'c1', ['{"path":"p","content":"abc']);
  const call = store.getCall('c1');
  assert.equal(call.tooLarge, false);
  assert.equal(call.content, 'abc');
  store.noteStreamEvent(delta('c1', 'defghijklmnop', { argumentsBytes: 45 }));
  assert.equal(call.tooLarge, true);
  assert.equal(call.bytes, 45);
  const frozenContent = call.content;
  const revision = call.revision;
  store.noteStreamEvent(delta('c1', 'more', { argumentsBytes: 49 }));
  assert.equal(call.content, frozenContent);
  assert.equal(call.bytes, 49);
  assert.equal(call.revision, revision + 1);
  assert.equal(call.phase, 'arriving');
});

test('tooLarge: the decoder reporting overflow is enough', () => {
  const { store } = makeStore({ maxChars: 20 });
  store.noteStreamEvent(delta('c1', '{"path":"p","content":"0123456789012345', { argumentsBytes: 5 }));
  assert.equal(store.getCall('c1').tooLarge, true);
});

test('maxEnded: the oldest ended call is released first', () => {
  const { store, events } = makeStore({ maxEnded: 2 });
  for (const id of ['c1', 'c2', 'c3']) {
    stream(store, id, ['{"path":"p"']);
  }
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c2' });
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c1', isError: true });
  assert.deepEqual(store.listCalls().map((c) => c.callId), ['c1', 'c2', 'c3']);
  store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: 'c3', approvalState: 'denied' });
  // c2 ended first, so it goes; a live call is never released this way
  assert.deepEqual(store.listCalls().map((c) => c.callId), ['c1', 'c3']);
  assert.equal(store.getCall('c2'), null);
  assert.deepEqual(events.filter((e) => e.type === 'removed').map((e) => e.callId), ['c2']);
});

test('maxEnded keeps live calls and counts only ended ones', () => {
  const { store } = makeStore({ maxEnded: 1 });
  stream(store, 'live', ['{"path":"p"']);
  for (const id of ['a', 'b', 'c']) {
    stream(store, id, ['{"path":"p"']);
    store.noteStreamEvent({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId: id });
  }
  assert.deepEqual(store.listCalls().map((c) => c.callId), ['live', 'c']);
});

test('a released call is forgotten under its alias too', () => {
  const { store, events } = makeStore();
  stream(store, 'c1', ['{"path":"p"']);
  store.noteStreamEvent(toolUse('alias', { path: 'p', content: 'x' }));
  assert.equal(store.getCall('alias'), store.getCall('c1'));
  store.noteStreamEvent({ type: 'stream_reset', streamId: 'st1' });
  assert.equal(store.getCall('c1'), null);
  assert.equal(store.getCall('alias'), null);
  assert.equal(events[events.length - 1].type, 'removed');
});

test('requestReveal notifies and remembers the call id once', () => {
  const { store, events } = makeStore();
  stream(store, 'c1', ['{"path":"p"']);
  assert.equal(store.takePendingReveal(), '');
  store.requestReveal('c1');
  assert.equal(events[events.length - 1].type, 'reveal');
  assert.equal(events[events.length - 1].callId, 'c1');
  assert.equal(store.takePendingReveal(), 'c1');
  assert.equal(store.takePendingReveal(), '');
  store.requestReveal('unknown');
  assert.equal(store.takePendingReveal(), '');
  store.requestReveal('c1');
  store.noteStreamEvent({ type: 'stream_reset', streamId: 'st1' });
  assert.equal(store.takePendingReveal(), '');
});

test('a listener that throws does not stop the others or the store', () => {
  const { store } = makeStore();
  const heard = [];
  store.subscribe(() => { throw new Error('listener boom'); });
  store.subscribe((event) => heard.push(event.type));
  assert.doesNotThrow(() => stream(store, 'c1', ['{"path":"p"']));
  assert.deepEqual(heard, ['updated']);
  assert.equal(store.getCall('c1').phase, 'arriving');
  assert.equal(store.getCall('c1').path, 'p');
});

test('unsubscribe stops notifications and dispose drops every listener', () => {
  const { store } = makeStore();
  const heardA = [];
  const heardB = [];
  const offA = store.subscribe(() => heardA.push(1));
  store.subscribe(() => heardB.push(1));
  stream(store, 'c1', ['{']);
  offA();
  stream(store, 'c1', ['"path":"p"']);
  assert.equal(heardA.length, 1);
  assert.equal(heardB.length, 2);
  store.dispose();
  assert.deepEqual(store.listCalls(), []);
  const count = heardB.length;
  stream(store, 'c2', ['{']);
  assert.equal(heardB.length, count);
  assert.doesNotThrow(() => store.subscribe(null)());
});

test('junk payloads never throw and create nothing', () => {
  const { store, events } = makeStore();
  const junk = [
    null, undefined, 42, 'text', [], {}, { type: 7 }, { type: null }, { type: 'tool_input_delta' },
    delta('', '{"path":"a"'), delta(undefined, '{"path":"a"'),
    { type: 'tool_input_delta', toolCallId: 5, toolName: 'write_file', sessionId: 's1' },
    { type: 'tool_input_delta', toolCallId: 'x', toolName: {}, sessionId: 's1' },
    { type: 'tool_use' }, { type: 'tool_use', toolName: 'write_file' },
    { type: 'tool_use', toolName: 'write_file', callId: {}, input: 5 },
    { type: 'tool_use', toolName: 7, callId: 'q', input: 'text' },
    { type: 'tool_approval_needed', toolName: 'write_file', callId: 'q', sessionId: { a: 1 } },
    { type: 'tool_approval_withdrawn' }, { type: 'tool_result' },
    { type: 'tool_result', callId: 'unknown', approvalState: 'denied' },
    { type: 'stream_reset' }, { type: 'complete' }, { type: 'error', streamId: 5 },
    { type: ' TOOL_RESULT ', callId: 'unknown' },
  ];
  for (const payload of junk) {
    assert.doesNotThrow(() => store.noteStreamEvent(payload), JSON.stringify(payload));
  }
  assert.deepEqual(store.listCalls(), []);
  assert.equal(events.length, 0);
});

test('a delta with wrong field types on a known call does not throw or lose the call', () => {
  const { store } = makeStore();
  stream(store, 'c1', ['{"path":"a"']);
  store.noteStreamEvent({ type: 'tool_input_delta', toolCallId: 'c1', toolName: 'write_file', argumentsDelta: { not: 'a string' }, argumentsBytes: 'x' });
  assert.equal(store.getCall('c1').path, 'a');
  assert.equal(store.getCall('c1').phase, 'arriving');
});

test('event types are compared trimmed and lower case', () => {
  const { store } = makeStore();
  store.noteStreamEvent({ ...delta('c1', '{"path":"a"'), type: '  Tool_Input_Delta ' });
  assert.equal(store.getCall('c1').path, 'a');
  store.noteStreamEvent({ type: ' TOOL_RESULT', callId: 'c1' });
  assert.equal(store.getCall('c1').phase, 'written');
});

test('tools other than the two followed ones create nothing', () => {
  const { store, events } = makeStore();
  for (const toolName of ['propose_change', 'delete_file', 'read_file', 'create_artifact', 'constructor', '__proto__', 'toString']) {
    store.noteStreamEvent(delta('c1', '{"path":"a"}', { toolName }));
    store.noteStreamEvent(toolUse('c2', { path: 'a', content: 'x' }, { toolName }));
    store.noteStreamEvent({ type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName, callId: 'c3', input: {} });
  }
  assert.deepEqual(store.listCalls(), []);
  assert.equal(events.length, 0);
});

test('an edit_file batch arriving, with getArrivingText checked mid-stream', () => {
  const { store } = makeStore();
  const argument = JSON.stringify({
    file_path: 'multi.js',
    edits: [
      { old_string: 'alpha', new_string: 'beta' },
      { old_string: 'gamma', new_string: 'delta' },
    ],
  });
  const ask = (text) => getArrivingText(store.getCall('e1'));
  let fed = 0;
  const feed = (upTo) => {
    store.noteStreamEvent(delta('e1', argument.slice(fed, upTo), { toolName: 'edit_file', argumentsBytes: upTo }));
    fed = upTo;
    return ask();
  };
  assert.equal(feed(argument.indexOf('alpha') + 3), 'alp');
  assert.equal(store.getCall('e1').mode, 'edit');
  assert.equal(store.getCall('e1').path, 'multi.js');
  assert.equal(feed(argument.indexOf('beta') + 2), 'be');
  assert.equal(feed(argument.indexOf('gamma') + 5), 'gamma');
  assert.equal(feed(argument.indexOf('delta') + 1), 'd');
  assert.equal(feed(argument.length), 'delta');
  const call = store.getCall('e1');
  assert.equal(call.edits.length, 2);
  assert.equal(call.edits[1].newDone, true);
  assert.equal(call.bytes, argument.length);
  store.noteStreamEvent({ type: 'tool_use', sessionId: 's1', streamId: 'st1', toolName: 'edit_file', callId: 'e1', input: JSON.parse(argument) });
  assert.equal(call.authoritative, true);
  assert.equal(call.edits.length, 2);
  assert.equal(getArrivingText(call), 'delta');
});

test('getArrivingText for each shape of call', () => {
  assert.equal(getArrivingText(null), '');
  assert.equal(getArrivingText(undefined), '');
  assert.equal(getArrivingText({}), '');
  assert.equal(getArrivingText({ mode: 'write', content: 'abc' }), 'abc');
  assert.equal(getArrivingText({ mode: 'write' }), '');
  assert.equal(getArrivingText({ mode: 'edit', edits: [] }), '');
  assert.equal(getArrivingText({ mode: 'edit', edits: [{ oldText: 'o', newText: 'n', newStarted: false }] }), 'o');
  assert.equal(getArrivingText({ mode: 'edit', edits: [{ oldText: 'o', newText: 'n', newStarted: true }] }), 'n');
  assert.equal(getArrivingText({ mode: 'edit', edits: [{ oldText: 'a', newText: 'b', newStarted: true }, { oldText: 'c', newText: '', newStarted: false }] }), 'c');
});

test('a write_file call whose decoder fails keeps its last good fields', () => {
  const { store } = makeStore();
  stream(store, 'c1', ['{"path":"p","content":"good']);
  stream(store, 'c1', ['\\x bad escape"}']);
  const call = store.getCall('c1');
  assert.equal(call.content, 'good');
  assert.equal(call.phase, 'arriving');
  store.noteStreamEvent(approval('c1', { path: 'p', content: 'good and complete' }, EXACT));
  assert.equal(call.content, 'good and complete');
});

test('a custom decoder and the default resolver are honoured', () => {
  const pushed = [];
  const store = createFollowStore({
    isEnabled: () => true,
    getActiveSessionId: () => 's1',
    createDecoder: ({ maxChars }) => ({
      push: (chunk) => pushed.push(chunk),
      snapshot: () => ({ path: ` fake-${maxChars} `, pathDone: true, content: pushed.join(''), contentStarted: true, contentDone: false, edits: [], done: false, failed: false, overflow: false }),
    }),
    maxChars: 99,
  });
  store.noteStreamEvent(delta('c1', 'ab'));
  store.noteStreamEvent(delta('c1', 'cd'));
  const call = store.getCall('c1');
  assert.equal(call.path, 'fake-99');
  assert.equal(call.content, 'abcd');
});

test('reset releases every call and forgets a pending reveal', () => {
  const { store, events } = makeStore();
  stream(store, 'c1', ['{"path":"p"']);
  stream(store, 'c2', ['{"path":"q"']);
  store.requestReveal('c2');
  store.reset();
  assert.deepEqual(store.listCalls(), []);
  assert.equal(store.takePendingReveal(), '');
  assert.equal(events.filter((e) => e.type === 'removed').length, 2);
});
