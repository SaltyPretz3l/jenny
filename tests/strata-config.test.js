const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_STRATA_SETTINGS,
  buildStrataConfig,
  checkTokenizerDir,
  findPacks,
  loadPackManifest,
  normalizeStrataSettings,
  readSetupConfig,
  resolveMaxContext,
  verifyPack,
} = require('../services/strata-config');

const NATIVE_BYTES = 'native-pack-bytes';
const VISION_BYTES = 'vision-pack';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const RTX_5090 = { name: 'NVIDIA GeForce RTX 5090', vram_total_mb: 32607 };

function makeTmp(t) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'strata-config-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function put(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function link(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  for (const type of ['junction', 'dir']) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch (_error) {
      void _error;
    }
  }
  return false;
}

// Small temp files stand in for the multi-gigabyte packs: the family spec carries their size and hash.
async function makeFixture(t) {
  const tmp = makeTmp(t);
  const root = path.join(tmp, 'Strata');
  const manifest = await loadPackManifest();
  const family = JSON.parse(JSON.stringify(manifest.families[0]));
  family.packs.native = { file: 'Inkling-2-Mini-SQ-20.strata', size_bytes: Buffer.byteLength(NATIVE_BYTES), sha256: sha(NATIVE_BYTES) };
  family.packs.vision = { file: 'Inkling-2-Mini-Vision.strata', size_bytes: Buffer.byteLength(VISION_BYTES), sha256: sha(VISION_BYTES) };
  const models = path.join(root, 'Strata-data', 'models', 'inkling-2-mini');
  const nativePath = path.join(models, family.packs.native.file);
  const visionPath = path.join(models, family.packs.vision.file);
  put(nativePath, NATIVE_BYTES);
  put(visionPath, VISION_BYTES);
  const tokenizer = path.join(root, 'Strata-data', 'packs', 'inkling-2-mini-sq-20', 'tokenizer');
  for (const name of ['chat_template.jinja', 'merges.txt', 'token_type.json', 'tokenizer.json', 'vocab.json']) put(path.join(tokenizer, name));
  const terminalDir = path.join(root, 'terminal', '0.1.67');
  const engineExe = path.join(root, 'components', 'shapes', 'inkling2', 'engine', '0.1.67-x', 'strata-inkling.exe');
  put(engineExe);
  put(path.join(terminalDir, 'serve', 'server.py'));
  const install = { ok: true, root, terminalDir, engine: { exe: engineExe, dir: path.dirname(engineExe), version: '0.1.67', backend: 'cuda' } };
  const setupConfig = {
    exe: 'component:strata-inkling',
    args: ['--native', nativePath, '--max-context', '32768', '--vision', visionPath, '--vram-experts-gb', '14.66'],
    cwd: terminalDir,
    tokenizer,
    model_name: 'inkling-2-mini-sq-20',
    arch: 'inkling2_loop',
    port: 8080,
    parallel: 1,
  };
  const packs = {
    native: { path: nativePath, size_bytes: family.packs.native.size_bytes, mtime_ms: fs.statSync(nativePath).mtimeMs, spec: family.packs.native },
    vision: { path: visionPath, size_bytes: family.packs.vision.size_bytes, mtime_ms: fs.statSync(visionPath).mtimeMs, spec: family.packs.vision },
  };
  return { tmp, root, family, install, setupConfig, packs, nativePath, visionPath, tokenizer, userDataPath: path.join(tmp, 'userData') };
}

function build(fx, overrides = {}) {
  return buildStrataConfig({
    install: fx.install,
    family: fx.family,
    setupConfig: fx.setupConfig,
    packs: fx.packs,
    settings: { ...DEFAULT_STRATA_SETTINGS },
    maxContext: 114432,
    userDataPath: fx.userDataPath,
    tokenizer: fx.tokenizer,
    ...overrides,
  });
}

