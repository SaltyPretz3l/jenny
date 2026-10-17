'use strict';

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const { isProcessAlive, getProcessCommandLine, getProcessCommandLineSync } = require('./backend/process-utils');
const treeTools = require('./backend/process-tree-tools');

const IMAGE_ENGINE_PID_FILENAME = 'image-engine.pid';

function getImageEnginePidPath(userDataPath) {
  return userDataPath ? path.join(userDataPath, IMAGE_ENGINE_PID_FILENAME) : '';
}

// Unresolved tree-cleanup evidence a render left behind when its root settled
// before every descendant was proven gone: the root's pid-ownership window, the
// early snapshot and the pids it proved ours, each with its creation time, plus
// descendants a later reconcile saw survive under them (never killed).
function validTree(tree) {
  const entries = (list) => Array.isArray(list) && list.length <= 128 && list.every((entry) => entry
    && Number.isSafeInteger(entry.pid) && entry.pid > 0 && (entry.createdMs === null || Number.isFinite(entry.createdMs)));
  return Boolean(tree) && typeof tree === 'object'
    && ['spawnedAtMs', 'spawnReturnedAtMs', 'rootHeldUntilMs'].every((key) => Number.isFinite(tree[key]))
    && (tree.rootCreatedMs === null || Number.isFinite(tree.rootCreatedMs))
    && entries(tree.processes) && entries(tree.survivors)
    && (tree.unresolved === undefined || entries(tree.unresolved));
}

function validRecord(record) {
  return record && record.version === 1 && Number.isSafeInteger(record.pid) && record.pid > 0
    && Number.isFinite(record.startedAt) && record.startedAt >= 0
    && ['exePath', 'opId', 'output'].every((key) => typeof record[key] === 'string'
      && record[key].length > 0 && record[key].length <= 1024 && !record[key].includes('\0'))
    && (record.treeSince === undefined || Number.isFinite(record.treeSince))
    && (record.tree === undefined || validTree(record.tree));
}

function treeCopy(tree) {
  const entries = (list) => list.map(({ pid, createdMs }) => ({ pid, createdMs }));
  return { spawnedAtMs: tree.spawnedAtMs, spawnReturnedAtMs: tree.spawnReturnedAtMs,
    rootHeldUntilMs: tree.rootHeldUntilMs, rootCreatedMs: tree.rootCreatedMs,
    processes: entries(tree.processes), survivors: entries(tree.survivors),
    ...(tree.unresolved === undefined ? {} : { unresolved: entries(tree.unresolved) }) };
}

function readRenderRecord(pidPath, { fsImpl = fs } = {}) {
  try {
    const record = JSON.parse(fsImpl.readFileSync(pidPath, 'utf8'));
    if (!validRecord(record)) return null;
    const { version, pid, exePath, opId, output, startedAt, treeSince, tree } = record;
    return { version, pid, exePath, opId, output, startedAt, ...(treeSince === undefined ? {} : { treeSince }),
      ...(tree === undefined ? {} : { tree: treeCopy(tree) }) };
  } catch (_error) { return null; }
}

// `treeSince` (the wall clock before the spawn) marks a record whose tree needs
// proof beyond its root's death until tree evidence or a confirmed cleanup lands.
function writeRenderRecord(pidPath, record, { fsImpl = fs, isProcessAliveImpl = isProcessAlive } = {}) {
  const payload = { version: 1, pid: record.pid, exePath: record.exePath,
    opId: record.opId, output: record.output, startedAt: record.startedAt,
    ...(record.treeSince === undefined ? {} : { treeSince: record.treeSince }) };
  if (!validRecord(payload)) throw new Error('image_engine_launch_unrecorded');
  writeAtomically(pidPath, payload, fsImpl, () => {
    const existing = readRenderRecord(pidPath, { fsImpl });
    if (existing && isProcessAliveImpl(existing.pid)) throw new Error('image_engine_launch_unrecorded');
  });
}

// Adds unresolved tree-cleanup evidence to this render's own record, so a later
// reconcile cannot clear it on the root's death alone. Throws on failure.
function retainRenderTree(pidPath, opId, tree, { fsImpl = fs } = {}) {
  const existing = readRenderRecord(pidPath, { fsImpl });
  if (existing?.opId !== opId) throw new Error('image_engine_record_not_owned');
  const payload = { ...existing, tree: validTree(tree) ? treeCopy(tree) : null };
  if (!validRecord(payload)) throw new Error('image_engine_tree_invalid');
  writeAtomically(pidPath, payload, fsImpl, () => {
    if (readRenderRecord(pidPath, { fsImpl })?.opId !== opId) throw new Error('image_engine_record_not_owned');
  });
}

