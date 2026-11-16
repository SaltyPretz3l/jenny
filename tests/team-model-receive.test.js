'use strict';

// new-test-file: services/team/model-receive.js is a new module (row 123 slice 6-4, the team model receiver).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createModelReceiver, MODEL_RECEIVE_REASONS } = require('../services/team/model-receive');
const { createModelHasher } = require('../services/team/model-hash');
const { readJournal, transferIdFor } = require('../services/team/model-receive-journal');
const { provenanceBytes } = require('../services/team/model-receive-checks');
const { createTransferIo } = require('../server/team/transfer-io');
const { resolveProjectorPath } = require('../services/llama-server-gguf-files');
const fx = require('./helpers/team-model-receive-fixture');

const MAIN = 'Qwen3-8B-Q4_K_M.gguf';

function setup(t, { specs, offerOverrides, transportOptions, hasher, limits, fsImpl, stepHook, extra } = {}) {
  const { base, root } = fx.makeRoot(t);
  const { offer, bytes } = fx.buildOffer(specs, offerOverrides);
  const transport = fx.fakeTransport(bytes, transportOptions);
  const logs = [];
  const events = [];
  const env = { base, root, offer, bytes, transport, logs, events };
  env.make = (more = {}) => createModelReceiver({
    roots: () => [root],
    transport,
    hasher: hasher || fx.fakeHasher(),
    limits: { ...fx.LIMITS, ...limits },
    logger: (...entry) => logs.push(entry),
    onEvent: (event) => events.push(event),
    validateManifest: fx.testValidator(),
    ...(fsImpl ? { fs: fsImpl } : {}),
    stepHook: stepHook ? (name, detail) => stepHook(name, detail, env) : null,
    ...extra,
    ...more,
  });
  env.receiver = env.make();
  env.familyDir = path.join(root, specs ? path.basename(specs[0].name).replace(/-Q4_K_M.*$/, '') : 'Qwen3-8B');
  env.incoming = path.join(root, '.jenny-incoming');
  env.start = (more = {}) => env.receiver.start({ offer: env.offer, root: env.root, ...more });
  return env;
}

const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
const tags = async (env) => (await fx.discover(env.root, env.base)).map((entry) => entry.tag);

test('a whole transfer: verified, placed, provenance written, staging gone, listed once', async (t) => {
  const hasher = createModelHasher();
  t.after(() => hasher.dispose());
  const env = setup(t, { hasher });
  const result = await env.start();
  assert.equal(result.state, 'complete', JSON.stringify(result));
  assert.deepEqual(filesIn(env.familyDir), [MAIN, `${MAIN}.jenny-source.json`, 'mmproj-Qwen3-8B-F16.gguf', 'mtp-Qwen3-8B-Q8_0.gguf']);
  env.offer.manifest.files.forEach((file, index) => assert.ok(fs.readFileSync(path.join(env.familyDir, file.name)).equals(env.bytes[index])));
  const provenance = JSON.parse(fs.readFileSync(path.join(env.familyDir, `${MAIN}.jenny-source.json`), 'utf8'));
  assert.deepEqual(Object.keys(provenance), ['schema', 'display_name', 'sender', 'team_id', 'folder', 'received_at', 'provenance', 'files']);
  assert.equal(provenance.folder, 'Qwen3-8B');
  assert.deepEqual(provenance.sender, { member_id: 'member_m1', display_name: 'Sam' });
  assert.deepEqual(provenance.provenance, { licence: 'Apache-2.0', source_url: 'https://example.test/qwen', note: 'From my library', checked: false });
  assert.deepEqual(provenance.files, env.offer.manifest.files.map(({ name, size, sha256 }) => ({ name, size, sha256 })));
  assert.deepEqual(filesIn(env.incoming), []);
  const entries = await fx.discover(env.root, env.base);
  assert.deepEqual(entries.map((e) => [e.tag, e.mainGguf, e.mmproj, e.drafterGguf]), [['Qwen3-8B', MAIN, true, 'mtp-Qwen3-8B-Q8_0.gguf']]);
  assert.deepEqual(['accept', 'complete', 'cancel'].map((name) => env.transport.count(name)), [1, 1, 0]);
  assert.equal(env.transport.calls.find((c) => c[0] === 'accept')[2], true, 'accept carries the signal');
  assert.deepEqual(env.receiver.resources(), { handles: 0, active: 0 });
  assert.equal(hasher.resources().worker, false);
  assert.equal(env.events.at(-1).doneBytes, env.events.at(-1).totalBytes);
});

