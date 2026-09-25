'use strict';

// `llamaServer.*` IPC namespace: renderer control of the single managed
// llama-server (status / start / stop / restart) plus local GGUF discovery, a
// native .gguf picker and the llama-server build picker. The manager itself stays main-process-owned and is
// reached only through the injected getter, so the handlers register even when
// no manager exists and every failure comes back as `{ ok:false, reason }`
// rather than a rejection across the preload bridge.

const fs = require('fs');
const path = require('path');

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { t } = require('../i18n-main');
const { pairProjector, splitGgufFiles } = require('../llama-server-gguf-files');
const { isLocalAbsolutePath, isManagedModelPath, managedModelKey } = require('../shell-config-engines');
const { normalizeSpec } = require('./llama-server-manager');
const { validateRuntimeExecutable } = require('./llama-server-runtime');

const MAX_LOCAL_GGUF_ENTRIES = 256;
const MAX_OLLAMA_SOURCE_TAGS = 64;
const OLLAMA_SOURCE_TTL_MS = 30_000;
// Each blob lookup is one blocking `/api/show` on the sidecar's dispatch loop:
// a hung daemon must cost one bounded batch per refresh, not one per model.
const OLLAMA_SOURCE_BATCH = 4;
const OLLAMA_SOURCE_BUDGET_MS = 5_000;
const OLLAMA_BLOB_BASENAME = /^sha256-[0-9a-f]{64}$/i;
// One part of a split model: its set's name, then the part count.
const SHARD_PART = /^(.+)-\d{5}-of-(\d{5})\.gguf$/i;

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
  // {authorize, unauthorizedResult} for llamaServer.chooseRuntime, the one
  // handler that hands main an executable path. Missing trusts no sender.
  authorization = null,
  platform = process.platform,
  validateRuntimeExecutableImpl = validateRuntimeExecutable,
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

  // A dialog's defaultPath: an existing local directory, or nothing. Never a
  // network or device path: stat on one would reach the host it names, with
  // the user's credentials, before any dialog opens.
  const existingDirectory = (value) => {
    const candidate = String(value || '').trim();
    if (!isLocalAbsolutePath(candidate, { platform })) {
      return '';
    }
    try {
      return fsImpl.statSync(candidate).isDirectory() ? candidate : '';
    } catch (_error) {
      return '';
    }
  };

  // A pick the user browsed to on another machine. The dialog reached it at
  // the user's hand, but main never reads a network path and settings would
  // not keep it, so it is refused before any fs call, with a reason the
  // renderer can explain (map the share to a drive letter).
  const refuseNetworkPick = (action, selected) => (selected && !isLocalAbsolutePath(selected, { platform })
    ? finish(action, { ok: false, reason: 'network_path' })
    : null);

  // A build is an executable main will spawn, so its path enters only here:
  // a main-owned dialog, the name check and the probe, then the manager's pick
  // registry. engines.updateSettings saves no runtime path it did not record.
  const chooseRuntime = async (_event, payload) => {
    try {
      const picks = getManager()?.runtimePicks;
      if (!picks || typeof picks.record !== 'function') {
        return finish('choose_runtime', { ok: false, reason: 'manager_unavailable' });
      }
      const defaultPath = existingDirectory(payload?.defaultPath);
      const picked = await dialogImpl.showOpenDialog(getMainWindow(), {
        title: t('main.dialog.llamaServer.selectRuntime', 'Select a llama-server build'),
        ...(defaultPath ? { defaultPath } : {}),
        properties: ['openFile'],
        ...(platform === 'win32' ? { filters: [{ name: 'llama-server', extensions: ['exe'] }] } : {}),
      });
      if (picked.canceled) {
        return finish('choose_runtime', { ok: true, picked: false, path: '' });
      }
      const selected = String(picked.filePaths?.[0] || '');
      const refused = refuseNetworkPick('choose_runtime', selected);
      if (refused) return refused;
      const verdict = await validateRuntimeExecutableImpl(selected, { fsImpl, platform });
      if (!verdict.ok) {
        return finish('choose_runtime', { ok: false, reason: verdict.reason });
      }
      picks.record(selected, { build: verdict.build, supportsMtp: verdict.supportsMtp });
      return finish('choose_runtime', {
        ok: true,
        picked: true,
        path: selected,
        build: verdict.build,
        supportsMtp: verdict.supportsMtp,
      });
    } catch (_error) {
      // A dialog or probe error message can carry the path; report a code.
      return finish('choose_runtime', { ok: false, reason: 'runtime_pick_failed' });
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
  // A split model ("<name>-00001-of-00003.gguf") is as big as its whole set.
  const modelBytes = (dir, main, mains) => {
    const shard = SHARD_PART.exec(main);
    const parts = shard ? mains.filter((name) => {
      const other = SHARD_PART.exec(name);
      return Boolean(other) && other[1].toLowerCase() === shard[1].toLowerCase() && other[2] === shard[2];
    }) : [];
    return (parts.length > 0 ? parts : [main])
      .reduce((total, name) => total + (fileSize(path.join(dir, name)) ?? 0), 0);
  };
  const describeGgufDir = (tag, dir, source, mainGguf = '') => {
    const files = readGgufs(dir);
    const resolvedMain = mainGguf || files.main[0] || '';
    return {
      tag,
      dir,
      mainGguf: resolvedMain,
      drafterGguf: files.drafters[0] || '',
      // Per model, exactly as the launch pairs it, never "the folder has one".
      mmproj: Boolean(resolvedMain && pairProjector(dir, resolvedMain, files)),
      sizeBytes: resolvedMain ? modelBytes(dir, resolvedMain, files.main) : 0,
      source,
    };
  };
  let ollamaSourceCache = { key: null, expiresAt: 0, results: [] };
  // Overlapping scans (model library + tuning drawer) share one query: two
  // concurrent batches of OLLAMA_SOURCE_BATCH overran the sidecar's blob
  // worker cap, which refused the second scan's lookups outright.
  let ollamaSourceInflight = null;
  const runOllamaSourceQuery = async (key, tags, startedMs) => {
    // Tags left unqueried when the budget runs out are picked up once the
    // cache expires.
    const results = [];
    let transient = false;
    for (let index = 0; index < tags.length; index += OLLAMA_SOURCE_BATCH) {
      if (nowMs() - startedMs > OLLAMA_SOURCE_BUDGET_MS) break;
      results.push(...await Promise.all(tags.slice(index, index + OLLAMA_SOURCE_BATCH).map(async (tag) => {
        try {
          return { tag, blob: await getOllamaBlob(tag) };
        } catch (_error) {
          transient = true;
          return { tag, blob: null };
        }
      })));
    }
    // A refused lookup says nothing about the model; retry it next scan.
    if (!transient) ollamaSourceCache = { key, expiresAt: nowMs() + OLLAMA_SOURCE_TTL_MS, results };
    return results;
  };
  const queryOllamaSources = async (tags) => {
    const key = [...tags].sort().join('\n');
    const startedMs = nowMs();
    if (ollamaSourceCache.key === key && startedMs < ollamaSourceCache.expiresAt) {
      return ollamaSourceCache.results;
    }
    if (ollamaSourceInflight?.key === key) return ollamaSourceInflight.promise;
    const inflight = { key, promise: runOllamaSourceQuery(key, tags, startedMs) };
    ollamaSourceInflight = inflight;
    try {
      return await inflight.promise;
    } finally {
      if (ollamaSourceInflight === inflight) ollamaSourceInflight = null;
    }
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
      .filter((root) => isLocalAbsolutePath(root, { platform }))
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
      if (!tag || !isManagedModelPath(modelPath, { platform })) continue;
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
      // Ollama names the path, but a network one is still never read here, and
      // Tune could not save it.
      if (!isLocalAbsolutePath(blobPath, { platform }) || entryKeys.has(key)) continue;
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

  const channels = registerIpcInvokeHandlers(ipcMainLike, {
    'llamaServer.getStatus': manage('get_status', (manager) => manager.getStatus()),
    'llamaServer.start': manage('start', async (manager, payload) => launched(
      await manager.start(normalizeSpec(payload, { platform }))
    )),
    'llamaServer.stop': manage('stop', (manager) => manager.stop()),
    'llamaServer.restart': manage('restart', async (manager, payload) => launched(
      await manager.restart(normalizeSpec(payload, { platform }))
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
        const defaultPath = existingDirectory(payload?.defaultPath);
        const picked = await dialogImpl.showOpenDialog(getMainWindow(), {
          title: t('main.dialog.llamaServer.selectModel', 'Select a GGUF model'),
          ...(defaultPath ? { defaultPath } : {}),
          properties: ['openFile'],
          filters: [{ name: t('main.dialog.llamaServer.ggufModels', 'GGUF models'), extensions: ['gguf'] }],
        });
        if (picked.canceled) {
          return finish('choose_gguf', { ok: true, picked: false, path: '' });
        }
        const selected = String(picked.filePaths?.[0] || '');
        const refused = refuseNetworkPick('choose_gguf', selected);
        if (refused) return refused;
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
          title: t('main.dialog.llamaServer.selectFolder', 'Select a GGUF folder'),
          properties: ['openDirectory'],
        });
        if (picked.canceled) {
          return finish('choose_library_folder', { ok: true, picked: false, path: '' });
        }
        const selected = String(picked.filePaths?.[0] || '');
        return refuseNetworkPick('choose_library_folder', selected) || finish('choose_library_folder', {
          ok: true,
          picked: true,
          path: selected,
        });
      } catch (error) {
        return finish('choose_library_folder', { ok: false, reason: reasonFor(error) });
      }
    },
  });
  return channels.concat(registerIpcInvokeHandlers(ipcMainLike, {
    'llamaServer.chooseRuntime': chooseRuntime,
  }, typeof authorization?.authorize === 'function' ? authorization : { authorize: () => false }));
}

module.exports = {
  registerLlamaServerIpcHandlers,
};
