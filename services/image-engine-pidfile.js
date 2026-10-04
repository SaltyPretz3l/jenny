'use strict';

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const { isProcessAlive, getProcessCommandLine, getProcessCommandLineSync } = require('./backend/process-utils');
const { killTreeWithProof } = require('./backend/process-tree-tools');

const IMAGE_ENGINE_PID_FILENAME = 'image-engine.pid';

function getImageEnginePidPath(userDataPath) {
  return userDataPath ? path.join(userDataPath, IMAGE_ENGINE_PID_FILENAME) : '';
}

function validRecord(record) {
  return record && record.version === 1 && Number.isSafeInteger(record.pid) && record.pid > 0
    && Number.isFinite(record.startedAt) && record.startedAt >= 0
    && ['exePath', 'opId', 'output'].every((key) => typeof record[key] === 'string'
      && record[key].length > 0 && record[key].length <= 1024 && !record[key].includes('\0'));
}

function readRenderRecord(pidPath, { fsImpl = fs } = {}) {
  try {
    const record = JSON.parse(fsImpl.readFileSync(pidPath, 'utf8'));
    if (!validRecord(record)) return null;
    const { version, pid, exePath, opId, output, startedAt } = record;
    return { version, pid, exePath, opId, output, startedAt };
  } catch (_error) { return null; }
}

function writeRenderRecord(pidPath, record, { fsImpl = fs, isProcessAliveImpl = isProcessAlive } = {}) {
  const payload = { version: 1, pid: record.pid, exePath: record.exePath,
    opId: record.opId, output: record.output, startedAt: record.startedAt };
  if (!validRecord(payload)) throw new Error('image_engine_launch_unrecorded');
  fsImpl.mkdirSync(path.dirname(pidPath), { recursive: true });
  const tmpPath = `${pidPath}.tmp`;
  let ownedTmp = false;
  try {
    let descriptor;
    try {
      descriptor = fsImpl.openSync(tmpPath, 'wx', 0o600);
    } catch (error) {
      // A tmp left by a crash between open and rename must not refuse every
      // later render; one render runs at a time, so a leftover is always stale.
      if (error?.code !== 'EEXIST') throw error;
      fsImpl.unlinkSync(tmpPath);
      descriptor = fsImpl.openSync(tmpPath, 'wx', 0o600);
    }
    ownedTmp = true;
    try { fsImpl.writeFileSync(descriptor, JSON.stringify(payload), 'utf8'); }
    finally { fsImpl.closeSync(descriptor); }
    const existing = readRenderRecord(pidPath, { fsImpl });
    if (existing && isProcessAliveImpl(existing.pid)) throw new Error('image_engine_launch_unrecorded');
    fsImpl.renameSync(tmpPath, pidPath);
    ownedTmp = false;
  } finally {
    if (ownedTmp) {
      try { fsImpl.unlinkSync(tmpPath); } catch (_error) { /* Preserve the original write failure. */ }
    }
  }
}

function clearOwnedRenderRecord(pidPath, opId, { fsImpl = fs } = {}) {
  if (readRenderRecord(pidPath, { fsImpl })?.opId !== opId) return;
  try { fsImpl.unlinkSync(pidPath); } catch (_error) { /* Retained records can be reconciled later. */ }
}

// The operation id is unique per render and pure ASCII, and it names the
// output file (`-o <scratch>/<opId>.png`), so it survives the OEM/UTF-8
// decoding of a Windows command line and any quoting of the prompt. Paths are
// not compared: a user name with non-ASCII letters or an apostrophe would make
// a live render read as a stranger's process.
function commandMatches(command, record, platform) {
  const opId = String(record.opId || '');
  if (!/^[a-z0-9_-]{8,64}$/i.test(opId)) return false;
  const haystack = platform === 'win32' ? command.toLowerCase() : command;
  return haystack.includes(platform === 'win32' ? opId.toLowerCase() : opId);
}

