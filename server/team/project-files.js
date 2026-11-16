'use strict';

// Upload into and download from a team project's folder (TEAM_PROJECTS_SPEC "Upload and download", slice
// 3-8b). The commands are team.project.upload.{begin,status,commit,discard} and team.project.download.manifest;
// the raw part routes (project-file-routes.js) call the route half of this module.
//
// - The router has already run the one authorization function for the command's row (writer to upload,
//   reader to download); begin, commit and a manifest look again after every wait. An upload id or manifest
//   id is bound to the member, device and project that made it, and every use re-checks all three; a
//   forged or foreign id answers as a missing one. `recheck()` (the project-change and membership
//   subscribers) drops every upload and manifest whose member is now refused as forbidden, missing or
//   deleting, and their staged bytes; a doubt (the store closed, an authorization error) drops nothing.
// - An upload always makes one new top-level folder (`folder_name`), absent at begin and again at install.
// - E69 (owner, 2026-11-14): a `folder_name` or any file path segment on the sensitive list (path-segments.js
//   SENSITIVE_NAMES: .git, .github, .vscode, .env, .jenny, case folded) answers `team_project_path_invalid` at
//   begin, before the measure and before a byte is staged; the download listing never offers one.
// - begin runs on the host's one project chain (team-project-commands.js `serialized`). commit hashes the
//   staged bytes off the chain, then takes it for the re-check, the turn rule, the quota re-check and the
//   install; the staging cleanup runs after the chain is released. commit is refused while a turn runs in any
//   conversation of the project: checked before the hash, on the chain, again after the measure and last before the
//   rename (a turn does not run on this chain). A project being deleted refuses everything here.
// - Quotas: project-quota.js. Manifests, their audit and the part reads: project-manifests.js.
// - `files_uploaded` is appended after an install (a failed append is logged, the upload stands).
// - `team_upload_progress` goes to the uploading member only, live (ephemeral), at most once a second.
// - Every platform offers file transfer (Windows since slice 3-8c). A host with no transfer core (no projects root,
//   a staging root refused, or a Windows volume that fails file-checks.js's probe: team-project-files.js) answers
//   `team_project_files_unavailable` everywhere.
//
// Answers, events, logs and audit entries carry ids, counts and byte totals: never a file name or path, except
// the manifest page, which hands the reader the relative paths of the files it may download.

const crypto = require('node:crypto');

const { hostFailure } = require('../api-contract');
const { GENERAL_PROJECT_ID } = require('./member-schema');
const { isSensitiveSegment, sensitiveSegment } = require('./path-segments');
const { PATH_INVALID, ROOT_UNAVAILABLE, TARGET_EXISTS } = require('./project-folders');
const { createProjectManifests } = require('./project-manifests');
const { createProjectQuota } = require('./project-quota');
const { safeLogger } = require('./safe-logger');
const { TRANSFER_LIMITS, foldKey } = require('./transfer-manifest');

// Each operation, and whether it is a receipted mutation (the rest are answered without a receipt).
const RECEIPTED = Object.freeze({
  'team.project.upload.begin': true, 'team.project.upload.status': false, 'team.project.upload.commit': true,
  'team.project.upload.discard': false, 'team.project.download.manifest': false,
});
const OPERATIONS = Object.freeze(Object.keys(RECEIPTED));
const UPLOAD = 'project.files.upload';
const DOWNLOAD = 'project.files.download';
const PROGRESS_EVENT = 'team_upload_progress';
const MIB = 1024 * 1024;
// Decision 4 and the spec's caps; a caller may pass lower values only (a test seam).
const FILE_LIMITS = Object.freeze({
  beginFiles: 2_000, projectBytes: 2048 * MIB, projectFiles: 10_000, allBytes: 8192 * MIB, uploadsPerMember: 2,
  manifestsPerMember: 2, manifestIdleMs: 10 * 60 * 1000, pageSize: 1_000, progressMs: 1_000,
});
const FINISHED_LIMIT = 64;

