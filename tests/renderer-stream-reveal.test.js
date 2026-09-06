const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JSDOM,
  buildRevealSession,
  captureCodeBlockScroll,
  createStreamRevealController,
  loadRendererTestApp,
  readRepoFile,
  restoreCodeBlockScroll,
  setChildrenHtmlPreservingKeyedNodes,
  settleVisibleStreamAffordances,
} = require('./helpers/renderer-stream-reveal-harness');
const { SCRIPT_ORDER } = require('./helpers/renderer-shell-harness-support');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

// Fixed waitForUi sleeps flake under the 12-worker lane: the send pipeline and
// debounced/rAF stream renders can land after any fixed tick count. Wait on the
// observable DOM state each assertion block reads instead.
async function waitForUserEntry(window) {
  await waitForUiState(
    window,
    () => Boolean(window.document.querySelector('.chat-entry.user')),
    { message: 'Timed out waiting for the sent user turn-article to render.' }
  );
}

test('streaming completion path has no paced drainer or post-complete bubble adornments', () => {
  const styleText = [
    'styles/chat-tools.css',
    'styles/chat-thread.css',
    'styles/chat-bubble-v2.css',
    'styles/chat-send-lifecycle-v2.css',
    'styles/chat-media-queries.css',
  ].map(readRepoFile).join('\n');

  assert.doesNotMatch(
    styleText,
    /\.chat-entry\.assistant\.pending\s+\.chat-bubble\s*\{[\s\S]*?opacity\s*:/,
    'pending assistant bubbles should not dim response text'
  );
  assert.doesNotMatch(
    styleText,
    /\.chat-entry\.assistant\.pending\s+\.chat-bubble::after/,
    'pending assistant bubbles should not add a second pseudo-caret'
  );
  assert.doesNotMatch(
    styleText,
    /stream-settled-entry/,
    'completed responses should not receive a post-complete settled animation class'
  );

  assert.doesNotMatch(
    readRepoFile('index.html'),
    /renderer\/chat\/renderer-stream-text-drainer\.js/,
    'production boot should not load the paced stream text drainer'
  );
  assert.equal(
    SCRIPT_ORDER.includes('renderer/chat/renderer-stream-text-drainer.js'),
    false,
    'renderer harness should mirror production by omitting the paced stream text drainer'
  );
});

function fakePre(scrollLeft = 0, scrollTop = 0) {
  return { tagName: 'PRE', scrollLeft, scrollTop };
}
function fakeRoot(pres) {
  return { querySelectorAll: () => pres };
}

test('captureCodeBlockScroll records only blocks the user has scrolled, keyed by ordinal', () => {
  const saved = captureCodeBlockScroll(fakeRoot([
    fakePre(0, 0),
    fakePre(120, 0),
    fakePre(0, 0),
    fakePre(0, 40),
  ]));
  assert.deepEqual(saved, [
    { index: 1, left: 120, top: 0 },
    { index: 3, left: 0, top: 40 },
  ]);
});

test('captureCodeBlockScroll returns empty when nothing is scrolled', () => {
  assert.deepEqual(captureCodeBlockScroll(fakeRoot([fakePre(), fakePre()])), []);
});

test('restoreCodeBlockScroll re-applies saved offsets to the same-ordinal blocks', () => {
  const saved = [
    { index: 1, left: 120, top: 0 },
    { index: 3, left: 0, top: 40 },
  ];
  const fresh = [fakePre(), fakePre(), fakePre(), fakePre()];
  restoreCodeBlockScroll(fakeRoot(fresh), saved);
  assert.equal(fresh[1].scrollLeft, 120);
  assert.equal(fresh[3].scrollTop, 40);
  // Untouched blocks stay at zero.
  assert.equal(fresh[0].scrollLeft, 0);
  assert.equal(fresh[2].scrollTop, 0);
});

test('restoreCodeBlockScroll ignores saved entries with no matching block after a reflow', () => {
  const saved = [{ index: 2, left: 80, top: 0 }];
  const fresh = [fakePre(), fakePre()]; // code block at ordinal 2 no longer exists
  assert.doesNotThrow(() => restoreCodeBlockScroll(fakeRoot(fresh), saved));
  assert.equal(fresh[0].scrollLeft, 0);
  assert.equal(fresh[1].scrollLeft, 0);
});

test('restoreCodeBlockScroll with empty/absent save set is a no-op', () => {
  const fresh = [fakePre(50, 0)];
  restoreCodeBlockScroll(fakeRoot(fresh), []);
  restoreCodeBlockScroll(fakeRoot(fresh), null);
  assert.equal(fresh[0].scrollLeft, 50);
});

test('keyed child morph reports failures so callers can log fallback renders', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const target = {
    ownerDocument: dom.window.document,
    firstChild: null,
    childNodes: [],
    querySelectorAll: () => [],
    insertBefore() {
      throw new Error('insert failed');
    },
  };
  const errors = [];

  const patched = setChildrenHtmlPreservingKeyedNodes(
    target,
    '<div data-thread-message-id="u2">new</div>',
    {
      onError(error) {
        errors.push(String(error?.message || error));
      },
    }
  );

  assert.equal(patched, false);
  assert.deepEqual(errors, ['insert failed']);
});

