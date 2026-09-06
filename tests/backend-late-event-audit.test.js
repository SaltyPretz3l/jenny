'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { appendLateEventAudit } = require('../services/backend/backend-late-event-audit');

test('late-event audit evicts oldest entries, bounds events, and records drops', () => {
  const row = {
    id: 'tool-result-1',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call-1',
      metadata: { late_events: [] },
    },
  };
  const service = {
    sessionStore: {
      getSessionMessages() {
        return [row];
      },
      updateMessage(_sessionId, _messageId, patch) {
        Object.assign(row, patch);
      },
    },
  };

  for (let index = 0; index < 55; index += 1) {
    appendLateEventAudit(service, 'session-1', 'call-1', {
      index,
      payload: index === 54 ? 'x'.repeat(10_000) : 'ok',
    });
  }

  const metadata = row.tool_result.metadata;
  assert.equal(metadata.late_events.length, 50);
  assert.equal(metadata.late_events[0].index, 5);
  assert.equal(metadata.dropped_count, 5);
  assert.equal(metadata.late_events.at(-1).truncated, true);
  assert.ok(metadata.late_events.every(
    (event) => Buffer.byteLength(JSON.stringify(event), 'utf8') <= 4096
  ));
});
