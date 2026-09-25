'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const {
  stableJson,
  strictHeader,
  validateHistoricalEntryAgainst,
} = require('../backend/runtime-continuation-records');
const {
  exportPendingContinuationsForArchive,
  validatePendingContinuationsArchive,
} = require('../backend/runtime-continuation-store');
const {
  readPortableCheckpointSnapshot,
  validatePortableCheckpointSnapshot,
} = require('../session-runtime/checkpoint-store');
const {
  readPortableBudgetSnapshot,
  validatePortableBudgetSnapshot,
} = require('../session-runtime/budgets');
const { readPortableLineageSnapshot } = require('../session-runtime/lineage-store');
const { validatePortableLineageSnapshot } = require('../session-runtime/lineage-contracts');
const { validateLineageCrosslinks, projectLineageForImport } = require('./runtime-lineage-archive');
const { decodeContinuation } = require('../session-runtime/continuation-contracts');
const { normalizeCheckpointRef } = require('../session-runtime/contracts');
const { assertRetirementWork } = require('../session-runtime/checkpoint-retirement');
const { archiveError } = require('./archive-format');
const runtimeLedgerArchive = require('./runtime-ledger-archive');

const RUNTIME_COORDINATION_SCHEMA_VERSION = 2;
const MAX_RUNTIME_COORDINATION_BYTES = 128 * 1024 * 1024;
const CHECKPOINT_DIRECTORY = 'session-runtime-checkpoints';
const BUDGET_DIRECTORY = 'session-runtime-budgets';
const LINEAGE_DIRECTORY = 'session-runtime-lineage';
const PROJECTION_KIND = 'runtime_coordination_projection_v2';
const PAYLOAD_KEYS = ['canonical_sessions', 'checkpoints', 'root_run_budgets', 'schema_version'];

function fail(reason, message = 'Archived runtime coordination state is invalid.', code = DATA_ERROR_CODES.ARCHIVE_CORRUPT) {
  throw archiveError(code, reason, message);
}

function exact(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateRuntimeCoordinationPayload(value) {
  if (Number(value?.schema_version) > RUNTIME_COORDINATION_SCHEMA_VERSION) {
    fail('unsupported_runtime_coordination_version',
      'Archived runtime coordination state uses an unsupported schema version.',
      DATA_ERROR_CODES.UNSUPPORTED_VERSION);
  }
  const legacy = value?.schema_version === 1;
  if (!exact(value, legacy ? PAYLOAD_KEYS : [...PAYLOAD_KEYS, 'lineage'])
    || (!legacy && value.schema_version !== RUNTIME_COORDINATION_SCHEMA_VERSION)) {
    fail('runtime_coordination_payload_invalid');
  }
  let checkpoints;
  let budgets;
  let lineage;
  let canonicalSessions;
  try {
    checkpoints = validatePortableCheckpointSnapshot(value.checkpoints);
    budgets = validatePortableBudgetSnapshot(value.root_run_budgets);
    lineage = validatePortableLineageSnapshot(legacy ? { schema_version: 1, records: [] } : value.lineage);
    canonicalSessions = validatePendingContinuationsArchive(value.canonical_sessions);
  } catch (error) {
    fail(String(error?.code || error?.message || 'runtime_coordination_payload_invalid').slice(0, 128));
  }
  const normalized = { schema_version: 2, checkpoints, lineage,
    root_run_budgets: budgets, canonical_sessions: canonicalSessions };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_RUNTIME_COORDINATION_BYTES) {
    fail('runtime_coordination_payload_capacity');
  }
  return Object.freeze(normalized);
}

function collectRuntimeCoordinationPayload(runtimeArchivePort) {
  if (!runtimeArchivePort || typeof runtimeArchivePort.capturePortableState !== 'function') return null;
  const captured = runtimeArchivePort.capturePortableState();
  const payload = validateRuntimeCoordinationPayload({ schema_version: 2,
    lineage: Object.hasOwn(captured, 'lineage') ? captured.lineage : { schema_version: 1, records: [] },
    checkpoints: captured.checkpoints, root_run_budgets: captured.root_run_budgets,
    canonical_sessions: captured.canonical_sessions });
  return payload.checkpoints.records.length || payload.root_run_budgets.records.length
    || payload.canonical_sessions.sessions.length || payload.lineage.records.length ? payload : null;
}

function createOfflineRuntimeArchivePort({ userDataPath, sessionStore } = {}) {
  const root = path.resolve(String(userDataPath || ''));
  if (!String(userDataPath || '').trim() || !sessionStore?.conversationStore) {
    throw new TypeError('offline runtime archive dependencies invalid');
  }
  return Object.freeze({
    capturePortableState() {
      const runtimeLedger = runtimeLedgerArchive.collectRuntimeLedgerPayload(root);
      const works = new Map((runtimeLedger?.records || []).map(work => [work.work_id, work]));
      return Object.freeze({
        checkpoints: readPortableCheckpointSnapshot(path.join(root, CHECKPOINT_DIRECTORY)),
        root_run_budgets: readPortableBudgetSnapshot(path.join(root, BUDGET_DIRECTORY)),
        lineage: readPortableLineageSnapshot(path.join(root, LINEAGE_DIRECTORY)),
        canonical_sessions: exportPendingContinuationsForArchive(sessionStore, {
          getWork: workId => works.get(workId) || null,
        }),
      });
    },
  });
}

