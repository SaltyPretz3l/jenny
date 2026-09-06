'use strict';

const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');
const { isValidOperationId } = require('../paths/store-paths');

const DIR = 'distribution/operations';
const MAX_RECORDS = 10000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PHASES = new Set(['pending', 'acquisition', 'verification', 'solving', 'snapshot', 'prepare', 'pointer', 'publication', 'cleanup', 'terminal']);
const OPERATION_KINDS = new Set(['catalog_refresh', 'install', 'check', 'update', 'downgrade', 'rollback']);
const fingerprintAdmissions = new Map();
const RECORD_KEYS = new Set(['operation_record_schema_version', 'operation_id', 'request_fingerprint',
  'operation_kind', 'phase', 'sequence', 'candidate_generation_id', 'created_at', 'updated_at',
  'terminal_reason', 'runtime_publication']);
function validRecord(value) {
  return value && Object.keys(value).every((key) => RECORD_KEYS.has(key))
    && value.operation_record_schema_version === 1 && isValidOperationId(value.operation_id)
    && typeof value.request_fingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.request_fingerprint)
    && OPERATION_KINDS.has(value.operation_kind)
    && PHASES.has(value.phase) && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && Number.isFinite(Date.parse(value.created_at)) && Number.isFinite(Date.parse(value.updated_at))
    && (value.candidate_generation_id === null || isValidOperationId(value.candidate_generation_id))
    && (value.terminal_reason === undefined || value.terminal_reason === null || /^[a-z][a-z0-9_-]{0,63}$/.test(value.terminal_reason))
    && (value.runtime_publication === undefined || value.runtime_publication === 'skipped_dormant');
}
async function readOperationRecord(facade, baseDir, operationId) {
  if (!isValidOperationId(operationId)) return { ok: false, reason: 'operation_id_invalid' };
  const read = await readJsonFile(facade, joinPath(baseDir, DIR, `${operationId}.json`));
  if (read.status === 'missing') return { ok: false, reason: 'operation_record_not_found' };
  if (read.status !== 'ok' || !validRecord(read.value)) return { ok: false, reason: 'operation_record_invalid' };
  return { ok: true, record: read.value };
}
async function createOperationRecord(facade, baseDir, record) {
  if (!validRecord(record) || record.phase !== 'pending' || record.sequence !== 0) return { ok: false, reason: 'operation_record_invalid' };
  return withFingerprintAdmission(facade, baseDir, record.request_fingerprint, async () => {
    const fingerprintMatch = await findOperationByFingerprint(facade, baseDir, record.request_fingerprint);
    if (fingerprintMatch.ok) return { ok: true, outcome: 'joined', record: fingerprintMatch.record };
    if (fingerprintMatch.reason !== 'operation_record_not_found') return fingerprintMatch;
    const existing = await readOperationRecord(facade, baseDir, record.operation_id);
    if (existing.ok) return existing.record.request_fingerprint === record.request_fingerprint
      ? { ok: true, outcome: 'joined', record: existing.record } : { ok: false, reason: 'fingerprint_mismatch' };
    if (existing.reason !== 'operation_record_not_found') return existing;
    if ((await facade.list(joinPath(baseDir, DIR))).filter((name) => name.endsWith('.json')).length >= MAX_RECORDS) {
      return { ok: false, reason: 'operation_record_capacity_unavailable' };
    }
    await writeJsonFileAtomic(facade, joinPath(baseDir, DIR), `${record.operation_id}.json`, record);
    return { ok: true, outcome: 'created', record };
  });
}
function withFingerprintAdmission(facade, baseDir, fingerprint, operation) {
  let facadeAdmissions = fingerprintAdmissions.get(facade);
  if (!facadeAdmissions) {
    facadeAdmissions = new Map();
    fingerprintAdmissions.set(facade, facadeAdmissions);
  }
  const key = `${baseDir}\0${fingerprint}`;
  const prior = facadeAdmissions.get(key) || Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  facadeAdmissions.set(key, current);
  return current.finally(() => {
    if (facadeAdmissions.get(key) === current) facadeAdmissions.delete(key);
    if (facadeAdmissions.size === 0) fingerprintAdmissions.delete(facade);
  });
}
async function advanceOperationPhase(facade, baseDir, operationId, phase, now, fields = {}) {
  if (!PHASES.has(phase)) return { ok: false, reason: 'operation_phase_invalid' };
  const current = await readOperationRecord(facade, baseDir, operationId); if (!current.ok) return current;
  const next = { ...current.record, ...fields, phase, sequence: current.record.sequence + 1, updated_at: now };
  if (!validRecord(next)) return { ok: false, reason: 'operation_record_invalid' };
  await writeJsonFileAtomic(facade, joinPath(baseDir, DIR), `${operationId}.json`, next);
  return { ok: true, record: next };
}
async function findOperationByFingerprint(facade, baseDir, fingerprint) {
  if (!/^[0-9a-f]{64}$/.test(fingerprint || '')) return { ok: false, reason: 'request_fingerprint_invalid' };
  const names = (await facade.list(joinPath(baseDir, DIR))).filter((name) => name.endsWith('.json')).sort();
  for (const name of names) {
    const current = await readOperationRecord(facade, baseDir, name.slice(0, -5));
    if (!current.ok) return current;
    if (current.record.request_fingerprint === fingerprint) return { ok: true, record: current.record };
  }
  return { ok: false, reason: 'operation_record_not_found' };
}
async function pruneTerminalOperationRecords(facade, baseDir, now, retentionMs = TERMINAL_RETENTION_MS) {
  const nowMs = Date.parse(now); const removed = [];
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(retentionMs) || retentionMs <= 0 || retentionMs > TERMINAL_RETENTION_MS) {
    return { ok: false, reason: 'operation_record_retention_invalid' };
  }
  for (const name of (await facade.list(joinPath(baseDir, DIR))).filter((item) => item.endsWith('.json')).sort()) {
    const operationId = name.slice(0, -5); const current = await readOperationRecord(facade, baseDir, operationId);
    if (current.ok && current.record.phase === 'terminal' && nowMs - Date.parse(current.record.updated_at) > retentionMs) {
      await facade.remove(joinPath(baseDir, DIR, name)); removed.push(operationId);
    }
  }
  return { ok: true, removed };
}
module.exports = { DIR, TERMINAL_RETENTION_MS, PHASES,
  createOperationRecord, advanceOperationPhase, findOperationByFingerprint, pruneTerminalOperationRecords };
