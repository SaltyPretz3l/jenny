'use strict';

// Conversation index pump (agentic memory v2, row 58 W4). Feeds the past chats
// the conversations_* tools may see into the sidecar-owned derived store
// <userData>/conversation-index.db, and runs the embed steps while the main
// model is idle. Polls on an unref'd timer; once the model has been quiet for
// 30 s (the reflection scheduler's rule: the later of the last busy poll and
// the newest chat write), a tick (1) loads the index state once per sidecar
// process, (2) purges chats that are gone or hidden, (3) indexes up to 3
// changed chats, newest first, and (4) runs the embed steps. A busy poll stops
// the tick; 3 failed ticks back off for 10 minutes. Chat text never reaches a
// log: events carry reason tokens and counts only.

const { isMainModelBusy } = require('../semantic-catalog-service');
const { indexRows, MAX_ID_CHARS, projectIdOf } = require('../tools/builtin/conversation-text');
const { visibleChatPredicate } = require('./memory-reflection-eligibility');
const { sidecarReady } = require('./memory-reflection-scheduler');
const { API_VERSION } = require('./sidecar-client');

const POLL_MS = 20_000;
const QUIET_MS = 30_000;
const BREAKER_FAILURES = 3;
const BACKOFF_MS = 10 * 60_000;
const SESSIONS_PER_TICK = 3;
const MAX_INDEX_MESSAGES = 500;
const MAX_TITLE_CHARS = 200;
const PURGE_BATCH = 500;
const EMBED_STEP = Object.freeze({ budget_seconds: 1.5, batch: 16 });

class PumpStop extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function fingerprintOf(summary) {
  return `${String(summary?.updated_at || '')}|${Number(summary?.message_count) || 0}`;
}

function pumpEnabled(service) {
  return service?.featureFlags?.memory_v2_enabled === true && service.hostMode !== 'server';
}

function catalogEnabled(service) {
  try {
    return service?.semanticCatalogService?.getSidecarConfig?.()?.semantic_catalog?.enabled === true;
  } catch (_error) {
    return false;
  }
}

function request(service, method, params) {
  return service.sidecarClient.request(method, { accept_version: API_VERSION, ...params });
}

class ConversationIndexPump {
  constructor({ service, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, isBusy = isMainModelBusy } = {}) {
    this.service = service;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.isBusy = isBusy;
    this.timer = null;
    this.disposed = false;
    this.running = false;
    this.lastBusyAt = now();
    // session_id -> fingerprint as the index holds it; null until loaded for
    // the current sidecar client.
    this.indexed = null;
    this.client = null;
    this.failures = 0;
    this.backoffUntil = 0;
  }

  start() {
    if (!this.disposed && !this.timer) this._schedule();
    return this;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.indexed = null;
  }

  // A committed delete purged this chat from the index.
  forget(sessionId) {
    this.indexed?.delete(sessionId);
  }

