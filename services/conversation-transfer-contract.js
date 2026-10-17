'use strict';

const { t } = require('./i18n-main');

const crypto = require('node:crypto');
const { TRANSFER_ERROR_CODES } = require('./backend/error-codes');

const MAX_SNAPSHOT_BYTES = 48 * 1024 * 1024;
const MAX_MESSAGES = 5000;
const ENDPOINTS = new Set(['jenny', 'codex']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  error.code = TRANSFER_ERROR_CODES.FAILED;
  throw error;
}
function identity(endpoint, id) {
  if (!ENDPOINTS.has(endpoint) || typeof id !== 'string'
    || (endpoint === 'codex' ? !UUID.test(id) : !/^sess_[A-Za-z0-9_-]{1,154}$/.test(id))) {
    fail('invalid_request', 'Select a valid conversation.');
  }
  return id;
}
function direction(source, destination) {
  if (!ENDPOINTS.has(source) || !ENDPOINTS.has(destination) || source === destination) {
    fail('invalid_request', 'Select Jenny and Codex as different endpoints.');
  }
}
function fingerprint(snapshot) {
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES || snapshot.messages.length > MAX_MESSAGES) {
    fail('snapshot_too_large', 'This conversation exceeds the single-chat transfer limit.');
  }
  return crypto.createHash('sha256').update(serialized).digest('hex');
}
function publicReceipt(record) {
  return { operationId: record.id, source: record.source, sourceId: record.sourceId,
    destination: record.destination, destinationId: record.destinationId || null,
    state: record.state, createdAt: record.createdAt };
}
function safeResult(error) {
  return { ok: false, code: TRANSFER_ERROR_CODES.FAILED, reason: error?.reason || 'transfer_failed',
    message: error?.reason ? error.message : t('error.transfer.failed', "Conversation transfer failed. Review the preview or retry the saved operation.") };
}
module.exports = { MAX_SNAPSHOT_BYTES, UUID, fail, identity, direction, fingerprint, publicReceipt, safeResult };
