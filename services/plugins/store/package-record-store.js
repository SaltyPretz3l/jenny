'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');
const { stableStringify } = require('../package/canonical-metadata');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');
const { PACKAGES_DIR, isValidDigest } = require('./content-store');

const CONTRACT_NAME = 'PluginPackageRecordV1';
const CONTRACT_NAME_V3 = 'PluginPackageRecordV3';
const MAX_PACKAGE_RECORD_SCHEMA_VERSION = 3;
const PACKAGE_RECORD_FILE = 'record.json';

function packageRecordDir(baseDir, digest) {
  return joinPath(baseDir, PACKAGES_DIR, digest);
}

function packageRecordPath(baseDir, digest) {
  return joinPath(packageRecordDir(baseDir, digest), PACKAGE_RECORD_FILE);
}

function immutablePackageIdentity(record) {
  if (record.package_record_schema_version === 3) {
    const { created_at: _createdAt, ...identity } = record;
    return identity;
  }
  const { source_identity: _sourceIdentity, created_at: _createdAt, ...identity } = record;
  return identity;
}

function contractNameForRecord(record) {
  return record?.package_record_schema_version === 3 ? CONTRACT_NAME_V3 : CONTRACT_NAME;
}

async function readPackageRecord(facade, baseDir, digest) {
  if (!isValidDigest(digest)) return { ok: false, reason: 'invalid_digest' };
  const read = await readJsonFile(facade, packageRecordPath(baseDir, digest));
  if (read.status === 'missing') return { ok: false, reason: 'package_record_not_found' };
  if (read.status === 'corrupted') return { ok: false, reason: 'package_record_corrupted', detail: read.error };
  if (Number.isInteger(read.value?.package_record_schema_version)
    && read.value.package_record_schema_version > MAX_PACKAGE_RECORD_SCHEMA_VERSION) {
    return { ok: false, reason: 'package_record_schema_newer', incompatible: true };
  }
  const validated = validate(contractNameForRecord(read.value), read.value);
  if (!validated.ok) return { ok: false, reason: 'package_record_invalid', detail: validated.error };
  if (validated.value.content_digest !== digest) return { ok: false, reason: 'package_record_digest_mismatch' };
  return { ok: true, record: validated.value };
}

async function writePackageRecord(facade, baseDir, { digest, record }) {
  if (!isValidDigest(digest)) return { ok: false, reason: 'invalid_digest' };
  const validated = validate(contractNameForRecord(record), record);
  if (!validated.ok) return { ok: false, reason: 'package_record_invalid', detail: validated.error };
  if (validated.value.content_digest !== digest) return { ok: false, reason: 'package_record_digest_mismatch' };

  const existing = await facade.stat(packageRecordPath(baseDir, digest));
  if (existing.exists) {
    const current = await readPackageRecord(facade, baseDir, digest);
    if (!current.ok) return current;
    if (stableStringify(immutablePackageIdentity(current.record))
      !== stableStringify(immutablePackageIdentity(validated.value))) {
      return { ok: false, reason: 'package_record_immutable_conflict' };
    }
    // The record at a content address is immutable first-acquisition evidence.
    // A later selection of identical bytes is idempotent and preserves it.
    return { ok: true, alreadyExisted: true, record: current.record };
  }

  await writeJsonFileAtomic(
    facade,
    packageRecordDir(baseDir, digest),
    PACKAGE_RECORD_FILE,
    validated.value
  );
  const verified = await readPackageRecord(facade, baseDir, digest);
  if (!verified.ok) return { ok: false, reason: 'package_record_post_write_verification_failed', detail: verified };
  return { ok: true, alreadyExisted: false, record: verified.record };
}

async function removePackageRecord(facade, baseDir, digest) {
  if (!isValidDigest(digest)) return { ok: false, reason: 'invalid_digest' };
  await facade.remove(packageRecordPath(baseDir, digest));
  return { ok: true };
}

module.exports = {
  CONTRACT_NAME,
  CONTRACT_NAME_V3,
  PACKAGE_RECORD_FILE,
  packageRecordPath,
  readPackageRecord,
  writePackageRecord,
  removePackageRecord,
};