test('loadPackManifest loads the real manifest and rejects a malformed one with a typed error', async (t) => {
  const manifest = await loadPackManifest();
  const family = manifest.families[0];
  assert.equal(family.params_b, 26.4);
  assert.equal(family.model_name, 'inkling-2-mini-sq-20');
  assert.equal(family.packs.native.size_bytes, 19346685952);
  assert.match(family.packs.vision.sha256, /^[0-9a-f]{64}$/);
  const tmp = makeTmp(t);
  const bad = JSON.parse(JSON.stringify(manifest));
  bad.families[0].packs.native.sha256 = 'ABC';
  put(path.join(tmp, 'bad.json'), JSON.stringify(bad));
  await assert.rejects(loadPackManifest({ file: path.join(tmp, 'bad.json') }), { code: 'strata_manifest_invalid' });
  put(path.join(tmp, 'junk.json'), '{nope');
  await assert.rejects(loadPackManifest({ file: path.join(tmp, 'junk.json') }), { code: 'strata_manifest_invalid' });
  await assert.rejects(loadPackManifest({ file: path.join(tmp, 'missing.json') }), { code: 'strata_manifest_invalid' });
});

test('normalizeStrataSettings falls back per field and drops unknown keys', () => {
  assert.deepEqual(normalizeStrataSettings(null), DEFAULT_STRATA_SETTINGS);
  assert.deepEqual(normalizeStrataSettings('x'), DEFAULT_STRATA_SETTINGS);
  assert.deepEqual(DEFAULT_STRATA_SETTINGS, { slots: 4, kv: 'k8v8', context: null, vision: true, drafting: 'off' });
  assert.ok(Object.isFrozen(DEFAULT_STRATA_SETTINGS));
  assert.deepEqual(
    normalizeStrataSettings({ slots: 3, kv: 'k4v4', context: 100, vision: 'yes', drafting: 'auto', extra: 1 }),
    DEFAULT_STRATA_SETTINGS,
  );
  assert.deepEqual(
    normalizeStrataSettings({ slots: 2, kv: 'auto', context: 65536, vision: false, drafting: 'dspark' }),
    { slots: 2, kv: 'auto', context: 65536, vision: false, drafting: 'dspark' },
  );
  assert.equal(normalizeStrataSettings({ context: 2000000 }).context, null);
  assert.equal(normalizeStrataSettings({ context: 2048.5 }).context, null);
  assert.equal(normalizeStrataSettings({ slots: 1, kv: 'bad' }).slots, 1);
});

