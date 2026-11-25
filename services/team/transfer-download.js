'use strict';

// One project download into a folder the member picked (row 123 slice 3-9, commit 3; TEAM_PROJECTS_SPEC "Upload and
// download", the 3-8b manifest and part route).
//
// The picked folder must be a real directory at its own real path (no link, junction or alias on the way) and empty
// (one entry read); it is checked again before the first write. The manifest is read page by page: the cursor must
// rise, and the pages and entries stay within the manifest's own total and the project file cap, else
// `team_answer_invalid`. Every entry is checked against the host's own path rules, the sensitive-name list (E69),
// sizes and fold collisions, and a bad entry is skipped and counted, never written. Each file's parts are read in
// order, hashed as they arrive and written to a partial file made exclusively in its own folder (folders this download made, none a link); the partial
// becomes the final name, which must not exist, only after its SHA-256 matches. Any failure, a cancel included,
// removes the partial (services/fs-remove-no-follow.js), so nothing partly written is kept and memory holds one part.
// `team_download_changed` (the host's file changed since its listing, or bytes that do not match) ends the download.
// A lost link waits for the team to come back and reads the file again from its first part; a link lost
// `stalledResumes` times in a row without a file finished ends it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { WINDOWS, openNoFollow, ownDirectory, renameNoReplace } = require('../../server/team/file-checks');
const { removeFile } = require('../fs-remove-no-follow');
const {
  HOST_ID, LIMITS, LinkDropped, SHA256, TransferEnd, commandCall, createCollisionSet, failureReason, isCount, partCall,
  pathAllowed, sensitiveName,
} = require('./transfer-common');

// The host lists 1,000 entries a page: the project file cap fits in ten pages, one more for an empty last page.
const MAX_MANIFEST_PAGES = Math.ceil(LIMITS.projectFiles / 1_000) + 1;
const CREATE_FLAGS = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;

/** null when `folder` is a real empty directory at its own real path, else the reason word. */
async function folderRefusal(folder) {
  if (!ownDirectory(folder)) return 'team_download_folder_invalid';
  let dir;
  try { dir = await fs.promises.opendir(folder); } catch { return 'team_download_folder_invalid'; }
  try {
    return (await dir.read()) === null ? null : 'team_download_folder_not_empty';
  } catch {
    return 'team_download_folder_invalid';
  } finally {
    await dir.close().catch(() => {});
  }
}

// One manifest page, checked against the page before it (`before`: the same manifest and total, a rising cursor).
function checkedPage(answer, before) {
  if (answer?.ok !== true) return null;
  const { manifest_id: id, part_size: partSize, total_files: totalFiles, total_bytes: totalBytes, entries } = answer;
  if (typeof id !== 'string' || !HOST_ID.test(id)) return null;
  if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > LIMITS.maxPartBytes) return null;
  if (!isCount(totalFiles) || totalFiles > LIMITS.projectFiles || !isCount(totalBytes) || !Array.isArray(entries)) return null;
  if (before && (id !== before.manifestId || totalFiles !== before.totalFiles || partSize !== before.partSize)) return null;
  const next = answer.next_cursor;
  // A further page's cursor rises past the one it was asked with; a repeating cursor would loop for ever.
  const floor = before ? before.next + 1 : 1; // the first page was asked from cursor 0
  if (next !== null && !(isCount(next) && next <= totalFiles && next >= floor)) return null;
  return { manifestId: id, partSize, totalFiles, totalBytes, entries, next, skipped: isCount(answer.skipped) ? answer.skipped : 0 };
}

// Every page of the manifest; `team_answer_invalid` for a cursor that does not rise or a listing past its bounds.
async function readManifest(manager, ids, signal) {
  const pages = [];
  let page = null;
  let listed = 0;
  do {
    if (pages.length >= MAX_MANIFEST_PAGES) throw new TransferEnd('team_answer_invalid');
    const params = page ? { ...ids, manifest_id: page.manifestId, cursor: page.next } : ids;
    let answer;
    try { answer = await commandCall(manager, 'team.project.download.manifest', params); } catch (error) {
      if (error instanceof LinkDropped) throw new TransferEnd('team_not_connected');
      throw error;
    }
    if (answer?.ok !== true) throw new TransferEnd(failureReason(answer));
    const next = checkedPage(answer, page);
    if (!next) throw new TransferEnd('team_answer_invalid');
    listed += next.entries.length;
    if (listed > next.totalFiles || listed > LIMITS.projectFiles) throw new TransferEnd('team_answer_invalid');
    page = next;
    pages.push(page);
    if (signal.aborted) throw new TransferEnd('aborted');
  } while (page.next !== null);
  return pages;
}

// The entries this download may write: well formed, inside the host's rules, none with a segment on the sensitive
// list (E69: the host never lists one; a hand-made manifest's is skipped and counted), no two landing on one name.
// A file over the per-file limit is not skipped quietly: it is named in `failed` (at most FAILED_LISTED, the rest only
// counted in `failedTotal`) and the other files still land.
const FAILED_LISTED = 20;
function writable(entries) {
  const kept = [];
  const names = createCollisionSet();
  const failed = [];
  let failedTotal = 0;
  let bad = 0;
  for (const entry of entries) {
    const named = entry && Number.isSafeInteger(entry.index) && typeof entry.path === 'string' && pathAllowed(entry.path)
      && sensitiveName(entry.path) === null && isCount(entry.size)
      && typeof entry.sha256 === 'string' && SHA256.test(entry.sha256);
    if (!named || !names.add(entry.path)) bad += 1;
    else if (entry.size > LIMITS.maxFileBytes) {
      failedTotal += 1;
      if (failed.length < FAILED_LISTED) failed.push({ path: entry.path, reason: 'team_download_file_too_large' });
    } else kept.push(entry);
  }
  return { kept, bad, failed, failedTotal };
}

