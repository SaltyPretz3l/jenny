// F2 renderer: tests for createMessageEditController state machine. Uses a
// minimal in-memory document stub + a stub startPromptSend to drive the
// enterEdit -> commitEdit/cancelEdit flow without booting the full renderer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createMessageEditController,
  EDIT_STREAM_BUSY_REASON,
  EDIT_EMPTY_CONTENT_REASON,
  EDIT_TEXT_ATTACHMENT_NOTICE,
} = require('../renderer/chat/renderer-chat-message-edit-utils');
const { buildInlineUserMessageEditorMarkup } = require('../renderer/inventory/inline-text-editor');

function createDocStub() {
  const textareas = new Map(); // messageId -> { value, listeners: {input,keydown}, focused, selected }
  const entries = new Map();   // messageId -> { focusCalls: 0 }
  const allEntries = [];
  const timers = [];
  function createClassList() {
    const classes = new Set();
    return {
      add(name) { classes.add(String(name)); },
      remove(name) { classes.delete(String(name)); },
      contains(name) { return classes.has(String(name)); },
    };
  }
  return {
    defaultView: {
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout() {},
    },
    _drainTimers() {
      const pending = timers.splice(0);
      for (const callback of pending) callback();
    },
    _addTextarea(messageId, initialValue) {
      let value = String(initialValue || '');
      const node = {
        listeners: { input: [], keydown: [] },
        focused: false,
        selected: false,
        selectionStart: 0,
        selectionEnd: 0,
        get value() { return value; },
        set value(nextValue) {
          value = String(nextValue || '');
          this.selectionStart = value.length;
          this.selectionEnd = value.length;
        },
        addEventListener(type, fn) { this.listeners[type].push(fn); },
        removeEventListener(type, fn) {
          this.listeners[type] = this.listeners[type].filter((listener) => listener !== fn);
        },
        focus() { this.focused = true; },
        select() { this.selected = true; },
        setSelectionRange(start, end) {
          this.selectionStart = start;
          this.selectionEnd = end;
        },
      };
      textareas.set(String(messageId), node);
      return node;
    },
    _addEntry(messageId, role) {
      const entry = {
        _messageId: messageId,
        _role: role,
        focusCalls: 0,
        classList: createClassList(),
        getAttribute(name) {
          if (name === 'data-message-id') return this._messageId;
          if (name === 'data-message-role') return this._role;
          if (name === 'data-virtualized') return this._virtualized === true ? 'true' : null;
          if (name === 'tabindex') return this.tabindex == null ? null : this.tabindex;
          return null;
        },
        hasAttribute(name) {
          return this.getAttribute(name) !== null;
        },
        setAttribute(name, value) {
          if (name === 'tabindex') this.tabindex = String(value);
          if (name === 'data-virtualized') this._virtualized = String(value) === 'true';
        },
        removeAttribute(name) {
          if (name === 'data-virtualized') this._virtualized = false;
          if (name === 'tabindex') delete this.tabindex;
        },
        focus() { this.focusCalls += 1; },
      };
      entries.set(String(messageId), entry);
      allEntries.push(entry);
      return entry;
    },
    querySelector(selector) {
      const taMatch = selector.match(/textarea\[data-edit-target-message-id="(.+)"\]/);
      if (taMatch) {
        return textareas.get(taMatch[1]) || null;
      }
      const entryMatch = selector.match(/\.chat-entry\[data-message-id="(.+)"\]/);
      if (entryMatch) {
        return entries.get(entryMatch[1]) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.chat-entry') {
        return allEntries.slice();
      }
      return [];
    },
  };
}

