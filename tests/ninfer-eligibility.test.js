'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNinferEligibilityProbe,
  evaluateNinferEligibility,
  parseNvidiaEligibilityCsv,
  probeNinferEligibility,
} = require('../services/ninfer-eligibility');

const EXPECTED_ARGS = [
  '--query-gpu=name,compute_cap,memory.total',
  '--format=csv,noheader,nounits',
];

function fakeExecFile({ stdout = '', error = null } = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    assert.equal(file, 'nvidia-smi');
    assert.deepEqual(args, EXPECTED_ARGS);
    assert.equal(options.windowsHide, true);
    setImmediate(() => callback(error, error ? '' : stdout, ''));
  };
  execFile.calls = calls;
  return execFile;
}

function probeWith(stdout, extra = {}) {
  const execFile = fakeExecFile({ stdout });
  return probeNinferEligibility({ execFile, platform: 'win32', ...extra }).then((result) => ({ result, execFile }));
}

test('RTX 5090 32 GB desktop card is eligible on device 0', async () => {
  const { result, execFile } = await probeWith('NVIDIA GeForce RTX 5090, 12.0, 32607\n');
  assert.equal(execFile.calls.length, 1);
  assert.deepEqual(result, {
    eligible: true,
    reason: '',
    device: { index: 0, name: 'NVIDIA GeForce RTX 5090', computeCapability: '12.0', memoryTotalMib: 32607 },
    probed: true,
  });
});

for (const row of [
  'NVIDIA GeForce RTX 5090 Laptop GPU, 12.0, 24463',
  'NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 12.0, 97887',
  'NVIDIA GeForce RTX 5070 Ti, 12.0, 16303',
  'NVIDIA GeForce RTX 4090, 8.9, 24564',
]) {
  test(`ineligible GPU: ${row}`, async () => {
    const { result } = await probeWith(`${row}\r\n`);
    assert.deepEqual(result, { eligible: false, reason: 'ninfer_gpu_unsupported', device: null, probed: true });
  });
}

test('the first eligible row wins and keeps its nvidia-smi index', async () => {
  const { result } = await probeWith('NVIDIA GeForce RTX 4090, 8.9, 24564\nNVIDIA GeForce RTX 5090, 12.0, 32607\n');
  assert.equal(result.eligible, true);
  assert.equal(result.device.index, 1);
});

test('a missing nvidia-smi resolves the probe-failed shape', async () => {
  const error = Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
  const execFile = fakeExecFile({ error });
  const result = await probeNinferEligibility({ execFile, platform: 'win32' });
  assert.deepEqual(result, { eligible: false, reason: 'ninfer_probe_failed', device: null, probed: true });
});

test('empty or unparseable output resolves the probe-failed shape', async () => {
  assert.equal((await probeWith('')).result.reason, 'ninfer_probe_failed');
  assert.equal((await probeWith('garbage\n')).result.reason, 'ninfer_probe_failed');
});

test('flag off refuses without spawning', async () => {
  const execFile = fakeExecFile();
  const result = await probeNinferEligibility({ flags: { ninfer: false }, execFile, platform: 'win32' });
  assert.deepEqual(result, { eligible: false, reason: 'ninfer_flag_off', device: null, probed: false });
  assert.equal(execFile.calls.length, 0);
});

test('flags without the key count as ON', async () => {
  const { result } = await probeWith('NVIDIA GeForce RTX 5090, 12.0, 32607\n', { flags: {} });
  assert.equal(result.eligible, true);
});

test('non-Windows platforms refuse without spawning', async () => {
  const execFile = fakeExecFile();
  const result = await probeNinferEligibility({ execFile, platform: 'linux' });
  assert.deepEqual(result, { eligible: false, reason: 'ninfer_platform_unsupported', device: null, probed: false });
  assert.equal(execFile.calls.length, 0);
});

test('parse skips malformed lines without throwing', () => {
  assert.deepEqual(parseNvidiaEligibilityCsv('bad line\nNVIDIA GeForce RTX 5090, 12.0, 32607\nx, 12.0, nope\n'), [
    { index: 1, name: 'NVIDIA GeForce RTX 5090', computeCapability: '12.0', memoryTotalMib: 32607 },
  ]);
  assert.deepEqual(parseNvidiaEligibilityCsv(null), []);
  assert.deepEqual(evaluateNinferEligibility([]), { eligible: false, reason: 'ninfer_gpu_unsupported', device: null });
});

test('memoized probe spawns once across concurrent and later callers; reset re-probes', async () => {
  const execFile = fakeExecFile({ stdout: 'NVIDIA GeForce RTX 5090, 12.0, 32607\n' });
  const getEligibility = createNinferEligibilityProbe({ execFile, platform: 'win32' });
  const results = await Promise.all([getEligibility(), getEligibility(), getEligibility()]);
  assert.equal(execFile.calls.length, 1);
  for (const result of results) {
    assert.equal(result.eligible, true);
  }
  const later = await getEligibility();
  assert.equal(later.eligible, true);
  assert.equal(execFile.calls.length, 1);
  getEligibility.reset();
  await getEligibility();
  assert.equal(execFile.calls.length, 2);
});

test('memoized probe caches a probe failure (no retry loop)', async () => {
  const execFile = fakeExecFile({ error: Object.assign(new Error('timeout'), { killed: true }) });
  const getEligibility = createNinferEligibilityProbe({ execFile, platform: 'win32' });
  assert.equal((await getEligibility()).reason, 'ninfer_probe_failed');
  assert.equal((await getEligibility()).reason, 'ninfer_probe_failed');
  assert.equal(execFile.calls.length, 1);
});
