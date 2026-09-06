'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const conversationFormatUtils = require('../renderer/shared/conversation-format-utils');
const {
  createBulkActionsController,
  sanitizeFilenameSlug,
  byteLength,
  pickSelectedMessages,
  findEarliestSelectedMessage,
  MAX_RECOMMENDED_EXPORT_BYTES,
  MAX_HARD_EXPORT_BYTES,
} = require('../renderer/chat/renderer-chat-bulk-actions-utils');

function makeState() {
  return {
    ui: {
      selectionMode: true,
      selectedMessageIdsBySession: new Map([['sess-1', new Set(['m-1', 'm-3'])]]),
      selectionAnchorBySession: new Map(),
      chatTimelineRowModelMetaBySession: new Map([['sess-1', { ok: true }]]),
      chatTimelineRowModelBySession: new Map([['sess-1', { foo: 1 }]]),
    },
    currentSessionId: 'sess-1',
    turnEventsBySession: new Map([['sess-1', [{ kind: 'assistant_text' }]]]),
    messagesBySession: new Map([['sess-1', [{ id: 'm-1' }]]]),
  };
}

function makeSelectionController(state) {
  return {
    isSelectMode: () => state.ui.selectionMode,
    getSelectedMessageIds: () => Array.from(
      (state.ui.selectedMessageIdsBySession.get(state.currentSessionId) || new Set()).values()
    ),
    exitSelectMode: () => {
      state.ui.selectionMode = false;
      state.ui.selectedMessageIdsBySession.clear();
    },
    syncActionBar: () => {},
  };
}

function makeDeps(overrides = {}) {
  const state = overrides.state || makeState();
  const selectionController = overrides.selectionController || makeSelectionController(state);
  const messages = overrides.messages || [
    { id: 'm-1', role: 'user', content: 'first', timestamp: '2026-05-12T10:00:00Z' },
    { id: 'm-2', role: 'assistant', content: 'reply', timestamp: '2026-05-12T10:01:00Z' },
    { id: 'm-3', role: 'user', content: 'third', timestamp: '2026-05-12T10:02:00Z' },
  ];
  const turnEvents = overrides.turnEvents || [
    { kind: 'user_text', primary_message_id: 'm-1' },
    { kind: 'assistant_text', primary_message_id: 'm-2' },
    { kind: 'user_text', primary_message_id: 'm-3' },
  ];
  const meta = overrides.meta || { id: 'sess-1', title: 'My Test', created_at: '2026-05-01T00:00:00Z' };
  const clipboardCalls = [];
  const saveFileCalls = [];
  const exportSessionCalls = [];
  const editTruncateCalls = [];
  const toastCalls = [];
  const logCalls = [];
  const renderCalls = [];
  const cacheClearCalls = [];

  const jennyShellClipboard = overrides.jennyShellClipboard || {
    writeText: async (text) => { clipboardCalls.push(text); return { ok: true }; },
  };
  const jennyShellDialog = overrides.jennyShellDialog || {
    saveFile: async (payload) => {
      saveFileCalls.push(payload);
      return { canceled: false, path: 'C:\\fake\\' + payload.defaultName, bytesWritten: payload.content.length };
    },
  };
  const jennyShellSessions = overrides.jennyShellSessions || {
    exportSession: async (sessionId) => {
      exportSessionCalls.push(sessionId);
      return JSON.stringify({ format: 'jenny-session-export', sessionId }, null, 2);
    },
    editAndTruncate: async (sessionId, messageId, patch) => {
      editTruncateCalls.push({ sessionId, messageId, patch });
      return { ok: true, sessionId };
    },
  };
  const confirmDelete = overrides.confirmDelete || (async () => true);

  const controller = createBulkActionsController({
    state,
    jennyShellSessions,
    jennyShellDialog,
    jennyShellClipboard,
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => messages,
    getCurrentSessionTurnEvents: () => turnEvents,
    getCurrentSessionMeta: () => meta,
    selectionController,
    conversationFormatUtils,
    renderAll: () => renderCalls.push(true),
    appendClientLog: (level, name, payload) => logCalls.push({ level, name, payload }),
    showToastMessage: (message, options) => toastCalls.push({ message, options }),
    clearProjectionContextCacheForSession: (sid) => cacheClearCalls.push(sid),
    confirmDelete,
  });

  return {
    controller,
    state,
    selectionController,
    messages,
    turnEvents,
    meta,
    clipboardCalls,
    saveFileCalls,
    exportSessionCalls,
    editTruncateCalls,
    toastCalls,
    logCalls,
    renderCalls,
    cacheClearCalls,
  };
}

/* ── Helpers ── */

