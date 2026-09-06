const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createTurnShellRenderer,
  resolveTurnArticleMessageId,
  resolveVisibleMessageDomTarget,
} = require('../renderer/chat/renderer-turn-shell');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');
const { SCRIPT_ORDER } = require('./helpers/renderer-shell-harness-support');

function createRenderer() {
  return createTurnShellRenderer({
    escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
  });
}

test('turn shell renderer wraps message bodies in a synthetic row list', () => {
  const renderer = createRenderer();
  const markup = renderer.buildMessageBodyShell('assistant_1', '<div class="chat-bubble">Hello</div>');

  assert.match(markup, /class="turn-row-list"/);
  assert.match(markup, /data-turn-row-list="true"/);
  assert.match(markup, /class="chat-row"/);
  assert.match(markup, /data-row-id="shell:assistant_1"/);
  assert.match(markup, /data-source-message-id="assistant_1"/);
});

test('turn shell renderer preserves assistant avatar/content framing around the shell row and appends caller-owned extra attributes verbatim', () => {
  const renderer = createRenderer();
  const articleMarkup = renderer.buildMessageShellArticle({
    className: 'assistant pending',
    messageId: 'assistant_1',
    messageRole: 'assistant',
    messageStatus: 'streaming',
    finalizedAt: '',
    predictedHeight: 184,
    extraAttributes: 'data-turn-id="turn_1" data-action-target-message-id="assistant_2"',
    innerHtml: renderer.buildAssistantContentShell(
      'assistant_1',
      '<div class="chat-bubble chat-bubble-streaming" data-streaming-bubble="true">Working...</div>'
    ),
  });

  assert.match(articleMarkup, /class="chat-entry message-shell assistant pending"/);
  assert.match(articleMarkup, /data-message-id="assistant_1"/);
  assert.match(articleMarkup, /data-message-role="assistant"/);
  assert.match(articleMarkup, /data-predicted-height="184"/);
  assert.match(articleMarkup, /style="min-height: 184px"/);
  assert.doesNotMatch(articleMarkup, /chat-avatar/, 'the legacy per-message avatar was removed by scroll-W4c');
  assert.match(articleMarkup, /class="chat-message-content"/);
  assert.match(articleMarkup, /data-row-id="shell:assistant_1"/);
  assert.match(articleMarkup, /data-streaming-bubble="true"/);
  assert.match(articleMarkup, /data-turn-id="turn_1"/);
  assert.match(articleMarkup, /data-action-target-message-id="assistant_2"/);
  // E3: every chat-entry is emitted with tabindex="-1" so the roving-tabindex
  // controller can promote one entry to tabindex="0" on first interaction.
  assert.match(articleMarkup, /tabindex="-1"/);
  // E4: chat-entry article carries an aria-label describing the message role
  // for screen readers navigating role="feed".
  assert.match(articleMarkup, /aria-label="Message from Jenny"/);
});

test('chat-entry aria-label varies by message role (E4)', () => {
  const renderer = createRenderer();

  const userArticle = renderer.buildMessageShellArticle({
    messageId: 'user_1',
    messageRole: 'user',
    innerHtml: '<div class="chat-bubble">Hi</div>',
  });
  assert.match(userArticle, /aria-label="Your message"/);
  assert.match(userArticle, /tabindex="-1"/);

  const systemArticle = renderer.buildMessageShellArticle({
    messageId: 'system_1',
    messageRole: 'system',
    innerHtml: '<div class="chat-bubble">system note</div>',
  });
  assert.match(systemArticle, /aria-label="System message"/);

  const toolArticle = renderer.buildMessageShellArticle({
    messageId: 'tool_1',
    messageRole: 'tool',
    innerHtml: '<div class="chat-bubble">tool result</div>',
  });
  assert.match(toolArticle, /aria-label="Tool message"/);

  const unknownArticle = renderer.buildMessageShellArticle({
    messageId: 'misc_1',
    messageRole: '',
    innerHtml: '<div class="chat-bubble">misc</div>',
  });
  assert.match(unknownArticle, /aria-label="Message"/);
});

