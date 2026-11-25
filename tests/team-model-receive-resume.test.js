'use strict';

// new-test-file: the receiver's resume, interrupt and sweep cases (row 123 slice 6-4); team-model-receive.test.js covers one run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createModelReceiver } = require('../services/team/model-receive');
const { readJournal, transferIdFor, writeJournal } = require('../services/team/model-receive-journal');
const fx = require('./helpers/team-model-receive-fixture');

const never = () => new Promise(() => {});
const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const OTHER = 'Qwen3-8B-Q8_0.gguf';

// `existing`: the family folder holds the receiver's own model, so the set goes into `<family>-2` (the folder rule).
function disk(t, set = 'model', { existing = false } = {}) {
  const { base, root } = fx.makeRoot(t);
  const specs = fx.FILE_SETS[set];
  const { offer, bytes } = fx.buildOffer(specs);
  const id = transferIdFor({ teamId: offer.teamId, senderId: offer.sender.memberId, manifest: offer.manifest });
  const ownDir = path.join(root, set === 'model' ? 'Qwen3-8B' : 'Big');
  const familyDir = existing ? `${ownDir}-2` : ownDir;
  if (existing) {
    fs.mkdirSync(ownDir);
    fs.writeFileSync(path.join(ownDir, OTHER), fx.makeBytes(4000, 'other'));
  }
  const receiver = ({ stepHook = null, hasher = fx.fakeHasher(), transportOptions, clock = Date.now } = {}) => {
    const transport = fx.fakeTransport(bytes, transportOptions);
    const made = createModelReceiver({
      roots: () => [root], transport, hasher, limits: fx.LIMITS, validateManifest: fx.testValidator(), stepHook, clock,
    });
    return { receiver: made, transport };
  };
  const stagingDir = path.join(root, '.jenny-incoming', id);
  return {
    base, root, set, offer, bytes, id, stagingDir, familyDir, ownDir, receiver, existing,
    main: offer.manifest.files[0].name,
    readJournal: () => readJournal(stagingDir, { id, segmentBytes: fx.SEG, maxBytes: 80 * 1024, validate: fx.testValidator() }),
  };
}

// A run that freezes (a simulated crash: no cleanup runs) at the first step `match` accepts.
async function crashAt(env, match, options = {}) {
  let hit = false;
  let reached;
  const cut = new Promise((resolve) => { reached = resolve; });
  const { receiver } = env.receiver({
    ...options,
    stepHook: async (name, detail) => {
      if (!hit && match(name, detail)) {
        hit = true;
        reached();
        await never();
      }
    },
  });
  const run = receiver.start({ offer: env.offer, root: env.root });
  assert.equal(await Promise.race([cut.then(() => 'cut'), run.then((r) => JSON.stringify(r))]), 'cut', 'the cut was reached');
}

// Before completion nothing of the set is listed, and a folder the receiver had only ever lists its own model.
async function assertNoPartialSet(env, { complete = false } = {}) {
  const entries = await fx.discover(env.root, env.base);
  for (const entry of entries) assert.equal(entry.dir.includes('.jenny-incoming'), false, 'staging is never listed');
  if (env.existing) {
    assert.deepEqual(entries.filter((entry) => entry.dir === env.ownDir).map((entry) => entry.mainGguf), [OTHER], 'only the folder\'s own model');
    assert.deepEqual(fs.readdirSync(env.ownDir), [OTHER], 'nothing of the set joins it');
  }
  const whole = env.offer.manifest.files.every((file) => fs.existsSync(path.join(env.familyDir, file.name)));
  if (complete || whole) return;
  assert.deepEqual(entries.filter((entry) => entry.dir === env.familyDir), [], 'the set is not listed before it is whole');
}

