'use strict';

// new-test-file: row 123 slice 6-5 sender (a new surface): what may be offered, the checks before any hashing, the
// push loop's source check, the outgoing rate limit and the offers file kept across a restart.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MODEL_TRANSFER_LIMITS, validateModelManifest } = require('../server/team/model-manifest');
const { MAX_ENTRIES, OFFERS_FILE_NAME, createOffersFile, createRateFile, offersFilePath } = require('../services/team/model-offers-file');
const { createModelHasher } = require('../services/team/model-hash');
const { createModelSender } = require('../services/team/model-send');
const { PushEnd, createPush, createRateLimiter } = require('../services/team/model-send-push');
const source = require('../services/team/model-send-source');
const { makeBytes } = require('./helpers/team-model-receive-fixture');

const TEAM = 'team_abcdefghijklmnop';
const SENDER = { memberId: 'member_abcdefghijklmnop', displayName: 'Mika Member' };
const MB = 1_000_000;

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-model-send-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

// A GGUF v3 header with string keys only (the prefill reads general.name, general.license, general.source.url).
function ggufWithKeys(keys, size = 4096) {
  const parts = [Buffer.from('GGUF', 'latin1'), Buffer.alloc(4), Buffer.alloc(8), Buffer.alloc(8)];
  parts[1].writeUInt32LE(3);
  parts[3].writeBigUInt64LE(BigInt(Object.keys(keys).length));
  const str = (text) => { const bytes = Buffer.from(text, 'utf8'); const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(bytes.length)); return [len, bytes]; };
  for (const [key, value] of Object.entries(keys)) {
    const type = Buffer.alloc(4);
    type.writeUInt32LE(8);
    parts.push(...str(key), type, ...str(value));
  }
  const head = Buffer.concat(parts);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 7)]);
}

function modelFolder(t, names = ['Qwen3-8B-Q4_K_M.gguf', 'mmproj-Qwen3-8B-F16.gguf', 'mtp-Qwen3-8B-Q8_0.gguf']) {
  const root = tempDir(t, 'root');
  const dir = path.join(root, 'Qwen3-8B-Q4_K_M');
  fs.mkdirSync(dir);
  names.forEach((name, index) => fs.writeFileSync(path.join(dir, name), index === 0
    ? ggufWithKeys({ 'general.name': 'Qwen\u0007 3', 'general.license': 'apache-2.0', 'general.source.url': 'https://example.test/q' })
    : makeBytes(3000 + index, name)));
  return { root, dir, entry: { tag: 'qwen3:8b', dir, mainGguf: names[0], sizeBytes: 4096, source: 'library' } };
}

const manifestOf = (requestId, audience = { kind: 'team' }) => ({
  request_id: requestId, audience, display_name: 'Qwen three',
  files: [{ name: 'Qwen3-8B-Q4_K_M.gguf', size: 4096, sha256: 'a'.repeat(64), segments: ['a'.repeat(64)] }],
  provenance: { licence: 'Apache-2.0', source_url: null, note: '' },
});
const entryOf = (requestId, offerId = null) => ({ request_id: requestId, offer_id: offerId, audience: { kind: 'team' },
  tag: 'qwen3:8b', files: ['Qwen3-8B-Q4_K_M.gguf'], manifest: manifestOf(requestId) });

