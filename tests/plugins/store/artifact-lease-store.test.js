'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { writeArtifactLease, readActiveArtifactDigests, pruneArtifactLeases } = require('../../../services/plugins/store/artifact-lease-store');
test('artifact leases protect exact digests and stale leases prune', async () => {
  const fs = new MemoryFsFacade(); await writeArtifactLease(fs, 's', { operationId: 'op', digests: ['a'.repeat(64)], expiresAt: '2026-08-05T00:00:00Z' });
  assert.equal((await readActiveArtifactDigests(fs, 's', '2026-08-04T00:00:00Z')).digests.has('a'.repeat(64)), true);
  assert.equal((await pruneArtifactLeases(fs, 's', '2026-08-06T00:00:00Z')).removed, 1);
});
