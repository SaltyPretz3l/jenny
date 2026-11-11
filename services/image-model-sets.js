'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isLocalAbsolutePath } = require('./shell-config-engines');
const { readGgufArchitecture } = require('./gguf-header');

const REQUIRED_SLOTS = Object.freeze(['diffusion', 'text_encoder', 'vae']);
const OPTIONAL_SLOTS = Object.freeze(['vision_projector']);
const ALL_SLOTS = Object.freeze([...REQUIRED_SLOTS, ...OPTIONAL_SLOTS]);
const FOLDER_SLOTS = { diffusion_models: 'diffusion', unet: 'diffusion', text_encoders: 'text_encoder', clip: 'text_encoder', llm: 'text_encoder', vae: 'vae' };
const DEFAULT_LIMITS = { maxDepth: 3, maxEntries: 2000, maxPerSlot: 64 };
const COMFY_FIND_LIMITS = { ...DEFAULT_LIMITS, maxDepth: 2 };
const STORE_VERSION = 2;
const failure = (reason) => ({ ok: false, reason });
const pathFor = (platform) => platform === 'win32' ? path.win32 : path.posix;

function loadFamilies({ familiesPath = path.join(__dirname, '..', 'config', 'sdcpp-families.json'), fsImpl = fs } = {}) {
  const { version, families } = JSON.parse(fsImpl.readFileSync(familiesPath, 'utf8'));
  return { version, families };
}

function loadRecipes({ recipesPath = path.join(__dirname, '..', 'config', 'comfyui-recipes.json'), fsImpl = fs } = {}) {
  const { version, recipes } = JSON.parse(fsImpl.readFileSync(recipesPath, 'utf8'));
  return { version, recipes };
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmptyStrings = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry !== '');
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

function recipeProblem(recipe) {
  if (!isObject(recipe) || !isObject(recipe.graph) || !isObject(recipe.slots) || !isObject(recipe.files)) return 'recipe needs graph, slots and files objects';
  const { graph, slots } = recipe;
  for (const [name, target] of Object.entries(slots)) {
    const [node, input] = Array.isArray(target) ? target : [];
    if (!isObject(graph[node]) || !isObject(graph[node].inputs) || !Object.hasOwn(graph[node].inputs, input)) return `slot ${name} names a missing graph input`;
  }
  for (const name of [...REQUIRED_SLOTS, 'prompt', 'width', 'height', 'seed']) if (!Object.hasOwn(slots, name)) return `slot ${name} is missing`;
  for (const phase of ['sample', 'decode', 'output']) if (!isObject(graph[recipe.phase_nodes?.[phase]])) return `phase node ${phase} is not in the graph`;
  for (const slot of REQUIRED_SLOTS) {
    const files = recipe.files[slot];
    if (!isObject(files) || !['folders', 'prefixes', 'extensions'].every((key) => nonEmptyStrings(files[key]))) return `files.${slot} needs folders, prefixes and extensions`;
  }
  if (!Array.isArray(recipe.resolutions) || recipe.resolutions.length === 0) return 'resolutions are missing';
  for (const size of recipe.resolutions) {
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match || ![match[1], match[2]].every((side) => Number(side) > 0 && Number(side) % 32 === 0)) return `resolution ${String(size)} is not a positive multiple of 32`;
  }
  if (!isObject(recipe.size_map) || !Object.values(recipe.size_map).every((size) => recipe.resolutions.includes(size))) return 'size_map maps outside resolutions';
  if (!positiveInteger(recipe.min_total_vram_mb) || !positiveInteger(recipe.free_vram_mb)) return 'VRAM numbers must be positive integers';
  if (!Number.isFinite(recipe.locked?.steps) || !Number.isFinite(recipe.locked?.cfg_scale)) return 'locked steps and cfg_scale must be numbers';
  return null;
}

function validateRecipe(recipe) {
  const detail = recipeProblem(recipe);
  return detail ? { ok: false, reason: 'recipe_invalid', detail } : { ok: true };
}