test('the production validator and default limits: one small file is one real segment', async (t) => {
  const { base, root } = fx.makeRoot(t);
  const { offer, bytes } = fx.buildOffer([{ name: 'Tiny-Q4_K_M.gguf', size: 5000 }]);
  offer.manifest.files[0].segments = [offer.manifest.files[0].sha256];
  const transport = fx.fakeTransport(bytes);
  const receiver = createModelReceiver({ roots: () => [root], transport, hasher: fx.fakeHasher() });
  const result = await receiver.start({ offer, root });
  assert.equal(result.state, 'complete', JSON.stringify(result));
  assert.equal(transport.count('takePart'), 1);
  assert.deepEqual((await fx.discover(root, base)).map((e) => e.tag), ['Tiny']);
});

test('a new family folder: nothing is listed until the whole set is renamed into place (three shards)', async (t) => {
  const seen = [];
  const env = setup(t, {
    specs: fx.SHARD_FILES,
    stepHook: async (name, _detail, self) => {
      if (name === 'moved' || name === 'placing') seen.push(await tags(self));
    },
  });
  const result = await env.start();
  assert.equal(result.state, 'complete', JSON.stringify(result));
  assert.equal(seen.length, 5);
  assert.ok(seen.every((listed) => listed.length === 0), JSON.stringify(seen));
  const entries = await fx.discover(env.root, env.base);
  assert.deepEqual(entries.map((e) => [e.tag, e.mainGguf]), [['Big', 'Big-Q4_K_M-00001-of-00003.gguf']]);
});

test('R14-F01: a set never joins a folder it did not arrive with; the model already there keeps its own companions', async (t) => {
  for (const own of [['Qwen3-8B-Q8_0.gguf'], ['Qwen3-8B-Q8_0.gguf', 'mmproj-F16.gguf']]) {
    const env = setup(t);
    fs.mkdirSync(env.familyDir);
    for (const name of own) fs.writeFileSync(path.join(env.familyDir, name), fx.makeBytes(4000, name));
    const result = await env.start();
    assert.equal(path.basename(resolveProjectorPath({ modelPath: path.join(env.familyDir, own[0]) })), own[1] || '');
    assert.deepEqual(filesIn(env.familyDir), own.slice().sort(), 'nothing joined the folder the receiver had');
    assert.equal(result.state, 'complete', JSON.stringify(result));
    const entries = await fx.discover(env.root, env.base);
    const mine = entries.find((e) => e.mainGguf === own[0]);
    assert.deepEqual([Boolean(mine.drafterGguf), mine.mmproj], [false, own.length > 1], 'no received drafter or projector');
    const sibling = path.join(env.root, 'Qwen3-8B-2');
    assert.equal(JSON.parse(fs.readFileSync(path.join(sibling, `${MAIN}.jenny-source.json`), 'utf8')).folder, 'Qwen3-8B-2');
  }
});

test('CON-Q4_K_M.gguf never creates a CON folder', async (t) => {
  const env = setup(t, { specs: [{ name: 'CON-Q4_K_M.gguf', size: 5000 }] });
  assert.deepEqual([await env.start(), filesIn(env.root), env.transport.calls.length], [{ ok: false, reason: 'model_destination_invalid' }, [], 0]);
});

test('accept refusals write nothing and send nothing', async (t) => {
  const cases = [
    ['an invalid manifest', (env) => ({ offer: { ...env.offer, manifest: { ...env.offer.manifest, request_id: 'bad id' } } }), 'model_manifest_invalid'],
    ['an invalid sender', (env) => ({ offer: { ...env.offer, sender: { memberId: 'nope', displayName: 'Sam' } } }), 'model_manifest_invalid'],
    ['a root not in the list', (env) => {
      fs.mkdirSync(path.join(env.base, 'other'));
      return { root: path.join(env.base, 'other') };
    }, 'model_destination_invalid'],
    ['a relative root', () => ({ root: 'models' }), 'model_destination_invalid'],
    ['a main model that exists', (env) => {
      fs.mkdirSync(env.familyDir);
      fs.writeFileSync(path.join(env.familyDir, MAIN), 'mine');
    }, 'model_exists'],
    ['a provenance file that exists', (env) => {
      fs.mkdirSync(env.familyDir);
      fs.writeFileSync(path.join(env.familyDir, `${MAIN}.jenny-source.json`), '{}');
    }, 'model_exists'],
    ['a family folder that is a file', (env) => fs.writeFileSync(env.familyDir, 'x'), 'model_destination_invalid'],
  ];
  for (const [label, arrange, reason] of cases) {
    const env = setup(t);
    const input = arrange(env) || {};
    const arranged = fx.listTree(env.root);
    assert.deepEqual(await env.start(input), { ok: false, reason }, label);
    assert.deepEqual(fx.listTree(env.root), arranged, label);
    assert.equal(env.transport.calls.length, 0, label);
  }
});

