'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { OllamaInstallService } = require('../services/ollama-install-service');

const INSTALLER_BYTES = Buffer.from('installer');
const INSTALLER_SHA = crypto.createHash('sha256').update(INSTALLER_BYTES).digest('hex');

test('cancellation during reprobe does not terminate the exited installer child', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.kill = () => {};
  let detectCalls = 0;
  let enterReprobe;
  const reprobeEntered = new Promise((resolve) => { enterReprobe = resolve; });
  let releaseReprobe;
  const reprobeGate = new Promise((resolve) => { releaseReprobe = resolve; });
  let terminationCalls = 0;
  const fsImpl = {
    mkdtempSync: () => 'C:/temp/jenny-ollama-regression',
    createWriteStream() {
      const chunks = [];
      const stream = {
        write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
        on() { return stream; },
        end(callback) { callback?.(); },
      };
      return stream;
    },
    rmSync() {},
    existsSync: () => false,
  };
  const service = new OllamaInstallService({
    manifest: {
      url: 'https://example.test/OllamaSetup.exe',
      version: '1.2.3',
      minimumSupportedVersion: '1.2.3',
      sizeBytes: INSTALLER_BYTES.length,
      sha256: INSTALLER_SHA,
      manualFallbackUrl: 'https://ollama.com/download/windows',
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(INSTALLER_BYTES.length) },
      body: (async function* body() { yield INSTALLER_BYTES; })(),
    }),
    spawnImpl: () => {
      setImmediate(() => child.emit('exit', 0));
      return child;
    },
    fsImpl,
    detectImpl: async () => {
      detectCalls += 1;
      if (detectCalls === 1) return { installed: false };
      enterReprobe();
      return reprobeGate;
    },
    delayImpl: async () => {},
    platform: 'win32',
    requestIdProvider: () => 'reprobe-cancel',
    killProcessTreeImpl: async () => {
      terminationCalls += 1;
      return { terminated: true };
    },
    postInstallReadinessTimeoutMs: 1000,
    terminationTimeoutMs: 1000,
  });

  const installation = service.installOllama({ confirmed: true, requestId: 'reprobe-cancel' });
  await reprobeEntered;
  const cancellation = service.cancelOllamaInstall({ requestId: 'reprobe-cancel' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminationCalls, 0);
  releaseReprobe({ installed: false });

  const cancelResult = await cancellation;
  assert.equal(cancelResult.cancelled, true);
  assert.equal((await installation).status, 'cancelled');
  assert.equal(terminationCalls, 0);
});
