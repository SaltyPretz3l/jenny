'use strict';

/* Shared fixtures for the suggested changes renderer suites (row 35 W2, W3): an
 * entry factory, the list view Electron returns, a fake
 * jennyShell.suggestedChanges bridge and a client over it. */

const { createSuggestedChangesClient } = require('../../renderer/features/renderer-suggested-changes-client');

let clock = 0;
function entry(id, overrides = {}) {
  clock += 1;
  return {
    id,
    revision: 1,
    status: 'to_review',
    path: `src/${id}.py`,
    kind: 'replace',
    old_string: 'a',
    new_string: 'b',
    title: `Title ${id}`,
    what: `What ${id}`,
    why: `Why ${id}`,
    watch_for: '',
    comments: [],
    tool_call_id: `call_${id}`,
    created_at: `2026-10-05T00:00:${String(clock).padStart(2, '0')}Z`,
    diff: { hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
    ...overrides,
  };
}

function listOf(entries, extra = {}) {
  const live = entries.filter((item) => ['to_review', 'out_of_date', 'needs_attention', 'later', 'revising', 'accepted'].includes(item.status));
  return {
    session_id: 's1',
    schema_version: 1,
    pending_count: live.length,
    unsent_comment_count: entries.reduce((sum, item) => sum + item.comments.filter((c) => !c.sent_at).length, 0),
    entries,
    ...extra,
  };
}

/* A bridge over an in-memory list, shaped like window.jennyShell.suggestedChanges. */
function fakeBridge(entries) {
  const calls = [];
  let changed = null;
  const bridge = {
    calls,
    entries,
    emit: () => changed && changed({ session_id: 's1', pending_count: 0 }),
    list: async () => listOf(entries),
    accept: async ({ sessionId, id, revision, force }) => {
      calls.push(force ? ['accept', sessionId, id, revision, 'force'] : ['accept', sessionId, id, revision]);
      const item = entries.find((e) => e.id === id);
      if (bridge.acceptResult) return bridge.acceptResult;
      if (item.revision !== revision) return { ok: false, error: 'revision_changed' };
      item.status = 'applied';
      item.updated_at = '2026-10-05T01:00:00Z';
      return { ok: true, status: 'applied', receipt_saved: true };
    },
    decide: async ({ id, decision, reason }) => {
      calls.push(['decide', id, decision, reason]);
      const item = entries.find((e) => e.id === id);
      if (decision === 'ungroup') item.group_id = null;
      else item.status = { reject: 'rejected', later: 'later', restore: 'to_review' }[decision];
      item.updated_at = '2026-10-05T01:00:00Z';
      return { ok: true };
    },
    comment: async ({ id, text }) => {
      calls.push(['comment', id, text]);
      entries.find((e) => e.id === id).comments.push({ id: `cm${calls.length}`, text, sent_at: null });
      return { ok: true };
    },
    sendComments: async ({ sessionId, undo }) => {
      calls.push(undo ? ['undoSend', sessionId, undo] : ['sendComments', sessionId]);
      return undo ? { ok: true, ids: undo.ids } : { ok: true, message: 'DIGEST', ids: ['b'], sent_at: '2026-10-05T01:00:00.000Z' };
    },
    onChanged: (cb) => { changed = cb; return () => { changed = null; }; },
  };
  return bridge;
}

function makeClient(entries, hostOverrides = {}) {
  const bridge = fakeBridge(entries);
  const sent = [];
  const host = {
    isSessionStreaming: () => false,
    startPromptSend: async (text, options) => { sent.push([text, options]); return { streamId: 'st', sessionId: 's1' }; },
    showToastMessage: () => {},
    ...hostOverrides,
  };
  const timers = [];
  const client = createSuggestedChangesClient({
    getBridge: () => bridge, getHost: () => host, now: () => 50_000,
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clearTimeout: () => {},
  });
  return { bridge, client, host, sent, timers };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Runs `fn` with a run-mode control whose mode can be switched by setRunMode.
async function withRunMode(initial, fn, { canSwitch = true } = {}) {
  const previous = globalThis.rendererRunModeControl;
  let mode = initial;
  const switches = [];
  globalThis.rendererRunModeControl = {
    currentRunMode: () => mode,
    setRunMode: async (next, options) => { switches.push([next, options.sessionId]); if (canSwitch) mode = next; return canSwitch; },
  };
  try { return await fn(switches); } finally { globalThis.rendererRunModeControl = previous; }
}

const click = (dom, node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const press = (dom, node, key, init = {}) => node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, ...init }));

module.exports = { click, entry, fakeBridge, listOf, makeClient, press, settle, withRunMode };