  _schedule() {
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.tick().finally(() => { if (!this.disposed) this._schedule(); });
    }, POLL_MS);
    this.timer?.unref?.();
  }

  _log(level, event, details) {
    try { this.service?._emitServiceLog?.(level, event, details); } catch (_error) { /* Logging never stops a tick. */ }
  }

  _lastChatActivityAt() {
    let latest = 0;
    for (const summary of this.service.sessionStore?.listSessions?.() || []) {
      const at = Date.parse(String(summary?.updated_at || ''));
      if (Number.isFinite(at) && at > latest) latest = at;
    }
    return latest;
  }

  _busy() {
    if (!this.isBusy(this.service)) return false;
    this.lastBusyAt = this.now();
    return true;
  }

  _idle(now) {
    if (this._busy()) return false;
    return now - Math.max(this.lastBusyAt, this._lastChatActivityAt()) >= QUIET_MS;
  }

  // Between RPCs: stop the tick when the model became busy or the pump went away.
  _checkpoint() {
    if (this.disposed) throw new PumpStop('disposed');
    if (this._busy()) throw new PumpStop('busy');
  }

  async tick() {
    if (this.disposed || this.running) return;
    const { service } = this;
    if (!pumpEnabled(service)) return;
    if (!sidecarReady(service)) {
      this.indexed = null;
      return;
    }
    const now = this.now();
    if (now < this.backoffUntil || !this._idle(now)) return;
    this.running = true;
    try {
      if (service.sidecarClient !== this.client) {
        this.client = service.sidecarClient;
        this.indexed = null;
      }
      await this._run();
      this.failures = 0;
    } catch (error) {
      if (!(error instanceof PumpStop)) this._fail(error);
    } finally {
      this.running = false;
    }
  }

  _fail(error) {
    this.failures += 1;
    this.indexed = null;
    const backoff = this.failures >= BREAKER_FAILURES;
    if (backoff) {
      this.failures = 0;
      this.backoffUntil = this.now() + BACKOFF_MS;
    }
    const reason = String(error?.reason || '');
    this._log('WARN', 'conversations.index_pump_failed', {
      reason: /^[a-z_]{1,64}$/u.test(reason) ? reason : 'request_failed', backoff,
    });
  }

  async _run() {
    const { service } = this;
    if (!this.indexed) await this._loadState();
    const wanted = this._wanted();
    const stale = [...this.indexed.keys()].filter(id => !wanted.has(id));
    for (let start = 0; start < stale.length; start += PURGE_BATCH) {
      this._checkpoint();
      const batch = stale.slice(start, start + PURGE_BATCH);
      const result = await request(service, 'conversations.purge', { session_ids: batch });
      if (result?.ok !== true) throw Object.assign(new Error('purge_failed'), { reason: String(result?.reason || 'purge_refused') });
      for (const id of batch) this.indexed.delete(id);
    }
    const changed = [...wanted.values()]
      .filter(summary => this.indexed.get(summary.id) !== fingerprintOf(summary))
      .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')))
      .slice(0, SESSIONS_PER_TICK);
    for (const summary of changed) {
      this._checkpoint();
      // A full index stops new chats only; existing rows keep embedding.
      if (!(await this._indexSession(summary))) break;
    }
    if (!catalogEnabled(service)) return;
    this._checkpoint();
    await request(service, 'conversations.embed_step', EMBED_STEP);
    if (service.featureFlags?.memory_hybrid_recall !== true) return;
    this._checkpoint();
    await request(service, 'memory.embed_step', EMBED_STEP);
  }

  async _loadState() {
    const result = await request(this.service, 'conversations.index_state', {});
    if (result?.ok !== true || !Array.isArray(result.sessions)) {
      throw Object.assign(new Error('index_state_failed'), { reason: String(result?.reason || 'invalid_response') });
    }
    this.indexed = new Map();
    for (const entry of result.sessions) {
      if (typeof entry?.session_id === 'string') this.indexed.set(entry.session_id, String(entry.fingerprint || ''));
    }
  }

  // Every chat the conversations_* tools may show, in any project (the tools
  // scope by project at query time). Hidden chats are purged from the index.
  // An unreadable lineage store hides every chat (fails closed).
  _wanted() {
    const visible = visibleChatPredicate(this.service);
    const wanted = new Map();
    for (const summary of this.service.sessionStore?.listSessions?.() || []) {
      if (!summary || typeof summary.id !== 'string' || !summary.id || summary.id.length > MAX_ID_CHARS) continue;
      if (Number(summary.message_count) > 0 && visible(summary)) wanted.set(summary.id, summary);
    }
    return wanted;
  }

  // Returns false when the index is full (stop indexing this tick).
  async _indexSession(summary) {
    const fingerprint = fingerprintOf(summary);
    const messages = this.service.sessionStore.peekSessionMessages(summary.id) || [];
    const result = await request(this.service, 'conversations.index_session', {
      session_id: summary.id,
      project_id: projectIdOf(summary.project_id),
      title: typeof summary.title === 'string' ? summary.title.slice(0, MAX_TITLE_CHARS) : '',
      updated_at: String(summary.updated_at || ''),
      fingerprint,
      messages: indexRows(messages, MAX_INDEX_MESSAGES),
    });
    if (result?.ok === true) {
      this.indexed.set(summary.id, fingerprint);
      return true;
    }
    if (result?.reason === 'index_full') {
      this._log('INFO', 'conversations.index_full', { indexed: this.indexed.size });
      return false;
    }
    throw Object.assign(new Error('index_session_failed'), { reason: String(result?.reason || 'invalid_response') });
  }
}

function startConversationIndexPump({ service, ...options } = {}) {
  const pump = new ConversationIndexPump({ service, ...options });
  service.conversationIndexPump = pump;
  return pump.start();
}

// A committed chat delete: drop the chat from the index. Best effort; never
// throws or blocks the delete (a miss is purged by the pump's next diff).
async function purgeConversationIndex(service, sessionId) {
  try {
    if (!sessionId || service?.hostMode === 'server' || !sidecarReady(service)) return;
    const result = await request(service, 'conversations.purge', { session_ids: [sessionId] });
    if (result?.ok === true) service.conversationIndexPump?.forget?.(sessionId);
  } catch (_error) {
    // The pump's next state diff retries a missed purge.
  }
}

module.exports = { ConversationIndexPump, purgeConversationIndex, startConversationIndexPump };
