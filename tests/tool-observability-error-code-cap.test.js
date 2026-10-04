const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolObservabilityAggregator } = require('../services/backend/tool-observability-aggregator');

function recordError(aggregator, errorCode, callId, toolName = 'read_file') {
  assert.equal(aggregator.recordToolResult({
    sessionId: 'sess_1', callId: String(callId), toolName, success: false, errorCode, durationMs: 1,
  }), true);
}

test('1000 distinct error codes retain 32 codes plus other without losing totals', () => {
  const aggregator = new ToolObservabilityAggregator();
  for (let index = 0; index < 1000; index += 1) {
    recordError(aggregator, `CMP-TOOL-${index}`, index);
  }
  const snapshot = aggregator.snapshot().tools.read_file;
  assert.ok(Object.keys(snapshot.error_codes).length <= 33, 'error code keys must be capped at 33 including other');
  assert.equal(snapshot.error_codes.other, 968);
  assert.equal(snapshot.error_count, 1000);
  assert.equal(snapshot.count, 1000);
  assert.equal(Object.values(snapshot.error_codes).reduce((sum, count) => sum + count, 0), 1000);
  recordError(aggregator, 'CMP-TOOL-0', 'repeat');
  recordError(aggregator, 'CMP-OTHER-0001', 'independent', 'write_file');
  assert.equal(aggregator.snapshot().tools.read_file.error_codes['CMP-TOOL-0'], 2);
  assert.equal(aggregator.snapshot().tools.write_file.error_codes['CMP-OTHER-0001'], 1);
  assert.equal(aggregator.snapshot().tools.read_file.last_result.error_code, 'CMP-TOOL-0');
});

test('missing codes stay unknown; invalid codes normalize to other before entering any diagnostic rows', () => {
  const missing = new ToolObservabilityAggregator();
  [null, undefined, ''].forEach((code, index) => recordError(missing, code, index));
  assert.deepEqual(missing.snapshot().tools.read_file.error_codes, { unknown: 3 });
  const aggregator = new ToolObservabilityAggregator();
  const invalid = [123, {}, ' has-space', 'bad/code', '\u4f60', 'a'.repeat(65)];
  invalid.forEach((code, index) => recordError(aggregator, code, index));
  const snapshot = aggregator.snapshot().tools.read_file;
  assert.deepEqual(snapshot.error_codes, { other: invalid.length });
  assert.ok(snapshot.recent_errors.every(row => row.error_code === 'other'));
  assert.equal(snapshot.last_result.error_code, 'other');
  for (const code of ['a'.repeat(64), 'CMP-TOOL_1.2:3', '__proto__']) {
    recordError(aggregator, code, code);
    assert.equal(aggregator.snapshot().tools.read_file.error_codes[code], 1);
  }
});

test('other does not consume the 32 distinct named-code slots and reset releases them', () => {
  const aggregator = new ToolObservabilityAggregator();
  recordError(aggregator, 'bad code', 'invalid');
  for (let index = 0; index < 33; index += 1) recordError(aggregator, `code_${index}`, index);
  const codes = aggregator.snapshot().tools.read_file.error_codes;
  assert.equal(Object.keys(codes).length, 33);
  assert.equal(codes.code_31, 1);
  assert.equal(codes.other, 2);
  aggregator.reset();
  recordError(aggregator, 'new_code', 'after_reset');
  assert.deepEqual(aggregator.snapshot().tools.read_file.error_codes, { new_code: 1 });
});
