const test = require('node:test');
const assert = require('node:assert/strict');
const { holdEventLoopUntilTestsFinish } = require('./helpers/event-loop-hold');

// Production timers in this module are unref'd; see the helper.
holdEventLoopUntilTestsFinish(test);
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { OllamaInstallService } = require('../services/ollama-install-service');

const BYTES = Buffer.from('fake-ollama-installer-payload');
const GOOD_SHA = crypto.createHash('sha256').update(BYTES).digest('hex');

function manifest(overrides = {}) {
  return {
    source: 'ollama.com',
    url: 'https://example.test/OllamaSetup.exe',
    version: '1.2.3',
    minimumSupportedVersion: '1.2.3',
    sizeBytes: BYTES.length,
    sha256: GOOD_SHA,
    license: 'MIT',
    manualFallbackUrl: 'https://ollama.com/download/windows',
    ...overrides,
  };
}

function fetchOnce(bytes, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    headers: {
      get: (key) => (String(key).toLowerCase() === 'content-length' ? String(bytes.length) : null),
    },
    body: (async function* gen() {
      yield bytes;
    })(),
  });
}

function makeService(opts = {}) {
  const fsState = { unlinked: [], written: [] };
  const defaultFsImpl = {
    mkdtempSync() {
      return 'C:/temp/jenny-ollama-test';
    },
    createWriteStream() {
      const chunks = [];
      const stream = {
        chunks,
        write(buf) {
          chunks.push(Buffer.from(buf));
          return true;
        },
        on() {
          return stream;
        },
        end(cb) {
          fsState.written.push(Buffer.concat(chunks));
          if (typeof cb === 'function') cb();
        },
      };
      return stream;
    },
    unlinkSync(p) {
      fsState.unlinked.push(p);
    },
    rmSync(p) {
      fsState.unlinked.push(p);
    },
    existsSync: opts.fileExists || (() => false),
  };
  const fsImpl = opts.fsImpl || defaultFsImpl;

  let spawnCalls = 0;
  const baseSpawn = opts.spawnImpl
    || (() => {
      const child = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('exit', 0));
      return child;
    });
  const spawnImpl = (...args) => {
    spawnCalls += 1;
    return baseSpawn(...args);
  };

  let fetchCalls = 0;
  const fetchImpl = opts.fetchImpl
    ? (...args) => {
      fetchCalls += 1;
      return opts.fetchImpl(...args);
    }
    : null;

  const svc = new OllamaInstallService({
    manifest: opts.manifest || manifest(),
    fetchImpl,
    spawnImpl,
    fsImpl,
    detectImpl: opts.detectImpl || (async () => ({ installed: false })),
    restartImpl: opts.restartImpl,
    delayImpl: async () => {},
    platform: opts.platform || 'win32',
    env: opts.env,
    requestIdProvider: () => 'rid',
    logger: () => {},
    killProcessTreeImpl: opts.killProcessTreeImpl,
    responseStartTimeoutMs: opts.responseStartTimeoutMs,
    downloadInactivityMs: opts.downloadInactivityMs,
    installerTimeoutMs: opts.installerTimeoutMs,
    postInstallReadinessTimeoutMs: opts.postInstallReadinessTimeoutMs,
    terminationTimeoutMs: opts.terminationTimeoutMs,
  });
  return { svc, fsState, getSpawnCalls: () => spawnCalls, getFetchCalls: () => fetchCalls };
}

test('getInstallPlan exposes provenance and is available only when fully pinned on win32', () => {
  const { svc } = makeService();
  const plan = svc.getInstallPlan();
  assert.equal(plan.available, true);
  assert.equal(plan.url, 'https://example.test/OllamaSetup.exe');
  assert.equal(plan.sha256, GOOD_SHA);
  assert.equal(plan.sizeBytes, BYTES.length);
  assert.equal(plan.minimumVersion, '1.2.3');

  const { svc: unpinned } = makeService({ manifest: manifest({ sha256: '' }) });
  assert.equal(unpinned.getInstallPlan().available, false);
  assert.equal(makeService({ manifest: manifest({ url: 'http://example.test/OllamaSetup.exe' }) }).svc
    .getInstallPlan().available, false);
  assert.equal(makeService({ manifest: manifest({ sizeBytes: Number.POSITIVE_INFINITY }) }).svc
    .getInstallPlan().available, false);

  const { svc: notWin } = makeService({ platform: 'linux' });
  assert.equal(notWin.getInstallPlan().available, false);
});