function createControllerHarness(options = {}) {
  const state = {
    currentSessionId: options.currentSessionId || 'sess_A',
    ui: {},
    turnEventsBySession: new Map([[options.currentSessionId || 'sess_A', [{ event_id: 'e1' }]]]),
    messagesBySession: new Map([[options.currentSessionId || 'sess_A', [{ id: 'msg_user_1' }]]]),
  };
  const doc = createDocStub();
  const logs = [];
  const composerErrors = [];
  const toasts = [];
  const renderCalls = [];
  const promptSends = [];
  const ipcCalls = [];
  const projectionCacheClears = [];
  const focusCalls = [];
  const virtualizerCalls = [];

  const messages = options.messages || [
    { id: 'msg_user_1', role: 'user', content: 'original prompt' },
    { id: 'msg_ai_1', role: 'assistant', content: 'reply' },
    { id: 'msg_user_2', role: 'user', content: 'follow-up' },
  ];

  // Pre-seed DOM entries + textarea (textarea created lazily on first sync).
  for (const msg of messages) {
    doc._addEntry(msg.id, msg.role);
  }

  const blockedState = { blocked: false };

  const startPromptSendImpl = async (prompt, opts) => {
    promptSends.push({ prompt, opts });
    if (typeof options.startPromptSend === 'function') {
      return options.startPromptSend(prompt, opts);
    }
    return {
      streamId: 'stream_' + Date.now(),
      sessionId: opts.sessionIdOverride,
      identity: { userMessageId: opts.editedMessageId },
    };
  };

  // Hook so tests can intercept the textarea creation on the first syncFromState.
  let textareaCreatedFor = null;
  const renderAllImpl = options.renderAll || (() => {
    renderCalls.push(1);
    if (state.ui.editingMessageId && textareaCreatedFor !== state.ui.editingMessageId) {
      // Auto-create the textarea matching the markup the renderer would produce.
      doc._addTextarea(state.ui.editingMessageId, state.ui.editingDraftText);
      textareaCreatedFor = state.ui.editingMessageId;
    }
    if (!state.ui.editingMessageId) {
      textareaCreatedFor = null;
    }
  });

  const controller = createMessageEditController({
    state,
    document: doc,
    jennyShellSessions: {
      editAndTruncate(sessionId, messageId, payload) {
        ipcCalls.push({ sessionId, messageId, payload });
        throw new Error('legacy truncate must not be called');
      },
    },
    getCurrentSessionMessages: () => messages,
    getCurrentSessionId: () => state.currentSessionId,
    startPromptSend: startPromptSendImpl,
    renderAll: renderAllImpl,
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
    showComposerActionError: (err, title) => composerErrors.push({ message: err && err.message, title }),
    resolveFollowUpActionBlock: () => ({ ...blockedState }),
    clearProjectionContextCacheForSession: (id) => projectionCacheClears.push(id),
    buildReplayableImageAttachments: options.buildReplayableImageAttachments || (() => []),
    hasTextAttachmentMetadata: options.hasTextAttachmentMetadata || (() => false),
    focusEntryAtIndexFn: (idx) => focusCalls.push(idx),
    showToastMessage: (payload) => toasts.push(payload),
    timelineVirtualizer: options.timelineVirtualizer || {
      ensureMounted(entryEl) {
        virtualizerCalls.push(entryEl && entryEl.getAttribute && entryEl.getAttribute('data-message-id'));
        entryEl && entryEl.removeAttribute && entryEl.removeAttribute('data-virtualized');
      },
    },
  });

  return {
    state,
    controller,
    doc,
    logs,
    composerErrors,
    toasts,
    renderCalls,
    promptSends,
    ipcCalls,
    projectionCacheClears,
    focusCalls,
    virtualizerCalls,
    setBlocked(reason) { blockedState.blocked = true; blockedState.reason = reason; },
    clearBlocked() { blockedState.blocked = false; delete blockedState.reason; },
  };
}