test('readSetupConfig reads the install folder file and refuses missing, oversize and non-object content', async (t) => {
  const fx = await makeFixture(t);
  const file = path.join(fx.root, 'install', fx.family.setup_config);
  assert.deepEqual(await readSetupConfig(fx.install, fx.family), { ok: false, reason: 'no_setup_config' });
  put(file, JSON.stringify(fx.setupConfig));
  const read = await readSetupConfig(fx.install, fx.family);
  assert.equal(read.ok, true);
  assert.equal(read.path, file);
  assert.equal(read.config.model_name, 'inkling-2-mini-sq-20');
  put(file, '[1,2]');
  assert.equal((await readSetupConfig(fx.install, fx.family)).reason, 'setup_config_invalid');
  put(file, '{nope');
  assert.equal((await readSetupConfig(fx.install, fx.family)).reason, 'setup_config_invalid');
  put(file, JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
  assert.equal((await readSetupConfig(fx.install, fx.family)).reason, 'setup_config_invalid');
});

test('readSetupConfig refuses an install folder that is a link', async (t) => {
  const fx = await makeFixture(t);
  const outside = path.join(fx.tmp, 'outside-install');
  put(path.join(outside, fx.family.setup_config), '{}');
  if (!link(outside, path.join(fx.root, 'install'))) return t.skip('no link support');
  assert.equal((await readSetupConfig(fx.install, fx.family)).reason, 'link_refused');
});

test('findPacks resolves both packs and checks name, size and containment', async (t) => {
  const fx = await makeFixture(t);
  const found = await findPacks(fx.install, fx.family, fx.setupConfig);
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.equal(found.native.path, fx.nativePath);
  assert.equal(found.native.size_bytes, Buffer.byteLength(NATIVE_BYTES));
  assert.equal(found.native.mtime_ms, fs.statSync(fx.nativePath).mtimeMs);
  assert.equal(found.native.spec, fx.family.packs.native);
  assert.equal(found.vision.path, fx.visionPath);
  assert.deepEqual(found.warnings, []);

  const noVisionArgs = { ...fx.setupConfig, args: ['--native', fx.nativePath] };
  assert.equal((await findPacks(fx.install, fx.family, noVisionArgs)).vision, null);
  assert.equal((await findPacks(fx.install, fx.family, { ...fx.setupConfig, args: [] })).reason, 'native_pack_missing');
  assert.equal((await findPacks(fx.install, fx.family, { ...fx.setupConfig, args: 'nope' })).reason, 'setup_config_invalid');
  assert.equal((await findPacks(fx.install, fx.family, { ...fx.setupConfig, args: ['--native', path.join(fx.root, 'gone.strata')] })).reason, 'native_pack_missing');

  const wrongName = path.join(fx.root, 'Strata-data', 'models', 'other.strata');
  put(wrongName, NATIVE_BYTES);
  assert.equal((await findPacks(fx.install, fx.family, { ...fx.setupConfig, args: ['--native', wrongName] })).reason, 'pack_name_mismatch');

  const outside = path.join(fx.tmp, 'elsewhere', fx.family.packs.native.file);
  put(outside, NATIVE_BYTES);
  assert.equal((await findPacks(fx.install, fx.family, { ...fx.setupConfig, args: ['--native', outside] })).reason, 'outside_root');

  put(fx.nativePath, `${NATIVE_BYTES}+`);
  const size = await findPacks(fx.install, fx.family, fx.setupConfig);
  assert.deepEqual({ ok: size.ok, reason: size.reason }, { ok: false, reason: 'pack_size_mismatch' });
});

test('findPacks refuses a pack folder that is a junction, and downgrades a bad vision pack to a warning', async (t) => {
  const fx = await makeFixture(t);
  put(fx.visionPath, 'wrong size vision');
  const soft = await findPacks(fx.install, fx.family, fx.setupConfig);
  assert.equal(soft.ok, true);
  assert.equal(soft.vision, null);
  assert.deepEqual(soft.warnings, [{ code: 'vision_pack_unusable', reason: 'pack_size_mismatch' }]);

  const outside = path.join(fx.tmp, 'real-models');
  put(path.join(outside, fx.family.packs.native.file), NATIVE_BYTES);
  const jump = path.join(fx.root, 'Strata-data', 'jump');
  if (!link(outside, jump)) return t.skip('no link support');
  const linked = path.join(jump, fx.family.packs.native.file);
  assert.equal((await findPacks(fx.install, fx.family, { ...fx.setupConfig, args: ['--native', linked] })).reason, 'link_refused');
});

test('checkTokenizerDir needs vocab.json, merges.txt and chat_template.jinja inside the root', async (t) => {
  const fx = await makeFixture(t);
  assert.deepEqual(await checkTokenizerDir(fx.install, fx.tokenizer), { ok: true, path: fx.tokenizer });
  fs.rmSync(path.join(fx.tokenizer, 'merges.txt'));
  assert.equal((await checkTokenizerDir(fx.install, fx.tokenizer)).reason, 'tokenizer_unusable');
  assert.equal((await checkTokenizerDir(fx.install, path.join(fx.root, 'nope'))).reason, 'tokenizer_unusable');
  assert.equal((await checkTokenizerDir(fx.install, fx.tmp)).reason, 'outside_root');
});

test('buildStrataConfig rebuilds args in order for the default settings', async (t) => {
  const fx = await makeFixture(t);
  const built = build(fx);
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.deepEqual(built.config.args, [
    '--native', fx.nativePath,
    '--max-context', '114432',
    '--vision', fx.visionPath,
    '--kv', 'k8v8',
    '--vram-experts-gb', '14.66',
  ]);
  assert.equal(built.config.exe, fx.install.engine.exe);
  assert.equal(built.config.cwd, fx.install.terminalDir);
  assert.equal(built.config.tokenizer, fx.tokenizer);
  assert.equal(built.config.model_name, 'inkling-2-mini-sq-20');
  assert.equal(built.config.drafting, 'off');
  assert.deepEqual(built.config.aliases, ['inkling-2-mini']);
  assert.notEqual(built.config.aliases, fx.family.aliases);
  assert.equal(built.config.log, path.join(fx.userDataPath, 'strata', 'logs', 'strata-server.log'));
  assert.deepEqual(built.warnings, []);
});

test('buildStrataConfig omits --kv for auto, drops vision when off or absent, and maps drafting', async (t) => {
  const fx = await makeFixture(t);
  const auto = build(fx, { settings: { ...DEFAULT_STRATA_SETTINGS, kv: 'auto', vision: false, drafting: 'dspark' } });
  assert.deepEqual(auto.config.args, ['--native', fx.nativePath, '--max-context', '114432', '--vram-experts-gb', '14.66']);
  assert.equal(auto.config.drafting, 'dspark');
  const noPack = build(fx, { packs: { native: fx.packs.native, vision: null } });
  assert.ok(!noPack.config.args.includes('--vision'));
  const k8v4 = build(fx, { settings: { ...DEFAULT_STRATA_SETTINGS, kv: 'k8v4' } });
  assert.deepEqual(k8v4.config.args.slice(6, 8), ['--kv', 'k8v4']);
  assert.equal(build(fx, { settings: { drafting: 'auto' } }).config.drafting, 'off');
});

test('buildStrataConfig keeps valid expert flags in fixed order and drops bad values with a warning', async (t) => {
  const fx = await makeFixture(t);
  const both = build(fx, { setupConfig: { ...fx.setupConfig, args: ['--native', fx.nativePath, '--ram-experts-gb=3.5', '--vram-experts-gb', '14'] } });
  assert.deepEqual(both.config.args.slice(-4), ['--vram-experts-gb', '14', '--ram-experts-gb', '3.5']);
  const bad = build(fx, { setupConfig: { ...fx.setupConfig, args: ['--native', fx.nativePath, '--vram-experts-gb', '14;calc', '--ram-experts-gb', '-1'] } });
  assert.equal(bad.ok, true);
  assert.ok(!bad.config.args.includes('--vram-experts-gb'));
  assert.ok(!bad.config.args.includes('--ram-experts-gb'));
  assert.deepEqual(bad.warnings.filter((w) => w.code === 'expert_flag_dropped').map((w) => w.flag), ['--vram-experts-gb', '--ram-experts-gb']);
  assert.ok(!JSON.stringify(bad.warnings).includes('calc'));
});

test('buildStrataConfig refuses --host, in both forms, and the other unsafe flags', async (t) => {
  const fx = await makeFixture(t);
  const spaced = build(fx, { setupConfig: { ...fx.setupConfig, args: [...fx.setupConfig.args, '--host', '0.0.0.0'] } });
  assert.deepEqual({ ok: spaced.ok, reason: spaced.reason }, { ok: false, reason: 'unsafe_setup_args' });
  assert.deepEqual(spaced.detail.flags, ['--host']);
  const equals = build(fx, { setupConfig: { ...fx.setupConfig, args: [...fx.setupConfig.args, '--host=0.0.0.0'] } });
  assert.equal(equals.reason, 'unsafe_setup_args');
  assert.ok(!JSON.stringify(equals).includes('0.0.0.0'));
  const many = build(fx, { setupConfig: { ...fx.setupConfig, args: ['--api-key', 'k', '--before-load=x', '--lazy', '--replicas', '2'] } });
  assert.deepEqual(many.detail.flags, ['--api-key', '--before-load', '--lazy', '--replicas']);
});

test('buildStrataConfig refuses an exe outside the components folder and unsupported component refs', async (t) => {
  const fx = await makeFixture(t);
  const outside = build(fx, { setupConfig: { ...fx.setupConfig, exe: path.join(fx.tmp, 'evil', 'strata-inkling.exe') } });
  assert.deepEqual({ ok: outside.ok, reason: outside.reason }, { ok: false, reason: 'exe_outside_components' });
  assert.equal(build(fx, { setupConfig: { ...fx.setupConfig, exe: 'component:strata-other' } }).reason, 'exe_unsupported');
  assert.equal(build(fx, { setupConfig: { ...fx.setupConfig, exe: 42 } }).reason, 'exe_unsupported');
  const samePathExe = build(fx, { setupConfig: { ...fx.setupConfig, exe: fx.install.engine.exe } });
  assert.equal(samePathExe.ok, true);
  const absent = { ...fx.setupConfig };
  delete absent.exe;
  assert.equal(build(fx, { setupConfig: absent }).config.exe, fx.install.engine.exe);
});

test('buildStrataConfig output has exactly the allowed keys and never carries smuggled setup keys', async (t) => {
  const fx = await makeFixture(t);
  const smuggled = {
    ...fx.setupConfig,
    before_load: 'calc.exe',
    api_key: 'secret-key',
    api_keys: ['a'],
    mcp_servers: { x: {} },
    host: '0.0.0.0',
    allowed_hosts: ['*'],
    cors_origins: ['*'],
    trusted_origins: ['*'],
    api_monitor: true,
    slot_save_path: 'C:\\x',
    env: { STRATA_API_KEY: 'k' },
    lib_dirs: ['C:\\lib'],
    drafting_probe: true,
    log: 'C:\\elsewhere.log',
    args_written: ['--host', '0.0.0.0'],
  };
  const built = build(fx, { setupConfig: smuggled });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.deepEqual(Object.keys(built.config).sort(), ['aliases', 'args', 'cwd', 'drafting', 'exe', 'log', 'model_name', 'tokenizer']);
  const text = JSON.stringify(built);
  for (const needle of ['secret-key', 'calc.exe', '0.0.0.0', '8080', 'elsewhere']) assert.ok(!text.includes(needle), needle);
});

test('buildStrataConfig lists dropped setup flags by name only and checks model name and tokenizer', async (t) => {
  const fx = await makeFixture(t);
  const extra = build(fx, { setupConfig: { ...fx.setupConfig, args: [...fx.setupConfig.args, '--threads', '8', '--mystery=secret', '--kv', 'k4v4'] } });
  assert.equal(extra.ok, true);
  const dropped = extra.warnings.filter((w) => w.code === 'setup_args_dropped');
  assert.equal(dropped.length, 1);
  assert.deepEqual(dropped[0].flags, ['--threads', '--mystery']);
  assert.ok(!JSON.stringify(extra.config).includes('secret'));
  assert.ok(!extra.config.args.includes('k4v4'));

  assert.equal(build(fx, { setupConfig: { ...fx.setupConfig, model_name: 'other' } }).reason, 'model_name_mismatch');
  assert.equal(build(fx, { tokenizer: undefined }).reason, 'tokenizer_unchecked');
  assert.equal(build(fx, { setupConfig: { ...fx.setupConfig, tokenizer: path.join(fx.tmp, 'outside-tok') } }).reason, 'outside_root');
  assert.equal(build(fx, { setupConfig: { ...fx.setupConfig, tokenizer: 7 } }).reason, 'tokenizer_invalid');
  assert.equal(build(fx, { maxContext: 10 }).reason, 'max_context_invalid');
});

test('resolveMaxContext caps at the measured fit, uses learned fits and falls back to the setup value', async (t) => {
  const fx = await makeFixture(t);
  const settings = (over) => ({ ...DEFAULT_STRATA_SETTINGS, ...over });
  const capped = resolveMaxContext({ family: fx.family, settings: settings({ context: 1000000 }), gpu: RTX_5090 });
  assert.deepEqual(capped, { maxContext: 114432, fit: 114432, source: 'measured' });
  assert.equal(resolveMaxContext({ family: fx.family, settings: settings({ context: 65536 }), gpu: RTX_5090 }).maxContext, 65536);
  assert.equal(resolveMaxContext({ family: fx.family, settings: settings({ slots: 1, kv: 'auto' }), gpu: RTX_5090 }).maxContext, 228352);
  assert.equal(resolveMaxContext({ family: fx.family, settings: settings({ context: 100000 }), gpu: RTX_5090 }).maxContext, 100000);

  const smallCard = { name: 'NVIDIA GeForce RTX 5090', vram_total_mb: 16000 };
  const learned = resolveMaxContext({ family: fx.family, settings: settings(), gpu: smallCard, learnedFits: { '4:k8v8': 48000 } });
  assert.deepEqual(learned, { maxContext: 48000, fit: 48000, source: 'learned' });
  const junkLearned = resolveMaxContext({ family: fx.family, settings: settings(), gpu: null, learnedFits: { '4:k8v8': 12 }, setupMaxContext: 20000 });
  assert.deepEqual(junkLearned, { maxContext: 20000, fit: 20000, source: 'default' });
  assert.equal(resolveMaxContext({ family: fx.family, settings: settings(), gpu: null, setupMaxContext: 99999 }).maxContext, 32768);
  assert.equal(resolveMaxContext({ family: fx.family, settings: settings(), gpu: null }).maxContext, 32768);
  assert.equal(resolveMaxContext({ family: fx.family, settings: settings(), gpu: { name: 'RTX 4090', vram_total_mb: 24000 } }).source, 'default');
  assert.equal(resolveMaxContext({ family: fx.family, settings: settings({ context: 2048 }), gpu: null }).maxContext, 2048);
});

test('verifyPack writes a receipt, skips hashing next time, and re-hashes on a changed mtime or force', async (t) => {
  const fx = await makeFixture(t);
  const calls = [];
  const hashFile = async (file) => { calls.push(file); return sha(NATIVE_BYTES); };
  const opts = { userDataPath: fx.userDataPath, hashFile };

  const first = await verifyPack(fx.packs.native, opts);
  assert.deepEqual(first, { ok: true, sha256: sha(NATIVE_BYTES), fromReceipt: false });
  const receiptFile = path.join(fx.userDataPath, 'strata', 'pack-receipts.json');
  const stored = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(stored.schema_version, 1);
  assert.equal(stored.receipts.length, 1);
  assert.equal(stored.receipts[0].path, fx.nativePath);
  assert.equal(stored.receipts[0].size_bytes, fx.packs.native.size_bytes);
  assert.equal(stored.receipts[0].sha256, sha(NATIVE_BYTES));
  assert.ok(stored.receipts[0].verified_at);

  const second = await verifyPack(fx.packs.native, opts);
  assert.equal(second.fromReceipt, true);
  assert.equal(calls.length, 1);

  await verifyPack({ ...fx.packs.native, mtime_ms: fx.packs.native.mtime_ms + 1000 }, opts);
  assert.equal(calls.length, 2);
  await verifyPack(fx.packs.native, { ...opts, force: true });
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).receipts.length, 1, 'one receipt per path');
});