test('manualFallbackUrl is platform-resolved; the manifest Windows URL never leaks off win32', () => {
  const { svc: win } = makeService({ platform: 'win32' });
  assert.equal(win.getInstallPlan().manualFallbackUrl, 'https://ollama.com/download/windows');

  const { svc: mac } = makeService({ platform: 'darwin' });
  assert.equal(mac.getInstallPlan().manualFallbackUrl, 'https://ollama.com/download/mac');

  const { svc: linux } = makeService({ platform: 'linux' });
  assert.equal(linux.getInstallPlan().manualFallbackUrl, 'https://ollama.com/download/linux');

  const { svc: other } = makeService({ platform: 'freebsd' });
  assert.equal(other.getInstallPlan().manualFallbackUrl, 'https://ollama.com/download');

  const { svc: bareWin } = makeService({ platform: 'win32', manifest: manifest({ manualFallbackUrl: '' }) });
  assert.equal(bareWin.getInstallPlan().manualFallbackUrl, 'https://ollama.com/download/windows');
});

test('installOllama requires explicit opt-in', async () => {
  const { svc, getFetchCalls } = makeService({ fetchImpl: fetchOnce(BYTES) });
  const result = await svc.installOllama({ confirmed: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'opt_in_required');
  assert.equal(getFetchCalls(), 0, 'must not download without opt-in');
});

test('installOllama reports not_configured when the manifest is unpinned', async () => {
  const { svc, getFetchCalls } = makeService({
    manifest: manifest({ sha256: '' }),
    fetchImpl: fetchOnce(BYTES),
  });
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'not_configured');
  assert.equal(getFetchCalls(), 0);
  assert.match(result.manualFallbackUrl, /ollama\.com/);
});

test('installOllama short-circuits when Ollama is already installed (no download)', async () => {
  const { svc, getFetchCalls, getSpawnCalls } = makeService({
    fetchImpl: fetchOnce(BYTES),
    detectImpl: async () => ({ installed: true, versionSupported: true }),
  });
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'already_installed');
  assert.equal(getFetchCalls(), 0);
  assert.equal(getSpawnCalls(), 0);
});

test('installOllama upgrades an installed runtime when version policy says it is outdated', async () => {
  let detectCalls = 0;
  let restartCalls = 0;
  const { svc, getFetchCalls, getSpawnCalls } = makeService({
    fetchImpl: fetchOnce(BYTES),
    detectImpl: async () => {
      detectCalls += 1;
      return detectCalls === 1
        ? { installed: true, version: '0.20.4', versionSupported: false, upgradeRequired: true }
        : {
          installed: true,
          running: true,
          version: '1.2.3',
          versionSupported: true,
          upgradeRequired: false,
        };
    },
    restartImpl: async () => {
      restartCalls += 1;
      return { ok: true, running: true };
    },
  });
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'installed');
  assert.equal(getFetchCalls(), 1);
  assert.equal(getSpawnCalls(), 1);
  assert.equal(restartCalls, 1);
});

test('installOllama accepts an unverified version only after a serving probe', async () => {
  const { svc: stopped, getFetchCalls: stoppedFetchCalls } = makeService({
    fetchImpl: fetchOnce(BYTES),
    detectImpl: async () => ({
      installed: true,
      versionStatus: 'unverified',
      versionSupported: null,
      running: false,
    }),
  });
  const stoppedResult = await stopped.installOllama({ confirmed: true });
  assert.notEqual(stoppedResult.code, 'already_installed');
  assert.equal(stoppedFetchCalls(), 1);

  const { svc: serving, getFetchCalls: servingFetchCalls } = makeService({
    fetchImpl: fetchOnce(BYTES),
    detectImpl: async () => ({
      installed: true,
      versionStatus: 'unverified',
      versionSupported: null,
      running: true,
    }),
  });
  const servingResult = await serving.installOllama({ confirmed: true });
  assert.equal(servingResult.code, 'already_installed');
  assert.equal(servingFetchCalls(), 0);
});

