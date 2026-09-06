'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BackendService } = require('../services/backend/backend-service');

test('active stream abort isolates malformed controllers and continues the batch', () => {
  const aborted = [];
  const logs = [];
  const service = {
    activeStreams: new Map([
      ['stream-bad', { abort() { throw new Error('broken controller'); } }],
      ['stream-good', { abort(error) { aborted.push(error.cancel_reason); } }],
    ]),
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  };

  BackendService.prototype._abortActiveStreams.call(service, 'service_stop', { clear: true });

  assert.deepEqual(aborted, ['service_stop']);
  assert.equal(service.activeStreams.size, 0);
  assert.equal(
    logs.some((entry) => entry.level === 'WARN'
      && entry.event === 'chat.stream_abort_failed'
      && entry.details.streamId === 'stream-bad'),
    true
  );
});