test('settleVisibleStreamAffordances removes terminal caret markers without rebuilding content', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="timeline" aria-busy="true">
      <div class="chat-thread-root" data-thread-message-id="assistant_stream-one">
        <article
          class="chat-entry assistant pending stream-reveal-entry"
          data-message-id="assistant_stream-one"
          data-streaming-message-id="assistant_stream-one"
        >
          <div class="chat-row" data-streaming-row="true">
            <div
              class="chat-bubble chat-bubble-markdown chat-bubble-streaming"
              data-streaming-bubble="true"
              role="status"
              aria-live="polite"
              aria-atomic="false"
              aria-label="Assistant response (streaming)"
            >
              <div class="chat-stream-unit is-revealed is-streaming-tail" data-stream-unit-index="0">
                <p>Final text stays put.</p>
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>
  </body>`);
  const timeline = dom.window.document.getElementById('timeline');

  const result = settleVisibleStreamAffordances({
    chatTimeline: timeline,
    messageId: 'assistant_stream-one',
    streamId: 'stream-one',
    escapeSelectorValue: (value) => String(value || ''),
  });

  assert.equal(result.cleared, true);
  assert.equal(timeline.textContent.includes('Final text stays put.'), true);
  assert.equal(timeline.querySelectorAll('.chat-bubble-streaming').length, 0);
  assert.equal(timeline.querySelectorAll('[data-streaming-bubble="true"]').length, 0);
  assert.equal(timeline.querySelectorAll('.is-streaming-tail').length, 0);
  assert.equal(timeline.querySelectorAll('[data-streaming-row="true"]').length, 0);
  assert.equal(timeline.querySelectorAll('[data-streaming-message-id]').length, 0);
  assert.equal(timeline.querySelectorAll('article.pending').length, 0);
  assert.equal(timeline.getAttribute('aria-busy'), 'false');

  const secondResult = settleVisibleStreamAffordances({
    chatTimeline: timeline,
    messageId: 'assistant_stream-one',
    streamId: 'stream-one',
    escapeSelectorValue: (value) => String(value || ''),
  });
  assert.equal(secondResult.cleared, false);
});

test('settleVisibleStreamAffordances does not clear unrelated streams when ids miss', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="timeline" aria-busy="true">
      <article
        class="chat-entry assistant pending"
        data-message-id="assistant_stream-other"
        data-streaming-message-id="assistant_stream-other"
      >
        <div class="chat-row" data-streaming-row="true">
          <div class="chat-bubble chat-bubble-streaming" data-streaming-bubble="true">
            <div class="chat-stream-unit is-revealed"><p>Still streaming.</p></div>
          </div>
        </div>
      </article>
    </div>
  </body>`);
  const timeline = dom.window.document.getElementById('timeline');

  const result = settleVisibleStreamAffordances({
    chatTimeline: timeline,
    streamId: 'stream-missing',
    messageId: 'assistant_stream-missing',
    escapeSelectorValue: (value) => String(value || ''),
  });

  assert.equal(result.cleared, false);
  assert.equal(timeline.querySelectorAll('.chat-bubble-streaming').length, 1);
  assert.equal(timeline.querySelectorAll('[data-streaming-bubble="true"]').length, 1);
  assert.equal(timeline.querySelectorAll('[data-streaming-row="true"]').length, 1);
  assert.equal(timeline.querySelectorAll('.is-revealed').length, 1);
  assert.equal(timeline.getAttribute('aria-busy'), 'true');
});

