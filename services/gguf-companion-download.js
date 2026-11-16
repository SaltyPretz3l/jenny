'use strict';

// Row 140: installs a GGUF chat model's companion files (the MTP drafter and the
// vision projector) beside the model, only when the user asks. Main owns every
// path: the renderer names a model by tag (and the path it shows), and this
// service re-resolves that against a fresh scan, so a path the scan did not list
// is never written to. The folder must be a real local directory whose resolved
// path equals its canonical path (no symlink or junction anywhere above it), it is
// re-checked before the partial file is opened and again before placement, and
// the finished file is linked (or renamed) into place without ever overwriting a
// name. A file is offered only when the launch rules would pick it beside the
// model. One download runs at a time. Logs carry reason codes only, never URLs or paths.

const fs = require('fs');
const path = require('path');

const { readGgufHeader } = require('./gguf-header');
const { pairProjector, resolveProjectorPath, splitGgufFiles } = require('./llama-server-gguf-files');
const { findFamily, pickDrafter } = require('./backend/llama-server-acceleration');
const { isLocalAbsolutePath, managedModelKey } = require('./shell-config-engines');
const {
  SAVE_AS, companionDownloadUrl, isSeparateMtpFamily, matchCompanionEntry,
} = require('./gguf-companion-catalog');
const { downloadPinnedHfFile, freeBytes, hashFile } = require('./hf-resumable-download');

const KINDS = Object.freeze(['drafter', 'projector']);
const PARTIAL_SUFFIX = '.jenny-partial';
const HEADROOM_BYTES = 64 * 1024 * 1024;
const HEADER_BUDGET_BYTES = 32 * 1024 * 1024;
const OFFER_MIN_GAIN_PCT = 10;
const MAX_MATCH_CACHE = 128;

function companionError(reason) {
  return Object.assign(new Error(reason), { reason });
}

