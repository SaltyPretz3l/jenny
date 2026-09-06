'use strict';

// One hour accommodates a long agentic turn: the payload is written mid-turn,
// while the message that references it is persisted only when the turn ends.
const DEFAULT_PAYLOAD_GRACE_MS = 3_600_000;

function normalizePayloadKey(value) {
  // Lowercasing is deliberately keep-biased: it prevents deletion of a live file
  // on case-insensitive filesystems and only retains an extra file on case-sensitive ones.
  return String(value).replace(/\\/g, '/').toLowerCase();
}

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addMetadataPayloadPaths(target, metadata) {
  if (!isObjectRecord(metadata) || !isObjectRecord(metadata.external_payloads)) return;

  for (const entry of Object.values(metadata.external_payloads)) {
    if (!isObjectRecord(entry) || typeof entry.path !== 'string') continue;
    target.add(normalizePayloadKey(entry.path));
  }
}

function payloadPathsFromMessages(messages) {
  const referenced = new Set();
  if (!Array.isArray(messages)) return referenced;

  for (const message of messages) {
    if (!isObjectRecord(message)) continue;
    addMetadataPayloadPaths(referenced, message.tool_call);
    addMetadataPayloadPaths(referenced, message.tool_result);
  }

  return referenced;
}

function collectReferencedPayloadPaths(sessionIds, getSessionMessages) {
  if (!Array.isArray(sessionIds)) {
    throw new TypeError('sessionIds must be an array');
  }
  if (typeof getSessionMessages !== 'function') {
    throw new TypeError('getSessionMessages must be a function');
  }

  const referenced = new Set();
  for (const sessionId of sessionIds) {
    const sessionPaths = payloadPathsFromMessages(getSessionMessages(sessionId));
    for (const payloadPath of sessionPaths) referenced.add(payloadPath);
  }
  return referenced;
}

function isPlainPayloadName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('..');
}

function selectOrphanPayloads({ entries, referenced, nowMs, graceMs } = {}) {
  if (!Array.isArray(entries) || !(referenced instanceof Set)) return [];
  if (!Number.isFinite(nowMs) || !Number.isFinite(graceMs) || graceMs < 0) return [];

  const selected = [];
  for (const entry of entries) {
    if (!isObjectRecord(entry) || !isPlainPayloadName(entry.name)) continue;
    if (referenced.has(normalizePayloadKey(entry.name))) continue;
    if (typeof entry.mtimeMs !== 'number' || !Number.isFinite(entry.mtimeMs)) continue;

    const ageMs = nowMs - entry.mtimeMs;
    if (ageMs < 0 || ageMs < graceMs) continue;
    selected.push(entry.name);
  }
  return selected;
}

module.exports = {
  DEFAULT_PAYLOAD_GRACE_MS,
  collectReferencedPayloadPaths,
  normalizePayloadKey,
  payloadPathsFromMessages,
  selectOrphanPayloads,
};