async function restartAndFinish(env) {
  const { receiver, transport } = env.receiver();
  const result = await receiver.start({ offer: env.offer, root: env.root });
  assert.equal(result.state, 'complete', JSON.stringify(result));
  env.offer.manifest.files.forEach((file, index) => {
    assert.ok(fs.readFileSync(path.join(env.familyDir, file.name)).equals(env.bytes[index]), file.name);
  });
  assert.deepEqual(filesIn(path.join(env.root, '.jenny-incoming')), []);
  assert.equal(filesIn(env.familyDir).some((name) => /\.jenny-(placing|moving)$/u.test(name)), false);
  const mains = (await fx.discover(env.root, env.base)).map((entry) => entry.mainGguf).sort();
  assert.deepEqual(mains, env.existing ? [env.main, OTHER].sort() : [env.main]);
  return transport;
}

test('a resume never trusts an unsynced tail: staging is cut back to the last verified segment', async (t) => {
  const env = disk(t);
  await crashAt(env, (name, detail) => name === 'part' && detail.file === 0 && detail.offset === fx.SEG + 2 * fx.PART);
  const file = path.join(env.stagingDir, '0.part');
  fs.appendFileSync(file, Buffer.alloc(1234, 9));
  assert.equal(env.readJournal().journal.files[0].verified_segments, 1);
  await assertNoPartialSet(env);
  const transport = await restartAndFinish(env);
  assert.deepEqual(transport.calls.find((c) => c[0] === 'accept')[1].startPoints, [
    { file: 0, offset: fx.SEG }, { file: 1, offset: 0 }, { file: 2, offset: 0 },
  ]);
  assert.equal(transport.calls.some((c) => c[0] === 'takePart' && c[1].file === 0 && c[1].offset < fx.SEG), false);
});

const PULL_CUTS = [
  ['mid part, first part of the first file', (name, d) => name === 'part' && d.file === 0 && d.offset === fx.PART],
  ['mid segment', (name, d) => name === 'part' && d.file === 0 && d.offset === fx.SEG + fx.PART],
  ['at a segment end', (name, d) => name === 'segment' && d.file === 0 && d.segment === 1],
  ['after the last part', (name, d) => name === 'segment' && d.file === 2 && d.segment === 1],
  ['after a file verified', (name, d) => name === 'verified' && d.file === 0],
  ['after the last file verified', (name, d) => name === 'verified' && d.file === 2],
  ['before placement', (name) => name === 'placing'],
];

for (const [label, match] of PULL_CUTS) {
  test(`a cut ${label} resumes to a correct, complete set`, async (t) => {
    const env = disk(t);
    await crashAt(env, match);
    await assertNoPartialSet(env);
    await restartAndFinish(env);
  });
}

test('a cut during the whole-file hash resumes and hashes again', async (t) => {
  const env = disk(t);
  let calls = 0;
  const { receiver } = env.receiver({ hasher: { hash: () => { calls += 1; return never(); } } });
  receiver.start({ offer: env.offer, root: env.root });
  await fx.until(() => calls > 0);
  await assertNoPartialSet(env);
  await restartAndFinish(env);
});

// Real cuts: a child process runs the transfer and ends itself before or after each placement move.
async function pool(jobs, size = 6) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await jobs[index]();
    }
  }));
  return results;
}

for (const [set, existing] of [['model', false], ['shards', false], ['model', true]]) {
  test(`real cuts at every placement move (${set}, ${existing ? 'existing' : 'new'} family folder) never show a partial set`, async (t) => {
    const probe = disk(t, set, { existing });
    const whole = await fx.runCutChild({ root: probe.root, set, op: 0, when: 'none' });
    assert.equal(whole.state, 'complete');
    assert.ok(whole.ops >= 13, `${whole.ops} moves`);
    const cuts = [];
    for (let op = 1; op <= whole.ops; op += 1) for (const when of ['before', 'after']) cuts.push({ op, when });
    const outcomes = await pool(cuts.map((cut) => async () => {
      const env = disk(t, set, { existing });
      const ran = await fx.runCutChild({ root: env.root, set, ...cut });
      assert.equal(ran.cut, true, `${cut.when} move ${cut.op}`);
      await assertNoPartialSet(env);
      await restartAndFinish(env);
      return true;
    }));
    assert.equal(outcomes.length, cuts.length);
  });
}

