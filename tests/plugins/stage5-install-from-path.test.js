'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MAX_ARCHIVE_BYTES,
  readPackageAtPath } = require('../../services/main/plugin-local-package-source');
const { createStage5ControlPlane } = require('../../services/plugins/stage5-control-plane');
const { DEVELOPER_UNSIGNED_KEY_ID } = require(
  '../../services/plugins/package/distribution-package-intake'
);
const { createMemoryFsFacade } = require('../../services/plugins/store/fs-facade');

test('readPackageAtPath rejects wrong extensions, oversized sources, and non-files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-plugin-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wrong = path.join(root, 'plugin.zip');
  fs.writeFileSync(wrong, 'bytes');
  const oversized = path.join(root, 'oversized.jenny-plugin');
  fs.closeSync(fs.openSync(oversized, 'w'));
  fs.truncateSync(oversized, MAX_ARCHIVE_BYTES + 1);
  const directory = path.join(root, 'directory.jenny-plugin');
  fs.mkdirSync(directory);

  assert.equal((await readPackageAtPath(wrong)).reason, 'package_extension_invalid');
  assert.equal((await readPackageAtPath('relative.jenny-plugin')).reason,
    'package_path_not_absolute');
  assert.equal((await readPackageAtPath(oversized)).reason, 'package_source_size_invalid');
  assert.equal((await readPackageAtPath(directory)).reason, 'package_source_not_regular_file');
});

test('installPackageFromPath validates the exact payload before reading', async () => {
  let reads = 0;
  const service = createStage5ControlPlane({
    readPackageAtPath: async () => { reads += 1; return { ok: true }; },
    inspectLocalPackage: async () => ({ ok: true }),
  });
  for (const payload of [
    {},
    { client_request_id: 'ok', path: '' },
    { client_request_id: 'Bad', path: 'a.jenny-plugin' },
    { client_request_id: 'ok', path: 'x'.repeat(4097) },
    { client_request_id: 'ok', path: 'a.jenny-plugin', extra: true },
  ]) {
    const result = await service.installPackageFromPath(payload);
    assert.equal(result.reason, 'distribution_request_invalid');
  }
  assert.equal(reads, 0);
});

test('installPackageFromPath carries the developer key discriminator through install', async () => {
  const bytes = Buffer.from('developer package');
  const sourceIdentity = { kind: 'local_package', package_path_digest: 'b'.repeat(64) };
  let contextInput;
  let started;
  const service = createStage5ControlPlane({
    facade: createMemoryFsFacade(),
    readPackageAtPath: async (packagePath) => ({ ok: true, canceled: false, changed: false,
      bytes, sourcePathDigest: 'b'.repeat(64), packagePath }),
    inspectLocalPackage: async () => ({ ok: true, publisher_id: 'acme', plugin_id: 'widget',
      version: '1.0.0', publisher_key_id: DEVELOPER_UNSIGNED_KEY_ID,
      package_record: { signing_key_id: DEVELOPER_UNSIGNED_KEY_ID,
        source_identity: sourceIdentity } }),
    createDistributionContext: async (request, internal) => {
      contextInput = { request, internal };
      return { ok: true, value: { marker: 'context' } };
    },
    distributionController: { startDistributionOperation(request, context) {
      started = { request, context };
      return { ok: true, operation_id: 'install_path' };
    } },
  });

  const result = await service.installPackageFromPath({
    client_request_id: 'install_path', path: 'G:\\plugins\\widget.jenny-plugin',
  });
  assert.equal(result.ok, true);
  assert.equal(contextInput.internal.developerProfile, true);
  assert.equal(contextInput.internal.localPackage.sourceIdentity, undefined);
  assert.equal(contextInput.internal.localPackage.bytes, bytes);
  assert.equal(started.request.operation.kind, 'install');
  assert.equal(started.context.marker, 'context');
});