function writeAtomically(pidPath, payload, fsImpl, beforeRename) {
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
    beforeRename();
    fsImpl.renameSync(tmpPath, pidPath);
    ownedTmp = false;
  } finally {
    if (ownedTmp) {
      try { fsImpl.unlinkSync(tmpPath); } catch (_error) { /* Preserve the original write failure. */ }
    }
  }
}

function clearOwnedRenderRecord(pidPath, opId, { fsImpl = fs } = {}) {
  const record = readRenderRecord(pidPath, { fsImpl });
  if (record?.opId !== opId) return;
  // The caller has proved this render settled. Remove its private reference before
  // dropping the recovery record, including a crash after runner settlement.
  removeOrphanOutput(record, path.dirname(pidPath), fsImpl, true);
  try { fsImpl.unlinkSync(pidPath); } catch (_error) { /* Retained records can be reconciled later. */ }
}

// What the Model Library shows about a stuck record: when the render started
// and how many helpers a reconcile saw but could not prove gone. Never throws.
function readRenderRecordSummary({ userDataPath, fsImpl = fs } = {}) {
  const record = readRenderRecord(getImageEnginePidPath(userDataPath), { fsImpl });
  return record ? { started_at: record.startedAt, unresolved: record.tree?.unresolved?.length || 0 } : null;
}