test('a real cut mid placement and the folder taken before restart: the set goes into the next folder, theirs untouched', async (t) => {
  const env = disk(t);
  assert.equal((await fx.runCutChild({ root: env.root, set: 'model', op: 6, when: 'after' })).cut, true);
  fs.mkdirSync(env.familyDir);
  fs.writeFileSync(path.join(env.familyDir, env.main), 'theirs');
  const { receiver, transport } = env.receiver();
  const result = await receiver.start({ offer: env.offer, root: env.root });
  assert.equal(result.state, 'complete', JSON.stringify(result));
  assert.deepEqual([filesIn(env.familyDir), fs.readFileSync(path.join(env.familyDir, env.main), 'utf8')], [[env.main], 'theirs']);
  const next = `${env.familyDir}-2`;
  env.offer.manifest.files.forEach((file, index) => assert.ok(fs.readFileSync(path.join(next, file.name)).equals(env.bytes[index])));
  assert.equal(JSON.parse(fs.readFileSync(path.join(next, `${env.main}.jenny-source.json`), 'utf8')).folder, 'Qwen3-8B-2');
  assert.deepEqual(filesIn(path.join(env.root, '.jenny-incoming')), []);
  assert.equal(transport.count('cancel'), 0);
});

test('a placed item whose file is gone is model_journal_invalid; the rest is taken back and staging removed', async (t) => {
  const env = disk(t, 'model', { existing: true });
  await crashAt(env, (name, d) => name === 'moved' && d.index === 1);
  fs.rmSync(path.join(env.stagingDir, 'set', env.offer.manifest.files[1].name));
  const { receiver } = env.receiver();
  const result = await receiver.start({ offer: env.offer, root: env.root });
  assert.deepEqual([result.state, result.reason], ['failed', 'model_journal_invalid']);
  assert.deepEqual([filesIn(env.ownDir), fs.existsSync(env.familyDir)], [[OTHER], false]);
  assert.deepEqual(filesIn(path.join(env.root, '.jenny-incoming')), []);
});

test('an invalid journal is model_journal_invalid and its staging folder is removed', async (t) => {
  const cases = [
    ['does not parse', 'refused', (env) => fs.writeFileSync(path.join(env.stagingDir, 'journal.json'), '{nope')],
    ['breaks a rule', 'refused', (env) => {
      fs.writeFileSync(path.join(env.stagingDir, 'journal.json'), JSON.stringify({ ...env.readJournal().journal, extra: 1 }));
    }],
    ['does not match the offer', 'refused', (env) => {
      const { journal } = env.readJournal();
      journal.sender.member_id = 'member_someone_else';
      writeJournal(env.stagingDir, journal, { maxBytes: 80 * 1024 });
    }],
    ['claims more than the file holds', 'failed', (env) => fs.truncateSync(path.join(env.stagingDir, '0.part'), fx.SEG - 1)],
    ['has a staging file that is a folder', 'failed', (env) => {
      fs.rmSync(path.join(env.stagingDir, '0.part'));
      fs.mkdirSync(path.join(env.stagingDir, '0.part'));
    }],
  ];
  for (const [label, expected, spoil] of cases) {
    const env = disk(t);
    await crashAt(env, (name, d) => name === 'segment' && d.file === 0 && d.segment === 1);
    spoil(env);
    const { receiver, transport } = env.receiver();
    const result = await receiver.start({ offer: env.offer, root: env.root });
    if (expected === 'refused') {
      assert.deepEqual([result, transport.calls.length], [{ ok: false, reason: 'model_journal_invalid' }, 0], label);
    } else {
      assert.deepEqual([result.state, result.reason, transport.count('cancel')], ['failed', 'model_journal_invalid', 1], label);
    }
    assert.deepEqual([filesIn(path.join(env.root, '.jenny-incoming')), fs.existsSync(env.familyDir)], [[], false], label);
  }
});

test('a staging folder with no journal (a cut before the first write) starts fresh', async (t) => {
  const env = disk(t);
  fs.mkdirSync(env.stagingDir, { recursive: true });
  fs.writeFileSync(path.join(env.stagingDir, '0.part'), 'stray');
  await restartAndFinish(env);
});

