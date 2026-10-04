'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { LIMITS } = require('../../../services/plugins/distribution/distribution-limits');
test('Stage 5B limits keep the retained-generation cap and drop the TUF keys', () => {
  assert.equal(LIMITS.retainedGenerations, 3);
  for (const key of ['refreshMs', 'rootRotations', 'delegatedRoles', 'targets']) assert.equal(Object.hasOwn(LIMITS, key), false, key);
});
