'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeSessionRuntime } = require('../shell-config-session-runtime');

const routes = new WeakSet();
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const ROUTE_KEYS = ['configuration_revision', 'engine_type', 'provider_id', 'requires_gpu', 'resource_class'];
// A queued inference waiter that has not re-polled for this long is gone (the
// sidecar re-admits at most 1 s apart while it waits).
const INFERENCE_WAITER_TTL_MS = 3_000;
// "Finish this first" (row 136). A first chat keeps the model reserved between its own requests for
// this long (a tool call that returns quickly); past it (a long command, an approval) other chats
// may go and the first chat only goes next. First status ends once its task has had no turn running
// for the idle window, so a reply that suspends and resumes keeps its place.
const FIRST_HOLD_GRACE_MS = 60_000;
const FIRST_IDLE_MS = 60_000;
// A pick made before the chat has a turn (slice 3) is dropped if none starts within this window.
const FIRST_START_WAIT_MS = 10 * 60_000;
const FIRST_SETTERS = new Set(['user', 'primary']);
const FIRST_TASK_CACHE_MAX = 64;

// Only application adapters call this factory with trusted provider/configuration
// metadata. Wire objects and model-supplied objects are not admission routes.
function captureRuntimeRoute(metadata) {
  if (!metadata || Object.keys(metadata).sort().join(',') !== ROUTE_KEYS.join(',')
    || !['engine_type', 'provider_id', 'configuration_revision'].every(key => (
      typeof metadata[key] === 'string' && TOKEN.test(metadata[key])
    ))
    || !['local', 'cloud'].includes(metadata.resource_class)
    || typeof metadata.requires_gpu !== 'boolean'
    || (metadata.resource_class === 'cloud' && metadata.requires_gpu)) {
    throw new TypeError('runtime_provider_route_invalid');
  }
  const route = Object.freeze({ ...metadata });
  routes.add(route);
  return route;
}

function isRuntimeRoute(route) {
  return Boolean(route && routes.has(route));
}

function laneKey(route) {
  return route.resource_class === 'local' ? 'local' : `cloud:${route.provider_id}`;
}

function positiveBound(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new TypeError('runtime_downstream_capacity_invalid');
  }
  return value;
}

function waiting(reason, records, queued = false, heldForFirst = false) {
  const blockers = records.map(record => Object.freeze({
    session_id: typeof record.sessionId === 'string' ? record.sessionId : null,
    quarantined_at: Number.isFinite(record.quarantinedAt) ? record.quarantinedAt : null,
  }));
  return Object.freeze({ status: 'waiting', reason, blockers: Object.freeze(blockers),
    ...(queued ? { queued: true } : {}), ...(heldForFirst ? { held_for_first: true } : {}) });
}

class RuntimeLaneAdmission {
  constructor({ limits, maxRunnableTurns = 16, maxInferenceRequests = 16,
    createId = randomUUID, onChange = null, now = Date.now, sameTask = null, setTimer = setTimeout } = {}) {
    this.limits = normalizeSessionRuntime(limits);
    this.capacity = { turn: positiveBound(maxRunnableTurns), inference: positiveBound(maxInferenceRequests) };
    this.createId = createId;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.now = now;
    this.leases = new Map();
    // ownerId -> { key, firstAt, lastAt } for mid-turn re-admits still waiting.
    this.inferenceWaiters = new Map();
    // { sessionId, key, setBy, setAt, lastActiveAt, idleSince, related } | null: the chat whose task
    // goes first. `idleSince` is null while a turn of the task runs; `related` remembers sameTask answers.
    this.first = null;
    // (firstSessionId, sessionId) -> true when sessionId is a helper chat of the first chat.
    this.sameTask = typeof sameTask === 'function' ? sameTask : null;
    this.setTimer = setTimer;
    this.firstWake = null;
  }

  setLimits(limits) {
    this.limits = normalizeSessionRuntime(limits);
    // Lowering a limit blocks new admission; it never evicts an active producer.
    this._changed();
    return this.snapshot();
  }

  // `priority` (row 69/70: the primary Jenny chat) admits one turn beyond the lane's
  // `runnable_turns` so an orchestrating chat can run while a worker chat streams or waits on
  // an approval; generation stays serialized by the inference lane. Per-session exclusion and
  // the downstream capacity still apply, and a priority turn never displaces an ordinary one.
  tryAcquireTurn({ sessionId, route, signal, priority = false } = {}) {
    if (typeof sessionId !== 'string' || !TOKEN.test(sessionId)) {
      throw new TypeError('runtime_session_identity_invalid');
    }
    return this._acquire('turn', { sessionId, route, signal, priority: priority === true });
  }