test('the root rule is by real path: a configured junction to the chosen folder allows it', async (t) => {
  const env = setup(t);
  const link = path.join(env.base, 'linked');
  if (!fx.linkDir(env.root, link)) return t.skip('this machine refused the link');
  const result = await env.make({ roots: () => [link] }).start({ offer: env.offer, root: env.root });
  assert.equal(result.state, 'complete', JSON.stringify(result));
  return undefined;
});

test('names that do not re-classify to the offered set are refused (shards Move and add would not group)', async (t) => {
  const specs = [{ name: 'Big_00001-of-00002.gguf', size: 3000 }, { name: 'Big_00002-of-00002.gguf', size: 3000 }];
  const env = setup(t, { specs });
  assert.equal(fx.testValidator()(env.offer.manifest).ok, true, 'the 6-1 rules accept it');
  assert.deepEqual(await env.start(), { ok: false, reason: 'model_manifest_invalid' });
});

test('free space at accept: the edge, one short, and a statfs that fails (allowed)', async (t) => {
  const total = fx.MODEL_FILES.reduce((sum, file) => sum + file.size, 0);
  const margin = 1000;
  const statfs = (free) => (free === null ? () => { throw new Error('no statfs'); } : () => ({ bavail: free, bsize: 1 }));
  for (const [free, ok] of [[total + margin - 1, false], [total + margin, true], [null, true]]) {
    const env = setup(t, { fsImpl: { ...fs, statfsSync: statfs(free) }, limits: { freeSpaceMarginBytes: margin } });
    const result = await env.start();
    assert.equal(result.ok, ok, `free ${free}`);
    if (!ok) assert.deepEqual([result, filesIn(env.root)], [{ ok: false, reason: 'model_no_space' }, []]);
  }
});

test('the disk filling mid transfer pauses with model_no_space, keeps staging, and resumes', async (t) => {
  let free = 1e12;
  const env = setup(t, {
    fsImpl: { ...fs, statfsSync: () => ({ bavail: free, bsize: 1 }) },
    stepHook: async (name, detail) => {
      if (name === 'segment' && detail.file === 0 && detail.segment === 0) free = 10;
    },
  });
  const paused = await env.start();
  assert.deepEqual([paused.state, paused.reason], ['paused', 'model_no_space']);
  assert.deepEqual(env.transport.calls.find((c) => c[0] === 'pause')[1], { offerId: 'offer_abc', reason: 'model_no_space' });
  assert.deepEqual(filesIn(env.root), ['.jenny-incoming']);
  free = 1e12;
  const done = await env.receiver.resume();
  assert.equal(done.state, 'complete', JSON.stringify(done));
  assert.deepEqual(env.transport.calls.find((c) => c[0] === 'resume')[1].startPoints[0], { file: 0, offset: fx.SEG });
});