test('bounds: a journal at its byte limit reads, one byte past does not; the stage list at its length and one past', async (t) => {
  const env = disk(t);
  await crashAt(env, (name, d) => name === 'moved' && d.index === 0);
  const size = fs.statSync(path.join(env.stagingDir, 'journal.json')).size;
  const read = (maxBytes) => readJournal(env.stagingDir, { id: env.id, segmentBytes: fx.SEG, maxBytes, validate: fx.testValidator() });
  assert.deepEqual([read(size).ok, read(size - 1).ok], [true, false]);
  const { journal } = read(size);
  assert.throws(() => writeJournal(env.stagingDir, journal, { maxBytes: size - 1 }), { code: 'journal_too_large' });
  assert.equal(journal.placement.stages.length, env.offer.manifest.files.length + 1);
  writeJournal(env.stagingDir, { ...journal, placement: { ...journal.placement, stages: [...journal.placement.stages, 0] } }, { maxBytes: size + 10 });
  assert.equal(read(size + 10).ok, false);
});

test('the 7-day sweep: one millisecond before stays, at it goes, a future stamp goes, junk children go', async (t) => {
  const env = disk(t);
  await crashAt(env, (name) => name === 'segment');
  const updated = env.readJournal().journal.updated_at;
  const week = 7 * 24 * 60 * 60 * 1000;
  const incoming = path.join(env.root, '.jenny-incoming');
  fs.mkdirSync(path.join(incoming, 'not-a-transfer'));
  fs.writeFileSync(path.join(incoming, 'stray-file'), 'x');
  fs.mkdirSync(path.join(incoming, `t${'a'.repeat(32)}`));
  const outside = path.join(env.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.gguf'), 'keep');
  const linked = fx.linkDir(outside, path.join(incoming, `t${'b'.repeat(32)}`));
  const { receiver } = env.receiver();
  assert.equal((await receiver.sweep(updated + week - 1)).removed, linked ? 4 : 3);
  assert.deepEqual([filesIn(incoming), filesIn(outside)], [[env.id], ['keep.gguf']]);
  assert.deepEqual(await receiver.sweep(updated - 1), { ok: true, removed: 1 }, 'a stamp in the future counts as expired');
  const again = disk(t);
  await crashAt(again, (name) => name === 'segment');
  const stamp = again.readJournal().journal.updated_at;
  assert.deepEqual(await again.receiver().receiver.sweep(stamp + week), { ok: true, removed: 1 });
});

test('the sweep rolls an expired placement back from its journal before removing it', async (t) => {
  const env = disk(t, 'model', { existing: true });
  await crashAt(env, (name, d) => name === 'moved' && d.index === 2);
  assert.ok(filesIn(path.join(env.stagingDir, 'set')).includes(env.offer.manifest.files[1].name));
  const updated = env.readJournal().journal.updated_at;
  assert.deepEqual(await env.receiver().receiver.sweep(updated + 7 * 24 * 60 * 60 * 1000), { ok: true, removed: 1 });
  assert.deepEqual([filesIn(env.ownDir), fs.existsSync(env.familyDir)], [[OTHER], false]);
  assert.deepEqual(filesIn(path.join(env.root, '.jenny-incoming')), []);
});

test('R14-F07: a journal folder outside the folder rule is invalid, so the sweep never joins it to the root', async (t) => {
  const env = disk(t);
  await crashAt(env, (name, d) => name === 'moved' && d.index === 0);
  const { journal } = env.readJournal();
  const withFolder = (folder) => writeJournal(env.stagingDir, { ...journal, folder }, { maxBytes: 80 * 1024 });
  for (const folder of ['..\\x', '../x', 'a/b', 'Qwen3-8B/..', '.hidden', 'Other', '', 'Qwen3-8B-1', 'Qwen3-8B-17', 'CON']) {
    withFolder(folder);
    assert.equal(env.readJournal().ok, false, JSON.stringify(folder));
  }
  for (const folder of ['Qwen3-8B', 'Qwen3-8B-2', 'Qwen3-8B-16']) {
    withFolder(folder);
    assert.equal(env.readJournal().ok, true, folder);
  }
  const escape = path.join(env.base, 'escape');
  fs.mkdirSync(escape);
  fs.writeFileSync(path.join(escape, env.main), 'keep');
  withFolder('../escape');
  assert.deepEqual(await env.receiver().receiver.sweep(Number.MAX_SAFE_INTEGER), { ok: true, removed: 1 });
  assert.deepEqual([filesIn(escape), filesIn(path.join(env.root, '.jenny-incoming'))], [[env.main], []]);
});

test('the sweep skips the transfer in progress and a .jenny-incoming that is a link', async (t) => {
  const env = disk(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { receiver, transport } = env.receiver({ transportOptions: { gate } });
  const running = receiver.start({ offer: env.offer, root: env.root });
  await fx.until(() => transport.count('takePart') > 0);
  assert.deepEqual(await receiver.sweep(Number.MAX_SAFE_INTEGER), { ok: true, removed: 0 });
  transport.gate = null;
  release();
  assert.equal((await running).state, 'complete');
  const other = disk(t);
  const target = path.join(other.base, 'target');
  fs.mkdirSync(path.join(target, 'tzzz'), { recursive: true });
  if (fx.linkDir(target, path.join(other.root, '.jenny-incoming'))) {
    assert.deepEqual(await other.receiver().receiver.sweep(Number.MAX_SAFE_INTEGER), { ok: true, removed: 0 });
    assert.deepEqual(filesIn(target), ['tzzz']);
  }
});

// Every open of `file` throws an operating-system error with `code` until the returned function is called.
function failOpens(t, file, code) {
  const realOpen = fs.openSync;
  fs.openSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(file)) throw Object.assign(new Error(`${code}: held`), { code });
    return realOpen(target, ...rest);
  };
  const restore = () => { fs.openSync = realOpen; };
  t.after(restore);
  return restore;
}

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const journalSpoils = (t) => [
  ...['EBUSY', 'EPERM', 'EACCES', 'EMFILE'].map((code) => [code, (env) => failOpens(t, path.join(env.stagingDir, 'journal.json'), code)]),
  ['a newer schema', (env) => {
    const file = path.join(env.stagingDir, 'journal.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), schema: 2 }));
    return () => {
      const { schema: _schema, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ schema: 1, ...rest }));
    };
  }],
];