test('installOllama happy path: download -> verify -> install -> completed', async () => {
  let detectCalls = 0;
  const phases = [];
  const { svc, getSpawnCalls } = makeService({
    fetchImpl: fetchOnce(BYTES),
    detectImpl: async () => {
      detectCalls += 1;
      return {
        installed: detectCalls > 1,
        running: detectCalls > 1,
        versionSupported: detectCalls > 1,
      };
    },
  });
  svc.on('install-progress', (p) => phases.push(p.phase));
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'installed');
  assert.equal(getSpawnCalls(), 1);
  assert.ok(phases.includes('downloading'));
  assert.equal(phases.at(-1), 'completed');
});

test('installOllama prepends the known Ollama install dir to PATH before the post-install re-probe', async () => {
  let detectCalls = 0;
  let pathAtSecondDetect = '';
  const env = { PATH: 'C:/Windows/system32', LOCALAPPDATA: 'C:/Users/x/AppData/Local', ProgramFiles: 'C:/Program Files' };
  const { svc } = makeService({
    fetchImpl: fetchOnce(BYTES),
    env,
    // Only the LOCALAPPDATA Programs/Ollama candidate "exists" on disk.
    fileExists: (candidate) => /Programs[\\/]Ollama[\\/]?$/.test(candidate) || /Programs[\\/]Ollama$/.test(candidate),
    detectImpl: async () => {
      detectCalls += 1;
      if (detectCalls > 1) {
        pathAtSecondDetect = env.PATH;
      }
      return {
        installed: detectCalls > 1,
        running: detectCalls > 1,
        versionSupported: detectCalls > 1,
      };
    },
  });
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'installed');
  assert.ok(
    pathAtSecondDetect.includes('Programs') && pathAtSecondDetect.includes('Ollama'),
    `expected the Ollama install dir to be prepended to PATH before the re-probe, got: ${pathAtSecondDetect}`
  );
  assert.ok(pathAtSecondDetect.includes('C:/Windows/system32'), 'must preserve the existing PATH entries');
});

test('installOllama does not fail the install when the PATH prepend has nothing to add', async () => {
  let detectCalls = 0;
  const { svc } = makeService({
    fetchImpl: fetchOnce(BYTES),
    env: { PATH: 'C:/Windows/system32' },
    fileExists: () => false,
    detectImpl: async () => {
      detectCalls += 1;
      return {
        installed: detectCalls > 1,
        running: detectCalls > 1,
        versionSupported: detectCalls > 1,
      };
    },
  });
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'installed');
});

test('installOllama fails closed on hash mismatch and never runs the installer', async () => {
  const { svc, fsState, getSpawnCalls } = makeService({
    manifest: manifest({ sha256: 'deadbeef'.repeat(8) }),
    fetchImpl: fetchOnce(BYTES),
  });
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'hash_mismatch');
  assert.equal(getSpawnCalls(), 0, 'must not spawn installer on hash mismatch');
  assert.equal(fsState.unlinked.length, 1, 'temp installer must be deleted');
});

test('installOllama reports installer_failed on a non-zero exit', async () => {
  const { svc } = makeService({
    fetchImpl: fetchOnce(BYTES),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('exit', 2));
      return child;
    },
  });
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'installer_failed');
  assert.match(result.manualFallbackUrl, /ollama\.com/);
});

test('installOllama reports download_failed on a bad HTTP response', async () => {
  const { svc, getSpawnCalls } = makeService({
    fetchImpl: fetchOnce(BYTES, { ok: false, status: 404 }),
  });
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'download_failed');
  assert.equal(getSpawnCalls(), 0);
});

