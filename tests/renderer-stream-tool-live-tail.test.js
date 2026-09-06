'use strict';

// W2-1: live tool-output tail — ephemeral DOM patches on the running tool row.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createToolLiveTail } = require('../renderer/chat/renderer-stream-tool-live-tail');
const { createStreamToolHandlers } = require('../renderer/chat/renderer-stream-handler-tools');

function makeTimeline(callId, { status = 'running' } = {}) {
  const dom = new JSDOM(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="${callId}">
        <div class="tool-call-block" data-call-id="${callId}" data-tool-status="${status}"></div>
      </div>
    </div>
  `);
  const doc = dom.window.document;
  return {
    dom,
    doc,
    timeline: doc.getElementById('chatTimeline'),
    block: doc.querySelector('.tool-call-block'),
  };
}

function chunkPayload(callId, lines, extra = {}) {
  return { callId, lines, ...extra };
}

test('appendChunk creates the pane inside the running tool block and appends lines', () => {
  const { timeline, block } = makeTimeline('call-1');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });

  const accepted = tail.appendChunk(chunkPayload('call-1', [
    { stream: 'stdout', text: 'building...' },
    { stream: 'stderr', text: 'warn: slow' },
  ]));

  assert.equal(accepted, true);
  const pane = block.querySelector('[data-tool-live-output]');
  assert.ok(pane, 'live pane mounted inside the tool block');
  const text = pane.querySelector('.tool-live-output-text').textContent;
  assert.equal(text, 'building...\n! warn: slow');
  assert.equal(pane.querySelector('.tool-live-output-truncation').classList.contains('hidden'), true);
});

test('subsequent chunks append and keep one pane', () => {
  const { timeline, block } = makeTimeline('call-2');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });

  tail.appendChunk(chunkPayload('call-2', [{ stream: 'stdout', text: 'one' }]));
  tail.appendChunk(chunkPayload('call-2', [{ stream: 'stdout', text: 'two' }]));

  assert.equal(block.querySelectorAll('[data-tool-live-output]').length, 1);
  assert.equal(
    block.querySelector('.tool-live-output-text').textContent,
    'one\ntwo'
  );
});

test('local scrollback cap keeps the newest lines and shows the truncation marker', () => {
  const { timeline, block } = makeTimeline('call-3');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline, maxTailLines: 5 });

  const lines = Array.from({ length: 9 }, (_, i) => ({ stream: 'stdout', text: `line-${i}` }));
  tail.appendChunk(chunkPayload('call-3', lines));

  const text = block.querySelector('.tool-live-output-text').textContent;
  assert.equal(text, ['line-4', 'line-5', 'line-6', 'line-7', 'line-8'].join('\n'));
  const marker = block.querySelector('.tool-live-output-truncation');
  assert.equal(marker.classList.contains('hidden'), false);
  assert.match(marker.textContent, /4 lines omitted/);
});

test('upstream droppedLines surfaces the truncation marker even under the local cap', () => {
  const { timeline, block } = makeTimeline('call-4');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });

  tail.appendChunk(chunkPayload('call-4', [{ stream: 'stdout', text: 'tail' }], { droppedLines: 12 }));

  const marker = block.querySelector('.tool-live-output-truncation');
  assert.equal(marker.classList.contains('hidden'), false);
  assert.match(marker.textContent, /12 lines omitted/);
});

test('chunks that arrive before the tool row mounts are retained and painted after mount', () => {
  // The tool_use render is async — an early chunk must not
  // be lost just because .tool-call-block does not exist yet.
  const dom = new JSDOM('<div id="chatTimeline"></div>');
  const doc = dom.window.document;
  const timeline = doc.getElementById('chatTimeline');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });

  assert.equal(
    tail.appendChunk(chunkPayload('call-early', [{ stream: 'stdout', text: 'first burst' }])),
    false
  );

  const row = doc.createElement('div');
  row.className = 'chat-row';
  row.innerHTML = '<div class="tool-call-block" data-call-id="call-early" data-tool-status="running"></div>';
  timeline.appendChild(row);

  tail.appendChunk(chunkPayload('call-early', [{ stream: 'stdout', text: 'second burst' }]));
  const text = timeline.querySelector('.tool-live-output-text').textContent;
  assert.equal(text, 'first burst\nsecond burst');
});

test('one pre-mount chunk paints as soon as its tool row mounts', async (t) => {
  const dom = new JSDOM('<div id="chatTimeline"></div>');
  const doc = dom.window.document;
  const timeline = doc.getElementById('chatTimeline');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });
  t.after(() => {
    tail.reset();
    dom.window.close();
  });

  assert.equal(
    tail.appendChunk(chunkPayload('call-once', [{ stream: 'stdout', text: 'only burst' }])),
    false
  );
  const row = doc.createElement('div');
  row.innerHTML = '<div class="tool-call-block" data-call-id="call-once" data-tool-status="running"></div>';
  timeline.appendChild(row);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(timeline.querySelector('.tool-live-output-text')?.textContent, 'only burst');
});

test('partial snapshots render into a replaceable slot and clear when gone', () => {
  const { timeline, block } = makeTimeline('call-partial');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });

  tail.appendChunk({ callId: 'call-partial', lines: [], partial: 'progress 42%' });
  const partialNode = block.querySelector('.tool-live-output-partial');
  assert.equal(partialNode.classList.contains('hidden'), false);
  assert.equal(partialNode.textContent, 'progress 42%');

  tail.appendChunk({ callId: 'call-partial', lines: [{ stream: 'stdout', text: 'progress 100%' }], partial: '' });
  assert.equal(partialNode.classList.contains('hidden'), true);
  assert.equal(partialNode.textContent, '');
  assert.equal(block.querySelector('.tool-live-output-text').textContent, 'progress 100%');
});

test('retained tails are bounded: the oldest call is evicted past the cap', () => {
  // Interrupted turns never settle — the map must not grow
  // without bound across repeated cancelled commands.
  const dom = new JSDOM('<div id="chatTimeline"></div>');
  const timeline = dom.window.document.getElementById('chatTimeline');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline, maxTrackedCalls: 2 });

  tail.appendChunk(chunkPayload('call-a', [{ stream: 'stdout', text: 'a' }]));
  tail.appendChunk(chunkPayload('call-b', [{ stream: 'stdout', text: 'b' }]));
  tail.appendChunk(chunkPayload('call-c', [{ stream: 'stdout', text: 'c' }]));

  // call-a was evicted: mounting its row now starts from an empty tail.
  const row = dom.window.document.createElement('div');
  row.innerHTML = '<div class="tool-call-block" data-call-id="call-a" data-tool-status="running"></div>';
  timeline.appendChild(row);
  tail.appendChunk(chunkPayload('call-a', [{ stream: 'stdout', text: 'fresh' }]));
  assert.equal(timeline.querySelector('.tool-live-output-text').textContent, 'fresh');
});

test('chunks for a settled row are dropped', () => {
  const { timeline, block } = makeTimeline('call-5', { status: 'completed' });
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });

  const accepted = tail.appendChunk(chunkPayload('call-5', [{ stream: 'stdout', text: 'late' }]));

  assert.equal(accepted, false);
  assert.equal(block.querySelector('[data-tool-live-output]'), null);
});

test('chunks with no matching tool block are dropped without error', () => {
  const { timeline } = makeTimeline('call-6');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });

  assert.equal(
    tail.appendChunk(chunkPayload('call-other', [{ stream: 'stdout', text: 'x' }])),
    false
  );
});

test('settle removes the pane and forgets the retained tail', () => {
  const { timeline, block } = makeTimeline('call-7');
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });

  tail.appendChunk(chunkPayload('call-7', [{ stream: 'stdout', text: 'running output' }]));
  assert.ok(block.querySelector('[data-tool-live-output]'));

  tail.settle('call-7');
  assert.equal(block.querySelector('[data-tool-live-output]'), null);

  // A late chunk after settle would recreate the pane only if the row still
  // reads as running — flip the status the way a settled render does and
  // assert the straggler is dropped.
  block.setAttribute('data-tool-status', 'completed');
  assert.equal(
    tail.appendChunk(chunkPayload('call-7', [{ stream: 'stdout', text: 'straggler' }])),
    false
  );
});

test('handleToolOutputChunk patches only the current session and never throws', async () => {
  const applied = [];
  const handlers = createStreamToolHandlers({
    state: { pendingToolApprovals: new Map(), toolCallsByStream: new Map() },
    isCurrentSession: (sessionId) => sessionId === 'session-visible',
    applyToolLiveOutputChunk: (payload) => applied.push(payload.callId),
  });

  const foreign = await handlers.handleToolOutputChunk({
    sessionId: 'session-hidden',
    callId: 'call-a',
    lines: [{ stream: 'stdout', text: 'x' }],
  });
  assert.deepEqual(foreign, { buffered: false, terminal: false });
  assert.deepEqual(applied, []);

  const visible = await handlers.handleToolOutputChunk({
    sessionId: 'session-visible',
    callId: 'call-b',
    lines: [{ stream: 'stdout', text: 'y' }],
  });
  assert.deepEqual(visible, { buffered: false, terminal: false });
  assert.deepEqual(applied, ['call-b']);
});

test('a throwing live-tail callback does not break the chunk handler', async () => {
  const handlers = createStreamToolHandlers({
    state: { pendingToolApprovals: new Map(), toolCallsByStream: new Map() },
    isCurrentSession: () => true,
    applyToolLiveOutputChunk: () => {
      throw new Error('tail died');
    },
  });

  const result = await handlers.handleToolOutputChunk({
    sessionId: 'session-visible',
    callId: 'call-c',
    lines: [{ stream: 'stdout', text: 'z' }],
  });
  assert.deepEqual(result, { buffered: false, terminal: false });
});
