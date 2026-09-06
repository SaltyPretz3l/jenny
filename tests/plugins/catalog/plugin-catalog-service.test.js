'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PluginCatalogService } = require('../../../services/plugins/catalog/plugin-catalog-service');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { cleanupTrackedResources, trackDirectory } = require('../../helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function tempDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(directory);
  return directory;
}

function rootSource(sourceId, kind = 'remote', extra = {}) {
  const root = Buffer.from('{"signed":{"_type":"root"}}');
  return { catalog_source_schema_version: 1, source_id: sourceId, kind,
    display_name: sourceId, root_fingerprint: crypto.createHash('sha256').update(root).digest('hex'),
    pinned_root_base64: root.toString('base64'),
    ...(kind === 'remote' ? { metadata_base_url: `https://${sourceId}.example.test/metadata/`,
      target_base_url: `https://${sourceId}.example.test/targets/` } : { real_root: 'X:\\mirror' }),
    ...extra };
}

function createService(overrides = {}) {
  const calls = [];
  const facade = overrides.facade || createMemoryFsFacade();
  const distributionController = overrides.distributionController || {
    async startDistributionOperation(request, context) { calls.push({ request, context }); return { ok: true }; },
    async selectOfflineMirror(payload) { calls.push({ select: payload }); return { ok: true }; },
    async recover() { calls.push({ recover: true }); return { ok: true, recovered: true }; },
  };
  const service = new PluginCatalogService({ facade, baseDir: 'plugins',
    cacheRoot: tempDirectory('jenny-plugin-catalog-cache-'), distributionController,
    createDistributionContext: overrides.createDistributionContext
      || (async () => ({ ok: true, value: { marker: 'context' } })),
    configuredSources: overrides.configuredSources || [],
    confirmOfflineTrust: overrides.confirmOfflineTrust || (async () => true),
    realpath: overrides.realpath || (async (value) => value), now: () => '2026-08-17T00:00:00Z' });
  return { service, calls, facade };
}

test('empty configuration is a successful truthful empty catalog', async () => {
  const { service } = createService();
  assert.deepEqual(await service.getCatalogState(), { ok: true, schema_version: 1, revision: 0,
    configured: false, empty_reason: 'no_catalog_sources_configured', sources: [], entries: [] });
  assert.equal((await service.refreshCatalogs()).ok, true);
});

test('one failed source cannot suppress a valid source', async () => {
  const { service } = createService({ configuredSources: [rootSource('good'), rootSource('bad')] });
  service._refreshSource = async (source) => source.source_id === 'bad'
    ? { ok: false, reason: 'synthetic_bad_source' }
    : { ok: true, entries: [{ catalog_entry_schema_version: 1, source_id: 'good',
      publisher_id: 'acme', plugin_id: 'notes', display_name: 'Notes', version: '1.0.0',
      summary: 'Verified', package_size_bytes: 8, package_sha256: 'd'.repeat(64),
      target_path: 'notes.zip' }], advisorySnapshot: { advisories: [] }, quarantined_plugins: [] };
  const state = await service.refreshCatalogs();
  assert.equal(state.ok, true);
  assert.equal(state.entries.length, 1);
  assert.deepEqual(state.refresh_results, [{ source_id: 'good', ok: true, entry_count: 1 },
    { source_id: 'bad', ok: false, reason: 'synthetic_bad_source' }]);
  assert.equal(state.sources.find((row) => row.source_id === 'bad').status, 'failed');
});

test('failed automatic quarantine withholds that source catalog entries', async () => {
  const distributionController = {
    async startDistributionOperation() { return { ok: false, reason: 'synthetic_quarantine_failure' }; },
    async selectOfflineMirror() { return { ok: true }; },
    async recover() { return { ok: true }; },
  };
  const { service } = createService({ configuredSources: [rootSource('advised')],
    distributionController });
  service._refreshSource = async () => ({ ok: true, entries: [{
    catalog_entry_schema_version: 1, source_id: 'advised', publisher_id: 'acme',
    plugin_id: 'notes', display_name: 'Notes', version: '1.0.0', summary: 'Verified',
    package_size_bytes: 8, package_sha256: 'd'.repeat(64), target_path: 'notes.zip',
  }], advisorySnapshot: { revision: 1, advisories: [{ publisher_id: 'acme', plugin_id: 'notes',
    quarantine: true }], revoked_artifacts: [], revoked_keys: [] },
  quarantined_plugins: ['acme/notes'] });
  const state = await service.refreshCatalogs();
  assert.deepEqual(state.entries, []);
  assert.deepEqual(state.refresh_results, [{ source_id: 'advised', ok: false,
    reason: 'catalog_quarantine_failed' }]);
  assert.equal(state.sources[0].status, 'failed');
});

