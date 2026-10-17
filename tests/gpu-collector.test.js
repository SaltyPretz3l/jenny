'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createGpuCollector } = require('../services/performance/gpu-collector');
const { systemPowerShellPath } = require('../services/artifact-open-with');
const { sanitizeSpawnEnv } = require('../services/backend/sanitize-spawn-env');
const helper = path.join(__dirname, '../services/performance/gpu-memory-win32.ps1');
const identity = { pid: 10, createdAt: '123' };
const csv = 'GPU-other, 00000000:03:00.0, 8192, 4096, 4096\nGPU-managed, 00000000:01:00.0, 32768, 31744, 1024\n';
function raw() { return { ok: true, adapters: [
  { luid: 'a', physical_index: 0, pci_bus_id: '0000:01:00.0', shared_used_bytes: 50 },
  { luid: 'b', physical_index: 0, pci_bus_id: '0000:03:00.0', shared_used_bytes: 80 }],
  processes: [{ pid: 10, created_at: '123', luid: 'a', physical_index: 0, basename: 'ninfer.exe', dedicated_bytes: 100, shared_bytes: 20 },
    { pid: 20, created_at: '456', luid: 'a', physical_index: 0, basename: 'other.exe', dedicated_bytes: 200, shared_bytes: 30 }] }; }
