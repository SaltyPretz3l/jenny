'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../package/canonical-metadata');
const { isValidDigest } = require('./content-store');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');

const DIR = 'distribution/evidence';
const KINDS = new Set(['lock', 'source_trust', 'advisory', 'clock', 'catalog']);
function digestEvidence(value) { return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex'); }
async function putEvidence(facade, baseDir, kind, value) {
  if (!KINDS.has(kind) || !value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'evidence_invalid' };
  const digest = digestEvidence(value);
  const file = `${digest}.json`; const dir = joinPath(baseDir, DIR, kind);
  const stat = await facade.stat(joinPath(dir, file));
  if (!stat.exists) await writeJsonFileAtomic(facade, dir, file, value);
  return { ok: true, digest };
}
async function getEvidence(facade, baseDir, kind, digest) {
  if (!KINDS.has(kind) || !isValidDigest(digest)) return { ok: false, reason: 'evidence_reference_invalid' };
  const read = await readJsonFile(facade, joinPath(baseDir, DIR, kind, `${digest}.json`));
  if (read.status !== 'ok') return { ok: false, reason: read.status === 'missing' ? 'evidence_not_found' : 'evidence_corrupted' };
  if (digestEvidence(read.value) !== digest) return { ok: false, reason: 'evidence_digest_mismatch' };
  return { ok: true, value: read.value };
}
module.exports = { DIR, KINDS, putEvidence, getEvidence };