test('render pipeline fallback preserves shell markup when renderer/chat/renderer-turn-shell.js is unavailable', async (t) => {
  const scriptIndex = SCRIPT_ORDER.indexOf('renderer/chat/renderer-turn-shell.js');
  assert.notEqual(scriptIndex, -1, 'renderer/chat/renderer-turn-shell.js should be present in the harness script order');
  SCRIPT_ORDER.splice(scriptIndex, 1);

  let app = null;
  try {
    app = await loadRendererApp();
    t.after(async () => {
      if (app) {
        await app.dispose();
      }
      SCRIPT_ORDER.splice(scriptIndex, 0, 'renderer/chat/renderer-turn-shell.js');
    });

    const { window, shell } = app;
    const input = window.document.getElementById('chatInput');
    const sendButton = window.document.getElementById('sendButton');

    input.value = 'Fallback shell contract';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 30);

    shell.__state.messagesBySession.set('session-1', [
      {
        id: 'user_fallback_1',
        role: 'user',
        content: 'Fallback shell contract',
        status: 'complete',
      },
      {
        id: 'assistant_fallback_1',
        role: 'assistant',
        content: 'Still wrapped correctly.',
        status: 'complete',
        streamId: 'fallback-1',
      },
    ]);
    await shell.__emitChat({
      type: 'complete',
      sessionId: 'session-1',
      streamId: 'fallback-1',
      content: 'Still wrapped correctly.',
      interactiveProtocolDrift: false,
      interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 50);

    const userEntry = window.document.querySelector('article[data-message-id="user_fallback_1"]');
    const assistantEntry = window.document.querySelector('article[data-message-id="assistant_fallback_1"]');

    assert.ok(userEntry?.classList.contains('message-shell'));
    assert.ok(userEntry?.querySelector('.turn-row-list[data-turn-row-list="true"]'));
    assert.ok(userEntry?.querySelector('.chat-row[data-row-id="shell:user_fallback_1"][data-source-message-id="user_fallback_1"]'));

    assert.ok(assistantEntry?.classList.contains('message-shell'));
    assert.ok(assistantEntry?.querySelector('.chat-message-content .turn-row-list[data-turn-row-list="true"]'));
    assert.ok(
      assistantEntry?.querySelector(
        '.chat-message-content .chat-row[data-source-message-id="assistant_fallback_1"]'
      )
    );
  } catch (error) {
    SCRIPT_ORDER.splice(scriptIndex, 0, 'renderer/chat/renderer-turn-shell.js');
    throw error;
  }
});

test('turn shell resolver maps compat-only child anchors back to the visible coalesced turn article', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="chat-timeline">
      <div class="chat-thread-node chat-thread-root chat-thread-root-assistant" data-thread-message-id="assistant_turn_1">
        <div class="chat-thread-node-row">
          <div class="chat-thread-node-article">
            <article class="chat-entry message-shell assistant" data-message-id="assistant_turn_1">
              <div class="chat-message-content">
                <div class="chat-hover-row" data-message-id="assistant_turn_1"></div>
              </div>
            </article>
          </div>
        </div>
        <div class="chat-thread-children" data-thread-parent="assistant_turn_1">
          <div class="chat-thread-node chat-thread-node-nested" data-thread-message-id="tool_use_turn_1">
            <div class="chat-thread-node-row">
              <div class="chat-thread-node-article">
                <span class="thread-compat-anchor" data-thread-compat-anchor="true" data-message-id="tool_use_turn_1" aria-hidden="true"></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </body></html>`);
  const timeline = dom.window.document.querySelector('.chat-timeline');

  const resolvedPrimary = resolveVisibleMessageDomTarget(timeline, 'assistant_turn_1');
  const resolvedCompatChild = resolveVisibleMessageDomTarget(timeline, 'tool_use_turn_1');

  assert.equal(resolvedPrimary?.tagName, 'ARTICLE');
  assert.equal(resolvedPrimary?.getAttribute('data-message-id'), 'assistant_turn_1');
  assert.equal(resolvedCompatChild?.tagName, 'ARTICLE');
  assert.equal(resolvedCompatChild?.getAttribute('data-message-id'), 'assistant_turn_1');
});

test('turn shell resolver can target the visible assistant text row for hidden compat ids', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="chat-timeline">
      <div class="chat-thread-node chat-thread-node-nested" data-thread-message-id="tool_use_turn_1">
        <div class="chat-thread-node-row">
          <div class="chat-thread-node-article">
            <article class="chat-entry message-shell assistant" data-message-id="tool_use_turn_1">
              <div class="chat-message-content">
                <div class="turn-row-list" data-turn-row-list="true">
                  <div class="chat-row" data-row-kind="tool_step" data-source-message-id="tool_use_turn_1"></div>
                </div>
              </div>
            </article>
          </div>
        </div>
      </div>
      <div class="chat-thread-node chat-thread-node-nested" data-thread-message-id="assistant_turn_1">
        <div class="chat-thread-node-row">
          <div class="chat-thread-node-article">
            <article class="chat-entry message-shell assistant" data-message-id="assistant_turn_1">
              <div class="chat-message-content">
                <div class="turn-row-list" data-turn-row-list="true">
                  <div
                    class="chat-row"
                    data-row-kind="assistant_text"
                    data-source-message-id="assistant_turn_1"
                    data-source-message-ids="assistant_turn_1"
                  ></div>
                </div>
              </div>
            </article>
          </div>
        </div>
      </div>
      <span class="thread-compat-anchor" data-thread-compat-anchor="true" data-message-id="assistant_turn_1" aria-hidden="true"></span>
    </div>
  </body></html>`);
  const timeline = dom.window.document.querySelector('.chat-timeline');

  const resolved = resolveVisibleMessageDomTarget(timeline, 'assistant_turn_1', {
    preferRow: true,
    rowKind: 'assistant_text',
  });

  assert.equal(resolved?.classList.contains('chat-row'), true);
  assert.equal(resolved?.getAttribute('data-row-kind'), 'assistant_text');
  assert.equal(resolved?.getAttribute('data-source-message-id'), 'assistant_turn_1');
});