test('renderer reveals only the changed trailing assistant markdown blocks while streaming', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-reveal';
          state.sessions = [buildRevealSession(sessionId, payload)];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-reveal' };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Reveal this reply';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUserEntry(window);

  await shell.__emitChat({ type: 'started', sessionId: 'session-reveal', streamId: 'stream-reveal' });
  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-reveal',
    streamId: 'stream-reveal',
    content: 'First paragraph.',
    aggregate: 'First paragraph.',
  });
  await waitForUiState(
    window,
    () => window.document.querySelector('[data-message-id="assistant_stream-reveal"]')
      ?.querySelectorAll('.chat-stream-unit').length === 1,
    { message: 'Timed out waiting for the streaming assistant article with its first stream unit.' }
  );

  const userEntryBefore = window.document.querySelector('.chat-entry.user');
  let assistantEntry = window.document.querySelector('[data-message-id="assistant_stream-reveal"]');
  let revealUnits = assistantEntry.querySelectorAll('.chat-stream-unit');

  assert.ok(userEntryBefore);
  assert.ok(assistantEntry.classList.contains('message-shell'));
  assert.equal(assistantEntry.querySelector('.chat-avatar'), null, 'the legacy per-message avatar was removed by scroll-W4c');
  assert.ok(assistantEntry.querySelector('.chat-message-content'));
  assert.ok(assistantEntry.querySelector('.chat-message-content .turn-row-list[data-turn-row-list="true"]'));
  assert.ok(
    assistantEntry.querySelector('.chat-message-content .chat-row[data-row-kind="assistant_text"][data-source-message-id="assistant_stream-reveal"]')
  );
  assert.ok(assistantEntry.querySelector('.chat-message-content [data-streaming-bubble="true"]'));
  assert.ok(assistantEntry.classList.contains('stream-reveal-entry'));
  assert.equal(revealUnits.length, 1);
  assert.equal(revealUnits[0].classList.contains('is-revealed'), true);
  assert.equal(revealUnits[0].classList.contains('is-streaming-tail'), false, 'streaming tail look removed (ISSUE-001 follow-up)');

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-reveal',
    streamId: 'stream-reveal',
    content: '\n\nSecond paragraph.',
    aggregate: 'First paragraph.\n\nSecond paragraph.',
  });
  await waitForUiState(
    window,
    () => window.document.querySelector('[data-message-id="assistant_stream-reveal"]')
      ?.querySelectorAll('.chat-stream-unit').length === 2,
    { message: 'Timed out waiting for the second stream unit to render.' }
  );

  const userEntryAfter = window.document.querySelector('.chat-entry.user');
  assistantEntry = window.document.querySelector('[data-message-id="assistant_stream-reveal"]');
  revealUnits = assistantEntry.querySelectorAll('.chat-stream-unit');

  assert.equal(userEntryAfter, userEntryBefore);
  assert.equal(revealUnits.length, 2);
  assert.equal(revealUnits[0].classList.contains('is-revealed'), false);
  assert.equal(revealUnits[1].classList.contains('is-revealed'), true);
  assert.equal(revealUnits[0].classList.contains('is-streaming-tail'), false, 'streaming tail look removed (ISSUE-001 follow-up)');
  assert.equal(revealUnits[1].classList.contains('is-streaming-tail'), false, 'streaming tail look removed (ISSUE-001 follow-up)');

  shell.__state.messagesBySession.set('session-reveal', [
    {
      id: 'user_1',
      role: 'user',
      content: 'Reveal this reply',
      timestamp: new Date().toISOString(),
    },
    {
      id: 'assistant_stream-reveal',
      role: 'assistant',
      content: 'First paragraph.\n\nSecond paragraph.',
      status: 'complete',
      timestamp: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
    },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-reveal',
    streamId: 'stream-reveal',
    content: 'First paragraph.\n\nSecond paragraph.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  // Wait for the settle re-render (hover row present, streaming affordances
  // gone), mirroring renderer-stream-reveal-terminal-root.test.js.
  await waitForUiState(
    window,
    () => {
      const entry = window.document.querySelector('[data-message-id="assistant_stream-reveal"]');
      return Boolean(entry)
        && !entry.classList.contains('pending')
        && Boolean(entry.querySelector('.chat-message-content .chat-hover-row'))
        && entry.querySelectorAll('.chat-stream-unit').length === 0;
    },
    { message: 'Timed out waiting for the assistant turn-article to settle after complete.' }
  );

  assistantEntry = window.document.querySelector('[data-message-id="assistant_stream-reveal"]');
  assert.ok(assistantEntry);
  assert.equal(assistantEntry.classList.contains('pending'), false);
  assert.equal(assistantEntry.classList.contains('stream-reveal-entry'), false);
  assert.ok(
    assistantEntry.querySelector('.chat-message-content .chat-row[data-row-kind="assistant_text"][data-source-message-id="assistant_stream-reveal"]')
  );
  assert.ok(assistantEntry.querySelector('.chat-message-content .chat-hover-row'));
  assert.equal(assistantEntry.querySelector('.chat-bubble-streaming'), null);
  assert.equal(assistantEntry.querySelectorAll('.chat-stream-unit').length, 0);
});