// Real-DOM harness (via jsdom) for the textarea-attribute-selector edge
// cases: message ids containing characters that are meaningful to CSS
// selector syntax (backslash, newline). The lightweight regex-based doc
// stub above doesn't reproduce real querySelector parsing (it neither
// mis-escapes backslash nor throws on an embedded newline), so those two
// defects can only be exercised against a real selector engine.
function createJsdomEditHarness(messageId) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const state = {
    currentSessionId: 'sess_A',
    ui: {},
    turnEventsBySession: new Map(),
    messagesBySession: new Map(),
  };
  const messages = [{ id: messageId, role: 'user', content: 'original prompt' }];

  const entry = doc.createElement('div');
  entry.className = 'chat-entry';
  entry.setAttribute('data-message-id', messageId);
  entry.setAttribute('data-message-role', 'user');
  doc.body.appendChild(entry);

  // Mirrors the stub harness's renderAllImpl: lazily materializes the real
  // <textarea data-edit-target-message-id="..."> the production renderer
  // would produce, using setAttribute (not selector text) so the raw id
  // (backslash/newline and all) lands verbatim in the DOM attribute.
  let textareaCreatedFor = null;
  const renderAllImpl = () => {
    if (state.ui.editingMessageId && textareaCreatedFor !== state.ui.editingMessageId) {
      const ta = doc.createElement('textarea');
      ta.setAttribute('data-edit-target-message-id', state.ui.editingMessageId);
      ta.value = state.ui.editingDraftText || '';
      doc.body.appendChild(ta);
      textareaCreatedFor = state.ui.editingMessageId;
    }
    if (!state.ui.editingMessageId) {
      textareaCreatedFor = null;
    }
  };

  const controller = createMessageEditController({
    state,
    document: doc,
    windowRef: dom.window,
    jennyShellSessions: { editAndTruncate: async () => ({}) },
    getCurrentSessionMessages: () => messages,
    getCurrentSessionId: () => state.currentSessionId,
    renderAll: renderAllImpl,
    appendClientLog: () => {},
    showComposerActionError: () => {},
    resolveFollowUpActionBlock: () => ({ blocked: false }),
  });

  return { dom, doc, state, controller };
}

test('enterEdit on a user message sets edit state', () => {
  const h = createControllerHarness();
  const ok = h.controller.enterEdit('msg_user_1');
  assert.equal(ok, true);
  assert.equal(h.state.ui.editingMessageId, 'msg_user_1');
  assert.equal(h.state.ui.editingDraftText, 'original prompt');
  assert.equal(h.state.ui.editingOriginalText, 'original prompt');
  assert.equal(h.state.ui.editingSessionId, 'sess_A');
  assert.equal(h.state.ui.editingAffectedCount, 3);
  // Should log entry + render at least once.
  assert.ok(h.logs.find((l) => l.event === 'chat.edit_entered'));
  assert.ok(h.renderCalls.length >= 1);
  // Textarea should be focused after sync.
  const ta = h.doc.querySelector('textarea[data-edit-target-message-id="msg_user_1"]');
  assert.ok(ta);
  assert.equal(ta.focused, true);
  assert.equal(ta.selected, true);
});

test('inline edit markup presents the exact existing-history impact', () => {
  const html = buildInlineUserMessageEditorMarkup({
    messageId: 'msg_user_1',
    draftText: 'edited',
    affectedCount: 3,
  });
  assert.match(html, /Affects 3 existing messages/);
  assert.match(html, /all later history/);
  assert.match(html, /title="Cancel edit \(Esc\)"/);
  assert.match(html, /title="Save and resend \(Ctrl\+Enter\)"/);
});

test('enterEdit on an assistant message is rejected (defensive)', () => {
  const h = createControllerHarness();
  const ok = h.controller.enterEdit('msg_ai_1');
  assert.equal(ok, false);
  assert.equal(h.state.ui.editingMessageId, '');
  assert.ok(h.logs.find((l) => l.event === 'chat.edit_blocked' && l.details.reason === 'not_user_message'));
});

test('enterEdit while another edit is already active is a silent no-op', () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  const before = h.state.ui.editingMessageId;
  const ok = h.controller.enterEdit('msg_user_2');
  assert.equal(ok, false);
  // First edit is unchanged.
  assert.equal(h.state.ui.editingMessageId, before);
});

test('enterEdit during stream busy state surfaces toast and stays in non-editing state', () => {
  const h = createControllerHarness();
  h.setBlocked('Wait for the current response to finish before editing.');
  const ok = h.controller.enterEdit('msg_user_1');
  assert.equal(ok, false);
  assert.equal(h.state.ui.editingMessageId, '');
  assert.ok(h.composerErrors.find((e) => /finish/i.test(e.message || '')));
});

