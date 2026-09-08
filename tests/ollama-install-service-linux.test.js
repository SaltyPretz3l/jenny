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
