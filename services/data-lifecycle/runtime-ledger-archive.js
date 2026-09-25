'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const {
  MAX_INDEX_BYTES,
  MAX_WORK_RECORD_BYTES,
  RUNTIME_STORE_SCHEMA_VERSION,
  createIndexDocument,
  pendingCapacityReason,
  stableJson,
  submissionHash,
  validateIndexDocument,
  validateWorkRecord,
  workSummary,
} = require('../session-runtime/contracts');
const { archiveError } = require('./archive-format');

const RUNTIME_LEDGER_DIRECTORY = 'session-runtime';
const MAX_RUNTIME_LEDGER_BYTES = 64 * 1024 * 1024;
const LEDGER_KEYS = Object.freeze(['index', 'records', 'schema_version']);
const PROJECTION_KIND = 'runtime_ledger_projection';
const NONTERMINAL_STATUSES = new Set(['pending', 'paused', 'running', 'needs_attention']);

function ledgerError(source, reason, message, cause) {
  return archiveError(
    source ? DATA_ERROR_CODES.SOURCE_UNREADABLE : DATA_ERROR_CODES.ARCHIVE_CORRUPT,
    reason,
    message,
    cause
  );
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === keys.join('\0'));
}

function readStableJson(filePath, maxBytes, { source = false } = {}) {
  let descriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0);
    descriptor = fs.openSync(filePath, flags);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) {
      throw new Error('invalid_runtime_ledger_document');
    }
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) {
      throw new Error('runtime_ledger_document_changed');
    }
    return { bytes: bytes.subarray(0, offset), value: JSON.parse(bytes.subarray(0, offset)) };
  } catch (error) {
    throw ledgerError(
      source,
      source ? 'runtime_ledger_source_invalid' : 'runtime_ledger_payload_invalid',
      source ? 'Durable runtime state could not be archived safely.' : 'Archived durable runtime state is invalid.',
      error
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function safeDirectoryEntries(directory, { missingAllowed = false, source = false } = {}) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_runtime_ledger_directory');
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (missingAllowed && error?.code === 'ENOENT') return null;
    throw ledgerError(
      source,
      source ? 'runtime_ledger_source_invalid' : 'runtime_ledger_payload_invalid',
      source ? 'Durable runtime state could not be archived safely.' : 'Archived durable runtime state is invalid.',
      error
    );
  }
}

function validateSnapshot(indexValue, records, { source = false } = {}) {
  const indexCheck = validateIndexDocument(indexValue);
  if (!indexCheck.ok) {
    const future = indexCheck.reason === 'future_schema';
    throw archiveError(
      future ? DATA_ERROR_CODES.UNSUPPORTED_VERSION
        : source ? DATA_ERROR_CODES.SOURCE_UNREADABLE : DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      future ? 'unsupported_runtime_ledger_version'
        : source ? 'runtime_ledger_source_invalid' : 'runtime_ledger_payload_invalid',
      future ? 'Durable runtime state uses an unsupported schema version.'
        : source ? 'Durable runtime state could not be archived safely.' : 'Archived durable runtime state is invalid.'
    );
  }
  const capacityReason = pendingCapacityReason(indexCheck.document.pending);
  if (capacityReason) {
    throw ledgerError(source, source ? 'runtime_ledger_source_capacity' : capacityReason,
      source ? 'Durable runtime state exceeds the portable archive bound.'
        : 'Archived durable runtime state exceeds runtime capacity.');
  }
  if (!Array.isArray(records) || records.length !== indexCheck.document.summaries.length) {
    throw ledgerError(source, source ? 'runtime_ledger_source_invalid' : 'runtime_ledger_payload_invalid',
      source ? 'Durable runtime state could not be archived safely.' : 'Archived durable runtime state is invalid.');
  }
  const byId = new Map();
  for (const value of records) {
    const checked = validateWorkRecord(value);
    if (!checked.ok) {
      const future = checked.reason === 'future_schema';
      throw archiveError(
        future ? DATA_ERROR_CODES.UNSUPPORTED_VERSION
          : source ? DATA_ERROR_CODES.SOURCE_UNREADABLE : DATA_ERROR_CODES.ARCHIVE_CORRUPT,
        future ? 'unsupported_runtime_ledger_version'
          : source ? 'runtime_ledger_source_invalid' : 'runtime_ledger_payload_invalid',
        future ? 'Durable runtime state uses an unsupported schema version.'
          : source ? 'Durable runtime state could not be archived safely.' : 'Archived durable runtime state is invalid.'
      );
    }
    if (byId.has(checked.record.work_id)) {
      throw ledgerError(source, source ? 'runtime_ledger_source_invalid' : 'runtime_ledger_payload_invalid',
        source ? 'Durable runtime state could not be archived safely.' : 'Archived durable runtime state is invalid.');
    }
    byId.set(checked.record.work_id, checked.record);
  }
  const ordered = [];
  for (const summary of indexCheck.document.summaries) {
    const record = byId.get(summary.work_id);
    if (!record || stableJson(workSummary(record)) !== stableJson(summary)) {
      throw ledgerError(source, source ? 'runtime_ledger_source_invalid' : 'runtime_ledger_payload_invalid',
        source ? 'Durable runtime state could not be archived safely.' : 'Archived durable runtime state is invalid.');
    }
    ordered.push(record);
  }
  return { index: indexCheck.document, records: ordered };
}

