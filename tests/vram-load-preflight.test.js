const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  TOLERANCE_MB,
  checkOllamaLoad,
  createVramLoadPreflight,
  estimateLlamaServerMb,
  estimateNinferMb,
  refusalMessageForStatus,
  withVramPreflight,
} = require('../services/backend/vram-load-preflight');
const { parseLinuxHolders, parseWindowsHolders } = require('../services/gpu-memory-holders');

const MIB = 1024 * 1024;

function vramSample(usedMb, totalMb = 32607) {
  return { available: true, usedMb, totalMb, devices: [{ index: 0, usedMb, totalMb }] };
}

function holder(pid, name, mb, parents = []) {
  return { pid, name, mb, chain: [{ pid, name }, ...parents] };
}

function preflight({ samples, holders = [], enabled = true, onHolders } = {}) {
  const queue = [...samples];
  let clock = 0;
  const logs = [];
  const instance = createVramLoadPreflight({
    probeVram: async () => (queue.length > 1 ? queue.shift() : queue[0]),
    listHolders: async () => {
      onHolders?.();
      return holders;
    },
    isEnabled: () => enabled,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    log: (level, event, payload) => logs.push({ level, event, payload }),
  });
  return { instance, logs };
}

function fakeFs(sizes, dirs = {}) {
  return {
    statSync(filePath) {
      if (!(filePath in sizes)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: sizes[filePath] };
    },
    readdirSync(dir) {
      if (!(dir in dirs)) throw new Error('ENOENT');
      return dirs[dir];
    },
  };
}

test('2026-11-13 replay: NInfer at 196K beside a 24 GB foreign server is refused and the server is named', async () => {
  const fs = fakeFs({ 'G:/m/qwen.ninfer': 23719715844 });
  const requiredMb = estimateNinferMb({
    artifactPath: 'G:/m/qwen.ninfer', contextSize: 196608, kvDtype: 'fp8', vision: true, mtp: true,
  }, fs);
  // Measured on the card: ~30.1 GB in use after load at this window (config/ninfer-artifacts.json).
  assert.ok(requiredMb > 29500 && requiredMb < 30700, String(requiredMb));
  const { instance, logs } = preflight({
    samples: [vramSample(24445)],
    holders: [holder(25432, 'llama-server.exe', 23496), holder(2516, 'dwm.exe', 510, [{ pid: 2060, name: 'winlogon.exe' }])],
  });
  const verdict = await instance.check({ engine: 'ninfer', model: 'qwen3.8-27b-nvfp4', requiredMb });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'vram_in_use');
  assert.deepEqual(verdict.holders.map((entry) => entry.name), ['llama-server.exe', 'dwm.exe']);
  assert.match(verdict.message, /qwen3\.8-27b-nvfp4 needs about 29\.\d GB/);
  assert.match(verdict.message, /only 8\.0 GB is free/);
  assert.match(verdict.message, /llama-server\.exe \(22\.9 GB\)/);
  assert.equal(instance.getLastRefusal().requiredMb, requiredMb);
  assert.equal(logs.at(-1).event, 'vram_preflight.refused');
});

test('a load that fits never lists holders', async () => {
  const { instance } = preflight({
    samples: [vramSample(1500)],
    onHolders: () => assert.fail('holders listed on a load that fits'),
  });
  assert.deepEqual(await instance.check({ engine: 'ninfer', requiredMb: 30000 }), { ok: true, reason: 'fits' });
});

test('a shortfall inside the tolerance is admitted', async () => {
  const { instance } = preflight({ samples: [vramSample(32607 - 20000)] });
  const verdict = await instance.check({ engine: 'llama-server', requiredMb: 20000 + TOLERANCE_MB });
  assert.equal(verdict.ok, true);
});

test('memory freed while the previous engine exits is waited for', async () => {
  const { instance } = preflight({ samples: [vramSample(26000), vramSample(26000), vramSample(1500)] });
  assert.deepEqual(await instance.check({ engine: 'ninfer', requiredMb: 30000 }), { ok: true, reason: 'settled' });
});

