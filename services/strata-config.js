'use strict';

// Pack manifest, Setup-config reading, pack verification with a receipt, the context window, and the sanitized
// engine config Jenny hands to Strata's server (row 200 S2 step 3). Nothing here spawns Strata or downloads.
// Setup's config is untrusted: only the keys named in the contract are used, and `args` is rebuilt from
// Jenny's own allowlist, never copied. Reasons are stable code strings; the UI turns them into words later.

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { writeJsonAtomicAsync } = require('./backend/session-storage-fs-utils');
const { isUnderPath, readBounded, realPathInside, samePath } = require('./strata-install');

const DEFAULT_MANIFEST_FILE = path.join(__dirname, '..', 'config', 'strata-packs.json');
const WORKER_FILE = path.join(__dirname, 'strata-pack-hash-worker.js');
const SETUP_CONFIG_MAX_BYTES = 256 * 1024;
const RECEIPT_MAX_ENTRIES = 8;
const DEFAULT_WINDOW = 32768;
const HEX64 = /^[0-9a-f]{64}$/;
const EXPERT_VALUE = /^\d{1,4}(\.\d{1,3})?$/;
const EXPERT_FLAGS = ['--vram-experts-gb', '--ram-experts-gb'];
const JENNY_FLAGS = ['--native', '--max-context', '--vision', '--kv', ...EXPERT_FLAGS];
const UNSAFE_FLAGS = [
  '--host', '--api-key', '--no-api-key', '--access', '--before-load', '--mcp-config', '--slot-save-path',
  '--lazy', '--idle-unload', '--open', '--api-monitor', '--replicas', '--split-serve',
];
const TOKENIZER_FILES = ['vocab.json', 'merges.txt', 'chat_template.jinja'];

// ---- Manifest ----

function manifestError(message) {
  const error = new Error(`Strata pack manifest invalid: ${message}`);
  error.code = 'strata_manifest_invalid';
  return error;
}

const isText = (value) => typeof value === 'string' && value.length > 0;
const isBareName = (value) => isText(value) && !/[\\/]/.test(value);

function validatePack(pack, label) {
  const ok = pack && isBareName(pack.file) && Number.isSafeInteger(pack.size_bytes) && pack.size_bytes > 0 && HEX64.test(pack.sha256);
  if (!ok) throw manifestError(`${label} pack`);
}

function validateFit(entry) {
  const windows = entry && entry.windows;
  const ok = entry && isText(entry.gpu_match) && Number.isSafeInteger(entry.min_vram_mb) && windows && typeof windows === 'object';
  if (!ok) throw manifestError('fit_table entry');
  for (const [key, value] of Object.entries(windows)) {
    if (!/^\d+:(auto|k8v8|k8v4)$/.test(key) || !Number.isSafeInteger(value) || value < MIN_CONTEXT) throw manifestError(`fit window ${key}`);
  }
}

function validateFamily(family) {
  const textOk = family && ['id', 'model_name', 'engine_component', 'engine_shape', 'hf_repo', 'hf_revision'].every((key) => isText(family[key]));
  const listOk = family && Array.isArray(family.aliases) && family.aliases.every(isText) && Array.isArray(family.fit_table);
  const sizeOk = family && typeof family.params_b === 'number' && Number.isFinite(family.params_b) && family.params_b > 0;
  if (!textOk || !listOk || !sizeOk || !isBareName(family.setup_config) || !family.packs) throw manifestError('family');
  validatePack(family.packs.native, 'native');
  if (family.packs.vision !== undefined) validatePack(family.packs.vision, 'vision');
  family.fit_table.forEach(validateFit);
}

function validateManifest(manifest) {
  const ok = manifest && manifest.schema_version === 1 && ['strata_release', 'strata_commit', 'terminal_version', 'engine_version'].every((key) => isText(manifest[key]));
  if (!ok || !Array.isArray(manifest.families) || manifest.families.length === 0) throw manifestError('header');
  manifest.families.forEach(validateFamily);
  return manifest;
}

async function loadPackManifest({ file = DEFAULT_MANIFEST_FILE, fsImpl = fs } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await fsImpl.promises.readFile(file, 'utf8'));
  } catch (_error) {
    void _error;
    throw manifestError('unreadable or not JSON');
  }
  return validateManifest(parsed);
}

// ---- Settings ----

// The saved-settings rule is shared with the shell config (strata-settings.js).
const { DEFAULT_STRATA_SETTINGS, MAX_CONTEXT, MIN_CONTEXT, normalizeStrataSettings } = require('./strata-settings');

// ---- Setup config and packs ----