test('offline mirror trust review sees only identity and fingerprint', async () => {
  const mirror = tempDirectory('jenny-plugin-mirror-');
  fs.mkdirSync(path.join(mirror, 'metadata'));
  fs.writeFileSync(path.join(mirror, 'metadata', 'root.json'), '{"signed":{"_type":"root"}}', 'utf8');
  let reviewed;
  const { service, calls } = createService({
    realpath: async (value) => (value === 'renderer-supplied-path-is-not-trusted'
      ? mirror : fs.promises.realpath(value)),
    confirmOfflineTrust: async (identity) => { reviewed = identity; return true; } });
  const result = await service.trustOfflineMirror({ source_id: 'usb', display_name: 'Release USB',
    root_path: 'renderer-supplied-path-is-not-trusted' });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(reviewed).sort(), ['display_name', 'root_fingerprint', 'source_id']);
  assert.equal(JSON.stringify(reviewed).includes(mirror), false);
  assert.equal('real_root' in result.source, false);
  assert.equal('pinned_root_base64' in result.source, false);
  assert.deepEqual(calls[0].select, { sourceId: 'usb', rootPath: mirror });
});

test('offline mirror trust rejects a metadata root that resolves outside the mirror', async (t) => {
  const mirror = tempDirectory('jenny-plugin-mirror-escape-');
  const outside = tempDirectory('jenny-plugin-mirror-outside-');
  fs.writeFileSync(path.join(outside, 'root.json'), '{"signed":{"_type":"root"}}', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(mirror, 'metadata'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('symlink or junction creation is unavailable');
      return;
    }
    throw error;
  }
  let reviewed = false;
  const { service } = createService({ realpath: fs.promises.realpath,
    confirmOfflineTrust: async () => { reviewed = true; return true; } });
  const result = await service.trustOfflineMirror({ source_id: 'escaped', display_name: 'Escaped',
    root_path: mirror });
  assert.equal(result.ok, false);
  assert.equal(reviewed, false);
});

test('catalog install uses only the refreshed verified target and preserves digest checks', async () => {
  const { service, calls } = createService();
  const bytes = Buffer.from('package!');
  const packageFile = path.join(tempDirectory('jenny-plugin-target-'), 'notes.zip');
  fs.writeFileSync(packageFile, bytes);
  const entry = { catalog_entry_schema_version: 1, source_id: 'usb', publisher_id: 'acme',
    plugin_id: 'notes', display_name: 'Notes', version: '1.0.0', summary: '',
    package_size_bytes: bytes.length, package_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    target_path: 'notes.zip' };
  service.entries.set('usb/acme/notes/1.0.0', entry);
  service.runtimeTargets.set('usb', new Map([['acme/notes/1.0.0', { entry, updater: {
    getTargetInfo: async () => ({ length: bytes.length }), downloadTarget: async () => packageFile,
  } }]]));
  service.advisorySnapshots.set('usb', { revision: 0, advisories: [],
    revoked_artifacts: [], revoked_keys: [] });
  service._sources = async () => ({ ok: true, revision: 0, sources: [rootSource('usb', 'offline_mirror')] });
  const result = await service.installFromCatalog({ source_id: 'usb', publisher_id: 'acme',
    plugin_id: 'notes', version: '1.0.0', package_sha256: entry.package_sha256 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].select, { sourceId: 'usb', rootPath: 'X:\\mirror' });
  assert.equal(calls[1].request.operation.kind, 'install');
  assert.equal(calls[1].request.operation.source_kind, 'offline_mirror');
  assert.equal(calls[1].context.sourceId, 'usb');
  assert.equal(calls[1].context.tufRootDigest, rootSource('usb').root_fingerprint);
  assert.match(calls[1].context.advisoryDigest, /^[0-9a-f]{64}$/);
  const acquired = await calls[1].context.acquireCatalogTarget({});
  assert.equal(acquired.ok, true);
  assert.deepEqual(acquired.bytes, bytes);
  assert.equal(JSON.stringify(result).includes(packageFile), false);
  assert.deepEqual(await service.installFromCatalog({ ...entry, source_id: 'usb',
    package_sha256: '0'.repeat(64) }), { ok: false, reason: 'catalog_target_stale' });
});