// The owner's confirmed "Clear anyway" for a record no proof can clear (its
// root exited before tree evidence landed): the render's scratch files and the
// record go without proof. Nothing is killed; a record that cannot be removed
// stays, so the retained GPU lease stays with it.
function clearRenderRecordUnproven({ userDataPath, fsImpl = fs, log = () => {} } = {}) {
  const pidPath = getImageEnginePidPath(userDataPath);
  // Only a confirmed absence is a clear: a record that cannot be read may still exist.
  try { fsImpl.readFileSync(pidPath, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { cleared: true, record: null };
    return { cleared: false, reason: 'image_engine_record_locked' };
  }
  const record = readRenderRecord(pidPath, { fsImpl });
  const unresolved = record?.tree?.unresolved?.length || 0;
  // The record goes first: a record that cannot be removed keeps its scratch files too.
  try { fsImpl.unlinkSync(pidPath); } catch (error) {
    if (error?.code !== 'ENOENT') return { cleared: false, reason: 'image_engine_record_locked' };
  }
  if (!record) return { cleared: true, record: null }; // an unparsable record: nothing to clean up after it
  removeOrphanOutput(record, userDataPath, fsImpl);
  try { log('WARN', 'image_engine.cleared_unproven', { opId: record.opId, pid: record.pid, unresolved }); }
  catch (_error) { /* Logging cannot change cleanup. */ }
  return { cleared: true, record: { pid: record.pid, startedAt: record.startedAt, unresolved } };
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
function removeOrphanOutput(record, userDataPath, fsImpl, referenceOnly = false) {
  const scratch = path.resolve(userDataPath, 'image-engine-scratch');
  if (!/^[a-z0-9_-]{8,64}$/i.test(record.opId)) return;
  try {
    if (fsImpl.lstatSync(scratch).isSymbolicLink() || fsImpl.realpathSync(scratch) !== scratch) return;
  } catch (_error) { return; }
  for (const output of [...(referenceOnly ? [] : [path.resolve(record.output)]), path.join(scratch, `${record.opId}-reference.png`)]) {
    try {
      if (path.dirname(output) === scratch && output.endsWith('.png') && fsImpl.lstatSync(output).isFile()) fsImpl.unlinkSync(output);
    } catch (_error) { /* Missing files are already clean. */ }
  }
}

// Windows keeps a dead parent's pid as its children's ParentProcessId, so a
// row listed under a process of ours may be its survivor. It is not when it is
// older than that process, or a child of a different process now holding the pid.
function isUnresolvedChild(row, byPid, parent) {
  const holder = byPid.get(parent.pid);
  const strangerHolds = holder?.createdMs != null && holder.createdMs !== parent.createdMs;
  return row.ppid === parent.pid
    && !(row.createdMs != null && parent.createdMs != null && row.createdMs < parent.createdMs - treeTools.CLOCK_SLACK_MS)
    && !(strangerHolds && row.createdMs != null && row.createdMs >= holder.createdMs);
}

// Tree-death proof for a record with tree evidence, re-running the runner's own
// survivor selection on a fresh process table: a recorded pid still running
// with its recorded creation time, or a process the root's window proves ours.
// A live recorded pid without a matching creation time may name a stranger: it
// is never killed and leaves the tree unproven, as does a recorded process's
// surviving child. Each such child is retained before an unproven return, so a
// later pass still follows it after its own parent exits.
async function reapRecordedTree(record, tools, retainUnresolved) {
  const { tree } = record;
  const table = await tools.listProcessRows();
  if (table?.ok !== true) return false;
  const byPid = new Map(table.rows.map((row) => [row.pid, row]));
  const unresolved = tree.unresolved || [];
  const entries = [...tree.processes, ...tree.survivors, ...unresolved];
  const same = (entry) => entry.createdMs != null && byPid.get(entry.pid)?.createdMs === entry.createdMs;
  const other = (entry) => entry.createdMs != null && byPid.get(entry.pid)?.createdMs != null && !same(entry);
  const identified = entries.every((entry) => !byPid.has(entry.pid) || same(entry) || other(entry));
  const recorded = tree.survivors.filter(same).map((entry) => entry.pid);
  const selected = tools.selectRootSurvivors({ rootPid: record.pid, spawnedAtMs: tree.spawnedAtMs,
    spawnReturnedAtMs: tree.spawnReturnedAtMs, rootHeldUntilMs: tree.rootHeldUntilMs,
    snapshot: { processes: tree.processes.filter((entry) => entry.createdMs != null), rootCreatedMs: tree.rootCreatedMs },
    rows: table.rows });
  const pids = [...new Set([...recorded, ...selected.pids])].filter((pid) => pid !== record.pid);
  const exclude = new Set([record.pid, ...pids]);
  const living = unresolved.filter((entry) => byPid.has(entry.pid) && !other(entry));
  const observed = table.rows.filter((row) => !exclude.has(row.pid)
    && entries.some((entry) => isUnresolvedChild(row, byPid, entry)));
  await tools.terminatePids(pids);
  const proof = await tools.confirmAllGone(pids);
  const gone = identified && !living.length && !observed.length && selected.ok === true && proof?.confirmed === true;
  const next = [...new Map([...living, ...observed.map((row) => ({ pid: row.pid, createdMs: row.createdMs ?? null }))]
    .map((entry) => [entry.pid, entry])).values()];
  if (!gone && JSON.stringify(next) !== JSON.stringify(unresolved)) retainUnresolved(next);
  return gone;
}

async function reconcileRenderRecord({
  userDataPath, fsImpl = fs, isProcessAliveImpl = isProcessAlive,
  getProcessCommandLineImpl = getProcessCommandLine, killTreeImpl = treeTools.killTreeWithProof,
  processTools = {}, log = () => {}, platform = process.platform,
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
  const tools = { ...treeTools, ...processTools };
  const retainUnresolved = (unresolved) => retainRenderTree(pidPath, record.opId, { ...record.tree, unresolved }, { fsImpl });
  // A marked record without tree evidence has no proof beyond its root: only the
  // kill-with-proof pass over its live root's tree clears it.
  const treeGone = async (liveTreeProven) => (record.tree ? reapRecordedTree(record, tools, retainUnresolved)
    : record.treeSince === undefined || liveTreeProven);
  const proven = async (action, liveTreeProven = false) => ((await treeGone(liveTreeProven))
    ? finish(true, action, true) : finish(false, 'unconfirmed'));
  try {
    if (!isProcessAliveImpl(record.pid)) return await proven('cleared_stale');
    const command = await getProcessCommandLineImpl(record.pid);
    if (typeof command !== 'string' || !command.trim()) return finish(false, 'unconfirmed');
    if (!commandMatches(command, record, platform)) return await proven('identity_mismatch');
    const proof = await killTreeImpl(record.pid);
    return proof.confirmed ? await proven('killed', true) : finish(false, 'unconfirmed');
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
    // Tree evidence, or its pending marker, needs the async proof; the next reconcile owns it.
    if (clear && !record.tree && record.treeSince === undefined) { removeOrphanOutput(record, userDataPath, fsImpl); clearOwnedRenderRecord(pidPath, record.opId, { fsImpl }); }
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

module.exports = { IMAGE_ENGINE_PID_FILENAME, getImageEnginePidPath, writeRenderRecord, retainRenderTree,
  readRenderRecord, clearOwnedRenderRecord, reconcileRenderRecord, killRenderRecordSync,
  readRenderRecordSummary, clearRenderRecordUnproven };
