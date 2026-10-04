'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isLocalAbsolutePath } = require('./shell-config-engines');
const { readGgufArchitecture } = require('./gguf-header');

const SLOTS = Object.freeze(['diffusion', 'text_encoder', 'vae']);
const FOLDER_SLOTS = { diffusion_models: 'diffusion', unet: 'diffusion', text_encoders: 'text_encoder', clip: 'text_encoder', llm: 'text_encoder', vae: 'vae' };
const DEFAULT_LIMITS = { maxDepth: 3, maxEntries: 2000, maxPerSlot: 64 };
const failure = (reason) => ({ ok: false, reason });
const pathFor = (platform) => platform === 'win32' ? path.win32 : path.posix;

function loadFamilies({ familiesPath = path.join(__dirname, '..', 'config', 'sdcpp-families.json'), fsImpl = fs } = {}) {
  const { version, families } = JSON.parse(fsImpl.readFileSync(familiesPath, 'utf8'));
  return { version, families };
}

function familyForArchitecture(architecture, families) {
  if (typeof architecture !== 'string') return null;
  for (const [id, family] of Object.entries(families)) {
    if (family.architectures.includes(architecture)) return id;
  }
  return null;
}

function validateRoot(root, platform, fsImpl) {
  if (!isLocalAbsolutePath(root, { platform })) return failure('root_not_local_path');
  // A local-looking directory link (or an ancestor) can resolve to a share;
  // the resolved path must be local before anything under it is listed.
  let real;
  try { real = fsImpl.realpathSync(root); }
  catch (_error) { return failure('root_not_directory'); }
  if (!isLocalAbsolutePath(real, { platform })) return failure('root_not_local_path');
  try {
    if (fsImpl.statSync(root).isDirectory()) return { ok: true };
  } catch (_error) { /* Missing and unreadable roots cannot be scanned. */ }
  return failure('root_not_directory');
}

function scanModelFolder(rootPath, {
  platform = process.platform, fsImpl = fs, readArchitecture = readGgufArchitecture, limits = DEFAULT_LIMITS,
} = {}) {
  const valid = validateRoot(rootPath, platform, fsImpl);
  if (!valid.ok) return valid;
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  if (!Object.values(bounds).every((limit) => Number.isSafeInteger(limit) && limit >= 0)) return failure('invalid_limits');
  const families = loadFamilies().families;
  const pathApi = pathFor(platform);
  const rootFolders = pathApi.relative(pathApi.parse(rootPath).root, rootPath).split(pathApi.sep);
  const candidates = { diffusion: [], text_encoder: [], vae: [] };
  let entries = 0;
  let truncated = false;

  function addFile(relative, absolute, folders) {
    const extension = pathApi.extname(absolute).toLowerCase();
    if (extension !== '.gguf' && extension !== '.safetensors') return;
    let architecture = null;
    if (extension === '.gguf') {
      try { architecture = readArchitecture(absolute, { fsImpl }); }
      catch (_error) { /* Bad headers remain classifiable by their folder. */ }
    }
    const family = familyForArchitecture(architecture, families);
    const folder = [...rootFolders, ...folders].reverse().find((segment) => Object.hasOwn(FOLDER_SLOTS, segment.toLowerCase()));
    let slot = folder ? FOLDER_SLOTS[folder.toLowerCase()] : null;
    if (!slot && extension === '.gguf') {
      if (family) slot = 'diffusion';
      else if (/^(qwen3vl|qwen2vl|qwen3|llama|t5|clip)/i.test(architecture || '')) slot = 'text_encoder';
    }
    if (!slot) return;
    if (candidates[slot].length >= bounds.maxPerSlot) { truncated = true; return; }
    try {
      const stat = fsImpl.statSync(absolute);
      if (!stat.isFile()) return;
      candidates[slot].push({
        name: relative, size_bytes: stat.size, slot,
        family_guess: slot === 'diffusion' && extension === '.gguf' ? family : null,
        architecture, format: extension.slice(1),
      });
    } catch (_error) { /* Files can disappear during a scan. */ }
  }

  function walk(directory, folders, depth) {
    // Entries are read one at a time so the cap bounds memory, not only work.
    let handle;
    try { handle = fsImpl.opendirSync(directory); }
    catch (_error) { return; }
    try {
      for (;;) {
        let dirent;
        try { dirent = handle.readSync(); } catch (_error) { return; }
        if (!dirent) return;
        if (entries >= bounds.maxEntries) { truncated = true; return; }
        entries += 1;
        if (dirent.isSymbolicLink()) continue;
        const absolute = pathApi.join(directory, dirent.name);
        if (dirent.isDirectory()) {
          if (depth < bounds.maxDepth) walk(absolute, [...folders, dirent.name], depth + 1);
          else truncated = true;
        } else if (dirent.isFile()) {
          addFile([...folders, dirent.name].join('/'), absolute, folders);
        }
      }
    } finally {
      try { handle.closeSync(); } catch (_error) { /* best effort */ }
    }
  }

  walk(rootPath, [], 0);
  for (const slot of SLOTS) candidates[slot].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { ok: true, root: rootPath, candidates, truncated };
}

function validName(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('/')
    && !/^[A-Za-z]:/.test(name) && !/[\\\0]/.test(name)
    && name.split('/').every((segment) => segment !== '..' && segment !== '.' && segment !== '');
}