test('only a root, persisted or library entry is sendable; an Ollama copy has its own reason; a tag is never a path', async (t) => {
  const { entry, dir } = modelFolder(t);
  const list = async () => [entry, { ...entry, tag: 'ollama:x', source: 'ollama', ollamaBlob: true }, { ...entry, tag: 'odd', source: 'other' }];
  assert.deepEqual((await source.sendableModels(list)).map((row) => [row.tag, row.sendable, row.reason]),
    [['qwen3:8b', true, null], ['ollama:x', false, 'model_ollama_copy'], ['odd', false, 'model_not_listed']]);
  assert.equal((await source.resolveModel(list, 'ollama:x')).reason, 'model_ollama_copy');
  assert.equal((await source.resolveModel(list, dir)).reason, 'model_not_listed', 'a path is not a tag');
  assert.equal((await source.resolveModel(list, 'missing')).reason, 'model_not_listed');
  const resolved = await source.resolveModel(list, 'qwen3:8b');
  assert.deepEqual(resolved.files.map((file) => [file.name, file.kind, file.required]),
    [['Qwen3-8B-Q4_K_M.gguf', 'model', true], ['mmproj-Qwen3-8B-F16.gguf', 'vision', false], ['mtp-Qwen3-8B-Q8_0.gguf', 'drafter', false]]);
  // The prefill comes from the header, cleaned (the bell is gone) and cut.
  assert.deepEqual(source.provenancePrefill(path.join(dir, 'Qwen3-8B-Q4_K_M.gguf'), 'qwen3:8b'),
    { name: 'Qwen 3', licence: 'apache-2.0', source_url: 'https://example.test/q' });
  assert.equal(source.cleanUrl('http://example.test/q'), '');
  assert.equal(source.cleanUrl('https://user:pw@example.test/'), '');
});

test('the receiver\'s own checks run before hashing: shard names, a lone drafter and the provenance bound are refused', () => {
  const check = (names, provenance = { licence: '', source_url: '', note: '' }, displayName = 'Qwen three') => source.precheck({
    manifest: source.buildManifest({ requestId: 'r1', audience: { kind: 'team' }, displayName, provenance,
      files: names.map((name) => ({ name, size: 1000 })) }), teamId: TEAM, sender: SENDER });
  assert.deepEqual(check(['Qwen3-8B-Q4_K_M.gguf', 'mmproj-Qwen3-8B-F16.gguf']), { ok: true });
  assert.equal(check(['Big-Q4_K_M-00001-of-00003.gguf', 'Big-Q4_K_M-00002-of-00003.gguf']).reason, 'model_manifest_invalid');
  assert.equal(check(['Qwen3-8B-Q4_K_M.gguf', 'mtp-Llama-3-Q8_0.gguf']).reason, 'model_manifest_invalid');
  assert.equal(check(['mtp-Qwen3-8B-Q8_0.gguf']).reason, 'model_manifest_invalid');
  // A manifest 6-1 accepts can still pass the receiver's 16 KiB provenance file (the 6-4 report measured 19,445 bytes):
  // eight long shard names with the widest licence, note and name.
  const wide = '€';
  const base = `${'A'.repeat(150)}-Q4_K_M`;
  const shards = Array.from({ length: 8 }, (_unused, index) => `${base}-0000${index + 1}-of-00008.gguf`);
  assert.equal(check(shards).ok, true);
  assert.equal(check(shards, { licence: wide.repeat(MODEL_TRANSFER_LIMITS.maxLicenceChars), source_url: '',
    note: wide.repeat(MODEL_TRANSFER_LIMITS.maxNoteChars) }, wide.repeat(128)).reason, 'model_provenance_too_large');
});

function senderFor(t, { entry, offersFile = { load: () => [], save: () => ({ ok: true }) }, hasher, link = {} }) {
  const commands = [];
  const sender = createModelSender({
    teamId: TEAM, discovery: async () => [entry], hasher, self: () => SENDER, offersFile, limiter: { take: async () => {} },
    sleep: async () => {}, transfers: { view: () => null, pauses: () => 0, refresh: async () => null, waitView: async () => {}, replay: () => {} },
    link: { command: async (operation, params) => { commands.push([operation, params]); return { ok: false, error: { reason: 'team_not_connected' } }; },
      put: async () => ({ ok: true, ready: true }), online: () => false, waitReconnect: async () => {}, ...link },
  });
  t.after(() => sender.stopAll());
  return { sender, commands };
}