test('turn shell resolver maps segmented and tool message ids to the primary assistant turn article id', () => {
  const projectionContext = {
    turnIdByMessageId: new Map([
      ['assistant_turn_1', 'turn_1'],
      ['tool_use_turn_1', 'turn_1'],
      ['assistant_turn_1_seg1', 'turn_1'],
    ]),
    turnById: new Map([
      ['turn_1', { primary_assistant_message_id: 'assistant_turn_1' }],
    ]),
  };

  assert.equal(resolveTurnArticleMessageId('assistant_turn_1', projectionContext), 'assistant_turn_1');
  assert.equal(resolveTurnArticleMessageId('tool_use_turn_1', projectionContext), 'assistant_turn_1');
  assert.equal(resolveTurnArticleMessageId('assistant_turn_1_seg1', projectionContext), 'assistant_turn_1');
  assert.equal(resolveTurnArticleMessageId('user_turn_1', projectionContext), 'user_turn_1');
});

test('turn shell resolver maps hidden source ids to their visible render owner', () => {
  const projectionContext = {
    turnIdByMessageId: new Map([
      ['tool_use_turn_1', 'turn_1'],
      ['tool_result_turn_1', 'turn_1'],
      ['assistant_turn_1', 'turn_1'],
    ]),
    turnById: new Map([
      ['turn_1', { primary_assistant_message_id: 'assistant_turn_1' }],
    ]),
    rowsByTurnId: new Map([
      ['turn_1', [{
        kind: 'tool_step',
        primary_message_id: 'tool_use_turn_1',
        render_message_id: 'tool_use_turn_1',
        source_message_ids: ['tool_use_turn_1', 'tool_result_turn_1'],
      }]],
    ]),
  };

  assert.equal(resolveTurnArticleMessageId('tool_result_turn_1', projectionContext), 'tool_use_turn_1');
});

