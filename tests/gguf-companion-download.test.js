'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGgufCompanionService, PARTIAL_SUFFIX } = require('../services/gguf-companion-download');
const { registerGgufCompanionIpcHandlers } = require('../services/main/gguf-companion-ipc-handlers');

const DRAFTER_BODY = Buffer.from('drafter-bytes-0123456789');
const PROJECTOR_BODY = Buffer.from('projector-bytes-abcdef');
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const REV = 'a'.repeat(40);

function catalog({ gain = undefined, projector = true } = {}) {
  return {
    schemaVersion: 1,
    entries: [{
      id: 'qwen3.8-27b',
      family: 'qwen38',
      match: { architecture: 'qwen35', baseModelRepos: ['Qwen/Qwen3.8-27B'], basenames: ['Qwen3.8-27B'], fileFamilies: ['qwen3.8-27b'] },
      drafter: {
        repo: 'unsloth/Qwen3.8-27B-GGUF', revision: REV, repoPath: 'MTP/mtp-Qwen3.8-27B-Q4_0.gguf',
        saveAs: 'mtp-Qwen3.8-27B-Q4_0.gguf', bytes: DRAFTER_BODY.length, sha256: sha(DRAFTER_BODY), vramMb: 3072,
        ...(gain === undefined ? {} : { gainOverBuiltInPct: gain, vramOverBuiltInMb: 800 }),
      },
      ...(projector ? { projector: {
        repo: 'unsloth/Qwen3.8-27B-GGUF', revision: REV, repoPath: 'mmproj-F16.gguf',
        saveAs: 'mmproj-Qwen3.8-27B-F16.gguf', bytes: PROJECTOR_BODY.length, sha256: sha(PROJECTOR_BODY), vramMb: 1100,
      } } : {}),
    }],
  };
}

const ACCELERATION = {
  families: [
    { family: 'qwen38', matchPrefixes: ['qwen3-8'], mtp: 'yes', mtpShape: 'separate' },
    { family: 'bonsai2', matchPrefixes: ['bonsai-2'], mtp: 'no', mtpShape: 'native' },
  ],
};

const HEADER = { architecture: 'qwen35', kv: { 'general.architecture': 'qwen35', 'general.basename': 'Qwen3.8-27B' } };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-companion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Qwen3.8-27B-UD-Q6_K');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'Qwen3.8-27B-UD-Q6_K.gguf'), 'model');
  return { root, dir };
}

function entryFor(dir, extra = {}) {
  return { tag: 'Qwen3.8-27B-UD-Q6_K', dir, mainGguf: 'Qwen3.8-27B-UD-Q6_K.gguf', drafterGguf: '', mmproj: false,
    sizeBytes: 5, source: 'root', embeddedMtpLayers: 0, ...extra };
}

// A download that writes the body its pin names, or fails with `reason`.
function fakeDownload({ reason = '', gate = null, calls = [] } = {}) {
  return async (options) => {
    calls.push(options);
    if (gate) await gate;
    if (options.signal.aborted) return { ok: false, reason: 'cancelled' };
    if (reason) return { ok: false, reason };
    const body = options.sha256 === sha(DRAFTER_BODY) ? DRAFTER_BODY : PROJECTOR_BODY;
    fs.writeFileSync(options.partialPath, body);
    options.onProgress?.({ receivedBytes: body.length, totalBytes: body.length });
    return { ok: true, partialPath: options.partialPath, resumed: false };
  };
}

function service(dir, overrides = {}) {
  const entries = overrides.entries || [entryFor(dir, overrides.entry)];
  return createGgufCompanionService({
    scanLocalGgufs: async () => { if (overrides.scans) overrides.scans.count += 1; return entries; },
    getCatalog: () => overrides.catalog || catalog(),
    getAccelerationCatalog: () => ACCELERATION,
    readHeader: () => (overrides.header === undefined ? HEADER : overrides.header),
    statfsImpl: overrides.statfsImpl || (async () => ({ bavail: 1e9, bsize: 4096 })),
    download: overrides.download || fakeDownload(),
    isEnabled: overrides.isEnabled || (() => true),
    isLocalOnly: overrides.isLocalOnly || (() => false),
    platform: process.platform,
    ...(overrides.fsImpl ? { fsImpl: overrides.fsImpl } : {}),
  });
}

