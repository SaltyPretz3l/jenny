'use strict';

/* Shared fixture for the chat messaging tests (row 59 checkpoint 4): a real
 * ElectronSessionStore, the real mail store and service composed through the
 * desktop wiring, an injected clock, manual recovery timers and a flush fault
 * injector (`failFlush`) that models a disk error for one session. */

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { createChatMessagingService } = require('../../services/chat-messaging-wiring');

const START_MS = Date.parse('2026-10-15T10:00:00.000Z');
const GESTURES = Array.from({ length: 64 }, (_, n) => `0000000${n % 10}-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`);

function createFixture(t, { projects = { project_a: { name: 'Alpha' }, project_b: { name: 'Beta' } } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-chat-messaging-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'), { logger() {} });
  const backend = new EventEmitter();
  const clock = { ms: START_MS };
  const events = [];
  const coordination = [];
  const logs = [];
  const timers = [];
  const faults = new Map(); // session id -> { skip, count }: let `skip` flushes pass, then fail `count`
  const admission = [];
  const realFlush = store.flushSession.bind(store);
  store.flushSession = (sessionId) => {
    const fault = faults.get(sessionId);
    if (fault && fault.skip > 0) {
      fault.skip -= 1;
    } else if (fault && fault.count > 0) {
      fault.count -= 1;
      return false;
    }
    return realFlush(sessionId);
  };
  Object.assign(backend, {
    sessionStore: store,
    projectService: { get: (id) => projects[id] || null },
    chatWorkspace: { notifyCoordinationChanged: (id) => coordination.push(id) },
  });
  const service = createChatMessagingService({
    backendService: backend,
    emit: (event) => events.push(event),
    log: (level, event, details) => logs.push([level, event, details]),
    reconcileAdmissionSnapshots: (sessionId) => { admission.push(sessionId); return false; },
    scheduleReconcile: false,
    serviceOptions: {
      now: () => new Date(clock.ms),
      setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
      clearTimer: (timer) => { timer.cleared = true; },
      notifierOptions: { intervalMs: 0 },
    },
  });
  t.after(() => {
    service.dispose();
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let gesture = 0;
  return {
    store,
    service,
    backend,
    clock,
    events,
    coordination,
    logs,
    timers,
    admission,
    gesture: () => GESTURES[gesture++],
    advance: (ms) => { clock.ms += ms; },
    failFlush: (sessionId, count = 1, skip = 0) => faults.set(sessionId, { skip, count }),
    session: (title, options = {}) => store.createSession({ title, ...options }),
    sessionId(title, options = {}) { return this.session(title, options).id; },
    archive: (sessionId) => store.setSessionMeta(sessionId, { archived_at: new Date(clock.ms).toISOString() }),
    mail: (sessionId) => store.getSession(sessionId).session_mail,
    async prepare(sourceId, destinationId, body = 'hello there', gestureId = undefined) {
      return service.prepare({
        schema_version: 1, source_session_id: sourceId, destination_session_id: destinationId, body,
        gesture_id: gestureId || this.gesture(),
      });
    },
    // prepare + send in one call -> the send response.
    async sendNew(sourceId, destinationId, body) {
      const prepared = await this.prepare(sourceId, destinationId, body);
      if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
      return { prepared, sent: await service.send({ schema_version: 1, operation_id: prepared.operation_id }) };
    },
  };
}

module.exports = { START_MS, createFixture };