test('sanitizeFilenameSlug lowercases, replaces non-alnum, trims to 60 chars', () => {
  assert.equal(sanitizeFilenameSlug('My Conversation!'), 'my-conversation');
  assert.equal(sanitizeFilenameSlug(''), 'untitled-session');
  assert.equal(sanitizeFilenameSlug('___'), 'untitled-session');
  const long = sanitizeFilenameSlug('a'.repeat(200));
  assert.equal(long.length, 60);
});

test('byteLength matches TextEncoder for ASCII and multi-byte text', () => {
  assert.equal(byteLength(''), 0);
  assert.equal(byteLength('hello'), 5);
  assert.equal(byteLength('café'), 5);
  // Sanity-check the threshold constants.
  assert.equal(MAX_RECOMMENDED_EXPORT_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_HARD_EXPORT_BYTES, 250 * 1024 * 1024);
});

test('pickSelectedMessages preserves message order from the original array', () => {
  const messages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const picked = pickSelectedMessages(messages, ['c', 'a']);
  assert.deepEqual(picked.map((m) => m.id), ['a', 'c']);
});

test('findEarliestSelectedMessage returns the lowest-index selected message', () => {
  const messages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const earliest = findEarliestSelectedMessage(messages, ['c', 'b']);
  assert.equal(earliest.id, 'b');
});

/* ── copyAsMarkdown / copyAsPlainText ── */

test('copyAsMarkdown writes markdown of the selected messages to clipboard', async () => {
  const ctx = makeDeps();
  const ok = await ctx.controller.copyAsMarkdown();
  assert.equal(ok, true);
  assert.equal(ctx.clipboardCalls.length, 1);
  // m-1 (user) and m-3 (user) — both should appear, m-2 should not.
  const written = ctx.clipboardCalls[0];
  assert.ok(written.includes('first'));
  assert.ok(written.includes('third'));
  assert.ok(!written.includes('reply'));
  assert.ok(ctx.toastCalls.some((t) => t.message.includes('Copied 2 messages as Markdown')));
});

test('copyAsPlainText writes plain text of the selected messages', async () => {
  const ctx = makeDeps();
  const ok = await ctx.controller.copyAsPlainText();
  assert.equal(ok, true);
  const written = ctx.clipboardCalls[0];
  assert.ok(written.includes('[You'));
  assert.ok(!written.includes('## You'));
});

test('copy operations no-op when no messages are selected', async () => {
  const ctx = makeDeps();
  ctx.state.ui.selectedMessageIdsBySession = new Map([['sess-1', new Set()]]);
  const okMd = await ctx.controller.copyAsMarkdown();
  const okPlain = await ctx.controller.copyAsPlainText();
  assert.equal(okMd, false);
  assert.equal(okPlain, false);
  assert.equal(ctx.clipboardCalls.length, 0);
});

/* ── exportMarkdown / exportPlainText / exportTurnEventJson ── */

