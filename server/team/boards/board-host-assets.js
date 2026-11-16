'use strict';

// Team boards T6 (row 151, plan PROJECT_BOARD_2026-11-13 sections 6.1, 6.4, 6.6 and 8.1): the team host's picture
// store, one folder a project over the guarded file layer (board-host-files.js).
//
//   <profile>/team-boards/<project_id>/assets/<sha256>.<ext>       ext png | jpg | webp | gif, by content
//   <profile>/team-boards/<project_id>/assets/unreferenced.json    { schema_version: 1, since: { <sha256>: <ISO> } }
//
// - A picture belongs to one project and is shared by that project's boards. Its type comes from its bytes only
//   (services/boards/board-image-info.js); SVG and everything else is refused. Its name is its SHA-256, checked
//   against the bytes on the way in and again on every read.
// - put checks, in this order, the id shapes, the size (10 MiB), the hash, the type and dimensions (each side as the
//   board model allows, and 64 million pixels in all: a small file must not open as a huge picture on every member's
//   screen), that the project folder exists (it is never made here: a removed project stays removed), whether the
//   picture is already stored (success, nothing written, its clock removed), and the project's total (256 MiB, 8192
//   pictures); then it writes through a temp file and a rename. Writes to one project are serialized. The count cap
//   keeps a project's folder far under the files layer's listing bound, past which neither an upload nor the sweep
//   could see it whole.
// - A full project makes room before it refuses: pictures no board file names now, and that a sweep already saw
//   unused at least ten minutes ago (their clock is running), go, oldest clock first, until the new one fits. So one
//   member's unused uploads hold the project's allowance until the next sweep, not for seven days. The decision is
//   made on the board store's full view like the sweep's, at most once a minute a project.
// - sweep: a picture unreferenced for more than 7 days is removed. Which pictures are referenced comes from `refs`
//   (the board store's assetRefs, bound by the caller); the decision and the removal run inside `use`, in the same
//   synchronous stretch as the board store's scan. A `refs` that answers anything but `{ ok: true }` or throws skips
//   the project: nothing is removed and no clock is written. A corrupt clocks file is rebuilt; a newer one is never
//   rewritten and its project is skipped.
// - Every method is async, never throws, and answers `{ ok: true, ... }` or a hostFailure. A transient file error
//   answers team_board_unavailable (retryable) and latches nothing. Logs carry a project id, counts, a reason word
//   or an error code: never a hash, a path or a byte.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ids = require('../../../services/boards/board-ids');
const { imageInfo } = require('../../../services/boards/board-image-info');
const { LIMITS } = require('../../../services/boards/board-model');
const durable = require('../../../services/host/durable-json');
const { assertSafeFile } = require('../../../services/host/path-guard');
const { hostFailure } = require('../../api-contract');
const { safeLogger } = require('../safe-logger');
const { BOARDS_ROOT, createBoardFiles, isTeamProjectId } = require('./board-host-files');
const { TEAM_BOARD_LIMITS } = require('./team-boards');

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// Making room in a full project: how long a picture's clock has run before it may go, and how often a project is tried.
const ROOM_AGE_MS = 10 * 60 * 1000;
const ROOM_RETRY_MS = 60 * 1000;
const ROOM_TRIED_MAX = 1024;
const FULL = Symbol('full');
const CLOCKS_SCHEMA_VERSION = 1;
const CLOCKS_MAX = 20000;
const CLOCKS_READ_BYTES = 4 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
// Options may only lower these.
const ASSET_LIMITS = Object.freeze({ assetBytes: TEAM_BOARD_LIMITS.assetBytes, pictureBytes: LIMITS.image_asset_bytes,
  pictures: 8192, pixels: 64_000_000 });