test('only the processes the load frees count as free, by their parent chain', async () => {
  const replaced = holder(900, 'llama-server.exe', 23000, [{ pid: 4242, name: 'electron.exe' }]);
  const jennyGpu = holder(950, 'electron.exe', 900, [{ pid: 4242, name: 'electron.exe' }]);
  const { instance } = preflight({ samples: [vramSample(25000)], holders: [replaced, jennyGpu] });
  assert.deepEqual(await instance.check({ engine: 'ollama', requiredMb: 28000, reclaimPids: [900] }), { ok: true, reason: 'reclaimable' });
  // Jenny's own GPU process is not freed by a load: without the replaced server the load is refused.
  const refused = await preflight({ samples: [vramSample(25000)], holders: [replaced, jennyGpu] })
    .instance.check({ engine: 'ollama', requiredMb: 28000, reclaimPids: [0, null] });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.holders.map((entry) => entry.pid), [900, 950]);
});

test('a credit (Ollama resident models) is used before any process lookup, and admitIf before both', async () => {
  const credited = preflight({ samples: [vramSample(25000)], onHolders: () => assert.fail('holders listed') });
  assert.deepEqual(await credited.instance.check({ requiredMb: 20000, creditMb: async () => 14000 }), { ok: true, reason: 'credited' });
  const skipped = preflight({ samples: [vramSample(30000)], onHolders: () => assert.fail('holders listed') });
  assert.deepEqual(await skipped.instance.check({
    requiredMb: 20000, admitIf: async () => 'port_answering', creditMb: () => assert.fail('credit read'),
  }), { ok: true, reason: 'port_answering' });
  let estimated = 0;
  await preflight({ samples: [vramSample(1000)] }).instance.check({ requiredMb: () => { estimated += 1; return 1000; } });
  assert.equal(estimated, 1);
  const off = preflight({ samples: [vramSample(1000)], enabled: false });
  assert.equal((await off.instance.check({ requiredMb: () => assert.fail('estimate computed with the check off') })).reason, 'disabled');
});

test('a model larger than the whole card is left to the engine fit', async () => {
  const { instance } = preflight({ samples: [vramSample(1500, 16303)] });
  assert.deepEqual(await instance.check({ engine: 'llama-server', requiredMb: 22000 }), { ok: true, reason: 'exceeds_card' });
});

test('no estimate, no GPU, or a failing probe admits the load', async () => {
  assert.equal((await preflight({ samples: [vramSample(30000)] }).instance.check({ requiredMb: 0 })).reason, 'no_estimate');
  const noGpu = preflight({ samples: [{ available: false }] });
  assert.equal((await noGpu.instance.check({ requiredMb: 20000 })).reason, 'probe_unavailable');
  const broken = createVramLoadPreflight({ probeVram: async () => { throw new Error('boom'); }, isEnabled: () => true });
  assert.equal((await broken.check({ requiredMb: 20000 })).ok, true);
});

