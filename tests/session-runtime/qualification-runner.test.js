'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { parseOptions, percentile, assertCaps } = require('../../scripts/observe/session-runtime-qualification');
test('opt-in qualification accepts only bounded controlled workloads and the approved timeout', () => {
  assert.deepEqual(parseOptions([]), { sessions: 200, transport: 'fake', timeoutMs: 600000 });
  assert.equal(parseOptions(['--sessions', '32']).sessions, 32);
  for (const args of [['--sessions', '201'], ['--sessions', 'NaN'], ['--sessions', '-1'],
    ['--timeout-ms', '1200000'], ['--transport', 'ollama'], ['--profile', 'existing'], ['--sessions']]) assert.throws(() => parseOptions(args));
});
test('qualification cap assertions detect configured inference, downstream and resource oversubscription', () => {
  const sample = { lanes: { configured: { local: { runnable_turns: 1, inference_requests: 1 }, cloud: { runnable_turns: 2, inference_requests: 4 } },
    downstream: { runnable_turns: 16, inference_requests: 16 }, lanes: [{ lane: 'local', turns: 1, inference_requests: 1 }] },
    resources: { capacity: { tests: 1 }, limits: { tests: 1 } }, checkpoints: { body_bytes: 8, max_body_bytes: 16 },
    cache: { cleanBytes: 8, limitBytes: 16 }, actor_records: 1, actor_limit: 64 };
  assert.doesNotThrow(() => assertCaps(sample));
  const bad = structuredClone(sample); bad.lanes.lanes[0].inference_requests = 2;
  assert.throws(() => assertCaps(bad));
  const resource = structuredClone(sample); resource.resources.capacity.tests = 2;
  assert.throws(() => assertCaps(resource));
  assert.equal(percentile([30, 10, 20], .5), 20); assert.equal(percentile([30, 10, 20], .95), 30);
});