function insideRoot(root, file, pathApi) {
  const relative = pathApi.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

function validSet(set) {
  return set && typeof set === 'object' && typeof set.id === 'string' && /^[a-f0-9]{12}$/.test(set.id)
    && typeof set.label === 'string' && typeof set.family === 'string'
    && isLocalAbsolutePath(set.root) && Number.isFinite(set.created_at)
    && set.files && SLOTS.every((slot) => set.files[slot]
      && validName(set.files[slot].name) && Number.isSafeInteger(set.files[slot].size_bytes)
      && set.files[slot].size_bytes >= 0);
}

function readStore(storePath, fsImpl) {
  let text;
  try { text = fsImpl.readFileSync(storePath, 'utf8'); }
  catch (error) {
    return error.code === 'ENOENT' ? { version: 1, default_id: null, sets: [] } : failure('store_unreadable');
  }
  try {
    const store = JSON.parse(text);
    if (!store || store.version !== 1 || !Array.isArray(store.sets) || store.sets.length > 16
      || !store.sets.every(validSet) || new Set(store.sets.map((set) => set.id)).size !== store.sets.length
      || (store.default_id !== null && !store.sets.some((set) => set.id === store.default_id))) {
      return failure('store_corrupt');
    }
    return store;
  } catch (_error) { return failure('store_corrupt'); }
}

function writeStore(storePath, store, fsImpl) {
  try {
    fsImpl.writeFileSync(`${storePath}.part`, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fsImpl.renameSync(`${storePath}.part`, storePath);
    return { ok: true };
  } catch (_error) { return failure('store_write_failed'); }
}

function collectFiles(root, names, fsImpl, pathApi) {
  const files = {};
  const paths = {};
  try {
    const realRoot = fsImpl.realpathSync(root);
    // A directory link to a share resolves to a network path; the store must
    // never hold one (every later read would refuse the whole store).
    if (!isLocalAbsolutePath(realRoot, { platform: pathApi === path.win32 ? 'win32' : 'linux' })) return failure('root_not_local_path');
    for (const slot of SLOTS) {
      const absolute = fsImpl.realpathSync(pathApi.join(root, ...names[slot].split('/')));
      if (!insideRoot(realRoot, absolute, pathApi)) return failure('name_escapes_root');
      const stat = fsImpl.statSync(absolute);
      if (!stat.isFile()) return failure('file_missing');
      files[slot] = { name: names[slot], size_bytes: stat.size };
      paths[slot] = absolute;
    }
    return { ok: true, files, paths, root: realRoot };
  } catch (_error) { return failure('file_missing'); }
}

function saveModelSet({ storePath, root, diffusion, text_encoder, vae, family, label }, {
  platform = process.platform, fsImpl = fs, families, now = Date.now, readArchitecture = readGgufArchitecture,
} = {}) {
  const valid = validateRoot(root, platform, fsImpl);
  if (!valid.ok) return valid;
  const names = { diffusion, text_encoder, vae };
  if (!SLOTS.every((slot) => validName(names[slot]))) return failure('invalid_name');
  const table = families || loadFamilies().families;
  if (!Object.hasOwn(table, family)) return failure('unknown_family');
  const pathApi = pathFor(platform);
  const collected = collectFiles(root, names, fsImpl, pathApi);
  if (!collected.ok) return collected;
  const preset = table[family];
  if (pathApi.extname(diffusion).toLowerCase() === '.gguf') {
    let architecture = null;
    try { architecture = readArchitecture(collected.paths.diffusion, { fsImpl }); }
    catch (_error) { /* An unreadable diffusion header cannot match a family. */ }
    if (!preset.architectures.includes(architecture)) return failure('family_mismatch');
  }
  const encoder = path.posix.basename(text_encoder).toLowerCase();
  if (preset.unsupported_encoder_patterns.some((pattern) => encoder.includes(pattern.toLowerCase()))) {
    return failure('image_text_encoder_unsupported');
  }
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  const identity = [...SLOTS.map((slot) => collected.paths[slot]), ...SLOTS.map((slot) => collected.files[slot].size_bytes)].join('\n');
  const id = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const index = store.sets.findIndex((set) => set.id === id);
  if (index === -1 && store.sets.length >= 16) return failure('too_many_sets');
  const set = { id, label: typeof label === 'string' ? label : '', family, root: collected.root, files: collected.files, created_at: now() };
  if (index === -1) store.sets.push(set);
  else store.sets[index] = set;
  if (store.sets.length === 1) store.default_id = id;
  const written = writeStore(storePath, store, fsImpl);
  return written.ok ? { ok: true, set } : written;
}

function listModelSets({ storePath, fsImpl = fs }) {
  const store = readStore(storePath, fsImpl);
  return store.ok === false ? store : { sets: store.sets, default_id: store.default_id };
}

function resolveModelSet(id, { storePath, fsImpl = fs }) {
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  const set = store.sets.find((entry) => entry.id === id);
  if (!set) return failure('model_set_not_found');
  const names = Object.fromEntries(SLOTS.map((slot) => [slot, set.files[slot].name]));
  const collected = collectFiles(set.root, names, fsImpl, path);
  if (!collected.ok || !SLOTS.every((slot) => collected.files[slot].size_bytes === set.files[slot].size_bytes)) {
    return failure('image_model_set_stale');
  }
  return { ok: true, set, paths: collected.paths };
}

function removeModelSet(id, { storePath, fsImpl = fs }) {
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  const index = store.sets.findIndex((set) => set.id === id);
  if (index === -1) return failure('model_set_not_found');
  store.sets.splice(index, 1);
  if (store.default_id === id) store.default_id = store.sets[0]?.id || null;
  return writeStore(storePath, store, fsImpl);
}

function setDefaultModelSet(id, { storePath, fsImpl = fs }) {
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  if (!store.sets.some((set) => set.id === id)) return failure('model_set_not_found');
  store.default_id = id;
  return writeStore(storePath, store, fsImpl);
}

module.exports = {
  SLOTS, loadFamilies, familyForArchitecture, scanModelFolder, saveModelSet,
  listModelSets, resolveModelSet, removeModelSet, setDefaultModelSet,
};