test('an unnamed refusal still says what to do', async () => {
  const { instance } = preflight({ samples: [vramSample(24000)], holders: [] });
  const verdict = await instance.check({ engine: 'llama-server', model: 'big', requiredMb: 25000 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /Close other programs that use the GPU/);
});

test('llama-server estimate sums every shard, the projector and the drafter; CPU placement is not checked', () => {
  const dir = path.join('models', 'qwen');
  const file = (name) => path.join(dir, name);
  const fs = fakeFs({
    [file('Q-00001-of-00002.gguf')]: 10000 * MIB,
    [file('Q-00002-of-00002.gguf')]: 8000 * MIB,
    [file('mmproj.gguf')]: 900 * MIB,
    [file('mtp.gguf')]: 500 * MIB,
  }, { [dir]: ['Q-00001-of-00002.gguf', 'Q-00002-of-00002.gguf', 'mmproj.gguf', 'mtp.gguf', 'Other-00001-of-00002.gguf'] });
  const model = file('Q-00001-of-00002.gguf');
  assert.equal(estimateLlamaServerMb({ modelPath: model, projectorPath: file('mmproj.gguf') }, fs), 18000 + 900 + 1024);
  assert.equal(estimateLlamaServerMb({
    modelPath: model, extraArgs: ['--spec-type', 'draft-mtp', '-md', file('mtp.gguf')],
  }, fs), 18000 + 500 + 1024 + 1024);
  // ngram speculation loads no draft model.
  assert.equal(estimateLlamaServerMb({ modelPath: model, extraArgs: ['--spec-type', 'ngram-cache'] }, fs), 18000 + 1024);
  assert.equal(estimateLlamaServerMb({ modelPath: file('missing.gguf') }, fs), 0);
  // A profile that keeps layers or experts on the CPU is the owner's offload choice.
  for (const extraArgs of [['-ngl', '20'], ['--n-cpu-moe', '12'], ['-ot', 'exps=CPU'], ['-ngl', '0']]) {
    assert.equal(estimateLlamaServerMb({ modelPath: model, extraArgs }, fs), 0, extraArgs.join(' '));
  }
  // The memory plan's own `-ngl all` and `--fit-target` keep the check on.
  assert.ok(estimateLlamaServerMb({ modelPath: model, extraArgs: ['-ngl', 'all', '--fit-target', '1024'] }, fs) > 0);
});

test('NInfer estimate follows the KV dtype, vision and the LM-head draft', () => {
  const fs = fakeFs({ a: 22000 * MIB });
  assert.equal(estimateNinferMb({ artifactPath: 'a', contextSize: 65536 }, fs), 22000 + 4096);
  assert.equal(estimateNinferMb({ artifactPath: 'a', contextSize: 65536, kvDtype: 'fp8', vision: true, mtp: true }, fs), 22000 + 2048 + 1024 + 370);
  assert.equal(estimateNinferMb({ artifactPath: 'a', contextSize: 65536, mtp: true, lmHeadDraft: false }, fs), 22000 + 4096);
});

test('the launch wrapper refuses before the spawn, skips identity restores, adopts, and honours a stop', async () => {
  const refusal = { ok: false, reason: 'vram_in_use', message: 'copy', holders: [] };
  const spawned = [];
  const checks = [];
  const lifecycle = { startLlamaServer: async (options) => { spawned.push(options); return { pid: 1 }; }, DEFAULT_PORT: 8033 };
  let portOpen = false;
  const wrapped = withVramPreflight(lifecycle, {
    startKey: 'startLlamaServer', engine: 'llama-server', estimate: () => 25000, pidFileName: 'none.pid',
    getPreflight: () => ({ check: async (request) => {
      checks.push(request);
      return (await request.admitIf()) ? { ok: true } : refusal;
    } }),
    isPortAnswering: async () => portOpen,
  });
  assert.equal(wrapped.DEFAULT_PORT, 8033);
  await assert.rejects(wrapped.startLlamaServer({ port: 8033 }), (error) => {
    assert.equal(error.message, 'vram_in_use');
    assert.equal(error.vramRefusal.message, 'copy');
    return true;
  });
  assert.equal(spawned.length, 0);
  assert.equal(checks[0].requiredMb(), 25000);
  assert.deepEqual(checks[0].reclaimPids, [0]);
  await wrapped.startLlamaServer({ port: 8033, retainedApiKey: 'k', adopt: false });
  portOpen = true;
  await wrapped.startLlamaServer({ port: 8033 });
  await assert.rejects(wrapped.startLlamaServer({ port: 8033, adopt: false }), /vram_in_use/);
  const controller = new AbortController();
  controller.abort();
  await wrapped.startLlamaServer({ port: 8033, adopt: false, abortSignal: controller.signal });
  assert.equal(spawned.length, 3);
  const unchecked = withVramPreflight(lifecycle, { startKey: 'startLlamaServer', estimate: () => 1, getPreflight: () => null });
  await unchecked.startLlamaServer({});
  assert.equal(spawned.length, 4);
});

test("the orphan named in Jenny's pidfile is passed as reclaimable", async (t) => {
  const os = require('node:os');
  const fsReal = require('node:fs');
  const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), 'vram-preflight-'));
  t.after(() => fsReal.rmSync(dir, { recursive: true, force: true }));
  fsReal.writeFileSync(path.join(dir, 'ninfer-serve.pid'), JSON.stringify({ pid: 31337, command: 'x' }));
  let seen = null;
  const wrapped = withVramPreflight({ startNinferServer: async () => ({ pid: 2 }) }, {
    startKey: 'startNinferServer', engine: 'ninfer', estimate: () => 1, pidFileName: 'ninfer-serve.pid',
    getPreflight: () => ({ check: async (request) => { seen = request; return { ok: true }; } }),
  });
  await wrapped.startNinferServer({ userDataPath: dir });
  assert.deepEqual(seen.reclaimPids, [31337]);
});