function samePath(left, right, platform) {
  const a = path.resolve(String(left || ''));
  const b = path.resolve(String(right || ''));
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function familyFor(names, accelerationCatalog) {
  for (const name of names) {
    const family = findFamily(String(name || '').replace(/\.gguf$/i, ''), accelerationCatalog);
    if (family) return family;
  }
  return null;
}

function familyById(id, accelerationCatalog) {
  const families = Array.isArray(accelerationCatalog?.families) ? accelerationCatalog.families : [];
  return id ? families.find((entry) => entry?.family === id) || null : null;
}

function createGgufCompanionService({
  scanLocalGgufs,
  getCatalog,
  getAccelerationCatalog,
  isEnabled = () => true,
  isLocalOnly = () => false,
  download = downloadPinnedHfFile,
  readHeader = readGgufHeader,
  fsImpl = fs,
  statfsImpl = fs.promises.statfs,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  logger = null,
} = {}) {
  if (typeof scanLocalGgufs !== 'function' || typeof getCatalog !== 'function') {
    throw new TypeError('createGgufCompanionService requires scanLocalGgufs and getCatalog.');
  }
  let operation = null; // { key, kind, tag, entry, controller, receivedBytes, totalBytes, promise }
  const failures = new Map(); // `${key}\n${kind}` -> reason
  const matchCache = new Map();

  const log = (event, fields) => {
    try { logger?.info?.(`gguf_companion.${event}`, fields); } catch (_error) { /* logging never fails a download */ }
  };

  const entryKey = (entry) => `${managedModelKey(entry.tag)}\n${path.resolve(entry.dir, entry.mainGguf)}`;
  const failureKey = (key, kind) => `${key}\n${kind}`;

  // The scan entry for this tag; with a path, the entry whose main file IS that path.
  async function resolveEntry({ tag, modelPath } = {}) {
    const key = managedModelKey(String(tag || ''));
    if (!key) return null;
    const wanted = String(modelPath || '').trim();
    // While this model downloads, the 1 s status poll reuses the entry install
    // resolved instead of scanning every GGUF folder; the scan resumes once it ends.
    const held = operation?.entry;
    if (held && managedModelKey(held.tag) === key
      && (!wanted || samePath(path.join(held.dir, held.mainGguf), wanted, platform))) return held;
    const entries = await scanLocalGgufs();
    const forTag = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && managedModelKey(entry.tag) === key && entry.dir && entry.mainGguf);
    if (!wanted) return forTag[0] || null;
    return forTag.find((entry) => samePath(path.join(entry.dir, entry.mainGguf), wanted, platform)) || null;
  }

  // Header match, cached by (path, size, mtime) so a poll never re-reads a 10 MB header.
  function matchFor(entry, catalog) {
    const filePath = path.join(entry.dir, entry.mainGguf);
    let stamp = '';
    try {
      const info = fsImpl.lstatSync(filePath);
      stamp = `${info.size}:${info.mtimeMs}`;
    } catch (_error) { /* unreadable: match by file name only */ }
    const cacheKey = `${path.resolve(filePath)}\n${stamp}`;
    if (matchCache.has(cacheKey)) return matchCache.get(cacheKey);
    let header = null;
    if (stamp) {
      try {
        header = readHeader(filePath, { maxBytes: HEADER_BUDGET_BYTES, fsImpl });
      } catch (_error) { header = null; }
    }
    const match = matchCompanionEntry({ header, fileName: entry.mainGguf }, catalog) || null;
    matchCache.set(cacheKey, match);
    while (matchCache.size > MAX_MATCH_CACHE) matchCache.delete(matchCache.keys().next().value);
    return match;
  }

  // The folder a companion may be written into, or a thrown `folder_rejected`.
  function assertFolder(dir) {
    if (!isLocalAbsolutePath(dir, { platform })) throw companionError('folder_rejected');
    let info;
    let real;
    try {
      info = fsImpl.lstatSync(dir);
      real = (fsImpl.realpathSync.native || fsImpl.realpathSync)(dir);
    } catch (_error) {
      throw companionError('folder_rejected');
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(real, dir, platform)) {
      throw companionError('folder_rejected');
    }
    return path.resolve(dir);
  }

  function targetPaths(dir, saveAs) {
    if (!SAVE_AS.test(String(saveAs || ''))) throw companionError('folder_rejected');
    const finalPath = path.join(dir, saveAs);
    if (!samePath(path.dirname(finalPath), dir, platform) || path.basename(finalPath) !== saveAs) {
      throw companionError('folder_rejected');
    }
    return { finalPath, partialPath: `${finalPath}${PARTIAL_SUFFIX}` };
  }

  function fileSize(filePath) {
    try {
      const info = fsImpl.lstatSync(filePath);
      return info.isFile() ? info.size : -1;
    } catch (error) {
      return error?.code === 'ENOENT' ? 0 : -1;
    }
  }

  // Unknown free space does not block: the download's own check decides.
  async function spaceFor(dir, needed) {
    const free = await freeBytes(statfsImpl, dir);
    return { ok: free === null || !Number.isFinite(free) || free >= needed, freeBytes: free };
  }

  // Would the launch rules pick `saveAs` beside this model once it is there? A fine-tune
  // beside other models' drafters or projectors may not be: offering it would download
  // a file that is never used.
  function wouldUse(kind, dir, entry, saveAs) {
    let names;
    try {
      names = fsImpl.readdirSync(dir);
    } catch (_error) {
      return false;
    }
    const files = splitGgufFiles(names.includes(saveAs) ? names : [...names, saveAs]);
    if (kind === 'drafter') return pickDrafter(files.drafters, entry.mainGguf) === saveAs;
    return path.basename(pairProjector(dir, entry.mainGguf, files)) === saveAs;
  }

  const driveOf = (dir) => {
    const root = path.parse(path.resolve(dir)).root;
    return platform === 'win32' ? root.replace(/[\\/]+$/, '') : root;
  };

  // Everything about one kind for one entry: the row's state and the pinned file.
  async function describeKind(kind, entry, ctx) {
    const { match, family, key } = ctx;
    const file = match?.entry?.[kind] || null;
    const base = {
      state: 'unavailable', reason: '', fileName: '', bytes: file?.bytes || 0, vramMb: file?.vramMb || 0,
      gainOverBuiltInPct: null, vramOverBuiltInMb: null, fineTune: Boolean(match?.fineTune),
      baseName: String(match?.baseName || ''), neededBytes: 0, freeBytes: null, drive: '',
    };
    const embedded = Number.isInteger(entry.embeddedMtpLayers) && entry.embeddedMtpLayers > 0;
    if (kind === 'drafter') {
      // The row exists for a family that drafts with a separate file, named by the tag or file, or by
      // the catalog entry the header matched (a fine-tune with its own name).
      if (!isSeparateMtpFamily(family) && !isSeparateMtpFamily(familyById(match?.entry?.family, ctx.acceleration))) return null;
      if (entry.drafterGguf) return { ...base, state: 'installed', fileName: String(entry.drafterGguf) };
    } else {
      if (entry.mmproj) {
        const projector = resolveProjectorPath({ modelPath: path.join(entry.dir, entry.mainGguf), fsImpl });
        return { ...base, state: 'installed', fileName: projector ? path.basename(projector) : '' };
      }
      if (!file) return null; // a model with no known projector has no Vision row
    }
    if (operation && operation.key === key && operation.kind === kind) {
      return { ...base, state: 'downloading', fileName: file?.saveAs || '' };
    }
    // A built-in head: MTP already runs. Offer the drafter only when it was measured faster.
    const offerOverHead = kind === 'drafter' && embedded;
    const gain = Number(file?.gainOverBuiltInPct);
    const offerable = !offerOverHead || (Number.isFinite(gain) && gain >= OFFER_MIN_GAIN_PCT);
    const embeddedState = (offer) => ({
      ...base, state: 'embedded', reason: '',
      gainOverBuiltInPct: offer ? gain : null,
      vramOverBuiltInMb: offer && Number.isInteger(file?.vramOverBuiltInMb) ? file.vramOverBuiltInMb : null,
    });
    const blocked = (reason, extra = {}) => (offerOverHead ? embeddedState(false) : { ...base, reason, ...extra });
    if (!isEnabled()) return blocked('disabled');
    if (entry.source === 'ollama' || entry.ollamaBlob === true) return blocked('ollama_copy');
    if (!file) return blocked('not_in_catalog');
    if (!offerable) return embeddedState(false);
    if (isLocalOnly()) return blocked('local_only');
    let dir;
    let paths;
    try {
      dir = assertFolder(entry.dir);
      paths = targetPaths(dir, file.saveAs);
    } catch (error) {
      return blocked(error.reason || 'folder_rejected');
    }
    if (!wouldUse(kind, dir, entry, file.saveAs)) return blocked('not_paired');
    // Not reported installed, yet something holds the name: never replaced.
    if (fileSize(paths.finalPath) !== 0) return blocked('name_taken');
    const partial = fileSize(paths.partialPath);
    if (partial < 0) return blocked('folder_rejected');
    const neededBytes = Math.max(0, file.bytes - partial) + HEADROOM_BYTES;
    const space = await spaceFor(dir, neededBytes);
    if (!space.ok) {
      return blocked('insufficient_space', { neededBytes: neededBytes - HEADROOM_BYTES, freeBytes: space.freeBytes, drive: driveOf(dir) });
    }
    if (operation) return blocked('busy');
    const failure = failures.get(failureKey(key, kind));
    const offered = offerOverHead ? embeddedState(true) : { ...base, state: 'available' };
    return failure ? { ...offered, state: 'failed', reason: failure } : { ...offered, fileName: file.saveAs };
  }

  async function snapshot(payload) {
    const entry = await resolveEntry(payload);
    if (!entry) return { entry: null };
    const catalog = getCatalog() || { entries: [] };
    const acceleration = typeof getAccelerationCatalog === 'function' ? getAccelerationCatalog() : null;
    const match = matchFor(entry, catalog);
    const family = familyFor([entry.tag, entry.mainGguf], acceleration);
    const ctx = { match, family, acceleration, key: entryKey(entry) };
    const rows = {};
    for (const kind of KINDS) rows[kind] = await describeKind(kind, entry, ctx);
    return { entry, ctx, rows };
  }

  async function status(payload = {}) {
    const snap = await snapshot(payload);
    if (!snap.entry) return { ok: false, reason: 'unknown_model' };
    return {
      ok: true,
      drafter: snap.rows.drafter,
      projector: snap.rows.projector,
      download: operation ? {
        kind: operation.kind, tag: operation.tag,
        receivedBytes: operation.receivedBytes, totalBytes: operation.totalBytes,
      } : null,
    };
  }

  function removeQuietly(filePath) {
    try {
      const info = fsImpl.lstatSync(filePath);
      if (info.isFile()) fsImpl.unlinkSync(filePath);
    } catch (_error) { /* already gone */ }
  }

  // Link the verified partial to its final name; never overwrite. An identical
  // file already there counts as installed. A cancel that lands after the last
  // byte still wins: the checked partial stays for the next try.
  async function place(dir, file, paths, signal) {
    if (signal?.aborted) throw companionError('cancelled');
    assertFolder(dir);
    const existing = fileSize(paths.finalPath);
    if (existing < 0) throw companionError('name_taken');
    if (existing > 0) {
      const same = existing === file.bytes && await hashFile(fsImpl, paths.finalPath) === file.sha256;
      removeQuietly(paths.partialPath);
      if (!same) throw companionError('name_taken');
      return;
    }
    try {
      fsImpl.linkSync(paths.partialPath, paths.finalPath);
    } catch (error) {
      if (error?.code === 'EEXIST') throw companionError('name_taken');
      if (error?.code === 'ENOENT') throw companionError('download_failed');
      // A volume without hard links (FAT, some network shares): rename the partial,
      // which sits in the same folder, so the final name never holds a half-written
      // file. Only while the name is free; rename would replace a file.
      if (fileSize(paths.finalPath) !== 0) throw companionError('name_taken');
      fsImpl.renameSync(paths.partialPath, paths.finalPath);
      return;
    }
    removeQuietly(paths.partialPath);
  }

  async function run(op, dir, file, paths) {
    let reason = '';
    try {
      assertFolder(dir);
      const result = await download({
        url: companionDownloadUrl(file),
        partialPath: paths.partialPath,
        bytes: file.bytes,
        sha256: file.sha256,
        fetchImpl, fsImpl, statfsImpl,
        signal: op.controller.signal,
        beforeOpen: () => assertFolder(dir),
        onProgress: ({ receivedBytes, totalBytes }) => {
          op.receivedBytes = Number(receivedBytes) || 0;
          op.totalBytes = Number(totalBytes) || file.bytes;
        },
      });
      if (!result?.ok) throw companionError(String(result?.reason || 'download_failed'));
      await place(dir, file, paths, op.controller.signal);
    } catch (error) {
      reason = typeof error?.reason === 'string' ? error.reason : 'download_failed';
    }
    if (operation === op) operation = null;
    if (reason && reason !== 'cancelled') failures.set(failureKey(op.key, op.kind), reason);
    else failures.delete(failureKey(op.key, op.kind));
    log(reason ? 'download_failed' : 'installed', { kind: op.kind, reason: reason || 'ok' });
    return reason ? { ok: false, reason } : { ok: true };
  }

  async function install(payload = {}) {
    const kind = String(payload.kind || '');
    if (!KINDS.includes(kind)) return { ok: false, reason: 'invalid_kind' };
    if (operation) return { ok: false, reason: 'busy' };
    const snap = await snapshot(payload);
    if (!snap.entry) return { ok: false, reason: 'unknown_model' };
    const row = snap.rows[kind];
    const offered = row && (row.state === 'available' || row.state === 'failed'
      || (row.state === 'embedded' && row.gainOverBuiltInPct !== null));
    if (!offered) return { ok: false, reason: row?.reason || (row ? `not_offered_${row.state}` : 'not_applicable') };
    if (operation) return { ok: false, reason: 'busy' }; // a second install raced the scan
    const file = snap.ctx.match.entry[kind];
    let dir;
    let paths;
    try {
      dir = assertFolder(snap.entry.dir);
      paths = targetPaths(dir, file.saveAs);
    } catch (error) {
      return { ok: false, reason: error.reason || 'folder_rejected' };
    }
    const op = {
      key: snap.ctx.key, kind, tag: String(snap.entry.tag), entry: snap.entry, controller: new AbortController(),
      receivedBytes: Math.max(0, fileSize(paths.partialPath)), totalBytes: file.bytes, promise: null,
    };
    operation = op;
    failures.delete(failureKey(op.key, kind));
    log('started', { kind });
    op.promise = run(op, dir, file, paths);
    return { ok: true };
  }

  function cancel() {
    if (operation) operation.controller.abort();
    return { ok: true };
  }

  // Tests await the running download through this.
  const whenIdle = () => (operation?.promise || Promise.resolve(null));

  return { status, install, cancel, whenIdle };
}

module.exports = {
  createGgufCompanionService,
  PARTIAL_SUFFIX,
};