test('exportMarkdown calls saveFile with the markdown-format payload and a sensible default name', async () => {
  const ctx = makeDeps();
  const result = await ctx.controller.exportMarkdown();
  assert.ok(result);
  assert.equal(ctx.saveFileCalls.length, 1);
  const payload = ctx.saveFileCalls[0];
  assert.equal(payload.format, 'markdown');
  assert.match(payload.defaultName, /^jenny-my-test-\d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(payload.content.includes('## You'));
});

test('exportPlainText calls saveFile with the plain-format payload', async () => {
  const ctx = makeDeps();
  const result = await ctx.controller.exportPlainText();
  assert.ok(result);
  const payload = ctx.saveFileCalls[0];
  assert.equal(payload.format, 'plain');
  assert.match(payload.defaultName, /\.txt$/);
});

test('exportTurnEventJson scopes events to the selected message ids', async () => {
  const ctx = makeDeps();
  const result = await ctx.controller.exportTurnEventJson();
  assert.ok(result);
  const payload = ctx.saveFileCalls[0];
  assert.equal(payload.format, 'json');
  const parsed = JSON.parse(payload.content);
  assert.equal(parsed.scope, 'selected');
  assert.deepEqual(parsed.messageIdScope.sort(), ['m-1', 'm-3']);
  // m-2's turn event must not appear in the export.
  for (const event of parsed.turnEvents) {
    const id = event.primary_message_id || (event.payload && event.payload.message_id) || '';
    assert.notEqual(id, 'm-2');
  }
});

test('saveFile cancellation flows through without firing a success toast', async () => {
  const ctx = makeDeps({
    jennyShellDialog: { saveFile: async () => ({ canceled: true, path: '', bytesWritten: 0 }) },
  });
  await ctx.controller.exportMarkdown();
  assert.ok(!ctx.toastCalls.some((t) => /^Saved to/.test(t.message)));
  assert.ok(ctx.logCalls.some((entry) => entry.name === 'chat.bulk_export_canceled'));
});

/* ── exportSessionJsonPortable ── */

test('exportSessionJsonPortable invokes sessions.exportSession then saves whole-session content', async () => {
  const ctx = makeDeps();
  const result = await ctx.controller.exportSessionJsonPortable();
  assert.ok(result);
  assert.deepEqual(ctx.exportSessionCalls, ['sess-1']);
  const payload = ctx.saveFileCalls[0];
  assert.equal(payload.format, 'session-json');
  assert.ok(payload.content.includes('jenny-session-export'));
  // Should also have shown the "exports whole session" info toast since
  // a subset is selected.
  assert.ok(ctx.toastCalls.some((t) => /whole session/.test(t.message)));
});

test('exportSessionJsonPortable bubbles up bridge failure as a danger toast', async () => {
  const ctx = makeDeps({
    jennyShellSessions: { exportSession: async () => { throw new Error('boom'); } },
  });
  const result = await ctx.controller.exportSessionJsonPortable();
  assert.equal(result, null);
  assert.ok(ctx.toastCalls.some((t) => t.options && t.options.tone === 'danger'));
});

/* ── deleteFromHere ── */

test('deleteFromHere calls editAndTruncate with the earliest selected id and no content patch', async () => {
  const ctx = makeDeps();
  await ctx.controller.deleteFromHere();
  assert.equal(ctx.editTruncateCalls.length, 1);
  assert.deepEqual(ctx.editTruncateCalls[0], {
    sessionId: 'sess-1',
    messageId: 'm-1',
    patch: {},
  });
});

test('deleteFromHere invalidates caches and exits selection mode on success', async () => {
  const ctx = makeDeps();
  await ctx.controller.deleteFromHere();
  assert.equal(ctx.state.turnEventsBySession.has('sess-1'), false);
  assert.equal(ctx.state.messagesBySession.has('sess-1'), false);
  assert.deepEqual(ctx.cacheClearCalls, ['sess-1']);
  assert.equal(ctx.state.ui.chatTimelineRowModelMetaBySession.has('sess-1'), false);
  assert.equal(ctx.state.ui.chatTimelineRowModelBySession.has('sess-1'), false);
  assert.equal(ctx.state.ui.selectionMode, false);
});

test('deleteFromHere no-ops when the user dismisses the confirmation', async () => {
  const ctx = makeDeps({
    confirmDelete: async () => false,
  });
  const result = await ctx.controller.deleteFromHere();
  assert.equal(result, null);
  assert.equal(ctx.editTruncateCalls.length, 0);
  // Selection state should be preserved.
  assert.equal(ctx.state.ui.selectionMode, true);
});

test('deleteFromHere confirmation names total trailing history loss', async () => {
  const prompts = [];
  const ctx = makeDeps({
    confirmDelete: async (prompt) => {
      prompts.push(prompt);
      return false;
    },
  });

  await ctx.controller.deleteFromHere();

  assert.equal(ctx.editTruncateCalls.length, 0);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /3 messages from the earliest selected message onward/i);
  assert.match(prompts[0], /2 selected/i);
  assert.match(prompts[0], /including unselected trailing messages/i);
});

test('deleteFromHere marks a bulk truncate transaction while IPC is pending', async () => {
  let resolveTruncate;
  const state = makeState();
  const ctx = makeDeps({
    state,
    jennyShellSessions: {
      exportSession: async () => '',
      editAndTruncate: async () => new Promise((resolve) => {
        resolveTruncate = resolve;
      }),
    },
  });

  const pending = ctx.controller.deleteFromHere();
  for (let i = 0; i < 5 && typeof resolveTruncate !== 'function'; i += 1) {
    await Promise.resolve();
  }

  assert.equal(ctx.state.ui.bulkTruncateCommitting, true);

  resolveTruncate({ ok: true, sessionId: 'sess-1' });
  await pending;

  assert.equal(ctx.state.ui.bulkTruncateCommitting, false);
});

test('deleteFromHere claims single-flight before confirmation resolves', async () => {
  let resolveConfirm;
  let truncateCalls = 0;
  const ctx = makeDeps({
    confirmDelete: () => new Promise((resolve) => { resolveConfirm = resolve; }),
    jennyShellSessions: {
      exportSession: async () => '',
      editAndTruncate: async () => { truncateCalls += 1; return { id: 'sess-1' }; },
    },
  });
  const first = ctx.controller.deleteFromHere();
  const second = ctx.controller.deleteFromHere();
  assert.equal(first, second);
  assert.equal(ctx.state.ui.bulkTruncateCommitting, true);
  await Promise.resolve();
  resolveConfirm(true);
  await first;
  assert.equal(truncateCalls, 1);
});

