'use strict';

// The team transfer core (slice 3-8a, TEAM_PROJECTS_SPEC "Upload and
// download", owner decisions E18 and E26). It moves a manifest of files into a
// staging directory and verifies them, and knows nothing about projects,
// members or roles: its owner is an opaque id the caller has already
// authorized. Slice 3-8b installs a verified upload into a project folder;
// Phase 6's model transfer reuses the same core.
//
// - Staging lives in `<stagingRoot>/<uploadId>/`, made with an exclusive
//   mkdir. Each manifest entry has one staging file named by its index
//   (`<index>.part`); no client path, name or segment reaches a filesystem
//   call. The upload id comes from the injected random source and is checked
//   against its own pattern before every path join.
// - A part is accepted only at the file's current length (no reordering, no
//   sparse writes); `status` reports bytes received so a client can resume.
//   Work on one upload runs one task at a time.
// - `commit` hashes each staged file as a stream (each chunk is an await, so
//   the event loop is never held for the whole upload) and answers no host
//   path. A verified upload is taken once by `take`, the only call that
//   gives the staged paths, and removed by `discard`.
// - Uploads do not survive a restart: `open()` removes every leftover staging
//   directory. Idle expiry runs on the injected clock through `sweep`; the
//   core owns no timer.
// - Logs and failures carry ids, counts, byte totals and reasons only: never
//   a path, a file name or a hash.

const fs = require('node:fs');
const path = require('node:path');

const { removeTree } = require('../../services/fs-remove-no-follow');
const { hostFailure } = require('../api-contract');
const { ownDirectory } = require('./file-checks');
const { safeLogger } = require('./safe-logger');
const { createTransferIo } = require('./transfer-io');
const { TRANSFER_LIMITS, validateManifest } = require('./transfer-manifest');

const fsp = fs.promises;

const UPLOAD_ID = /^upload_[A-Za-z0-9_-]{22}$/u;
const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const ID_BYTES = 16;
// Parts copied and waiting per upload (orchestrator decision, fix round).
const MAX_PENDING_PARTS = 4;

const notFound = () => hostFailure('forbidden', 'team_not_found');
const stale = () => hostFailure('conflict', 'team_upload_stale');
const unavailable = () => hostFailure('unavailable', 'host_unavailable');
const invalid = () => hostFailure('invalid', 'team_upload_manifest_invalid');
const sizeLimit = () => hostFailure('limit', 'team_upload_size_limit');
const stagingFailed = () => hostFailure('persistence', 'team_upload_staging_failed');