const TAG = { tag: 'Qwen3.8-27B-UD-Q6_K' };

test('both rows are offered for a listed model with neither file', async (t) => {
  const { dir } = fixture(t);
  const result = await service(dir).status(TAG);
  assert.equal(result.ok, true);
  assert.equal(result.drafter.state, 'available');
  assert.equal(result.drafter.fileName, 'mtp-Qwen3.8-27B-Q4_0.gguf');
  assert.equal(result.drafter.bytes, DRAFTER_BODY.length);
  assert.equal(result.projector.state, 'available');
  assert.equal(result.download, null);
});

test('installed files and a model with no known projector', async (t) => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'mmproj-F16.gguf'), 'p');
  const installed = await service(dir, { entry: { drafterGguf: 'mtp-Qwen3.8-27B-Q4_0.gguf', mmproj: true } }).status(TAG);
  assert.equal(installed.drafter.state, 'installed');
  assert.equal(installed.drafter.fileName, 'mtp-Qwen3.8-27B-Q4_0.gguf');
  assert.equal(installed.projector.state, 'installed');
  assert.equal(installed.projector.fileName, 'mmproj-F16.gguf');
  const noProjector = await service(dir, { catalog: catalog({ projector: false }) }).status(TAG);
  assert.equal(noProjector.projector, null);
});

test('a family that does not draft with a separate file has no Drafter row', async (t) => {
  const { dir } = fixture(t);
  const entries = [{ ...entryFor(dir), tag: 'bonsai-2-27b', mainGguf: 'Qwen3.8-27B-UD-Q6_K.gguf' }];
  const result = await service(dir, { entries, header: { architecture: 'other', kv: {} } }).status({ tag: 'bonsai-2-27b' });
  assert.equal(result.drafter, null);
  assert.equal(result.projector, null);
});

test('a built-in head offers the drafter only when it was measured at least 10% faster', async (t) => {
  const { dir } = fixture(t);
  const offered = await service(dir, { entry: { embeddedMtpLayers: 1 }, catalog: catalog({ gain: 10.8 }) }).status(TAG);
  assert.equal(offered.drafter.state, 'embedded');
  assert.equal(offered.drafter.gainOverBuiltInPct, 10.8);
  assert.equal(offered.drafter.vramOverBuiltInMb, 800);
  const quiet = service(dir, { entry: { embeddedMtpLayers: 1 }, catalog: catalog({ gain: 4 }) });
  const notOffered = await quiet.status(TAG);
  assert.equal(notOffered.drafter.state, 'embedded');
  assert.equal(notOffered.drafter.gainOverBuiltInPct, null);
  assert.equal((await quiet.install({ ...TAG, kind: 'drafter' })).ok, false);
  const unmeasured = await service(dir, { entry: { embeddedMtpLayers: 1 } }).status(TAG);
  assert.equal(unmeasured.drafter.gainOverBuiltInPct, null);
});

test('gates: kill switch, Ollama copy, Local only, not in the catalog', async (t) => {
  const { dir } = fixture(t);
  assert.equal((await service(dir, { isEnabled: () => false }).status(TAG)).drafter.reason, 'disabled');
  assert.equal((await service(dir, { entry: { source: 'ollama' } }).status(TAG)).drafter.reason, 'ollama_copy');
  assert.equal((await service(dir, { entry: { ollamaBlob: true } }).status(TAG)).projector.reason, 'ollama_copy');
  const localOnly = await service(dir, { isLocalOnly: () => true }).status(TAG);
  assert.equal(localOnly.drafter.state, 'unavailable');
  assert.equal(localOnly.drafter.reason, 'local_only');
  const unlisted = await service(dir, { header: { architecture: 'llama', kv: {} } }).status(TAG);
  assert.equal(unlisted.drafter.reason, 'not_in_catalog');
  assert.equal(unlisted.projector, null);
  const refused = await service(dir, { isLocalOnly: () => true }).install({ ...TAG, kind: 'drafter' });
  assert.deepEqual(refused, { ok: false, reason: 'local_only' });
});