test('deleteFromHere surfaces an IPC failure as a danger toast and preserves selection', async () => {
  const ctx = makeDeps({
    jennyShellSessions: {
      exportSession: async () => '',
      editAndTruncate: async () => { throw new Error('disk full'); },
    },
  });
  await ctx.controller.deleteFromHere();
  assert.ok(ctx.toastCalls.some((t) => t.options && t.options.tone === 'danger'));
  // Selection should still be active.
  assert.equal(ctx.state.ui.selectionMode, true);
});

test('deleteFromHere requires a structured persistence result and keeps recovery state on refusal', async () => {
  const ctx = makeDeps({
    jennyShellSessions: {
      exportSession: async () => '',
      editAndTruncate: async () => true,
    },
  });
  assert.equal(await ctx.controller.deleteFromHere(), null);
  assert.equal(ctx.state.ui.selectionMode, true);
  assert.equal(ctx.cacheClearCalls.length, 0);
  assert.ok(ctx.toastCalls.some((entry) => entry.options?.tone === 'danger'));
});

/* ── Threshold guards ── */

test('threshold guard hard-fails when content exceeds 250 MB', async () => {
  const big = 'x'.repeat((MAX_HARD_EXPORT_BYTES + 1024));
  const ctx = makeDeps({
    jennyShellClipboard: { writeText: async (text) => { /* would write */ void text; return { ok: true }; } },
  });
  // Force the builder to emit huge content by stubbing conversationFormatUtils.
  const stubFormat = {
    buildMarkdown: () => big,
    buildPlainText: () => 'short',
    buildJson: () => '{}',
  };
  const stubbed = createBulkActionsController({
    state: ctx.state,
    jennyShellSessions: { exportSession: async () => '', editAndTruncate: async () => ({}) },
    jennyShellDialog: { saveFile: async () => ({ canceled: false, path: 'x', bytesWritten: 0 }) },
    jennyShellClipboard: ctx.controller && undefined || { writeText: async () => null },
    getCurrentSessionId: () => 'sess-1',
    getCurrentSessionMessages: () => ctx.messages,
    getCurrentSessionTurnEvents: () => [],
    getCurrentSessionMeta: () => ctx.meta,
    selectionController: ctx.selectionController,
    conversationFormatUtils: stubFormat,
    showToastMessage: (message, options) => ctx.toastCalls.push({ message, options }),
    appendClientLog: () => {},
    renderAll: () => {},
    clearProjectionContextCacheForSession: () => {},
  });
  const ok = await stubbed.copyAsMarkdown();
  assert.equal(ok, false);
  assert.ok(ctx.toastCalls.some((t) => /exceeds 250 MB/.test(t.message)));
});

test('threshold guard emits a warning toast over 5 MB but proceeds', async () => {
  const ctx = makeDeps();
  const stubFormat = {
    buildMarkdown: () => 'x'.repeat(MAX_RECOMMENDED_EXPORT_BYTES + 1024),
    buildPlainText: () => '',
    buildJson: () => '{}',
  };
  const stubbed = createBulkActionsController({
    state: ctx.state,
    jennyShellSessions: { exportSession: async () => '', editAndTruncate: async () => ({}) },
    jennyShellDialog: { saveFile: async () => ({ canceled: false, path: 'x', bytesWritten: 0 }) },
    jennyShellClipboard: { writeText: async () => null },
    getCurrentSessionId: () => 'sess-1',
    getCurrentSessionMessages: () => ctx.messages,
    getCurrentSessionTurnEvents: () => [],
    getCurrentSessionMeta: () => ctx.meta,
    selectionController: ctx.selectionController,
    conversationFormatUtils: stubFormat,
    showToastMessage: (message, options) => ctx.toastCalls.push({ message, options }),
    appendClientLog: () => {},
    renderAll: () => {},
    clearProjectionContextCacheForSession: () => {},
  });
  await stubbed.copyAsMarkdown();
  assert.ok(ctx.toastCalls.some((t) => /larger than 5 MB/.test(t.message)));
});

/* ── Dispose / surface ── */

test('createBulkActionsController throws when state is missing', () => {
  assert.throws(
    () => createBulkActionsController({}),
    /requires `state`/,
  );
});

test('controller exposes the expected verbs', () => {
  const ctx = makeDeps();
  assert.equal(typeof ctx.controller.copyAsMarkdown, 'function');
  assert.equal(typeof ctx.controller.copyAsPlainText, 'function');
  assert.equal(typeof ctx.controller.exportMarkdown, 'function');
  assert.equal(typeof ctx.controller.exportPlainText, 'function');
  assert.equal(typeof ctx.controller.exportTurnEventJson, 'function');
  assert.equal(typeof ctx.controller.exportSessionJsonPortable, 'function');
  assert.equal(typeof ctx.controller.deleteFromHere, 'function');
  assert.equal(typeof ctx.controller.dispose, 'function');
});