// Makes each folder of `relative` under `root`, each a real directory at its own real path; answers the file's path.
async function prepareParent(root, relative) {
  const segments = relative.split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      await fs.promises.mkdir(current);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new TransferEnd('team_download_write_failed');
    }
    if (!ownDirectory(current)) throw new TransferEnd('team_download_write_failed');
  }
  return path.join(current, segments[segments.length - 1]);
}

// The partial becomes `target`, which must not exist: Windows holds the name first; elsewhere a hard link fails on an
// existing name, and a volume with no hard links checks the name is absent and renames.
async function placeFinal(partial, target) {
  if (WINDOWS) { await renameNoReplace(partial, target); return; }
  try {
    await fs.promises.link(partial, target);
  } catch (error) {
    if (error?.code === 'EEXIST') throw error;
    const taken = await fs.promises.lstat(target).then(() => true, (missing) => missing?.code !== 'ENOENT');
    if (taken) throw new Error('target exists', { cause: error });
    await fs.promises.rename(partial, target);
    return;
  }
  await fs.promises.unlink(partial);
}

// One file: parts read in order, hashed and written as they arrive to a partial file, placed after the hash matches.
async function downloadFile(manager, projectId, page, entry, target, signal) {
  const partial = path.join(path.dirname(target), `.jenny-${crypto.randomBytes(6).toString('hex')}.partial`);
  let handle;
  try { handle = await openNoFollow(partial, CREATE_FLAGS, 0o600); } catch { throw new TransferEnd('team_download_write_failed'); }
  let placed = false;
  try {
    const hash = crypto.createHash('sha256');
    let read = 0;
    for (let n = 0; read < entry.size; n += 1) {
      if (signal.aborted) throw new TransferEnd('aborted');
      const expected = Math.min(page.partSize, entry.size - read);
      const answer = await partCall(manager, (session, client) => session.getPart(client, { projectId,
        manifestId: page.manifestId, index: entry.index, n, maxBytes: page.partSize, signal }), signal);
      if (answer?.ok !== true) throw new TransferEnd(failureReason(answer));
      if (!Buffer.isBuffer(answer.bytes) || answer.bytes.length !== expected) throw new TransferEnd('team_download_changed');
      hash.update(answer.bytes);
      await writeAll(handle, answer.bytes, read);
      read += expected;
    }
    if (hash.digest('hex') !== entry.sha256) throw new TransferEnd('team_download_changed');
    await handle.close();
    handle = null;
    try { await placeFinal(partial, target); } catch { throw new TransferEnd('team_download_write_failed'); }
    placed = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!placed) await removeFile(partial).catch(() => {});
  }
}

async function writeAll(handle, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    let result;
    try { result = await handle.write(bytes, written, bytes.length - written, position + written); } catch {
      throw new TransferEnd('team_download_write_failed');
    }
    if (result.bytesWritten <= 0) throw new TransferEnd('team_download_write_failed');
    written += result.bytesWritten;
  }
}

/**
 * Runs a download into `folder` (already checked empty). deps: { manager, projectId, folder, signal, progress,
 * waitReconnect, stopped }. Resolves { ok: true, files, bytes, skipped, path } (plus `failed: [{ path, reason }]` and
 * `failed_files` when a listed file was over the per-file limit) or throws a TransferEnd.
 */
async function runDownload({ manager, projectId, folder, signal, progress, waitReconnect, stopped }) {
  progress({ state: 'checking', files_done: 0, bytes_done: 0 }, true);
  const pages = await readManifest(manager, { project_id: projectId }, signal);
  const page = pages[pages.length - 1];
  const { kept, bad, failed, failedTotal } = writable(pages.flatMap((one) => one.entries));
  const totals = { files_total: kept.length, bytes_total: kept.reduce((sum, entry) => sum + entry.size, 0),
    skipped: page.skipped + bad };
  let filesDone = 0;
  let bytesDone = 0;
  progress({ ...totals, state: 'running', files_done: 0, bytes_done: 0 }, true);
  // The folder is checked again before anything is written (it may have been swapped since it was picked).
  if (!ownDirectory(folder)) throw new TransferEnd('team_download_folder_invalid');
  let stalled = 0;
  for (const entry of kept) {
    for (;;) {
      try {
        await downloadFile(manager, projectId, page, entry, await prepareParent(folder, entry.path), signal);
        break;
      } catch (error) {
        if (!(error instanceof LinkDropped)) throw error;
        stalled += 1;
        if (stalled >= LIMITS.stalledResumes || stopped()) throw new TransferEnd('team_not_connected');
        progress({ ...totals, state: 'waiting', files_done: filesDone, bytes_done: bytesDone }, true);
        await waitReconnect(signal);
      }
    }
    stalled = 0;
    filesDone += 1;
    bytesDone += entry.size;
    progress({ ...totals, state: 'running', files_done: filesDone, bytes_done: bytesDone });
  }
  return { ok: true, files: filesDone, bytes: bytesDone, skipped: totals.skipped, path: folder,
    ...(failedTotal > 0 ? { failed, failed_files: failedTotal } : {}) };
}

module.exports = { MAX_MANIFEST_PAGES, folderRefusal, runDownload };