test('installOllama honors write-stream backpressure during download', async () => {
  const chunks = [];
  let drained = false;
  let detectCalls = 0;
  const stream = new EventEmitter();
  stream.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    if (!drained) {
      drained = true;
      setImmediate(() => stream.emit('drain'));
      return false;
    }
    return true;
  };
  stream.end = (callback) => callback?.();
  const { svc } = makeService({
    fetchImpl: fetchOnce(BYTES),
    fsImpl: {
      mkdtempSync: () => 'C:/temp/jenny-ollama-backpressure',
      createWriteStream: () => stream,
      unlinkSync() {},
      rmSync() {},
      existsSync: () => false,
    },
    detectImpl: async () => {
      detectCalls += 1;
      return {
        installed: detectCalls > 1,
        running: detectCalls > 1,
        versionSupported: detectCalls > 1,
      };
    },
  });

  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'completed');
  assert.deepEqual(Buffer.concat(chunks), BYTES);
});

test('cancelOllamaInstall aborts an in-flight download and emits cancelled', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let onFirstChunk;
  const firstChunk = new Promise((r) => {
    onFirstChunk = r;
  });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(BYTES.length) },
    body: (async function* gen() {
      yield Buffer.from('part-1');
      onFirstChunk();
      await gate;
      yield Buffer.from('part-2');
    })(),
  });
  const { svc, getSpawnCalls } = makeService({ fetchImpl });
  const pending = svc.installOllama({ confirmed: true, requestId: 'rid' });
  await firstChunk;
  let cancelSettled = false;
  const cancellation = svc.cancelOllamaInstall({ requestId: 'rid' }).then((result) => {
    cancelSettled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelSettled, false, 'cancellation must wait for the network reader to settle');
  release();
  const cancelResult = await cancellation;
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.termination_confirmed, true);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(getSpawnCalls(), 0, 'cancelled download must not reach the installer');
});

test('installOllama coalesces duplicate active request ids', async () => {
  let releaseFetch;
  const fetchImpl = () => new Promise((resolve) => {
    releaseFetch = () => resolve({
      ok: true,
      status: 200,
      headers: { get: () => String(BYTES.length) },
      body: (async function* body() { yield BYTES; })(),
    });
  });
  const { svc, getFetchCalls } = makeService({ fetchImpl });
  const first = svc.installOllama({ confirmed: true, requestId: 'same-request' });
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await svc.installOllama({ confirmed: true, requestId: 'same-request' });

  assert.equal(duplicate.requestId, 'same-request');
  assert.equal(duplicate.status, 'running');
  assert.equal(getFetchCalls(), 1);

  releaseFetch();
  await first;
});

test('installOllama adopts one global operation across different request ids', async () => {
  let releaseFetch;
  const { svc, getFetchCalls } = makeService({
    fetchImpl: () => new Promise((resolve) => {
      releaseFetch = () => resolve({
        ok: true,
        status: 200,
        headers: { get: () => String(BYTES.length) },
        body: (async function* body() { yield BYTES; })(),
      });
    }),
  });
  const first = svc.installOllama({ confirmed: true, requestId: 'first' });
  await new Promise((resolve) => setImmediate(resolve));
  const adopted = await svc.installOllama({ confirmed: true, requestId: 'second' });
  assert.equal(adopted.requestId, 'first');
  assert.equal(getFetchCalls(), 1);
  releaseFetch();
  await first;
});

test('installOllama aborts when streamed bytes exceed pinned provenance', async () => {
  const { svc, getSpawnCalls } = makeService({
    fetchImpl: fetchOnce(Buffer.concat([BYTES, Buffer.from('overflow')])),
  });
  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'byte_overflow');
  assert.equal(getSpawnCalls(), 0);
});

test('installOllama fails visibly when the download becomes inactive', async () => {
  const { svc, getSpawnCalls } = makeService({
    downloadInactivityMs: 5,
    fetchImpl: async (_url, { signal } = {}) => ({
      ok: true,
      status: 200,
      headers: { get: () => String(BYTES.length) },
      body: {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            }),
          };
        },
      },
    }),
  });

  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'download_inactivity');
  assert.equal(getSpawnCalls(), 0);
});

