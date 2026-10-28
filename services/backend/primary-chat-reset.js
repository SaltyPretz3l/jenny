'use strict';

// Row 76 S6: Reset and Forget for the primary Jenny chat. Reset clears the transcript in
// place under the session's idle lease (the row, role, title, pin, project,
// `session_incarnation`, standing permissions and message grants all survive); Forget is
// Reset plus deletion of the memories that originated in the chat. Functions over the
// BackendService instance (`service`), like ./backend-session-truncate.
//
// Runtime work is cancelled and awaited before the lease is taken: a paused turn proves its
// cleanup only while the session actor is idle, and the lease's own pending mutation keeps
// it busy (live 2026-10-27: a turn a restart paused failed every reset). A live turn refuses
// `session_busy` first, so the cancel never stops a reply.
// Order inside the lease: cancel runtime work admitted since -> copy (keep_copy) -> discard mail ->
// dismiss proposals -> clear the transcript (+ mirror, journal, assets, todo list, payloads,
// artifacts, usage) -> purge the conversation index -> forget -> memory opt-out -> history.
// The idle lease is checked by the actor before the commit starts and again here after the
// cancel wait and right before the clear (a turn can start while the reset awaits; then it
// refuses `session_busy`). Steps before the mail discard abort cleanly; the discard and the
// proposal dismiss are durable writes of their own and stay when the clear is then refused
// (a retry is safe); every step after the clear is best effort and reports a reason token in
// `limits`. `copy_path` is profile-relative (`exports/<name>`), never an absolute path.
//
// Never: delete the session, touch the sequence counters / incarnation / role / coordination
// fields, or call purgeSessionMemories / `memory.purge_session` (its per-session marker
// would permanently stop memory for the chat). Logs carry ids, counts and reason tokens
// only: never titles, message bodies or the copy's path.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { collectAssetPaths } = require('../attachment-service');
const { findPrimarySessions, primaryChatEnabled } = require('./primary-session');
const { createSessionMailStore } = require('./session-mail-store');
const { createChatProposalStore } = require('./chat-proposal-store');
const { exportSession } = require('./session-export-import');
const { purgeConversationIndex } = require('./conversation-index-pump');
const { purgeSessionTodoList } = require('./session-todo-list-purge');
const {
  collectDeletedSessionPayloadKeys,
  collectRemainingReferencedPayloadKeys,
} = require('./backend-session-reference-scan');
const {
  deleteApprovedMemory,
  deletePendingMemory,
  listApprovedMemories,
  listPendingMemories,
} = require('./backend-memory');

const SCHEMA_VERSION = 1;
const MUTATION_SITE = 'primary_chat.reset';
const RUNTIME_CANCEL_TIMEOUT_MS = 5_000;
const MAX_FORGET_MEMORIES = 500;
const MAX_DISCARD_IDS = 100; // chat-messaging-contract MAX_MESSAGE_IDS
const DISCARDABLE_MAIL = new Set(['queued', 'excluded_by_user']);

const refuse = (reason) => ({ ok: false, reason });

function reasonToken(error, fallback = 'error') {
  return String(error?.code || error?.name || fallback).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || fallback;
}

function controlsDisabled(service) {
  return service?.featureFlags?.primary_chat_controls === false || !primaryChatEnabled(service?.featureFlags);
}

function primaryId(service) {
  const summaries = service?.sessionStore?.listSessions?.();
  return findPrimarySessions(summaries)[0]?.id || '';
}