function collectRuntimeLedgerPayload(userDataPath) {
  const root = path.join(path.resolve(userDataPath), RUNTIME_LEDGER_DIRECTORY);
  const rootEntries = safeDirectoryEntries(root, { missingAllowed: true, source: true });
  if (rootEntries === null) return null;
  if (rootEntries.some((entry) => !['index.json', 'work'].includes(entry.name))
    || rootEntries.some((entry) => entry.name === 'index.json' && !entry.isFile())
    || rootEntries.some((entry) => entry.name === 'work' && !entry.isDirectory())
    || !rootEntries.some((entry) => entry.name === 'index.json')) {
    throw ledgerError(true, 'runtime_ledger_source_invalid', 'Durable runtime state could not be archived safely.');
  }
  const indexPath = path.join(root, 'index.json');
  const firstIndex = readStableJson(indexPath, MAX_INDEX_BYTES, { source: true });
  const indexCheck = validateIndexDocument(firstIndex.value);
  if (!indexCheck.ok) return validateSnapshot(firstIndex.value, [], { source: true });
  const workRoot = path.join(root, 'work');
  const workEntries = safeDirectoryEntries(workRoot, { missingAllowed: true, source: true }) || [];
  const expectedNames = new Set(indexCheck.document.summaries.map((entry) => `${entry.work_id}.json`));
  if (workEntries.length !== expectedNames.size || workEntries.some((entry) => (
    !entry.isFile() || !expectedNames.has(entry.name)
  ))) {
    throw ledgerError(true, 'runtime_ledger_source_invalid', 'Durable runtime state could not be archived safely.');
  }
  const records = [];
  let snapshotBytes = firstIndex.bytes.length;
  for (const summary of indexCheck.document.summaries) {
    const document = readStableJson(
      path.join(workRoot, `${summary.work_id}.json`), MAX_WORK_RECORD_BYTES, { source: true }
    );
    snapshotBytes += document.bytes.length;
    if (snapshotBytes > MAX_RUNTIME_LEDGER_BYTES) {
      throw ledgerError(true, 'runtime_ledger_source_capacity',
        'Durable runtime state exceeds the portable archive bound.');
    }
    records.push(document.value);
  }
  const snapshot = validateSnapshot(indexCheck.document, records, { source: true });
  const finalIndex = readStableJson(indexPath, MAX_INDEX_BYTES, { source: true });
  if (!firstIndex.bytes.equals(finalIndex.bytes)) {
    throw ledgerError(true, 'runtime_ledger_source_changed', 'Durable runtime state changed during archive creation.');
  }
  const payload = { schema_version: RUNTIME_STORE_SCHEMA_VERSION,
    index: snapshot.index, records: snapshot.records };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_RUNTIME_LEDGER_BYTES) {
    throw ledgerError(true, 'runtime_ledger_source_capacity', 'Durable runtime state exceeds the portable archive bound.');
  }
  return payload;
}

function importedTransitionId(record) {
  const digest = crypto.createHash('sha256')
    .update(`${record.work_id}\0${record.revision}\0${record.submission_hash}`)
    .digest('hex');
  return `transition_import_${digest}`;
}