test('a write that fails before its first byte leaves an empty file that a resume removes', async (t) => {
  const io = createTransferIo();
  let failed = false;
  const transferIo = {
    ...io,
    writeAt: async (file, offset, bytes) => {
      if (!failed && offset === 0) {
        failed = true;
        fs.writeFileSync(file, '', { flag: 'wx' });
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return io.writeAt(file, offset, bytes);
    },
  };
  const env = setup(t, { extra: { transferIo } });
  const paused = await env.start();
  assert.deepEqual([paused.state, paused.reason], ['paused', 'model_no_space']);
  assert.equal(fs.statSync(path.join(env.incoming, fs.readdirSync(env.incoming)[0], '0.part')).size, 0);
  const done = await env.receiver.resume();
  assert.equal(done.state, 'complete', JSON.stringify(done));
});

test('a bad segment is re-pulled up to the retries, then the transfer fails and staging is removed', async (t) => {
  const bad = (file, offset, part) => (file === 0 && offset === fx.SEG ? Buffer.alloc(part.length, 7) : part);
  const env = setup(t, { transportOptions: { corrupt: bad } });
  const result = await env.start();
  assert.deepEqual([result.state, result.reason], ['failed', 'model_hash_mismatch']);
  assert.equal(env.transport.calls.filter((c) => c[0] === 'takePart' && c[1].file === 0 && c[1].offset === fx.SEG).length, 3);
  assert.deepEqual(env.transport.calls.find((c) => c[0] === 'cancel')[1], { offerId: 'offer_abc', reason: 'model_hash_mismatch' });
  assert.deepEqual([filesIn(env.incoming), fs.existsSync(env.familyDir)], [[], false]);
});

test('a segment bad twice and good on the third pull, and a short part, are placed correctly', async (t) => {
  const twice = (file, offset, part, pull) => (file === 0 && offset === fx.SEG && pull <= 2 ? Buffer.alloc(part.length, 7) : part);
  const short = (file, offset, part, pull) => (file === 2 && offset === 0 && pull === 1 ? part.subarray(1) : part);
  for (const corrupt of [twice, short]) {
    const env = setup(t, { transportOptions: { corrupt } });
    assert.equal((await env.start()).state, 'complete');
    assert.ok(fs.readFileSync(path.join(env.familyDir, MAIN)).equals(env.bytes[0]));
  }
});

test('whole-file checks: a wrong digest, a short file, not a GGUF header on the main model, a shard or a companion', async (t) => {
  const cut = async (name, detail, env) => {
    if (name === 'segment' && detail.file === 0 && detail.segment === 3) {
      fs.truncateSync(path.join(env.incoming, fs.readdirSync(env.incoming)[0], '0.part'), 3 * fx.SEG + 100);
    }
  };
  const notGguf = (index, specs = fx.MODEL_FILES) => specs.map((spec, i) => (i === index ? { ...spec, gguf: false } : spec));
  const cases = [
    ['wrong digest', { hasher: fx.fakeHasher({ wrong: (r) => ({ ...r, sha256: '0'.repeat(64) }) }) }, 'model_hash_mismatch'],
    ['short file', { stepHook: cut }, 'model_hash_mismatch'],
    ['main not gguf', { specs: notGguf(0) }, 'model_not_gguf'],
    ['companion not gguf', { specs: notGguf(1) }, 'model_not_gguf'],
    ['shard not gguf', { specs: notGguf(1, fx.SHARD_FILES) }, 'model_not_gguf'],
  ];
  for (const [label, options, reason] of cases) {
    const env = setup(t, options);
    const result = await env.start();
    assert.deepEqual([result.state, result.reason], ['failed', reason], label);
    assert.deepEqual([filesIn(env.incoming), fs.existsSync(env.familyDir)], [[], false], label);
  }
});

test('a folder that appears at the planned name mid placement is never joined: the set takes the next one', async (t) => {
  for (const existing of [false, true]) {
    let planned = '';
    const env = setup(t, {
      stepHook: async (name, detail, self) => {
        if (name !== 'moved' || detail.index !== 1) return;
        planned = self.receiver.folder();
        fs.mkdirSync(path.join(self.root, planned));
        fs.writeFileSync(path.join(self.root, planned, MAIN), 'theirs');
      },
    });
    if (existing) fs.mkdirSync(env.familyDir);
    const result = await env.start();
    const next = existing ? 'Qwen3-8B-3' : 'Qwen3-8B-2';
    assert.deepEqual([result.state, planned], ['complete', existing ? 'Qwen3-8B-2' : 'Qwen3-8B'], JSON.stringify(result));
    assert.deepEqual([filesIn(path.join(env.root, planned)), fs.readFileSync(path.join(env.root, planned, MAIN), 'utf8')], [[MAIN], 'theirs']);
    assert.ok(fs.readFileSync(path.join(env.root, next, MAIN)).equals(env.bytes[0]));
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.root, next, `${MAIN}.jenny-source.json`), 'utf8')).folder, next);
    assert.deepEqual(filesIn(env.incoming), []);
  }
});