function child() {
  const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.kill = () => { c.killed = true; }; return c;
}
function fixture(t, options = {}, response = raw()) {
  const children = []; const calls = []; const execCalls = []; const requests = [];
  const collector = createGpuCollector({ platform: 'win32', now: () => 42,
    spawn: (...args) => {
      calls.push(args); const c = child(); children.push(c);
      queueMicrotask(() => c.stdout.write('{"event":"ready"}\n'));
      c.stdin.on('data', data => { requests.push(JSON.parse(data));
        if (response !== null) queueMicrotask(() => c.stdout.write(JSON.stringify(response) + '\n')); });
      return c;
    }, execFile: (...args) => { execCalls.push(args); args[3](null, csv); }, ...options });
  t.after(() => collector.dispose()); return { collector, children, calls, execCalls, requests };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('persistent hidden helper sends only data and maps LUID through PCI, independent of row order', async t => {
  const f = fixture(t); const sample = await f.collector.sample({ ...identity, ignored: '$(whoami)' });
  assert.equal(sample.state, 'fresh'); assert.equal(sample.adapter.gpu_uuid, 'GPU-managed');
  assert.equal(sample.adapter.dedicated_free_bytes, 1024 ** 3); assert.equal(sample.adapter.shared_used_bytes, 50);
  assert.equal(sample.sampled_at, 42); assert.equal(sample.managed_process.pid, 10);
  assert.equal(sample.external_processes[0].pid, 20);
  assert.deepEqual(f.requests, [{ pid: 10, createdAt: '123' }]);
  await f.collector.sample(identity); assert.equal(f.calls.length, 1);
  const [exe, args, opts] = f.calls[0]; assert.equal(exe, systemPowerShellPath());
  assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper]);
  assert.equal(opts.windowsHide, true); assert.equal(opts.shell, false); assert.deepEqual(opts.env, sanitizeSpawnEnv(process.env));
  assert.equal(f.execCalls[0][0], 'nvidia-smi');
  assert.equal(f.execCalls[0][1][0], '--query-gpu=uuid,pci.bus_id,memory.total,memory.used,memory.free');
  assert.equal(f.execCalls[0][2].windowsHide, true); assert.deepEqual(f.execCalls[0][2].env, sanitizeSpawnEnv(process.env));
  f.collector.dispose(); assert.equal(f.children[0].killed, true);
});
test('single in-flight promise and timeout kill owned helper; next sample restarts', async t => {
  const f = fixture(t, {}, null); const first = f.collector.sample(identity);
  assert.equal(f.collector.sample(identity), first);
  const result = await first; assert.equal(result.reason, 'sample_timeout'); assert.equal(f.children[0].killed, true);
  const second = f.collector.sample(identity); await tick(); assert.equal(f.children.length, 2);
  f.children[1].stdout.write(JSON.stringify(raw()) + '\n'); assert.equal((await second).state, 'fresh');
});
test('fail closed on missing helper, spawn throw, child/stdin errors, constrained host and disposal', async t => {
  for (const opts of [{ helperPath: path.join(__dirname, 'missing-helper.ps1') },
    { spawn: () => { throw new Error('C:/private/secret'); } },
    ...['error', 'close', 'stdin'].map(event => ({ spawn: () => {
      const c = child(); queueMicrotask(() => event === 'stdin' ? c.stdin.emit('error', new Error('secret')) : c.emit(event)); return c;
    } })),
    { spawn: () => { const c = child(); queueMicrotask(() => c.stdout.write('{"ok":false,"reason":"FullLanguage"}\n')); return c; } }]) {
    const f = fixture(t, opts); const result = await f.collector.sample(identity);
    assert.equal(result.state, 'unavailable'); assert.doesNotMatch(JSON.stringify(result), /private|secret|C:\//);
  }
  const f = fixture(t); f.collector.dispose(); assert.equal((await f.collector.sample(identity)).reason, 'disposed');
});
test('an environment failure before readiness keeps its reason and latches; no respawn per sample', async t => {
  let spawns = 0;
  const f = fixture(t, { spawn: () => { spawns++; const c = child(); queueMicrotask(() => c.stdout.write('{"ok":false,"reason":"pdh_unavailable"}\n')); return c; } });
  assert.equal((await f.collector.sample(identity)).reason, 'pdh_unavailable');
  assert.equal((await f.collector.sample(identity)).reason, 'pdh_unavailable');
  assert.equal(spawns, 1);
});
test('other startup failures back off from 30 s, doubling, and a successful start resets it', async t => {
  let clock = 1000; let spawns = 0; let healthy = false;
  const f = fixture(t, { now: () => clock, spawn: () => {
    spawns++; const c = child();
    queueMicrotask(() => { if (healthy) c.stdout.write('{"event":"ready"}\n'); else c.emit('close'); });
    c.stdin.on('data', () => queueMicrotask(() => c.stdout.write(JSON.stringify(raw()) + '\n')));
    return c;
  } });
  assert.equal((await f.collector.sample(identity)).reason, 'helper_unavailable'); assert.equal(spawns, 1);
  clock += 29000; await f.collector.sample(identity); assert.equal(spawns, 1, 'inside the 30 s window');
  clock += 2000; await f.collector.sample(identity); assert.equal(spawns, 2, 'retried after 30 s');
  clock += 31000; await f.collector.sample(identity); assert.equal(spawns, 2, 'second failure doubles to 60 s');
  clock += 30000; healthy = true; assert.equal((await f.collector.sample(identity)).state, 'fresh'); assert.equal(spawns, 3);
});
test('release ends an idle helper and the next sample respawns it', async t => {
  const f = fixture(t); await f.collector.sample(identity);
  f.collector.release(); assert.equal(f.children[0].killed, true);
  assert.equal((await f.collector.sample(identity)).state, 'fresh'); assert.equal(f.calls.length, 2);
});
test('a null helper line fails closed instead of throwing in the data handler', async t => {
  const f = fixture(t, { spawn: () => { const c = child(); queueMicrotask(() => c.stdout.write('null\n')); return c; } });
  assert.equal((await f.collector.sample(identity)).state, 'unavailable');
});
test('startup handshake has a five second bound and kills only the owned helper', async t => {
  const c = child(); const f = fixture(t, { spawn: () => c });
  assert.equal((await f.collector.sample(identity)).reason, 'helper_startup_timeout'); assert.equal(c.killed, true);
});
test('line cap counts UTF-8 bytes, handles split lines, resets per line and ignores old child events', async t => {
  const f = fixture(t, {}, null); const promise = f.collector.sample(identity); await tick();
  f.children[0].stdout.write('é'.repeat(131073)); assert.equal((await promise).reason, 'helper_line_limit');
  const next = f.collector.sample(identity); await tick();
  f.children[0].emit('close'); f.children[0].stdout.write('bad old output\n');
  const message = JSON.stringify(raw()) + '\n'; const split = message.length >> 1;
  f.children[1].stdout.write(message.slice(0, split)); f.children[1].stdout.write(message.slice(split));
  assert.equal((await next).state, 'fresh');
});
test('invalid JSON and oversized complete lines fail closed', async t => {
  for (const line of ['invalid\n', 'x'.repeat(262145) + '\n']) {
    const f = fixture(t, {}, null); const p = f.collector.sample(identity); await tick(); f.children[0].stdout.write(line);
    assert.equal((await p).state, 'unavailable'); assert.equal(f.children[0].killed, true);
  }
});
test('process identity requires PID and creation time and rejects ambiguity', async t => {
  for (const mutate of [r => { r.processes[0].created_at = '134'; }, r => { r.processes[0].created_at = null; },
    r => r.processes.push({ ...r.processes[0] }), r => { r.processes[0].pid = 11; }]) {
    const r = raw(); mutate(r); const f = fixture(t, {}, r);
    const result = await f.collector.sample(identity); assert.equal(result.reason, 'ambiguous_identity'); assert.equal(result.managed_process, null);
  }
});
test('creation times match within the one-microsecond CIM precision only', async t => {
  for (const [helperTicks, state] of [['1230', 'fresh'], ['1239', 'fresh'], ['1240', 'fresh'], ['1241', 'unavailable']]) {
    const r = raw(); r.processes[0].created_at = helperTicks; const f = fixture(t, {}, r);
    assert.equal((await f.collector.sample({ pid: 10, createdAt: '1230' })).state, state);
  }
});
test('a managed row on an adapter without an NVIDIA device does not make attribution ambiguous', async t => {
  const r = raw(); r.adapters.push({ luid: 'c', physical_index: 0, pci_bus_id: '0000:00:02.0', shared_used_bytes: 0 });
  r.processes.push({ ...r.processes[0], luid: 'c', dedicated_bytes: 0 }, { ...r.processes[0], physical_index: 1 });
  const s = await fixture(t, {}, r).collector.sample(identity);
  assert.equal(s.state, 'fresh'); assert.equal(s.adapter.gpu_uuid, 'GPU-managed'); assert.equal(s.managed_process.dedicated_bytes, 100);
});
test('UTC ISO identity normalizes to the CIM UTC .NET tick representation', async t => {
  const r = raw(); r.processes[0].created_at = '638712864000000000';
  const f = fixture(t, {}, r); assert.equal((await f.collector.sample({ pid: 10, createdAt: '2025-01-01T00:00:00Z' })).state, 'fresh');
});
test('unmapped or ambiguous PCI and multi-physical rows are never guessed by name or order', async t => {
  for (const mutate of [r => { r.adapters[0].pci_bus_id = null; }, r => { r.adapters[0].pci_bus_id = '0000:05:00.0'; },
    r => r.adapters.push({ ...r.adapters[0] }), r => r.processes.push({ ...r.processes[0], luid: 'b' })]) {
    const r = raw(); mutate(r); const f = fixture(t, {}, r); assert.equal((await f.collector.sample(identity)).state, 'unavailable');
  }
});
test('external rows are adapter scoped, basename only, top eight, with omitted count and null unknown bytes', async t => {
  const r = raw(); r.processes = [r.processes[0]];
  for (let i = 0; i < 12; i++) r.processes.push({ pid: 30 + i, created_at: '1', luid: 'a', physical_index: 0,
    basename: 'C:\\private\\app.exe', dedicated_bytes: i * 100, shared_bytes: null });
  r.processes.push({ ...r.processes[1], pid: 99, luid: 'b', dedicated_bytes: 99999 });
  const f = fixture(t, {}, r); const s = await f.collector.sample(identity);
  assert.equal(s.external_processes.length, 8); assert.equal(s.external_processes[0].pid, 41);
  assert.equal(s.external_processes[0].basename, 'app.exe'); assert.equal(s.external_processes[0].shared_bytes, null);
  assert.equal(s.other_process_count, 4); assert.equal(s.truncated, true); assert.doesNotMatch(JSON.stringify(s), /private/);
});
test('all helper coverage limits yield partial and truncated, never sum process allocations', async t => {
  for (const mutate of [r => { r.truncated = true; }, r => { r.scanned_instances = 4097; },
    r => { while (r.adapters.length < 17) r.adapters.push({ luid: 'unused' }); },
    r => { while (r.processes.length < 257) r.processes.push({ ...r.processes[1], pid: r.processes.length + 100 }); }]) {
    const r = raw(); mutate(r); const f = fixture(t, {}, r); const s = await f.collector.sample(identity);
    assert.equal(s.state, 'partial'); assert.equal(s.truncated, true); assert.equal(s.adapter.dedicated_used_bytes, 31744 * 1024 ** 2);
  }
});
test('impossible bytes and framebuffer totals are rejected rather than clamped; unknown stays null', async t => {
  for (const output of ['GPU-a, 0000:01:00.0, 10, 11, 0', 'GPU-a, 0000:01:00.0, 10, 8, 3',
    'GPU-a, 0000:01:00.0, 10, -1, 5', 'GPU-a, 0000:01:00.0, 9007199254740991, 0, 0']) {
    const f = fixture(t, { execFile: (_e, _a, _o, cb) => cb(null, output) });
    assert.equal((await f.collector.sample(identity)).reason, 'invalid_framebuffer');
  }
  const r = raw(); r.processes[0].shared_bytes = -1; const bad = fixture(t, {}, r);
  assert.equal((await bad.collector.sample(identity)).reason, 'invalid_process_bytes');
  const f = fixture(t, { execFile: (_e, _a, _o, cb) => cb(null, 'GPU-a, 0000:01:00.0, 32768, N/A, N/A') });
  assert.equal((await f.collector.sample(identity)).adapter.dedicated_free_bytes, null);
});
test('nvidia-smi exceptions and errors are unavailable and never expose diagnostics', async t => {
  for (const execFile of [() => { throw new Error('secret'); }, (_e, _a, _o, cb) => cb(new Error('secret'))]) {
    const f = fixture(t, { execFile }); assert.equal((await f.collector.sample(identity)).reason, 'framebuffer_unavailable');
  }
});
test('framebuffer device overflow is bounded and explicitly partial', async t => {
  const lines = [csv.trim()];
  for (let i = 4; i < 20; i++) lines.push(`GPU-${i}, 0000:${i.toString(16).padStart(2, '0')}:00.0, 8192, 0, 8192`);
  const f = fixture(t, { execFile: (_e, _a, _o, cb) => cb(null, lines.join('\n')) });
  const s = await f.collector.sample(identity); assert.equal(s.state, 'partial'); assert.equal(s.truncated, true);
});
test('non-Windows never spawns helper and retains only unambiguous framebuffer capability', async t => {
  for (const platform of ['linux', 'darwin']) {
    const f = fixture(t, { platform, execFile: (_e, _a, _o, cb) => cb(null, csv.split('\n')[0]) });
    const s = await f.collector.sample(identity); assert.equal(s.state, 'unavailable'); assert.equal(f.calls.length, 0);
    assert.equal(s.adapter.gpu_uuid, 'GPU-other'); assert.equal(s.adapter.shared_used_bytes, null);
    assert.equal(s.managed_process, null); assert.deepEqual(s.external_processes, []);
  }
});
test('packaging unpacks the fixed helper and static native boundary uses English counters and FullLanguage', () => {
  const config = require('js-yaml').load(fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8'));
  assert.ok(config.asarUnpack.includes('services/performance/gpu-memory-win32.ps1'));
  const text = fs.readFileSync(helper, 'utf8');
  for (const name of ['PdhOpenQuery', 'PdhAddEnglishCounterW', 'PdhCollectQueryData', 'PdhGetFormattedCounterArrayW',
    'OpenProcess', 'GetProcessTimes', 'QueryFullProcessImageName', 'D3DKMTOpenAdapterFromLuid', 'D3DKMTQueryAdapterInfo', 'FullLanguage', 'ReadLine']) assert.ok(text.includes(name));
  for (const group of ['Adapter', 'Process']) for (const kind of ['Dedicated', 'Shared']) assert.ok(text.includes(`\\GPU ${group} Memory(*)\\${kind} Usage`));
  assert.doesNotMatch(text, /Invoke-Expression|Start-Process|Invoke-WebRequest|Set-Content|WriteAll/);
  assert.match(text, /4096/); assert.match(text, /processes.Count>=256/); assert.match(text, /adapters.Count>=16/);
  assert.match(fs.readFileSync(path.join(__dirname, '../services/performance/gpu-collector.js'), 'utf8'), /app\.asar\.unpacked/);
});
test('win32-only real hidden helper compiles and reports readiness without requests or windows', { skip: process.platform !== 'win32' }, async t => {
  const c = spawn(systemPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: sanitizeSpawnEnv(process.env) });
  t.after(() => c.kill());
  const result = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('helper readiness timeout')), 5000);
    t.after(() => clearTimeout(timer)); c.on('error', reject); c.stderr.on('data', () => {});
    c.stdout.on('data', data => { output += data; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])); });
    c.on('close', () => reject(new Error('helper exited before readiness')));
  });
  assert.deepEqual(result, { event: 'ready' });
});
