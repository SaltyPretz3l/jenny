'use strict';

// Reflection scheduler (agentic memory v2, row 58 W2: "Jenny takes notes").
// Polls on an unref'd timer and, only once the main model has been idle for a
// quiet period (the semantic catalog's gate) and no chat has been written for
// that long, runs at most one reflection at a time on the most recently
// updated eligible chat. Per chat: one run per 10
// minutes unless 4 or more user messages accumulated; 3 consecutive failures
// back it off for 30 minutes; a preemption by a chat turn is not a failure; a
// refusal or a caught-up chat waits for new messages. Counters are per process.

const { isMainModelBusy } = require('../semantic-catalog-service');
const { requestRuntimeInference } = require('./backend-runtime-inference');
const {
  localReflectionEngine,
  reflectionGloballyEnabled,
  sessionIneligibility,
} = require('./memory-reflection-eligibility');
const { executeReflection, prepareReflection } = require('./memory-reflection-run');

const POLL_MS = 15_000;
const QUIET_MS = 30_000;
const THROTTLE_MS = 10 * 60_000;
const THROTTLE_BYPASS_NEW_USER_MESSAGES = 4;
const BREAKER_FAILURES = 3;
const BACKOFF_MS = 30 * 60_000;
// Chats untouched for a day are not scanned: reflection follows live use, and
// an old chat becomes a candidate again once it gets a new message.
const RECENT_MS = 24 * 60 * 60_000;
// Cursor reads (inline sidecar RPCs) per tick, bounding a cold start.
const MAX_PREPARES_PER_TICK = 4;
const TRANSIENT_INELIGIBILITY = new Set(['turn_active', 'lineage_unavailable']);

function sidecarReady(service) {
  const client = service?.sidecarClient;
  if (!client || client.connected !== true || typeof client.request !== 'function') return false;
  return String(service.sidecarManager?.getStatus?.()?.phase || 'ready') === 'ready';
}

function summarySignature(summary) {
  return `${Number(summary?.message_count) || 0}|${String(summary?.updated_at || '')}`;
}

class MemoryReflectionScheduler {
  constructor({
    service, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    isBusy = isMainModelBusy, requestInference = requestRuntimeInference,
  } = {}) {
    this.service = service;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.isBusy = isBusy;
    this.requestInference = requestInference;
    this.timer = null;
    this.disposed = false;
    this.running = false;
    this.controller = null;
    this.lastBusyAt = now();
    this.sessions = new Map();
    this.status = { enabled: false, state: 'idle', last_run_at: null, last_outcome: null,
      runs: 0, preempted: 0, saved: 0, queued: 0, skipped: 0, failed: 0, refused: {} };
  }

  start() {
    if (!this.disposed && !this.timer) this._schedule();
    return this;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.controller?.abort(new Error('memory_reflection_disposed'));
  }

  snapshot() {
    const now = this.now();
    let backoffs = 0;
    for (const entry of this.sessions.values()) if (entry.backoffUntil > now) backoffs += 1;
    return { ...this.status, refused: { ...this.status.refused }, backoffs };
  }

