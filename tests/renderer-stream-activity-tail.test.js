'use strict';

// Follow Jenny (row 121): the four-line tail and the "Watch in Workspace" link
// under the chat's writing activity row (renderer-stream-activity-tail.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const {
  createStreamActivityTail,
  TAIL_LINES,
  TAIL_LINE_MAX_CHARS,
} = require('../renderer/chat/renderer-stream-activity-tail');

const ROW_HTML = '<div class="turn-activity-row" data-turn-activity-row="stream-1" role="status">'
  + '<span class="status-dot turn-activity-dot"></span><span class="turn-activity-glyph"></span>'
  + '<span class="turn-activity-name">Writing</span><span class="turn-activity-label">app.js</span>'
  + '<span class="turn-activity-elapsed">3s</span></div>';

function makeCall(overrides = {}) {
  return {
    callId: 'call-1',
    sessionId: 'session-1',
    streamId: 'stream-1',
    mode: 'write',
    source: 'stream',
    phase: 'arriving',
    authoritative: false,
    tooLarge: false,
    path: 'src/app.js',
    content: '',
    edits: [],
    ...overrides,
  };
}

function makeFakeStore(calls = []) {
  const listeners = new Set();
  return {
    calls,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listCalls: () => calls.slice(),
    getCall: (callId) => calls.find((call) => call.callId === callId) || null,
    emit(type, call) {
      for (const listener of [...listeners]) listener({ type, call });
    },
    listenerCount: () => listeners.size,
  };
}

function makeHarness(t, { calls = [makeCall()], workspaceActive = false, timelineOverride } = {}) {
  const dom = new JSDOM(`<div id="chatTimeline"><article class="chat-entry assistant pending"><div class="chat-message-content">${ROW_HTML}</div></article></div>`);
  const doc = dom.window.document;
  const timeline = doc.getElementById('chatTimeline');
  const store = makeFakeStore(calls);
  const flags = { workspaceActive };
  const watched = [];
  const tail = createStreamActivityTail({
    store,
    getTimeline: timelineOverride || (() => timeline),
    isWorkspaceActive: () => flags.workspaceActive,
    onWatch: (call) => watched.push(call),
    actionButton,
  });
  t.after(() => {
    tail.dispose();
    dom.window.close();
  });
  return { dom, doc, timeline, store, flags, watched, tail, calls };
}

const tailNode = (timeline) => timeline.querySelector('.turn-activity-tail');
const linkNode = (timeline) => timeline.querySelector('[data-turn-activity-watch]');
const rowNode = (timeline) => timeline.querySelector('.turn-activity-row');
const lineTexts = (timeline) => [...tailNode(timeline).children].map((span) => span.textContent);

function assertNoNodes(timeline, message) {
  assert.equal(tailNode(timeline), null, `${message}: no tail`);
  assert.equal(linkNode(timeline), null, `${message}: no link`);
}

test('exports the tail size constants', () => {
  assert.equal(TAIL_LINES, 4);
  assert.equal(TAIL_LINE_MAX_CHARS, 240);
});

test('an arriving write shows the last four lines and the link as the row last child', (t) => {
  const call = makeCall({ content: 'one\ntwo\nthree\nfour\nfive\nsix' });
  const { timeline, store } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  // Five lines are kept for four that show: the oldest is clipped above them, where a line slides out.
  assert.deepEqual(lineTexts(timeline), ['two', 'three', 'four', 'five', 'six']);
  const tail = tailNode(timeline);
  assert.equal(tail.getAttribute('data-turn-activity-tail'), 'call-1');
  assert.equal(tail.getAttribute('aria-hidden'), 'true');
  assert.equal(tail.tagName, 'DIV');
  assert.equal(rowNode(timeline).nextSibling, tail, 'the tail directly follows the row');
  const link = linkNode(timeline);
  assert.equal(rowNode(timeline).lastChild, link, 'the link is the row last child');
  assert.equal(link.tagName, 'BUTTON');
  assert.equal(link.getAttribute('data-turn-activity-watch'), 'call-1');
  assert.equal(link.textContent, 'Watch in Workspace');
  assert.equal(link.getAttribute('title'), 'Open Workspace and show the file arriving');
  assert.ok(link.classList.contains('turn-activity-watch'));
});