test('at most 16 open offers; a file outside the companion set and an audience of oneself are refused, nothing hashed', async (t) => {
  const { entry } = modelFolder(t);
  const hashed = [];
  // A read that never ends: every offer stays open while it reads.
  const hasher = { hash: (file, { signal }) => { hashed.push(file); return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }); } };
  const { sender } = senderFor(t, { entry, hasher });
  const input = { tag: 'qwen3:8b', files: [], display_name: 'Qwen three' };
  assert.equal((await sender.offer({ ...input, files: ['elsewhere.gguf'] })).error.reason, 'model_file_not_offered');
  assert.equal((await sender.offer({ ...input, member_id: SENDER.memberId })).error.reason, 'model_audience_invalid');
  assert.equal(hashed.length, 0);
  for (let index = 0; index < MODEL_TRANSFER_LIMITS.maxOffersPerMember; index += 1) assert.equal((await sender.offer(input)).ok, true);
  const refused = await sender.offer(input);
  assert.deepEqual(refused, { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_model_offer_limit' } });
  await sender.stopAll();
  assert.deepEqual(sender.resources(), { offers: 16, pushes: 0, reads: 0 });
});

test('the push re-checks the source before every part: a change stops it with model_source_changed, handles closed', async (t) => {
  const dir = tempDir(t, 'push');
  const file = path.join(dir, 'Model-Q4_K_M.gguf');
  fs.writeFileSync(file, makeBytes(40, 'push'));
  const files = [{ path: file, size: 40, identity: source.identityOf(fs.lstatSync(file, { bigint: true })) }];
  const puts = [];
  let view = { state: 'flowing', queued: false, next: { index: 0, part: 0 } };
  const push = createPush({
    transferId: 'mxfer_aaaaaaaaaaaaaaaaaaaaaa', files, partBytes: 10, command: async () => ({ ok: true }), view: () => view,
    pauses: () => 0, refresh: async () => null, waitView: async () => {}, online: () => true, waitReconnect: async () => {},
    sleep: async () => {}, limiter: { take: async () => {} },
    put: async (index, n, bytes) => {
      puts.push([index, n, bytes.length]);
      if (n === 1) fs.appendFileSync(file, 'x');
      return { ok: true, ready: true };
    },
  });
  const outcome = await push.run(new AbortController().signal);
  assert.deepEqual(outcome, { state: 'ended', reason: 'model_source_changed' });
  assert.deepEqual(puts, [[0, 0, 10], [0, 1, 10]], 'no part after the change');
  assert.equal(push.handles(), 0);
  view = null;
  assert.ok(new PushEnd('x') instanceof Error);
});