test('cancelOllamaInstall reports unconfirmed cancellation when response abort does not settle', async () => {
  const { svc } = makeService({
    fetchImpl: () => new Promise(() => {}),
    terminationTimeoutMs: 5,
  });
  void svc.installOllama({ confirmed: true, requestId: 'stuck-response' });
  await new Promise((resolve) => setImmediate(resolve));

  const result = await svc.cancelOllamaInstall({ requestId: 'stuck-response' });
  assert.equal(result.cancelled, false);
  assert.equal(result.termination_confirmed, false);
  assert.equal(result.code, 'termination_failed');
});

test('cancelOllamaInstall exposes failed installer-tree termination', async () => {
  const child = new EventEmitter();
  child.pid = 9192;
  child.kill = () => {};
  const { svc, getSpawnCalls } = makeService({
    fetchImpl: fetchOnce(BYTES),
    spawnImpl: () => child,
    killProcessTreeImpl: async () => ({ terminated: false }),
    terminationTimeoutMs: 5,
  });
  void svc.installOllama({ confirmed: true, requestId: 'stuck-installer' });
  while (getSpawnCalls() === 0) await new Promise((resolve) => setImmediate(resolve));

  const result = await svc.cancelOllamaInstall({ requestId: 'stuck-installer' });
  assert.equal(result.cancelled, false);
  assert.equal(result.termination_confirmed, false);
  assert.equal(result.code, 'termination_failed');
});

test('installOllama bounds response start and installer execution', async () => {
  const responseTimeout = makeService({
    fetchImpl: () => new Promise(() => {}),
    responseStartTimeoutMs: 5,
  });
  assert.equal((await responseTimeout.svc.installOllama({ confirmed: true })).code, 'response_timeout');

  const installerTimeout = makeService({
    fetchImpl: fetchOnce(BYTES),
    installerTimeoutMs: 5,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 9191;
      child.kill = () => {};
      return child;
    },
    killProcessTreeImpl: async () => ({ terminated: true }),
  });
  const result = await installerTimeout.svc.installOllama({ confirmed: true });
  assert.equal(result.code, 'installer_timeout');
  assert.match(result.error, /timed out/i);
});

test('installer timeout reports termination failure when the owned tree cannot be confirmed stopped', async () => {
  const { svc } = makeService({
    fetchImpl: fetchOnce(BYTES),
    installerTimeoutMs: 5,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 9292;
      child.kill = () => {};
      return child;
    },
    killProcessTreeImpl: async () => ({ terminated: false }),
  });

  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.code, 'termination_failed');
  assert.match(result.summary, /could not be confirmed stopped/i);
});

test('post-install readiness is bounded when detection never settles', async () => {
  const { svc } = makeService({
    fetchImpl: fetchOnce(BYTES),
    detectImpl: () => new Promise(() => {}),
    postInstallReadinessTimeoutMs: 5,
  });

  const result = await svc.installOllama({ confirmed: true });
  assert.equal(result.code, 'installed_unverified');
});

test('disposeActiveInstalls drains the single canonical install operation', async () => {
  const service = new OllamaInstallService({
    manifest: manifest(),
    platform: 'win32',
    fetchImpl: (_url, { signal } = {}) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    detectImpl: async () => ({ installed: false }),
    terminationTimeoutMs: 20,
  });
  const events = [];
  service.on('install-progress', (payload) => events.push(payload));

  // Not awaited: both callers adopt the same canonical install operation.
  service.installOllama({ confirmed: true, requestId: 'reap-a' });
  service.installOllama({ confirmed: true, requestId: 'reap-b' });
  assert.equal(service._active.size, 1);

  const reaped = await service.disposeActiveInstalls();

  assert.equal(reaped, 1, 'the canonical in-flight install must be reaped');
  assert.equal(service._active.size, 0);
  const cancelled = events.filter((p) => p.status === 'cancelled');
  assert.equal(cancelled.length, 1, 'the canonical install emits one terminal cancellation');
  assert.equal(await service.disposeActiveInstalls(), 0, 'a second reap is a no-op');
});