test('a rollback that fails keeps the journal and staging; the next start finishes it', async (t) => {
  let failLinks = false;
  const fsImpl = { ...fs, linkSync: (...rest) => (failLinks ? (() => { throw Object.assign(new Error('x'), { code: 'EIO' }); })() : fs.linkSync(...rest)) };
  const taken = ['Qwen3-8B', ...Array.from({ length: 15 }, (_, n) => `Qwen3-8B-${n + 2}`)];
  const env = setup(t, {
    fsImpl,
    stepHook: async (name, detail, self) => {
      if (name !== 'moved' || detail.index !== 3 || failLinks) return;
      for (const folder of taken) fs.mkdirSync(path.join(self.root, folder)); // every folder of the rule is taken
      failLinks = true;
    },
  });
  const result = await env.start();
  assert.deepEqual([result.state, result.reason], ['failed', 'model_exists']);
  assert.equal(filesIn(env.incoming).length, 1, 'staging kept');
  assert.ok(env.logs.some((entry) => entry[1] === 'team.model.receive_rollback_kept'));
  const id = filesIn(env.incoming)[0];
  const read = readJournal(path.join(env.incoming, id), { id, segmentBytes: fx.SEG, maxBytes: 80 * 1024, validate: fx.testValidator() });
  assert.equal(read.journal.phase, 'rollback');
  failLinks = false;
  const again = await env.make().start({ offer: env.offer, root: env.root });
  assert.deepEqual([again.state, again.reason], ['failed', 'model_exists']);
  assert.deepEqual([taken.flatMap((folder) => filesIn(path.join(env.root, folder))), filesIn(env.incoming)], [[], []]);
});

test('a staged file changed after its check is refused before placement (model_journal_invalid)', async (t) => {
  const env = setup(t, {
    stepHook: async (name, _detail, self) => {
      if (name === 'placing') fs.truncateSync(path.join(self.incoming, fs.readdirSync(self.incoming)[0], '1.part'), 10);
    },
  });
  const result = await env.start();
  assert.deepEqual([result.state, result.reason], ['failed', 'model_journal_invalid']);
  assert.deepEqual([filesIn(env.incoming), fs.existsSync(env.familyDir)], [[], false]);
});

test('no write through a link: root, .jenny-incoming, staging folder and family folder', async (t) => {
  for (const kind of [process.platform === 'win32' ? 'junction' : 'dir', 'dir']) {
    const at = {
      root: (env, real) => (fx.linkDir(real, path.join(env.base, 'linked-root'), kind)
        ? { root: path.join(env.base, 'linked-root'), roots: [path.join(env.base, 'linked-root')] } : null),
      incoming: (env, real) => (fx.linkDir(real, env.incoming, kind) ? {} : null),
      staging: (env, real) => {
        fs.mkdirSync(env.incoming);
        const id = transferIdFor({ teamId: 'team_t1', senderId: 'member_m1', manifest: env.offer.manifest });
        return fx.linkDir(real, path.join(env.incoming, id), kind) ? {} : null;
      },
      family: (env, real) => (fx.linkDir(real, env.familyDir, kind) ? {} : null),
    };
    for (const [label, arrange] of Object.entries(at)) {
      const env = setup(t);
      const real = path.join(env.base, 'elsewhere');
      fs.mkdirSync(real);
      const arranged = arrange(env, real);
      if (!arranged) {
        t.diagnostic(`${kind} at ${label}: this machine refused the link; not run`);
        continue;
      }
      const receiver = arranged.roots ? env.make({ roots: () => arranged.roots }) : env.receiver;
      const result = await receiver.start({ offer: env.offer, root: arranged.root || env.root });
      assert.deepEqual(result, { ok: false, reason: 'model_destination_invalid' }, `${kind} at ${label}`);
      assert.deepEqual([filesIn(real), env.transport.calls.length], [[], 0], `${kind} at ${label}`);
    }
  }
});

test('a family folder swapped for a link before placement is refused and nothing lands through it', async (t) => {
  const env = setup(t, {
    stepHook: async (name, _detail, self) => {
      if (name !== 'placing') return;
      fs.mkdirSync(path.join(self.base, 'elsewhere'));
      if (!fx.linkDir(path.join(self.base, 'elsewhere'), self.familyDir)) throw new Error('link refused');
    },
  });
  const result = await env.start();
  assert.deepEqual([result.state, result.reason], ['failed', 'model_destination_invalid']);
  assert.deepEqual(filesIn(path.join(env.base, 'elsewhere')), []);
});