const answers = Object.freeze({
  NOT_FOUND: () => hostFailure('forbidden', 'team_board_not_found'),
  ASSET_NOT_FOUND: () => hostFailure('forbidden', 'team_board_asset_not_found'),
  INVALID: () => hostFailure('invalid', 'team_board_asset_invalid'),
  SIZE: () => hostFailure('limit', 'team_board_asset_size_limit'),
  MISMATCH: () => hostFailure('invalid', 'team_board_asset_mismatch'),
  UNSUPPORTED: () => hostFailure('invalid', 'team_board_asset_unsupported'),
  DIMENSIONS: () => hostFailure('invalid', 'team_board_asset_dimensions'),
  STORAGE: () => hostFailure('limit', 'team_board_asset_storage_limit'),
  UNAVAILABLE: () => hostFailure('unavailable', 'team_board_unavailable', '', true),
});
const { NOT_FOUND, ASSET_NOT_FOUND, UNAVAILABLE } = answers;

const isHash = (value) => typeof value === 'string' && value.length === 64 && HASH_RE.test(value);
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const codeOf = (error) => durable.logCode(error?.code ?? null) ?? 'failed';

function resolveLimits(limits = {}) {
  const resolved = { ...ASSET_LIMITS };
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!Object.hasOwn(ASSET_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > ASSET_LIMITS[key]) {
      throw new RangeError('invalid_team_board_asset_limit');
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

/**
 * userDataPath: the host profile (absolute). refs(projectId, use): the board store's assetRefs, bound by the caller
 * (`(projectId, use) => boards.assetRefs({ projectId, use })`). clock(): milliseconds. logger(level, event, data).
 * assertSafePath(file): throws for a path reached through a link. fileOps and limits are test seams: fileOps replaces
 * readJson, listDir, readBytes or writeBytes; limits lowers { assetBytes, pictureBytes, pictures, pixels }.
 */
function createTeamBoardAssets({
  userDataPath, refs, clock = Date.now, logger = null, assertSafePath = assertSafeFile, fileOps = {}, limits = {},
} = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new TypeError('createTeamBoardAssets requires an absolute userDataPath.');
  }
  if (typeof refs !== 'function' || typeof clock !== 'function' || typeof assertSafePath !== 'function') {
    throw new TypeError('createTeamBoardAssets requires refs(), clock() and a path guard.');
  }
  const caps = resolveLimits(limits);
  const log = safeLogger(logger);
  const ops = {
    readJson: fileOps.readJson || durable.readJson,
    writeText: fileOps.writeText || durable.writeText,
    listDir: fileOps.listDir || ((dir) => fs.readdirSync(dir)),
    ...(fileOps.readBytes ? { readBytes: fileOps.readBytes } : {}),
    ...(fileOps.writeBytes ? { writeBytes: fileOps.writeBytes } : {}),
  };
  const files = createBoardFiles({ root: path.join(userDataPath, BOARDS_ROOT), guard: assertSafePath, ops, log });
  const queues = new Map();
  const roomTried = new Map(); // project id -> when room was last looked for
  const pictureName = (hash, ext) => `${hash}.${ext}`;

  function run(projectId, body) {
    const result = (queues.get(projectId) || Promise.resolve()).then(body);
    const settled = result.then(() => {}, () => {});
    queues.set(projectId, settled);
    settled.then(() => { if (queues.get(projectId) === settled) queues.delete(projectId); });
    return result;
  }

  async function call(body) {
    try {
      return await body();
    } catch (error) {
      log('WARN', 'team_board_asset.call_failed', { code: codeOf(error) });
      return UNAVAILABLE();
    }
  }

  function nowMs() {
    let value;
    try { value = clock(); } catch { value = Number.NaN; }
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  /* -------------------------------------------------------------- clocks */

  // { status: 'ok', since: Map<hash, ms>, rebuilt } | { status: 'newer' | 'unsafe' | 'transient' }. A missing file is
  // empty; a corrupt, oversized or foreign one is empty with rebuilt: true (the sweep writes a fresh one).
  function readClocks(projectId) {
    const read = files.read(files.assetPath(projectId, ids.ASSET_INDEX_FILE), CLOCKS_READ_BYTES);
    if (read.status === 'missing') return { status: 'ok', since: new Map(), rebuilt: false };
    if (read.status === 'link') return { status: 'unsafe' };
    if (read.status === 'transient') return { status: 'transient' };
    const value = read.status === 'ok' ? read.value : null;
    const version = isPlainObject(value) ? value.schema_version : undefined;
    if (Number.isSafeInteger(version) && version > CLOCKS_SCHEMA_VERSION) return { status: 'newer' };
    const since = new Map();
    if (version !== CLOCKS_SCHEMA_VERSION || !isPlainObject(value.since) || Object.keys(value).length !== 2) {
      return { status: 'ok', since, rebuilt: true };
    }
    let rebuilt = false;
    for (const [hash, at] of Object.entries(value.since)) {
      const ms = typeof at === 'string' && ISO_RE.test(at) ? Date.parse(at) : Number.NaN;
      if (since.size >= CLOCKS_MAX || !isHash(hash) || !Number.isFinite(ms)) rebuilt = true;
      else since.set(hash, ms);
    }
    return { status: 'ok', since, rebuilt };
  }

  function writeClocks(projectId, since) {
    const out = {};
    for (const [hash, ms] of [...since].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, CLOCKS_MAX)) out[hash] = new Date(ms).toISOString();
    try {
      files.writeAsset(projectId, ids.ASSET_INDEX_FILE, Buffer.from(JSON.stringify({ schema_version: CLOCKS_SCHEMA_VERSION, since: out }), 'utf8'));
      return true;
    } catch (error) {
      log('WARN', 'team_board_asset.clocks_write_failed', { project_id: projectId, code: codeOf(error) });
      return false;
    }
  }

  // A picture uploaded again is about to be named by a card: its clock goes. A damaged file is the sweep's to rebuild.
  function forgetClock(projectId, hash) {
    const clocks = readClocks(projectId);
    if (clocks.status !== 'ok' || clocks.rebuilt || !clocks.since.has(hash)) return;
    clocks.since.delete(hash);
    writeClocks(projectId, clocks.since);
  }

  /* -------------------------------------------------------------- pictures */

  // Removes every stored file of one picture without following a link; true when none is left.
  function removePicture(projectId, hash) {
    let all = true;
    for (const ext of ids.ASSET_EXTENSIONS) {
      const filePath = files.assetPath(projectId, pictureName(hash, ext));
      const entry = files.assetEntry(filePath);
      if (entry === 'missing') continue;
      if (entry !== 'plain' || !files.removeFile(filePath, projectId)) all = false;
    }
    return all;
  }

  // A full project: true when a picture was removed to make room for `need` more bytes and one more picture.
  async function makeRoom(projectId, need) {
    const now = nowMs();
    if (now === null || now - (roomTried.get(projectId) ?? -ROOM_RETRY_MS) < ROOM_RETRY_MS) return false;
    if (roomTried.size >= ROOM_TRIED_MAX) roomTried.clear();
    roomTried.set(projectId, now);
    const pictures = files.listAssets(projectId);
    const clocks = pictures === null ? null : readClocks(projectId);
    if (clocks?.status !== 'ok') return false;
    let removed = null;
    // Called by the board store in the same synchronous stretch as its scan, and only on a full view.
    const use = (referenced) => {
      if (removed !== null || !(referenced instanceof Set)) return;
      removed = 0;
      const held = new Map();
      for (const { hash, bytes } of pictures) held.set(hash, { bytes: (held.get(hash)?.bytes ?? 0) + bytes, files: (held.get(hash)?.files ?? 0) + 1 });
      let total = pictures.reduce((sum, picture) => sum + picture.bytes, 0);
      let count = pictures.length;
      const idle = [...clocks.since].filter(([hash, since]) => held.has(hash) && !referenced.has(hash) && now - since >= ROOM_AGE_MS)
        .sort(([a, first], [b, second]) => first - second || (a < b ? -1 : 1));
      for (const [hash] of idle) {
        if (count < caps.pictures && total + need <= caps.assetBytes) break;
        if (!removePicture(projectId, hash)) continue;
        total -= held.get(hash).bytes;
        count -= held.get(hash).files;
        clocks.since.delete(hash);
        removed += 1;
      }
      if (removed > 0) writeClocks(projectId, clocks.since);
    };
    try { await refs(projectId, use); } catch { /* no view: nothing was decided */ }
    if (removed > 0) log('INFO', 'team_board_asset.room_made', { project_id: projectId, removed });
    return removed > 0;
  }

  async function put(args) {
    const { projectId, hash, bytes } = args || {};
    if (!isTeamProjectId(projectId)) return NOT_FOUND();
    if (!isHash(hash)) return answers.INVALID();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return answers.INVALID();
    if (bytes.byteLength > caps.pictureBytes) return answers.SIZE();
    if (sha256(bytes) !== hash) return answers.MISMATCH();
    const info = imageInfo(bytes);
    if (!info.ok) return info.reason === 'dimensions' ? answers.DIMENSIONS() : answers.UNSUPPORTED();
    if (info.width * info.height > caps.pixels) return answers.DIMENSIONS();
    const done = (stored) => ({ ok: true, asset: hash, type: info.mime, width: info.width, height: info.height,
      bytes: bytes.byteLength, stored });
    // One synchronous stretch, from the folder check to the write: the answer, or FULL.
    const store = () => {
      const state = files.assetsState(projectId);
      if (state === 'no_project' || state === 'invalid') return NOT_FOUND();
      if (state === 'unsafe' && files.projectState(projectId) !== 'ok') return NOT_FOUND();
      if (state !== 'ok' && state !== 'missing') return UNAVAILABLE();
      if (state === 'ok') {
        for (const ext of ids.ASSET_EXTENSIONS) {
          const entry = files.assetEntry(files.assetPath(projectId, pictureName(hash, ext)));
          if (entry === 'missing') continue;
          if (entry !== 'plain') return UNAVAILABLE();
          // The stored file is checked against its name. One that was damaged on disk is never served (`read`), so
          // it is removed here and written again from this upload: sending a picture again repairs it.
          const kept = files.readAsset(files.assetPath(projectId, pictureName(hash, ext)), caps.pictureBytes);
          if (kept.status === 'transient') return UNAVAILABLE();
          if (kept.status === 'ok' && sha256(kept.bytes) === hash) {
            forgetClock(projectId, hash);
            return done(false);
          }
          if (!files.removeFile(files.assetPath(projectId, pictureName(hash, ext)), projectId)) return UNAVAILABLE();
          log('WARN', 'team_board_asset.repaired', { project_id: projectId });
        }
      }
      const pictures = files.listAssets(projectId);
      if (pictures === null) return UNAVAILABLE();
      const total = pictures.reduce((sum, picture) => sum + picture.bytes, 0) + bytes.byteLength;
      if (pictures.length >= caps.pictures || total > caps.assetBytes) return FULL;
      try {
        files.writeAsset(projectId, pictureName(hash, info.ext), bytes);
      } catch (error) {
        log('WARN', 'team_board_asset.write_failed', { project_id: projectId, code: codeOf(error) });
        return UNAVAILABLE();
      }
      log('INFO', 'team_board_asset.stored', { project_id: projectId });
      return done(true);
    };
    // Inside the project's queue. After room was made the whole stretch runs again, from the folder check.
    return run(projectId, () => call(async () => {
      const first = store();
      if (first !== FULL) return first;
      const second = (await makeRoom(projectId, bytes.byteLength)) ? store() : FULL;
      return second === FULL ? answers.STORAGE() : second;
    }));
  }

  async function read(args) {
    const { projectId, hash } = args || {};
    if (!isTeamProjectId(projectId) || !isHash(hash)) return ASSET_NOT_FOUND();
    return call(() => {
      const state = files.assetsState(projectId);
      if (state === 'transient') return UNAVAILABLE();
      if (state !== 'ok') return ASSET_NOT_FOUND();
      for (const ext of ids.ASSET_EXTENSIONS) {
        const got = files.readAsset(files.assetPath(projectId, pictureName(hash, ext)), caps.pictureBytes);
        if (got.status === 'missing') continue;
        if (got.status === 'transient') return UNAVAILABLE();
        if (got.status !== 'ok') return ASSET_NOT_FOUND();
        // Checked again by content and against its name: a file changed on disk is not served.
        const info = imageInfo(got.bytes);
        if (!info.ok || info.ext !== ext || sha256(got.bytes) !== hash) return ASSET_NOT_FOUND();
        return { ok: true, bytes: got.bytes, type: info.mime, width: info.width, height: info.height, ext };
      }
      return ASSET_NOT_FOUND();
    });
  }

  async function discard(args) {
    const { projectId, hash } = args || {};
    if (!isTeamProjectId(projectId) || !isHash(hash)) return ASSET_NOT_FOUND();
    return run(projectId, () => call(() => {
      const state = files.assetsState(projectId);
      if (state === 'missing' || state === 'no_project') return { ok: true, removed: false };
      if (state !== 'ok') return UNAVAILABLE();
      const present = ids.ASSET_EXTENSIONS.some((ext) => files.assetEntry(files.assetPath(projectId, pictureName(hash, ext))) !== 'missing');
      if (!present) return { ok: true, removed: false };
      if (!removePicture(projectId, hash)) return UNAVAILABLE();
      forgetClock(projectId, hash);
      return { ok: true, removed: true };
    }));
  }

  async function usage(args) {
    const projectId = args?.projectId;
    if (!isTeamProjectId(projectId)) return NOT_FOUND();
    return call(() => {
      const pictures = files.listAssets(projectId);
      if (pictures === null) return UNAVAILABLE();
      return { ok: true, bytes: pictures.reduce((sum, picture) => sum + picture.bytes, 0), count: pictures.length };
    });
  }

  /* -------------------------------------------------------------- sweep */

  // The decision for one project on a full view of its references, and the removals: synchronous.
  function decide(projectId, pictures, clocks, referenced, now) {
    const next = new Map();
    const fresh = [];
    let removed = 0;
    let kept = 0;
    for (const hash of [...new Set(pictures.map((picture) => picture.hash))].sort()) {
      const first = clocks.since.get(hash);
      if (referenced.has(hash)) kept += 1;
      else if (first === undefined || first > now) { fresh.push(hash); kept += 1; }
      else if (now - first > GRACE_MS && removePicture(projectId, hash)) removed += 1;
      else { next.set(hash, first); kept += 1; }
    }
    // Bounded: the clocks already running come first.
    for (const hash of fresh) if (next.size < CLOCKS_MAX) next.set(hash, now);
    const changed = clocks.rebuilt || next.size !== clocks.since.size
      || [...next].some(([hash, ms]) => clocks.since.get(hash) !== ms);
    if (changed) writeClocks(projectId, next);
    return { removed, kept };
  }

  function skip(projectId, reason, counts) {
    counts.skipped += 1;
    log('WARN', 'team_board_asset.sweep_skipped', { project_id: projectId, reason });
  }

  async function sweepProject(projectId, now, counts) {
    const pictures = files.listAssets(projectId);
    if (pictures === null) return skip(projectId, 'unsafe', counts);
    if (pictures.length === 0) return undefined;
    const clocks = readClocks(projectId);
    if (clocks.status !== 'ok') return skip(projectId, clocks.status, counts);
    let decided = null;
    // Called by the board store in the same synchronous stretch as its scan, and only on a full view.
    const use = (referenced) => {
      if (decided === null && referenced instanceof Set) decided = decide(projectId, pictures, clocks, referenced, now);
      return decided;
    };
    let answer;
    try { answer = await refs(projectId, use); } catch { answer = null; }
    if (decided !== null) {
      counts.removed += decided.removed;
      counts.kept += decided.kept;
    }
    if (answer === null || typeof answer !== 'object' || answer.ok !== true || decided === null) return skip(projectId, 'refs_unavailable', counts);
    return undefined;
  }

  function sweep() {
    return call(async () => {
      const now = nowMs();
      if (now === null) return UNAVAILABLE();
      const names = files.listProjects();
      if (names === null) return UNAVAILABLE();
      const counts = { removed: 0, kept: 0, skipped: 0 };
      for (const projectId of names) {
        await run(projectId, () => sweepProject(projectId, now, counts).catch(() => skip(projectId, 'failed', counts)));
      }
      if (counts.removed > 0 || counts.skipped > 0) log('INFO', 'team_board_asset.swept', { ...counts });
      return { ok: true, ...counts };
    });
  }

  return Object.freeze({ put, read, discard, usage, sweep });
}

module.exports = { GRACE_MS, ROOM_AGE_MS, ROOM_RETRY_MS, createTeamBoardAssets };