function recipeNodeTypes(recipe) {
  return [...new Set(Object.values(recipe.graph).map((node) => node.class_type))].sort();
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
  const candidates = { diffusion: [], text_encoder: [], vae: [], vision_projector: [] };
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
    if (extension === '.gguf' && /mmproj/i.test(pathApi.basename(absolute))) slot = 'vision_projector';
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
  for (const slot of ALL_SLOTS) candidates[slot].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
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
  const comfy = set?.backend === 'comfyui';
  return set && typeof set === 'object' && typeof set.id === 'string' && /^[a-f0-9]{12}$/.test(set.id)
    && (comfy || set.backend === 'sdcpp') && typeof set.label === 'string'
    && (comfy ? typeof set.recipe === 'string' && set.recipe !== '' : typeof set.family === 'string')
    && isLocalAbsolutePath(set.root) && Number.isFinite(set.created_at)
    && set.files && [...REQUIRED_SLOTS, ...(comfy ? [] : OPTIONAL_SLOTS.filter(slot => set.files[slot] !== undefined))].every((slot) => set.files[slot]
      && validName(set.files[slot].name) && Number.isSafeInteger(set.files[slot].size_bytes)
      && set.files[slot].size_bytes >= 0);
}

function readStore(storePath, fsImpl) {
  let text;
  try { text = fsImpl.readFileSync(storePath, 'utf8'); }
  catch (error) {
    return error.code === 'ENOENT' ? { version: STORE_VERSION, default_id: null, comfyui_folder: null, sets: [] } : failure('store_unreadable');
  }
  try {
    let store = JSON.parse(text);
    // A version 1 file migrates in memory; the next write lands it as version 2.
    if (store?.version === 1 && Array.isArray(store.sets)) {
      store = { ...store, version: STORE_VERSION, comfyui_folder: null, sets: store.sets.map((set) => (set && typeof set === 'object' ? { ...set, backend: 'sdcpp' } : set)) };
    }
    if (!store || store.version !== STORE_VERSION || !Array.isArray(store.sets) || store.sets.length > 16
      || !store.sets.every(validSet) || new Set(store.sets.map((set) => set.id)).size !== store.sets.length
      || (store.default_id !== null && !store.sets.some((set) => set.id === store.default_id))
      || (store.comfyui_folder !== null && !(typeof store.comfyui_folder === 'string' && isLocalAbsolutePath(store.comfyui_folder)))) {
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
    for (const slot of ALL_SLOTS.filter((key) => names[key])) {
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

function saveModelSet({ storePath, root, diffusion, text_encoder, vae, vision_projector, family, label }, {
  platform = process.platform, fsImpl = fs, families, now = Date.now, readArchitecture = readGgufArchitecture,
} = {}) {
  const valid = validateRoot(root, platform, fsImpl);
  if (!valid.ok) return valid;
  const names = { diffusion, text_encoder, vae, ...(vision_projector ? { vision_projector } : {}) };
  if (!REQUIRED_SLOTS.every((slot) => validName(names[slot])) || (vision_projector !== undefined && vision_projector !== '' && !validName(vision_projector))) return failure('invalid_name');
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
  if (vision_projector) {
    try {
      if (!preset.vision_flag || pathApi.extname(vision_projector).toLowerCase() !== '.gguf'
        || readArchitecture(collected.paths.vision_projector, { fsImpl }) !== 'clip') return failure('image_projector_unsupported');
    } catch (_error) { return failure('image_projector_unsupported'); }
  }
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  const slots = ALL_SLOTS.filter((slot) => collected.paths[slot]);
  const identity = [...slots.map((slot) => collected.paths[slot]), ...slots.map((slot) => collected.files[slot].size_bytes)].join('\n');
  const id = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const index = store.sets.findIndex((set) => set.id === id);
  if (index === -1 && store.sets.length >= 16) return failure('too_many_sets');
  const set = { id, label: typeof label === 'string' ? label : '', backend: 'sdcpp', family, root: collected.root, files: collected.files, created_at: now() };
  if (index === -1) store.sets.push(set);
  else store.sets[index] = set;
  if (store.sets.length === 1) store.default_id = id;
  const written = writeStore(storePath, store, fsImpl);
  return written.ok ? { ok: true, set } : written;
}

function listModelSets({ storePath, fsImpl = fs }) {
  const store = readStore(storePath, fsImpl);
  return store.ok === false ? store : { sets: store.sets, default_id: store.default_id, comfyui_folder: store.comfyui_folder };
}

function validateComfyFolder(folder, { fsImpl = fs, platform = process.platform } = {}) {
  const valid = validateRoot(folder, platform, fsImpl);
  if (!valid.ok) return valid.reason === 'root_not_directory' ? failure('comfyui_folder_invalid') : valid;
  const pathApi = pathFor(platform);
  const real = fsImpl.realpathSync(folder);
  const isFile = (file) => { try { return fsImpl.statSync(file).isFile(); } catch (_error) { return false; } };
  const isDirectory = (dir) => { try { return fsImpl.statSync(dir).isDirectory(); } catch (_error) { return false; } };
  const pythons = [pathApi.join(real, 'python_embeded', 'python.exe'), ...(platform === 'win32' ? [] : [pathApi.join(real, 'python_embeded', 'bin', 'python3')])];
  const pythonPath = pythons.find(isFile);
  const mainPath = pathApi.join(real, 'ComfyUI', 'main.py');
  const modelsRoot = pathApi.join(real, 'ComfyUI', 'models');
  // The interpreter Jenny spawns and its script must not be links out of the chosen folder.
  const contained = (file) => { try { return insideRoot(real, fsImpl.realpathSync(file), pathApi); } catch (_error) { return false; } };
  if (!pythonPath || !isFile(mainPath) || !isDirectory(modelsRoot)
    || !contained(pythonPath) || !contained(mainPath)) return failure('comfyui_folder_invalid');
  return { ok: true, folder: real, pythonPath, mainPath, modelsRoot };
}

function setComfyFolder({ storePath, folder }, { fsImpl = fs, platform = process.platform } = {}) {
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  let next = null;
  if (folder !== null) {
    const valid = validateComfyFolder(folder, { fsImpl, platform });
    if (!valid.ok) return valid;
    next = valid.folder;
  }
  store.comfyui_folder = next;
  const written = writeStore(storePath, store, fsImpl);
  return written.ok ? { ok: true, comfyui_folder: next } : written;
}

function getComfyFolder({ storePath, fsImpl = fs }) {
  const store = readStore(storePath, fsImpl);
  return store.ok === false ? store : { ok: true, comfyui_folder: store.comfyui_folder };
}

// The saved folder, validated, with the recipe it is used for.
function comfyContext(store, recipeId, { fsImpl, platform, recipes }) {
  if (!store.comfyui_folder) return failure('comfyui_folder_missing');
  const folder = validateComfyFolder(store.comfyui_folder, { fsImpl, platform });
  if (!folder.ok) return folder;
  const table = recipes || loadRecipes().recipes;
  if (typeof recipeId !== 'string' || !Object.hasOwn(table, recipeId)) return failure('unknown_recipe');
  return { ok: true, folder, recipe: table[recipeId] };
}

function recipeFileMatches(files, name, pathApi) {
  const segments = name.split('/');
  const base = segments[segments.length - 1].toLowerCase();
  return segments.length >= 2 && files.folders.includes(segments[0])
    && files.prefixes.some((prefix) => base.startsWith(prefix.toLowerCase()))
    && files.extensions.some((extension) => pathApi.extname(base) === extension.toLowerCase());
}

function findRecipeFiles({ storePath, recipe: recipeId }, {
  fsImpl = fs, platform = process.platform, recipes, limits = COMFY_FIND_LIMITS,
} = {}) {
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  const context = comfyContext(store, recipeId, { fsImpl, platform, recipes });
  if (!context.ok) return context;
  const bounds = { ...COMFY_FIND_LIMITS, ...limits };
  if (!Object.values(bounds).every((limit) => Number.isSafeInteger(limit) && limit >= 0)) return failure('invalid_limits');
  const pathApi = pathFor(platform);
  const { modelsRoot } = context.folder;
  const candidates = { diffusion: [], text_encoder: [], vae: [] };
  let entries = 0;
  let truncated = false;

  function walk(directory, relative, slot, depth) {
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
        const name = `${relative}/${dirent.name}`;
        if (dirent.isDirectory()) {
          if (depth < bounds.maxDepth) walk(absolute, name, slot, depth + 1);
          else truncated = true;
        } else if (dirent.isFile() && recipeFileMatches(context.recipe.files[slot], name, pathApi)) {
          if (candidates[slot].length >= bounds.maxPerSlot) { truncated = true; continue; }
          try { candidates[slot].push({ name, size_bytes: fsImpl.statSync(absolute).size }); }
          catch (_error) { /* Files can disappear during a listing. */ }
        }
      }
    } finally {
      try { handle.closeSync(); } catch (_error) { /* best effort */ }
    }
  }

  for (const slot of REQUIRED_SLOTS) {
    for (const folder of context.recipe.files[slot].folders) {
      const directory = pathApi.join(modelsRoot, folder);
      // A linked model folder would fail the containment check on save, so it is not offered.
      try { if (fsImpl.lstatSync(directory).isSymbolicLink()) continue; } catch (_error) { continue; }
      walk(directory, folder, slot, 0);
    }
    candidates[slot].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  return { ok: true, root: modelsRoot, candidates, truncated };
}

function saveComfyModelSet({ storePath, recipe: recipeId, diffusion, text_encoder, vae, label }, {
  platform = process.platform, fsImpl = fs, recipes, now = Date.now,
} = {}) {
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  const context = comfyContext(store, recipeId, { fsImpl, platform, recipes });
  if (!context.ok) return context;
  const names = { diffusion, text_encoder, vae };
  if (!REQUIRED_SLOTS.every((slot) => validName(names[slot]))) return failure('invalid_name');
  const pathApi = pathFor(platform);
  if (!REQUIRED_SLOTS.every((slot) => recipeFileMatches(context.recipe.files[slot], names[slot], pathApi))) return failure('recipe_file_mismatch');
  const collected = collectFiles(context.folder.modelsRoot, names, fsImpl, pathApi);
  if (!collected.ok) return collected;
  const identity = ['comfyui', recipeId, ...REQUIRED_SLOTS.map((slot) => collected.paths[slot]), ...REQUIRED_SLOTS.map((slot) => collected.files[slot].size_bytes)].join('\n');
  const id = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const index = store.sets.findIndex((set) => set.id === id);
  if (index === -1 && store.sets.length >= 16) return failure('too_many_sets');
  const set = { id, label: typeof label === 'string' ? label : '', backend: 'comfyui', recipe: recipeId, root: collected.root, files: collected.files, created_at: now() };
  if (index === -1) store.sets.push(set);
  else store.sets[index] = set;
  if (store.sets.length === 1) store.default_id = id;
  const written = writeStore(storePath, store, fsImpl);
  return written.ok ? { ok: true, set } : written;
}

const VERSION_PATTERN = /__version__\s*=\s*["']([0-9][0-9A-Za-z.+-]{0,31})["']/;
const VERSION_READ_BYTES = 4096;

// ComfyUI's own version, from a bounded read of its version file. The file is
// untrusted: it is never evaluated, only matched, and a link out of the install is not read.
function readComfyVersion(folder, fsImpl, pathApi) {
  let fd = null;
  try {
    const file = pathApi.join(folder, 'ComfyUI', 'comfyui_version.py');
    const real = fsImpl.realpathSync(file);
    if (!insideRoot(folder, real, pathApi) || !fsImpl.statSync(real).isFile()) return '';
    fd = fsImpl.openSync(real, 'r');
    const buffer = Buffer.alloc(VERSION_READ_BYTES);
    const length = fsImpl.readSync(fd, buffer, 0, VERSION_READ_BYTES, 0);
    return VERSION_PATTERN.exec(buffer.toString('utf8', 0, length))?.[1] || '';
  } catch (_error) { return ''; }
  finally {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch (_error) { /* best effort */ } }
  }
}

// Dotted numeric compare: missing parts are 0 and a non-numeric suffix is ignored.
function versionAtLeast(version, minimum) {
  const parts = (text) => text.split('.').map((part) => Number.parseInt(/^\d+/.exec(part)?.[0] ?? '0', 10));
  const have = parts(version);
  const need = parts(minimum);
  for (let index = 0; index < Math.max(have.length, need.length); index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

// A recipe counts as added only when a set for it lives under the current
// models folder; a set from a folder the user moved away from is stale.
function recipeAdded(sets, recipeId, modelsRoot) {
  return Boolean(modelsRoot) && sets.some((set) => set.backend === 'comfyui' && set.recipe === recipeId && set.root === modelsRoot);
}

// Static file reads only: the saved ComfyUI folder, its version, and what each recipe finds there.
function comfyFolderHealth({ storePath }, { fsImpl = fs, platform = process.platform, recipes } = {}) {
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  if (!store.comfyui_folder) return null;
  const folder = store.comfyui_folder;
  const valid = validateComfyFolder(folder, { fsImpl, platform });
  if (!valid.ok) return { folder, ok: false, reason: valid.reason, version: '', recipes: {} };
  const pathApi = pathFor(platform);
  const version = readComfyVersion(valid.folder, fsImpl, pathApi);
  let modelsRoot = '';
  try { modelsRoot = fsImpl.realpathSync(valid.modelsRoot); } catch (_error) { /* nothing counts as added */ }
  const table = recipes || loadRecipes().recipes;
  const entries = {};
  for (const [id, recipe] of Object.entries(table)) {
    const found = findRecipeFiles({ storePath, recipe: id }, { fsImpl, platform, recipes: table });
    const minimum = recipe.min_comfyui_version || '';
    entries[id] = {
      label: recipe.label, min_version: minimum,
      version_ok: version === '' || minimum === '' || versionAtLeast(version, minimum),
      steps: recipe.locked.steps,
      slots: Object.fromEntries(REQUIRED_SLOTS.map((slot) => [slot, found.ok ? found.candidates[slot] : []])),
      truncated: found.ok ? found.truncated : false,
      added: recipeAdded(store.sets, id, modelsRoot),
    };
  }
  return { folder, ok: true, reason: '', version, models_root: modelsRoot, recipes: entries };
}

// ComfyUI's loader nodes take the path below the model folder, with the OS separator.
function loaderNameFor(name, platform = process.platform) {
  return name.split('/').slice(1).join(pathFor(platform).sep);
}

function resolveModelSet(id, { storePath, fsImpl = fs, platform = process.platform }) {
  const store = readStore(storePath, fsImpl);
  if (store.ok === false) return store;
  const set = store.sets.find((entry) => entry.id === id);
  if (!set) return failure('model_set_not_found');
  const stale = failure('image_model_set_stale');
  const comfy = set.backend === 'comfyui';
  let folder = null;
  if (comfy) {
    if (!store.comfyui_folder) return stale;
    folder = validateComfyFolder(store.comfyui_folder, { fsImpl, platform });
    try { if (!folder.ok || fsImpl.realpathSync(folder.modelsRoot) !== set.root) return stale; }
    catch (_error) { return stale; }
    if (!REQUIRED_SLOTS.every((slot) => set.files[slot].name.includes('/'))) return stale;
  }
  const names = Object.fromEntries(ALL_SLOTS.filter((slot) => set.files[slot]).map((slot) => [slot, set.files[slot].name]));
  const collected = collectFiles(set.root, names, fsImpl, pathFor(platform));
  if (!collected.ok || !Object.keys(names).every((slot) => collected.files[slot].size_bytes === set.files[slot].size_bytes)) return stale;
  if (!comfy) return { ok: true, set, paths: collected.paths };
  const loaderNames = Object.fromEntries(REQUIRED_SLOTS.map((slot) => [slot, loaderNameFor(names[slot], platform)]));
  const { pythonPath, mainPath, modelsRoot } = folder;
  return { ok: true, set, paths: collected.paths, comfy: { folder: folder.folder, pythonPath, mainPath, modelsRoot, loaderNames } };
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
  REQUIRED_SLOTS, OPTIONAL_SLOTS, loadFamilies, familyForArchitecture, scanModelFolder, saveModelSet,
  listModelSets, resolveModelSet, removeModelSet, setDefaultModelSet,
  loadRecipes, validateRecipe, recipeNodeTypes, validateComfyFolder, setComfyFolder, getComfyFolder,
  findRecipeFiles, saveComfyModelSet, comfyFolderHealth, recipeAdded, loaderNameFor,
};