test('verifyPack returns sha256_mismatch and drops the receipt on a wrong hash', async (t) => {
  const fx = await makeFixture(t);
  const good = { userDataPath: fx.userDataPath, hashFile: async () => sha(NATIVE_BYTES) };
  await verifyPack(fx.packs.native, good);
  const wrong = await verifyPack(fx.packs.native, { userDataPath: fx.userDataPath, force: true, hashFile: async () => sha('tampered') });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'sha256_mismatch');
  assert.deepEqual(wrong.detail, { expected: sha(NATIVE_BYTES), actual: sha('tampered') });
  const stored = JSON.parse(fs.readFileSync(path.join(fx.userDataPath, 'strata', 'pack-receipts.json'), 'utf8'));
  assert.deepEqual(stored.receipts, []);
  const failed = await verifyPack(fx.packs.native, { userDataPath: fx.userDataPath, hashFile: async () => { throw new Error('disk gone'); } });
  assert.deepEqual({ ok: failed.ok, reason: failed.reason }, { ok: false, reason: 'hash_failed' });
});

test('verifyPack treats a corrupt or wrong-schema receipt file as empty and caps receipts at eight', async (t) => {
  const fx = await makeFixture(t);
  const receiptFile = path.join(fx.userDataPath, 'strata', 'pack-receipts.json');
  put(receiptFile, '{broken');
  let calls = 0;
  const hashFile = async () => { calls += 1; return sha(NATIVE_BYTES); };
  assert.equal((await verifyPack(fx.packs.native, { userDataPath: fx.userDataPath, hashFile })).fromReceipt, false);
  put(receiptFile, JSON.stringify({ schema_version: 99, receipts: [{ path: fx.nativePath }] }));
  assert.equal((await verifyPack(fx.packs.native, { userDataPath: fx.userDataPath, hashFile })).fromReceipt, false);
  assert.equal(calls, 2);

  for (let index = 0; index < 10; index += 1) {
    const file = path.join(fx.tmp, `pack-${index}.strata`);
    put(file, NATIVE_BYTES);
    const pack = { path: file, size_bytes: Buffer.byteLength(NATIVE_BYTES), mtime_ms: fs.statSync(file).mtimeMs, spec: fx.packs.native.spec };
    await verifyPack(pack, { userDataPath: fx.userDataPath, hashFile });
  }
  const stored = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(stored.receipts.length, 8);
  assert.ok(stored.receipts.every((entry) => /pack-[2-9]\.strata$/.test(entry.path)), 'the newest eight are kept');
});