function emit(service, level, event, details) {
  try { service?._emitServiceLog?.(level, event, details); } catch (_error) { /* logging never throws */ }
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// The copy the person asked for, written before anything is cleared. Returns its path.
function writeCopy(service, sessionId, now) {
  const json = exportSession(service.sessionStore, sessionId, service.attachmentAssetStore || null);
  if (typeof json !== 'string' || !json) throw new Error('export_unavailable');
  const dir = path.join(service.options.userDataPath, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const base = `jenny-reset-${stamp(now())}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const file = path.join(dir, `${base}${attempt ? `-${attempt + 1}` : ''}.json`);
    try {
      fs.writeFileSync(file, json, { encoding: 'utf8', flag: 'wx' });
      return path.relative(service.options.userDataPath, file).split(path.sep).join('/');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('copy_name_exhausted');
}

async function discardMail(service, sessionId) {
  const read = createSessionMailStore(service.sessionStore).read(sessionId);
  if (!read.ok) throw Object.assign(new Error('mail_unreadable'), { code: read.reason || 'mail_unreadable' });
  const inbox = read.mail.inbox;
  const ids = inbox.filter((record) => DISCARDABLE_MAIL.has(record.context?.state)).map((record) => record.envelope.message_id);
  const kept = inbox.length - ids.length;
  if (!ids.length) return { discarded: 0, kept };
  if (typeof service.chatMessages?.discard !== 'function') {
    throw Object.assign(new Error('mail_discard_unavailable'), { code: 'mail_discard_unavailable' });
  }
  for (let start = 0; start < ids.length; start += MAX_DISCARD_IDS) {
    const result = await service.chatMessages.discard({
      schema_version: SCHEMA_VERSION, session_id: sessionId, message_ids: ids.slice(start, start + MAX_DISCARD_IDS),
    });
    if (result?.ok !== true) throw Object.assign(new Error('mail_discard_refused'), { code: String(result?.reason || 'mail_discard_refused') });
  }
  return { discarded: ids.length, kept };
}

async function dismissProposals(service, sessionId) {
  const read = createChatProposalStore(service.sessionStore).read(sessionId);
  const pending = read.ok ? read.records.filter((record) => record.kind === 'session' && record.decision_state === 'pending') : [];
  let dismissed = 0;
  let kept = 0;
  for (const record of pending) {
    try {
      const result = await service.chatProposals?.decide?.({
        schema_version: SCHEMA_VERSION,
        session_id: sessionId,
        proposal_id: record.proposal_id,
        expected_revision: record.revision,
        decision_id: randomUUID(),
        choice: 'dismiss',
      });
      if (result?.ok === true) dismissed += 1;
      else kept += 1;
    } catch (_error) {
      kept += 1;
    }
  }
  return { dismissed, kept };
}

function assetPathsOf(service, sessionId) {
  const paths = [];
  const readers = [
    () => service.sessionStore?.getSessionMessages?.(sessionId),
    () => service.shadowStore?.getMessages?.(sessionId),
  ];
  for (const read of readers) {
    for (const message of read() || []) paths.push(...collectAssetPaths(message?.attachments));
  }
  return [...new Set(paths)];
}

// Everything that clears the transcript and its derived stores. Returns the limit tokens
// of the best-effort steps that failed; `null` when the canonical clear itself was refused.
async function clearTranscript(service, sessionId, ctx) {
  const store = service.sessionStore;
  let assetsBefore = [];
  let assetsScanFailed = false;
  if (service.attachmentAssetStore) {
    try { assetsBefore = assetPathsOf(service, sessionId); } catch (_error) { assetsScanFailed = true; }
  }
  let payloadsBefore = [];
  let payloadsScanFailed = false;
  if (service.ipcPayloadStore) {
    try { payloadsBefore = [...collectDeletedSessionPayloadKeys(service, sessionId)]; } catch (_error) { payloadsScanFailed = true; }
  }

  if (!store.replaceMessages(sessionId, [])) return false;
  await ctx.step('session_state', 'session_state', () => {
    const patched = store.updateSession(sessionId, {
      turn_events: [],
      active_turn: null,
      pending_question_batch: null,
      pending_plan_proposal: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      failure_retry_reasoning_snapshots: {},
      composer_draft: '',
      compaction_snapshot: null,
      context_usage: null,
    });
    if (!patched) throw Object.assign(new Error('refused'), { code: 'update_refused' });
  });

  const shadow = service.shadowStore;
  if (shadow?.upsertSession && !(typeof shadow.getSession === 'function' && !shadow.getSession(sessionId))) {
    let reason = null;
    try {
      const mirrored = shadow.upsertSession(sessionId, {
        messages: [], message_count: 0, last_message_preview: '', turn_events: [], active_turn: null,
        pending_question_batch: null, pending_plan_proposal: null,
      }, { allowCreate: false });
      if (!mirrored) reason = 'mirror_refused';
    } catch (error) {
      reason = reasonToken(error, 'mirror_failed');
    }
    if (reason) {
      emit(service, 'WARN', 'primary_chat.reset_replication_lag', { sessionId, reason });
      ctx.limit('shadow_mirror');
    }
  }

  await ctx.step('store_flush', 'store_flush', () => {
    if (typeof store.flushSession === 'function' && store.flushSession(sessionId) !== true) {
      throw Object.assign(new Error('flush_refused'), { code: 'flush_refused' });
    }
  });

  if (typeof service.turnEventJournal?.purgeTurnsAfter === 'function') {
    await ctx.step('journal', 'journal', () => {
      const result = service.turnEventJournal.purgeTurnsAfter(sessionId, new Set());
      service.turnEventJournal.flush?.();
      if (result && result.ok === false) throw Object.assign(new Error('journal'), { code: result.reason || 'journal_purge_refused' });
    });
  }

  if (assetsScanFailed) ctx.fail('attachments', 'attachments', 'candidate_scan_failed');
  else if (service.attachmentAssetStore && assetsBefore.length) {
    await ctx.step('attachments', 'attachments', async () => {
      const pruned = await service.attachmentAssetStore.pruneAssetPaths(assetsBefore, assetPathsOf(service, sessionId));
      if (pruned?.failedCount > 0) throw Object.assign(new Error('prune'), { code: 'prune_incomplete' });
    });
  }

  if (service.options?.userDataPath) {
    await ctx.step('todo_list', 'todo_list', () => purgeSessionTodoList(service.options.userDataPath, sessionId));
  }

  if (payloadsScanFailed) ctx.fail('ipc_payloads', 'ipc_payloads', 'candidate_scan_failed');
  else if (service.ipcPayloadStore && payloadsBefore.length) {
    await ctx.step('ipc_payloads', 'ipc_payloads', () => service.ipcPayloadStore.prunePayloadPaths(
      payloadsBefore, collectRemainingReferencedPayloadKeys(service, sessionId), { graceMs: 0 }
    ));
  }

  if (service.artifactService) {
    await ctx.step('artifacts', 'artifacts', () => service.artifactService.deleteSessionArtifacts(sessionId));
  }

  if (typeof service.usageHistory?.resetSession === 'function') {
    await ctx.step('usage', 'usage', async () => {
      const result = await service.usageHistory.resetSession(sessionId);
      if (result?.ok !== true) throw Object.assign(new Error('usage'), { code: 'usage_reset_failed' });
    });
  }
  return true;
}

// The primary's approved memories (origin or chat-scope) and its pending candidates.
async function primaryMemories(service, sessionId) {
  const [approved, pending] = await Promise.all([listApprovedMemories(service), listPendingMemories(service)]);
  return {
    memories: (approved?.memories || [])
      .filter((memory) => memory && (memory.session_id === sessionId || memory.scope_session_id === sessionId))
      .slice(0, MAX_FORGET_MEMORIES),
    candidates: (pending?.candidates || [])
      .filter((candidate) => candidate && candidate.session_id === sessionId)
      .slice(0, MAX_FORGET_MEMORIES),
  };
}

async function forgetMemories(service, sessionId, ctx) {
  const forgotten = { memories: 0, pending: 0 };
  let found = null;
  await ctx.step('memory', 'memory', async () => { found = await primaryMemories(service, sessionId); });
  if (!found) return forgotten;
  for (const memory of found.memories) {
    await ctx.step('memory', 'memory', async () => {
      const result = await deleteApprovedMemory(service, memory.id, memory.project_id);
      if (result?.deleted !== true) throw Object.assign(new Error('not_deleted'), { code: 'memory_not_deleted' });
      forgotten.memories += 1;
    });
  }
  for (const candidate of found.candidates) {
    await ctx.step('memory_pending', 'memory', async () => {
      const result = await deletePendingMemory(service, sessionId, candidate.content_fingerprint, candidate.project_id);
      if (result?.deleted !== true) throw Object.assign(new Error('not_deleted'), { code: 'pending_not_deleted' });
      forgotten.pending += 1;
    });
  }
  return forgotten;
}

async function setMemoryOptOut(service, sessionId) {
  const current = service.sessionStore.getSession(sessionId)?.context_preferences || {};
  const write = typeof service.setSessionPreferences === 'function'
    ? service.setSessionPreferences(sessionId, { context_preferences: { ...current, memory_opt_out: true } })
    : null;
  if (!(await write)) throw Object.assign(new Error('opt_out'), { code: 'preferences_unavailable' });
}

function abortStep(service, sessionId, step, reason, error) {
  emit(service, 'WARN', 'primary_chat.reset_step_failed', { sessionId, step, reason: reasonToken(error, reason) });
  return refuse(reason);
}

// Cancels the chat's runtime work and waits for it. Returns a refusal, or null once quiet.
async function quiesceRuntime(service, sessionId) {
  if (!service.sessionRuntime?.cancelSessionAndWait) return null;
  try {
    const quiet = await service.sessionRuntime.cancelSessionAndWait(sessionId, {
      reason: 'primary_chat_reset', timeoutMs: RUNTIME_CANCEL_TIMEOUT_MS,
    });
    if (quiet?.ok === true) return null;
    return abortStep(service, sessionId, 'runtime', 'unavailable', { code: quiet?.reason || 'runtime_not_quiescent' });
  } catch (error) {
    return abortStep(service, sessionId, 'runtime', 'unavailable', error);
  }
}

function createContext(service, sessionId) {
  const limits = [];
  const limit = (token) => { if (!limits.includes(token)) limits.push(token); };
  const fail = (step, token, reason) => {
    limit(token);
    emit(service, 'WARN', 'primary_chat.reset_step_failed', { sessionId, step, reason: String(reason).slice(0, 64) });
  };
  const step = async (name, token, work) => {
    try { await work(); } catch (error) { fail(name, token, reasonToken(error)); }
  };
  return { limits, limit, fail, step };
}

async function runReset(service, sessionId, { forget, keepCopy, memoryOptOut, now }) {
  const store = service.sessionStore;
  const before = store.getSession(sessionId);
  if (!before) return refuse('not_found');
  const ctx = createContext(service, sessionId);
  const abort = (step, reason, error) => abortStep(service, sessionId, step, reason, error);

  const busy = () => abort('lease', 'session_busy', { code: 'turn_started' });
  // Work queued since the first wait has no attempt yet and cancels without a cleanup proof.
  const runtimeRefusal = await quiesceRuntime(service, sessionId);
  if (runtimeRefusal) return runtimeRefusal;

  if (store.getActiveTurn?.(sessionId)) return busy();
  let copyPath = null;
  if (keepCopy) {
    try { copyPath = writeCopy(service, sessionId, now); } catch (error) { return abort('copy', 'copy_failed', error); }
  }

  let mail;
  try { mail = await discardMail(service, sessionId); } catch (error) { return abort('mail', 'unavailable', error); }
  const proposals = await dismissProposals(service, sessionId);

  if (store.getActiveTurn?.(sessionId)) return busy();
  let cleared;
  try { cleared = await clearTranscript(service, sessionId, ctx); } catch (error) { return abort('transcript', 'unavailable', error); }
  if (!cleared) return abort('transcript', 'unavailable', { code: 'replace_refused' });

  await purgeConversationIndex(service, sessionId);
  const forgotten = forget ? await forgetMemories(service, sessionId, ctx) : null;
  if (memoryOptOut) await ctx.step('memory_opt_out', 'memory_opt_out', () => setMemoryOptOut(service, sessionId));
  await ctx.step('history', 'history', async () => {
    if ((await service.primaryChatControls?.recordHistory?.(forget ? 'forgot' : 'reset')) === false) {
      throw Object.assign(new Error('history'), { code: 'history_refused' });
    }
  });

  const messages = Array.isArray(before.messages) ? before.messages.length : Number(before.message_count) || 0;
  emit(service, 'INFO', 'primary_chat.reset', {
    sessionId,
    forget,
    messages,
    mailDiscarded: mail.discarded,
    mailKept: mail.kept,
    proposalsDismissed: proposals.dismissed,
    proposalsKept: proposals.kept,
    copy: copyPath !== null,
    memories: forgotten?.memories ?? 0,
    pending: forgotten?.pending ?? 0,
    limits: ctx.limits,
  });
  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    cleared: { messages, mail, proposals },
    copy_path: copyPath,
    forgotten,
    limits: ctx.limits,
  };
}

// resetPrimaryChat(service, { forget, keep_copy, memory_opt_out, now }) -> { ok: true, ... } | { ok: false, reason }.
async function resetPrimaryChat(service, {
  forget = false, keep_copy: keepCopy = true, memory_opt_out: memoryOptOut = false, now = () => new Date(),
} = {}) {
  if (controlsDisabled(service)) return refuse('disabled');
  const sessionId = primaryId(service);
  if (!sessionId) return refuse('not_found');
  if (typeof service.sessionTurnActors?.runSessionMutation !== 'function'
    || typeof service.sessionStore?.replaceMessages !== 'function'
    || !service.options?.userDataPath) return refuse('unavailable');
  if (service.sessionStore.getActiveTurn?.(sessionId)
    || service.sessionTurnActors.hasActiveLifecycle?.(sessionId) === true) return refuse('session_busy');
  const runtimeRefusal = await quiesceRuntime(service, sessionId);
  if (runtimeRefusal) return runtimeRefusal;
  try {
    return await service.sessionTurnActors.runSessionMutation(
      sessionId,
      MUTATION_SITE,
      () => null,
      () => runReset(service, sessionId, {
        forget: forget === true, keepCopy: keepCopy !== false, memoryOptOut: memoryOptOut === true, now,
      }),
      { requireIdle: true }
    );
  } catch (error) {
    if (error?.code === 'session_busy') return refuse('session_busy');
    emit(service, 'WARN', 'primary_chat.reset_step_failed', { sessionId, step: 'reset', reason: reasonToken(error) });
    return refuse('unavailable');
  }
}

// What Forget would delete, for the confirm dialog: the same filters and cap as the run.
async function forgetPreview(service) {
  if (controlsDisabled(service)) return refuse('disabled');
  const sessionId = primaryId(service);
  if (!sessionId) return refuse('not_found');
  try {
    const { memories, candidates } = await primaryMemories(service, sessionId);
    return { ok: true, schema_version: SCHEMA_VERSION, memories: memories.length, pending: candidates.length };
  } catch (error) {
    emit(service, 'WARN', 'primary_chat.reset_step_failed', { sessionId, step: 'preview', reason: reasonToken(error) });
    return refuse('unavailable');
  }
}

module.exports = { forgetPreview, resetPrimaryChat };