test('a managed status the check refused maps to the refusal copy; any other status maps to nothing', () => {
  const service = { vramLoadPreflight: { getLastRefusal: () => ({ message: 'Close game.exe (9.0 GB).' }) } };
  assert.equal(refusalMessageForStatus(service, { lastError: 'vram_in_use' }), 'Close game.exe (9.0 GB).');
  assert.equal(refusalMessageForStatus(service, { lastError: 'llama_server_exited:1' }), '');
  assert.equal(refusalMessageForStatus({}, { lastError: 'vram_in_use' }), '');
});

test('an Ollama load needs its reported weights and gets its resident models as credit', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = String(url).endsWith('/api/tags')
      ? { models: [{ name: 'gemma4:12b', size: 9000 * MIB }, { name: 'other:latest', size: 1 }] }
      : { models: [{ name: 'old:latest', size_vram: 12000 * MIB }] };
    return { ok: true, json: async () => body };
  };
  const requests = [];
  const service = {
    ollamaManager: { _host: '127.0.0.1', _port: 11500 },
    vramLoadPreflight: { check: async (request) => {
      requests.push(request);
      return { ok: true, credit: await request.creditMb() };
    } },
  };
  const verdict = await checkOllamaLoad(service, 'gemma4:12b', { reclaimPids: [77] });
  assert.equal(requests[0].requiredMb, 9000 + 1024);
  assert.deepEqual(requests[0].reclaimPids, [77]);
  assert.equal(verdict.credit, 12000);
  assert.ok(urls.every((url) => url.startsWith('http://127.0.0.1:11500/')));
  await checkOllamaLoad(service, 'missing:tag');
  assert.equal(requests[1].requiredMb, 0);
  assert.deepEqual(await checkOllamaLoad({}, 'gemma4:12b'), { ok: true, reason: 'no_preflight' });
});

test('holder parsers keep names and parent chains and drop small or malformed rows', () => {
  const windows = parseWindowsHolders(JSON.stringify([
    { pid: 25432, mb: 23496, chain: [{ pid: 25432, name: 'llama-server.exe' }] },
    { pid: 3, mb: 100, chain: [] },
    { pid: 'x', mb: 9000 },
  ]));
  assert.deepEqual(windows, [{ pid: 25432, mb: 23496, name: 'llama-server.exe', chain: [{ pid: 25432, name: 'llama-server.exe' }] }]);
  assert.deepEqual(parseWindowsHolders('{"pid":7,"mb":4000,"chain":[{"pid":7,"name":"a.exe"}]}').map((entry) => entry.name), ['a.exe']);
  assert.deepEqual(parseWindowsHolders('not json'), []);
  const proc = {
    '/proc/50/stat': '50 (llama server) S 40 50 50 0',
    '/proc/40/stat': '40 (ollama) S 1 40 40 0',
    '/proc/1/stat': '1 (systemd) S 0 1 1 0',
  };
  const linux = parseLinuxHolders('50, 12000\n60, 100\n', { readFileSync: (file) => {
    if (!(file in proc)) throw new Error('ENOENT');
    return proc[file];
  } });
  assert.equal(linux.length, 1);
  assert.equal(linux[0].name, 'llama server');
  assert.deepEqual(linux[0].chain.map((link) => link.name), ['llama server', 'ollama', 'systemd']);
});
