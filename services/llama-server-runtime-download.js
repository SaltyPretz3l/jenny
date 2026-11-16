'use strict';

// Row 142 S3: "Get a build". When no trusted llama-server build can read a model's
// architecture, Jenny can download one pinned llama.cpp release into
// {userData}/runtimes/<release>-<variant>/, where the chooser
// (main/llama-server-runtime-choice.js) finds it like any other trusted build.
//
// Main owns everything: the renderer sends only an architecture string, which
// is a catalog lookup, never a path, URL or file name. URLs are built here from
// one fixed prefix and the catalog's plain file names. A download starts only
// from start() (a click), never by itself, and nothing relaunches afterwards.
// Order of a job: each asset downloads to .downloads/<name>.part (resumable
// with Range), its size and sha256 must match the catalog, every zip extracts
// into a staging folder (llama-server-runtime-extract.js), the staging build is
// probed and must report the catalog's build number, and only then does the
// folder move into place. A failed or cancelled job installs nothing. Status
// and logs carry codes and numbers only: no paths, URLs or raw error text.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { extractRuntimeZip } = require('./llama-server-runtime-extract');
const { removeFile, removeTree } = require('./fs-remove-no-follow');

const DEFAULT_CATALOG_PATH = path.join(__dirname, '..', 'config', 'llama-server-runtimes.json');
const DOWNLOAD_PREFIX = 'https://github.com/ggml-org/llama.cpp/releases/download/';
const SERVER_NAME = 'llama-server.exe';
const RELEASE = /^b\d{3,9}$/;
const ARCHITECTURE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const VARIANT_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.zip$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;
const MAX_ASSET_BYTES = 8 * 1024 ** 3;
const MAX_ARCHITECTURES = 1024;
const MAX_REDIRECTS = 5;
const SPACE_FACTOR = 2.5;
const EXTRACT_FACTOR = 4;
const RESPONSE_TIMEOUT_MS = 30000;
const INACTIVITY_MS = 60000;
const ABORTED = Symbol('aborted');

class Fail extends Error {
  constructor(reason, extra = {}) {
    super(reason);
    this.reason = reason;
    Object.assign(this, extra);
  }
}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The catalog's reason for being invalid is a code, never the offending text.
function validateCatalog(raw) {
  if (!isPlain(raw) || raw.schema_version !== 1) return { ok: false, reason: 'catalog_shape' };
  if (typeof raw.release !== 'string' || !RELEASE.test(raw.release)
    || raw.build !== Number(raw.release.slice(1))) return { ok: false, reason: 'catalog_release' };
  const architectures = raw.architectures;
  if (!Array.isArray(architectures) || architectures.length === 0 || architectures.length > MAX_ARCHITECTURES
    || !architectures.every((name) => typeof name === 'string' && ARCHITECTURE.test(name))) {
    return { ok: false, reason: 'catalog_architectures' };
  }
  if (!isPlain(raw.variants) || Object.keys(raw.variants).length === 0) return { ok: false, reason: 'catalog_variants' };
  const variants = {};
  for (const [id, variant] of Object.entries(raw.variants)) {
    if (!VARIANT_ID.test(id) || !isPlain(variant) || variant.platform !== 'win32' || variant.arch !== 'x64'
      || (variant.gpu !== 'nvidia' && variant.gpu !== 'none')
      || !Array.isArray(variant.assets) || variant.assets.length === 0 || variant.assets.length > 4) {
      return { ok: false, reason: 'catalog_variant' };
    }
    const assets = [];
    for (const asset of variant.assets) {
      if (!isPlain(asset) || typeof asset.name !== 'string' || !ASSET_NAME.test(asset.name)
        || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES
        || typeof asset.sha256 !== 'string' || !SHA256_HEX.test(asset.sha256)) {
        return { ok: false, reason: 'catalog_asset' };
      }
      assets.push({ name: asset.name, size: asset.size, sha256: asset.sha256 });
    }
    variants[id] = {
      gpu: variant.gpu, assets, totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
    };
  }
  return {
    ok: true,
    catalog: { release: raw.release, build: raw.build, architectures: new Set(architectures), variants },
  };
}

