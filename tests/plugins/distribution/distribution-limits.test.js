'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { LIMITS } = require('../../../services/plugins/distribution/distribution-limits');
test('Stage 5B limits freeze TUF and Git deadlines', () => { assert.equal(LIMITS.refreshMs, 60000); assert.equal(LIMITS.gitMs, 120000); assert.equal(LIMITS.retainedGenerations, 3); });