function projectRecordForImport(record, now) {
  if (!NONTERMINAL_STATUSES.has(record.status)) return record;
  if (record.revision >= Number.MAX_SAFE_INTEGER || record.authority.root_revision >= Number.MAX_SAFE_INTEGER) {
    throw ledgerError(false, 'runtime_ledger_revision_exhausted',
      'Archived durable runtime state cannot be invalidated safely.');
  }
  const authority = {
    ...record.authority,
    root_path: null,
    root_id: null,
    root_revision: record.authority.root_revision + 1,
    device_id: null,
    inode: null,
  };
  const projected = {
    ...record,
    authority,
    status: 'paused',
    revision: record.revision + 1,
    submission_hash: submissionHash({ authority, input: record.input,
      project_id: record.project_id, purpose: record.purpose, session_id: record.session_id }),
    updated_at: now,
    transition: {
      transition_id: importedTransitionId(record),
      from: record.status,
      to: 'paused',
      reason: 'Paused during portable restore for project and authority review.',
      at: now,
    },
    recovery: record.recovery || {
      kind: 'restart_paused',
      previous_status: record.status,
      reason: 'Imported work requires explicit project and authority review.',
      at: now,
    },
  };
  const checked = validateWorkRecord(projected);
  if (!checked.ok) {
    throw ledgerError(false, 'runtime_ledger_payload_invalid',
      'Archived durable runtime state could not be made safe for import.');
  }
  return checked.record;
}

function projectRuntimeLedgerPayload(payload, { now = new Date().toISOString() } = {}) {
  if (payload?.schema_version > RUNTIME_STORE_SCHEMA_VERSION) {
    throw archiveError(DATA_ERROR_CODES.UNSUPPORTED_VERSION, 'unsupported_runtime_ledger_version',
      'Archived durable runtime state uses an unsupported schema version.');
  }
  if (!exactKeys(payload, LEDGER_KEYS) || payload.schema_version !== RUNTIME_STORE_SCHEMA_VERSION) {
    throw ledgerError(false, 'runtime_ledger_payload_invalid', 'Archived durable runtime state is invalid.');
  }
  const snapshot = validateSnapshot(payload.index, payload.records);
  const records = snapshot.records.map((record) => projectRecordForImport(record, now));
  const index = createIndexDocument(records.map(workSummary), snapshot.index.revision + 1,
    snapshot.index.next_submission_sequence);
  const checkedIndex = validateIndexDocument(index);
  const capacityReason = checkedIndex.ok && pendingCapacityReason(checkedIndex.document.pending);
  if (!checkedIndex.ok || capacityReason) {
    throw ledgerError(false, capacityReason || 'runtime_ledger_payload_invalid',
      'Archived durable runtime state cannot be restored within runtime limits.');
  }
  const files = records.map((record) => ({
    relativePath: path.join('work', `${record.work_id}.json`),
    bytes: Buffer.from(JSON.stringify(record), 'utf8'),
  }));
  files.push({ relativePath: 'index.json', bytes: Buffer.from(JSON.stringify(checkedIndex.document), 'utf8') });
  const totalBytes = files.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (totalBytes > MAX_RUNTIME_LEDGER_BYTES) {
    throw ledgerError(false, 'runtime_ledger_payload_capacity',
      'Archived durable runtime state exceeds the portable restore bound.');
  }
  return Object.freeze({ kind: PROJECTION_KIND, files: Object.freeze(files) });
}

function isRuntimeLedgerProjection(value) {
  return value?.kind === PROJECTION_KIND && Array.isArray(value.files);
}

function pathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function captureDirectoryIdentity(directory, owner = null) {
  const lexical = path.resolve(directory);
  const lexicalStat = fs.lstatSync(lexical);
  if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path',
      'Runtime restore destination is unsafe.');
  }
  const real = fs.realpathSync.native(lexical);
  const realStat = fs.statSync(real);
  if (!realStat.isDirectory() || (owner && !pathWithin(owner.real, real))) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path',
      'Runtime restore destination escapes its owner root.');
  }
  return Object.freeze({ lexical, real, dev: String(realStat.dev), ino: String(realStat.ino) });
}

function assertDirectoryIdentity(identity, owner = null) {
  const current = captureDirectoryIdentity(identity.lexical, owner);
  if (current.real !== identity.real || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'restore_destination_changed',
      'Runtime restore destination changed during publication.');
  }
}

function projectionParent(relativePath, rootIdentity, workIdentity) {
  if (relativePath === 'index.json') return rootIdentity;
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  if (!/^work\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/u.test(normalized)) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'runtime_ledger_payload_invalid',
      'Runtime restore projection contains an invalid path.');
  }
  return workIdentity;
}

