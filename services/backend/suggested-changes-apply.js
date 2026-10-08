'use strict';

// Plan Plus C4, Electron half: send one consented apply of suggested changes to
// the sidecar's `workspace.apply_suggested_changes` with explicit root authority
// (path, device id, inode), then shape-check the reply. The sidecar does every
// write through its journaled edit/write tools; Electron never writes proposal
// bytes itself.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { API_VERSION } = require('./sidecar-client');
const { resolveRequestTimeoutMs } = require('./sidecar-request-timeouts');

const METHOD = 'workspace.apply_suggested_changes';
const MAX_ITEMS = 20;
const MAX_ID_CHARS = 160;
const MAX_PATH_CHARS = 4096;
const KINDS = new Set(['create', 'replace']);
const STATUSES = new Set(['applied', 'refused', 'rolled_back']);
const OUTCOMES = new Set(['applied', 'moved', 'out_of_date', 'refused']);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CHANGE_SET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_KEYS = ['suggestion_id', 'path', 'kind', 'old_string', 'new_string', 'expected_hash'];
const RESULT_ITEM_KEYS = ['suggestion_id', 'outcome', 'reason', 'after_hash', 'diff', 'base_hash'];

function inputError(reason) {
  const error = new Error(`Suggested changes cannot be applied: ${reason}`);
  error.reason = reason;
  return error;
}

function boundedId(value) {
  return typeof value === 'string' && value.trim() && value.length <= MAX_ID_CHARS
    && !value.includes('\0') ? value : '';
}

function decimalToken(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^[1-9][0-9]{0,39}$/.test(text) ? text : '';
}

function authorityParams(authority) {
  const root = authority?.root_path;
  const deviceId = decimalToken(authority?.device_id);
  const inode = decimalToken(authority?.inode);
  if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root) || !deviceId || !inode) {
    throw inputError('workspace_required');
  }
  return { workspace_root: root, device_id: deviceId, inode };
}

function wireItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw inputError('item_invalid');
  const kind = item.kind;
  const replace = kind === 'replace';
  const valid = KINDS.has(kind)
    && boundedId(item.suggestion_id)
    && typeof item.path === 'string' && item.path.trim() && item.path.length <= MAX_PATH_CHARS
    && typeof item.new_string === 'string'
    && (replace
      ? typeof item.old_string === 'string' && item.old_string !== '' && HASH_PATTERN.test(item.expected_hash)
      : (item.old_string == null || item.old_string === '') && item.expected_hash == null);
  if (!valid) throw inputError('item_invalid');
  return {
    suggestion_id: item.suggestion_id,
    path: item.path,
    kind,
    old_string: replace ? item.old_string : null,
    new_string: item.new_string,
    expected_hash: replace ? item.expected_hash : null,
  };
}

function wireItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw inputError('items_invalid');
  if (items.length > MAX_ITEMS) throw inputError('too_many_items');
  const wire = items.map(wireItem);
  if (new Set(wire.map((item) => item.suggestion_id)).size !== wire.length) {
    throw inputError('duplicate_suggestion_id');
  }
  return wire;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validHashOrNull(value) {
  return value === null || HASH_PATTERN.test(value);
}

function validResultItem(item, expectedId) {
  return isPlainObject(item)
    && RESULT_ITEM_KEYS.every((key) => Object.prototype.hasOwnProperty.call(item, key))
    && item.suggestion_id === expectedId
    && OUTCOMES.has(item.outcome)
    && (item.reason === null || typeof item.reason === 'string')
    && validHashOrNull(item.after_hash)
    && validHashOrNull(item.base_hash)
    && (item.diff === null || isPlainObject(item.diff));
}

function validResult(result, items) {
  if (!isPlainObject(result) || result.schema_version !== 1 || !STATUSES.has(result.status)) return false;
  const changeSet = result.workspace_change_set;
  // `rolled_back` is null only when the failed write never reached the journal.
  const changeSetOk = changeSet === null
    ? result.status !== 'applied'
    : isPlainObject(changeSet) && CHANGE_SET_ID_PATTERN.test(String(changeSet.change_set_id || ''));
  return changeSetOk
    && Array.isArray(result.items)
    && result.items.length === items.length
    && result.items.every((item, index) => validResultItem(item, items[index].suggestion_id));
}

/**
 * Apply consented suggested changes as one sidecar call (one journal change set).
 * `request` is the bound `sidecarClient.request`; `authority` the session's
 * `{root_path, device_id, inode}`. Invalid inputs throw `error.reason` before any
 * call; transport errors propagate; a malformed reply becomes an empty refusal.
 */
async function applySuggestedChanges({ request, authority, sessionId, items, applyId } = {}) {
  if (typeof request !== 'function') throw inputError('request_unavailable');
  const root = authorityParams(authority);
  if (!boundedId(sessionId)) throw inputError('session_required');
  const resolvedApplyId = applyId === undefined || applyId === null ? randomUUID() : applyId;
  if (!boundedId(resolvedApplyId)) throw inputError('apply_id_invalid');
  const wire = wireItems(items);
  const params = {
    accept_version: API_VERSION,
    schema_version: 1,
    ...root,
    session_id: sessionId,
    apply_id: resolvedApplyId,
    items: wire,
  };
  const result = await request(METHOD, params, { timeoutMs: resolveRequestTimeoutMs(METHOD) });
  return validResult(result, wire)
    ? result
    : { schema_version: 1, status: 'refused', workspace_change_set: null, items: [] };
}

module.exports = { applySuggestedChanges };
