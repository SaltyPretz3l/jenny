'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { putSource, getSource, readSourceRegistry } = require('../../../services/plugins/store/source-registry-store');
test('source registry is versioned, bounded, and returns ids from writes', async () => {
  const fs = new MemoryFsFacade(); const row = { source_id: 'catalog', kind: 'https_url', locator: 'https://example.test/', updated_at: '2026-08-04T00:00:00Z' };
  assert.deepEqual(await putSource(fs, 'store', row), { ok: true, source_id: 'catalog', revision: 1 });
  assert.equal((await getSource(fs, 'store', 'catalog')).source.locator, row.locator);
  assert.equal((await readSourceRegistry(fs, 'store')).registry.source_registry_schema_version, 1);
});
test('concurrent distinct source writes preserve both rows with monotonic revisions', async () => {
  const fs = new MemoryFsFacade(); const updated_at = '2026-08-04T00:00:00Z';
  const results = await Promise.all([
    putSource(fs, 'store', { source_id: 'a', kind: 'https_url', locator: 'https://a.test/', updated_at }),
    putSource(fs, 'store', { source_id: 'b', kind: 'https_url', locator: 'https://b.test/', updated_at }),
  ]);
  const registry = (await readSourceRegistry(fs, 'store')).registry;
  assert.deepEqual(results.map((result) => result.revision), [1, 2]);
  assert.equal(registry.revision, 2);
  assert.deepEqual(registry.sources.map((source) => source.source_id), ['a', 'b']);
});
test('source registry independently rejects credentials, query state, and unknown fields', async () => {
  const fs = new MemoryFsFacade(); const updated_at = '2026-08-04T00:00:00Z';
  assert.equal((await putSource(fs, 'store', { source_id: 'secret', kind: 'https_url', locator: 'https://u:p@example.test/', updated_at })).reason,
    'source_record_invalid');
  assert.equal((await putSource(fs, 'store', { source_id: 'query', kind: 'git', locator: 'https://example.test/repo?q=secret', updated_at })).reason,
    'source_record_invalid');
  assert.equal((await putSource(fs, 'store', { source_id: 'extra', kind: 'https_url', locator: 'https://example.test/', updated_at, token: 'secret' })).reason,
    'source_record_invalid');
});