function loadRuntimeCatalog(filePath = DEFAULT_CATALOG_PATH, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

// GitHub serves a release asset from github.com, then redirects to its own
// asset hosts; every hop is checked, nothing else is followed.
function allowedHop(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_error) { return false; }
  return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password
    && (parsed.hostname === 'github.com' || parsed.hostname.endsWith('.githubusercontent.com'));
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function createLlamaServerRuntimeDownload({
  catalog = DEFAULT_CATALOG_PATH,
  userDataPath = () => '',
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  fsImpl = fs,
  statfsImpl = fs.promises.statfs,
  detectNvidia = async () => false,
  validateImpl = null,
  // The chooser's two answers for an architecture; start() re-checks the offer.
  bundledReads = () => 'unknown',
  hasReader = () => true,
  isLocalOnly = () => false,
  isEnabled = () => true,
  onReady = async () => {},
  log = () => {},
} = {}) {
  const fsp = fsImpl.promises;
  const emit = (level, event, fields) => {
    try { log(level, event, fields); } catch (_error) { /* logging never breaks a download */ }
  };
  const read = (thunk, fallback) => {
    try {
      const value = typeof thunk === 'function' ? thunk() : thunk;
      return value == null ? fallback : value;
    } catch (_error) {
      return fallback;
    }
  };

  let parsed; // undefined: not loaded; null: invalid (logged once)
  const catalogData = () => {
    if (parsed === undefined) {
      const raw = typeof catalog === 'string' ? loadRuntimeCatalog(catalog, fsImpl) : read(catalog, null);
      const checked = validateCatalog(raw);
      parsed = checked.ok ? checked.catalog : null;
      if (!checked.ok) emit('WARN', 'llama.server.runtime_download_catalog_invalid', { reason: checked.reason });
    }
    return parsed;
  };

  let nvidia = null; // null until the first detectNvidia() answer
  let warming = null;
  const warm = () => {
    if (!warming) {
      warming = Promise.resolve().then(() => detectNvidia()).then((found) => { nvidia = found === true; }, () => { nvidia = false; });
    }
    return warming;
  };

  const runtimesDir = () => {
    const home = String(read(userDataPath, '') || '');
    return home && path.isAbsolute(home) ? path.join(home, 'runtimes') : '';
  };
  const pick = (data) => {
    if (nvidia === null) return null;
    const entries = Object.entries(data.variants);
    const wanted = entries.find(([, variant]) => variant.gpu === (nvidia ? 'nvidia' : 'none'))
      || entries.find(([, variant]) => variant.gpu === 'none');
    return wanted ? { id: wanted[0], ...wanted[1] } : null;
  };
  const folderName = (data, variant) => `${data.release}-${variant.id}`;
  const installed = (data, variant) => {
    const home = runtimesDir();
    if (!home) return false;
    try {
      return fsImpl.statSync(path.join(home, folderName(data, variant), SERVER_NAME)).isFile();
    } catch (_error) {
      return false;
    }
  };

  // null, or { build, sizeBytes }. Synchronous (the import plan is), so the GPU
  // answer must have been warmed; until then there is no offer. The chooser's two
  // answers come from the injected resolvers unless a caller passes them.
  function offerFor({ architecture, bundledReads: bundledArg, hasReader: readerArg } = {}) {
    if (!read(isEnabled, false) || platform !== 'win32' || arch !== 'x64') return null;
    if (typeof architecture !== 'string' || !ARCHITECTURE.test(architecture)) return null;
    const bundled = bundledArg !== undefined ? bundledArg : read(() => bundledReads(architecture), 'unknown');
    const reader = readerArg !== undefined ? readerArg : read(() => hasReader(architecture), true);
    if (bundled !== 'no' || reader !== false) return null;
    const data = catalogData();
    if (!data || !data.architectures.has(architecture)) return null;
    if (nvidia === null) {
      warm();
      return null;
    }
    const variant = pick(data);
    if (!variant || installed(data, variant)) return null;
    return { build: data.build, sizeBytes: variant.totalBytes };
  }

  let job = null; // { build, variant, controller, promise, running }
  let state = { state: 'idle', build: 0, receivedBytes: 0, totalBytes: 0 };
  const setState = (patch) => { state = { ...state, ...patch }; };
  const status = () => ({ ...state });

  // ---- paths ----------------------------------------------------------------
  const sameKey = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  // The runtimes folder must be a real directory (never a link); returns its real path.
  async function realRuntimes() {
    const home = runtimesDir();
    if (!home) throw new Fail('unsafe_entry');
    await fsp.mkdir(home, { recursive: true });
    const info = await fsp.lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Fail('unsafe_entry');
    return { home, real: await fsp.realpath(home) };
  }
  // A direct child folder of runtimes/ that is real and sits where its name says.
  async function plainChild(roots, name, { create }) {
    const child = path.join(roots.home, name);
    if (create) await fsp.mkdir(child, { recursive: true });
    const info = await fsp.lstat(child);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Fail('unsafe_entry');
    if (sameKey(await fsp.realpath(child)) !== sameKey(path.join(roots.real, name))) throw new Fail('unsafe_entry');
    return child;
  }

  // ---- download -------------------------------------------------------------
  async function openPartial(partPath, start) {
    try {
      if (!(await fsp.lstat(partPath)).isFile()) throw new Fail('unsafe_entry');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const { O_WRONLY, O_CREAT, O_NOFOLLOW = 0 } = fs.constants;
    const handle = await fsp.open(partPath, O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600);
    try {
      if (start === 0) await handle.truncate(0);
    } catch (error) {
      await handle.close();
      throw error;
    }
    return handle;
  }

  async function request(url, partSize, controller) {
    const headers = partSize > 0 ? { Range: `bytes=${partSize}-` } : {};
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!allowedHop(target)) throw new Fail('network');
      const response = await fetchImpl(target, { method: 'GET', redirect: 'manual', headers, signal: controller.signal });
      const status_ = response?.status;
      if (status_ >= 300 && status_ < 400) {
        const location = response.headers?.get?.('location');
        try { await response.body?.cancel?.(); } catch (_error) { /* discarded */ }
        if (!location) throw new Fail('network');
        try { target = new URL(location, target).href; } catch (_error) { throw new Fail('network'); }
        continue;
      }
      return response;
    }
    throw new Fail('network');
  }

  // Appends the asset's body to its .part file. Resolves when the file holds `asset.size` bytes.
  async function fetchInto(asset, release, partPath, partSize, base, active) {
    const { controller } = active;
    let timer = setTimeout(() => active.abortWith('network'), RESPONSE_TIMEOUT_MS);
    let response;
    try {
      response = await request(`${DOWNLOAD_PREFIX}${release}/${asset.name}`, partSize, controller);
    } catch (error) {
      if (active.reason) throw new Fail(active.reason);
      throw error instanceof Fail ? error : new Fail('network');
    } finally {
      clearTimeout(timer);
    }
    const discard = async () => { try { await response.body?.cancel?.(); } catch (_error) { /* discarded */ } };
    let start = 0;
    if (response.status === 206 && partSize > 0) {
      const match = CONTENT_RANGE.exec(String(response.headers?.get?.('content-range') || '').trim());
      if (!match || Number(match[1]) !== partSize || Number(match[3]) !== asset.size) {
        await discard();
        throw new Fail('network');
      }
      start = partSize;
    } else if (response.status !== 200) {
      await discard();
      throw new Fail('network');
    }
    const length = response.headers?.get?.('content-length');
    if (length !== null && length !== undefined && length !== ''
      && (!/^\d+$/.test(String(length).trim()) || Number(length) !== asset.size - start)) {
      await discard();
      throw new Fail('size_mismatch');
    }
    if (typeof response.body?.[Symbol.asyncIterator] !== 'function') {
      await discard();
      throw new Fail('network');
    }
    const handle = await openPartial(partPath, start);
    const iterator = response.body[Symbol.asyncIterator]();
    let written = start;
    timer = null;
    const resetInactivity = () => {
      clearTimeout(timer);
      timer = setTimeout(() => active.abortWith('network'), INACTIVITY_MS);
    };
    try {
      resetInactivity();
      for (;;) {
        const next = iterator.next();
        next.catch(() => {});
        let step;
        try {
          step = await raceAbort(next, controller.signal);
        } catch (_error) {
          throw new Fail('network');
        }
        if (step === ABORTED) throw new Fail(active.reason || 'cancelled');
        if (step.done) break;
        const value = step.value;
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (written + buffer.length > asset.size) throw new Fail('size_mismatch');
        resetInactivity();
        for (let offset = 0; offset < buffer.length;) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, written + offset);
          if (!bytesWritten) throw new Fail('network');
          offset += bytesWritten;
        }
        written += buffer.length;
        setState({ receivedBytes: base + written });
      }
      await handle.sync();
    } finally {
      clearTimeout(timer);
      Promise.resolve(iterator.return?.()).catch(() => {});
      await handle.close();
    }
    // A body that ends early is a dropped connection: the bytes stay for a resume.
    if (written !== asset.size) throw new Fail('network');
  }

  async function hashFile(file, signal) {
    const hash = crypto.createHash('sha256');
    const stream = fsImpl.createReadStream(file, { highWaterMark: 1024 * 1024 });
    try {
      for await (const chunk of stream) {
        if (signal.aborted) throw new Fail('cancelled');
        hash.update(chunk);
      }
    } finally {
      stream.destroy();
    }
    return hash.digest('hex');
  }

  async function downloadAsset(asset, release, downloads, base, active) {
    // Keyed by checksum: a part left by an older catalog's same-named asset never resumes into this one.
    const partPath = path.join(downloads, `${asset.sha256.slice(0, 16)}-${asset.name}.part`);
    let partSize = 0;
    try {
      const info = await fsp.lstat(partPath);
      if (!info.isFile()) {
        await removeFile(partPath, { fsImpl });
      } else {
        partSize = info.size;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (partSize > asset.size) {
      await removeFile(partPath, { fsImpl });
      partSize = 0;
    }
    setState({ state: 'downloading', receivedBytes: base + partSize });
    if (partSize < asset.size) await fetchInto(asset, release, partPath, partSize, base, active);
    setState({ state: 'verifying', receivedBytes: base + asset.size });
    if ((await fsp.lstat(partPath)).size !== asset.size) {
      await removeFile(partPath, { fsImpl }).catch(() => {});
      throw new Fail('size_mismatch');
    }
    if (await hashFile(partPath, active.controller.signal) !== asset.sha256) {
      await removeFile(partPath, { fsImpl }).catch(() => {});
      throw new Fail('sha_mismatch');
    }
    return partPath;
  }

  async function renameInto(from, to) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(from, to);
        return;
      } catch (error) {
        if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  }

  async function runJob(data, variant, active) {
    const roots = await realRuntimes();
    const downloads = await plainChild(roots, '.downloads', { create: true });
    const zips = [];
    let base = 0;
    for (const asset of variant.assets) {
      if (read(isLocalOnly, false) === true) throw new Fail('local_only');
      zips.push(await downloadAsset(asset, data.release, downloads, base, active));
      base += asset.size;
    }
    setState({ state: 'extracting' });
    const name = folderName(data, variant);
    const stagingName = `.staging-${name}`;
    // Sweep every staging folder a quit or crash mid-extract left behind (one job runs at a time).
    for (const entry of await fsp.readdir(roots.home).catch(() => [])) {
      if (entry.startsWith('.staging-')) await removeTree(path.join(roots.home, entry), { fsImpl }).catch(() => {});
    }
    const staging = await plainChild(roots, stagingName, { create: true });
    try {
      const budget = { remaining: EXTRACT_FACTOR * variant.totalBytes };
      for (const zipPath of zips) {
        await extractRuntimeZip({ zipPath, destDir: staging, budget, signal: active.controller.signal, fsImpl, platform });
      }
      setState({ state: 'probing' });
      if (typeof validateImpl !== 'function') throw new Fail('probe_failed');
      const binary = path.join(staging, SERVER_NAME);
      let probed = null;
      try {
        if (!(await fsp.lstat(binary)).isFile()) throw new Fail('probe_failed');
        probed = await validateImpl(binary, { fsImpl, platform });
      } catch (_error) { /* a throwing probe fails closed below */ }
      if (!probed || probed.ok !== true || probed.build !== data.build) throw new Fail('probe_failed');
      if (active.controller.signal.aborted) throw new Fail('cancelled');
      const finalPath = path.join(roots.home, name);
      await removeTree(finalPath, { fsImpl });
      await renameInto(staging, finalPath);
    } catch (error) {
      await removeTree(staging, { fsImpl }).catch(() => {});
      // A verified zip that extracts wrong or builds a server that won't start would fail
      // the same way again: delete it (the UI says so). A cancel keeps it for a resume.
      if (['unsafe_entry', 'too_large', 'probe_failed'].includes(reasonOf(error, active))) {
        for (const zipPath of zips) await removeFile(zipPath, { fsImpl }).catch(() => {});
      }
      throw error;
    }
    for (const zipPath of zips) await removeFile(zipPath, { fsImpl }).catch(() => {});
    await fsp.rmdir(downloads).catch(() => {}); // other releases' parts keep it alive
  }

  function reasonOf(error, active) {
    if (active.reason) return active.reason;
    if (error instanceof Fail || /^[a-z][a-z0-9_]{0,39}$/.test(String(error?.reason || ''))) return error.reason;
    return error?.code === 'ENOSPC' ? 'no_space' : 'network';
  }

  async function finishJob(data, variant, active) {
    const fields = { build: data.build, variant: variant.id };
    try {
      await runJob(data, variant, active);
    } catch (error) {
      const reason = reasonOf(error, active);
      if (reason === 'cancelled') {
        setState({ state: 'cancelled' });
        emit('INFO', 'llama.server.runtime_download_cancelled', fields);
      } else {
        setState({ state: 'failed', reason });
        emit('WARN', 'llama.server.runtime_download_failed', { ...fields, reason });
      }
      return;
    }
    try {
      await onReady();
    } catch (_error) { /* the build is installed; the next prepare() finds it */ }
    setState({ state: 'ready' });
    emit('INFO', 'llama.server.runtime_download_ready', fields);
  }

  async function start({ architecture } = {}) {
    if (!read(isEnabled, false)) return { ok: false, reason: 'flag_off' };
    if (read(isLocalOnly, false) === true) return { ok: false, reason: 'local_only' };
    if (job?.running) return { ok: false, reason: 'busy' };
    await warm();
    const data = catalogData();
    const variant = offerFor({ architecture: typeof architecture === 'string' ? architecture : '' }) ? pick(data) : null;
    if (!variant || job?.running) return { ok: false, reason: job?.running ? 'busy' : 'not_offered' };
    const home = runtimesDir();
    const needBytes = Math.ceil(SPACE_FACTOR * variant.totalBytes);
    let freeBytes = null;
    try {
      const stats = await statfsImpl(String(read(userDataPath, '')));
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch (_error) { /* an unreadable volume does not block the download */ }
    if (home && freeBytes !== null && Number.isFinite(freeBytes) && freeBytes < needBytes) {
      return { ok: false, reason: 'no_space', needBytes, freeBytes };
    }
    if (job?.running) return { ok: false, reason: 'busy' };
    const controller = new AbortController();
    const active = {
      controller,
      reason: '',
      abortWith(reason) {
        if (!active.reason) active.reason = reason;
        controller.abort();
      },
    };
    state = { state: 'downloading', build: data.build, receivedBytes: 0, totalBytes: variant.totalBytes };
    emit('INFO', 'llama.server.runtime_download_started', { build: data.build, variant: variant.id });
    job = { running: true, active, promise: null };
    job.promise = finishJob(data, variant, active).finally(() => { job.running = false; });
    return { ok: true, build: data.build };
  }

  function cancel() {
    if (job?.running) job.active.abortWith('cancelled');
    return { ok: true };
  }

  return {
    offerFor,
    start,
    status,
    cancel,
    warm,
    // Resolves when the current job (if any) has finished; tests and shutdown use it.
    settled: () => (job?.promise ? job.promise.then(() => undefined) : Promise.resolve()),
  };
}

module.exports = {
  DEFAULT_CATALOG_PATH,
  createLlamaServerRuntimeDownload,
  loadRuntimeCatalog,
  validateCatalog,
};