test('updates reuse the tail and link elements, and a line keeps its span while it shows', (t) => {
  const call = makeCall({ content: 'a\nb\nc\nd' });
  const { timeline, store } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  const tail = tailNode(timeline);
  const link = linkNode(timeline);
  const [spanA, spanB, spanC, spanD] = tail.children;
  call.content = 'a\nb\nc\ndd';
  store.emit('updated', call);
  assert.deepEqual([...tail.children], [spanA, spanB, spanC, spanD], 'a growing line adds no span');
  assert.equal(spanD.textContent, 'dd');
  call.content = 'a\nb\nc\ndd\ne';
  store.emit('updated', call);
  const spanE = tail.lastElementChild;
  assert.deepEqual([...tail.children], [spanA, spanB, spanC, spanD, spanE], 'a new line is one new span at the end');
  call.content = 'a\nb\nc\ndd\ne\nf\ng';
  store.emit('updated', call);
  assert.equal(tailNode(timeline), tail);
  assert.equal(linkNode(timeline), link);
  assert.deepEqual(lineTexts(timeline), ['c', 'dd', 'e', 'f', 'g']);
  assert.deepEqual([...tail.children].slice(0, 3), [spanC, spanD, spanE], 'the lines still showing kept their spans');
  assert.equal(spanA.isConnected, false, 'a line that left the tail lost its span');
  assert.equal(timeline.querySelectorAll('.turn-activity-tail').length, 1);
  assert.equal(timeline.querySelectorAll('[data-turn-activity-watch]').length, 1);
});

test('text that is replaced, not appended, rebuilds only the lines that changed place', (t) => {
  const call = makeCall({ content: 'one\ntwo\nthree' });
  const { timeline, store } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  const [first] = tailNode(timeline).children;
  call.content = 'one\n2\nthree\nfour'; // the second line is shorter: every later line starts elsewhere
  store.emit('updated', call);
  assert.deepEqual(lineTexts(timeline), ['one', '2', 'three', 'four']);
  assert.equal(tailNode(timeline).children[0], first);
  call.content = 'x';
  store.emit('updated', call);
  assert.deepEqual(lineTexts(timeline), ['x']);
});

test('line shaping: long lines are cut, CRLF loses its CR, a trailing newline adds no line, short text gives fewer spans', (t) => {
  const call = makeCall({ content: `${'x'.repeat(500)}\nshort` });
  const { timeline, store } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  assert.equal(lineTexts(timeline)[0].length, TAIL_LINE_MAX_CHARS);
  assert.equal(lineTexts(timeline)[1], 'short');

  call.content = 'alpha\r\nbeta\r\ngamma\r\n';
  store.emit('updated', call);
  assert.deepEqual(lineTexts(timeline), ['alpha', 'beta', 'gamma']);
  for (const text of lineTexts(timeline)) assert.ok(!text.includes('\r'));

  call.content = 'first\nsecond\n';
  store.emit('updated', call);
  assert.deepEqual(lineTexts(timeline), ['first', 'second']);
  assert.equal(tailNode(timeline).children.length, 2);

  call.content = 'only';
  store.emit('updated', call);
  assert.deepEqual(lineTexts(timeline), ['only']);

  call.content = '';
  store.emit('updated', call);
  assert.ok(tailNode(timeline), 'the element stays with no text');
  assert.equal(tailNode(timeline).children.length, 0);
});

test('a blank line inside the last lines is kept and the text is plain', (t) => {
  const call = makeCall({ content: 'a\n\n<b>bold</b>\n' });
  const { timeline, store } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  assert.deepEqual(lineTexts(timeline), ['a', '', '<b>bold</b>']);
  assert.equal(tailNode(timeline).querySelector('b'), null, 'written through textContent');
});