test('X4b-F05: a journal that does not read for a passing reason, or is newer, keeps its staging (sweep, discard, accept)', async (t) => {
  for (const [label, spoil] of journalSpoils(t)) {
    const env = disk(t);
    await crashAt(env, (name, d) => name === 'segment' && d.file === 0 && d.segment === 1);
    const { updated_at: updated, files: [{ verified_segments: verified }] } = env.readJournal().journal;
    assert.ok(verified > 0, 'verified parts on disk');
    const kept = filesIn(env.stagingDir);
    const restore = spoil(env);
    const stamp = fs.statSync(path.join(env.stagingDir, 'journal.json')).mtimeMs;
    const { receiver, transport } = env.receiver();
    assert.deepEqual(await receiver.sweep(updated + 60 * 1000), { ok: true, removed: 0 }, `${label}: a minute old`);
    assert.deepEqual(await receiver.sweep(stamp + THIRTY_DAYS - 1), { ok: true, removed: 0 }, `${label}: cannot be judged, under 30 days`);
    assert.deepEqual(await receiver.discard({ offer: env.offer, root: env.root }), { ok: false, reason: 'model_staging_failed' }, label);
    assert.deepEqual(await receiver.start({ offer: env.offer, root: env.root }), { ok: false, reason: 'model_staging_failed' }, label);
    assert.deepEqual([filesIn(env.stagingDir), transport.calls.length], [kept, 0], `${label}: staging and verified parts kept`);
    restore();
    const after = await restartAndFinish(env);
    assert.deepEqual(after.calls.find((c) => c[0] === 'accept')[1].startPoints[0], { file: 0, offset: verified * fx.SEG }, label);
  }
});

