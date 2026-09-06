'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { BaseFetcher } = require('tuf-js');
const { BrokerFetcher, contained, refreshTufRepository } = require('../../../services/plugins/distribution/tuf-repository');
const { DownloadHTTPError } = require('tuf-js/dist/error');
const { metadata, digest, buildSignedTufRepository } = require('../../helpers/plugins/tuf-fixture-builder');
class MapFetcher extends BaseFetcher {
  constructor(files) { super(); this.files = files; }
  async fetch(url) {
    const name = new URL(url).pathname.split('/').pop(); const bytes = this.files.get(name);
    if (!bytes) throw new DownloadHTTPError('missing', 404);
    return new Response(bytes).body;
  }
}
test('TUF fetches only through the broker and accounts bytes', async () => {
  let called = 0; const fetcher = new BrokerFetcher({ broker: { request: async () => { called += 1; return { ok: true, status_code: 200, body: Buffer.from('root') }; } },
    operationId: 'op', consent: {}, deadlineEpochMs: Date.now() + 1000 });
  const reader = (await fetcher.fetch('https://example.test/root.json')).getReader(); const chunk = await reader.read();
  assert.equal(Buffer.from(chunk.value).toString(), 'root'); assert.equal(called, 1); assert.equal(fetcher.totalBytes, 4);
});
test('broker fetcher preserves 403/404 status for normal sequential root completion', async () => {
  const fetcher = new BrokerFetcher({ broker: { request: async () => ({ ok: true, status_code: 404, body: Buffer.alloc(0) }) },
    operationId: 'op', consent: {}, deadlineEpochMs: Date.now() + 1000 });
  await assert.rejects(fetcher.fetch('https://example.test/2.root.json'), (error) => error instanceof DownloadHTTPError && error.statusCode === 404);
});
test('TUF refuses TOFU and filesystem containment is realpath-oriented', async () => {
  assert.match(digest(metadata('root')), /^[0-9a-f]{64}$/);
  assert.equal((await refreshTufRepository({ initialRootBytes: null })).reason, 'tuf_initial_root_required');
  assert.equal(contained('C:\\root', 'C:\\root\\child'), true); assert.equal(contained('C:\\root', 'C:\\escape'), false);
});
test('a failed refresh restores the exact pre-refresh filesystem state', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jenny-tuf-test-'));
  const metadataDir = path.join(root, 'metadata'); const targetDir = path.join(root, 'targets');
  try {
    const result = await refreshTufRepository({ metadataDir, targetDir,
      metadataBaseUrl: 'https://example.test/metadata/', targetBaseUrl: 'https://example.test/targets/',
      initialRootBytes: Buffer.from('{}'), fetcher: { fetch: async () => { throw new Error('unexpected_fetch'); } },
      trustedHighWater: '2026-08-04T00:00:00Z', now: () => Date.parse('2026-08-04T00:00:00Z') });
    assert.equal(result.ok, false); assert.equal(fs.existsSync(metadataDir), false); assert.equal(fs.existsSync(targetDir), false);
    assert.deepEqual((await fs.promises.readdir(root)).filter((name) => name.startsWith('.jenny-tuf-refresh-')), []);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});
test('official updater performs sequential signed root rotation and accepts one coherent snapshot', async () => {
  const fixture = buildSignedTufRepository(); const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jenny-tuf-valid-'));
  try {
    const files = new Map([['2.root.json', fixture.rotatedRootBytes], ['timestamp.json', fixture.timestampBytes],
      ['snapshot.json', fixture.snapshotBytes], ['1.snapshot.json', fixture.snapshotBytes],
      ['targets.json', fixture.targetsBytes], ['1.targets.json', fixture.targetsBytes]]);
    const result = await refreshTufRepository({ metadataDir: path.join(root, 'metadata'), targetDir: path.join(root, 'targets'),
      metadataBaseUrl: 'https://repo.test/metadata/', targetBaseUrl: 'https://repo.test/targets/',
      initialRootBytes: fixture.initialRootBytes, fetcher: new MapFetcher(files), trustedHighWater: '2026-08-04T00:00:00Z',
      now: () => Date.parse('2026-08-04T00:00:00Z') });
    assert.equal(result.ok, true, result.reason); assert.equal(result.accepted.roles.root.version, 2);
    assert.equal(result.accepted.roles.targets.version, 1); assert.equal(result.accepted.targets, 1);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});
test('TUF scratch cleanup failure does not replace a successful refresh', async () => {
  const fixture = buildSignedTufRepository(); const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jenny-tuf-cleanup-test-'));
  const originalRm = fs.promises.rm;
  try {
    fs.promises.rm = async (target, options) => {
      if (path.basename(target).startsWith('.jenny-tuf-refresh-')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return originalRm(target, options);
    };
    const files = new Map([['2.root.json', fixture.rotatedRootBytes], ['timestamp.json', fixture.timestampBytes],
      ['snapshot.json', fixture.snapshotBytes], ['1.snapshot.json', fixture.snapshotBytes],
      ['targets.json', fixture.targetsBytes], ['1.targets.json', fixture.targetsBytes]]);
    const result = await refreshTufRepository({ metadataDir: path.join(root, 'metadata'), targetDir: path.join(root, 'targets'),
      metadataBaseUrl: 'https://repo.test/metadata/', targetBaseUrl: 'https://repo.test/targets/',
      initialRootBytes: fixture.initialRootBytes, fetcher: new MapFetcher(files), trustedHighWater: '2026-08-04T00:00:00Z',
      now: () => Date.parse('2026-08-04T00:00:00Z') });
    assert.equal(result.ok, true, result.reason); assert.equal(result.accepted.targets, 1);
  } finally {
    fs.promises.rm = originalRm;
    await originalRm(root, { recursive: true, force: true });
  }
});