  // sessionId (optional) only names the holder in a waiter's blockers, so a send held behind
  // another chat's generation can say which chat it waits for. `queue` marks a mid-turn re-admit
  // the sidecar keeps polling: queued owners are granted oldest first among themselves, so a chat
  // whose tool calls finish in milliseconds cannot win every gap against a polling one.
  tryAcquireInference({ ownerId, route, signal, sessionId = null, queue = false } = {}) {
    if (typeof ownerId !== 'string' || !TOKEN.test(ownerId)) {
      throw new TypeError('runtime_inference_owner_invalid');
    }
    const holder = typeof sessionId === 'string' && TOKEN.test(sessionId) ? sessionId : null;
    return this._acquire('inference', { ownerId, route, signal, sessionId: holder, queue: queue === true });
  }

  // Puts one chat's running task first on its lane: other chats' model requests wait while it
  // works, and it is never queued behind them. A running request is never cut off. `setBy` records
  // who chose (the person, or the primary Jenny chat). A newer pick replaces an older one, except
  // that Jenny's never replaces the person's. `picker` is the chat that made the pick: it is not
  // held behind it, so Jenny still answers the person. `whenStarted` accepts a chat with no turn
  // yet (Jenny messages a chat, then puts it first): the pick takes effect with its first turn.
  setFirstSession(sessionId, { setBy = 'user', picker = null, whenStarted = false } = {}) {
    if (typeof sessionId !== 'string' || !TOKEN.test(sessionId)) {
      throw new TypeError('runtime_session_identity_invalid');
    }
    const by = FIRST_SETTERS.has(setBy) ? setBy : 'user';
    if (by === 'primary' && this._firstAlive()?.setBy === 'user') {
      return Object.freeze({ status: 'rejected', reason: 'user_pick_active' });
    }
    const turn = [...this.leases.values()].find(record => record.kind === 'turn'
      && record.sessionId === sessionId && record.state === 'active');
    if (!turn && whenStarted !== true) return Object.freeze({ status: 'rejected', reason: 'session_not_running' });
    const at = this.now();
    // `key` stays null until the picked chat's first turn: until then the pick holds nothing.
    this.first = { sessionId, key: turn ? turn.key : null, setBy: by, setAt: at, lastActiveAt: at,
      idleSince: turn ? null : at,
      picker: typeof picker === 'string' && TOKEN.test(picker) ? picker : null, related: new Map() };
    this._changed();
    return Object.freeze({ status: 'set', ...this.firstSession(), started: Boolean(turn) });
  }

  // With a session id, clears only that chat's pick (a stale clear never drops a newer one).
  clearFirstSession(sessionId = null) {
    if (!this.first || (sessionId !== null && this.first.sessionId !== sessionId)) return false;
    this.first = null;
    this._changed();
    return true;
  }

  firstSession() {
    const first = this._firstAlive();
    return first ? Object.freeze({ session_id: first.sessionId, set_by: first.setBy, set_at: first.setAt }) : null;
  }

  forgetInferenceWaiter(ownerId) {
    this.inferenceWaiters.delete(ownerId);
  }

  ownsInferenceLease(lease, route) {
    const record = this.leases.get(lease?.id);
    return Boolean(record?.lease === lease && record.kind === 'inference'
      && record.route === route && record.state === 'active');
  }

  release(lease, { producerSettled = false } = {}) {
    const current = this.leases.get(lease?.id);
    if (!current || current.lease !== lease) return false;
    if (!producerSettled) {
      if (current.state !== 'quarantined') current.quarantinedAt = this.now();
      current.state = 'quarantined';
      this._noteFirstRelease(current);
      this._changed();
      return false;
    }
    this.leases.delete(lease.id);
    this._noteFirstRelease(current);
    this._changed();
    return true;
  }

  confirmCleanup(lease) {
    const current = this.leases.get(lease?.id);
    if (!current || current.lease !== lease || current.state !== 'quarantined') return false;
    return this.release(lease, { producerSettled: true });
  }

