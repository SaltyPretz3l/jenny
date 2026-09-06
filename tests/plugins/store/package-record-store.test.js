'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { sha256Hex } = require('../../../services/plugins/store/content-store');
const {
  packageRecordPath,
  readPackageRecord,
  writePackageRecord,
  removePackageRecord,
} = require('../../../services/plugins/store/package-record-store');
const { verifiedPackageVerdict } = require('../../helpers/plugins/durability-scenario');

const BASE_DIR = 'plugins';

function recordFixture(bytes = 'package-bytes') {
  return verifiedPackageVerdict({ packageBytes: bytes }).package_record;
}

function stage5Record(digest, overrides = {}) {
  return {
    package_record_schema_version: 3,
    publisher_id: 'acme-labs', plugin_id: 'remote', package_semver: '1.0.0',
    content_digest: digest, canonical_metadata_digest: '1'.repeat(64),
    signing_key_id: '2'.repeat(64),
    source_identity: { kind: 'https_url', url_digest: '3'.repeat(64) },
    archive_bytes: 5, entry_count: 1, uncompressed_bytes: 5,
    verification_cache_key: '4'.repeat(64), created_at: '2026-08-04T20:00:00Z',
    ...overrides,
  };
}

test('immutable package record round-trips beside its digest and identical retries are idempotent', async () => {
  const facade = createMemoryFsFacade();
  const record = recordFixture();
  const digest = sha256Hex('package-bytes');
  const first = await writePackageRecord(facade, BASE_DIR, { digest, record });
  assert.deepEqual({ ok: first.ok, alreadyExisted: first.alreadyExisted }, { ok: true, alreadyExisted: false });
  assert.equal(packageRecordPath(BASE_DIR, digest), `plugins/packages/${digest}/record.json`);
  assert.deepEqual((await readPackageRecord(facade, BASE_DIR, digest)).record, record);

  const second = await writePackageRecord(facade, BASE_DIR, { digest, record });
  assert.deepEqual({ ok: second.ok, alreadyExisted: second.alreadyExisted }, { ok: true, alreadyExisted: true });

  const laterAcquisition = {
    ...record,
    created_at: '2026-08-03T00:00:00Z',
    source_identity: { kind: 'local_package', package_path_digest: 'f'.repeat(64) },
  };
  const later = await writePackageRecord(facade, BASE_DIR, { digest, record: laterAcquisition });
  assert.equal(later.ok, true);
  assert.deepEqual(later.record, record, 'first-acquisition evidence remains immutable');
});

test('digest mismatch and immutable replacement attempts fail closed', async () => {
  const facade = createMemoryFsFacade();
  const digest = sha256Hex('package-bytes');
  const record = recordFixture();
  assert.equal((await writePackageRecord(facade, BASE_DIR, {
    digest: 'f'.repeat(64), record,
  })).reason, 'package_record_digest_mismatch');

  await writePackageRecord(facade, BASE_DIR, { digest, record });
  const changed = {
    ...record,
    canonical_metadata_digest: 'e'.repeat(64),
  };
  assert.equal((await writePackageRecord(facade, BASE_DIR, { digest, record: changed })).reason, 'package_record_immutable_conflict');
});

test('corrupt records are preserved as evidence until explicit digest cleanup', async () => {
  const facade = createMemoryFsFacade();
  const digest = sha256Hex('package-bytes');
  await facade.mkdir(`plugins/packages/${digest}`);
  await facade.writeFile(packageRecordPath(BASE_DIR, digest), '{bad json');
  assert.equal((await readPackageRecord(facade, BASE_DIR, digest)).reason, 'package_record_corrupted');
  assert.equal((await removePackageRecord(facade, BASE_DIR, digest)).ok, true);
  assert.equal((await readPackageRecord(facade, BASE_DIR, digest)).reason, 'package_record_not_found');
  assert.equal((await removePackageRecord(facade, BASE_DIR, 'not-a-digest')).reason, 'invalid_digest');
});

test('V3 package records preserve exact source identity while V1 compatibility is unchanged', async () => {
  const facade = createMemoryFsFacade();
  const digest = sha256Hex('bytes');
  const record = stage5Record(digest);
  assert.equal((await writePackageRecord(facade, BASE_DIR, { digest, record })).ok, true);
  assert.deepEqual((await readPackageRecord(facade, BASE_DIR, digest)).record, record);
  const drifted = stage5Record(digest, {
    source_identity: { kind: 'https_url', url_digest: '9'.repeat(64) },
  });
  assert.equal((await writePackageRecord(facade, BASE_DIR, { digest, record: drifted })).reason,
    'package_record_immutable_conflict');
});