test('E74: staging kept for a journal that cannot be judged is swept once 30 days have passed since its last change', async (t) => {
  for (const [label, spoil] of journalSpoils(t)) {
    const env = disk(t);
    await crashAt(env, (name, d) => name === 'segment' && d.file === 0 && d.segment === 1);
    spoil(env);
    const stamp = fs.statSync(path.join(env.stagingDir, 'journal.json')).mtimeMs;
    const { receiver } = env.receiver();
    assert.deepEqual(await receiver.sweep(stamp + THIRTY_DAYS - 1), { ok: true, removed: 0 }, `${label}: just under 30 days`);
    assert.equal(fs.existsSync(env.stagingDir), true, `${label}: kept just under 30 days`);
    assert.deepEqual(await receiver.sweep(stamp + THIRTY_DAYS), { ok: true, removed: 1 }, `${label}: exactly 30 days`);
    assert.equal(fs.existsSync(env.stagingDir), false, `${label}: removed at 30 days`);
    // A stamp ahead of the clock (a clock set back, a synced folder) is not 30 days old: kept (review pass).
    const back = disk(t);
    await crashAt(back, (name, d) => name === 'segment' && d.file === 0 && d.segment === 1);
    spoil(back);
    const stampBack = fs.statSync(path.join(back.stagingDir, 'journal.json')).mtimeMs;
    assert.deepEqual(await back.receiver().receiver.sweep(stampBack - 60 * 1000), { ok: true, removed: 0 }, `${label}: clock set back`);
    assert.equal(fs.existsSync(back.stagingDir), true, `${label}: kept under a clock set back`);
  }
});

test('E74: a journal that cannot be read or stat-ed is aged by its folder', async (t) => {
  const env = disk(t);
  await crashAt(env, (name, d) => name === 'segment' && d.file === 0 && d.segment === 1);
  const file = path.join(env.stagingDir, 'journal.json');
  failOpens(t, file, 'EBUSY');
  const realLstat = fs.lstatSync;
  fs.lstatSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(file)) throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
    return realLstat(target, ...rest);
  };
  t.after(() => { fs.lstatSync = realLstat; });
  const stamp = realLstat(env.stagingDir).mtimeMs;
  const { receiver } = env.receiver();
  assert.deepEqual(await receiver.sweep(stamp + THIRTY_DAYS - 1), { ok: true, removed: 0 }, 'just under 30 days by the folder');
  assert.equal(fs.existsSync(env.stagingDir), true);
  assert.deepEqual(await receiver.sweep(stamp + THIRTY_DAYS), { ok: true, removed: 1 }, '30 days by the folder');
  assert.equal(fs.existsSync(env.stagingDir), false);
});

test('X4b-F06: an empty holder left at the family folder\'s name is removed; a foreign file or folder there is not', async (t) => {
  // At accept: the holder goes and the set is placed in the family folder.
  const env = disk(t);
  fs.writeFileSync(env.familyDir, '');
  await restartAndFinish(env);
  // Mid placement (a rename whose holder could not be removed, then a restart): the set still lands there.
  const cut = disk(t);
  await crashAt(cut, (name, d) => name === 'moved' && d.index === 0);
  fs.writeFileSync(cut.familyDir, '');
  await restartAndFinish(cut);
  // A rename that fails and reports its holder left: logged, resumable, and the next start removes it.
  const left = disk(t);
  const logs = [];
  const failing = async (_from, to, { onLeft } = {}) => {
    fs.writeFileSync(to, '');
    const stat = fs.lstatSync(to, { bigint: true });
    onLeft({ file: to, dev: stat.dev, ino: stat.ino });
    throw Object.assign(new Error('held'), { code: 'EBUSY' });
  };
  const failed = await createModelReceiver({
    roots: () => [left.root], transport: fx.fakeTransport(left.bytes), hasher: fx.fakeHasher(), limits: fx.LIMITS,
    validateManifest: fx.testValidator(), renameFolder: failing, logger: (_level, event) => logs.push(event),
  }).start({ offer: left.offer, root: left.root });
  assert.deepEqual([failed.state, failed.reason, logs.includes('team.model.receive_holder_left')],
    ['paused', 'model_staging_failed', true], JSON.stringify(failed));
  await restartAndFinish(left);
  // A file with bytes in it, or a folder, at that name is never removed or joined.
  const foreign = disk(t);
  fs.writeFileSync(foreign.familyDir, 'x');
  assert.deepEqual(await foreign.receiver().receiver.start({ offer: foreign.offer, root: foreign.root }),
    { ok: false, reason: 'model_destination_invalid' });
  assert.equal(fs.readFileSync(foreign.familyDir, 'utf8'), 'x');
});

