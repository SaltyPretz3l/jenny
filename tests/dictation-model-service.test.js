'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DictationModelService } = require('../services/dictation-model-service');
const {
  DICTATION_MODEL_MANIFEST, DICTATION_MODEL_TOTAL_BYTES, dictationFileRelativePath, dictationFileUrl,
} = require('../services/dictation-model-manifest');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const BODIES = {
  'asr/big.bin': Buffer.alloc(300_000, 7),
  'asr/vocab.txt': Buffer.from('hello vocab\n'),
  'vad/silero.bin': Buffer.alloc(5_000, 3),
};
function makeManifest(bodies = BODIES) {
  return {
    id: 'test-model-1',
    files: Object.entries(bodies).map(([rel, body]) => {
      const [subdir, repoPath] = rel.split('/');
      return { repo: 'owner/repo', revision: 'rev123', repoPath, subdir, bytes: body.length, sha256: sha(body) };
    }),
  };
}
const bodyForUrl = (url, bodies = BODIES) => {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
  return Object.entries(bodies).find(([rel]) => rel.endsWith(`/${name}`))?.[1];
};

// A fetch that serves the fake bodies from huggingface.co, optionally via a CDN redirect.
function fakeFetch({ ignoreRange = false, chunk = 64 * 1024, redirectTo = null, calls = [], onChunk = null,
  bodies = BODIES, corrupt = false } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {}, redirect: init.redirect });
    const host = new URL(url).hostname;
    if (host === 'huggingface.co' && redirectTo && init.redirect === 'manual') {
      return { status: 302, headers: new Map([['location', `${redirectTo}${new URL(url).pathname}`]]), body: null };
    }
    let body = bodyForUrl(url, bodies);
    if (!body) return { status: 404, headers: new Map(), body: null };
    if (corrupt) body = Buffer.alloc(body.length, 1);
    if (init.redirect === 'manual') return { status: 200, headers: new Map(), body: null };
    const range = /^bytes=(\d+)-$/.exec(init.headers?.Range || '');
    let start = 0;
    let status = 200;
    const headers = new Map();
    if (range && !ignoreRange) {
      start = Number(range[1]);
      status = 206;
      headers.set('content-range', `bytes ${start}-${body.length - 1}/${body.length}`);
    }
    const slice = body.subarray(start);
    headers.set('content-length', String(slice.length));
    return {
      status,
      headers,
      body: (async function* generate() {
        for (let offset = 0; offset < slice.length; offset += chunk) {
          if (onChunk) await onChunk(offset);
          yield slice.subarray(offset, offset + chunk);
        }
      }()),
    };
  };
}

const bigFree = async () => ({ bavail: 1e9, bsize: 4096 });
function build(overrides = {}) {
  const userDataPath = createTrackedTempDir('jenny-dictation-');
  const service = new DictationModelService({
    userDataPath, manifest: makeManifest(), fetchImpl: fakeFetch(), statfsImpl: bigFree, ...overrides,
  });
  const root = path.join(userDataPath, 'engines', 'speech');
  return { service, userDataPath, root, finalDir: path.join(root, 'test-model-1'),
    staging: path.join(root, '.staging-test-model-1') };
}
async function runToEnd(service) {
  await service.setup();
  await service.whenIdle();
  return service.getState();
}

test('the pinned manifest carries both repos, exact revisions and sizes that add up', () => {
  assert.equal(DICTATION_MODEL_MANIFEST.id, 'parakeet-tdt-0.6b-v3-int8-8f23f0c');
  assert.equal(DICTATION_MODEL_MANIFEST.repos.asr.revision, '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce');
  assert.equal(DICTATION_MODEL_MANIFEST.repos.vad.revision, 'b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6');
  assert.equal(DICTATION_MODEL_MANIFEST.files.length, 7);
  assert.equal(DICTATION_MODEL_TOTAL_BYTES, DICTATION_MODEL_MANIFEST.files.reduce((sum, f) => sum + f.bytes, 0));
  assert.deepEqual(DICTATION_MODEL_MANIFEST.files.map(dictationFileRelativePath), [
    'asr/encoder-model.int8.onnx', 'asr/decoder_joint-model.int8.onnx', 'asr/nemo128.onnx',
    'asr/vocab.txt', 'asr/config.json', 'vad/silero_vad.onnx', 'vad/config.json']);
  for (const entry of DICTATION_MODEL_MANIFEST.files) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(dictationFileUrl(entry).startsWith(`https://huggingface.co/${entry.repo}/resolve/${entry.revision}/`));
  }
  assert.ok(Object.isFrozen(DICTATION_MODEL_MANIFEST));
});