test('commitEdit with unchanged draft acts as cancel (no IPC call)', async () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  // Don't change the draft.
  const result = await h.controller.commitEdit();
  assert.equal(result, null);
  assert.equal(h.ipcCalls.length, 0);
  assert.equal(h.state.ui.editingMessageId, '');
  assert.ok(h.logs.find((l) => l.event === 'chat.edit_unchanged'));
});

test('commitEdit issues one atomic startPromptSend operation with the edited prompt', async () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  // Update draft (the controller writes from textarea.input — emulate manually).
  h.state.ui.editingDraftText = 'edited prompt body';
  const result = await h.controller.commitEdit();
  assert.ok(result);
  assert.equal(h.ipcCalls.length, 0, 'legacy sessions.editAndTruncate must not run');
  assert.equal(h.promptSends.length, 1);
  assert.equal(h.promptSends[0].prompt, 'edited prompt body');
  assert.equal(h.promptSends[0].opts.visiblePrompt, 'edited prompt body');
  assert.ok(h.logs.find((l) => l.event === 'chat.edit_committed'));
  assert.ok(h.logs.find((l) => l.event === 'chat.edit_replayed'));
  assert.equal(h.promptSends[0].opts.editedMessageId, 'msg_user_1');
  assert.equal(h.promptSends[0].opts.sessionIdOverride, 'sess_A');
  // The authoritative start accepted the replacement turn, so edit state clears.
  assert.equal(h.state.ui.editingMessageId, '');
});

test('commitEdit pins the atomic command to the edit-origin session during navigation', async () => {
  let resolveStart;
  const pendingStart = new Promise((resolve) => { resolveStart = resolve; });
  const h = createControllerHarness({
    startPromptSend: () => pendingStart,
  });
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = 'edited prompt body';

  const commitPromise = h.controller.commitEdit();
  // Session navigation happens while the one backend command is pending.
  h.state.currentSessionId = 'sess_B';
  resolveStart({
    streamId: 'stream-edit',
    sessionId: 'sess_A',
    identity: { userMessageId: 'msg_user_1' },
  });
  await commitPromise;

  assert.equal(h.promptSends.length, 1);
  assert.equal(
    h.promptSends[0].opts.sessionIdOverride,
    'sess_A',
    'the resend must be pinned to the edit-origin session, not the now-current session'
  );
});

test('commitEdit rechecks the stream busy gate before calling IPC', async () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = 'edited prompt body';
  h.setBlocked('Wait for the current response to finish before editing.');

  const result = await h.controller.commitEdit();

  assert.equal(result, null);
  assert.equal(h.ipcCalls.length, 0);
  assert.equal(h.promptSends.length, 0);
  assert.equal(h.state.ui.editingMessageId, 'msg_user_1');
  assert.ok(h.composerErrors.find((e) => e.title === 'Edit Blocked'));
  assert.ok(h.logs.find((l) => l.level === 'WARN' && l.event === 'chat.edit_commit_blocked_by_stream'));
});

test('commitEdit ignores duplicate submits while the atomic start is pending', async () => {
  let resolveStart;
  const pendingStart = new Promise((resolve) => { resolveStart = resolve; });
  const h = createControllerHarness({
    startPromptSend: () => pendingStart,
  });
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = 'edited prompt body';

  const firstCommit = h.controller.commitEdit();
  const secondCommit = h.controller.commitEdit();

  assert.equal(await secondCommit, null);
  assert.equal(h.promptSends.length, 1);
  assert.equal(h.ipcCalls.length, 0);
  assert.equal(h.state.ui.editCommitting, true);
  assert.equal(h.state.ui.editingMessageId, 'msg_user_1');
  assert.equal(h.state.ui.editingDraftText, 'edited prompt body');

  resolveStart({
    streamId: 'stream-edit',
    sessionId: 'sess_A',
    identity: { userMessageId: 'msg_user_1' },
  });
  await firstCommit;
  assert.equal(h.promptSends.length, 1);
});