test('two concurrent verifyPack calls for one path share a single hash', async (t) => {
  const fx = await makeFixture(t);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const hashFile = async () => { calls += 1; await gate; return sha(NATIVE_BYTES); };
  const opts = { userDataPath: fx.userDataPath, hashFile };
  const pair = Promise.all([verifyPack(fx.packs.native, opts), verifyPack(fx.packs.native, opts)]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  release();
  const [a, b] = await pair;
  assert.equal(calls, 1);
  assert.equal(a.ok && b.ok, true);
});

test('verifyPack hashes a real file through the worker thread', async (t) => {
  const fx = await makeFixture(t);
  const file = path.join(fx.tmp, 'real.strata');
  const bytes = crypto.randomBytes(300 * 1024);
  fs.writeFileSync(file, bytes);
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  const spec = { file: 'real.strata', size_bytes: bytes.length, sha256: expected };
  const pack = { path: file, size_bytes: bytes.length, mtime_ms: fs.statSync(file).mtimeMs, spec };
  const result = await verifyPack(pack, { userDataPath: fx.userDataPath });
  assert.deepEqual(result, { ok: true, sha256: expected, fromReceipt: false });
  const bad = await verifyPack({ ...pack, spec: { ...spec, sha256: sha('other') } }, { userDataPath: fx.userDataPath, force: true });
  assert.equal(bad.reason, 'sha256_mismatch');
  assert.equal(bad.detail.actual, expected);
  const gone = await verifyPack({ ...pack, path: path.join(fx.tmp, 'gone.strata') }, { userDataPath: fx.userDataPath, force: true });
  assert.equal(gone.reason, 'hash_failed');
});

test('verifyPack forwards byte progress to every caller of one in-flight hash', async (t) => {
  const fx = await makeFixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let hashes = 0;
  const hashFile = async (_file, onProgress) => { hashes += 1; await gate; onProgress(4); onProgress(8); return sha(NATIVE_BYTES); };
  const heardA = [];
  const heardB = [];
  const a = verifyPack(fx.packs.native, { userDataPath: fx.userDataPath, hashFile, force: true, onProgress: (done) => heardA.push(done) });
  const b = verifyPack(fx.packs.native, { userDataPath: fx.userDataPath, hashFile, force: true, onProgress: (done) => heardB.push(done) });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true);
  assert.equal(hashes, 1, 'one hash for both callers');
  assert.deepEqual([heardA, heardB], [[4, 8], [4, 8]]);
  // No listener is fine, and a hashFile that ignores progress still verifies.
  assert.equal((await verifyPack(fx.packs.native, { userDataPath: fx.userDataPath, force: true, hashFile: async () => sha(NATIVE_BYTES) })).ok, true);
});
