'use strict';

// One folder upload into a shared project (row 123 slice 3-9, commit 3; TEAM_PROJECTS_SPEC "Upload and download",
// the 3-8b part route). The member's folder is only read, never changed.
//
// `planUpload(root)` walks the picked folder (links are skipped and counted, never followed) and checks the host's
// caps, path rules, sensitive names (E69: refused with the name) and fold collisions before anything is sent,
// answering the host's own reason words.
// `runUpload` then hashes each file, sends `team.project.upload.begin`, sends every file's parts in order (two files
// at a time; a file's parts go one after another, as the host requires), and commits. A file that changes on disk
// between its hash and its last part ends the upload (`team_upload_changed`) and the upload is discarded. A lost link
// waits for the team to come back, reads `team.project.upload.status` and goes on from the bytes the host holds; a
// link lost `stalledResumes` times in a row without a byte moved ends it. Cancel stops within one part.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  HOST_ID, LIMITS, LinkDropped, TransferEnd, commandCall, failureReason, folderNameAllowed, hasCollision, isCount, partCall,
  pathAllowed, sensitiveFolder, sensitiveName,
} = require('./transfer-common');

const HASH_CHUNK = 1024 * 1024;

const refuse = (reason) => ({ ok: false, reason });
// E69: a name on the sensitive list is refused with the host's word and the name, as spelled in the member's own
// folder, so the member is told which one (never logged; it is the member's local name).
const refuseSensitive = (name) => ({ ok: false, reason: 'team_project_path_invalid', name });

/**
 * The entries under `root`, depth first, never following a link (a link or junction is counted, not entered), with
 * one asynchronous `lstat` per regular file. `onFile(relative, abs, size)` answering false stops the walk at once.
 * Answers { links, unreadable, truncated }; `truncated` when more than `limit` entries were seen.
 */
async function walkFolder(root, { onFile, limit = LIMITS.walkEntries }) {
  const totals = { links: 0, unreadable: 0, truncated: false };
  const pending = [''];
  let seen = 0;
  while (pending.length > 0) {
    const relative = pending.pop();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true }); } catch { totals.unreadable += 1; continue; }
    for (const entry of entries) {
      seen += 1;
      if (seen > limit) { totals.truncated = true; return totals; }
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isSymbolicLink()) { totals.links += 1; continue; }
      if (entry.isDirectory()) { pending.push(child); continue; }
      if (!entry.isFile()) { totals.unreadable += 1; continue; }
      const abs = path.join(root, child);
      let stat;
      try { stat = await fs.promises.lstat(abs); } catch { totals.unreadable += 1; continue; }
      if (!stat.isFile()) { totals.unreadable += 1; continue; }
      if (onFile(child, abs, stat.size) === false) return totals;
    }
  }
  return totals;
}

/** The picked folder's plan: { ok: true, folderName, files: [{ path, abs, size }], bytes, links, unreadable } or a refusal. */
async function planUpload(root, { walk = walkFolder } = {}) {
  const folderName = path.basename(root);
  if (!folderNameAllowed(folderName)) return refuse('team_project_path_invalid');
  if (sensitiveFolder(folderName)) return refuseSensitive(folderName);
  const files = [];
  let tooMany = false;
  let sensitive = null;
  // The walk stops at the first file past the begin cap (fix 9) or under a sensitive name (E69): nothing more is
  // read once the plan is refused.
  const totals = await walk(root, { limit: LIMITS.walkEntries, onFile: (relative, abs, size) => {
    if (sensitive !== null) return false;
    const slashed = relative.split(path.sep).join('/');
    sensitive = sensitiveName(slashed);
    if (sensitive !== null) return false;
    if (files.length >= LIMITS.beginFiles) { tooMany = true; return false; }
    files.push({ path: slashed, abs, size });
    return true;
  } });
  if (sensitive !== null) return refuseSensitive(sensitive);
  if (tooMany || totals.truncated) return refuse('team_upload_file_limit');
  if (files.length === 0) return refuse('team_upload_empty');
  let bytes = 0;
  for (const file of files) {
    if (!pathAllowed(file.path)) return refuse('team_project_path_invalid');
    if (!isCount(file.size) || file.size > LIMITS.maxFileBytes) return refuse('team_upload_size_limit');
    bytes += file.size;
  }
  if (bytes > LIMITS.maxUploadBytes) return refuse('team_upload_size_limit');
  if (hasCollision(files.map((file) => file.path))) return refuse('team_upload_manifest_invalid');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, folderName, files, bytes, links: totals.links, unreadable: totals.unreadable };
}