// Only a render's own scratch output is removed after a confirmed cleanup.
function removeOrphanOutput(record, userDataPath, fsImpl) {
  try {
    const scratch = path.resolve(userDataPath, 'image-engine-scratch');
    const output = path.resolve(record.output);
    if (path.dirname(output) !== scratch || !output.endsWith('.png')) return;
    if (fsImpl.lstatSync(output).isFile()) fsImpl.unlinkSync(output);
  } catch (_error) { /* Missing or unreadable outputs are left alone. */ }
}

async function reconcileRenderRecord({
  userDataPath, fsImpl = fs, isProcessAliveImpl = isProcessAlive,
  getProcessCommandLineImpl = getProcessCommandLine, killTreeImpl = killTreeWithProof,
  log = () => {}, platform = process.platform,
} = {}) {
  const pidPath = getImageEnginePidPath(userDataPath);
  const record = readRenderRecord(pidPath, { fsImpl });
  if (!record) return { confirmed: true, action: 'none' };
  const finish = (confirmed, action, clear = false) => {
    if (clear) {
      clearOwnedRenderRecord(pidPath, record.opId, { fsImpl });
      removeOrphanOutput(record, userDataPath, fsImpl);
    }
    try { log(confirmed ? 'INFO' : 'WARN', `image_engine.${action}`, { opId: record.opId, pid: record.pid }); }
    catch (_error) { /* Logging cannot change cleanup. */ }
    return { confirmed, action };
  };
  try {
    if (!isProcessAliveImpl(record.pid)) return finish(true, 'cleared_stale', true);
    const command = await getProcessCommandLineImpl(record.pid);
    if (typeof command !== 'string' || !command.trim()) return finish(false, 'unconfirmed');
    if (!commandMatches(command, record, platform)) return finish(true, 'identity_mismatch', true);
    const proof = await killTreeImpl(record.pid);
    return proof.confirmed ? finish(true, 'killed', true) : finish(false, 'unconfirmed');
  } catch (_error) { return finish(false, 'unconfirmed'); }
}

function killRenderRecordSync({
  userDataPath, fsImpl = fs, spawnSyncImpl = child_process.spawnSync,
  isProcessAliveImpl = isProcessAlive, getProcessCommandLineSyncImpl = getProcessCommandLineSync,
  log = () => {}, platform = process.platform,
} = {}) {
  const pidPath = getImageEnginePidPath(userDataPath);
  const record = readRenderRecord(pidPath, { fsImpl });
  if (!record) return { hadState: false, killed: false };
  const finish = (killed, action, clear = false) => {
    if (clear) clearOwnedRenderRecord(pidPath, record.opId, { fsImpl });
    try { log(killed ? 'INFO' : 'WARN', `image_engine.${action}`, { opId: record.opId, pid: record.pid }); }
    catch (_error) { /* Logging cannot change cleanup. */ }
    return { hadState: true, killed };
  };
  try {
    if (!isProcessAliveImpl(record.pid)) return finish(false, 'cleared_stale', true);
    // The default 500 ms is a cold-start PowerShell miss; the emergency path can afford 3 s.
    const command = getProcessCommandLineSyncImpl(record.pid, { platform, spawnSyncImpl, timeoutMs: 3000 });
    if (typeof command !== 'string' || !command.trim()) return finish(false, 'unconfirmed');
    if (!commandMatches(command, record, platform)) return finish(false, 'identity_mismatch', true);
    if (platform === 'win32') {
      spawnSyncImpl('taskkill', ['/PID', String(record.pid), '/T', '/F'], {
        windowsHide: true, timeout: 3000, stdio: 'ignore',
      });
    } else {
      process.kill(record.pid, 'SIGKILL');
    }
    return !isProcessAliveImpl(record.pid) ? finish(true, 'killed', true) : finish(false, 'unconfirmed');
  } catch (_error) { return finish(false, 'unconfirmed'); }
}

module.exports = { IMAGE_ENGINE_PID_FILENAME, getImageEnginePidPath, writeRenderRecord,
  readRenderRecord, clearOwnedRenderRecord, reconcileRenderRecord, killRenderRecordSync };