async function readSetupConfig(install, family, { fsImpl = fs } = {}) {
  const file = path.join(install.root, 'install', family.setup_config);
  const inside = await realPathInside(install.root, file, { fsImpl });
  if (!inside.ok) return { ok: false, reason: inside.reason === 'missing' ? 'no_setup_config' : inside.reason };
  const read = await readBounded(fsImpl, inside.path, SETUP_CONFIG_MAX_BYTES);
  if (!read || read.truncated) return { ok: false, reason: 'setup_config_invalid' };
  try {
    const config = JSON.parse(read.text);
    if (config && typeof config === 'object' && !Array.isArray(config)) return { ok: true, path: inside.path, config };
  } catch (_error) {
    void _error;
  }
  return { ok: false, reason: 'setup_config_invalid' };
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  const value = index === -1 ? null : args[index + 1];
  return typeof value === 'string' && !value.startsWith('--') ? value : null;
}

const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

async function checkPack(install, spec, file, fsImpl) {
  if (!path.isAbsolute(file)) return { ok: false, reason: 'outside_root' };
  const inside = await realPathInside(install.root, file, { fsImpl });
  if (!inside.ok) return { ok: false, reason: inside.reason === 'missing' ? 'pack_missing' : inside.reason, detail: inside.detail };
  if (!sameName(path.basename(inside.path), spec.file)) return { ok: false, reason: 'pack_name_mismatch' };
  let stat;
  try {
    stat = await fsImpl.promises.stat(inside.path);
  } catch (_error) {
    void _error;
    return { ok: false, reason: 'pack_missing' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'pack_missing' };
  if (stat.size !== spec.size_bytes) return { ok: false, reason: 'pack_size_mismatch', detail: { expected: spec.size_bytes, actual: stat.size } };
  return { ok: true, path: inside.path, size_bytes: stat.size, mtime_ms: stat.mtimeMs, spec };
}

async function findPacks(install, family, setupConfig, { fsImpl = fs } = {}) {
  const args = setupConfig && setupConfig.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return { ok: false, reason: 'setup_config_invalid' };
  const nativeFile = flagValue(args, '--native');
  if (!nativeFile) return { ok: false, reason: 'native_pack_missing' };
  const native = await checkPack(install, family.packs.native, nativeFile, fsImpl);
  if (!native.ok) return { ...native, reason: native.reason === 'pack_missing' ? 'native_pack_missing' : native.reason };
  const warnings = [];
  let vision = null;
  const visionFile = family.packs.vision ? flagValue(args, '--vision') : null;
  if (visionFile) {
    const checked = await checkPack(install, family.packs.vision, visionFile, fsImpl);
    if (checked.ok) vision = checked;
    else warnings.push({ code: 'vision_pack_unusable', reason: checked.reason });
  }
  return { ok: true, native, vision, warnings };
}

async function checkTokenizerDir(install, dir, { fsImpl = fs } = {}) {
  const inside = await realPathInside(install.root, dir, { fsImpl });
  if (!inside.ok) return { ok: false, reason: inside.reason === 'missing' ? 'tokenizer_unusable' : inside.reason };
  try {
    if (!(await fsImpl.promises.stat(inside.path)).isDirectory()) return { ok: false, reason: 'tokenizer_unusable' };
    for (const name of TOKENIZER_FILES) {
      const file = await realPathInside(install.root, path.join(inside.path, name), { fsImpl });
      if (!file.ok || !(await fsImpl.promises.stat(file.path)).isFile()) return { ok: false, reason: 'tokenizer_unusable' };
    }
  } catch (_error) {
    void _error;
    return { ok: false, reason: 'tokenizer_unusable' };
  }
  return { ok: true, path: inside.path };
}

// ---- Context window ----

function findMeasuredFit(family, gpu, key) {
  if (!gpu || typeof gpu.name !== 'string') return null;
  const name = gpu.name.toLowerCase();
  for (const entry of family.fit_table || []) {
    const fit = entry.windows[key];
    if (name.includes(entry.gpu_match.toLowerCase()) && gpu.vram_total_mb >= entry.min_vram_mb && Number.isInteger(fit)) return fit;
  }
  return null;
}

// Never returns more than the fit: a larger window makes the engine map KV into system RAM (plan section 2c).
function resolveMaxContext({ family, settings, gpu, learnedFits = {}, setupMaxContext = null }) {
  const normalized = normalizeStrataSettings(settings);
  const key = `${normalized.slots}:${normalized.kv}`;
  const learned = learnedFits && learnedFits[key];
  let fit = findMeasuredFit(family, gpu, key);
  let source = 'measured';
  if (fit === null && Number.isInteger(learned) && learned >= MIN_CONTEXT) {
    fit = learned;
    source = 'learned';
  } else if (fit === null) {
    const setup = Number.isFinite(setupMaxContext) && setupMaxContext > 0 ? setupMaxContext : DEFAULT_WINDOW;
    fit = Math.max(MIN_CONTEXT, Math.min(Math.floor(setup), DEFAULT_WINDOW));
    source = 'default';
  }
  const wanted = normalized.context === null ? fit : Math.min(normalized.context, fit);
  return { maxContext: Math.max(MIN_CONTEXT, Math.floor(wanted)), fit, source };
}

// ---- Engine config ----

// One pass over Setup's args: which unsafe flags appear, which flags are dropped, the expert values.
function scanSetupArgs(args) {
  const found = { unsafe: [], dropped: [], experts: new Map(), badExperts: [] };
  const addOnce = (list, value) => { if (!list.includes(value)) list.push(value); };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    let value = equals === -1 ? null : token.slice(equals + 1);
    if (equals === -1 && index + 1 < args.length && !args[index + 1].startsWith('--')) {
      value = args[index + 1];
      index += 1;
    }
    if (UNSAFE_FLAGS.includes(name)) addOnce(found.unsafe, name);
    else if (!JENNY_FLAGS.includes(name)) addOnce(found.dropped, name);
    else if (EXPERT_FLAGS.includes(name) && !found.experts.has(name) && !found.badExperts.includes(name)) {
      if (typeof value === 'string' && EXPERT_VALUE.test(value)) found.experts.set(name, value);
      else found.badExperts.push(name);
    }
  }
  return found;
}

