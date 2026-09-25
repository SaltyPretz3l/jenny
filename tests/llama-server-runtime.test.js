const test = require('node:test');
const assert = require('node:assert/strict');

const { isLlamaServerRuntimePath } = require('../services/shell-config-engines');
const {
  MAX_RUNTIME_PICKS,
  createRuntimePickRegistry,
  validateRuntimeExecutable,
  reconcileManagedRuntimePaths,
  writeManagedPatch,
  resolveLaunchRuntime,
  describeRuntimeLabel,
  runtimeFolderToken,
} = require('../services/main/llama-server-runtime');

const WIN = { platform: 'win32' };
const FORK = 'G:\\llmmodels\\runtimes\\llama-prism-b10683-cuda13.3\\llama-server.exe';
const OTHER = 'D:\\builds\\llama-b10800\\llama-server.exe';
const BONSAI_KEY = 'ternary-bonsai-2-27b-pq2-0';

function fileStat() {
  return { isFile: () => true, mtimeMs: 1, size: 2 };
}

function fakeFs(files) {
  return {
    statSync(target) {
      if (files.has(target)) return fileStat();
      const error = new Error(`ENOENT: ${target}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
}

function persistedWith(entries) {
  return { enabled: true, perModel: entries };
}

test('runtime paths accept only an absolute, normalized drive path to llama-server.exe on win32', () => {
  assert.equal(isLlamaServerRuntimePath(FORK, WIN), true);
  assert.equal(isLlamaServerRuntimePath('C:\\x\\LLAMA-SERVER.EXE', WIN), true, 'case-insensitive on win32');
  for (const bad of [
    '\\\\server\\share\\llama-server.exe',
    '\\\\?\\C:\\x\\llama-server.exe',
    '\\\\.\\C:\\x\\llama-server.exe',
    '\\x\\llama-server.exe',
    'C:llama-server.exe',
    'runtimes\\llama-server.exe',
    'C:\\x\\..\\y\\llama-server.exe',
    'C:\\x\\.\\llama-server.exe',
    'C:/x/llama-server.exe',
    'C:\\x\\\\llama-server.exe',
    'C:\\x\\calc.exe',
    'C:\\x\\llama-cli.exe',
    'C:\\x\\llama-server.exe.bat',
    'C:\\x\\llama-server',
    'C:\\x\\llama-server.exe\n',
    'C:\\x\u0000\\llama-server.exe',
    'C:\\x\u007f\\llama-server.exe',
    `C:\\${'a'.repeat(1010)}\\llama-server.exe`,
    '',
  ]) {
    assert.equal(isLlamaServerRuntimePath(bad, WIN), false, JSON.stringify(bad));
  }
  for (const bad of [null, undefined, 42, {}, [FORK], true]) {
    assert.equal(isLlamaServerRuntimePath(bad, WIN), false, String(bad));
  }
});

test('runtime paths on posix accept only an absolute, normalized path to llama-server', () => {
  const linux = { platform: 'linux' };
  assert.equal(isLlamaServerRuntimePath('/opt/llama-prism/llama-server', linux), true);
  for (const bad of [
    '/opt/llama-prism/llama-server.exe',
    '/opt/llama-prism/LLAMA-SERVER',
    'opt/llama-server',
    '/opt/../llama-server',
    '/opt//llama-server',
    '//host/share/llama-server',
    '/opt/llama-server/',
  ]) {
    assert.equal(isLlamaServerRuntimePath(bad, linux), false, bad);
  }
});

test('the pick registry matches exact strings and evicts the oldest past its cap', () => {
  const picks = createRuntimePickRegistry();
  assert.equal(MAX_RUNTIME_PICKS, 8);
  picks.record(FORK, { build: 10683, supportsMtp: true });
  assert.equal(picks.has(FORK), true);
  assert.equal(picks.has(FORK.toLowerCase()), false, 'no case folding: the renderer echoes the exact pick');
  assert.deepEqual(picks.get(FORK), { path: FORK, build: 10683, supportsMtp: true });
  for (let index = 0; index < MAX_RUNTIME_PICKS; index += 1) {
    picks.record(`C:\\b${index}\\llama-server.exe`, { build: index + 1, supportsMtp: false });
  }
  assert.equal(picks.has(FORK), false, 'oldest evicted');
  assert.equal(picks.size(), MAX_RUNTIME_PICKS);
  picks.record('C:\\b0\\llama-server.exe', { build: 1, supportsMtp: false });
  picks.record('C:\\b9\\llama-server.exe', { build: 10, supportsMtp: false });
  assert.equal(picks.has('C:\\b0\\llama-server.exe'), true, 're-recording refreshes recency');
  assert.equal(picks.has('C:\\b1\\llama-server.exe'), false);
  picks.consume('C:\\b0\\llama-server.exe');
  assert.equal(picks.has('C:\\b0\\llama-server.exe'), false);
  assert.equal(picks.get('C:\\missing\\llama-server.exe'), null);
});

test('validateRuntimeExecutable never probes a bad name, a missing file or a directory', async () => {
  let probes = 0;
  const probeImpl = async () => { probes += 1; return { ok: true, build: 1 }; };
  let stats = 0;
  const countingFs = { statSync: () => { stats += 1; return fileStat(); } };
  assert.deepEqual(await validateRuntimeExecutable('C:\\x\\calc.exe', { probeImpl, fsImpl: countingFs, ...WIN }),
    { ok: false, reason: 'not_llama_server' });
  assert.equal(stats, 0, 'the name check runs before any filesystem access');
  assert.deepEqual(await validateRuntimeExecutable(FORK, { probeImpl, fsImpl: fakeFs(new Set()), ...WIN }),
    { ok: false, reason: 'runtime_missing' });
  const directoryFs = { statSync: () => ({ isFile: () => false }) };
  assert.deepEqual(await validateRuntimeExecutable(FORK, { probeImpl, fsImpl: directoryFs, ...WIN }),
    { ok: false, reason: 'not_llama_server' });
  assert.equal(probes, 0);
});

test('validateRuntimeExecutable requires a probe that reports a real build', async () => {
  const fsImpl = fakeFs(new Set([FORK]));
  const calls = [];
  const probeWith = (result) => async (options) => { calls.push(options); return result; };
  assert.deepEqual(await validateRuntimeExecutable(FORK, { fsImpl, probeImpl: probeWith({ ok: false, build: 0 }), ...WIN }),
    { ok: false, reason: 'runtime_probe_failed' });
  assert.deepEqual(await validateRuntimeExecutable(FORK, { fsImpl, probeImpl: probeWith({ ok: true, build: 0 }), ...WIN }),
    { ok: false, reason: 'runtime_probe_failed' }, 'an exe whose --help exits 0 but reports no build fails closed');
  assert.deepEqual(await validateRuntimeExecutable(FORK, { fsImpl, probeImpl: probeWith({ ok: true, build: 1.5 }), ...WIN }),
    { ok: false, reason: 'runtime_probe_failed' });
  // A build the saved shape cannot hold would save the path without its number.
  assert.deepEqual(await validateRuntimeExecutable(FORK, { fsImpl, probeImpl: probeWith({ ok: true, build: 1_000_000_000 }), ...WIN }),
    { ok: false, reason: 'runtime_probe_failed' });
  assert.deepEqual(await validateRuntimeExecutable(FORK, { fsImpl, probeImpl: probeWith({ ok: true, build: 999_999_999 }), ...WIN }),
    { ok: true, build: 999_999_999, supportsMtp: false });
  const rejecting = async () => { throw new Error('boom'); };
  assert.deepEqual(await validateRuntimeExecutable(FORK, { fsImpl, probeImpl: rejecting, ...WIN }),
    { ok: false, reason: 'runtime_probe_failed' });
  assert.deepEqual(
    await validateRuntimeExecutable(FORK, { fsImpl, probeImpl: probeWith({ ok: true, build: 10683, supportsMtp: true }), ...WIN }),
    { ok: true, build: 10683, supportsMtp: true }
  );
  assert.equal(calls.every((options) => options.binaryPath === FORK && options.retryFailed === true), true);
});

test('reconcile keeps the saved runtime when an entry omits the field and clears it on an empty string', () => {
  const persisted = persistedWith({
    [BONSAI_KEY]: { engine: 'llama-server', tag: 'ternary-bonsai-2-27b-pq2_0', runtimePath: FORK, runtimeBuild: 10683 },
  });
  const kept = reconcileManagedRuntimePaths({
    enabled: true,
    perModel: { [BONSAI_KEY]: { engine: 'llama-server', tag: 'ternary-bonsai-2-27b-pq2_0', mtp: { mode: 'off' } } },
  }, { persisted, picks: createRuntimePickRegistry(), ...WIN });
  assert.deepEqual(kept.patch, {
    enabled: true,
    perModel: {
      [BONSAI_KEY]: {
        engine: 'llama-server', tag: 'ternary-bonsai-2-27b-pq2_0', mtp: { mode: 'off' }, runtimePath: FORK, runtimeBuild: 10683,
      },
    },
  });
  assert.deepEqual(kept.rejectedKeys, []);
  const cleared = reconcileManagedRuntimePaths({
    perModel: { [BONSAI_KEY]: { engine: 'llama-server', runtimePath: '', runtimeBuild: 10683 } },
  }, { persisted, picks: null, ...WIN });
  assert.deepEqual(cleared.patch.perModel[BONSAI_KEY], { engine: 'llama-server' });
  const echoed = reconcileManagedRuntimePaths({
    perModel: { [BONSAI_KEY]: { engine: 'llama-server', runtimePath: FORK, runtimeBuild: 1 } },
  }, { persisted, picks: null, ...WIN });
  assert.deepEqual(echoed.patch.perModel[BONSAI_KEY], { engine: 'llama-server', runtimePath: FORK, runtimeBuild: 10683 },
    'an echo of the saved path keeps the saved build, never the renderer-sent one');
  const fresh = reconcileManagedRuntimePaths({
    perModel: { 'gemma4-12b': { engine: 'llama-server' } },
  }, { persisted, picks: null, ...WIN });
  assert.deepEqual(fresh.patch.perModel['gemma4-12b'], { engine: 'llama-server' });
});

test('reconcile accepts a picked path once per patch and takes the build from the pick', () => {
  const persisted = persistedWith({});
  const picks = createRuntimePickRegistry();
  picks.record(FORK, { build: 10683, supportsMtp: true });
  const result = reconcileManagedRuntimePaths({
    perModel: {
      [BONSAI_KEY]: { engine: 'llama-server', runtimePath: FORK, runtimeBuild: 999999 },
      'zeta-model': { engine: 'llama-server', runtimePath: FORK },
    },
  }, { persisted, picks, ...WIN });
  assert.deepEqual(result.patch.perModel[BONSAI_KEY], { engine: 'llama-server', runtimePath: FORK, runtimeBuild: 10683 });
  assert.deepEqual(result.patch.perModel['zeta-model'], { engine: 'llama-server' }, 'the same pick cannot land twice');
  assert.deepEqual(result.acceptedPaths, [FORK]);
  assert.deepEqual(result.acceptedKeys, [BONSAI_KEY]);
  assert.deepEqual(result.rejectedKeys, ['zeta-model']);
  assert.equal(picks.has(FORK), true, 'reconcile never consumes; the write does');
});

test('reconcile rejects unpicked, malformed and non-string runtime paths and keeps the saved one', () => {
  const persisted = persistedWith({ [BONSAI_KEY]: { engine: 'llama-server', runtimePath: FORK, runtimeBuild: 10683 } });
  const picks = createRuntimePickRegistry();
  picks.record('C:\\x\\calc.exe', { build: 1, supportsMtp: false });
  for (const smuggled of [OTHER, 'C:\\x\\calc.exe', '\\\\evil\\share\\llama-server.exe', 42, null, true, { path: OTHER }, [OTHER]]) {
    const result = reconcileManagedRuntimePaths({
      perModel: { [BONSAI_KEY]: { engine: 'llama-server', runtimePath: smuggled } },
    }, { persisted, picks, ...WIN });
    assert.deepEqual(result.patch.perModel[BONSAI_KEY], { engine: 'llama-server', runtimePath: FORK, runtimeBuild: 10683 },
      JSON.stringify(smuggled));
    assert.deepEqual(result.rejectedKeys, [BONSAI_KEY]);
    assert.deepEqual(result.acceptedPaths, []);
  }
});

test('reconcile ignores inherited fields, canonicalizes keys and never pollutes prototypes', () => {
  const picks = createRuntimePickRegistry();
  picks.record(FORK, { build: 10683, supportsMtp: true });
  const inherited = Object.create({ runtimePath: FORK });
  inherited.engine = 'llama-server';
  const viaInheritance = reconcileManagedRuntimePaths({ perModel: { [BONSAI_KEY]: inherited } },
    { persisted: persistedWith({}), picks, ...WIN });
  assert.deepEqual(viaInheritance.patch.perModel[BONSAI_KEY], { engine: 'llama-server' });
  assert.deepEqual(viaInheritance.acceptedPaths, []);

  const parsed = JSON.parse(`{"perModel": {
    "__proto__": {"engine": "llama-server", "runtimePath": ${JSON.stringify(FORK)}},
    "Ternary-Bonsai-2-27B-PQ2_0": {"engine": "llama-server", "__proto__": {"runtimePath": ${JSON.stringify(FORK)}}},
    "constructor": null
  }}`);
  const result = reconcileManagedRuntimePaths(parsed, { persisted: persistedWith({}), picks, ...WIN });
  assert.equal(({}).runtimePath, undefined);
  assert.deepEqual(Object.keys(result.patch.perModel), ['constructor', BONSAI_KEY], 'a raw __proto__ key is dropped');
  assert.deepEqual(result.patch.perModel[BONSAI_KEY], { engine: 'llama-server' }, 'an own __proto__ field is dropped');
  assert.equal(Object.getPrototypeOf(result.patch.perModel[BONSAI_KEY]), Object.prototype);
  assert.equal(result.patch.perModel.constructor, null, 'a delete for a real key named constructor passes through');
  assert.deepEqual(result.acceptedPaths, []);
});

test('reconcile collapses keys that canonicalize together, last sorted key winning like the normalizer', () => {
  const picks = createRuntimePickRegistry();
  picks.record(FORK, { build: 10683, supportsMtp: false });
  picks.record(OTHER, { build: 10800, supportsMtp: false });
  const result = reconcileManagedRuntimePaths({
    perModel: {
      'Ternary-Bonsai-2-27B-PQ2_0': { engine: 'llama-server', runtimePath: FORK },
      [BONSAI_KEY]: { engine: 'llama-server', runtimePath: OTHER },
    },
  }, { persisted: persistedWith({}), picks, ...WIN });
  assert.deepEqual(Object.keys(result.patch.perModel), [BONSAI_KEY]);
  assert.deepEqual(result.patch.perModel[BONSAI_KEY], { engine: 'llama-server', runtimePath: OTHER, runtimeBuild: 10800 });
  assert.deepEqual(result.acceptedPaths, [OTHER]);
});

test('reconcile passes deletes and top-level fields through and drops malformed containers and keys', () => {
  const persisted = persistedWith({ [BONSAI_KEY]: { engine: 'llama-server', runtimePath: FORK, runtimeBuild: 10683 } });
  const result = reconcileManagedRuntimePaths({
    enabled: true,
    lastPickDir: 'G:\\llmmodels',
    perModel: { [BONSAI_KEY]: null, '###': { engine: 'llama-server' } },
  }, { persisted, picks: null, ...WIN });
  assert.deepEqual(result.patch, { enabled: true, lastPickDir: 'G:\\llmmodels', perModel: { [BONSAI_KEY]: null } });
  assert.deepEqual(reconcileManagedRuntimePaths({ enabled: true, perModel: [1] }, { persisted, ...WIN }).patch, { enabled: true });
  for (const junk of [null, undefined, 'x', 7, [{ perModel: {} }]]) {
    assert.deepEqual(reconcileManagedRuntimePaths(junk, { persisted, ...WIN }).patch, {});
  }
  const nonObjectEntry = reconcileManagedRuntimePaths({ perModel: { [BONSAI_KEY]: 'x' } }, { persisted, ...WIN });
  assert.deepEqual(nonObjectEntry.patch.perModel[BONSAI_KEY], { runtimePath: FORK, runtimeBuild: 10683 });
});

test('writeManagedPatch consumes accepted picks only after the write lands and logs keys, never paths', () => {
  const persisted = persistedWith({ 'gemma4-12b': { engine: 'llama-server', runtimePath: FORK, runtimeBuild: 10683 } });
  const picks = createRuntimePickRegistry();
  picks.record(OTHER, { build: 10800, supportsMtp: false });
  const logs = [];
  const log = (level, event, details) => logs.push({ level, event, details });
  const writes = [];
  const service = {
    getLocalEngines: () => ({ openaiCompatible: { managed: persisted } }),
    updateManagedLlamaServer: (patch) => {
      writes.push(patch);
      persisted.perModel = { ...persisted.perModel, ...patch.perModel };
      return { ok: 'state' };
    },
  };
  const payload = { perModel: {
    [BONSAI_KEY]: { engine: 'llama-server', runtimePath: OTHER },
    'gemma4-12b': { engine: 'llama-server', runtimePath: 'C:\\evil\\llama-server.exe' },
  } };
  assert.deepEqual(writeManagedPatch({ shellConfigService: service, patch: payload, picks, log, ...WIN }), { ok: 'state' });
  assert.deepEqual(writes[0].perModel[BONSAI_KEY], { engine: 'llama-server', runtimePath: OTHER, runtimeBuild: 10800 });
  assert.deepEqual(writes[0].perModel['gemma4-12b'], { engine: 'llama-server', runtimePath: FORK, runtimeBuild: 10683 });
  assert.equal(picks.has(OTHER), false, 'an accepted pick is single-use');
  assert.deepEqual(logs.map((entry) => [entry.level, entry.event, entry.details]), [
    ['WARN', 'engines.managed_runtime_rejected', { keys: ['gemma4-12b'] }],
    ['INFO', 'engines.managed_runtime_accepted', { keys: [BONSAI_KEY] }],
  ]);
  assert.equal(/llama-server\.exe|:\\/.test(JSON.stringify(logs)), false);

  picks.record(OTHER, { build: 10800, supportsMtp: false });
  const failing = { ...service, updateManagedLlamaServer: () => { throw new Error('disk full'); } };
  assert.throws(() => writeManagedPatch({ shellConfigService: failing, patch: payload, picks, log, ...WIN }), /disk full/);
  assert.equal(picks.has(OTHER), true, 'a failed write keeps the pick for a retry');
});

test('a write that returns without saving the runtime keeps the pick and claims nothing (T3)', () => {
  const picks = createRuntimePickRegistry();
  picks.record(OTHER, { build: 10800, supportsMtp: false });
  const logs = [];
  const service = {
    getLocalEngines: () => ({ openaiCompatible: { managed: persistedWith({}) } }),
    // A newer config version or the per-model cap: the call succeeds, nothing lands.
    updateManagedLlamaServer: () => ({ ok: 'state' }),
  };
  writeManagedPatch({
    shellConfigService: service,
    patch: { perModel: { [BONSAI_KEY]: { engine: 'llama-server', runtimePath: OTHER } } },
    picks,
    log: (level, event, details) => logs.push({ level, event, details }),
    ...WIN,
  });
  assert.equal(picks.has(OTHER), true, 'the user can Apply again without picking again');
  assert.deepEqual(logs, []);
});

test('only a build tag from the folder name reaches lastError, never the name itself (T4, T7)', () => {
  assert.equal(runtimeFolderToken('C:\\Users\\jane.doe\\llama-server.exe', WIN), 'runtime');
  assert.equal(runtimeFolderToken('D:\\AI Tools\\Jane Doe\\llama-server.exe', WIN), 'runtime');
  assert.equal(runtimeFolderToken('/home/jane/llama-server', { platform: 'linux' }), 'runtime');
  assert.equal(runtimeFolderToken('D:\\tools\\llama.cpp\\llama-server.exe', WIN), 'runtime');
  assert.equal(runtimeFolderToken('D:\\builds\\b10800\\llama-server.exe', WIN), 'b10800');
  assert.equal(runtimeFolderToken('D:\\builds\\cuda-b10800-x64\\llama-server.exe', WIN), 'b10800');
  assert.equal(runtimeFolderToken('D:\\builds\\bob1234\\llama-server.exe', WIN), 'runtime');
  // Names that merely contain "llama" or a build tag are never echoed.
  assert.equal(runtimeFolderToken('D:\\Jane Smith b1990\\llama-server.exe', WIN), 'b1990');
  assert.equal(runtimeFolderToken('D:\\jdoe-llama\\llama-server.exe', WIN), 'runtime');
  assert.equal(runtimeFolderToken('D:\\Villamar\\llama-server.exe', WIN), 'runtime');
  assert.equal(runtimeFolderToken('D:\\Acme Corp llama pilot\\llama-server.exe', WIN), 'runtime');
  assert.equal(runtimeFolderToken('D:\\LLAMA-B10683\\llama-server.exe', WIN), 'b10683');
  assert.equal(runtimeFolderToken('D:\\b1234567890\\llama-server.exe', WIN), 'runtime');
});

test('resolveLaunchRuntime: env beats a saved runtime, a missing saved runtime never falls back', () => {
  const bundled = 'C:\\app\\llama_server_extract\\llama-server.exe';
  const resolveBundledPath = () => bundled;
  const fsImpl = fakeFs(new Set([FORK]));
  assert.deepEqual(resolveLaunchRuntime({ binaryOverride: 'E:\\env\\llama-server.exe', runtimePath: FORK, resolveBundledPath, fsImpl, ...WIN }),
    { binaryPath: 'E:\\env\\llama-server.exe', source: 'env', shadowed: true, error: '' });
  assert.deepEqual(resolveLaunchRuntime({ binaryOverride: 'E:\\env\\llama-server.exe', resolveBundledPath, fsImpl, ...WIN }),
    { binaryPath: 'E:\\env\\llama-server.exe', source: 'env', shadowed: false, error: '' });
  assert.deepEqual(resolveLaunchRuntime({ runtimePath: FORK, resolveBundledPath, fsImpl, ...WIN }),
    { binaryPath: FORK, source: 'saved', shadowed: false, error: '' });
  assert.deepEqual(resolveLaunchRuntime({ runtimePath: OTHER, resolveBundledPath, fsImpl, ...WIN }),
    { binaryPath: '', source: 'saved', shadowed: false, error: 'llama_server_runtime_missing:b10800' });
  assert.deepEqual(resolveLaunchRuntime({ runtimePath: '', resolveBundledPath, fsImpl, ...WIN }),
    { binaryPath: bundled, source: 'bundled', shadowed: false, error: '' });
  const directoryFs = { statSync: () => ({ isFile: () => false }) };
  assert.equal(resolveLaunchRuntime({ runtimePath: FORK, resolveBundledPath, fsImpl: directoryFs, ...WIN }).error,
    'llama_server_runtime_missing:b10683');
});

test('runtimeFolderToken bounds what reaches lastError and Diagnostics to a build tag', () => {
  assert.equal(runtimeFolderToken(FORK, WIN), 'b10683');
  assert.equal(runtimeFolderToken('C:\\x\\bad$name\\llama-server.exe', WIN), 'runtime');
  assert.equal(runtimeFolderToken(`C:\\${'a'.repeat(65)}\\llama-server.exe`, WIN), 'runtime');
  assert.equal(runtimeFolderToken('C:\\llama-server.exe', WIN), 'runtime');
  assert.equal(runtimeFolderToken('/opt/llama prism 2/llama-server', { platform: 'linux' }), 'runtime');
});

test('describeRuntimeLabel prefers the probe cache, then the saved build, and names env and bundled', () => {
  const peekWith = (result) => () => result;
  assert.equal(describeRuntimeLabel({ source: 'env', binaryPath: 'E:\\x\\llama-server.exe' }, { peekImpl: peekWith(null) }), 'env');
  assert.equal(describeRuntimeLabel({ source: 'bundled', binaryPath: 'C:\\b\\llama-server.exe' }, { peekImpl: peekWith(null) }), 'bundled');
  assert.equal(describeRuntimeLabel({ source: 'saved', binaryPath: FORK },
    { runtimeBuild: 1, peekImpl: peekWith({ ok: true, build: 10683 }) }), 'build 10683');
  assert.equal(describeRuntimeLabel({ source: 'saved', binaryPath: FORK }, { runtimeBuild: 10683, peekImpl: peekWith(null) }), 'build 10683');
  assert.equal(describeRuntimeLabel({ source: 'saved', binaryPath: FORK },
    { runtimeBuild: 0, peekImpl: peekWith({ ok: false, build: 0 }) }), 'custom');
  assert.equal(describeRuntimeLabel({ source: 'saved', binaryPath: '', error: 'llama_server_runtime_missing:x' }, {}), '');
  assert.equal(describeRuntimeLabel(null, {}), '');
});
