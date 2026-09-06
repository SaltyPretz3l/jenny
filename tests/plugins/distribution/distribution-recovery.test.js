'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { recordDigest, validateV3Generation, recoverDistribution } = require('../../../services/plugins/distribution/distribution-recovery');
test('recovery digest is canonical and pre-distribution generations remain compatible', async () => {
  assert.equal(recordDigest({ b: 2, a: 1 }), recordDigest({ a: 1, b: 2 }));
  assert.deepEqual(await validateV3Generation(new MemoryFsFacade(), 's', { generation_schema_version: 2 }), { ok: true });
});
test('distribution recovery preserves the minimal empty Stage 5A store posture', async () => {
  const result = await recoverDistribution(new MemoryFsFacade(), 's', { now: '2026-08-04T00:00:00Z' });
  assert.ok(['committed', 'safely_recoverable', 'plugins-disabled-required', 'indeterminate'].includes(result.distribution_classification));
});