test('a fresh install downloads, verifies, writes install.json last and reports ready', async () => {
  const { service, finalDir, staging } = build();
  const states = [];
  service.on('changed', (state) => states.push(state.state));
  await service.start();
  assert.equal(service.getState().state, 'not_installed');
  assert.equal(service.getState().modelDir, null);
  const final = await runToEnd(service);
  assert.equal(final.state, 'ready');
  assert.equal(final.modelDir, finalDir);
  assert.equal(Object.hasOwn(service.getPublicState(), 'modelDir'), false, 'change events and IPC results carry no path');
  assert.equal(final.error, null);
  assert.equal(final.downloadedBytes, final.totalBytes);
  assert.ok(states.includes('downloading') && states.includes('verifying'));
  assert.equal(states.at(-1), 'ready');
  for (const [rel, body] of Object.entries(BODIES)) assert.deepEqual(fs.readFileSync(path.join(finalDir, rel)), body);
  const record = JSON.parse(fs.readFileSync(path.join(finalDir, 'install.json'), 'utf8'));
  assert.equal(record.id, 'test-model-1');
  assert.deepEqual(record.revisions, { asr: 'rev123', vad: 'rev123' });
  assert.equal(record.files.length, 3);
  assert.deepEqual(record.files[0], { path: 'asr/big.bin', bytes: 300_000, sha256: sha(BODIES['asr/big.bin']) });
  assert.ok(Number.isFinite(Date.parse(record.installedAt)));
  assert.equal(fs.existsSync(staging), false);
  assert.deepEqual(fs.readdirSync(path.join(finalDir, 'asr')).filter((name) => name.endsWith('.part')), []);
});

test('progress emits are throttled to 250 ms', async () => {
  let clock = 0;
  const { service } = build({ now: () => clock, fetchImpl: fakeFetch({ chunk: 1_000, onChunk: () => { clock += 10; } }) });
  const progress = [];
  service.on('changed', (state) => { if (state.state === 'downloading') progress.push(state.downloadedBytes); });
  await runToEnd(service);
  // ~305 chunks at 10 ms each is ~3 s, so well under 305 progress emits.
  assert.ok(progress.length < 60, `emitted ${progress.length}`);
  assert.ok(progress.length > 3);
});

test('resume sends a Range request from the existing .part and finishes the file', async () => {
  const calls = [];
  const { service, staging } = build({ fetchImpl: fakeFetch({ calls }) });
  const big = BODIES['asr/big.bin'];
  fs.mkdirSync(path.join(staging, 'asr'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'asr', 'big.bin.part'), big.subarray(0, 100_000));
  const final = await runToEnd(service);
  assert.equal(final.state, 'ready');
  const bigCalls = calls.filter((call) => call.url.endsWith('/big.bin') && call.redirect === 'error');
  assert.equal(bigCalls.length, 1);
  assert.equal(bigCalls[0].headers.Range, 'bytes=100000-');
  assert.deepEqual(fs.readFileSync(path.join(service.finalDir, 'asr', 'big.bin')), big);
});

test('a server that ignores Range restarts the file cleanly', async () => {
  const { service, staging } = build({ fetchImpl: fakeFetch({ ignoreRange: true }) });
  const big = BODIES['asr/big.bin'];
  fs.mkdirSync(path.join(staging, 'asr'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'asr', 'big.bin.part'), Buffer.alloc(100_000, 9));
  const final = await runToEnd(service);
  assert.equal(final.state, 'ready');
  assert.equal(final.downloadedBytes, final.totalBytes);
  assert.deepEqual(fs.readFileSync(path.join(service.finalDir, 'asr', 'big.bin')), big);
});

test('a checksum mismatch deletes that .part and fails with checksum_mismatch', async () => {
  const { service, staging, finalDir } = build({ fetchImpl: fakeFetch({ corrupt: true }) });
  const final = await runToEnd(service);
  assert.equal(final.state, 'failed');
  assert.equal(final.error.reason, 'checksum_mismatch');
  assert.equal(final.modelDir, null);
  assert.equal(fs.existsSync(path.join(staging, 'asr', 'big.bin.part')), false);
  assert.equal(fs.existsSync(finalDir), false);
  // A later setup retries from the failed state.
  service.fetchImpl = fakeFetch();
  assert.equal((await runToEnd(service)).state, 'ready');
});