const sameFile = (stat, file) => stat.isFile() && stat.size === file.size && stat.mtimeMs === file.mtimeMs;

async function hashFile(file, signal) {
  const before = await fs.promises.lstat(file.abs);
  if (!before.isFile() || before.size !== file.size) throw new TransferEnd('team_upload_changed');
  file.mtimeMs = before.mtimeMs;
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(file.abs, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK, Math.max(file.size, 1)));
    let offset = 0;
    while (offset < file.size) {
      if (signal.aborted) throw new TransferEnd('aborted');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset);
      if (bytesRead === 0) throw new TransferEnd('team_upload_changed');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (!sameFile(await handle.stat(), file)) throw new TransferEnd('team_upload_changed');
  } finally {
    await handle.close().catch(() => {});
  }
  file.sha256 = hash.digest('hex');
}

function checkedBegin(answer) {
  if (answer?.ok !== true) return null;
  const partSize = answer.part_size;
  return typeof answer.upload_id === 'string' && HOST_ID.test(answer.upload_id) && Number.isSafeInteger(partSize)
    && partSize >= 1 && partSize <= LIMITS.maxPartBytes ? { uploadId: answer.upload_id, partSize } : null;
}

// The bytes the host holds per file, from a status answer; null when the answer does not fit this upload.
function receivedOf(answer, files) {
  if (answer?.ok !== true || !Array.isArray(answer.files) || answer.files.length !== files.length) return null;
  const received = [];
  for (const [index, row] of answer.files.entries()) {
    if (!row || row.index !== index || row.size !== files[index].size || !isCount(row.received) || row.received > row.size) return null;
    received.push(row.received);
  }
  return received;
}

/**
 * Runs a planned upload. deps: { manager, projectId, plan, signal, progress(fields, force), waitReconnect(signal),
 * stopped() }. Resolves { ok: true, files, bytes } or throws a TransferEnd.
 */
async function runUpload({ manager, projectId, plan, signal, progress, waitReconnect, stopped }) {
  const { files } = plan;
  const totals = { files_total: files.length, bytes_total: plan.bytes, links_skipped: plan.links,
    unreadable: plan.unreadable, folder: plan.folderName };
  progress({ ...totals, state: 'checking', files_done: 0, bytes_done: 0 }, true);
  for (const file of files) {
    if (signal.aborted) throw new TransferEnd('aborted');
    await hashFile(file, signal);
  }
  const ids = { project_id: projectId };
  const answer = await once(() => commandCall(manager, 'team.project.upload.begin', { ...ids,
    folder_name: plan.folderName, files: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })) }));
  if (answer?.ok !== true) throw new TransferEnd(failureReason(answer));
  const begun = checkedBegin(answer);
  if (!begun) throw new TransferEnd('team_answer_invalid');
  const upload = { uploadId: begun.uploadId, partSize: begun.partSize, received: files.map(() => 0) };
  plan.uploadId = upload.uploadId;
  const done = () => upload.received.reduce((sum, value) => sum + value, 0);
  const report = (force = false) => progress({ ...totals, state: 'running', bytes_done: done(),
    files_done: files.filter((file, index) => upload.received[index] === file.size).length }, force);
  report(true);
  let stalled = 0;
  for (;;) {
    const before = done();
    try {
      await sendAll(manager, projectId, files, upload, signal, report);
      break;
    } catch (error) {
      if (!(error instanceof LinkDropped)) throw error;
      stalled = done() > before ? 0 : stalled + 1;
      if (stalled >= LIMITS.stalledResumes || stopped()) throw new TransferEnd('team_not_connected');
      progress({ ...totals, state: 'waiting', bytes_done: done(), files_done: 0 }, true);
      await waitReconnect(signal);
      const status = await commandCall(manager, 'team.project.upload.status', { ...ids, upload_id: upload.uploadId })
        .catch((dropped) => { if (dropped instanceof LinkDropped) return null; throw dropped; });
      if (status === null) continue;
      const received = receivedOf(status, files);
      if (!received) throw new TransferEnd(status?.ok === true ? 'team_answer_invalid' : failureReason(status));
      upload.received = received;
      report(true);
    }
  }
  progress({ ...totals, state: 'committing', bytes_done: plan.bytes, files_done: files.length }, true);
  const committed = await once(() => commandCall(manager, 'team.project.upload.commit', { ...ids, upload_id: upload.uploadId }));
  if (committed?.ok !== true) throw new TransferEnd(failureReason(committed));
  plan.committed = true;
  return { ok: true, files: files.length, bytes: plan.bytes };

  // A begin or commit is sent once: no answer ends the upload (a resend could repeat it).
  async function once(run) {
    try { return await run(); } catch (error) {
      if (error instanceof LinkDropped) throw new TransferEnd('team_not_connected');
      throw error;
    }
  }
}