function resolveExe(install, setupConfig) {
  const exe = setupConfig.exe;
  const engineExe = install.engine && install.engine.exe;
  if (exe === undefined || exe === 'component:strata-inkling') return { ok: true, exe: engineExe };
  if (typeof exe !== 'string' || exe.startsWith('component:')) return { ok: false, reason: 'exe_unsupported' };
  if (!samePath(path.resolve(exe), engineExe)) return { ok: false, reason: 'exe_outside_components' };
  return { ok: true, exe: engineExe };
}

function checkTokenizerInput(install, setupConfig, checked) {
  const declared = setupConfig.tokenizer;
  if (typeof declared !== 'string' || !path.isAbsolute(declared)) return { ok: false, reason: 'tokenizer_invalid' };
  if (!isUnderPath(install.root, declared)) return { ok: false, reason: 'outside_root' };
  if (typeof checked !== 'string' || !checked) return { ok: false, reason: 'tokenizer_unchecked' };
  if (!isUnderPath(install.root, checked)) return { ok: false, reason: 'outside_root' };
  return { ok: true, tokenizer: checked };
}

function rebuildArgs(packs, settings, maxContext, scan) {
  const args = ['--native', packs.native.path, '--max-context', String(maxContext)];
  if (settings.vision && packs.vision) args.push('--vision', packs.vision.path);
  if (settings.kv !== 'auto') args.push('--kv', settings.kv);
  for (const flag of EXPERT_FLAGS) {
    if (scan.experts.has(flag)) args.push(flag, scan.experts.get(flag));
  }
  return args;
}

function checkBuildInput({ install, family, setupConfig, packs, maxContext }) {
  const valid = install && install.engine && isText(install.engine.exe) && isText(install.root) && isText(install.terminalDir)
    && family && packs && packs.native && isText(packs.native.path)
    && setupConfig && Array.isArray(setupConfig.args) && setupConfig.args.every((arg) => typeof arg === 'string');
  if (!valid) return { ok: false, reason: 'setup_config_invalid' };
  if (!Number.isInteger(maxContext) || maxContext < MIN_CONTEXT || maxContext > MAX_CONTEXT) return { ok: false, reason: 'max_context_invalid' };
  return { ok: true };
}

function buildStrataConfig(input) {
  const bad = checkBuildInput(input);
  if (!bad.ok) return bad;
  const { install, family, setupConfig, packs, maxContext, userDataPath } = input;
  const settings = normalizeStrataSettings(input.settings);
  const scan = scanSetupArgs(setupConfig.args);
  if (scan.unsafe.length) return { ok: false, reason: 'unsafe_setup_args', detail: { flags: scan.unsafe } };
  const exe = resolveExe(install, setupConfig);
  if (!exe.ok) return exe;
  if (setupConfig.model_name !== family.model_name) return { ok: false, reason: 'model_name_mismatch' };
  const tokenizer = checkTokenizerInput(install, setupConfig, input.tokenizer);
  if (!tokenizer.ok) return tokenizer;
  const warnings = scan.badExperts.map((flag) => ({ code: 'expert_flag_dropped', flag }));
  if (scan.dropped.length) warnings.push({ code: 'setup_args_dropped', flags: scan.dropped });
  const config = {
    exe: exe.exe,
    cwd: install.terminalDir,
    tokenizer: tokenizer.tokenizer,
    model_name: family.model_name,
    args: rebuildArgs(packs, settings, maxContext, scan),
    drafting: settings.drafting,
    aliases: [...family.aliases],
    log: path.join(userDataPath, 'strata', 'logs', 'strata-server.log'),
  };
  return { ok: true, config, warnings };
}