test('a resume with every byte already verified takes the transfer up with the host again, so its complete is not lost', async (t) => {
  const env = disk(t, 'model', { existing: true });
  await crashAt(env, (name, d) => name === 'moved' && d.index === 1);
  // A host that knows a transfer once this receiver accepted or resumed it; a complete for another one reaches nothing.
  const known = new Set();
  const completed = [];
  const base = fx.fakeTransport(env.bytes);
  const transport = { ...base,
    accept: async (payload) => { known.add(payload.offerId); return base.accept(payload); },
    resume: async (payload) => { known.add(payload.offerId); return base.resume(payload); },
    complete: async (payload) => { if (known.has(payload.offerId)) completed.push(payload.offerId); return base.complete(payload); } };
  const receiver = createModelReceiver({ roots: () => [env.root], transport, hasher: fx.fakeHasher(), limits: fx.LIMITS,
    validateManifest: fx.testValidator() });
  const result = await receiver.start({ offer: env.offer, root: env.root });
  assert.equal(result.state, 'complete', JSON.stringify(result));
  assert.deepEqual(completed, [env.offer.offerId], 'the host heard the transfer complete');
  assert.equal(base.count('takePart'), 0, 'nothing was pulled again');
  // A host that refuses the take-up (the offer is gone) does not stop a set that is already whole from being placed.
  const gone = disk(t, 'model', { existing: true });
  await crashAt(gone, (name, d) => name === 'moved' && d.index === 1);
  const refusing = createModelReceiver({ roots: () => [gone.root], hasher: fx.fakeHasher(), limits: fx.LIMITS, validateManifest: fx.testValidator(),
    transport: { ...fx.fakeTransport(gone.bytes), resume: async () => { throw Object.assign(new Error('gone'), { code: 'team_not_found' }); },
      accept: async () => { throw Object.assign(new Error('gone'), { code: 'team_not_found' }); } } });
  assert.equal((await refusing.start({ offer: gone.offer, root: gone.root })).state, 'complete');
});

test('a folder that appears at the family name during the rename (POSIX ENOTEMPTY or ENOTDIR) is a taken name, as EEXIST is', async (t) => {
  for (const code of ['EEXIST', 'ENOTEMPTY', 'ENOTDIR']) {
    const env = disk(t);
    let calls = 0;
    const renameFolder = async (from, to) => {
      calls += 1;
      if (calls === 1) {
        fs.mkdirSync(to);
        fs.writeFileSync(path.join(to, OTHER), 'theirs');
        throw Object.assign(new Error('raced'), { code });
      }
      fs.renameSync(from, to);
    };
    const result = await createModelReceiver({ roots: () => [env.root], transport: fx.fakeTransport(env.bytes), hasher: fx.fakeHasher(),
      limits: fx.LIMITS, validateManifest: fx.testValidator(), renameFolder }).start({ offer: env.offer, root: env.root });
    assert.equal(result.state, 'complete', `${code}: ${JSON.stringify(result)}`);
    assert.equal(fs.readFileSync(path.join(env.familyDir, OTHER), 'utf8'), 'theirs', `${code}: their folder is untouched`);
    assert.equal(fs.existsSync(path.join(`${env.familyDir}-2`, env.main)), true, `${code}: the set went into the next folder`);
  }
});