// Every file's remaining parts: two files at a time, each file's parts in order. The first failure stops both workers
// before their next part and is the one thrown (fix 10): a later lost link never hides a hard failure.
async function sendAll(manager, projectId, files, upload, signal, report) {
  const queue = files.map((file, index) => index).filter((index) => upload.received[index] < files[index].size);
  const run = { failure: null };
  const worker = async () => {
    while (queue.length > 0 && run.failure === null) {
      const index = queue.shift();
      try { await sendFile(manager, projectId, files[index], index, upload, signal, report, run); } catch (error) {
        if (run.failure === null) run.failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: LIMITS.partsInFlight }, worker));
  if (run.failure) throw run.failure;
}

async function sendFile(manager, projectId, file, index, upload, signal, report, run) {
  const handle = await fs.promises.open(file.abs, 'r');
  try {
    if (!sameFile(await handle.stat(), file)) throw new TransferEnd('team_upload_changed');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(upload.partSize, file.size));
    // Resuming inside a file: the bytes the host already holds are hashed again from disk.
    for (let offset = 0; offset < upload.received[index]; offset += buffer.length) {
      const length = Math.min(buffer.length, upload.received[index] - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new TransferEnd('team_upload_changed');
      hash.update(buffer.subarray(0, length));
    }
    while (upload.received[index] < file.size) {
      if (signal.aborted) throw new TransferEnd('aborted');
      if (run.failure !== null) return;
      const offset = upload.received[index];
      const length = Math.min(upload.partSize, file.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new TransferEnd('team_upload_changed');
      const bytes = buffer.subarray(0, length);
      const answer = await partCall(manager, (session, client) => session.putPart(client, { projectId,
        uploadId: upload.uploadId, index, n: offset / upload.partSize, bytes, signal }), signal);
      if (answer?.ok !== true) {
        // A stale part (the host holds a different count): read the status again, as after a lost link.
        if (answer?.error?.reason === 'team_upload_stale') throw new LinkDropped();
        throw new TransferEnd(failureReason(answer));
      }
      if (answer.index !== index || answer.received !== offset + length) throw new TransferEnd('team_answer_invalid');
      hash.update(bytes);
      upload.received[index] = offset + length;
      report();
    }
    if (run.failure !== null) return;
    if (!sameFile(await handle.stat(), file) || hash.digest('hex') !== file.sha256) throw new TransferEnd('team_upload_changed');
  } finally {
    await handle.close().catch(() => {});
  }
}

module.exports = { planUpload, runUpload, walkFolder };