test('not enough space names what is needed and where', async (t) => {
  const { dir } = fixture(t);
  const result = await service(dir, { statfsImpl: async () => ({ bavail: 1, bsize: 1 }) }).status(TAG);
  assert.equal(result.drafter.reason, 'insufficient_space');
  assert.equal(result.drafter.neededBytes, DRAFTER_BODY.length);
  assert.equal(result.drafter.freeBytes, 1);
  assert.ok(result.drafter.drive.length > 0);
});

test('install downloads, places the file under its pinned name and removes the partial', async (t) => {
  const { dir } = fixture(t);
  const calls = [];
  const svc = service(dir, { download: fakeDownload({ calls }) });
  assert.deepEqual(await svc.install({ ...TAG, kind: 'drafter' }), { ok: true });
  await svc.whenIdle();
  const finalPath = path.join(dir, 'mtp-Qwen3.8-27B-Q4_0.gguf');
  assert.deepEqual(fs.readFileSync(finalPath), DRAFTER_BODY);
  assert.equal(fs.existsSync(finalPath + PARTIAL_SUFFIX), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/${REV}/MTP/mtp-Qwen3.8-27B-Q4_0.gguf`);
  assert.equal(calls[0].partialPath, finalPath + PARTIAL_SUFFIX);
  assert.equal(calls[0].bytes, DRAFTER_BODY.length);
});

test('one download at a time: the running row says downloading, the other says busy', async (t) => {
  const { dir } = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scans = { count: 0 };
  const svc = service(dir, { download: fakeDownload({ gate }), scans });
  assert.equal((await svc.install({ ...TAG, kind: 'drafter' })).ok, true);
  const scansAtStart = scans.count;
  const during = await svc.status(TAG);
  await svc.status(TAG);
  assert.equal(scans.count, scansAtStart, 'the status poll reuses the downloading entry instead of scanning');
  assert.equal(during.drafter.state, 'downloading');
  assert.equal(during.projector.reason, 'busy');
  assert.equal(during.download.kind, 'drafter');
  assert.deepEqual(await svc.install({ ...TAG, kind: 'projector' }), { ok: false, reason: 'busy' });
  release();
  await svc.whenIdle();
  assert.equal((await svc.status(TAG)).projector.state, 'available');
});

test('cancel records no failure; a checksum failure is shown until the next try', async (t) => {
  const { dir } = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cancelled = service(dir, { download: fakeDownload({ gate }) });
  await cancelled.install({ ...TAG, kind: 'drafter' });
  cancelled.cancel();
  release();
  await cancelled.whenIdle();
  assert.equal((await cancelled.status(TAG)).drafter.state, 'available');

  const failing = service(dir, { download: fakeDownload({ reason: 'sha256_mismatch' }) });
  await failing.install({ ...TAG, kind: 'drafter' });
  await failing.whenIdle();
  const after = await failing.status(TAG);
  assert.equal(after.drafter.state, 'failed');
  assert.equal(after.drafter.reason, 'sha256_mismatch');
  assert.equal((await failing.install({ ...TAG, kind: 'drafter' })).ok, true, 'a failed row can be retried');
  await failing.whenIdle();
});

test('placement never overwrites: a taken name is refused before and during a download', async (t) => {
  const { dir } = fixture(t);
  const finalPath = path.join(dir, 'mtp-Qwen3.8-27B-Q4_0.gguf');
  fs.writeFileSync(finalPath, 'someone else');
  const calls = [];
  const svc = service(dir, { download: fakeDownload({ calls }) });
  assert.equal((await svc.status(TAG)).drafter.reason, 'name_taken', 'refused before any download');
  assert.deepEqual(await svc.install({ ...TAG, kind: 'drafter' }), { ok: false, reason: 'name_taken' });
  assert.equal(calls.length, 0);
  fs.unlinkSync(finalPath);

  // The name is taken while the download runs: a different file stays and the result is name_taken.
  for (const [body, reason] of [['someone else', 'name_taken'], [DRAFTER_BODY, '']]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const racing = service(dir, { download: fakeDownload({ gate }) });
    assert.equal((await racing.install({ ...TAG, kind: 'drafter' })).ok, true);
    fs.writeFileSync(finalPath, body);
    release();
    const result = await racing.whenIdle();
    assert.equal(result.ok, !reason, 'an identical file counts as installed');
    if (reason) assert.equal(result.reason, reason);
    assert.deepEqual(fs.readFileSync(finalPath), Buffer.from(body));
    assert.equal(fs.existsSync(finalPath + PARTIAL_SUFFIX), false);
    fs.unlinkSync(finalPath);
  }
});

test('a file the launch rules would not pick beside the model is not offered', async (t) => {
  const { dir } = fixture(t);
  // Two other models' drafters: the catalog drafter would be a third that names no file here.
  const entry = { mainGguf: 'Swift-1.5-Model-Q6_K.gguf' };
  fs.writeFileSync(path.join(dir, entry.mainGguf), 'x');
  fs.writeFileSync(path.join(dir, 'mtp-gemma-4-12b-it.gguf'), 'x');
  fs.writeFileSync(path.join(dir, 'mtp-gemma-4-31b-it.gguf'), 'x');
  const svc = service(dir, { entry });
  const before = await svc.status(TAG);
  assert.equal(before.drafter.state, 'unavailable');
  assert.equal(before.drafter.reason, 'not_paired');
  assert.deepEqual(await svc.install({ ...TAG, kind: 'drafter' }), { ok: false, reason: 'not_paired' });
});

test('a model folder that is a symlink or junction is refused', async (t) => {
  const { root, dir } = fixture(t);
  const link = path.join(root, 'linked-model');
  try {
    fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`cannot create a link here: ${error.code}`);
    return;
  }
  const calls = [];
  const svc = service(link, { download: fakeDownload({ calls }) });
  const result = await svc.status(TAG);
  assert.equal(result.drafter.reason, 'folder_rejected');
  assert.deepEqual(await svc.install({ ...TAG, kind: 'drafter' }), { ok: false, reason: 'folder_rejected' });
  assert.equal(calls.length, 0);
});

test('a folder swapped for a link mid-download is refused before placement', async (t) => {
  const { root, dir } = fixture(t);
  const moved = path.join(root, 'moved');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const svc = service(dir, { download: async (options) => {
    await gate;
    fs.writeFileSync(options.partialPath, DRAFTER_BODY);
    return { ok: true, partialPath: options.partialPath, resumed: false };
  } });
  await svc.install({ ...TAG, kind: 'drafter' });
  fs.renameSync(dir, moved);
  try {
    fs.symlinkSync(moved, dir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    release();
    await svc.whenIdle();
    t.skip(`cannot create a link here: ${error.code}`);
    return;
  }
  release();
  await svc.whenIdle();
  assert.equal(fs.existsSync(path.join(moved, 'mtp-Qwen3.8-27B-Q4_0.gguf')), false);
});

test('the model is resolved from the scan, never from the renderer path', async (t) => {
  const { dir } = fixture(t);
  const svc = service(dir);
  assert.deepEqual(await svc.status({ tag: 'nope' }), { ok: false, reason: 'unknown_model' });
  assert.deepEqual(await svc.status({ ...TAG, modelPath: path.join(os.tmpdir(), 'elsewhere.gguf') }),
    { ok: false, reason: 'unknown_model' });
  assert.equal((await svc.status({ ...TAG, modelPath: path.join(dir, 'Qwen3.8-27B-UD-Q6_K.gguf') })).ok, true);
  assert.deepEqual(await svc.install({ ...TAG, kind: 'shell' }), { ok: false, reason: 'invalid_kind' });
});

test('production wiring: the real catalogs load, Local only comes from saved settings, no scan means no channels', async (t) => {
  const { registerGgufCompanions } = require('../services/main/gguf-companion-ipc-handlers');
  const { dir } = fixture(t);
  const handlers = new Map();
  const ipcMainLike = { handle: (channel, handler) => handlers.set(channel, handler) };
  let mode = 'auto';
  const svc = registerGgufCompanions(ipcMainLike, {
    listLocalGgufs: async () => [entryFor(dir)],
    shellConfigService: { getState: () => ({ offlineIntelligence: { mode } }) },
    featureFlags: { gguf_companions: true },
    authorization: { authorize: () => true },
  });
  assert.equal(typeof svc.status, 'function');
  assert.deepEqual([...handlers.keys()].sort(),
    ['llama-server:cancel-companion', 'llama-server:companion-status', 'llama-server:install-companion']);
  // The fixture's model file is not a GGUF, so the file family matches the seed's Qwen entry.
  const offered = await handlers.get('llama-server:companion-status')({}, TAG);
  assert.equal(offered.drafter.state, 'available');
  assert.equal(offered.drafter.bytes, 1369590656);
  mode = 'local_only';
  assert.equal((await handlers.get('llama-server:companion-status')({}, TAG)).drafter.reason, 'local_only');
  assert.equal(registerGgufCompanions({ handle() { throw new Error('nothing registers'); } }, {}), null);
});

test('IPC handlers: authorization, payload clean-up and thrown errors', async () => {
  const handlers = new Map();
  const ipcMainLike = { handle: (channel, handler) => handlers.set(channel, handler) };
  const seen = [];
  const fakeService = {
    status: async (payload) => { seen.push(payload); return { ok: true }; },
    install: async () => { throw Object.assign(new Error('x'), { reason: 'folder_rejected' }); },
    cancel: () => ({ ok: true }),
  };
  registerGgufCompanionIpcHandlers(ipcMainLike, { service: fakeService, authorization: { authorize: (event) => event.trusted === true } });
  const call = (suffix, event, payload) => handlers.get(`llama-server:${suffix}`)(event, payload);
  assert.equal((await call('companion-status', { trusted: false }, {})).authorized, false);
  await call('companion-status', { trusted: true }, { tag: 'Q', modelPath: 5, kind: 'drafter', extra: 'x' });
  assert.deepEqual(seen[0], { tag: 'Q', modelPath: '', kind: 'drafter' });
  assert.deepEqual(await call('install-companion', { trusted: true }, {}), { ok: false, reason: 'folder_rejected' });
  assert.deepEqual(await call('cancel-companion', { trusted: true }), { ok: true });
});

test('without hard links the checked partial is renamed into place, never copied over a name', async (t) => {
  const { dir } = fixture(t);
  const noLinks = { ...fs, linkSync: () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); } };
  const svc = service(dir, { fsImpl: noLinks });
  assert.equal((await svc.install({ ...TAG, kind: 'drafter' })).ok, true);
  assert.deepEqual(await svc.whenIdle(), { ok: true });
  const finalPath = path.join(dir, 'mtp-Qwen3.8-27B-Q4_0.gguf');
  assert.deepEqual(fs.readFileSync(finalPath), DRAFTER_BODY);
  assert.equal(fs.existsSync(finalPath + PARTIAL_SUFFIX), false);
});

test('a cancel that lands after the last byte keeps the checked partial and places nothing', async (t) => {
  const { dir } = fixture(t);
  let svc;
  const finishThenCancel = async (options) => {
    const result = await fakeDownload()(options);
    svc.cancel();
    return result;
  };
  svc = service(dir, { download: finishThenCancel });
  assert.equal((await svc.install({ ...TAG, kind: 'drafter' })).ok, true);
  assert.deepEqual(await svc.whenIdle(), { ok: false, reason: 'cancelled' });
  const finalPath = path.join(dir, 'mtp-Qwen3.8-27B-Q4_0.gguf');
  assert.equal(fs.existsSync(finalPath), false);
  assert.deepEqual(fs.readFileSync(finalPath + PARTIAL_SUFFIX), DRAFTER_BODY, 'the next try resumes from it');
  assert.equal((await svc.status(TAG)).drafter.state, 'available', 'a cancel records no failure');
});