function referenceForCheckpoint(document) {
  if (document.state === 'retired') return { reference: document.reference, retired: document };
  const body = Buffer.from(document.body, 'base64');
  const continuation = decodeContinuation(body);
  return { continuation, reference: normalizeCheckpointRef({ schema_version: 1,
    checkpoint_id: continuation.identity.checkpoint_id,
    sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length,
    source_attempt: continuation.source_attempt }) };
}

function validateRuntimeCoordinationCrosslinks(value, { runtimeLedger = null, sessions = new Map() } = {}) {
  const payload = validateRuntimeCoordinationPayload(value);
  const works = new Map((runtimeLedger?.records || []).map(work => [work.work_id, work]));
  if ((payload.checkpoints.records.length || payload.canonical_sessions.sessions.length) && !works.size) {
    fail('runtime_coordination_ledger_missing');
  }
  try { validateLineageCrosslinks(payload.lineage, { works, sessions, budgets: payload.root_run_budgets }); }
  catch (error) { fail(error.code || 'runtime_lineage_crosslink_invalid'); }
  const checkpoints = new Map();
  for (const item of payload.checkpoints.records) {
    if (checkpoints.has(item.checkpoint_id)) fail('runtime_coordination_crosslink_invalid');
    checkpoints.set(item.checkpoint_id, referenceForCheckpoint(item.document));
  }
  const canonicalRows = new Map();
  const artifacts = new Map();
  for (const row of payload.canonical_sessions.sessions) {
    const archived = sessions.get(row.session_id);
    if (!archived || !Array.isArray(archived.messages)) fail('runtime_coordination_session_missing');
    const messageIds = new Set(archived.messages.map(message => String(message?.id || '')));
    const eventIds = new Set(row.turn_events.map(event => String(event?.event_id || '')));
    const header = strictHeader(row.runtime_continuations);
    const canonicalSession = { ...archived, id: row.session_id,
      session_incarnation: row.session_incarnation,
      runtime_continuations: header, turn_events: row.turn_events };
    canonicalRows.set(row.session_id, canonicalSession);
    for (const entry of header.entries) {
      const body = entry.body;
      const work = works.get(body.work_id);
      if (!work || body.session_id !== row.session_id || body.session_incarnation !== row.session_incarnation
        || body.turn_id !== work.turn_id || body.session_id !== work.session_id
        || body.message_selector.ordered_message_ids.some(id => !messageIds.has(id))
        || body.turn_selector.ordered_event_ids.some(id => !eventIds.has(id))
        || artifacts.has(entry.checkpoint_id)) fail('runtime_coordination_crosslink_invalid');
      try { validateHistoricalEntryAgainst(entry, canonicalSession, work); }
      catch (_error) { fail('runtime_coordination_crosslink_invalid'); }
      artifacts.set(entry.checkpoint_id, entry);
    }
  }
  for (const item of payload.checkpoints.records) {
    const { continuation, reference, retired } = checkpoints.get(item.checkpoint_id);
    if (retired) {
      const work = works.get(retired.identity.work_id);
      try { assertRetirementWork(retired, work); }
      catch (_error) { fail('runtime_coordination_retirement_crosslink_invalid'); }
      if (artifacts.has(item.checkpoint_id) || work.checkpoint_ref?.checkpoint_id === item.checkpoint_id) {
        fail('runtime_coordination_retirement_crosslink_invalid');
      }
      continue;
    }
    const work = works.get(continuation.identity.work_id);
    const artifact = artifacts.get(item.checkpoint_id);
    if (!work
      || continuation.identity.session_id !== work.session_id
      || continuation.identity.turn_id !== work.turn_id
      || (item.document.state === 'committed' && !artifact)
      || (artifact && !canonicalRows.has(artifact.body.session_id))) {
      fail('runtime_coordination_crosslink_invalid');
    }
    if (artifact) {
      try {
        validateHistoricalEntryAgainst(artifact,
          canonicalRows.get(artifact.body.session_id), work, continuation);
      } catch (_error) { fail('runtime_coordination_crosslink_invalid'); }
    }
    if (work.checkpoint_ref?.checkpoint_id === item.checkpoint_id
      && stableJson(work.checkpoint_ref) !== stableJson(reference)) {
      fail('runtime_coordination_crosslink_invalid');
    }
  }
  for (const work of works.values()) {
    if (!work.checkpoint_ref) continue;
    const saved = checkpoints.get(work.checkpoint_ref.checkpoint_id);
    if (!saved || saved.retired || stableJson(saved.reference) !== stableJson(work.checkpoint_ref)) {
      fail('runtime_coordination_crosslink_invalid');
    }
  }
  if ([...artifacts.keys()].some(id => !checkpoints.has(id))) {
    fail('runtime_coordination_crosslink_invalid');
  }
  return payload;
}

