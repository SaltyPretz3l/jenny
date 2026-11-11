'use strict';

// A team host answers no network health check, so readiness is a file in the
// profile directory: the boot epoch and pid of the running host. It is written
// atomically when the host is ready and removed when it stops. A marker whose
// process is gone is stale and counts as not ready.

const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJson } = require('../../services/host/durable-json');

const READY_MARKER_FILE = 'team-ready.json';
const READY_MARKER_SCHEMA = 1;
const MAX_MARKER_BYTES = 4 * 1024;
const BOOT_EPOCH = /^[A-Za-z0-9_-]{1,128}$/u;
const MARKER_FIELDS = new Set(['schema_version', 'boot_epoch', 'pid']);

function markerPath(userDataPath) {
  return path.join(userDataPath, READY_MARKER_FILE);
}

function writeReadyMarker({ userDataPath, bootEpoch, pid = process.pid }) {
  if (typeof bootEpoch !== 'string' || !BOOT_EPOCH.test(bootEpoch)) throw new TypeError('invalid_boot_epoch');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('invalid_pid');
  writeJson(markerPath(userDataPath), { schema_version: READY_MARKER_SCHEMA, boot_epoch: bootEpoch, pid });
}

function removeReadyMarker({ userDataPath }) {
  try {
    fs.rmSync(markerPath(userDataPath), { force: true });
  } catch (_error) {
    // Best effort: a marker that cannot be removed is caught by the liveness check.
  }
}

function readReadyMarker({ userDataPath }) {
  try {
    const value = readJson(markerPath(userDataPath), { maxBytes: MAX_MARKER_BYTES });
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
    if (Object.keys(value).some((key) => !MARKER_FIELDS.has(key)) || Object.keys(value).length !== MARKER_FIELDS.size) return null;
    if (value.schema_version !== READY_MARKER_SCHEMA) return null;
    if (typeof value.boot_epoch !== 'string' || !BOOT_EPOCH.test(value.boot_epoch)) return null;
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    return { bootEpoch: value.boot_epoch, pid: value.pid };
  } catch (_error) {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function isReadyMarkerLive({ userDataPath, isProcessAlive = processIsAlive }) {
  const marker = readReadyMarker({ userDataPath });
  if (!marker) return false;
  try {
    return isProcessAlive(marker.pid) === true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  READY_MARKER_FILE,
  writeReadyMarker,
  removeReadyMarker,
  readReadyMarker,
  isReadyMarkerLive,
};
