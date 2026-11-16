'use strict';

// A team host answers no network health check, so readiness is a file in the
// profile directory: the boot epoch and pid of the running host. It is written
// atomically when the host is ready and removed when it stops. A marker whose
// process is gone is stale and counts as not ready.
//
// Slice 3-11: in a container the host is pid 1 on every run, so a marker a killed
// container left names a live pid after a restart. On Linux the marker also holds
// the process's start time (field 22 of /proc/<pid>/stat, read without a child
// process) as schema 2, and the check compares it. Where the platform gives none
// (Windows, macOS) the marker is exactly the schema 1 marker and the check is the
// pid alone; a schema 1 marker written by an older build reads the same way.

const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJson } = require('../../services/host/durable-json');

const READY_MARKER_FILE = 'team-ready.json';
const READY_MARKER_SCHEMA = 1;
const STARTED_MARKER_SCHEMA = 2;
const MAX_MARKER_BYTES = 4 * 1024;
const BOOT_EPOCH = /^[A-Za-z0-9_-]{1,128}$/u;
const START_TIME = /^[0-9]{1,20}$/u;
const MARKER_FIELDS = Object.freeze({
  [READY_MARKER_SCHEMA]: new Set(['schema_version', 'boot_epoch', 'pid']),
  [STARTED_MARKER_SCHEMA]: new Set(['schema_version', 'boot_epoch', 'pid', 'start_time']),
});
// A stat line is a few hundred bytes; a longer read is a surprise and reads as no start time.
const MAX_STAT_BYTES = 1024;

function markerPath(userDataPath) {
  return path.join(userDataPath, READY_MARKER_FILE);
}

// The raw stat text of a process, at most MAX_STAT_BYTES + 1 bytes (procfs reports size 0, so it is
// read to the end); null on any error.
function readProcStat(pid) {
  let fd;
  try {
    fd = fs.openSync(`/proc/${pid}/stat`, fs.constants.O_RDONLY);
    const buffer = Buffer.alloc(MAX_STAT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    return buffer.subarray(0, offset).toString('latin1');
  } catch (_error) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_error) { /* already closed */ } }
  }
}

// The start time of `pid` as a decimal string (clock ticks since boot), Linux only; null elsewhere and
// for anything unexpected. The command name (field 2) may hold spaces and parentheses, so the fields
// are counted from after the last `)`: field 3 is the first there, field 22 the twentieth.
function processStartTime(pid, { platform = process.platform, readStat = readProcStat } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const text = readStat(pid);
    if (typeof text !== 'string' || text.length > MAX_STAT_BYTES) return null;
    const close = text.lastIndexOf(')');
    if (close < 0) return null;
    const value = text.slice(close + 1).trim().split(' ')[19];
    return typeof value === 'string' && START_TIME.test(value) ? value : null;
  } catch (_error) {
    return null;
  }
}

// `startTime` defaults to this process's own (from `readStartTime`) when the pid is its own; null writes
// the schema 1 marker.
function writeReadyMarker({ userDataPath, bootEpoch, pid = process.pid, readStartTime = processStartTime,
  startTime = pid === process.pid ? readStartTime(pid) : null }) {
  if (typeof bootEpoch !== 'string' || !BOOT_EPOCH.test(bootEpoch)) throw new TypeError('invalid_boot_epoch');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('invalid_pid');
  if (startTime !== null && (typeof startTime !== 'string' || !START_TIME.test(startTime))) {
    throw new TypeError('invalid_start_time');
  }
  writeJson(markerPath(userDataPath), startTime === null
    ? { schema_version: READY_MARKER_SCHEMA, boot_epoch: bootEpoch, pid }
    : { schema_version: STARTED_MARKER_SCHEMA, boot_epoch: bootEpoch, pid, start_time: startTime });
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
    // Only the numbers 1 and 2: a key lookup alone would let "2" or [2] through.
    const schema = value.schema_version;
    const fields = schema === READY_MARKER_SCHEMA || schema === STARTED_MARKER_SCHEMA ? MARKER_FIELDS[schema] : null;
    if (!fields || Object.keys(value).some((key) => !fields.has(key)) || Object.keys(value).length !== fields.size) return null;
    if (typeof value.boot_epoch !== 'string' || !BOOT_EPOCH.test(value.boot_epoch)) return null;
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    if (value.schema_version === READY_MARKER_SCHEMA) return { bootEpoch: value.boot_epoch, pid: value.pid };
    if (typeof value.start_time !== 'string' || !START_TIME.test(value.start_time)) return null;
    return { bootEpoch: value.boot_epoch, pid: value.pid, startTime: value.start_time };
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

function isReadyMarkerLive({ userDataPath, isProcessAlive = processIsAlive, readStartTime = processStartTime }) {
  const marker = readReadyMarker({ userDataPath });
  if (!marker) return false;
  try {
    if (isProcessAlive(marker.pid) !== true) return false;
    // A schema 1 marker carries no start time: the pid alone, as before.
    return marker.startTime === undefined || readStartTime(marker.pid) === marker.startTime;
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
  processStartTime,
};