  // Backend-restart proof only: confirms every quarantined lease no live owner
  // still holds (a turn lease in `heldLeases`, an inference lease whose owner is
  // in `heldOwners`). Returns how many were confirmed.
  confirmOrphaned({ heldLeases, heldOwners }) {
    let confirmed = 0;
    for (const record of [...this.leases.values()]) {
      if (record.state !== 'quarantined') continue;
      if (record.kind === 'turn' ? heldLeases.has(record.lease) : heldOwners.has(record.ownerId)) continue;
      if (this.confirmCleanup(record.lease)) confirmed += 1;
    }
    return confirmed;
  }

  snapshot() {
    const lanes = new Map();
    let quarantined = 0;
    for (const record of this.leases.values()) {
      const key = record.key;
      const lane = lanes.get(key) || { lane: key, turns: 0, inference_requests: 0, quarantined: 0 };
      lane[record.kind === 'turn' ? 'turns' : 'inference_requests'] += 1;
      if (record.state === 'quarantined') { lane.quarantined += 1; quarantined += 1; }
      lanes.set(key, lane);
    }
    return Object.freeze({
      active_leases: this.leases.size, quarantined,
      downstream: Object.freeze({ runnable_turns: this.capacity.turn, inference_requests: this.capacity.inference }),
      configured: Object.freeze(normalizeSessionRuntime(this.limits)),
      first: this.firstSession(),
      lanes: Object.freeze([...lanes.values()].map(Object.freeze)),
    });
  }

  _acquire(kind, { sessionId = null, ownerId = null, route, signal, priority = false, queue = false }) {
    if (!isRuntimeRoute(route)) throw new TypeError('runtime_provider_route_untrusted');
    if (signal?.aborted) return Object.freeze({ status: 'rejected', reason: 'cancelled' });
    const key = laneKey(route);
    // Quarantined leases still count: capacity stays charged until cleanup is confirmed.
    let sessionBusy = false;
    let kindCount = 0;
    let keyCount = 0;
    let priorityKeyCount = 0; // turns on this lane holding its one extra slot
    const kindRecords = [];
    for (const record of this.leases.values()) {
      if (record.kind !== kind) continue;
      kindRecords.push(record);
      kindCount += 1;
      if (record.key === key) {
        keyCount += 1;
        if (record.priority) priorityKeyCount += 1;
      }
      if (kind === 'turn' && record.sessionId === sessionId) sessionBusy = true;
    }
    const ordinaryKeyCount = keyCount - priorityKeyCount;
    if (sessionBusy) return waiting('session_busy', kindRecords.filter(record => record.sessionId === sessionId));
    if (kindCount >= this.capacity[kind]) {
      return waiting('downstream_capacity', kindRecords);
    }
    const setting = kind === 'turn' ? 'runnable_turns' : 'inference_requests';
    const limit = this.limits[route.resource_class][setting];
    // Ordinary turns count only ordinary holders. A priority turn takes the lane's single extra slot
    // while it is free (so the primary alone never blocks a worker), else an ordinary slot like anyone
    // else: two priority sessions never add up to two extra slots.
    const usesPrioritySlot = kind === 'turn' && priority && priorityKeyCount < 1;
    const first = kind === 'inference' ? this._firstOn(key) : null;
    const inFirstTask = first !== null && this._inFirstTask(first, sessionId);
    if (inFirstTask) first.lastActiveAt = this.now();
    // The chat that made the pick (Jenny) is neither held behind it nor queued behind the chats it
    // holds; like everyone, it still waits for a request that is running.
    const picker = first !== null && first.picker !== null && sessionId === first.picker;
    const heldUntil = first && !inFirstTask && !picker ? this._firstHeldUntil(first, key) : 0;
    // The first chat is never queued behind the chats it is ahead of.
    const waitersAhead = queue && !inFirstTask && !picker ? this._inferenceWaitersAhead(ownerId, key) : 0;
    const laneFull = kind === 'turn'
      ? (!usesPrioritySlot && ordinaryKeyCount >= limit)
      : keyCount + waitersAhead >= limit;
    if (heldUntil || laneFull) {
      if (queue) this._noteInferenceWaiter(ownerId, key);
      // A caller that does not poll (a reply's first request) is retried through onChange.
      else if (heldUntil && Number.isFinite(heldUntil)) this._wakeAt(heldUntil);
      return waiting('lane_capacity', heldUntil ? [{ sessionId: first.sessionId, quarantinedAt: null }]
        : kindRecords.filter(record => record.key === key), queue && keyCount < limit, Boolean(heldUntil));
    }
    if (queue) this.inferenceWaiters.delete(ownerId);
    const id = this.createId();
    if (typeof id !== 'string' || !TOKEN.test(id) || this.leases.has(id)) {
      throw new Error('runtime_lane_identity_conflict');
    }
    const lease = Object.freeze({ id });
    this.leases.set(id, { lease, kind, sessionId, ownerId, route, key, priority: usesPrioritySlot,
      state: 'active', quarantinedAt: null });
    // A pick waiting for this chat's first turn starts now, not at somebody's next look: a turn
    // that ends before any model request would otherwise leave it on the start window.
    if (kind === 'turn' && this.first?.key === null) this._firstAlive();
    this._changed();
    return Object.freeze({ status: 'granted', lease });
  }