test('the outgoing rate limit holds 1 and 25 MB/s on the injected clock, is off by default and leaves no timer', async (t) => {
  for (const rate of [1, 25]) {
    let now = 0;
    const sleeps = [];
    const limiter = createRateLimiter({ rate: () => rate * MB, clock: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
    const part = 4 * 1024 * 1024;
    for (let index = 0; index < 20; index += 1) await limiter.take(part, null);
    const perSecond = (20 * part) / (now / 1000);
    assert.ok(Math.abs(perSecond - rate * MB) / (rate * MB) < 0.02, `${rate} MB/s measured ${perSecond}`);
    assert.equal(sleeps.length, 20, 'one sleep per part, no busy loop');
  }
  const dir = tempDir(t, 'rate');
  const rateFile = createRateFile({ userDataPath: dir, teamId: TEAM, maxMb: 1000 });
  assert.equal(rateFile.load(), 0, 'off by default');
  let slept = 0;
  const off = createRateLimiter({ rate: () => rateFile.load() * MB, clock: () => 0, sleep: async () => { slept += 1; } });
  await off.take(10 * MB, null);
  assert.equal(slept, 0);
  assert.equal(rateFile.save(25), true);
  assert.equal(rateFile.load(), 25);
  assert.equal(rateFile.save(0), true);
  assert.equal(rateFile.load(), 0);
});

test('the offers file: nothing before the first offer, atomic, 16 kept and one past refused, broken files set aside', (t) => {
  const userData = tempDir(t, 'offers');
  const logs = [];
  const file = createOffersFile({ userDataPath: userData, teamId: TEAM, now: () => 1234, log: (...entry) => logs.push(entry) });
  const where = offersFilePath(userData, TEAM);
  assert.equal(path.basename(where), OFFERS_FILE_NAME);
  assert.deepEqual(file.load(), []);
  assert.equal(fs.existsSync(where), false, 'nothing written before the first offer');
  const entries = Array.from({ length: MAX_ENTRIES }, (_unused, index) => entryOf(`req_${index}`, index === 0 ? `offer_${'b'.repeat(22)}` : null));
  assert.deepEqual(file.save(entries), { ok: true });
  assert.deepEqual(file.load().map((entry) => entry.request_id), entries.map((entry) => entry.request_id));
  assert.deepEqual(fs.readdirSync(path.dirname(where)).filter((name) => name !== OFFERS_FILE_NAME), [], 'no temp file left');
  assert.deepEqual(file.save([...entries, entryOf('req_x')]), { ok: false, reason: 'team_model_offer_limit' });
  assert.equal(validateModelManifest(file.load()[0].manifest).ok, true);
  // One past the bound on disk, a broken file and an oversized one are each set aside and read as empty.
  fs.writeFileSync(where, JSON.stringify({ schema: 1, offers: [...entries, entryOf('req_x')] }));
  assert.deepEqual(file.load(), []);
  assert.deepEqual(fs.readdirSync(path.dirname(where)), [`${OFFERS_FILE_NAME}.bad-1234`]);
  fs.writeFileSync(where, '{ not json');
  assert.deepEqual(file.load(), []);
  fs.writeFileSync(where, 'x'.repeat(16 * (MODEL_TRANSFER_LIMITS.maxBodyBytes + 4096) + 2048));
  assert.deepEqual(file.load(), []);
  assert.deepEqual(fs.readdirSync(path.dirname(where)), [`${OFFERS_FILE_NAME}.bad-1234`], 'one set-aside copy kept');
  // A withdrawn or ended offer leaves the file; the last one removes it.
  file.save(entries.slice(0, 2));
  file.save(entries.slice(0, 1));
  assert.equal(file.load().length, 1);
  file.save([]);
  assert.equal(fs.existsSync(where), false);
  assert.ok(logs.every(([, , fields]) => !JSON.stringify(fields).includes(userData)), 'no path logged');
});

test('X4b-F05: an offers file that does not read for a passing reason, or is newer, is kept and never rewritten', (t) => {
  const userData = tempDir(t, 'offers-kept');
  const where = offersFilePath(userData, TEAM);
  const entries = [entryOf('req_a'), entryOf('req_b')];
  assert.deepEqual(createOffersFile({ userDataPath: userData, teamId: TEAM }).save(entries), { ok: true });
  const saved = fs.readFileSync(where);
  const realOpen = fs.openSync;
  t.after(() => { fs.openSync = realOpen; });
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EMFILE']) {
    fs.openSync = (target, ...rest) => {
      if (path.resolve(String(target)) === where) throw Object.assign(new Error(code), { code });
      return realOpen(target, ...rest);
    };
    const file = createOffersFile({ userDataPath: userData, teamId: TEAM, now: () => 99 });
    assert.deepEqual(file.load(), [], code);
    assert.deepEqual(file.save(entries.slice(0, 1)), { ok: false, reason: 'team_unavailable' }, `${code}: not written over`);
    fs.openSync = realOpen;
    assert.deepEqual([fs.readdirSync(path.dirname(where)), fs.readFileSync(where).equals(saved)], [[OFFERS_FILE_NAME], true], code);
    assert.deepEqual(createOffersFile({ userDataPath: userData, teamId: TEAM }).load().map((entry) => entry.request_id), ['req_a', 'req_b']);
  }
  const newer = JSON.stringify({ schema: 2, offers: [], later: true });
  fs.writeFileSync(where, newer);
  const file = createOffersFile({ userDataPath: userData, teamId: TEAM, now: () => 99 });
  assert.deepEqual([file.load(), file.save(entries)], [[], { ok: false, reason: 'team_unavailable' }]);
  assert.deepEqual([fs.readdirSync(path.dirname(where)), fs.readFileSync(where, 'utf8')], [[OFFERS_FILE_NAME], newer]);
});

// The push of one 40-byte file in 10-byte parts against a stub host answering every put through `answer`.
function pushAgainst(t, answer, { fileBytes = 40 } = {}) {
  const dir = tempDir(t, 'pushhost');
  const file = path.join(dir, 'Model-Q4_K_M.gguf');
  fs.writeFileSync(file, makeBytes(fileBytes, 'pushhost'));
  const files = [{ path: file, size: fileBytes, identity: source.identityOf(fs.lstatSync(file, { bigint: true })) }];
  const puts = [];
  const sleeps = [];
  let stats = 0;
  const fsImpl = { ...fs, promises: { ...fs.promises, lstat: (...args) => { stats += 1; return fs.promises.lstat(...args); }, open: fs.promises.open } };
  const push = createPush({
    transferId: 'mxfer_aaaaaaaaaaaaaaaaaaaaaa', files, partBytes: 10, fsImpl, command: async () => ({ ok: true }),
    view: () => ({ state: 'flowing', queued: false, next: { index: 0, part: 0 } }), pauses: () => 0, refresh: async () => null,
    waitView: async () => {}, online: () => true, waitReconnect: async () => {}, sleep: async (ms) => { sleeps.push(ms); },
    limiter: { take: async () => {} },
    put: async (index, n, bytes) => { puts.push([index, n, bytes.length]); return answer(puts.length, index, n); },
  });
  return { push, puts, sleeps, stats: () => stats };
}

test('a host that answers window_full forever ends the push in bounded time; the part is read once, not per retry', async (t) => {
  const host = pushAgainst(t, (count) => (count > 5000 ? { ok: false, error: { reason: 'guard_tripped' } } : { ok: true, wait: 'window_full' }));
  const outcome = await host.push.run(new AbortController().signal);
  assert.deepEqual(outcome, { state: 'ended', reason: 'team_model_transfer_stale' });
  assert.ok(host.puts.length <= 64, `bounded puts (${host.puts.length})`);
  assert.ok(host.sleeps.length >= host.puts.length - 1, 'a back-off between the answers');
  assert.equal(host.stats(), 1, 'the part was checked and read once');
});

test('team_model_relay_busy forever ends the push after a bounded number of tries', async (t) => {
  const host = pushAgainst(t, (count) => (count > 5000 ? { ok: false, error: { reason: 'guard_tripped' } }
    : { ok: false, error: { reason: 'team_model_relay_busy' } }));
  const outcome = await host.push.run(new AbortController().signal);
  assert.deepEqual(outcome, { state: 'ended', reason: 'team_model_relay_busy' });
  assert.ok(host.puts.length <= 64, `bounded puts (${host.puts.length})`);
});

// A worker stand-in for the real createModelHasher: answers 'a' * 64 for the declared size after `delayMs`, or never.
function fakeHashWorkers({ delayMs = 20, hold = false } = {}) {
  const made = [];
  class FakeWorker extends EventEmitter {
    constructor(_file, { workerData }) {
      super();
      made.push(this);
      const size = Number(workerData.expected.size);
      const result = { size, sha256: 'a'.repeat(64), segments: Array(Math.ceil(size / workerData.segmentBytes)).fill('a'.repeat(64)) };
      if (!hold) this.timer = setTimeout(() => { this.emit('message', { type: 'done', result }); setImmediate(() => this.emit('exit', 0)); }, delayMs);
    }

    terminate() { clearTimeout(this.timer); setImmediate(() => this.emit('exit', 1)); return Promise.resolve(1); }
  }
  return { FakeWorker, made };
}

// One model folder holding only the 4096-byte main file the kept manifests name.
function keptSetup(t, { hold = false } = {}) {
  const folder = modelFolder(t, ['Qwen3-8B-Q4_K_M.gguf']);
  const userData = tempDir(t, 'kept');
  const offersFile = createOffersFile({ userDataPath: userData, teamId: TEAM });
  const { FakeWorker } = fakeHashWorkers({ hold });
  const hasher = createModelHasher({ WorkerImpl: FakeWorker });
  t.after(() => hasher.dispose());
  return { ...folder, offersFile, hasher };
}

const settled = async (sender, ms = 5000) => {
  const until = Date.now() + ms;
  while (sender.records().some((record) => record.state === 'reading')) {
    if (Date.now() > until) throw new Error('reads never ended');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
};

test('16 kept offers survive a restart with the real hasher: none is ended as busy, the file still holds 16', async (t) => {
  const { entry, offersFile, hasher } = keptSetup(t);
  const kept = Array.from({ length: MAX_ENTRIES }, (_unused, index) => entryOf(`req_${index}`));
  assert.deepEqual(offersFile.save(kept), { ok: true });
  const { sender } = senderFor(t, { entry, offersFile, hasher });
  await sender.restore();
  await settled(sender);
  assert.deepEqual(sender.records().map((record) => record.state), Array(MAX_ENTRIES).fill('offering'),
    JSON.stringify(sender.records().map((record) => record.reason)));
  assert.equal(offersFile.load().length, MAX_ENTRIES);
});

test('17 offers at once give 16 and one refusal, and the offers file holds 16', async (t) => {
  const { entry, offersFile, hasher } = keptSetup(t);
  const { sender } = senderFor(t, { entry, offersFile, hasher });
  const input = { tag: 'qwen3:8b', files: [], display_name: 'Qwen three' };
  const answers = await Promise.all(Array.from({ length: MAX_ENTRIES + 1 }, () => sender.offer(input)));
  assert.equal(answers.filter((answer) => answer.ok === true).length, MAX_ENTRIES);
  assert.deepEqual(answers.filter((answer) => answer.ok !== true).map((answer) => answer.error.reason), ['team_model_offer_limit']);
  await settled(sender);
  assert.equal(offersFile.load().length, MAX_ENTRIES);
});

test('a write of the offers file while the restore still reads keeps every kept entry', async (t) => {
  const { entry, offersFile, hasher } = keptSetup(t, { hold: true });
  const kept = [entryOf('req_a'), entryOf('req_b'), entryOf('req_c')];
  offersFile.save(kept);
  const { sender } = senderFor(t, { entry, offersFile, hasher });
  await sender.restore();
  const made = await sender.offer({ tag: 'qwen3:8b', files: [], display_name: 'Qwen three' });
  assert.equal(made.ok, true);
  assert.deepEqual(await sender.withdraw(made.request_id), { ok: true });
  assert.deepEqual(offersFile.load().map((saved) => saved.request_id), ['req_a', 'req_b', 'req_c']);
});

// A same-size rewrite happens mid-push (the open handle sees it too); a replaced file and a symlink are put in place
// after the hash and before the push opens the file (Windows refuses to rename over or delete a file held open).
test('the source re-stat stops the push for a same-size rewrite, a replaced file and a symlink put in its place', async (t) => {
  for (const change of ['rewrite', 'replace', 'symlink']) {
    const dir = tempDir(t, `restat-${change}`);
    const file = path.join(dir, 'Model-Q4_K_M.gguf');
    fs.writeFileSync(file, makeBytes(40, 'restat'));
    const files = [{ path: file, size: 40, identity: source.identityOf(fs.lstatSync(file, { bigint: true })) }];
    let skipped = false;
    if (change === 'replace') {
      fs.writeFileSync(path.join(dir, 'next.tmp'), makeBytes(40, 'restat'));
      fs.renameSync(path.join(dir, 'next.tmp'), file);
    } else if (change === 'symlink') {
      const target = path.join(dir, 'elsewhere.gguf');
      fs.writeFileSync(target, makeBytes(40, 'restat'));
      fs.rmSync(file);
      try { fs.symlinkSync(target, file); } catch { skipped = true; fs.copyFileSync(target, file); }
    }
    const puts = [];
    const push = createPush({
      transferId: 'mxfer_aaaaaaaaaaaaaaaaaaaaaa', files, partBytes: 10, command: async () => ({ ok: true }),
      view: () => ({ state: 'flowing', queued: false, next: { index: 0, part: 0 } }), pauses: () => 0, refresh: async () => null,
      waitView: async () => {}, online: () => true, waitReconnect: async () => {}, sleep: async () => {}, limiter: { take: async () => {} },
      put: async (index, n) => {
        puts.push(n);
        if (n === 1 && change === 'rewrite') {
          fs.writeFileSync(file, makeBytes(40, 'other bytes'));
          const later = new Date(Date.now() + 5000);
          fs.utimesSync(file, later, later);
        }
        return { ok: true, ready: true };
      },
    });
    const outcome = await push.run(new AbortController().signal);
    assert.deepEqual(outcome, { state: 'ended', reason: 'model_source_changed' }, change);
    assert.deepEqual(puts, change === 'rewrite' ? [0, 1] : [], `${change}: no part after the change`);
    if (skipped) t.diagnostic('symlink: not allowed on this machine; a copied file stood in');
  }
});

test('the push loop takes the limiter once per part with that part\'s bytes; a host next past the end is the host\'s fault', async (t) => {
  const takes = [];
  const dir = tempDir(t, 'limiter');
  const file = path.join(dir, 'Model-Q4_K_M.gguf');
  fs.writeFileSync(file, makeBytes(35, 'limiter'));
  const files = [{ path: file, size: 35, identity: source.identityOf(fs.lstatSync(file, { bigint: true })) }];
  let view = { state: 'flowing', queued: false, next: { index: 0, part: 0 } };
  const push = createPush({
    transferId: 'mxfer_aaaaaaaaaaaaaaaaaaaaaa', files, partBytes: 10, command: async () => ({ ok: true }), view: () => view,
    pauses: () => 0, refresh: async () => null, online: () => true, waitReconnect: async () => {}, sleep: async () => {},
    waitView: async () => { view = { ...view, state: 'done' }; },
    limiter: { take: async (bytes) => { takes.push(bytes); } }, put: async () => ({ ok: true, ready: true }),
  });
  assert.deepEqual(await push.run(new AbortController().signal), { state: 'done', reason: null });
  assert.deepEqual(takes, [10, 10, 10, 5]);
  // A `next` past the file's end: ended as team_answer_invalid, never as a changed source.
  const past = createPush({
    transferId: 'mxfer_aaaaaaaaaaaaaaaaaaaaaa', files, partBytes: 10, command: async () => ({ ok: true }),
    view: () => ({ state: 'flowing', queued: false, next: { index: 0, part: 9 } }), pauses: () => 0, refresh: async () => null,
    waitView: async () => {}, online: () => true, waitReconnect: async () => {}, sleep: async () => {}, limiter: { take: async () => {} },
    put: async () => ({ ok: true, ready: true }),
  });
  assert.deepEqual(await past.run(new AbortController().signal), { state: 'ended', reason: 'team_answer_invalid' });
});

test('one limiter sleep is never longer than the part\'s time at the rate plus a second, even after the clock steps back', async () => {
  let now = 1_000_000;
  const sleeps = [];
  const limiter = createRateLimiter({ rate: () => MB, clock: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  await limiter.take(MB, null);
  now -= 3_600_000; // the wall clock steps back an hour
  await limiter.take(MB, null);
  assert.ok(sleeps.every((ms) => ms <= 2000), JSON.stringify(sleeps));
});