test('a redirect to a host outside the Hugging Face allowlist is rejected', async () => {
  const calls = [];
  const { service } = build({ fetchImpl: fakeFetch({ calls, redirectTo: 'https://evil.example.com' }) });
  const final = await runToEnd(service);
  assert.equal(final.state, 'failed');
  assert.equal(final.error.reason, 'redirect_host_rejected');
  assert.ok(calls.every((call) => new URL(call.url).hostname === 'huggingface.co'));
});

test('a redirect to the Hugging Face CDN is followed and a non-https redirect is rejected', async () => {
  const cdn = build({ fetchImpl: fakeFetch({ redirectTo: 'https://cas-bridge.xethub.hf.co' }) });
  assert.equal((await runToEnd(cdn.service)).state, 'ready');
  const plain = build({ fetchImpl: fakeFetch({ redirectTo: 'http://cas-bridge.xethub.hf.co' }) });
  assert.equal((await runToEnd(plain.service)).error.reason, 'redirect_scheme_rejected');
});

test('cancel keeps the .part files, returns to not_installed and a later setup resumes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let seen = 0;
  const calls = [];
  const { service, staging } = build({ fetchImpl: fakeFetch({ calls, chunk: 50_000,
    onChunk: async (offset) => { seen += 1; if (offset >= 100_000) await gate; } }) });
  await service.setup();
  while (seen < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  const cancelled = service.cancel();
  assert.equal(cancelled.state, 'not_installed');
  assert.equal(cancelled.error, null);
  release();
  await service.whenIdle();
  assert.equal(service.getState().state, 'not_installed');
  const part = path.join(staging, 'asr', 'big.bin.part');
  assert.ok(fs.statSync(part).size > 0 && fs.statSync(part).size < 300_000);
  const kept = fs.statSync(part).size;
  service.fetchImpl = fakeFetch({ calls });
  const final = await runToEnd(service);
  assert.equal(final.state, 'ready');
  assert.ok(calls.some((call) => call.headers.Range === `bytes=${kept}-`));
});

test('a cancel that lands while a finished file is renamed still ends not_installed', async () => {
  const { service } = build();
  const rename = service._renameWithRetry.bind(service);
  service._renameWithRetry = async (from, to) => { service.cancel(); return rename(from, to); };
  const states = [];
  service.on('changed', (state) => states.push(state.state));
  await service.setup();
  await service.whenIdle();
  assert.equal(service.getState().state, 'not_installed', `states seen: ${states.join(' > ')}`);
  assert.equal(service.getState().error, null);
});

test('a cancel after every file verified is refused, so the UI never says not installed over a finished install', async () => {
  const { service } = build();
  const promote = service._promote.bind(service);
  let answered = null;
  service._promote = async (op) => { answered = service.cancel(); return promote(op); };
  await service.setup();
  await service.whenIdle();
  assert.equal(answered.state, 'verifying', 'the cancel is a no-op once promoting');
  assert.equal(service.getState().state, 'ready');
});

test('remove clears the final and staging directories and refuses while downloading', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, finalDir, staging } = build({ fetchImpl: fakeFetch({ chunk: 50_000, onChunk: () => gate }) });
  await service.setup();
  await assert.rejects(service.remove(), { reason: 'download_in_progress' });
  service.cancel();
  release();
  await service.whenIdle();
  assert.ok(fs.existsSync(staging));
  service.fetchImpl = fakeFetch();
  await runToEnd(service);
  assert.equal(service.getState().state, 'ready');
  fs.mkdirSync(staging, { recursive: true });
  const removed = await service.remove();
  assert.equal(removed.state, 'not_installed');
  assert.equal(removed.modelDir, null);
  assert.equal(fs.existsSync(finalDir), false);
  assert.equal(fs.existsSync(staging), false);
});