test('commitEdit clears edit state at the authoritative-start callback before stream-buffer postwork', async () => {
  let releasePostwork;
  const postwork = new Promise((resolve) => { releasePostwork = resolve; });
  let h;
  h = createControllerHarness({
    startPromptSend: async (_prompt, opts) => {
      const result = {
        streamId: 'stream-edit',
        sessionId: 'sess_A',
        identity: { userMessageId: 'msg_user_1' },
      };
      assert.equal(h.state.ui.editingMessageId, 'msg_user_1');
      opts.onAuthoritativeStart(result);
      assert.equal(h.state.ui.editingMessageId, '');
      await postwork;
      return result;
    },
  });
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = 'edited prompt body';

  const commitPromise = h.controller.commitEdit();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.state.ui.editingMessageId, '');
  releasePostwork();
  assert.equal((await commitPromise).streamId, 'stream-edit');
});

test('commitEdit reconciles to the edited anchor and invalidates derived caches after authoritative start', async () => {
  const h = createControllerHarness();
  h.state.messagesBySession.set('sess_A', [
    { id: 'msg_user_1', role: 'user', content: 'original prompt' },
    { id: 'msg_ai_1', role: 'assistant', content: 'stale reply' },
  ]);
  h.state.ui.chatTimelineRowModelMetaBySession = new Map([['sess_A', { meta: true }]]);
  h.state.ui.chatTimelineRowModelBySession = new Map([['sess_A', { rows: true }]]);
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = 'edited body';
  await h.controller.commitEdit();
  assert.equal(h.state.turnEventsBySession.has('sess_A'), false);
  assert.deepEqual(h.state.messagesBySession.get('sess_A'), [
    { id: 'msg_user_1', role: 'user', content: 'edited body', attachments: [] },
  ]);
  assert.equal(h.state.ui.chatTimelineRowModelMetaBySession.has('sess_A'), false);
  assert.equal(h.state.ui.chatTimelineRowModelBySession.has('sess_A'), false);
  assert.deepEqual(h.projectionCacheClears, ['sess_A']);
});

test('commitEdit on rejected atomic start leaves edit mode and draft open for retry', async () => {
  const h = createControllerHarness({
    startPromptSend: async () => { throw new Error('sidecar unavailable'); },
  });
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = 'edited body';
  const result = await h.controller.commitEdit();
  assert.equal(result, null);
  // Edit state remains so the user can retry / cancel.
  assert.equal(h.state.ui.editingMessageId, 'msg_user_1');
  assert.equal(h.state.ui.editingDraftText, 'edited body');
  assert.equal(h.state.ui.editCommitting, false);
  assert.ok(h.composerErrors.find((e) => /sidecar unavailable/i.test(e.message || '')));
  assert.ok(h.logs.find((l) => l.event === 'chat.edit_failed'));
  assert.equal(h.promptSends.length, 1);
  assert.equal(h.ipcCalls.length, 0);
});

test('commitEdit on atomic start returning null retains edit state without clearing caches', async () => {
  const h = createControllerHarness({ startPromptSend: async () => null });
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = 'edited body';
  const result = await h.controller.commitEdit();
  assert.equal(result, null);
  assert.equal(h.state.ui.editingMessageId, 'msg_user_1');
  assert.equal(h.state.ui.editingDraftText, 'edited body');
  assert.equal(h.state.messagesBySession.has('sess_A'), true);
  assert.ok(h.logs.find((entry) => entry.event === 'chat.edit_start_refused'));
});

test('commitEdit blocks empty draft when there are no replayable image attachments', async () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = '';
  const result = await h.controller.commitEdit();
  assert.equal(result, null);
  assert.equal(h.ipcCalls.length, 0);
  // Original draft un-committed; edit mode remains open with the editor available.
  assert.ok(h.composerErrors.find((e) => /empty/i.test(e.message || '')));
});

test('commitEdit allows empty draft when image attachments will replay', async () => {
  const h = createControllerHarness({
    buildReplayableImageAttachments: () => [{ id: 'img_1', kind: 'image' }],
  });
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = '';
  const result = await h.controller.commitEdit();
  assert.ok(result);
  assert.equal(h.ipcCalls.length, 0);
  assert.equal(h.promptSends.length, 1);
  // Replay attachments were passed through.
  assert.deepEqual(h.promptSends[0].opts.replayImageAttachments, [{ id: 'img_1', kind: 'image' }]);
});