test('turn shell resolver supports selector-sensitive message ids without scanning failure', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="chat-timeline">
      <article class="chat-entry message-shell assistant" data-message-id='assistant:"[1]"'></article>
    </div>
  </body></html>`);
  const timeline = dom.window.document.querySelector('.chat-timeline');

  const resolved = resolveVisibleMessageDomTarget(timeline, 'assistant:"[1]"');

  assert.ok(resolved);
  assert.equal(resolved.getAttribute('data-message-id'), 'assistant:"[1]"');
});

/* ── F4/F5/F6: selection-handle integration ── */

test('buildMessageShellArticle omits data-selected when selection mode is off (F4)', () => {
  const renderer = createRenderer();
  const markup = renderer.buildMessageShellArticle({
    className: 'user',
    messageId: 'u-1',
    messageRole: 'user',
    innerHtml: '<div class="chat-bubble">Hello</div>',
  });
  assert.equal(markup.includes('data-selected'), false);
  assert.equal(markup.includes('chat-entry-select-handle'), false);
});

test('buildMessageShellArticle emits data-selected="false" + handle when selection mode is on (F4)', () => {
  // Stub the inventory primitive for this test only.
  const previous = globalThis.inventorySelectionHandle;
  globalThis.inventorySelectionHandle = {
    buildSelectionHandleMarkup({ messageId, selected, ariaLabel }) {
      return `<button class="chat-entry-select-handle" role="checkbox" aria-checked="${selected ? 'true' : 'false'}" data-select-message-id="${messageId}" aria-label="${ariaLabel}"></button>`;
    },
  };
  try {
    const renderer = createRenderer();
    const markup = renderer.buildMessageShellArticle({
      className: 'user',
      messageId: 'u-1',
      messageRole: 'user',
      innerHtml: '<div class="chat-bubble">Hello</div>',
      selectionMode: true,
      selected: false,
    });
    assert.ok(markup.includes('data-selected="false"'));
    assert.ok(markup.includes('chat-entry-select-handle'));
    assert.ok(markup.includes('data-select-message-id="u-1"'));
    assert.ok(markup.includes('aria-checked="false"'));
  } finally {
    if (previous == null) {
      delete globalThis.inventorySelectionHandle;
    } else {
      globalThis.inventorySelectionHandle = previous;
    }
  }
});

test('buildMessageShellArticle reflects selected=true and Jenny aria-label for assistant role (F4)', () => {
  const previous = globalThis.inventorySelectionHandle;
  globalThis.inventorySelectionHandle = {
    buildSelectionHandleMarkup({ messageId, selected, ariaLabel }) {
      return `<button class="chat-entry-select-handle" data-msg="${messageId}" aria-checked="${selected ? 'true' : 'false'}" data-aria-label="${ariaLabel}"></button>`;
    },
  };
  try {
    const renderer = createRenderer();
    const markup = renderer.buildMessageShellArticle({
      className: 'assistant',
      messageId: 'a-1',
      messageRole: 'assistant',
      innerHtml: '',
      selectionMode: true,
      selected: true,
    });
    assert.ok(markup.includes('data-selected="true"'));
    assert.ok(markup.includes('data-msg="a-1"'));
    assert.ok(markup.includes('aria-checked="true"'));
    assert.ok(markup.includes('data-aria-label="Select message from Jenny"'));
  } finally {
    if (previous == null) {
      delete globalThis.inventorySelectionHandle;
    } else {
      globalThis.inventorySelectionHandle = previous;
    }
  }
});

test('buildMessageShellArticle suppresses the handle for non-selectable roles (system) but keeps data-selected (F4)', () => {
  const previous = globalThis.inventorySelectionHandle;
  globalThis.inventorySelectionHandle = {
    buildSelectionHandleMarkup() {
      return '<button class="chat-entry-select-handle"></button>';
    },
  };
  try {
    const renderer = createRenderer();
    const markup = renderer.buildMessageShellArticle({
      className: 'system',
      messageId: 's-1',
      messageRole: 'system',
      innerHtml: '<div class="chat-system-notice">Notice</div>',
      selectionMode: true,
      selected: false,
    });
    // Layout-shift attribute stays so CSS spacing is uniform.
    assert.ok(markup.includes('data-selected="false"'));
    // But the handle button does NOT appear (system rows are not selectable).
    assert.equal(markup.includes('chat-entry-select-handle'), false);
  } finally {
    if (previous == null) {
      delete globalThis.inventorySelectionHandle;
    } else {
      globalThis.inventorySelectionHandle = previous;
    }
  }
});

test('buildMessageShellArticle degrades gracefully when the inventory primitive is missing (F4)', () => {
  const previous = globalThis.inventorySelectionHandle;
  delete globalThis.inventorySelectionHandle;
  try {
    const renderer = createRenderer();
    const markup = renderer.buildMessageShellArticle({
      className: 'user',
      messageId: 'u-1',
      messageRole: 'user',
      innerHtml: '<div class="chat-bubble">x</div>',
      selectionMode: true,
      selected: true,
    });
    // No handle, but data-selected still attached for the CSS hook.
    assert.ok(markup.includes('data-selected="true"'));
    assert.equal(markup.includes('chat-entry-select-handle'), false);
  } finally {
    if (previous) globalThis.inventorySelectionHandle = previous;
  }
});