function projectRuntimeCoordinationPayload(value, context = null) {
  const payload = context
    ? validateRuntimeCoordinationCrosslinks(value, context)
    : validateRuntimeCoordinationPayload(value);
  const imported = context ? { ...payload,
    lineage: projectLineageForImport(payload.lineage, context.ledgerProjection) } : payload;
  return Object.freeze({ kind: PROJECTION_KIND, payload: imported });
}

function isRuntimeCoordinationProjection(value) {
  return value?.kind === PROJECTION_KIND && value.payload?.schema_version === 2;
}

function pathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function captureDirectory(directory, owner = null) {
  const lexical = path.resolve(directory);
  const stat = fs.lstatSync(lexical);
  const real = fs.realpathSync.native(lexical);
  const realStat = fs.statSync(real);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !realStat.isDirectory()
    || (owner && !pathWithin(owner.real, real))) fail('unsafe_restore_path',
      'Runtime coordination destination is unsafe.', DATA_ERROR_CODES.UNSAFE_PATH);
  return { lexical, real, dev: String(realStat.dev), ino: String(realStat.ino) };
}

function assertDirectory(identity, owner = null) {
  const current = captureDirectory(identity.lexical, owner);
  if (current.real !== identity.real || current.dev !== identity.dev || current.ino !== identity.ino) {
    fail('restore_destination_changed', 'Runtime coordination destination changed.', DATA_ERROR_CODES.UNSAFE_PATH);
  }
}

function writeRecordDirectory(targetRoot, records, { idKey, owner }) {
  assertDirectory(owner);
  fs.mkdirSync(targetRoot, { recursive: false, mode: 0o700 });
  const root = captureDirectory(targetRoot, owner);
  for (const item of records) {
    assertDirectory(owner);
    assertDirectory(root, owner);
    const directoryPath = path.join(root.lexical,
      crypto.createHash('sha256').update(item[idKey]).digest('hex'));
    fs.mkdirSync(directoryPath, { recursive: false, mode: 0o700 });
    const directory = captureDirectory(directoryPath, root);
    const bytes = Buffer.from(JSON.stringify(item.document), 'utf8');
    let descriptor;
    try {
      assertDirectory(owner);
      assertDirectory(root, owner);
      assertDirectory(directory, root);
      descriptor = fs.openSync(path.join(directory.lexical, 'record.json'),
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length) throw new Error('write_mismatch');
      const actual = Buffer.allocUnsafe(bytes.length);
      if (fs.readSync(descriptor, actual, 0, actual.length, 0) !== actual.length || !actual.equals(bytes)) {
        throw new Error('write_mismatch');
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    assertDirectory(directory, root);
  }
}

function runtimeCoordinationDestinations(userDataPath) {
  return [path.join(userDataPath, CHECKPOINT_DIRECTORY), path.join(userDataPath, BUDGET_DIRECTORY),
    path.join(userDataPath, LINEAGE_DIRECTORY)];
}

function publishRuntimeCoordinationProjection(userDataPath, projection, { sessionStore } = {}) {
  if (!isRuntimeCoordinationProjection(projection) || !sessionStore?.conversationStore) {
    throw new TypeError('runtime coordination projection dependencies invalid');
  }
  const owner = captureDirectory(userDataPath);
  const [checkpointsRoot, budgetsRoot, lineageRoot] = runtimeCoordinationDestinations(owner.lexical);
  writeRecordDirectory(checkpointsRoot, projection.payload.checkpoints.records,
    { idKey: 'checkpoint_id', owner });
  writeRecordDirectory(budgetsRoot, projection.payload.root_run_budgets.records,
    { idKey: 'root_run_id', owner });
  writeRecordDirectory(lineageRoot, projection.payload.lineage.records,
    { idKey: 'root_run_id', owner });
  sessionStore.conversationStore.installPendingContinuationsFromArchive(
    projection.payload.canonical_sessions);
  return true;
}

function isUntouchedRuntimeCoordinationBootstrap(userDataPath) {
  return runtimeCoordinationDestinations(path.resolve(userDataPath)).every((root) => {
    try {
      const stat = fs.lstatSync(root);
      return stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(root).length === 0;
    } catch (error) { return error?.code === 'ENOENT'; }
  });
}

module.exports = {
  BUDGET_DIRECTORY,
  LINEAGE_DIRECTORY,
  CHECKPOINT_DIRECTORY,
  MAX_RUNTIME_COORDINATION_BYTES,
  RUNTIME_COORDINATION_SCHEMA_VERSION,
  collectRuntimeCoordinationPayload,
  createOfflineRuntimeArchivePort,
  isRuntimeCoordinationProjection,
  isUntouchedRuntimeCoordinationBootstrap,
  projectRuntimeCoordinationPayload,
  publishRuntimeCoordinationProjection,
  runtimeCoordinationDestinations,
  validateRuntimeCoordinationCrosslinks,
  validateRuntimeCoordinationPayload,
};
