'use strict';

// "Add GGUF model…" ▸ Move and add (row 107): moves a picked model, with the
// shards, projector and drafters that belong to it, into <root>/<family>/ so
// it stops living in Downloads. Main owns every path: the source must be a
// file main's own picker returned, and the destination a GGUF folder, Jenny's
// models folder or a folder main's picker returned. Nothing is overwritten.
// On one volume the files are linked into place and unlinked from the source;
// across volumes each is copied to "<name>.jenny-partial", fsynced and size-checked,
// and the originals are removed only after every copy is in place.

const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { readGgufArchitecture } = require('./gguf-header');
const { createArchSupport } = require('./main/llama-server-runtime-choice');
const { companionFiles, createPlaceFile, safeFolderName } = require('./gguf-place');
const { splitGgufFiles } = require('./llama-server-gguf-files');
const { isLocalAbsolutePath } = require('./shell-config-engines');

const MAX_PICKS = 16;
// Headroom a cross-volume copy leaves on the destination beyond its own bytes.
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
// Jenny's own in-flight names: a copy being written, and a file set aside
// while it is linked into place.
const PARTIAL_SUFFIX = '.jenny-partial';
const STAGED_SUFFIX = '.jenny-moving';

function pathKey(value, platform) {
  const resolved = path.resolve(String(value || ''));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinOrSame(child, parent, platform) {
  const relative = path.relative(pathKey(parent, platform), pathKey(child, platform));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The last paths main's own pickers returned; only these may be moved, or
// moved into.
function createPickSet(platform, max = MAX_PICKS) {
  const keys = [];
  return {
    add(value) {
      const key = pathKey(value, platform);
      const index = keys.indexOf(key);
      if (index >= 0) keys.splice(index, 1);
      keys.push(key);
      while (keys.length > max) keys.shift();
    },
    has(value) {
      return keys.includes(pathKey(value, platform));
    },
    delete(value) {
      const index = keys.indexOf(pathKey(value, platform));
      if (index >= 0) keys.splice(index, 1);
    },
  };
}

function createGgufImportService({
  fsImpl = fs,
  platform = process.platform,
  userDataPath = '',
  repoRoot = process.cwd(),
  getLibraryRoots = () => [],
  resolveBundledRuntime = () => '',
  // Row 142: the trusted build a launch would use when the bundled one answers
  // 'no' ({ build, label } or null); the caller prepares the chooser first.
  chooseRuntimeForArchitecture = () => null,
  // Row 142 S3: the build "Get a build" would download for an architecture no
  // trusted build reads ({ build, sizeBytes } or null).
  runtimeDownloadOffer = () => null,
  readArchitecture = readGgufArchitecture,
  log = () => {},
} = {}) {
  const modelPicks = createPickSet(platform);
  const folderPicks = createPickSet(platform);
  const archSupport = createArchSupport({ fsImpl, platform });
  let active = null;

  const homeModels = () => (userDataPath ? path.join(userDataPath, 'models') : '');
  const libraryRoots = () => {
    let roots = [];
    try {
      roots = getLibraryRoots() || [];
    } catch (_error) { /* settings unavailable: Jenny's models folder only */ }
    return (Array.isArray(roots) ? roots : [])
      .map((root) => String(root || '').trim())
      .filter((root) => isLocalAbsolutePath(root, { platform }));
  };
  const homeRoot = () => libraryRoots()[0] || homeModels();
  const scannedRoots = () => [homeModels(), path.join(repoRoot, '.jenny', 'models'), ...libraryRoots()]
    .filter(Boolean);
  const real = (value) => {
    try {
      return fsImpl.realpathSync(value);
    } catch (_error) {
      return path.resolve(value);
    }
  };
  // The nearest existing folder at or above a path, for volume and free-space
  // reads before Jenny's models folder exists.
  const existingAncestor = (value) => {
    let current = path.resolve(value);
    for (;;) {
      try {
        if (fsImpl.statSync(current).isDirectory()) return current;
      } catch (_error) { /* keep climbing */ }
      const parent = path.dirname(current);
      if (parent === current) return '';
      current = parent;
    }
  };
  const spaceFor = (sourceDir, destRoot) => {
    const anchor = destRoot ? existingAncestor(destRoot) : '';
    if (!anchor) return { crossVolume: true, freeBytes: null };
    let crossVolume = true;
    try {
      crossVolume = fsImpl.statSync(sourceDir).dev !== fsImpl.statSync(anchor).dev;
    } catch (_error) { /* unknown: treat as a copy */ }
    let freeBytes = null;
    try {
      const space = fsImpl.statfsSync(anchor);
      freeBytes = Number(space.bavail) * Number(space.bsize);
    } catch (_error) { /* no statfs: the copy itself reports ENOSPC */ }
    return { crossVolume, freeBytes };
  };
  const architectureOf = (filePath) => {
    try {
      return String(readArchitecture(filePath, { fsImpl }) || '');
    } catch (_error) {
      return '';
    }
  };

  function plan(filePath) {
    const source = String(filePath || '');
    if (!isLocalAbsolutePath(source, { platform })) return { ok: false, reason: 'network_path' };
    if (!modelPicks.has(source)) return { ok: false, reason: 'not_picked' };
    let stat;
    try {
      stat = fsImpl.lstatSync(source);
    } catch (_error) {
      return { ok: false, reason: 'missing' };
    }
    // lstat: a link to a model is never followed, so never moved.
    if (!stat.isFile()) return { ok: false, reason: 'not_a_file' };
    const sourceDir = real(path.dirname(source));
    const file = path.basename(source);
    // A projector or drafter is never added, so never moved on its own.
    if (splitGgufFiles([file]).main.length === 0) return { ok: false, reason: 'not_main_model' };
    const architecture = architectureOf(source);
    let bundled = '';
    try {
      bundled = String(resolveBundledRuntime() || '');
    } catch (_error) { /* no bundled build: unknown */ }
    const support = archSupport(bundled, architecture);
    let autoBuild = null;
    if (support === 'no') {
      try {
        const chosen = chooseRuntimeForArchitecture(architecture);
        if (chosen) autoBuild = { build: chosen.build, label: chosen.label };
      } catch (_error) { /* no automatic build */ }
    }
    let downloadBuild = null;
    if (support === 'no' && !autoBuild) {
      try {
        const offer = runtimeDownloadOffer(architecture);
        if (offer) downloadBuild = { build: offer.build, sizeBytes: offer.sizeBytes };
      } catch (_error) { /* no download offer */ }
    }
    const base = {
      ok: true, architecture, archSupport: support,
      ...(autoBuild ? { autoBuild } : {}), ...(downloadBuild ? { downloadBuild } : {}),
    };
    if (scannedRoots().some((root) => isWithinOrSame(sourceDir, real(root), platform))) {
      return { ...base, inside: true };
    }
    let names = [];
    try {
      names = fsImpl.readdirSync(sourceDir);
    } catch (_error) { /* the model alone */ }
    let sizeBytes = stat.size;
    const companions = companionFiles(sourceDir, file, names).filter((name) => {
      try {
        const companion = fsImpl.lstatSync(path.join(sourceDir, name));
        if (!companion.isFile()) return false;
        sizeBytes += companion.size;
        return true;
      } catch (_error) {
        return false;
      }
    });
    const destRoot = homeRoot();
    return {
      ...base,
      inside: false,
      file,
      companions,
      sizeBytes,
      sourceDirName: path.basename(sourceDir),
      destRoot,
      destDir: destRoot ? path.join(destRoot, safeFolderName(file)) : '',
      ...spaceFor(sourceDir, destRoot),
    };
  }

  const allowedDestRoot = (root) => {
    if (!isLocalAbsolutePath(root, { platform })) return false;
    const key = pathKey(root, platform);
    return [homeModels(), ...libraryRoots()].some((known) => known && pathKey(known, platform) === key)
      || folderPicks.has(root);
  };

  // Links into place without ever replacing a file (services/gguf-place.js).
  const placeFile = createPlaceFile({
    fs: fsImpl, platform, log, stagedSuffix: STAGED_SUFFIX, restoreFailedEvent: 'llama.server.gguf_import_restore_failed',
  });

  const moveOnVolume = (sourceDir, destDir, files) => {
    const placed = [];
    try {
      for (const name of files) {
        placeFile(path.join(sourceDir, name), path.join(destDir, name));
        placed.push(name);
      }
    } catch (error) {
      for (const name of placed.reverse()) {
        try {
          placeFile(path.join(destDir, name), path.join(sourceDir, name));
        } catch (rollbackError) {
          log('WARN', 'llama.server.gguf_import_rollback_failed', { code: rollbackError?.code || 'unknown' });
        }
      }
      throw error;
    }
  };

  // A stream torn down by Cancel closes its handle a tick later; Windows
  // refuses to delete a file that is still open.
  const closed = (stream) => new Promise((resolve) => {
    if (!stream || stream.closed) resolve();
    else stream.once('close', resolve);
  });

  const copyAcrossVolumes = async (sourceDir, destDir, files, state) => {
    const partials = [];
    const finals = [];
    let writer;
    try {
      for (const name of files) {
        const from = path.join(sourceDir, name);
        const partial = path.join(destDir, `${name}${PARTIAL_SUFFIX}`);
        // A leftover of an interrupted copy (Jenny's own suffix) is replaced.
        try {
          if (fsImpl.lstatSync(partial).isFile()) fsImpl.unlinkSync(partial);
        } catch (_error) { /* none */ }
        partials.push(partial);
        const counter = new Transform({
          transform(chunk, _encoding, done) {
            state.doneBytes += chunk.length;
            done(null, chunk);
          },
        });
        writer = fsImpl.createWriteStream(partial, { flags: 'wx' });
        await pipeline(fsImpl.createReadStream(from), counter, writer, { signal: state.controller.signal });
        // Flushing gigabytes to a slow drive must not block the main thread.
        const handle = await fsImpl.promises.open(partial, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (fsImpl.statSync(partial).size !== fsImpl.statSync(from).size) {
          throw Object.assign(new Error('size_mismatch'), { code: 'ESIZE' });
        }
      }
      if (state.controller.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      for (let index = 0; index < files.length; index += 1) {
        const final = path.join(destDir, files[index]);
        placeFile(partials[index], final);
        finals.push(final);
      }
    } catch (error) {
      await closed(writer);
      for (const target of finals.concat(partials)) {
        try {
          fsImpl.unlinkSync(target);
        } catch (_cleanupError) { /* gone or never written; the sources are untouched */ }
      }
      throw error;
    }
    // Every copy is in place and checked: only now do the originals go.
    for (const name of files) {
      try {
        fsImpl.unlinkSync(path.join(sourceDir, name));
      } catch (error) {
        log('WARN', 'llama.server.gguf_import_source_kept', { code: error?.code || 'unknown' });
      }
    }
  };

  const failureReason = (error) => {
    if (error?.name === 'AbortError') return 'cancelled';
    if (error?.code === 'ENOSPC') return 'no_space';
    if (error?.code === 'EEXIST') return 'exists';
    if (error?.code === 'EINUSE') return 'in_use';
    return 'io';
  };

  async function start(payload) {
    if (active) return { ok: false, reason: 'busy' };
    const planned = plan(payload?.path);
    if (!planned.ok) return planned;
    if (planned.inside) return { ok: false, reason: 'inside' };
    const destRoot = String(payload?.destRoot || planned.destRoot || '').trim();
    if (!destRoot || !allowedDestRoot(destRoot)) return { ok: false, reason: 'destination_not_allowed' };
    const sourceDir = real(path.dirname(String(payload.path)));
    const files = [planned.file, ...planned.companions];
    const { crossVolume, freeBytes } = spaceFor(sourceDir, destRoot);
    if (crossVolume && freeBytes !== null && freeBytes < planned.sizeBytes + SPACE_MARGIN_BYTES) {
      return { ok: false, reason: 'no_space', freeBytes, sizeBytes: planned.sizeBytes };
    }
    const state = { doneBytes: 0, totalBytes: planned.sizeBytes, controller: new AbortController() };
    active = state;
    let createdDir = '';
    try {
      // Only Jenny's own models folder is created; a GGUF folder must exist.
      if (pathKey(destRoot, platform) === pathKey(homeModels(), platform)) fsImpl.mkdirSync(destRoot, { recursive: true });
      const realRoot = real(destRoot);
      if (!fsImpl.statSync(realRoot).isDirectory()) return { ok: false, reason: 'destination_missing' };
      const destDir = path.join(realRoot, safeFolderName(planned.file));
      if (path.dirname(destDir) !== realRoot) return { ok: false, reason: 'destination_not_allowed' };
      try {
        const existing = fsImpl.lstatSync(destDir);
        if (!existing.isDirectory() || existing.isSymbolicLink()) return { ok: false, reason: 'exists' };
      } catch (_error) {
        fsImpl.mkdirSync(destDir);
        createdDir = destDir;
      }
      if (files.some((name) => fsImpl.existsSync(path.join(destDir, name)))) return { ok: false, reason: 'exists' };
      if (crossVolume) {
        await copyAcrossVolumes(sourceDir, destDir, files, state);
      } else {
        try {
          moveOnVolume(sourceDir, destDir, files);
        } catch (error) {
          if (error?.code !== 'EXDEV') throw error;
          await copyAcrossVolumes(sourceDir, destDir, files, state);
        }
      }
      createdDir = '';
      log('INFO', 'llama.server.gguf_import_done', { files: files.length, crossVolume, bytes: planned.sizeBytes });
      // A pick moves once; the file's old path no longer exists.
      modelPicks.delete(payload.path);
      return { ok: true, modelPath: path.join(destDir, planned.file), dir: destDir, moved: files };
    } catch (error) {
      return { ok: false, reason: failureReason(error) };
    } finally {
      if (createdDir) {
        try {
          fsImpl.rmdirSync(createdDir);
        } catch (_error) { /* not empty or gone: leave it */ }
      }
      active = null;
    }
  }

  return {
    recordModelPick: (value) => modelPicks.add(value),
    recordFolderPick: (value) => folderPicks.add(value),
    plan,
    start,
    status: () => (active
      ? { ok: true, active: true, doneBytes: active.doneBytes, totalBytes: active.totalBytes }
      : { ok: true, active: false }),
    cancel: () => {
      const running = Boolean(active);
      if (running) active.controller.abort();
      return { ok: true, cancelled: running };
    },
  };
}

module.exports = {
  companionFiles,
  createArchSupport,
  createGgufImportService,
  safeFolderName,
};
