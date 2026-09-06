'use strict';

const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');
const { isValidDigest } = require('./content-store');
const { isValidOperationId } = require('../paths/store-paths');

const DIR = 'distribution/leases';
function validLease(value) {
  return value && value.artifact_lease_schema_version === 1 && isValidOperationId(value.operation_id)
    && Array.isArray(value.digests) && value.digests.length <= 128 && value.digests.every(isValidDigest)
    && new Set(value.digests).size === value.digests.length && Number.isFinite(Date.parse(value.expires_at));
}
async function writeArtifactLease(facade, baseDir, { operationId, digests, expiresAt }) {
  const record = { artifact_lease_schema_version: 1, operation_id: operationId, digests: [...digests].sort(), expires_at: expiresAt };
  if (!validLease(record)) return { ok: false, reason: 'artifact_lease_invalid' };
  await writeJsonFileAtomic(facade, joinPath(baseDir, DIR), `${operationId}.json`, record);
  return { ok: true, record };
}
async function releaseArtifactLease(facade, baseDir, operationId) {
  if (!isValidOperationId(operationId)) return { ok: false, reason: 'operation_id_invalid' };
  await facade.remove(joinPath(baseDir, DIR, `${operationId}.json`)); return { ok: true };
}
async function readActiveArtifactDigests(facade, baseDir, now) {
  const names = await facade.list(joinPath(baseDir, DIR)); const digests = new Set(); const stale = [];
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const read = await readJsonFile(facade, joinPath(baseDir, DIR, name));
    if (read.status !== 'ok' || !validLease(read.value) || Date.parse(read.value.expires_at) <= Date.parse(now)) stale.push(name);
    else read.value.digests.forEach((item) => digests.add(item));
  }
  return { ok: true, digests, stale };
}
async function pruneArtifactLeases(facade, baseDir, now) {
  const current = await readActiveArtifactDigests(facade, baseDir, now);
  for (const name of current.stale) await facade.remove(joinPath(baseDir, DIR, name));
  return { ok: true, removed: current.stale.length };
}
module.exports = { DIR, writeArtifactLease, releaseArtifactLease, readActiveArtifactDigests, pruneArtifactLeases };
