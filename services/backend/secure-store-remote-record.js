'use strict';

// Remote Control pairing record helpers for SecureStore (kept beside the store
// so secure-store.js stays under the 600-line hotspot ratchet). The record is a
// versioned plain JSON object; SecureStore encrypts it like every other secret.
const SECRET_TYPE_REMOTE_CONTROL = 'remote_control_record';
const REMOTE_CONTROL_RECORD_KEY = 'remote_control:record';
const MAX_REMOTE_CONTROL_RECORD_BYTES = 64 * 1024;

function remoteControlRecordKeyName() {
  return REMOTE_CONTROL_RECORD_KEY;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeRemoteControlRecord(record) {
  if (!isPlainObject(record) || !Number.isInteger(record.record_version)
    || record.record_version <= 0) {
    throw new Error('SecureStore: remote control record invalid.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(record);
  } catch (error) {
    throw new Error('SecureStore: remote control record invalid.', { cause: error });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REMOTE_CONTROL_RECORD_BYTES) {
    throw new Error('SecureStore: remote control record invalid.');
  }
  return serialized;
}

// null = no record stored; undefined = stored but corrupt (caller drops it).
function parseRemoteControlRecord(stored) {
  if (!stored) {
    return null;
  }
  try {
    const record = JSON.parse(stored);
    return isPlainObject(record) ? record : undefined;
  } catch (_error) {
    return undefined;
  }
}

module.exports = {
  SECRET_TYPE_REMOTE_CONTROL,
  parseRemoteControlRecord,
  remoteControlRecordKeyName,
  serializeRemoteControlRecord,
};