test('catalog update preserves verified source and advisory evidence', async () => {
  const contexts = [];
  const { service } = createService({ configuredSources: [rootSource('stable')],
    distributionController: {
      async startDistributionOperation(request, context) {
        contexts.push({ request, context });
        return { ok: true };
      },
      async selectOfflineMirror() { return { ok: true }; },
      async recover() { return { ok: true }; },
    } });
  const entry = { catalog_entry_schema_version: 1, source_id: 'stable', publisher_id: 'acme',
    plugin_id: 'notes', display_name: 'Notes', version: '2.0.0', summary: '',
    package_size_bytes: 8, package_sha256: 'd'.repeat(64), target_path: 'notes.zip' };
  const snapshot = { revision: 4, advisories: [], revoked_artifacts: [], revoked_keys: [] };
  service.entries.set('stable/acme/notes/2.0.0', entry);
  service.advisorySnapshots.set('stable', snapshot);
  service._committedState = async () => ({ pointer: { generation_id: 'gen-current' },
    generation: { plugins: [] } });
  const result = await service.updateFromCatalog({ source_id: 'stable', publisher_id: 'acme',
    plugin_id: 'notes', version: '2.0.0', package_sha256: entry.package_sha256 });
  assert.equal(result.ok, true);
  assert.equal(contexts[0].request.operation.kind, 'update');
  assert.equal(contexts[0].context.sourceId, 'stable');
  assert.equal(contexts[0].context.updateSourceKind, 'signed_catalog');
  assert.deepEqual(contexts[0].context.advisorySnapshot, snapshot);
  assert.equal(contexts[0].context.tufRootDigest, rootSource('stable').root_fingerprint);
});

test('malformed advisories fail closed and preserve revocation evidence', () => {
  const { service } = createService();
  const valid = service._validatedAdvisories({ revision: 7, advisories: [{
    advisory_id: 'ADV-1', publisher_id: 'acme', plugin_id: 'notes', version_range: '<2.0.0',
    action: 'quarantine', severity: 'high',
  }], revoked_artifacts: ['a'.repeat(64)], revoked_keys: ['b'.repeat(64)] });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value.revoked_artifacts, ['a'.repeat(64)]);
  assert.deepEqual(valid.value.revoked_keys, ['b'.repeat(64)]);
  assert.deepEqual(service._validatedAdvisories({ revision: 1, advisories: [{
    publisher_id: 'acme', plugin_id: 'notes', version_range: '*', action: 'force',
  }], revoked_artifacts: [], revoked_keys: [] }), {
    ok: false, reason: 'advisory_snapshot_invalid',
  });
});

test('artifact and publisher-key revocations quarantine installed plugins', () => {
  const { service } = createService();
  const snapshot = { revision: 2, advisories: [], revoked_artifacts: ['a'.repeat(64)],
    revoked_keys: ['b'.repeat(64)] };
  const result = service._quarantinedPlugins(snapshot, { generation: { plugins: [{
    publisher_id: 'acme', plugin_id: 'artifact-revoked', resolved_version: '1.0.0',
    artifact_digest: 'a'.repeat(64), publisher_key_id: 'c'.repeat(64),
  }, {
    publisher_id: 'acme', plugin_id: 'key-revoked', resolved_version: '1.0.0',
    artifact_digest: 'd'.repeat(64), publisher_key_id: 'b'.repeat(64),
  }] } });
  assert.deepEqual(result, { ok: true, value: ['acme/artifact-revoked', 'acme/key-revoked'] });
});

test('refresh calls coalesce so an older completion cannot overwrite newer state', async () => {
  const { service } = createService({ configuredSources: [rootSource('stable')] });
  let releases;
  let calls = 0;
  service._refreshSource = async () => {
    calls += 1;
    await new Promise((resolve) => { releases = resolve; });
    return { ok: true, entries: [], runtimeTargets: new Map(), advisorySnapshot: {
      revision: 0, advisories: [], revoked_artifacts: [], revoked_keys: [],
    }, quarantined_plugins: [] };
  };
  const first = service.refreshCatalogs();
  const second = service.refreshCatalogs();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releases();
  assert.deepEqual(await first, await second);
  assert.equal(service.revision, 1);
});

test('app-configured source identity cannot be shadowed by an offline mirror', async () => {
  const mirror = tempDirectory('jenny-plugin-mirror-collision-');
  fs.mkdirSync(path.join(mirror, 'metadata'));
  fs.writeFileSync(path.join(mirror, 'metadata', 'root.json'),
    '{"signed":{"_type":"root"}}', 'utf8');
  let reviewed = false;
  const { service } = createService({ configuredSources: [rootSource('stable')],
    realpath: fs.promises.realpath,
    confirmOfflineTrust: async () => { reviewed = true; return true; } });
  assert.deepEqual(await service.trustOfflineMirror({ source_id: 'stable', display_name: 'USB',
    root_path: mirror }), { ok: false, reason: 'catalog_source_identity_conflict' });
  assert.equal(reviewed, false);
  const state = await service.getCatalogState();
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0].kind, 'remote');
});

test('safe recovery is delegated without renderer-controlled force release', async () => {
  const { service, calls } = createService();
  assert.deepEqual(await service.retryRecovery(), { ok: true, recovered: true });
  assert.deepEqual(calls, [{ recover: true }]);
  assert.equal(typeof service.forceReleaseQuarantine, 'undefined');
});