test('commitEdit shows a warning toast when the original message had text attachments', async () => {
  const h = createControllerHarness({
    hasTextAttachmentMetadata: () => true,
  });
  h.controller.enterEdit('msg_user_1');
  h.state.ui.editingDraftText = 'edited body';
  await h.controller.commitEdit();
  assert.ok(h.toasts.find((t) => /text attachments/i.test(String(t.message || ''))));
});

test('cancelEdit clears state and restores focus to the bubble row', () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  h.controller.cancelEdit();
  assert.equal(h.state.ui.editingMessageId, '');
  assert.deepEqual(h.focusCalls, []);
  const entry = h.doc.querySelector('.chat-entry[data-message-id="msg_user_1"]');
  assert.equal(entry.focusCalls, 1);
  assert.ok(h.logs.find((l) => l.event === 'chat.edit_cancelled'));
});

test('cancelEdit uses temporary programmatic focus without leaving row tabbable', () => {
  const h = createControllerHarness();
  const entry = h.doc.querySelector('.chat-entry[data-message-id="msg_user_1"]');
  assert.equal(entry.getAttribute('tabindex'), null);
  h.controller.enterEdit('msg_user_1');

  h.controller.cancelEdit();

  assert.equal(entry.focusCalls, 1);
  assert.equal(entry.getAttribute('tabindex'), null);
});

test('cancelEdit with skipFocusRestore does not invoke focusEntryAtIndex', () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  h.controller.cancelEdit({ skipFocusRestore: true });
  assert.deepEqual(h.focusCalls, []);
});

test('cancelEdit applies a transient highlight to the restored bubble row', () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');

  h.controller.cancelEdit();

  const entry = h.doc.querySelectorAll('.chat-entry')[0];
  assert.equal(entry.classList.contains('chat-citation-target-highlight'), true);
  h.doc._drainTimers();
  assert.equal(entry.classList.contains('chat-citation-target-highlight'), false);
});

test('cancelEdit mounts a virtualized entry before restoring focus', () => {
  const h = createControllerHarness();
  const entry = h.doc.querySelector('.chat-entry[data-message-id="msg_user_1"]');
  entry.setAttribute('data-virtualized', 'true');
  h.controller.enterEdit('msg_user_1');

  h.controller.cancelEdit();

  assert.deepEqual(h.virtualizerCalls, ['msg_user_1']);
  assert.equal(entry.getAttribute('data-virtualized'), null);
  assert.equal(entry.focusCalls, 1);
});

test('syncFromState preserves selection when re-mirroring a changed draft', () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  const ta = h.doc.querySelector('textarea[data-edit-target-message-id="msg_user_1"]');
  ta.value = 'stale text';
  ta.selectionStart = 2;
  ta.selectionEnd = 5;
  h.state.ui.editingDraftText = 'fresh draft';

  h.controller.syncFromState();

  assert.equal(ta.value, 'fresh draft');
  assert.equal(ta.selectionStart, 2);
  assert.equal(ta.selectionEnd, 5);
});

test('syncFromState finds and wires the textarea when the message id contains a backslash', () => {
  // The buggy lookup only escaped double-quotes, so an unescaped backslash
  // in the id is consumed by CSS-selector parsing and the query misses the
  // real attribute value entirely (findEntryByMessageId's own escaping was
  // already correct — this proves syncFromState now matches it).
  const messageId = 'user_a\\b_1';
  const h = createJsdomEditHarness(messageId);

  const ok = h.controller.enterEdit(messageId);
  assert.equal(ok, true);

  const textarea = h.doc.querySelector('textarea[data-edit-target-message-id]');
  assert.ok(textarea, 'renderAllImpl should have created the textarea');
  assert.equal(textarea.getAttribute('data-edit-target-message-id'), messageId);

  // Listener wiring only happens once syncFromState actually locates the
  // textarea, so a live input event mirroring into draft state proves the
  // lookup succeeded (not just that a textarea exists somewhere in the DOM).
  textarea.value = 'changed via input';
  textarea.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  assert.equal(h.state.ui.editingDraftText, 'changed via input');
});