test('startup detection is ready only for a matching install.json and exact file sizes', async () => {
  const first = build();
  await runToEnd(first.service);
  const again = new DictationModelService({ userDataPath: first.userDataPath, manifest: makeManifest(), statfsImpl: bigFree });
  await again.start();
  assert.equal(again.getState().state, 'ready');
  assert.equal(again.getState().modelDir, first.finalDir);

  fs.appendFileSync(path.join(first.finalDir, 'asr', 'vocab.txt'), 'x');
  const wrongSize = new DictationModelService({ userDataPath: first.userDataPath, manifest: makeManifest() });
  await wrongSize.start();
  assert.equal(wrongSize.getState().state, 'not_installed');
  assert.equal(wrongSize.getState().modelDir, null);

  fs.writeFileSync(path.join(first.finalDir, 'asr', 'vocab.txt'), BODIES['asr/vocab.txt']);
  fs.rmSync(path.join(first.finalDir, 'install.json'));
  const noRecord = new DictationModelService({ userDataPath: first.userDataPath, manifest: makeManifest() });
  await noRecord.start();
  assert.equal(noRecord.getState().state, 'not_installed');
});

test('an install.json for another model is not ready and a stale final dir is replaced on install', async () => {
  const { service, finalDir } = build();
  fs.mkdirSync(path.join(finalDir, 'asr'), { recursive: true });
  fs.writeFileSync(path.join(finalDir, 'stale.txt'), 'old');
  fs.writeFileSync(path.join(finalDir, 'install.json'), JSON.stringify({ id: 'other', files: [] }));
  await service.start();
  assert.equal(service.getState().state, 'not_installed');
  assert.equal((await runToEnd(service)).state, 'ready');
  assert.equal(fs.existsSync(path.join(finalDir, 'stale.txt')), false);
});

test('insufficient disk space fails before any download', async () => {
  const calls = [];
  const { service } = build({ fetchImpl: fakeFetch({ calls }), statfsImpl: async () => ({ bavail: 10, bsize: 4096 }) });
  const final = await runToEnd(service);
  assert.equal(final.state, 'failed');
  assert.equal(final.error.reason, 'insufficient_disk_space');
  assert.equal(calls.length, 0);
});

test('setup is a no-op while downloading or ready, and an invalid manifest is refused', async () => {
  const { service } = build();
  const first = service.setup();
  const second = service.setup();
  await Promise.all([first, second]);
  await service.whenIdle();
  assert.equal(service.getState().state, 'ready');
  const calls = [];
  service.fetchImpl = fakeFetch({ calls });
  await service.setup();
  assert.equal(calls.length, 0);
  assert.throws(() => new DictationModelService({ userDataPath: 'x', manifest: { id: 'a', files: [{}] } }), TypeError);
});

test('wireDictation hangs the service on the backend and bridges changes to the renderer', async () => {
  const { wireDictation } = require('../services/dictation-model-service');
  const userDataPath = createTrackedTempDir('jenny-dictation-wire-');
  const backendService = {};
  const sent = [];
  const service = wireDictation({ backendService, userDataPath, sendBridgeEvent: (...args) => sent.push(args), log: () => {} });
  assert.equal(backendService.dictation, service);
  await service.start();
  service.fetchImpl = fakeFetch();
  service.statfsImpl = bigFree;
  service.cancel();
  assert.deepEqual(sent, []);
  service._set({ state: 'failed', error: { reason: 'download_failed' } });
  assert.equal(sent.at(-1)[0], 'dictation.onChanged');
  assert.equal(sent.at(-1)[1].state, 'failed');
});

test('the download manifest installs exactly the files the sidecar engine requires', () => {
  // sidecar/ai/speech/audio.py REQUIRED_MODEL_FILES is what validate_model_dir checks.
  const source = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'ai', 'speech', 'audio.py'), 'utf8');
  const block = /REQUIRED_MODEL_FILES[^=]*=\s*\{([\s\S]*?)\n\}/.exec(source)[1];
  const required = [];
  for (const [, subdir, names] of block.matchAll(/(ASR|VAD)_SUBDIR:\s*\(([\s\S]*?)\)/g)) {
    for (const [, name] of names.matchAll(/"([^"]+)"/g)) required.push(`${subdir.toLowerCase()}/${name}`);
  }
  assert.deepEqual(DICTATION_MODEL_MANIFEST.files.map(dictationFileRelativePath).sort(), required.sort());
  assert.equal(DICTATION_MODEL_MANIFEST.totalBytes, 672947357);
});