  _schedule() {
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.tick().catch(error => this._log('WARN', 'memory.reflection_tick_failed', {
        reason: String(error?.reason || error?.code || 'tick_failed').slice(0, 64),
      })).finally(() => { if (!this.disposed) this._schedule(); });
    }, POLL_MS);
    this.timer?.unref?.();
  }

  _log(level, event, details) {
    try { this.service?._emitServiceLog?.(level, event, details); } catch (_error) { /* Logging never stops a tick. */ }
  }

  _entry(sessionId) {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { lastRunAt: null, lastRunMessageCount: 0, failures: 0, backoffUntil: 0, settledSignature: null };
      this.sessions.set(sessionId, entry);
    }
    return entry;
  }

  // The newest canonical chat write. A turn that starts and ends between two
  // polls is never seen busy, but its messages moved its chat's updated_at
  // (off-turn receipts do not).
  _lastChatActivityAt() {
    let latest = 0;
    for (const summary of this.service.sessionStore?.listSessions?.() || []) {
      const at = Date.parse(String(summary?.updated_at || ''));
      if (Number.isFinite(at) && at > latest) latest = at;
    }
    return latest;
  }

  _idle(now) {
    if (this.isBusy(this.service)) {
      this.lastBusyAt = now;
      return false;
    }
    return now - Math.max(this.lastBusyAt, this._lastChatActivityAt()) >= QUIET_MS;
  }

  async tick() {
    if (this.disposed || this.running) return;
    const { service } = this;
    this.status.enabled = reflectionGloballyEnabled(service);
    if (!this.status.enabled) {
      this.status.state = 'idle';
      return;
    }
    if (!this._idle(this.now())) {
      this.status.state = 'waiting_idle';
      return;
    }
    const engineType = localReflectionEngine(service);
    if (engineType && sidecarReady(service)) {
      this.running = true;
      try {
        await this._runFirstEligible(engineType);
      } finally {
        this.running = false;
      }
    }
    this.status.state = this.snapshot().backoffs > 0 ? 'backing_off' : 'idle';
  }

  _candidates(now) {
    const summaries = this.service.sessionStore?.listSessions?.() || [];
    const ids = new Set(summaries.map(summary => summary?.id));
    for (const id of this.sessions.keys()) if (!ids.has(id)) this.sessions.delete(id);
    return summaries.filter(summary => {
      if (!summary?.id || summary.archived_at) return false;
      const updatedAt = Date.parse(String(summary.updated_at || ''));
      if (Number.isFinite(updatedAt) && now - updatedAt > RECENT_MS) return false;
      const entry = this._entry(summary.id);
      if (entry.settledSignature === summarySignature(summary) || entry.backoffUntil > now) return false;
      // Within the throttle window only a burst of new messages can qualify.
      const newMessages = (Number(summary.message_count) || 0) - entry.lastRunMessageCount;
      return !(entry.lastRunAt !== null && now - entry.lastRunAt < THROTTLE_MS
        && newMessages < THROTTLE_BYPASS_NEW_USER_MESSAGES);
    });
  }

  async _runFirstEligible(engineType) {
    let prepares = 0;
    for (const summary of this._candidates(this.now())) {
      if (prepares >= MAX_PREPARES_PER_TICK || this.disposed) return;
      const entry = this._entry(summary.id);
      const signature = summarySignature(summary);
      const ineligible = sessionIneligibility(this.service, this.service.sessionStore.getSession(summary.id));
      if (ineligible) {
        // A live turn or an unreadable lineage store is transient; every other
        // reason holds until the chat changes.
        if (!TRANSIENT_INELIGIBILITY.has(ineligible)) entry.settledSignature = signature;
        continue;
      }
      prepares += 1;
      let prepared;
      try {
        prepared = await prepareReflection(this.service, summary.id, { engineType });
      } catch (error) {
        const reason = String(error?.reason || '');
        this._record(summary.id, entry, { outcome: 'failed', reason: /^[a-z_]{1,64}$/u.test(reason) ? reason : 'prepare_failed' });
        return;
      }
      if (prepared.status !== 'ready') {
        if (prepared.status === 'nothing_new' || prepared.reason === 'session_purged') entry.settledSignature = signature;
        continue;
      }
      const now = this.now();
      if (entry.lastRunAt !== null && now - entry.lastRunAt < THROTTLE_MS
        && prepared.plan.window.pendingUserCount < THROTTLE_BYPASS_NEW_USER_MESSAGES) continue;
      if (!this._idle(now)) return;
      await this._run(summary.id, entry, signature, prepared.plan);
      return;
    }
  }

  async _run(sessionId, entry, signature, plan) {
    this.status.state = 'running';
    this.status.runs += 1;
    this.controller = new AbortController();
    const result = await executeReflection(this.service, plan, {
      requestInference: this.requestInference, signal: this.controller.signal, now: this.now,
    });
    this.controller = null;
    if (this.disposed) return;
    this.lastBusyAt = this.now();
    this._record(sessionId, entry, result, signature);
  }

  _record(sessionId, entry, result, signature = null) {
    const now = this.now();
    const { outcome } = result;
    this.status.last_run_at = new Date(now).toISOString();
    this.status.last_outcome = outcome === 'refused' ? `refused:${result.reason}` : outcome;
    // Skipped: foreground work took the capacity first; nothing about the chat changed.
    if (outcome === 'skipped') return;
    if (outcome === 'preempted') {
      this.status.preempted += 1;
    } else if (outcome === 'failed') {
      this.status.failed += 1;
      entry.lastRunAt = now;
      entry.failures += 1;
      if (entry.failures >= BREAKER_FAILURES) entry.backoffUntil = now + BACKOFF_MS;
    } else {
      entry.lastRunAt = now;
      entry.failures = 0;
      entry.lastRunMessageCount = Number(this.service.sessionStore.getSessionSummary?.(sessionId)?.message_count) || 0;
      if (outcome === 'refused') {
        this.status.refused[result.reason] = (this.status.refused[result.reason] || 0) + 1;
        if (signature) entry.settledSignature = signature;
      } else {
        this.status.saved += result.saved || 0;
        this.status.queued += result.queued || 0;
        this.status.skipped += result.skipped || 0;
      }
    }
    this._log(outcome === 'failed' ? 'WARN' : 'INFO', 'memory.reflection_outcome', {
      sessionId, outcome, reason: result.reason || '', saved: result.saved || 0, queued: result.queued || 0,
      skipped: result.skipped || 0, backoff: entry.backoffUntil > now,
    });
  }
}

function startMemoryReflectionScheduler({ service, ...options } = {}) {
  const scheduler = new MemoryReflectionScheduler({ service, ...options });
  service.memoryReflectionScheduler = scheduler;
  return scheduler.start();
}

module.exports = { MemoryReflectionScheduler, startMemoryReflectionScheduler, sidecarReady };
