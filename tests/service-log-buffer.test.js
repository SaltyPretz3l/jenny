const test = require('node:test');
const assert = require('node:assert/strict');
const { createServiceLogBuffer } = require('../services/backend/service-log-buffer');
const { BackendService } = require('../services/backend/backend-service');

test('holds entries until drained, stamped with their original time', () => {
  const buffer = createServiceLogBuffer({ now: () => 'T0' });
  assert.equal(buffer.hold({ level: 'ERROR', event: 'runtime_store.read_only', details: { reason: 'x' } }), true);
  assert.deepEqual(buffer.drain(), [
    { level: 'ERROR', event: 'runtime_store.read_only', details: { reason: 'x', early_log_at: 'T0' } },
  ]);
  // Drained once: later entries go straight to whoever listens (or nowhere).
  assert.equal(buffer.hold({ level: 'INFO', event: 'late', details: {} }), false);
  assert.deepEqual(buffer.drain(), []);
});

test('is bounded and reports how many entries it dropped', () => {
  const buffer = createServiceLogBuffer({ limit: 2, now: () => 'T0' });
  for (let index = 0; index < 5; index += 1) buffer.hold({ level: 'INFO', event: `e${index}`, details: null });
  const drained = buffer.drain();
  assert.deepEqual(drained.map(entry => entry.event), ['e0', 'e1', 'backend.early_service_logs_dropped']);
  assert.deepEqual(drained[0].details, { early_log_at: 'T0' });
  assert.deepEqual(drained[2].details, { dropped: 3 });
});

test('BackendService replays logs emitted before the host listened', () => {
  const emitLog = BackendService.prototype._emitServiceLog;
  const drain = BackendService.prototype.drainEarlyServiceLogs;
  const service = Object.assign(Object.create(BackendService.prototype), {
    _earlyServiceLogs: createServiceLogBuffer({ now: () => 'T0' }),
    _events: undefined,
  });
  require('node:events').EventEmitter.call(service);
  emitLog.call(service, 'error', 'runtime_store.read_only', { reason: 'index_unreadable' });
  const live = [];
  service.on('service-log', entry => live.push(entry));
  emitLog.call(service, 'INFO', 'after_listen', {});
  assert.deepEqual(live.map(entry => entry.event), ['after_listen']);
  assert.deepEqual(drain.call(service), [{ level: 'ERROR', event: 'runtime_store.read_only',
    details: { reason: 'index_unreadable', early_log_at: 'T0' } }]);
});