function publishRuntimeLedgerProjection(targetRoot, projection, { ownerRoot = path.dirname(targetRoot) } = {}) {
  if (!isRuntimeLedgerProjection(projection)) throw new TypeError('runtime ledger projection is required');
  const ownerIdentity = captureDirectoryIdentity(ownerRoot);
  const resolvedTarget = path.resolve(targetRoot);
  if (!pathWithin(ownerIdentity.lexical, resolvedTarget) || resolvedTarget === ownerIdentity.lexical) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_restore_path',
      'Runtime restore destination escapes its owner root.');
  }
  assertDirectoryIdentity(ownerIdentity);
  fs.mkdirSync(resolvedTarget, { recursive: false, mode: 0o700 });
  const rootIdentity = captureDirectoryIdentity(resolvedTarget, ownerIdentity);
  assertDirectoryIdentity(ownerIdentity);
  assertDirectoryIdentity(rootIdentity, ownerIdentity);
  const workRoot = path.join(resolvedTarget, 'work');
  fs.mkdirSync(workRoot, { recursive: false, mode: 0o700 });
  const workIdentity = captureDirectoryIdentity(workRoot, rootIdentity);
  const names = new Set();
  for (const file of projection.files) {
    const parentIdentity = projectionParent(file.relativePath, rootIdentity, workIdentity);
    const targetPath = path.join(resolvedTarget, file.relativePath);
    const normalizedTarget = path.resolve(targetPath).toLocaleLowerCase('en-US');
    if (names.has(normalizedTarget) || !Buffer.isBuffer(file.bytes)) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'runtime_ledger_payload_invalid',
        'Runtime restore projection is invalid.');
    }
    names.add(normalizedTarget);
    assertDirectoryIdentity(ownerIdentity);
    assertDirectoryIdentity(rootIdentity, ownerIdentity);
    assertDirectoryIdentity(parentIdentity, parentIdentity === rootIdentity ? ownerIdentity : rootIdentity);
    let descriptor;
    try {
      const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
        | (fs.constants.O_NOFOLLOW || 0);
      descriptor = fs.openSync(targetPath, flags, 0o600);
      fs.writeFileSync(descriptor, file.bytes);
      fs.fsyncSync(descriptor);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.bytes.length) {
        throw new Error('runtime_ledger_publish_invalid_file');
      }
      const actual = Buffer.allocUnsafe(file.bytes.length);
      const count = fs.readSync(descriptor, actual, 0, actual.length, 0);
      if (count !== actual.length || !actual.equals(file.bytes)) {
        throw new Error('runtime_ledger_publish_mismatch');
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    try {
      assertDirectoryIdentity(ownerIdentity);
      assertDirectoryIdentity(rootIdentity, ownerIdentity);
      assertDirectoryIdentity(parentIdentity, parentIdentity === rootIdentity ? ownerIdentity : rootIdentity);
      const targetStat = fs.lstatSync(targetPath);
      const realTarget = fs.realpathSync.native(targetPath);
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || !pathWithin(parentIdentity.real, realTarget)) {
        throw new Error('runtime_ledger_publish_escaped');
      }
    } catch (error) {
      try { fs.unlinkSync(targetPath); } catch (_cleanupError) { /* Rollback owns remaining cleanup. */ }
      throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'restore_destination_changed',
        'Runtime restore destination changed during publication.', error);
    }
  }
}

function isUntouchedRuntimeBootstrap(userDataPath) {
  const root = path.join(path.resolve(userDataPath), RUNTIME_LEDGER_DIRECTORY);
  try {
    const entries = safeDirectoryEntries(root, { missingAllowed: true });
    if (entries === null) return true;
    if (entries.some((entry) => !['index.json', 'work'].includes(entry.name))) return false;
    const work = entries.find((entry) => entry.name === 'work');
    if (work && (!work.isDirectory() || safeDirectoryEntries(path.join(root, 'work')).length)) return false;
    const index = entries.find((entry) => entry.name === 'index.json');
    if (!index?.isFile()) return false;
    const checked = validateIndexDocument(readStableJson(path.join(root, 'index.json'), MAX_INDEX_BYTES).value);
    return checked.ok && checked.document.revision === 0
      && checked.document.next_submission_sequence === 1
      && checked.document.summaries.length === 0;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  MAX_RUNTIME_LEDGER_BYTES,
  RUNTIME_LEDGER_DIRECTORY,
  collectRuntimeLedgerPayload,
  isRuntimeLedgerProjection,
  isUntouchedRuntimeBootstrap,
  projectRuntimeLedgerPayload,
  publishRuntimeLedgerProjection,
};