test('bounds: the provenance file at its limit and one past; 16 staging entries (stray files count) and 15', async (t) => {
  const env = setup(t);
  const bytes = provenanceBytes(env.offer);
  assert.equal((await env.make({ limits: { ...fx.LIMITS, provenanceFileBytes: bytes } }).start({ offer: env.offer, root: env.root })).state, 'complete');
  const env2 = setup(t);
  assert.deepEqual(await env2.make({ limits: { ...fx.LIMITS, provenanceFileBytes: bytes - 1 } }).start({ offer: env2.offer, root: env2.root }),
    { ok: false, reason: 'model_manifest_invalid' });
  for (const [count, ok] of [[16, false], [15, true]]) {
    const env3 = setup(t);
    fs.mkdirSync(env3.incoming);
    for (let index = 0; index < count; index += 1) {
      if (index % 2) fs.writeFileSync(path.join(env3.incoming, `stray-${index}`), 'x');
      else fs.mkdirSync(path.join(env3.incoming, `t${String(index).padStart(32, '0')}`));
    }
    const result = await env3.start();
    assert.equal(result.ok, ok, `${count} entries`);
    if (!ok) assert.deepEqual(result, { ok: false, reason: 'model_staging_failed' });
  }
});

async function heldRun(t, options = {}) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = setup(t, { ...options, transportOptions: { gate, ...options.transportOptions } });
  const timersBefore = timers();
  const running = env.start();
  await fx.until(() => env.transport.count('takePart') > 0);
  return { env, running, release, timersBefore };
}

test('pause keeps staging and tells the transport; resume restarts from the verified start points', async (t) => {
  const { env, running, release, timersBefore } = await heldRun(t);
  assert.deepEqual(await env.start(), { ok: false, reason: 'model_receiver_busy' }, 'one incoming transfer at a time');
  assert.deepEqual(await env.receiver.pause(), { ok: true, state: 'paused' });
  assert.equal((await running).state, 'paused');
  assert.deepEqual(env.transport.calls.find((c) => c[0] === 'pause')[1], { offerId: 'offer_abc', reason: 'paused' });
  assert.deepEqual([filesIn(env.incoming).length, env.receiver.resources(), timers()], [1, { handles: 0, active: 1 }, timersBefore]);
  assert.equal(env.logs.some((entry) => entry[1] === 'team.model.receive_transport_failed'), false, 'an aborted part is not a transport failure');
  env.transport.gate = null;
  release();
  assert.equal((await env.receiver.resume()).state, 'complete');
  assert.deepEqual(env.transport.calls.find((c) => c[0] === 'resume')[1].startPoints, [0, 1, 2].map((file) => ({ file, offset: 0 })));
});

test('cancel removes staging and tells the transport; running or paused', async (t) => {
  for (const pauseFirst of [false, true]) {
    const { env, running, timersBefore } = await heldRun(t);
    if (pauseFirst) await env.receiver.pause();
    assert.equal((await env.receiver.cancel()).ok, true);
    assert.deepEqual(env.transport.calls.find((c) => c[0] === 'cancel')[1], { offerId: 'offer_abc', reason: 'cancelled' });
    assert.deepEqual([filesIn(env.incoming), env.receiver.resources(), timers()], [[], { handles: 0, active: 0 }, timersBefore]);
    assert.equal((await running).state, pauseFirst ? 'paused' : 'cancelled');
  }
});

test('dispose (Force local, sharing off) sends nothing, keeps staging and refuses new work', async (t) => {
  const { env, running, timersBefore } = await heldRun(t);
  const callsBefore = env.transport.calls.length;
  assert.deepEqual(await env.receiver.dispose(), { ok: true });
  assert.equal((await running).state, 'disposed');
  assert.deepEqual([env.transport.calls.length, filesIn(env.incoming).length, timers()], [callsBefore, 1, timersBefore]);
  const refused = { ok: false, reason: 'model_receiver_disposed' };
  assert.deepEqual([await env.start(), await env.receiver.resume(), env.receiver.status().state], [refused, refused, 'disposed']);
});

test('stops asked for during the accept checks: dispose and cancel send nothing; pause then resume accepts', async (t) => {
  for (const kind of ['dispose', 'cancel', 'pause']) {
    const env = setup(t);
    const running = env.start();
    const stopped = env.receiver[kind]();
    const result = await running;
    await stopped;
    assert.equal(result.state, { dispose: 'disposed', cancel: 'cancelled', pause: 'paused' }[kind], kind);
    assert.equal(env.transport.calls.length, 0, kind);
    assert.equal(filesIn(env.incoming).length, kind === 'cancel' ? 0 : 1, kind);
    if (kind === 'pause') {
      assert.equal((await env.receiver.resume()).state, 'complete');
      assert.equal(env.transport.count('accept'), 1);
    }
  }
});