test('an edit call shows the last edit newText once started, its oldText before', (t) => {
  const call = makeCall({
    mode: 'edit',
    content: '',
    edits: [
      { oldText: 'first old', oldDone: true, newText: 'first new', newStarted: true, newDone: true, replaceAll: false },
      { oldText: 'second old\nline two', oldDone: false, newText: '', newStarted: false, newDone: false, replaceAll: false },
    ],
  });
  const { timeline, store } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  assert.deepEqual(lineTexts(timeline), ['second old', 'line two']);
  call.edits[1].oldDone = true;
  call.edits[1].newStarted = true;
  call.edits[1].newText = 'second new';
  store.emit('updated', call);
  assert.deepEqual(lineTexts(timeline), ['second new']);
});

test('the nodes go when the call is no longer shown', async (t) => {
  const cases = [
    ['authoritative', (call) => { call.authoritative = true; }],
    ['phase written', (call) => { call.phase = 'written'; }],
    ['phase failed', (call) => { call.phase = 'failed'; }],
    ['source whole', (call) => { call.source = 'whole'; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, (sub) => {
      const call = makeCall({ content: 'a\nb' });
      const { timeline, store } = makeHarness(sub, { calls: [call] });
      store.emit('updated', call);
      assert.ok(tailNode(timeline) && linkNode(timeline), 'precondition: shown');
      mutate(call);
      store.emit('updated', call);
      assertNoNodes(timeline, name);
    });
  }

  await t.test('removed notification', (sub) => {
    const call = makeCall({ content: 'a' });
    const { timeline, store } = makeHarness(sub, { calls: [call] });
    store.emit('updated', call);
    store.emit('removed', call);
    assertNoNodes(timeline, 'removed');
  });

  await t.test('workspace becomes active, then sync', (sub) => {
    const call = makeCall({ content: 'a' });
    const { timeline, store, flags, tail } = makeHarness(sub, { calls: [call] });
    store.emit('updated', call);
    flags.workspaceActive = true;
    tail.sync();
    assertNoNodes(timeline, 'workspace active');
    flags.workspaceActive = false;
    tail.sync();
    assert.ok(tailNode(timeline) && linkNode(timeline), 'comes back when the chat view is active again');
  });

  await t.test('a call that is not shown never draws', (sub) => {
    const call = makeCall({ source: 'whole', content: 'a' });
    const { timeline, store } = makeHarness(sub, { calls: [call] });
    store.emit('updated', call);
    assertNoNodes(timeline, 'whole from the start');
  });
});

test('tooLarge removes the tail and keeps the link', (t) => {
  const call = makeCall({ content: 'a\nb' });
  const { timeline, store } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  const link = linkNode(timeline);
  call.tooLarge = true;
  store.emit('updated', call);
  assert.equal(tailNode(timeline), null);
  assert.equal(linkNode(timeline), link);
  assert.equal(timeline.querySelectorAll('[data-turn-activity-watch]').length, 1);
});

test('a recreated row gets the link and the tail, and the document holds exactly one of each', (t) => {
  const call = makeCall({ content: 'a\nb\nc' });
  const { doc, timeline, store } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  const container = rowNode(timeline).parentNode;
  rowNode(timeline).remove();
  const holder = doc.createElement('div');
  holder.innerHTML = ROW_HTML;
  const newRow = holder.firstElementChild;
  container.appendChild(newRow);
  store.emit('updated', call);
  assert.equal(newRow.lastChild, linkNode(timeline));
  assert.equal(newRow.nextSibling, tailNode(timeline));
  assert.equal(doc.querySelectorAll('.turn-activity-tail').length, 1);
  assert.equal(doc.querySelectorAll('[data-turn-activity-watch]').length, 1);
  assert.equal(newRow.querySelectorAll('[data-turn-activity-watch]').length, 1);
  assert.deepEqual(lineTexts(timeline), ['a', 'b', 'c']);
});

test('without a row nothing is drawn, and the nodes appear once the row exists', (t) => {
  const call = makeCall({ content: 'a' });
  const { doc, timeline, store } = makeHarness(t, { calls: [call] });
  const row = rowNode(timeline);
  const parent = row.parentNode;
  row.remove();
  store.emit('updated', call);
  assertNoNodes(timeline, 'no row');
  parent.appendChild(row);
  store.emit('updated', call);
  assert.ok(tailNode(timeline) && linkNode(timeline));
  assert.equal(doc.querySelectorAll('.turn-activity-tail').length, 1);
});

test('a stream id with selector characters still finds its row', (t) => {
  const call = makeCall({ streamId: 'stream"x]\\1', content: 'a' });
  const dom = new JSDOM('<div id="chatTimeline"></div>');
  const doc = dom.window.document;
  const timeline = doc.getElementById('chatTimeline');
  const row = doc.createElement('div');
  row.className = 'turn-activity-row';
  row.setAttribute('data-turn-activity-row', 'stream"x]\\1');
  timeline.appendChild(row);
  const store = makeFakeStore([call]);
  const tail = createStreamActivityTail({
    store, getTimeline: () => timeline, isWorkspaceActive: () => false, onWatch() {}, actionButton,
  });
  t.after(() => { tail.dispose(); dom.window.close(); });
  store.emit('updated', call);
  assert.ok(tailNode(timeline) && linkNode(timeline));
});

test('clicking the link calls onWatch once; focus never moves; dispose cleans up', (t) => {
  const call = makeCall({ content: 'a\nb' });
  const { doc, dom, timeline, store, watched, tail } = makeHarness(t, { calls: [call] });
  const outside = doc.createElement('input');
  outside.type = 'text';
  doc.body.appendChild(outside);
  outside.focus();
  assert.equal(doc.activeElement, outside);
  store.emit('updated', call);
  call.content = 'a\nb\nc';
  store.emit('updated', call);
  tail.sync();
  assert.equal(doc.activeElement, outside, 'updates leave focus alone');

  linkNode(timeline).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(watched.length, 1);
  assert.equal(watched[0], call);

  tail.dispose();
  assertNoNodes(timeline, 'after dispose');
  assert.equal(store.listenerCount(), 0, 'unsubscribed');
  // A late notification and a click on a leftover node do nothing.
  assert.doesNotThrow(() => store.emit('updated', call));
  assertNoNodes(timeline, 'late notification');
  const stray = doc.createElement('button');
  stray.setAttribute('data-turn-activity-watch', 'call-1');
  timeline.appendChild(stray);
  stray.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(watched.length, 1, 'the click listener is gone');
  assert.doesNotThrow(() => tail.sync());
  assert.doesNotThrow(() => tail.dispose());
});

test('the click is delegated from the transcript root, once per root', (t) => {
  const call = makeCall({ content: 'a' });
  const { dom, timeline, store, watched } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  store.emit('updated', call);
  store.emit('updated', call);
  linkNode(timeline).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(watched.length, 1, 'repeated draws do not stack listeners');
});

test('a click for a call the store no longer lists does nothing', (t) => {
  const call = makeCall({ content: 'a' });
  const { dom, timeline, store, watched, calls } = makeHarness(t, { calls: [call] });
  store.emit('updated', call);
  calls.length = 0;
  linkNode(timeline).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(watched.length, 0);
});

test('a null timeline and an empty store do not throw', (t) => {
  const call = makeCall({ content: 'a' });
  const nullHarness = makeHarness(t, { calls: [call], timelineOverride: () => null });
  assert.doesNotThrow(() => nullHarness.store.emit('updated', call));
  assert.doesNotThrow(() => nullHarness.tail.sync());
  assertNoNodes(nullHarness.timeline, 'null timeline');

  const emptyHarness = makeHarness(t, { calls: [] });
  assert.doesNotThrow(() => emptyHarness.tail.sync());
  assert.doesNotThrow(() => emptyHarness.store.emit('removed', makeCall()));
  assert.doesNotThrow(() => emptyHarness.store.emit('updated', undefined));
  assert.equal(tailNode(emptyHarness.timeline), null, 'an empty store draws no tail');
  assert.equal(linkNode(emptyHarness.timeline), null, 'an empty store draws no link');
});

test('sync draws every shown call listed by the store', (t) => {
  const call = makeCall({ content: 'one\ntwo' });
  const { timeline, tail } = makeHarness(t, { calls: [call] });
  assertNoNodes(timeline, 'before any notification');
  tail.sync();
  assert.deepEqual(lineTexts(timeline), ['one', 'two']);
  assert.ok(linkNode(timeline));
});
