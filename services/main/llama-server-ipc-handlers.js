'use strict';

// `llamaServer.*` IPC namespace: renderer control of the single managed
// llama-server (status / start / stop / restart) plus local GGUF discovery and
// a native .gguf picker. The manager itself stays main-process-owned and is
// reached only through the injected getter, so the handlers register even when
// no manager exists and every failure comes back as `{ ok:false, reason }`
// rather than a rejection across the preload bridge.

const fs = require('fs');
const path = require('path');

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { splitGgufFiles } = require('../llama-server-lifecycle');
const { isManagedModelPath, managedModelKey } = require('../shell-config-engines');
const { normalizeSpec } = require('./llama-server-manager');

const MAX_LOCAL_GGUF_ENTRIES = 256;
const MAX_OLLAMA_SOURCE_TAGS = 64;
const OLLAMA_SOURCE_TTL_MS = 30_000;
// Each blob lookup is one blocking `/api/show` on the sidecar's dispatch loop:
// a hung daemon must cost one bounded batch per refresh, not one per model.
const OLLAMA_SOURCE_BATCH = 4;
const OLLAMA_SOURCE_BUDGET_MS = 5_000;
const OLLAMA_BLOB_BASENAME = /^sha256-[0-9a-f]{64}$/i;

function registerLlamaServerIpcHandlers(ipcMainLike, {
  getManager,
  userDataPath = '',
  repoRoot = process.cwd(),
  getMainWindow = () => null,
  dialogImpl,
  fsImpl = fs,
  log,
  // Persisted per-model entries ({ tag, modelPath }) whose directories join the
  // scan, so a GGUF chosen outside Jenny's model roots keeps its drafter verdict.
  getPersistedModels = () => [],
  getLibraryRoots = () => [],
  getOllamaTags = async () => [],
  getOllamaBlob = async () => null,
  nowMs = Date.now,
} = {}) {
  if (typeof getManager !== 'function') {
    return [];
  }
  const logEvent = typeof log === 'function' ? log : () => {};
  const reasonFor = (error) => String((error && error.message) || error);
  // One log line per call; never the key, never a status blob.
  const finish = (action, result) => {
    const details = {
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(typeof result.picked === 'boolean' ? { picked: result.picked } : {}),
    };
    logEvent(result.ok ? 'INFO' : 'WARN', `llama.server.ipc_${action}`, details);
    return result;
  };

  const manage = (action, call) => async (_event, payload) => {
    let manager = null;
    try {
      manager = getManager();
      if (!manager) {
        return finish(action, { ok: false, reason: 'manager_unavailable', state: 'stopped' });
      }
      return finish(action, { ok: true, ...await call(manager, payload) });
    } catch (error) {
      let status = { state: 'stopped' };
      try {
        status = manager?.getStatus?.() || status;
      } catch (_statusError) { /* fail soft */ }
      return finish(action, { ok: false, reason: reasonFor(error), ...status });
    }
  };

  // The manager resolves a failed launch as a status, never a rejection.
  const launched = (status) => ({
    ...status,
    ok: status.state === 'ready',
    ...(status.state !== 'ready' && status.lastError ? { reason: status.lastError } : {}),
  });

  const readDir = (dir) => {
    try {
      return fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return [];
      }
      throw error;
    }
  };
  // The launcher's own classification (resolveGgufPath), so the picker never
  // advertises a file the launch would not choose.
  const readGgufs = (dir) => splitGgufFiles(
    readDir(dir).filter((entry) => entry.isFile()).map((entry) => entry.name)
  );
  const fileSize = (filePath) => {
    try {
      const info = fsImpl.lstatSync(filePath);
      return info.isFile() ? info.size : null;
    } catch (_error) {
      return null;
    }
  };
  const describeGgufDir = (tag, dir, source, mainGguf = '') => {
    const files = readGgufs(dir);
    const resolvedMain = mainGguf || files.main[0] || '';
    return {
      tag,
      dir,
      mainGguf: resolvedMain,
      drafterGguf: files.drafters[0] || '',
      mmproj: files.projectors.length > 0,
      sizeBytes: resolvedMain ? fileSize(path.join(dir, resolvedMain)) ?? 0 : 0,
      source,
    };
  };
  let ollamaSourceCache = { key: null, expiresAt: 0, results: [] };
  const queryOllamaSources = async (tags) => {
    const key = [...tags].sort().join('\n');
    const startedMs = nowMs();
    if (ollamaSourceCache.key === key && startedMs < ollamaSourceCache.expiresAt) {
      return ollamaSourceCache.results;
    }
    // Tags left unqueried when the budget runs out are picked up once the
    // cache expires.
    const results = [];
    for (let index = 0; index < tags.length; index += OLLAMA_SOURCE_BATCH) {
      if (nowMs() - startedMs > OLLAMA_SOURCE_BUDGET_MS) break;
      results.push(...await Promise.all(tags.slice(index, index + OLLAMA_SOURCE_BATCH).map(async (tag) => {
        try {
          return { tag, blob: await getOllamaBlob(tag) };
        } catch (_error) {
          return { tag, blob: null };
        }
      })));
    }
    ollamaSourceCache = { key, expiresAt: nowMs() + OLLAMA_SOURCE_TTL_MS, results };
    return results;
  };

  // `{userData}/models/<tag>/` and `{repoRoot}/.jenny/models/<tag>/` — one
  // directory per tag, never deeper, symlinks skipped (Dirent.isDirectory()
  // is false for them and lstat never follows).
  const listLocalGgufs = async () => {
    const builtInRoots = [
      userDataPath && path.join(userDataPath, 'models'),
      path.join(repoRoot, '.jenny', 'models'),
    ].filter(Boolean);
    const entries = [];
    const entryKeys = new Set();
    // Dedupe is per (directory, key): one directory may legitimately list
    // under two tags (Ollama's blob store holds every model's copy).
    const seen = new Set();
    const seenKey = (dir, key) => `${dir.toLowerCase()}\n${key}`;
    const scanRoot = (root) => {
      for (const tagEntry of readDir(root).filter((entry) => entry.isDirectory())) {
        const dir = path.join(root, tagEntry.name);
        const key = managedModelKey(tagEntry.name);
        entries.push(describeGgufDir(tagEntry.name, dir, 'root'));
        entryKeys.add(key);
        seen.add(seenKey(dir, key));
      }
    };
    for (const root of builtInRoots) scanRoot(root);

    let libraryRoots = [];
    try {
      libraryRoots = getLibraryRoots() || [];
    } catch (_error) { /* settings unavailable: built-in roots only */ }
    // A library root that repeats a built-in root (or itself) would list
    // every model twice and double-charge the entry cap.
    const scannedRoots = new Set(builtInRoots.map((root) => path.resolve(root).toLowerCase()));
    libraryRoots = (Array.isArray(libraryRoots) ? libraryRoots : [])
      .map((root) => String(root || '').trim())
      .filter((root) => root && path.isAbsolute(root))
      .filter((root) => {
        const resolved = path.resolve(root).toLowerCase();
        if (scannedRoots.has(resolved)) return false;
        scannedRoots.add(resolved);
        return true;
      });
    const sizeIndex = new Map();
    const indexedDirs = new Set();
    const indexLibraryDir = (dir) => {
      // One readdir per directory per scan: roots, tag folders and persisted
      // model folders overlap, and the first entry for a size already wins.
      if (indexedDirs.has(dir)) return;
      indexedDirs.add(dir);
      for (const mainGguf of readGgufs(dir).main) {
        const sizeBytes = fileSize(path.join(dir, mainGguf));
        // A partial download (0 bytes) must never size-match anything.
        if (!sizeBytes) continue;
        if (!sizeIndex.has(sizeBytes)) sizeIndex.set(sizeBytes, { dir, mainGguf });
      }
    };
    for (const root of libraryRoots) {
      const tagDirs = readDir(root).filter((entry) => entry.isDirectory());
      scanRoot(root);
      indexLibraryDir(root);
      for (const tagEntry of tagDirs) indexLibraryDir(path.join(root, tagEntry.name));
    }
    for (const root of builtInRoots) {
      indexLibraryDir(root);
      for (const tagEntry of readDir(root).filter((entry) => entry.isDirectory())) {
        indexLibraryDir(path.join(root, tagEntry.name));
      }
    }

    let persisted = [];
    try {
      persisted = getPersistedModels() || [];
    } catch (_error) { /* settings unavailable: roots-only scan */ }
    for (const item of Array.isArray(persisted) ? persisted : []) {
      const tag = String(item?.tag || '').trim();
      const modelPath = String(item?.modelPath || '').trim();
      if (!tag || !isManagedModelPath(modelPath)) continue;
      const dir = path.dirname(modelPath);
      const isBlobPath = OLLAMA_BLOB_BASENAME.test(path.basename(modelPath));
      // Ollama's blob store holds thousands of extensionless files and no .gguf,
      // so indexing it is a full readdir that can never contribute a size match.
      if (!isBlobPath) indexLibraryDir(dir);
      const key = managedModelKey(tag);
      if (seen.has(seenKey(dir, key))) continue;
      seen.add(seenKey(dir, key));
      // Always listed even when a root already carries the tag: the drawer
      // matches a persisted path by PATH, so its own directory decides the
      // drafter verdict. Only the Ollama source below defers to earlier keys.
      const entry = describeGgufDir(tag, dir, 'persisted', path.basename(modelPath));
      if (isBlobPath) entry.ollamaBlob = true;
      entries.push(entry);
      entryKeys.add(key);
    }

    let ollamaTags = [];
    try {
      ollamaTags = await getOllamaTags() || [];
    } catch (_error) { /* Ollama unavailable: local paths only */ }
    const pendingKeys = new Set();
    const tags = (Array.isArray(ollamaTags) ? ollamaTags : [])
      .map((tag) => String(tag || '').trim())
      .filter((tag) => {
        const key = tag && managedModelKey(tag);
        if (!key || entryKeys.has(key) || pendingKeys.has(key)) return false;
        pendingKeys.add(key);
        return true;
      })
      .slice(0, MAX_OLLAMA_SOURCE_TAGS);
    for (const { tag, blob } of await queryOllamaSources(tags)) {
      const blobPath = String(blob?.blobPath || '').trim();
      const key = managedModelKey(tag);
      if (!blobPath || entryKeys.has(key)) continue;
      const sizeBytes = fileSize(blobPath) ?? 0;
      const match = sizeBytes ? sizeIndex.get(sizeBytes) : null;
      // A size match re-homes the tag onto the library directory (so its
      // mtp-*.gguf drafter is found) even though that directory is already
      // listed under its own folder name: the tag is what the drawer matches.
      const entry = match
        ? describeGgufDir(tag, match.dir, 'library', match.mainGguf)
        : {
            tag,
            dir: path.dirname(blobPath),
            mainGguf: path.basename(blobPath),
            drafterGguf: '',
            mmproj: Boolean(blob?.mmprojPath),
            sizeBytes,
            source: 'ollama',
          };
      entry.sizeBytes = sizeBytes;
      entries.push(entry);
      entryKeys.add(key);
    }
    return entries
      .sort((left, right) => left.tag.localeCompare(right.tag))
      .slice(0, MAX_LOCAL_GGUF_ENTRIES);
  };

  return registerIpcInvokeHandlers(ipcMainLike, {
    'llamaServer.getStatus': manage('get_status', (manager) => manager.getStatus()),
    'llamaServer.start': manage('start', async (manager, payload) => launched(
      await manager.start(normalizeSpec(payload))
    )),
    'llamaServer.stop': manage('stop', (manager) => manager.stop()),
    'llamaServer.restart': manage('restart', async (manager, payload) => launched(
      await manager.restart(normalizeSpec(payload))
    )),
    'llamaServer.listLocalGgufs': async () => {
      try {
        return finish('list_local_ggufs', { ok: true, entries: await listLocalGgufs() });
      } catch (error) {
        return finish('list_local_ggufs', { ok: false, reason: reasonFor(error) });
      }
    },
    'llamaServer.chooseGguf': async (_event, payload) => {
      try {
        const defaultPath = String(payload?.defaultPath || '').trim();
        let validDefaultPath = false;
        if (defaultPath && path.isAbsolute(defaultPath) && !/[\r\n\0]/.test(defaultPath)) {
          try {
            validDefaultPath = fsImpl.statSync(defaultPath).isDirectory();
          } catch (_error) { /* invalid default path is omitted */ }
        }
        const picked = await dialogImpl.showOpenDialog(getMainWindow(), {
          title: 'Select a GGUF model',
          ...(validDefaultPath ? { defaultPath } : {}),
          properties: ['openFile'],
          filters: [{ name: 'GGUF models', extensions: ['gguf'] }],
        });
        if (picked.canceled) {
          return finish('choose_gguf', { ok: true, picked: false, path: '' });
        }
        const selected = String(picked.filePaths?.[0] || '');
        if (!/\.gguf$/i.test(selected)) {
          return finish('choose_gguf', { ok: false, reason: 'not_gguf' });
        }
        const dir = path.dirname(selected);
        return finish('choose_gguf', {
          ok: true,
          picked: true,
          path: selected,
          dir,
          drafterGguf: readGgufs(dir).drafters[0] || '',
        });
      } catch (error) {
        return finish('choose_gguf', { ok: false, reason: reasonFor(error) });
      }
    },
    'llamaServer.chooseLibraryFolder': async () => {
      try {
        const picked = await dialogImpl.showOpenDialog(getMainWindow(), {
          title: 'Select a GGUF folder',
          properties: ['openDirectory'],
        });
        if (picked.canceled) {
          return finish('choose_library_folder', { ok: true, picked: false, path: '' });
        }
        return finish('choose_library_folder', {
          ok: true,
          picked: true,
          path: String(picked.filePaths?.[0] || ''),
        });
      } catch (error) {
        return finish('choose_library_folder', { ok: false, reason: reasonFor(error) });
      }
    },
  });
}

module.exports = {
  registerLlamaServerIpcHandlers,
};