test('dispose during placement stops after the move in hand: no complete is sent, and a restart finishes', async (t) => {
  let disposing = null;
  const env = setup(t, {
    stepHook: async (name, detail, self) => {
      if (name === 'moved' && detail.index === 0 && !disposing) disposing = self.receiver.dispose();
    },
  });
  const result = await env.start();
  assert.equal((await disposing, result.state), 'disposed');
  assert.deepEqual([env.transport.count('complete'), env.receiver.resources().handles], [0, 0]);
  assert.deepEqual(await tags(env), []);
  assert.equal((await env.make().start({ offer: env.offer, root: env.root })).state, 'complete');
  // Asked for after the last move: the set is placed, and still nothing is sent.
  let late = null;
  const env2 = setup(t, { stepHook: async (name, _d, self) => { if (name === 'renamed') late = self.receiver.dispose(); } });
  assert.equal((await env2.start()).state, 'complete');
  assert.equal((await late, env2.transport.count('complete')), 0);
});

test('a stop flag set during a pause is not carried into the next run (a later mismatch still fails)', async (t) => {
  let free = 1e12;
  let corruptAll = false;
  let releasePause;
  const pauseGate = new Promise((resolve) => { releasePause = resolve; });
  const env = setup(t, {
    fsImpl: { ...fs, statfsSync: () => ({ bavail: free, bsize: 1 }) },
    transportOptions: { corrupt: (file, offset, part) => (corruptAll ? Buffer.alloc(part.length) : part) },
    stepHook: async (name) => {
      if (name === 'segment') free = 10;
    },
  });
  const pause = env.transport.pause;
  env.transport.pause = async (payload) => { await pauseGate; return pause(payload); };
  const running = env.start();
  // The disk-full pause is waiting on the transport: a user pause arrives meanwhile and sets the flag.
  await fx.until(() => free === 10 && env.receiver.status().state === 'pulling');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stop = env.receiver.pause();
  releasePause();
  await running;
  await stop;
  free = 1e12;
  corruptAll = true;
  const result = await env.receiver.resume();
  assert.deepEqual([result.state, result.reason], ['failed', 'model_hash_mismatch']);
  assert.deepEqual(filesIn(env.incoming), []);
});

test('a hung accept does not hold pause; a hung best-effort call is bounded', async (t) => {
  const env = setup(t, { transportOptions: { hang: ['accept', 'pause', 'cancel'] }, limits: { quietCallMs: 30 } });
  const timersBefore = timers();
  const running = env.start();
  await fx.until(() => env.transport.count('accept') > 0);
  assert.deepEqual(await env.receiver.pause(), { ok: true, state: 'paused' });
  assert.equal((await running).state, 'paused');
  assert.equal((await env.receiver.cancel()).ok, true);
  assert.deepEqual([filesIn(env.incoming), timers()], [[], timersBefore]);
  assert.equal(env.logs.filter((entry) => entry[2]?.code === 'quiet_call_timeout').length, 2);
});

test('pause during whole-file verification aborts the hash and leaves no hash running', async (t) => {
  let running = 0;
  const hasher = {
    hash: (_file, { signal }) => new Promise((_resolve, reject) => {
      running += 1;
      signal.addEventListener('abort', () => {
        running -= 1;
        reject(Object.assign(new Error('model_hash_aborted'), { code: 'model_hash_aborted' }));
      }, { once: true });
    }),
  };
  const env = setup(t, { hasher });
  const run = env.start();
  await fx.until(() => running === 1);
  assert.deepEqual(await env.receiver.pause(), { ok: true, state: 'paused' });
  assert.deepEqual([(await run).state, running, env.receiver.resources().handles], ['paused', 0, 0]);
  await env.receiver.cancel();
});

