'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { putEvidence, getEvidence } = require('../../../services/plugins/store/distribution-evidence-store');
test('canonical evidence is stored and reverified by digest', async () => {
  const fs = new MemoryFsFacade(); const put = await putEvidence(fs, 's', 'lock', { z: 1, a: 2 });
  assert.equal(put.ok, true); assert.deepEqual((await getEvidence(fs, 's', 'lock', put.digest)).value, { z: 1, a: 2 });
});