const FORBIDDEN = hostFailure('forbidden', 'team_not_found').error.code;
const notFound = () => hostFailure('forbidden', 'team_not_found');
const stale = () => hostFailure('conflict', 'team_upload_stale');
const BUSY = 'team_project_busy';
const busy = () => hostFailure('conflict', BUSY);
const uploadLimit = () => hostFailure('limit', 'team_upload_limit');
const forbidden = (failure) => failure?.error?.code === FORBIDDEN;

function resolveLimits(limits = {}) {
  const resolved = { ...FILE_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(FILE_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > FILE_LIMITS[key]) {
      throw new RangeError('invalid_project_file_limit');
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

/**
 * core: the transfer core (null on a host with no file transfer). folders: project-folders.js. store: the member
 * store (project rows). serialized(fn): the host's project chain. audit(): the shared ProjectAudit or null.
 * turnRunning(projectId): true while a turn runs in any of its conversations (and on any doubt).
 * publish(type, payload, options). roots: the staging and projects roots for the disk reserve.
 */
function createProjectFiles({
  core = null, folders, store, authorize, serialized, audit = () => null, turnRunning = () => true,
  publish = () => {}, roots = [], statfs, clock = Date.now,
  randomBytes = crypto.randomBytes, logger = null, limits,
} = {}) {
  if (typeof authorize !== 'function' || typeof serialized !== 'function' || !store || !folders) {
    throw new TypeError('createProjectFiles requires folders, store, authorize and serialized.');
  }
  const config = resolveLimits(limits);
  const log = safeLogger(logger);
  const uploads = new Map();
  const finished = new Map();

  // Each entry point calls it once.
  function filesUnavailable() {
    if (!core) return hostFailure('unavailable', 'team_project_files_unavailable');
    return null;
  }

  // null while this device may take `action` on the project, else the refusal (an error is a missing one).
  const denial = (deviceId, action, projectId) => {
    try {
      const verdict = authorize({ device_id: deviceId }, action, { kind: 'project', id: projectId });
      return verdict?.ok === true ? null : (verdict?.error ? verdict : notFound());
    } catch {
      return notFound();
    }
  };

  // null for an active project, else the refusal: a row that is not there or one being deleted (forbidden), or a
  // store that cannot answer (unavailable).
  function projectGate(projectId) {
    if (projectId === GENERAL_PROJECT_ID) return notFound();
    let row;
    try { row = store.getProject(projectId); } catch { return hostFailure('unavailable', 'team_unavailable'); }
    if (!row) return notFound();
    if (row.state === 'deleting') return hostFailure('forbidden', 'team_project_deleting');
    return row.state === 'active' ? null : notFound();
  }
  const refusalFor = (deviceId, action, projectId) => denial(deviceId, action, projectId) || projectGate(projectId);

  const ownerKey = (memberId, deviceId, projectId) => crypto.createHash('sha256')
    .update(`${memberId}\u0000${deviceId}\u0000${projectId}`).digest('base64url');
  const bound = (record, memberId, deviceId, projectId) => record.memberId === memberId
    && record.deviceId === deviceId && record.projectId === projectId;
  const ids = (record) => ({ uploadId: record.id, ownerId: record.ownerId });

  // Forgets the record now; true when it was live. `done`: the caller finished it (answers stale for an hour).
  function forgetUpload(record, { done = false } = {}) {
    if (uploads.get(record.id) !== record) return false;
    uploads.delete(record.id);
    if (done) {
      finished.set(record.id, { memberId: record.memberId, deviceId: record.deviceId, projectId: record.projectId, at: clock() });
      while (finished.size > FINISHED_LIMIT) finished.delete(finished.keys().next().value);
    }
    return true;
  }
  // A lapsed upload is no longer the core's to discard by id: its sweep removes it.
  const removeStaging = (record) => Promise.resolve(core?.discard(ids(record)))
    .then((answer) => (answer?.ok === false ? core.sweep() : answer)).catch(() => {});
  // Forgets the record and removes its staging; a caller that must answer at once leaves the promise.
  function dropUpload(record, options) {
    forgetUpload(record, options);
    return removeStaging(record);
  }

  // A live upload for this caller, or a refusal: missing for a forged, foreign or lapsed id, stale for one
  // this caller finished (committed or discarded) within the last hour.
  function uploadFor(uploadId, memberId, deviceId, projectId) {
    const record = typeof uploadId === 'string' ? uploads.get(uploadId) : undefined;
    if (record && bound(record, memberId, deviceId, projectId)) {
      if (core.alive(ids(record))) return { record };
      dropUpload(record); // lapsed in the core: its slot and staging go
      return { failure: notFound() };
    }
    const done = typeof uploadId === 'string' ? finished.get(uploadId) : undefined;
    if (done && bound(done, memberId, deviceId, projectId) && clock() - done.at < TRANSFER_LIMITS.idleMs) {
      return { failure: stale() };
    }
    return { failure: notFound() };
  }

  const quota = createProjectQuota({ folders, store, limits: config, openUploads: () => [...uploads.values()],
    held: () => core.resources(), roots, statfs, clock, log });

  // One audit entry; true only when the shared log answered ok.
  function appended(entry) {
    try {
      return audit()?.append(entry)?.ok === true;
    } catch {
      return false;
    }
  }

  const manifests = createProjectManifests({ folders, limits: config, appended, clock, randomBytes, log,
    stillAllowed: (deviceId, projectId) => refusalFor(deviceId, DOWNLOAD, projectId) });

  // ---------------------------------------------------------------- upload commands

  async function begin({ params, actor }) {
    const { project_id: projectId, folder_name: folderName, files } = params;
    const refused = refusalFor(actor.device_id, UPLOAD, projectId);
    if (refused) return refused;
    if (!Array.isArray(files) || files.length === 0) return hostFailure('invalid', 'team_upload_manifest_invalid');
    if (files.length > config.beginFiles) return hostFailure('limit', 'team_upload_file_limit');
    // E69: a folder name or a path segment on the sensitive list is refused before any measure or staging.
    if (isSensitiveSegment(folderName) || files.some((entry) => sensitiveSegment(entry?.path) !== null)) {
      return hostFailure('invalid', PATH_INVALID);
    }
    if ([...uploads.values()].filter((record) => record.memberId === actor.member_id).length >= config.uploadsPerMember) {
      return uploadLimit();
    }
    const child = folders.childState(projectId, folderName);
    if (!child.ok) return hostFailure(child.reason === PATH_INVALID ? 'invalid' : 'unavailable', child.reason);
    const key = foldKey(folderName);
    if (child.state !== 'absent' || [...uploads.values()].some((record) => record.projectId === projectId
      && record.folderKey === key)) return hostFailure('conflict', TARGET_EXISTS);
    const declared = files.reduce((total, entry) => total + (Number.isSafeInteger(entry?.size) ? entry.size : 0), 0);
    const over = await quota.refusal(projectId, files.length, declared) || quota.diskRefusal(declared);
    if (over) return over;
    const ownerId = ownerKey(actor.member_id, actor.device_id, projectId);
    const begun = await core.begin({ ownerId, files });
    if (!begun.ok) return begun;
    // The measure and the staging mkdir awaited: the caller is checked again before the upload exists.
    const again = refusalFor(actor.device_id, UPLOAD, projectId);
    if (again) {
      await Promise.resolve(core.discard({ uploadId: begun.uploadId, ownerId })).catch(() => {});
      return again;
    }
    const record = { id: begun.uploadId, ownerId, memberId: actor.member_id, deviceId: actor.device_id, projectId,
      folderName, folderKey: key, fileCount: files.length, totalBytes: declared, partSize: begun.partSize,
      filesDone: files.filter((entry) => entry.size === 0).length, bytesDone: 0, progressAt: -Infinity };
    uploads.set(record.id, record);
    log('INFO', 'team.project_files.upload_begun', { project_id: projectId, upload_id: record.id, files: files.length,
      bytes: declared });
    return { ok: true, upload_id: record.id, part_size: record.partSize };
  }

  function status({ params, actor }) {
    const found = uploadFor(params.upload_id, actor.member_id, actor.device_id, params.project_id);
    if (found.failure) return found.failure;
    const answer = core.status(ids(found.record));
    return answer.ok ? { ok: true, upload_id: found.record.id, verified: answer.verified, files: answer.files } : answer;
  }

  async function discard({ params, actor }) {
    const found = uploadFor(params.upload_id, actor.member_id, actor.device_id, params.project_id);
    if (found.failure) return found.failure;
    await dropUpload(found.record, { done: true });
    log('INFO', 'team.project_files.upload_discarded', { project_id: found.record.projectId, upload_id: found.record.id });
    return { ok: true, upload_id: found.record.id };
  }

  function installRefusal(reason) {
    const kind = { [TARGET_EXISTS]: 'conflict', [BUSY]: 'conflict', [ROOT_UNAVAILABLE]: 'unavailable', [PATH_INVALID]: 'invalid' }[reason]
      || 'persistence';
    return hostFailure(kind, kind === 'persistence' ? 'team_upload_install_failed' : reason);
  }

  // On the chain: everything that must not interleave with another begin or install. `cleanup` asks the caller
  // to remove the staging once the chain is released.
  async function installVerified(record, actor) {
    if (uploads.get(record.id) !== record) return { answer: notFound() };
    const again = refusalFor(actor.device_id, UPLOAD, record.projectId);
    if (again) return { answer: again, cleanup: forgetUpload(record) };
    // A busy project or a full quota leaves the upload verified: a later commit installs it without a new hash.
    if (turnRunning(record.projectId) !== false) return { answer: busy() };
    const over = await quota.refusal(record.projectId, 0, 0);
    if (over) return { answer: over };
    // The measure awaited, and a turn does not run on this chain (review round two, R15-F03): the turn rule again,
    // with nothing awaited between it and the take. A turn that starts during the build stops the rename (`ready`).
    if (turnRunning(record.projectId) !== false) return { answer: busy() };
    const taken = core.take(record.id, record.ownerId);
    if (!taken.ok) return { answer: taken, cleanup: forgetUpload(record, { done: true }) };
    const installed = await folders.install(record.projectId, record.folderName, record.id,
      taken.files.map((entry) => ({ path: entry.path, size: entry.size, stagedPath: entry.stagedPath })),
      { ready: () => (turnRunning(record.projectId) !== false ? BUSY : null) });
    forgetUpload(record, { done: true });
    if (!installed.ok) return { answer: installRefusal(installed.reason), cleanup: true };
    quota.installed(record.projectId, installed.bytes, installed.files);
    if (!appended({ kind: 'files_uploaded', project_id: record.projectId, actor_member_id: record.memberId,
      detail: { files: installed.files, bytes: installed.bytes, skipped: 0 } })) {
      log('WARN', 'team.project_files.upload_unrecorded', { project_id: record.projectId, upload_id: record.id });
    }
    log('INFO', 'team.project_files.installed', { project_id: record.projectId, upload_id: record.id,
      files: installed.files, bytes: installed.bytes, linked: installed.linked });
    return { answer: { ok: true, upload_id: record.id, files: installed.files, bytes: installed.bytes }, cleanup: true };
  }

  async function commit({ params, actor }) {
    const found = uploadFor(params.upload_id, actor.member_id, actor.device_id, params.project_id);
    if (found.failure) return found.failure;
    const { record } = found;
    const refused = refusalFor(actor.device_id, UPLOAD, record.projectId);
    if (refused) return refused;
    if (turnRunning(record.projectId) !== false) return busy();
    // The hash pass, off the chain (skipped for an upload a busy or full answer left verified).
    if (core.status(ids(record)).verified !== true) {
      const verified = await core.commit(ids(record));
      if (!verified.ok) {
        // A hash mismatch or a staging failure removed the upload in the core; an incomplete one stays open.
        if (!core.alive(ids(record))) dropUpload(record, { done: true });
        return verified;
      }
    }
    const outcome = await serialized(() => installVerified(record, actor));
    if (outcome.cleanup) await removeStaging(record);
    return outcome.answer;
  }

  // ---------------------------------------------------------------- download manifest

  async function downloadManifest({ params, actor }) {
    const refused = projectGate(params.project_id);
    if (refused) return refused;
    if (params.manifest_id === undefined) return manifests.build(params.project_id, actor.member_id, actor.device_id);
    const manifest = manifests.manifestFor(params.manifest_id, actor.member_id, actor.device_id, params.project_id);
    return manifest ? manifests.page(manifest, params.cursor) : notFound();
  }

  // ---------------------------------------------------------------- the route half

  function progress(record, force) {
    const now = clock();
    if (!force && now - record.progressAt < config.progressMs) return;
    record.progressAt = now;
    try {
      publish(PROGRESS_EVENT, { upload_id: record.id, files_done: record.filesDone, bytes_done: record.bytesDone },
        { audience: new Set([record.memberId]), bucket: `project:${record.projectId}`, ephemeral: true });
    } catch { /* transport is best effort */ }
  }

  // One part of a bound upload: part `n` is offset `n * partSize`.
  async function writePart(record, index, n, bytes) {
    if (uploads.get(record.id) !== record) return notFound();
    const written = await core.writePart({ ...ids(record), index, offset: n * record.partSize, bytes });
    if (!written.ok) {
      if (!core.alive(ids(record))) dropUpload(record);
      return written;
    }
    record.bytesDone += bytes.length;
    if (written.complete) record.filesDone += 1;
    progress(record, record.bytesDone === record.totalBytes);
    return { ok: true, index: written.index, received: written.received, complete: written.complete };
  }

  // Every upload and manifest whose member is now refused as forbidden, missing or deleting goes, with its staged
  // bytes (the project-change and membership subscribers). A project being deleted loses its measure.
  function recheck(event = null) {
    if (event && ['deleting', 'deleted'].includes(event.reason) && typeof event.project_id === 'string') {
      quota.forget(event.project_id);
    }
    let open;
    try { open = store.open().ok === true; } catch { open = false; }
    if (!open) {
      log('WARN', 'team.project_files.recheck_skipped', { reason: 'team_unavailable' });
      return 0;
    }
    const gone = (deviceId, action, projectId) => {
      let verdict;
      try { verdict = authorize({ device_id: deviceId }, action, { kind: 'project', id: projectId }); } catch { return false; }
      return (verdict?.ok !== true && forbidden(verdict)) || forbidden(projectGate(projectId));
    };
    let dropped = 0;
    for (const record of [...uploads.values()]) {
      if (!gone(record.deviceId, UPLOAD, record.projectId)) continue;
      dropUpload(record);
      dropped += 1;
    }
    dropped += manifests.retain((manifest) => !gone(manifest.deviceId, DOWNLOAD, manifest.projectId));
    if (dropped > 0) log('INFO', 'team.project_files.revoked', { count: dropped });
    return dropped;
  }

  // The idle sweep: lapsed uploads (one hour) and manifests (ten minutes).
  async function sweep() {
    if (!core) return;
    await core.sweep();
    for (const record of [...uploads.values()]) if (!core.alive(ids(record))) dropUpload(record);
    manifests.sweep();
  }

  const HANDLERS = {
    'team.project.upload.begin': (call) => serialized(() => begin(call)),
    'team.project.upload.status': status,
    'team.project.upload.commit': commit,
    'team.project.upload.discard': discard,
    'team.project.download.manifest': downloadManifest,
  };

  // `call` is { params, actor: { member_id, owner, device_id } } from team-commands.js.
  async function dispatch(command, call) {
    const unavailable = filesUnavailable();
    if (unavailable) return unavailable;
    if (!Object.hasOwn(HANDLERS, command.operation) || typeof call?.actor?.device_id !== 'string') {
      return hostFailure('invalid', 'unsupported_operation');
    }
    return HANDLERS[command.operation](call);
  }

  return Object.freeze({
    handles: (operation) => Object.hasOwn(RECEIPTED, operation),
    isRead: (operation) => RECEIPTED[operation] === false,
    dispatch,
    // The route half (project-file-routes.js).
    filesUnavailable, projectGate, uploadFor, manifestFor: manifests.manifestFor, writePart, readPart: manifests.readPart,
    recheck, sweep,
    resources: () => ({ uploads: uploads.size, manifests: manifests.size(), measured: quota.size() }),
  });
}

module.exports = { FILE_LIMITS, OPERATIONS, createProjectFiles };