  _inFirstTask(first, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (sessionId === first.sessionId) return true;
    if (!this.sameTask) return false;
    // A chat's spawn link never changes, and this runs for every lease on every poll.
    let related = first.related.get(sessionId);
    if (related === undefined) {
      try { related = this.sameTask(first.sessionId, sessionId) === true; } catch (_error) { return false; }
      if (first.related.size >= FIRST_TASK_CACHE_MAX) first.related.clear();
      first.related.set(sessionId, related);
    }
    return related;
  }

  // The pick, while its task is still around: it ends once no turn of the task has run for the idle
  // window (the start window for a pick whose chat has not had a turn yet).
  _firstAlive() {
    const first = this.first;
    if (!first) return null;
    // A pick that has not started waits for the picked chat's own turn: a helper chat that is
    // still running for an idle chat does not start it (and would end it 60 s after it stops).
    const started = first.key !== null;
    let running = null;
    for (const record of this.leases.values()) {
      if (record.kind !== 'turn' || record.state !== 'active') continue;
      if (started ? this._inFirstTask(first, record.sessionId) : record.sessionId === first.sessionId) {
        running = record;
        break;
      }
    }
    const now = this.now();
    if (running && !started) {
      first.key = running.key;
      first.lastActiveAt = now;
    }
    if (running) first.idleSince = null;
    else first.idleSince ??= now;
    const window = first.key !== null ? FIRST_IDLE_MS : FIRST_START_WAIT_MS;
    if (first.idleSince !== null && now - first.idleSince > window) this.first = null;
    return this.first;
  }

  _firstOn(key) {
    const first = this._firstAlive();
    return first && first.idleSince === null && first.key === key ? first : null;
  }

  // How long the lane stays reserved for the first chat: Infinity while one of its requests runs
  // (its release announces the change), else the time the grace after its last request ends, else 0.
  _firstHeldUntil(first, key) {
    for (const record of this.leases.values()) {
      if (record.kind === 'inference' && record.key === key && record.state === 'active'
        && this._inFirstTask(first, record.sessionId)) return Infinity;
    }
    const until = first.lastActiveAt + FIRST_HOLD_GRACE_MS;
    return this.now() <= until ? until : 0;
  }

  // One pending wake: a held caller that does not poll is tried again once the grace can have ended.
  _wakeAt(at) {
    if (this.firstWake) return;
    this.firstWake = this.setTimer(() => {
      this.firstWake = null;
      this._changed();
    }, Math.max(at - this.now(), 0) + 1);
    this.firstWake?.unref?.();
  }

  _noteFirstRelease(record) {
    const first = this.first;
    if (!first) return;
    if (record.kind === 'inference' && this._inFirstTask(first, record.sessionId)) first.lastActiveAt = this.now();
    // Stamps the start of the idle window as soon as the task's last turn goes.
    if (record.kind === 'turn') this._firstAlive();
  }

  _inferenceWaitersAhead(ownerId, key) {
    const cutoff = this.now() - INFERENCE_WAITER_TTL_MS;
    const own = this.inferenceWaiters.get(ownerId);
    let ahead = 0;
    for (const [id, waiter] of this.inferenceWaiters) {
      if (waiter.lastAt < cutoff) { this.inferenceWaiters.delete(id); continue; }
      if (id !== ownerId && waiter.key === key && (!own || waiter.firstAt < own.firstAt)) ahead += 1;
    }
    return ahead;
  }

  _noteInferenceWaiter(ownerId, key) {
    const now = this.now();
    const current = this.inferenceWaiters.get(ownerId);
    this.inferenceWaiters.set(ownerId, { key, firstAt: current?.key === key ? current.firstAt : now, lastAt: now });
  }

  _changed() {
    try { this.onChange?.(); } catch (_error) { /* Observers cannot release or replace a producer. */ }
  }
}

module.exports = { RuntimeLaneAdmission, captureRuntimeRoute, isRuntimeRoute };
