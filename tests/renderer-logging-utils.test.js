'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createClientLogAppender,
  sanitizeLogDetails,
  clampLogTimestamp,
  DEFAULT_DETAIL_SIZE_CAP,
} = require('../renderer/shell/renderer-logging-utils');

describe('renderer-logging-utils intake hardening', () => {
  test('clampLogTimestamp passes through a valid timestamp and clamps a malformed one', () => {
    const valid = '2026-06-19T00:00:00.000Z';
    assert.equal(clampLogTimestamp(valid), valid);

    for (const bad of ['not-a-date', '', null, undefined, {}, NaN]) {
      const clamped = clampLogTimestamp(bad);
      assert.ok(Number.isFinite(new Date(clamped).getTime()), `expected finite ts for ${String(bad)}`);
    }
  });

  test('sanitizeLogDetails coerces non-objects to an empty object', () => {
    assert.deepEqual(sanitizeLogDetails('a string'), {});
    assert.deepEqual(sanitizeLogDetails(42), {});
    assert.deepEqual(sanitizeLogDetails(null), {});
    assert.deepEqual(sanitizeLogDetails([1, 2, 3]), {});
  });

  test('sanitizeLogDetails passes through a small plain object unchanged', () => {
    const details = { message: 'ok', category: 'startup' };
    assert.equal(sanitizeLogDetails(details), details);
  });

  test('sanitizeLogDetails truncates an oversized blob to a readable preview', () => {
    const big = { blob: 'x'.repeat(DEFAULT_DETAIL_SIZE_CAP + 10) };
    const result = sanitizeLogDetails(big);
    assert.equal(result._truncated, true);
    assert.ok(result._originalSize > DEFAULT_DETAIL_SIZE_CAP);
    assert.ok(typeof result.preview === 'string' && result.preview.length <= 2000);
    // The truncated marker must itself be safe to stringify.
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  test('sanitizeLogDetails replaces a circular graph with a safe marker', () => {
    const circular = { name: 'loop' };
    circular.self = circular;
    const result = sanitizeLogDetails(circular);
    assert.deepEqual(result, { _unserializable: true });
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  test('sanitizeLogDetails honors an explicit cap', () => {
    const details = { v: 'abcdefghij' };
    assert.equal(sanitizeLogDetails(details, 4)._truncated, true);
    assert.equal(sanitizeLogDetails(details, 100000), details);
  });
});

describe('renderer-logging-utils', () => {
  test('creates normalized renderer client log entries', () => {
    const entries = [];
    const appendClientLog = createClientLogAppender({
      pushLogEntry(entry) {
        entries.push(entry);
      },
      component: 'renderer.test',
    });

    appendClientLog('warn', 'demo.event', {
      sessionId: 'session-1',
      callId: 'call-1',
      duration_ms: '12',
      message: 'Demo message',
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, 'WARN');
    assert.equal(entries[0].component, 'renderer.test');
    assert.equal(entries[0].event, 'demo.event');
    assert.equal(entries[0].message, 'Demo message');
    assert.equal(entries[0].session_id, 'session-1');
    assert.equal(entries[0].tool_call_id, 'call-1');
    assert.equal(entries[0].duration_ms, 12);
    assert.equal(entries[0].source, 'renderer');
  });

  test('appendClientLog sanitizes an oversized details payload before storing it', () => {
    const entries = [];
    const appendClientLog = createClientLogAppender({ pushLogEntry: (entry) => entries.push(entry) });
    const big = 'x'.repeat(DEFAULT_DETAIL_SIZE_CAP + 10);

    appendClientLog('info', 'demo.big', { sessionId: 'session-9', message: 'still here', blob: big });

    assert.equal(entries.length, 1);
    const entry = entries[0];
    // The bulk payload is capped, not stored verbatim, on both data and details.
    assert.equal(entry.data._truncated, true);
    assert.ok(entry.data._originalSize > DEFAULT_DETAIL_SIZE_CAP);
    assert.ok(!('blob' in entry.data), 'the oversized blob must not be stored verbatim');
    assert.equal(entry.details._truncated, true);
    // Correlation + message fields are extracted before sanitizing, so they survive.
    assert.equal(entry.message, 'still here');
    assert.equal(entry.session_id, 'session-9');
    assert.equal(entry.details.message, 'still here');
  });
});
