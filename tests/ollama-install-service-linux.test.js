'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { holdEventLoopUntilTestsFinish } = require('./helpers/event-loop-hold');

holdEventLoopUntilTestsFinish(test);

const { OllamaInstallService } = require('../services/ollama-install-service');

const BYTES = Buffer.from('fake-linux-ollama-archive');
const SHA256 = crypto.createHash('sha256').update(BYTES).digest('hex');
const VERSION = '1.2.3';

function fetchOnce(bytes = BYTES) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.length) },
    body: (async function* body() { yield bytes; })(),
  });
}

function probeSpawn(output, exitCode = 1) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.end(output);
      child.stdout.end();
      setImmediate(() => child.emit('close', exitCode));
    });
    return child;
  };
}

function linuxManifest() {
  return {
    minimumSupportedVersion: VERSION,
    license: 'MIT',
    platforms: {
      linux: {
        x64: {
          url: 'https://example.test/ollama-linux-amd64.tar.zst',
          version: VERSION,
          sizeBytes: BYTES.length,
          sha256: SHA256,
          format: 'tar.zst',
          manualFallbackUrl: 'https://ollama.com/download/linux',
        },
      },
    },
  };
}

function createHarness(root, overrides = {}) {
  const downloadsDir = path.join(root, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const env = { XDG_DATA_HOME: root, PATH: '' };
  let detectCalls = 0;
  let restartCalls = 0;
  const service = new OllamaInstallService({
    manifest: linuxManifest(),
    platform: 'linux',
    arch: 'x64',
    env,
    fsImpl: fs,
    tmpDirProvider: () => downloadsDir,
    fetchImpl: fetchOnce(),
    probePortImpl: async () => ({ state: 'free', port: 11434 }),
    extractImpl: async ({ destinationDir, onProgress }) => {
      fs.mkdirSync(path.join(destinationDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(destinationDir, 'bin', 'ollama'), 'fake binary');
      onProgress({ compressedBytes: Math.floor(BYTES.length / 2) });
      onProgress({ compressedBytes: BYTES.length });
    },
    spawnImpl: probeSpawn(`Warning: client version is ${VERSION}`, 1),
    detectImpl: async () => {
      detectCalls += 1;
      return detectCalls === 1
        ? { installed: false }
        : { installed: true, running: true, versionSupported: true };
    },
    restartImpl: async () => {
      restartCalls += 1;
      return { ok: true };
    },
    delayImpl: async () => {},
    requestIdProvider: () => 'linux-install',
    ...overrides,
  });
  return { service, env, getRestartCalls: () => restartCalls };
}

function installRoot(root) {
  return path.posix.join(root, 'jenny', 'ollama');
}

function siblingArtifacts(root) {
  const parent = path.dirname(installRoot(root));
  return fs.existsSync(parent)
    ? fs.readdirSync(parent).filter((name) => name.startsWith('.ollama.staging-') || name.includes('.previous-'))
    : [];
}

test('linux archive install verifies, publishes, restarts, and re-probes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-install-success-'));
  try {
    const { service, env, getRestartCalls } = createHarness(root);
    const phases = [];
    service.on('install-progress', (progress) => phases.push(progress.phase));

    const result = await service.installOllama({ confirmed: true });

    assert.equal(result.code, 'installed');
    assert.equal(fs.existsSync(path.join(installRoot(root), 'bin', 'ollama')), true);
    assert.deepEqual(siblingArtifacts(root), []);
    assert.equal(getRestartCalls(), 1);
    assert.equal(env.PATH.split(path.delimiter)[0], path.posix.join(installRoot(root), 'bin'));
    for (const phase of ['downloading', 'verifying', 'installing', 'restarting']) {
      assert.equal(phases.includes(phase), true, `missing ${phase} phase`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linux archive install atomically replaces an existing managed install', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-install-replace-'));
  try {
    const marker = path.join(installRoot(root), 'marker.txt');
    fs.mkdirSync(installRoot(root), { recursive: true });
    fs.writeFileSync(marker, 'old install');

    const { service } = createHarness(root);
    const result = await service.installOllama({ confirmed: true });

    assert.equal(result.code, 'installed');
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(siblingArtifacts(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linux archive install preserves the existing install when the binary version mismatches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-install-mismatch-'));
  try {
    const marker = path.join(installRoot(root), 'marker.txt');
    fs.mkdirSync(installRoot(root), { recursive: true });
    fs.writeFileSync(marker, 'old install');
    const { service } = createHarness(root, {
      spawnImpl: probeSpawn('client version is 9.9.9', 0),
    });

    const result = await service.installOllama({ confirmed: true });

    assert.equal(result.code, 'binary_probe_failed');
    assert.equal(fs.existsSync(marker), true);
    assert.deepEqual(siblingArtifacts(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linux archive install maps extractor failures and leaves the existing install untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-install-extract-'));
  try {
    const marker = path.join(installRoot(root), 'marker.txt');
    fs.mkdirSync(installRoot(root), { recursive: true });
    fs.writeFileSync(marker, 'old install');
    const { service } = createHarness(root, {
      extractImpl: async () => {
        const error = new Error('bad');
        error.code = 'archive_unsafe_path';
        error.entry = '../x';
        throw error;
      },
    });

    const result = await service.installOllama({ confirmed: true });

    assert.equal(result.code, 'extract_failed');
    assert.match(result.error, /archive_unsafe_path/);
    assert.equal(fs.existsSync(marker), true);
    assert.deepEqual(siblingArtifacts(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linux archive install cancels during extraction and removes staging', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-install-cancel-'));
  try {
    let extractionStarted;
    const started = new Promise((resolve) => { extractionStarted = resolve; });
    let releaseExtraction;
    const extractionGate = new Promise((resolve) => { releaseExtraction = resolve; });
    const { service } = createHarness(root, {
      extractImpl: async ({ isCancelled }) => {
        extractionStarted();
        await extractionGate;
        if (isCancelled()) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      },
    });
    const installation = service.installOllama({ confirmed: true, requestId: 'cancel-extract' });
    await started;

    const cancellation = service.cancelOllamaInstall({ requestId: 'cancel-extract' });
    releaseExtraction();
    const result = await installation;
    const cancelResult = await cancellation;

    assert.equal(result.status, 'cancelled');
    assert.equal(cancelResult.cancelled, true);
    assert.deepEqual(siblingArtifacts(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linux archive install restores the existing install when publish fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-install-publish-'));
  try {
    const marker = path.join(installRoot(root), 'marker.txt');
    fs.mkdirSync(installRoot(root), { recursive: true });
    fs.writeFileSync(marker, 'old install');
    const fsImpl = new Proxy(fs, {
      get(target, property) {
        if (property !== 'renameSync') return target[property];
        return (source, destination) => {
          if (path.basename(source).startsWith('.ollama.staging-') && destination === installRoot(root)) {
            throw new Error('injected publish failure');
          }
          return target.renameSync(source, destination);
        };
      },
    });
    const { service } = createHarness(root, { fsImpl });

    const result = await service.installOllama({ confirmed: true });

    assert.equal(result.code, 'publish_failed');
    assert.equal(fs.existsSync(marker), true);
    assert.deepEqual(siblingArtifacts(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linux archive install refuses cancellation once the archive is published', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-install-late-cancel-'));
  try {
    let restartStarted;
    const started = new Promise((resolve) => { restartStarted = resolve; });
    let releaseRestart;
    const restartGate = new Promise((resolve) => { releaseRestart = resolve; });
    const { service } = createHarness(root, {
      restartImpl: async () => {
        restartStarted();
        await restartGate;
        return { ok: true };
      },
    });
    const installation = service.installOllama({ confirmed: true, requestId: 'late-cancel' });
    await started;

    const cancelResult = await service.cancelOllamaInstall({ requestId: 'late-cancel' });
    releaseRestart();
    const result = await installation;

    assert.equal(cancelResult.cancelled, false);
    assert.equal(cancelResult.code, 'already_published');
    assert.equal(cancelResult.request_id, 'late-cancel');
    assert.equal(result.status, 'completed');
    assert.equal(result.code, 'installed');
    assert.equal(fs.existsSync(path.join(installRoot(root), 'bin', 'ollama')), true);
    assert.deepEqual(siblingArtifacts(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function parentDir(root) {
  return path.dirname(installRoot(root));
}

function makeDirWithMarker(dir, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), content);
}

test('reconcileArchiveInstall restores the newest previous install when the live directory is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-reconcile-restore-'));
  try {
    const parent = parentDir(root);
    makeDirWithMarker(path.join(parent, 'ollama.previous-100'), 'older');
    makeDirWithMarker(path.join(parent, 'ollama.previous-200'), 'newest');
    const logs = [];
    const { service } = createHarness(root, { logger: (level, event) => logs.push(event) });

    service.reconcileArchiveInstall();

    assert.equal(fs.readFileSync(path.join(installRoot(root), 'marker.txt'), 'utf8'), 'newest');
    assert.deepEqual(siblingArtifacts(root), []);
    assert.equal(logs.includes('ollama_install.previous_restored'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reconcileArchiveInstall removes stale previous and staging directories beside a live install', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-reconcile-stale-'));
  try {
    const parent = parentDir(root);
    makeDirWithMarker(installRoot(root), 'live');
    makeDirWithMarker(path.join(parent, 'ollama.previous-100'), 'stale');
    makeDirWithMarker(path.join(parent, '.ollama.staging-abc123'), 'abandoned');
    // Names outside the exact patterns are never touched.
    makeDirWithMarker(path.join(parent, 'ollama.previous-keep'), 'not digits');
    makeDirWithMarker(path.join(parent, 'other.previous-100'), 'other install');
    fs.writeFileSync(path.join(parent, 'ollama.previous-300'), 'a file, not a directory');
    // A link that matches the pattern is left alone and its target is not followed.
    const outside = path.join(root, 'outside');
    makeDirWithMarker(outside, 'outside data');
    fs.symlinkSync(outside, path.join(parent, '.ollama.staging-link'), 'junction');
    const { service } = createHarness(root);

    service.reconcileArchiveInstall();

    assert.equal(fs.readFileSync(path.join(installRoot(root), 'marker.txt'), 'utf8'), 'live');
    assert.deepEqual(fs.readdirSync(parent).sort(), [
      '.ollama.staging-link',
      'ollama',
      'ollama.previous-300',
      'ollama.previous-keep',
      'other.previous-100',
    ]);
    assert.equal(fs.readFileSync(path.join(outside, 'marker.txt'), 'utf8'), 'outside data');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reconcileArchiveInstall leaves the staging directory of an install that is running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-reconcile-active-'));
  try {
    const parent = parentDir(root);
    makeDirWithMarker(path.join(parent, '.ollama.staging-stale1'), 'abandoned');
    let duringInstall = null;
    const { service } = createHarness(root, {
      extractImpl: async ({ destinationDir }) => {
        fs.mkdirSync(path.join(destinationDir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(destinationDir, 'bin', 'ollama'), 'fake binary');
        service.reconcileArchiveInstall();
        duringInstall = fs.readdirSync(parent).filter((name) => name.startsWith('.ollama.staging-'));
      },
    });

    const result = await service.installOllama({ confirmed: true });

    assert.equal(result.code, 'installed');
    // The abandoned directory went at the start of the install; only the live staging remained mid-install.
    assert.equal(duringInstall.length, 1);
    assert.notEqual(duringInstall[0], '.ollama.staging-stale1');
    assert.deepEqual(siblingArtifacts(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linux archive install recovers an interrupted publish before staging a new install', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-reconcile-install-'));
  try {
    const parent = parentDir(root);
    makeDirWithMarker(path.join(parent, 'ollama.previous-100'), 'interrupted');
    let liveAtExtract = null;
    const { service } = createHarness(root, {
      extractImpl: async ({ destinationDir }) => {
        liveAtExtract = fs.existsSync(path.join(installRoot(root), 'marker.txt'));
        fs.mkdirSync(path.join(destinationDir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(destinationDir, 'bin', 'ollama'), 'fake binary');
      },
    });

    const result = await service.installOllama({ confirmed: true });

    assert.equal(result.code, 'installed');
    assert.equal(liveAtExtract, true);
    assert.deepEqual(siblingArtifacts(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reconcileArchiveInstall is a no-op off the Linux archive plan and never throws', () => {
  const idleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-reconcile-noop-'));
  for (const platform of ['win32', 'darwin']) {
    const touched = [];
    const fsImpl = new Proxy(fs, {
      get(target, property) {
        touched.push(String(property));
        return target[property];
      },
    });
    const { service } = createHarness(idleRoot, { platform, fsImpl });
    touched.length = 0;
    assert.doesNotThrow(() => service.reconcileArchiveInstall());
    assert.deepEqual(touched, [], `${platform} must not touch the filesystem`);
  }
  fs.rmSync(idleRoot, { recursive: true, force: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-reconcile-throws-'));
  try {
    const fsImpl = new Proxy(fs, {
      get(target, property) {
        if (property === 'readdirSync' || property === 'lstatSync') {
          return () => { throw new Error('injected fs failure'); };
        }
        return target[property];
      },
    });
    const { service } = createHarness(root, { fsImpl });
    assert.doesNotThrow(() => service.reconcileArchiveInstall());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux install refuses occupied or unknown ports before temporary files or download', async () => {
  for (const state of ['occupied', 'unknown']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-port-guard-'));
    try {
      let fetched = false;
      let temporary = false;
      const { service } = createHarness(root, {
        detectImpl: async () => ({ installed: true, running: false, upgradeRequired: false }),
        probePortImpl: async () => ({ state, port: 11434 }),
        fetchImpl: async () => { fetched = true; throw new Error('must not download'); },
        tmpDirProvider: () => { temporary = true; return root; },
      });
      const result = await service.installOllama({ confirmed: true });
      assert.equal(result.status, 'failed');
      assert.equal(result.code, state === 'occupied' ? 'port_held_external' : 'port_state_unknown');
      assert.equal(fetched, false);
      assert.equal(temporary, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('Linux install restarts Jenny\'s released engine after any unfinished outcome, once after success', async () => {
  for (const [label, overrides, expected] of [
    ['download failure', { fetchImpl: async () => { throw new Error('offline'); } }, 'failed'],
    ['occupied port', { probePortImpl: async () => ({ state: 'occupied', port: 11434 }) }, 'failed'],
    ['success', {}, 'completed'],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-release-'));
    try {
      let released = 0;
      const { service, getRestartCalls } = createHarness(root, {
        releaseOwnedImpl: async () => { released++; return true; }, ...overrides,
      });
      const result = await service.installOllama({ confirmed: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(result.status, expected, label);
      assert.equal(released, 1, label);
      assert.equal(getRestartCalls(), 1, label);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a cancel that outlives the pending engine release still restores Jenny\'s engine exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-late-release-'));
  try {
    let finishRelease;
    let probed = false;
    const { service, getRestartCalls } = createHarness(root, {
      terminationTimeoutMs: 5,
      releaseOwnedImpl: () => new Promise((resolve) => { finishRelease = resolve; }),
      probePortImpl: async () => { probed = true; return { state: 'free', port: 11434 }; },
    });
    const install = service.installOllama({ confirmed: true });
    while (!finishRelease) await new Promise((resolve) => setImmediate(resolve));
    const cancel = await service.cancelOllamaInstall({ requestId: 'linux-install' });
    assert.equal(cancel.code, 'termination_failed');
    assert.equal(getRestartCalls(), 0, 'nothing was released yet');
    // The operation keeps its lifecycle latch while Jenny's engine is still being stopped.
    const retry = await service.installOllama({ confirmed: true, requestId: 'second' });
    assert.equal(retry.requestId, 'linux-install');
    finishRelease(true);
    const result = await install;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.status, 'failed');
    assert.equal(getRestartCalls(), 1);
    assert.equal(probed, false, 'a finished operation does not continue into the port probe');
    await service.cancelOllamaInstall({ requestId: 'linux-install' });
    assert.equal(getRestartCalls(), 1);
    assert.equal((await service.installOllama({ confirmed: true, requestId: 'third' })).requestId, 'third');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cancel whose release settles before the deadline keeps retries coalesced until restoration settles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linux-early-release-'));
  try {
    let finishRelease;
    let finishRestart;
    let restartCalls = 0;
    const { service } = createHarness(root, {
      terminationTimeoutMs: 60_000,
      releaseOwnedImpl: () => new Promise((resolve) => { finishRelease = resolve; }),
      restartImpl: () => {
        restartCalls += 1;
        return new Promise((resolve) => { finishRestart = resolve; });
      },
    });
    const install = service.installOllama({ confirmed: true });
    while (!finishRelease) await new Promise((resolve) => setImmediate(resolve));
    const cancel = service.cancelOllamaInstall({ requestId: 'linux-install' });
    finishRelease(true);
    const result = await install;
    assert.equal(result.status, 'cancelled');
    assert.equal((await cancel).code, 'cancelled');
    assert.equal(restartCalls, 1);
    // The terminal response is published, but restoration of Jenny's engine still owns the lifecycle.
    for (const requestId of ['second', 'third']) {
      assert.equal((await service.installOllama({ confirmed: true, requestId })).requestId, 'linux-install');
    }
    finishRestart({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restartCalls, 1);
    assert.equal((await service.installOllama({ confirmed: true, requestId: 'fourth' })).requestId, 'fourth');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
