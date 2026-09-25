const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createImmediateRevealController,
  disposeTrackedRevealDoms,
} = require('./helpers/renderer-stream-reveal-harness');

test.afterEach(disposeTrackedRevealDoms);

function block(phase, status, text, { fp = '', key = `phase_${phase}` } = {}) {
  return `<div class="reasoning-row-block expanded" data-phase-key="${key}"
    data-thinking-id="think_${phase}" data-reasoning-status="${status}"${fp ? ` data-reasoning-fp="${fp}"` : ''}>
    <button class="reasoning-row-header" type="button">Phase ${phase}</button>
    <div class="reasoning-row-panel expanded">
      <div class="reasoning-row-panel-body"><p>${text}</p></div>
    </div>
  </div>`;
}

function stack(blocks) {
  return `<div class="reasoning-row-stack">${blocks.join('')}</div>`;
}

function setup({ settledFp = '', settledKey, liveKey } = {}) {
  const settled = block(1, 'complete', 'settled thought', { fp: settledFp, ...(settledKey ? { key: settledKey } : {}) });
  const live = block(2, 'streaming', 'live thought', liveKey ? { key: liveKey } : {});
  const { dom, timeline, controller } = createImmediateRevealController(`
    <div id="timeline">
      <article class="chat-entry assistant" data-message-id="assistant_stream">
        <div data-turn-row-list="true">
          <div class="chat-row" data-row-id="phase_1" data-row-kind="reasoning"
            data-source-message-id="assistant_stream">${stack([settled])}</div>
          <div class="chat-row" data-row-id="phase_2" data-row-kind="reasoning"
            data-source-message-id="assistant_stream">${stack([live])}</div>
        </div>
      </article>
    </div>`);
  const streamingMessage = { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' };
  controller.commitFullRender({ currentSessionId: 'session-1', structureSignature: 10, streamingMessage });
  const calls = { builds: 0, fallbacks: [] };
  function patch(blocks) {
    controller.queuePatch({
      currentSessionId: 'session-1',
      structureSignature: 10,
      streamingMessage,
      messages: [streamingMessage],
      latestAssistantMessageId: streamingMessage.id,
      buildMessageNodeState: () => ({
        thinkingMarkup: stack(blocks), bubbleInnerHtml: null, pending: true,
        entryReveal: false, status: 'streaming', finalizedAt: '',
      }),
      buildTurnRowListMarkup: () => { calls.builds += 1; return ''; },
      onFallback: (cause) => calls.fallbacks.push(cause),
    });
  }
  return { dom, timeline, calls, patch, settled };
}

test('checkpoint deltas patch the live phase in place without touching the settled row', () => {
  const { dom, timeline, calls, patch, settled } = setup();
  const settledRow = timeline.querySelector('[data-row-id="phase_1"]');
  const settledNodes = Array.from(settledRow.querySelectorAll('*'));
  const settledHtml = settledRow.outerHTML;
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(settledRow, { subtree: true, attributes: true, childList: true, characterData: true });
  const liveRow = timeline.querySelector('[data-row-id="phase_2"]');
  const liveBlock = liveRow.querySelector('.reasoning-row-block');
  const liveBody = liveRow.querySelector('.reasoning-row-panel-body');

  patch([settled, block(2, 'streaming', 'live thought grown')]);
  assert.equal(calls.builds, 0, 'a checkpoint delta must not rebuild the turn row list');
  assert.deepEqual(calls.fallbacks, []);
  assert.equal(liveBody.textContent, 'live thought grown');
  // Matching is by key even when the message-level stack order differs.
  patch([block(2, 'streaming', 'live thought grown again'), settled]);
  assert.equal(calls.builds, 0);
  assert.deepEqual(calls.fallbacks, []);
  assert.equal(timeline.querySelector('[data-row-id="phase_2"]'), liveRow);
  assert.equal(liveRow.querySelector('.reasoning-row-block'), liveBlock);
  assert.equal(liveRow.querySelector('.reasoning-row-panel-body'), liveBody);
  assert.equal(liveBody.textContent, 'live thought grown again');
  assert.equal(timeline.querySelector('[data-row-id="phase_1"]'), settledRow);
  assert.deepEqual(Array.from(settledRow.querySelectorAll('*')), settledNodes);
  assert.equal(settledRow.outerHTML, settledHtml);
  assert.deepEqual(observer.takeRecords(), [], 'the other row must receive no DOM writes');
  observer.disconnect();
});

test('a new checkpoint phase without a rendered row still takes the structural path', () => {
  const { calls, patch, settled } = setup();
  patch([settled, block(2, 'streaming', 'live thought'), block(3, 'streaming', 'new phase')]);
  assert.equal(calls.builds, 1);
  assert.deepEqual(calls.fallbacks, ['row_model_no_row_list_markup']);
});

test('a status change in another checkpoint row still takes the structural path', () => {
  const { calls, patch } = setup();
  patch([block(1, 'streaming', 'settled thought'), block(2, 'streaming', 'live thought grown')]);
  assert.equal(calls.builds, 1);
  assert.deepEqual(calls.fallbacks, ['row_model_no_row_list_markup']);
});

test('a missing live checkpoint key still takes the structural path', () => {
  const { calls, patch, settled } = setup();
  patch([settled]);
  assert.equal(calls.builds, 1);
  assert.deepEqual(calls.fallbacks, ['row_model_no_row_list_markup']);
});

test('a settled sibling whose summary or body changed still takes the structural path', () => {
  const { calls, patch } = setup({ settledFp: 'fp-a' });
  patch([block(1, 'complete', 'settled thought', { fp: 'fp-a' }), block(2, 'streaming', 'live thought grown')]);
  assert.equal(calls.builds, 0, 'an unchanged sibling fingerprint patches surgically');
  patch([block(1, 'complete', 'summarized thought', { fp: 'fp-b' }), block(2, 'streaming', 'live thought grown more')]);
  assert.equal(calls.builds, 1, 'a changed sibling fingerprint must rebuild the rows');
  assert.deepEqual(calls.fallbacks, ['row_model_no_row_list_markup']);
});

test('duplicate reasoning block keys never align surgically', () => {
  const { calls, patch } = setup({ settledKey: 'same', liveKey: 'same' });
  patch([
    block(1, 'complete', 'settled thought', { key: 'same' }),
    block(2, 'streaming', 'live thought grown', { key: 'same' }),
  ]);
  assert.equal(calls.builds, 1);
  assert.deepEqual(calls.fallbacks, ['row_model_no_row_list_markup']);
});