function resolveLimits(limits) {
  const resolved = { ...TRANSFER_LIMITS };
  for (const [key, value] of Object.entries(limits || {})) {
    if (!Object.hasOwn(TRANSFER_LIMITS, key) || !Number.isSafeInteger(value) || value <= 0
      || value > TRANSFER_LIMITS[key]) {
      throw new RangeError('invalid_transfer_limit');
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/u.test(error.code) ? error.code : 'unknown';
}

/**
 * Create a transfer core. `stagingRoot` must be an existing real directory
 * (checked by `open()`); `clock` answers milliseconds; `randomBytes(n)`
 * answers a Buffer; `logger(level, event, fields)` is optional.
 */
function createTransferCore({ stagingRoot, clock, randomBytes, logger, limits } = {}) {
  if (typeof stagingRoot !== 'string' || stagingRoot.length === 0) throw new TypeError('stagingRoot is required.');
  if (typeof clock !== 'function') throw new TypeError('clock is required.');
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes is required.');
  const config = resolveLimits(limits);
  const log = safeLogger(logger);
  const uploads = new Map();
  const removals = new Set();
  // new -> opening -> open -> closed; a refused open goes back to new.
  let state = 'new';
  let closing = null;
  let root = null;
  let stagedTotal = 0;
  let reservedTotal = 0;
  let openHandles = 0;
  // Checked staging IO (transfer-io.js); its opens and closes feed resources().openHandles.
  const io = createTransferIo({ onHandle: (delta) => { openHandles += delta; } });

  const ready = () => state === 'open';
  const expired = (upload, now) => now - upload.touched >= config.idleMs;

  // Queue `task` behind the upload's earlier work. The queue never rejects.
  function run(upload, task) {
    const result = upload.queue.then(task).catch((error) => {
      log('ERROR', 'team_transfer.task_failed', { upload_id: upload.id, code: errorCode(error) });
      return stagingFailed();
    });
    upload.queue = result.then(() => {}, () => {});
    return result;
  }

  async function removeDirectory(directory, uploadId) {
    try {
      await removeTree(directory);
    } catch (error) {
      log('WARN', 'team_transfer.remove_failed', { upload_id: uploadId, code: errorCode(error) });
    }
  }

  const current = (upload) => uploads.get(upload.id) === upload;

  // Drop the upload from memory and give back its staged and reserved bytes.
  function forget(upload) {
    uploads.delete(upload.id);
    stagedTotal -= upload.staged;
    reservedTotal -= upload.reserved;
  }

  // Forget the upload now (lookups fail at once) and remove its directory
  // after any task already queued for it. A task removing its own upload
  // passes `fromTask`, since waiting on its own queue would never finish.
  function remove(upload, { fromTask = false } = {}) {
    if (!current(upload)) return upload.removal || Promise.resolve();
    forget(upload);
    const removal = fromTask
      ? removeDirectory(upload.dir, upload.id)
      : upload.queue.then(() => removeDirectory(upload.dir, upload.id));
    upload.queue = removal;
    upload.removal = removal;
    removals.add(removal);
    removal.finally(() => removals.delete(removal));
    return removal;
  }

  // Another owner's id, an unknown id, a malformed id and an expired id all
  // answer null, so every caller answers them exactly alike. A lookup does not
  // refresh the idle time: only a successful part, commit or take does, so
  // polling or refused parts cannot keep an upload alive.
  function lookup(uploadId, ownerId) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID.test(uploadId)) return null;
    const upload = uploads.get(uploadId);
    if (!upload || upload.ownerId !== ownerId || expired(upload, clock())) return null;
    return upload;
  }

  // Forgets every lapsed upload synchronously; the returned promise settles
  // when their directories are gone (each removal is tracked for close()).
  async function expire(now) {
    const lapsed = [...uploads.values()].filter((upload) => expired(upload, now));
    const removing = lapsed.map((upload) => remove(upload));
    await Promise.all(removing);
    if (lapsed.length > 0) log('INFO', 'team_transfer.expired', { count: lapsed.length });
    return lapsed.length;
  }

  async function rootUnchanged() {
    try {
      const stat = await fsp.lstat(root.path, { bigint: true });
      return stat.isDirectory() && stat.dev === root.dev && stat.ino === root.ino;
    } catch (_error) {
      return false;
    }
  }

  function refuseRoot(reason) {
    log('ERROR', 'team_transfer.root_refused', { reason });
    return unavailable();
  }

  // A second open() while one runs is refused; a close() during it wins.
  async function open() {
    if (state !== 'new') return unavailable();
    state = 'opening';
    const result = await openRoot();
    if (state !== 'opening') return unavailable();
    if (!result.ok) {
      state = 'new';
      return result;
    }
    root = result.root;
    state = 'open';
    log('INFO', 'team_transfer.opened', { removed: result.removed, unexpected: result.unexpected });
    return { ok: true, removed: result.removed, unexpected: result.unexpected };
  }

  async function openRoot() {
    if (!path.isAbsolute(stagingRoot)) return refuseRoot('not_absolute');
    const rootPath = path.resolve(stagingRoot);
    // A real directory at its own native real path (file-checks.js `ownDirectory`): a link, junction, substituted
    // drive or 8.3 alias on the way is refused; on Windows an ASCII letter typed in another case is the same folder.
    const stat = ownDirectory(rootPath);
    if (stat === null) return refuseRoot(fs.existsSync(rootPath) ? 'not_real_directory' : 'missing');
    let removed = 0;
    let unexpected = 0;
    try {
      for (const entry of await fsp.readdir(rootPath, { withFileTypes: true })) {
        if (UPLOAD_ID.test(entry.name) && entry.isDirectory()) {
          await removeTree(path.join(rootPath, entry.name));
          removed += 1;
        } else {
          unexpected += 1;
        }
      }
    } catch (error) {
      log('ERROR', 'team_transfer.leftovers_failed', { removed, code: errorCode(error) });
      return unavailable();
    }
    return { ok: true, root: { path: rootPath, dev: stat.dev, ino: stat.ino }, removed, unexpected };
  }

  // The per-owner and overall upload slots. Lapsed uploads give theirs back
  // first; their directories go in the background (tracked for close()).
  function slotRefusal(ownerId) {
    expire(clock());
    const owned = [...uploads.values()].filter((upload) => upload.ownerId === ownerId).length;
    if (owned >= config.maxUploadsPerOwner) return hostFailure('limit', 'team_upload_limit');
    if (uploads.size >= config.maxUploads) return hostFailure('limit', 'team_upload_limit', '', true);
    return null;
  }

  async function begin({ ownerId, files, maxTotalBytes } = {}) {
    if (!ready()) return unavailable();
    if (typeof ownerId !== 'string' || !OWNER_ID.test(ownerId)) throw new TypeError('ownerId is invalid.');
    // A caller with no free slot is refused before the manifest pass, which
    // costs synchronous host time for a large manifest.
    const early = slotRefusal(ownerId);
    if (early) return early;
    let quota = config.maxUploadBytes;
    if (maxTotalBytes !== undefined) {
      if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) return invalid();
      quota = Math.min(quota, maxTotalBytes);
    }
    const manifest = validateManifest(files, config);
    if (!manifest.ok) return manifest;
    if (manifest.totalBytes > quota) return sizeLimit();
    const rootOk = await rootUnchanged();
    // A close() during the lstat is a shutdown, not a root change.
    if (!ready()) return unavailable();
    if (!rootOk) return refuseRoot('changed');
    // Checked again: from here to the reservation below nothing awaits, so
    // the caps hold against begins that passed the early check concurrently.
    const refusal = slotRefusal(ownerId);
    if (refusal) return refusal;
    if (reservedTotal + manifest.totalBytes > config.maxReservedBytes) {
      return hostFailure('limit', 'team_upload_limit', '', true);
    }
    const bytes = randomBytes(ID_BYTES);
    const uploadId = Buffer.isBuffer(bytes) && bytes.length === ID_BYTES ? `upload_${bytes.toString('base64url')}` : '';
    if (!UPLOAD_ID.test(uploadId)) return refuseRoot('random_source');
    if (uploads.has(uploadId)) return stagingFailed();
    const upload = {
      id: uploadId,
      ownerId,
      files: manifest.files,
      received: manifest.files.map(() => 0),
      staged: 0,
      reserved: manifest.totalBytes,
      pending: 0,
      dir: path.join(root.path, uploadId),
      status: 'open',
      verified: null,
      touched: clock(),
      queue: Promise.resolve(),
      removal: null,
    };
    uploads.set(uploadId, upload);
    reservedTotal += upload.reserved;
    const made = fsp.mkdir(upload.dir, { mode: 0o700 }).then(() => null, (error) => error);
    upload.queue = made.then(() => {});
    const error = await made;
    if (error) {
      // Never remove a directory this call did not make.
      if (current(upload)) forget(upload);
      log('ERROR', 'team_transfer.staging_failed', { upload_id: uploadId, code: errorCode(error) });
      return stagingFailed();
    }
    // close() during the mkdir has already queued this directory's removal.
    if (!current(upload)) return unavailable();
    log('INFO', 'team_transfer.begun', {
      upload_id: uploadId, files: manifest.files.length, bytes: manifest.totalBytes,
    });
    return { ok: true, uploadId, partSize: config.maxPartBytes };
  }

  async function writePart({ uploadId, ownerId, index, offset, bytes } = {}) {
    if (!ready()) return unavailable();
    const upload = lookup(uploadId, ownerId);
    if (!upload || !Number.isInteger(index) || index < 0 || index >= upload.files.length) return notFound();
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || !Number.isSafeInteger(offset) || offset < 0) {
      return invalid();
    }
    if (bytes.length > config.maxPartBytes) return sizeLimit();
    // Every part but the one that ends its file is exactly partSize, which
    // bounds the parts (and file system calls) an upload can take.
    if (offset + bytes.length < upload.files[index].size && bytes.length !== config.maxPartBytes) return invalid();
    // Bounded before the copy: at most MAX_PENDING_PARTS copies wait per upload.
    if (upload.pending >= MAX_PENDING_PARTS) return hostFailure('limit', 'team_upload_limit', '', true);
    upload.pending += 1;
    // A copy: the caller's buffer may be reused while the part waits its turn.
    const part = Buffer.from(bytes);
    return run(upload, async () => {
      try {
        return await writeQueued(upload, index, offset, part);
      } finally {
        upload.pending -= 1;
      }
    });
  }

  async function writeQueued(upload, index, offset, part) {
    if (!current(upload)) return notFound();
    if (upload.status !== 'open' || offset !== upload.received[index]) return stale();
    if (offset + part.length > upload.files[index].size) return sizeLimit();
    try {
      await io.writeAt(path.join(upload.dir, `${index}.part`), offset, part);
    } catch (error) {
      log('ERROR', 'team_transfer.staging_failed', { upload_id: upload.id, code: errorCode(error) });
      await remove(upload, { fromTask: true });
      return stagingFailed();
    }
    if (!current(upload)) return notFound();
    upload.received[index] += part.length;
    upload.staged += part.length;
    stagedTotal += part.length;
    upload.touched = clock();
    const done = upload.received[index];
    return { ok: true, index, received: done, complete: done === upload.files[index].size };
  }

  function status({ uploadId, ownerId } = {}) {
    if (!ready()) return unavailable();
    const upload = lookup(uploadId, ownerId);
    if (!upload) return notFound();
    return {
      ok: true,
      verified: upload.status !== 'open',
      files: upload.files.map((entry, index) => ({ index, size: entry.size, received: upload.received[index] })),
    };
  }

  // A cheap liveness read: true while the upload is open to this owner (no file list is built).
  function alive({ uploadId, ownerId } = {}) {
    return ready() && lookup(uploadId, ownerId) !== null;
  }

  async function commit({ uploadId, ownerId } = {}) {
    if (!ready()) return unavailable();
    const upload = lookup(uploadId, ownerId);
    if (!upload) return notFound();
    return run(upload, async () => {
      if (!current(upload)) return notFound();
      if (upload.status !== 'open') return stale();
      if (upload.files.some((entry, index) => upload.received[index] !== entry.size)) return stale();
      const verified = [];
      for (const [index, entry] of upload.files.entries()) {
        const stagedPath = path.join(upload.dir, `${index}.part`);
        let digest;
        try {
          digest = await io.hashFile(stagedPath, entry.size);
        } catch (error) {
          log('ERROR', 'team_transfer.staging_failed', { upload_id: upload.id, code: errorCode(error) });
          await remove(upload, { fromTask: true });
          return stagingFailed();
        }
        if (!current(upload)) return notFound();
        if (digest !== entry.sha256) {
          log('WARN', 'team_transfer.hash_mismatch', { upload_id: upload.id, index });
          await remove(upload, { fromTask: true });
          return hostFailure('invalid', 'team_upload_hash_mismatch');
        }
        verified.push(Object.freeze({ index, path: entry.path, size: entry.size, sha256: entry.sha256, stagedPath }));
      }
      upload.status = 'verified';
      upload.verified = Object.freeze(verified);
      upload.touched = clock();
      log('INFO', 'team_transfer.committed', { upload_id: upload.id, files: verified.length, bytes: upload.staged });
      const files = verified.map(({ stagedPath: _staged, ...item }) => Object.freeze(item));
      return { ok: true, files: Object.freeze(files) };
    });
  }

  // Hands a verified upload to its installer once. The staged files stay until
  // `discard`.
  function take(uploadId, ownerId) {
    if (!ready()) return unavailable();
    const upload = lookup(uploadId, ownerId);
    if (!upload) return notFound();
    if (upload.status !== 'verified') return stale();
    upload.status = 'taken';
    upload.touched = clock();
    return { ok: true, files: upload.verified };
  }

  async function discard({ uploadId, ownerId } = {}) {
    if (!ready()) return unavailable();
    const upload = lookup(uploadId, ownerId);
    if (!upload) return notFound();
    await remove(upload);
    log('INFO', 'team_transfer.discarded', { upload_id: upload.id });
    return { ok: true };
  }

  async function sweep(now = clock()) {
    if (!ready()) return { ok: true, expired: 0 };
    return { ok: true, expired: await expire(now) };
  }

  // Every close() answers the first one's promise, which settles only once
  // every directory is gone.
  function close() {
    if (closing) return closing;
    const count = uploads.size;
    state = 'closed';
    closing = (async () => {
      await Promise.all([...uploads.values()].map((upload) => remove(upload)));
      await Promise.all([...removals]);
      log('INFO', 'team_transfer.closed', { uploads: count });
      return { ok: true };
    })();
    return closing;
  }

  function resources() {
    return { uploads: uploads.size, stagedBytes: stagedTotal, reservedBytes: reservedTotal, openHandles };
  }

  return Object.freeze({
    open, begin, writePart, status, alive, commit, take, discard, sweep, close, resources,
  });
}

module.exports = { createTransferCore, UPLOAD_ID_PATTERN: UPLOAD_ID };