// ---- Pack verification and the receipt ----

function hashWithWorker(file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => { if (!settled) { settled = true; settle(value); } };
    const worker = new Worker(WORKER_FILE, { workerData: { path: file } });
    worker.on('message', (message) => {
      if (message && Number.isFinite(message.done)) { if (!settled) onProgress(message.done); return; }
      if (message && typeof message.sha256 === 'string') finish(resolve, message.sha256);
      else finish(reject, new Error(String((message && message.error) || 'hash_failed')));
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => finish(reject, new Error(`hash worker exited (${code}) without a result`)));
  });
}

const inflightHashes = new Map();
let receiptQueue = Promise.resolve();

// One hash per file at a time; every caller hears its byte progress.
function hashOnce(pack, hashFile, onProgress) {
  const key = process.platform === 'win32' ? pack.path.toLowerCase() : pack.path;
  let pending = inflightHashes.get(key);
  if (!pending) {
    const listeners = new Set();
    pending = Promise.resolve().then(() => hashFile(pack.path, (done) => listeners.forEach((listener) => listener(done))))
      .finally(() => inflightHashes.delete(key));
    pending.listeners = listeners;
    inflightHashes.set(key, pending);
  }
  if (typeof onProgress === 'function') pending.listeners.add(onProgress);
  return pending;
}

const receiptFilePath = (userDataPath) => path.join(userDataPath, 'strata', 'pack-receipts.json');

function validReceipt(entry) {
  return entry && isText(entry.path) && Number.isFinite(entry.size_bytes) && Number.isFinite(entry.mtime_ms) && HEX64.test(entry.sha256);
}

// A missing, unparsable or wrong-schema file is an empty list, never an error.
async function readReceipts(fsImpl, userDataPath) {
  if (!isText(userDataPath)) return [];
  try {
    const parsed = JSON.parse(await fsImpl.promises.readFile(receiptFilePath(userDataPath), 'utf8'));
    if (!parsed || parsed.schema_version !== 1 || !Array.isArray(parsed.receipts)) return [];
    return parsed.receipts.filter(validReceipt).slice(-RECEIPT_MAX_ENTRIES);
  } catch (_error) {
    void _error;
    return [];
  }
}

// Serialized so the packs' concurrent verifications never lose each other's receipt; a failed write is not a failed check.
function updateReceipts(fsImpl, userDataPath, pack, sha256) {
  if (!isText(userDataPath)) return Promise.resolve();
  const run = receiptQueue.then(async () => {
    const kept = (await readReceipts(fsImpl, userDataPath)).filter((entry) => !samePath(entry.path, pack.path));
    if (sha256) {
      kept.push({ path: pack.path, size_bytes: pack.size_bytes, mtime_ms: pack.mtime_ms, sha256, verified_at: new Date().toISOString() });
    }
    await writeJsonAtomicAsync(receiptFilePath(userDataPath), { schema_version: 1, receipts: kept.slice(-RECEIPT_MAX_ENTRIES) });
  }).catch(() => {});
  receiptQueue = run;
  return run;
}

function receiptMatches(entry, pack) {
  return samePath(entry.path, pack.path) && entry.size_bytes === pack.size_bytes
    && entry.mtime_ms === pack.mtime_ms && entry.sha256 === pack.spec.sha256;
}

async function verifyPack(pack, { userDataPath, force = false, fsImpl = fs, hashFile = hashWithWorker, onProgress = null } = {}) {
  if (!force) {
    const hit = (await readReceipts(fsImpl, userDataPath)).find((entry) => receiptMatches(entry, pack));
    if (hit) return { ok: true, sha256: hit.sha256, fromReceipt: true };
  }
  let actual;
  try {
    actual = String(await hashOnce(pack, hashFile, onProgress)).toLowerCase();
  } catch (error) {
    return { ok: false, reason: 'hash_failed', detail: { message: String((error && error.message) || error) } };
  }
  if (actual === pack.spec.sha256) {
    await updateReceipts(fsImpl, userDataPath, pack, actual);
    return { ok: true, sha256: actual, fromReceipt: false };
  }
  await updateReceipts(fsImpl, userDataPath, pack, null);
  return { ok: false, reason: 'sha256_mismatch', detail: { expected: pack.spec.sha256, actual } };
}

module.exports = {
  DEFAULT_STRATA_SETTINGS,
  buildStrataConfig,
  checkTokenizerDir,
  findPacks,
  loadPackManifest,
  normalizeStrataSettings,
  readSetupConfig,
  resolveMaxContext,
  verifyPack,
};