test('renderer suppresses stream reveal classes when reduced motion is active', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    reducedMotion: true,
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-reveal-reduced';
          state.sessions = [buildRevealSession(sessionId, payload)];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-reveal-reduced' };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Reveal this reply';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUserEntry(window);

  await shell.__emitChat({
    type: 'started',
    sessionId: 'session-reveal-reduced',
    streamId: 'stream-reveal-reduced',
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-reveal-reduced',
    streamId: 'stream-reveal-reduced',
    content: 'First paragraph.\n\nSecond paragraph.',
    aggregate: 'First paragraph.\n\nSecond paragraph.',
  });
  await waitForUiState(
    window,
    () => window.document.querySelector('[data-message-id="assistant_stream-reveal-reduced"]')
      ?.querySelectorAll('.chat-stream-unit').length === 2,
    { message: 'Timed out waiting for the reduced-motion streaming article with both stream units.' }
  );

  const assistantEntry = window.document.querySelector('[data-message-id="assistant_stream-reveal-reduced"]');
  const revealUnits = assistantEntry.querySelectorAll('.chat-stream-unit');

  assert.ok(assistantEntry);
  assert.equal(assistantEntry.classList.contains('stream-reveal-entry'), false);
  assert.equal(revealUnits.length, 2);
  assert.equal(Array.from(revealUnits).some((unit) => unit.classList.contains('is-revealed')), false);
  assert.equal(Array.from(revealUnits).some((unit) => unit.classList.contains('is-streaming-tail')), false,
    'streaming tail class suppressed under reduced motion');
});

test('stream reveal targets the coalesced turn article when the streaming message id differs from the visible article id', () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream_root">
            <div class="chat-message-content">
              <div class="turn-row-list" data-turn-row-list="true">
                <div class="chat-row" data-row-kind="assistant_text" data-source-message-id="assistant_stream_root_seg1" data-streaming-row="true">
                  <div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true">old</div>
                </div>
              </div>
            </div>
          </article>
        </div>
      </body>
    </html>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  dom.window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};

  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({
      html: '<span>patched</span>',
      units: [{ html: '<span>patched</span>', revealed: true, tail: true }],
      fingerprints: ['patched'],
      changedStartIndex: 0,
    }),
    escapeSelectorValue: (value) => String(value || ''),
  });

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream_root_seg1', role: 'assistant', status: 'streaming', content: 'patched' },
    streamingArticleMessageId: 'assistant_stream_root',
    activeTurnRootMessageId: 'user_stream_root',
    activeTurnStructureHash: 100,
    activeTurnTailFingerprint: 'tail:1',
  });

  const resolvedArticle = controller.resolveStreamingPatchTarget({
    streamingMessageId: 'assistant_stream_root_seg1',
    streamingArticleMessageId: 'assistant_stream_root',
  }, timeline);
  assert.equal(resolvedArticle?.getAttribute('data-message-id'), 'assistant_stream_root');
  assert.equal(
    timeline.querySelector('[data-message-id="assistant_stream_root"]')?.getAttribute('data-streaming-message-id'),
    'assistant_stream_root_seg1'
  );

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream_root_seg1',
    streamingMessage: { id: 'assistant_stream_root_seg1', role: 'assistant', status: 'streaming', content: 'patched' },
    messages: [{ id: 'assistant_stream_root_seg1', role: 'assistant', status: 'streaming', content: 'patched' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: '<span>patched</span>',
      innerHtml: '<div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true"><span>patched</span></div>',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  assert.match(String(timeline.textContent || ''), /patched/);

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 11,
    streamingMessage: null,
    streamingArticleMessageId: '',
    activeTurnRootMessageId: 'user_stream_root',
    activeTurnStructureHash: 101,
    activeTurnTailFingerprint: 'tail:2',
  });

  assert.equal(
    timeline.querySelector('[data-message-id="assistant_stream_root"]')?.hasAttribute('data-streaming-message-id'),
    false
  );
});

test('stream unit reuse resets when the active session changes even if message ids collide', () => {
  const state = { currentSessionId: 'session-1' };
  const previousLengths = [];
  const controller = createStreamRevealController({
    state,
    reducedMotionQuery: { matches: true },
    renderStreamingMarkdownUnits: (_content, options) => {
      previousLengths.push(options.previousUnits.length);
      return {
        html: '<p>stream</p>',
        units: [{ html: '<p>stream</p>', fingerprint: 'stream' }],
        changedStartIndex: 0,
      };
    },
  });
  const message = { id: 'assistant_collision', content: 'stream' };
  controller.commitFullRender({ currentSessionId: 'session-1', streamingMessage: message });

  controller.buildStreamingBubbleMarkup(message);
  controller.buildStreamingBubbleMarkup(message);
  state.currentSessionId = 'session-2';
  controller.buildStreamingBubbleMarkup(message);

  assert.deepEqual(previousLengths, [0, 1, 0]);
});