test('progress comes per part, at most once per interval of the injected clock', async (t) => {
  let now = 0;
  const env = setup(t, { extra: { clock: () => now }, stepHook: async (name) => { if (name === 'part') now += 300; } });
  assert.equal((await env.start()).state, 'complete');
  const ends = new Set([0]);
  let total = 0;
  for (const file of env.offer.manifest.files) for (let at = 0; at < file.size; at += fx.SEG) ends.add(total += Math.min(fx.SEG, file.size - at));
  const mid = env.events.filter((event) => event.state === 'pulling' && !ends.has(event.doneBytes));
  const parts = env.offer.manifest.files.reduce((sum, file) => sum + Math.ceil(file.size / fx.PART), 0);
  assert.ok(mid.length > 3 && mid.length < parts / 1.5, `${mid.length} of ${parts}`);
});

test('redaction: no name, path, hash, licence text, URL or sender name in any log, event or refusal', async (t) => {
  const specs = [{ name: 'MARKERNAME-Q4_K_M.gguf', size: fx.SEG + 10 }, { name: 'mmproj-MARKERNAME-F16.gguf', size: 3000 }];
  const offerOverrides = { licence: 'MARKERLICENCE text', sourceUrl: 'https://marker.example/MARKERURL', note: 'MARKERNOTE' };
  const exists = async (name, _d, self) => {
    if (name === 'moved') {
      fs.mkdirSync(self.familyDir, { recursive: true });
      fs.writeFileSync(path.join(self.familyDir, 'MARKERNAME-Q4_K_M.gguf'), 'x');
    }
  };
  const runs = [
    {},
    { transportOptions: { corrupt: (file, offset, part) => (file === 0 ? Buffer.alloc(part.length) : part) } },
    { hasher: fx.fakeHasher({ wrong: (r) => ({ ...r, sha256: 'f'.repeat(64) }) }) },
    { fsImpl: { ...fs, statfsSync: () => ({ bavail: 1, bsize: 1 }) } },
    { transportOptions: { reject: { takePart: Object.assign(new Error('MARKER C:\\x'), { code: 'MARKER_CODE C:\\MARKERDIR' }) } } },
    { stepHook: exists },
    { stepHook: async (name, _d, self) => { if (name === 'placing') fs.truncateSync(path.join(self.incoming, fs.readdirSync(self.incoming)[0], '1.part'), 1); } },
  ];
  for (const options of runs) {
    const env = setup(t, { specs, offerOverrides, ...options });
    env.offer.sender.displayName = 'MARKERSENDER';
    const outputs = [await env.start(), await env.start({ root: path.join(env.base, 'MARKERDIR') })];
    outputs.push(await env.start({ offer: { ...env.offer, manifest: { ...env.offer.manifest, files: [] } } }));
    const id = transferIdFor({ teamId: 'team_t1', senderId: 'member_m1', manifest: env.offer.manifest });
    fs.mkdirSync(path.join(env.incoming, id), { recursive: true });
    fs.writeFileSync(path.join(env.incoming, id, 'journal.json'), '{bad');
    outputs.push(await env.make().start({ offer: env.offer, root: env.root }), env.logs, env.events);
    const text = JSON.stringify(outputs);
    const markers = ['MARKER', env.root, env.base, ...env.offer.manifest.files.flatMap((f) => [f.sha256, ...f.segments])];
    for (const marker of markers) {
      assert.equal(text.includes(marker) || text.includes(JSON.stringify(marker).slice(1, -1)), false, 'a marker leaked');
    }
    for (const reason of text.match(/"reason":"[a-z_]+"/g) || []) {
      const word = reason.slice(10, -1);
      assert.ok(MODEL_RECEIVE_REASONS.includes(word) || ['paused', 'cancelled'].includes(word), word);
    }
  }
});

test('the receiver loads nothing that dials, loads or selects a model (MI9), one level of requires deep', () => {
  const dir = path.join(__dirname, '..', 'services', 'team');
  const requiresOf = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  const seen = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.startsWith('model-receive'))) {
    for (const spec of requiresOf(path.join(dir, name))) {
      seen.push(spec);
      if (!spec.startsWith('.')) continue;
      const target = require.resolve(path.resolve(dir, spec));
      seen.push(...requiresOf(target));
    }
  }
  const banned = ['http-client', 'team-service', 'ipc-methods', 'client-file', 'lifecycle', 'settings', 'engine', 'electron', 'readiness'];
  for (const word of banned) assert.equal(seen.some((spec) => spec.includes(word)), false, word);
  for (const exact of ['http', 'node:http', 'net', 'node:net', 'child_process', 'node:child_process']) {
    assert.equal(seen.includes(exact), false, exact);
  }
});