test('enterEdit does not throw when the message id contains a newline', () => {
  // An unescaped (or quote-only-escaped) newline inside a CSS attribute
  // selector string is invalid and throws a SyntaxError from querySelector.
  // Previously that throw was uncaught: enterEdit calls syncFromState
  // outside of renderAll's try/catch, so the exception propagated straight
  // out of enterEdit after state was already switched into editing mode.
  const messageId = 'user_a\nb_1';
  const h = createJsdomEditHarness(messageId);

  const ok = h.controller.enterEdit(messageId);
  assert.equal(ok, true);
  assert.equal(h.state.ui.editingMessageId, messageId);

  // The try/catch + linear-scan fallback should still locate and wire the
  // textarea despite the selector-engine miss.
  const textarea = h.doc.querySelector('textarea[data-edit-target-message-id]');
  assert.ok(textarea);
  textarea.value = 'edited after newline id';
  textarea.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  assert.equal(h.state.ui.editingDraftText, 'edited after newline id');
});

test('syncFromState still finds the textarea for a normal id (no regression)', () => {
  const messageId = 'user_req_normal_1';
  const h = createJsdomEditHarness(messageId);

  const ok = h.controller.enterEdit(messageId);
  assert.equal(ok, true);

  const textarea = h.doc.querySelector(
    'textarea[data-edit-target-message-id="' + messageId + '"]'
  );
  assert.ok(textarea);
  assert.equal(h.doc.activeElement, textarea, 'enterEdit focuses the textarea via syncFromState');
});

test('textarea keydown wiring: Enter commits, Esc cancels, Shift+Enter passes through', async () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  const ta = h.doc.querySelector('textarea[data-edit-target-message-id="msg_user_1"]');
  assert.ok(ta);

  // Type new value, then fire 'input' to mirror into draft state.
  ta.value = 'changed';
  for (const fn of ta.listeners.input) fn();
  assert.equal(h.state.ui.editingDraftText, 'changed');

  // Shift+Enter: no-op (newline default).
  let prevented = false;
  for (const fn of ta.listeners.keydown) {
    fn({ key: 'Enter', shiftKey: true, preventDefault() { prevented = true; }, stopPropagation() {} });
  }
  assert.equal(prevented, false);
  assert.equal(h.ipcCalls.length, 0);

  // Esc: cancels.
  let escPrevented = false;
  for (const fn of ta.listeners.keydown) {
    fn({ key: 'Escape', preventDefault() { escPrevented = true; }, stopPropagation() {} });
  }
  assert.equal(escPrevented, true);
  assert.equal(h.state.ui.editingMessageId, '');

  // Re-enter, then Enter (bare) → commit.
  h.controller.enterEdit('msg_user_1');
  const ta2 = h.doc.querySelector('textarea[data-edit-target-message-id="msg_user_1"]');
  ta2.value = 'final edit';
  for (const fn of ta2.listeners.input) fn();
  let enterPrevented = false;
  for (const fn of ta2.listeners.keydown) {
    fn({ key: 'Enter', shiftKey: false, ctrlKey: true, preventDefault() { enterPrevented = true; }, stopPropagation() {} });
  }
  assert.equal(enterPrevented, true);
  // commitEdit is async — give the microtask queue a tick.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.ipcCalls.length, 0);
  assert.equal(h.promptSends.length, 1);
});

test('textarea keydown wiring: bare Enter inserts a newline and does not commit', async () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  const ta = h.doc.querySelector('textarea[data-edit-target-message-id="msg_user_1"]');
  let prevented = false;
  for (const fn of ta.listeners.keydown) {
    fn({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, preventDefault() { prevented = true; }, stopPropagation() {} });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, false);
  assert.equal(h.promptSends.length, 0);
  assert.equal(h.state.ui.editingMessageId, 'msg_user_1');
});

