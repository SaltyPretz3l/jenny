const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

function createFrameScheduler() {
  let nextHandle = 1;
  const pending = new Map();
  return {
    request(callback) {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    flushNext(timestamp = 16) {
      const next = pending.entries().next().value;
      if (!next) return false;
      pending.delete(next[0]);
      next[1](timestamp);
      return true;
    },
    flushAll(limit = 20) {
      let count = 0;
      while (count < limit && this.flushNext(16 + count * 16)) count += 1;
      return count;
    },
    get size() {
      return pending.size;
    },
  };
}

function loadThinkingUtils() {
  const modulePath = require.resolve('../renderer/chat/renderer-render-pipeline-thinking');
  delete require.cache[modulePath];
  return require(modulePath);
}

function createHarness({
  messages = [],
  preflight = false,
  cancelFrames = true,
} = {}) {
  const scheduler = createFrameScheduler();
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="column">
      <div id="layer"><div id="sprite"></div></div>
      <div id="timeline"></div>
    </div>
  </body></html>`);
  const documentRef = dom.window.document;
  const timeline = documentRef.getElementById('timeline');
  const layer = documentRef.getElementById('layer');
  const sprite = documentRef.getElementById('sprite');
  const column = documentRef.getElementById('column');
  let layerDisplay = 'block';

  global.window = dom.window;
  global.document = documentRef;
  const { createThinkingPipeline } = loadThinkingUtils();

  dom.window.getComputedStyle = (element) => ({
    display: element === layer ? layerDisplay : 'block',
    visibility: 'visible',
    rowGap: '16px',
    gap: '16px',
  });
  layer.getBoundingClientRect = () => ({ top: 0, left: 0, right: 52, bottom: 800, width: 52, height: 800 });
  sprite.getBoundingClientRect = () => ({ top: 0, left: 2, right: 32, bottom: 30, width: 30, height: 30 });

  for (const [index, message] of messages.entries()) {
    if (!message?.id) continue;
    const node = documentRef.createElement('article');
    node.dataset.messageId = message.id;
    node.className = 'chat-entry';
    node.getBoundingClientRect = () => ({
      top: 100 + index * 100,
      left: 60,
      right: 500,
      bottom: 160 + index * 100,
      width: 440,
      height: 60,
    });
    const bubble = documentRef.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.getBoundingClientRect = node.getBoundingClientRect;
    node.appendChild(bubble);
    timeline.appendChild(node);
  }

  const state = {
    currentSessionId: 'session-1',
    activeStreamSessionId: '',
    activeStreamId: '',
    streamThinkingStatusByStream: new Map(),
    ui: { activeView: 'chat', chatMode: 'thread' },
  };
  const spriteRuntime = {};
  const holoCalls = [];
  const pipeline = createThinkingPipeline({
    requestAnimationFrame: (callback) => scheduler.request(callback),
    cancelAnimationFrame: cancelFrames
      ? (handle) => scheduler.cancel(handle)
      : () => {},
    state,
    constants: { MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' } },
    dom: {
      chatTimeline: timeline,
      chatThreadColumn: column,
      chatSpriteLayer: layer,
      chatAssistantSprite: sprite,
    },
    controllers: {
      thinkingIndicator: {
        getDisplayState() { return { mode: 'idle' }; },
      },
    },
    runtime: { spriteRuntime },
    callbacks: {
      getCurrentSessionMessages: () => messages,
      getLatestAssistantMessageId: (items) => {
        const match = [...items].reverse().find((message) => message?.role === 'assistant');
        return match?.id || '';
      },
      getLatestUserMessageId: (items) => {
        const match = [...items].reverse().find((message) => message?.role === 'user');
        return match?.id || '';
      },
      escapeSelectorValue: (value) => String(value),
      isSendPreflightPending: () => preflight,
      setSpriteHoloState: (active, mode) => holoCalls.push([active, mode]),
    },
  });

  return {
    dom,
    holoCalls,
    layer,
    messages,
    pipeline,
    scheduler,
    sprite,
    spriteRuntime,
    state,
    setLayerDisplay: (value) => { layerDisplay = value; },
  };
}

function appendReasoningRow(article, {
  thinkingId = 'shared-thinking',
  status = 'streaming',
  label = 'Original label',
} = {}) {
  const row = article.ownerDocument.createElement('div');
  row.className = 'reasoning-row-block';
  row.dataset.thinkingId = thinkingId;
  row.dataset.reasoningStatus = status;
  const main = article.ownerDocument.createElement('div');
  main.className = 'reasoning-row-main';
  main.textContent = label;
  row.appendChild(main);
  article.appendChild(row);
  return { main, row };
}

function setLiveThinkingState(harness, {
  streamId = 'stream-1',
  thinkingId = 'shared-thinking',
  text = 'Updated live status',
} = {}) {
  harness.state.activeStreamSessionId = 'session-1';
  harness.state.activeStreamId = streamId;
  harness.state.streamThinkingStatusByStream.set(streamId, { text, thinkingId });
}

test('live reasoning status selects the later streaming row within the active message', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' }],
  });
  const article = harness.dom.window.document.querySelector('.chat-entry[data-message-id="a1"]');
  const earlier = appendReasoningRow(article, { status: 'complete', label: 'Earlier complete' });
  const later = appendReasoningRow(article, { status: 'streaming', label: 'Later streaming' });
  setLiveThinkingState(harness);

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(earlier.main.textContent, 'Earlier complete');
  assert.equal(earlier.main.classList.contains('shimmer-active'), false);
  assert.equal(later.main.textContent, 'Updated live status');
  assert.equal(later.main.classList.contains('shimmer-active'), true);
  harness.pipeline.dispose();
});

test('live reasoning status is scoped to the active message article', () => {
  const harness = createHarness({
    messages: [
      { id: 'a1', role: 'assistant', status: 'complete', content: 'Earlier response' },
      { id: 'a2', role: 'assistant', status: 'streaming', content: 'Current response' },
    ],
  });
  const articles = harness.dom.window.document.querySelectorAll('.chat-entry');
  const earlier = appendReasoningRow(articles[0], { label: 'Earlier article' });
  const active = appendReasoningRow(articles[1], { label: 'Active article' });
  setLiveThinkingState(harness);

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(earlier.main.textContent, 'Earlier article');
  assert.equal(earlier.main.classList.contains('shimmer-active'), false);
  assert.equal(active.main.textContent, 'Updated live status');
  assert.equal(active.main.classList.contains('shimmer-active'), true);
  harness.pipeline.dispose();
});

test('live reasoning status without an active message id selects the last streaming match', () => {
  const harness = createHarness({
    messages: [
      { id: 'a1', role: 'assistant', status: 'complete', content: 'Earlier response' },
      { id: 'a2', role: 'assistant', status: 'streaming', content: 'Current response' },
    ],
  });
  const articles = harness.dom.window.document.querySelectorAll('.chat-entry');
  const earlier = appendReasoningRow(articles[0], { label: 'Earlier article' });
  const latestStreaming = appendReasoningRow(articles[1], { label: 'Latest streaming' });
  setLiveThinkingState(harness);

  harness.pipeline.renderLiveThinkingChip();

  assert.equal(earlier.main.textContent, 'Earlier article');
  assert.equal(earlier.main.classList.contains('shimmer-active'), false);
  assert.equal(latestStreaming.main.textContent, 'Updated live status');
  assert.equal(latestStreaming.main.classList.contains('shimmer-active'), true);
  harness.pipeline.dispose();
});

test('settled sprite is a persistent static anchor and unchanged renders are idempotent', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.layer.classList.contains('visible'), true);
  assert.equal(harness.sprite.dataset.spriteState, 'complete');
  assert.deepEqual(harness.holoCalls, [[false, 'idle']]);

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.deepEqual(harness.holoCalls, [[false, 'idle']], 'unchanged passive state does not retrigger holo work');

  harness.pipeline.updateAssistantSpritePosition(undefined, undefined, { refreshHolo: true });
  harness.scheduler.flushNext();
  assert.deepEqual(
    harness.holoCalls,
    [[false, 'idle'], [false, 'idle']],
    'an explicit appearance refresh re-evaluates unchanged holo eligibility without DOM churn'
  );
  harness.pipeline.dispose();
});

test('sprite maps live, error, and canonical terminal metadata to distinct view states', () => {
  const message = { id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' };
  const harness = createHarness({ messages: [message] });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'live');
  assert.equal(harness.sprite.classList.contains('is-streaming'), true);
  assert.deepEqual(harness.holoCalls.at(-1), [true, 'inference']);

  harness.state.activeStreamSessionId = 'session-1';
  harness.state.activeStreamId = 'stream-1';
  message.status = 'complete';
  message.terminal_status = 'streaming';
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'complete', 'settled row status outranks stale live metadata');

  message.status = 'error';
  delete message.terminal_status;
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'error');
  assert.deepEqual(harness.holoCalls.at(-1), [false, 'idle']);

  message.terminal_status = 'interrupted';
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'cancelled');

  message.terminal_status = 'aborted';
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'cancelled');
  harness.pipeline.dispose();
});

test('preflight anchors a live sprite below the latest user bubble', () => {
  const harness = createHarness({
    messages: [{ id: 'u1', role: 'user', status: 'complete', content: 'Hello' }],
    preflight: true,
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'live');
  assert.equal(harness.spriteRuntime.targetMessageId, 'u1');
  assert.equal(harness.spriteRuntime.targetY, 172);
  harness.pipeline.dispose();
});

test('preflight for a new turn does not remain anchored to the previous assistant response', () => {
  const harness = createHarness({
    messages: [
      { id: 'u0', role: 'user', status: 'complete', content: 'Earlier prompt' },
      { id: 'a0', role: 'assistant', status: 'complete', content: 'Earlier response' },
      { id: 'u1', role: 'user', status: 'complete', content: 'New prompt' },
    ],
    preflight: true,
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.spriteRuntime.targetMessageId, 'u1');
  assert.equal(harness.spriteRuntime.targetY, 372);
  harness.pipeline.dispose();
});

test('multistep tool phases retain the latest prose anchor until new prose arrives', () => {
  const turnMessages = [
    { id: 'u1', role: 'user', status: 'complete', content: 'Inspect this' },
    { id: 'a1', role: 'assistant', status: 'complete', content: 'I will inspect it.' },
    { id: 'tool1', role: 'assistant', kind: 'tool_use', status: 'streaming', content: '' },
    { id: 'result1', role: 'tool', kind: 'tool_result', status: 'complete', content: 'result' },
    { id: 'a2', role: 'assistant', status: 'streaming', content: 'The result is ready.' },
  ];
  const messages = turnMessages.slice();
  const harness = createHarness({ messages });
  messages.splice(2);
  harness.state.activeStreamSessionId = 'session-1';
  harness.state.activeStreamId = 'stream-1';

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.spriteRuntime.targetMessageId, 'a1');

  messages.push(turnMessages[2]);
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.spriteRuntime.targetMessageId, 'a1', 'tool use keeps the prose anchor');

  messages.push(turnMessages[3]);
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.spriteRuntime.targetMessageId, 'a1', 'tool result keeps the prose anchor');

  messages.push(turnMessages[4]);
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.spriteRuntime.targetMessageId, 'a2', 'new prose becomes the next stable anchor');
  assert.equal(harness.sprite.dataset.spriteState, 'live');
  assert.equal(harness.layer.classList.contains('visible'), true);
  harness.pipeline.dispose();
});

test('a tool-only first assistant phase anchors to its article instead of falling back to the prompt', () => {
  const harness = createHarness({
    messages: [
      { id: 'u1', role: 'user', status: 'complete', content: 'Inspect this' },
      { id: 'tool1', role: 'assistant', kind: 'tool_use', status: 'streaming', content: '' },
    ],
    preflight: true,
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.spriteRuntime.targetMessageId, 'tool1');
  assert.equal(harness.spriteRuntime.targetY, 200);
  harness.pipeline.dispose();
});

test('sprite placement is clamped to the rail layer bounds', () => {
  const messages = Array.from({ length: 9 }, (_, index) => ({
    id: `a${index + 1}`,
    role: 'assistant',
    status: 'complete',
    content: `Message ${index + 1}`,
  }));
  const harness = createHarness({ messages });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.spriteRuntime.targetMessageId, 'a9');
  assert.equal(harness.spriteRuntime.targetY, 770);
  harness.pipeline.dispose();
});

test('responsive hiding and malformed message input fail closed', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });
  harness.setLayerDisplay('none');
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.layer.dataset.suppressionReason, 'responsive_hidden');

  harness.setLayerDisplay('block');
  assert.doesNotThrow(() => harness.pipeline.updateAssistantSpritePosition({ malformed: true }));
  harness.scheduler.flushNext();
  assert.equal(harness.layer.dataset.suppressionReason, 'empty_thread');
  harness.pipeline.dispose();
});

test('malformed array entries are ignored while later valid messages still anchor', () => {
  const harness = createHarness({
    messages: [null, { id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });

  assert.doesNotThrow(() => harness.pipeline.updateAssistantSpritePosition());
  harness.scheduler.flushNext();
  assert.equal(harness.layer.classList.contains('visible'), true);
  assert.equal(harness.spriteRuntime.targetMessageId, 'a1');
  harness.pipeline.dispose();
});

test('stale positioning callbacks are fenced when frame cancellation is unavailable', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
    cancelFrames: false,
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.state.ui.activeView = 'settings';
  harness.pipeline.updateAssistantSpritePosition();
  assert.equal(harness.scheduler.size, 2);
  harness.scheduler.flushAll();
  assert.equal(harness.layer.dataset.suppressionReason, 'inactive_view');

  harness.state.ui.activeView = 'chat';
  harness.pipeline.updateAssistantSpritePosition();
  const holoCallCount = harness.holoCalls.length;
  harness.pipeline.dispose();
  harness.scheduler.flushAll();
  assert.equal(harness.spriteRuntime.frameHandle, 0);
  assert.equal(harness.holoCalls.length, holoCallCount + 1, 'only disposal disables holo');
});

test('missing targets retry only within the bound', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });
  harness.dom.window.document.querySelector('[data-message-id="a1"]').remove();

  harness.pipeline.updateAssistantSpritePosition();
  assert.equal(harness.scheduler.flushAll(), 5, 'initial frame plus two bounded reanchor attempts');
  assert.equal(harness.layer.dataset.suppressionReason, 'missing_target');
  assert.equal(harness.scheduler.size, 0);

  harness.pipeline.dispose();
});