test('textarea keydown wiring: IME composition suppresses Enter-commit and Esc-cancel', async () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  const ta = h.doc.querySelector('textarea[data-edit-target-message-id="msg_user_1"]');
  assert.ok(ta);
  ta.value = 'composed';
  for (const fn of ta.listeners.input) fn();

  // Enter while composing (isComposing) → no commit, not prevented.
  let composingEnterPrevented = false;
  for (const fn of ta.listeners.keydown) {
    fn({ key: 'Enter', shiftKey: false, isComposing: true, preventDefault() { composingEnterPrevented = true; }, stopPropagation() {} });
  }
  assert.equal(composingEnterPrevented, false);
  assert.equal(h.ipcCalls.length, 0);
  assert.equal(h.state.ui.editingMessageId, 'msg_user_1', 'edit stays open while composing');

  // Enter with legacy keyCode 229 (IME commit keystroke) → still no commit.
  let legacyEnterPrevented = false;
  for (const fn of ta.listeners.keydown) {
    fn({ key: 'Enter', shiftKey: false, keyCode: 229, preventDefault() { legacyEnterPrevented = true; }, stopPropagation() {} });
  }
  assert.equal(legacyEnterPrevented, false);
  assert.equal(h.ipcCalls.length, 0);

  // Esc while composing → IME keeps it; the edit is NOT cancelled.
  let composingEscPrevented = false;
  for (const fn of ta.listeners.keydown) {
    fn({ key: 'Escape', isComposing: true, preventDefault() { composingEscPrevented = true; }, stopPropagation() {} });
  }
  assert.equal(composingEscPrevented, false);
  assert.equal(h.state.ui.editingMessageId, 'msg_user_1', 'Esc during composition does not cancel the edit');

  // Bare Esc (composition finished) → cancels as normal.
  let escPrevented = false;
  for (const fn of ta.listeners.keydown) {
    fn({ key: 'Escape', preventDefault() { escPrevented = true; }, stopPropagation() {} });
  }
  assert.equal(escPrevented, true);
  assert.equal(h.state.ui.editingMessageId, '');
});

test('getDraft returns the current edit-mode snapshot', () => {
  const h = createControllerHarness();
  assert.deepEqual(h.controller.getDraft(), {
    messageId: '',
    sessionId: '',
    draftText: '',
    originalText: '',
    committing: false,
  });
  h.controller.enterEdit('msg_user_1');
  assert.deepEqual(h.controller.getDraft(), {
    messageId: 'msg_user_1',
    sessionId: 'sess_A',
    draftText: 'original prompt',
    originalText: 'original prompt',
    committing: false,
  });
});

test('isEditing returns true for the row being edited, false otherwise', () => {
  const h = createControllerHarness();
  assert.equal(h.controller.isEditing(), false);
  assert.equal(h.controller.isEditing('msg_user_1'), false);
  h.controller.enterEdit('msg_user_1');
  assert.equal(h.controller.isEditing(), true);
  assert.equal(h.controller.isEditing('msg_user_1'), true);
  assert.equal(h.controller.isEditing('msg_user_2'), false);
});

test('dispose clears edit state and textarea listeners', () => {
  const h = createControllerHarness();
  h.controller.enterEdit('msg_user_1');
  const ta = h.doc.querySelector('textarea[data-edit-target-message-id="msg_user_1"]');
  assert.equal(ta.listeners.input.length, 1);
  assert.equal(ta.listeners.keydown.length, 1);
  h.controller.dispose();
  assert.equal(h.state.ui.editingMessageId, '');
  assert.equal(ta.listeners.input.length, 0);
  assert.equal(ta.listeners.keydown.length, 0);
});

test('edit-utils exposes the stream-busy + empty-content + text-attachment notice constants', () => {
  // The lock-reason string is owned by chat-bubble-action-utils
  // (EDIT_DISABLED_REASON_DURING_EDIT). The three constants below are read
  // by the controller's surfaced toasts.
  assert.equal(typeof EDIT_STREAM_BUSY_REASON, 'string');
  assert.equal(typeof EDIT_EMPTY_CONTENT_REASON, 'string');
  assert.equal(typeof EDIT_TEXT_ATTACHMENT_NOTICE, 'string');
  for (const value of [EDIT_STREAM_BUSY_REASON, EDIT_EMPTY_CONTENT_REASON, EDIT_TEXT_ATTACHMENT_NOTICE]) {
    assert.ok(value.length > 0);
  }
});
