const test = require('node:test');
const assert = require('node:assert/strict');

const { probeNvidiaSmiVram } = require('../services/gpu-vram-probe');

// Build a fake node-style execFile(file, args, options, callback) that records
// the invocation and invokes the callback with the supplied (error, stdout, stderr).
function fakeExecFile({ error = null, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    // Node allows (file, args, callback) too; normalize.
    const cb = typeof options === 'function' ? options : callback;
    cb(error, stdout, stderr);
  };
  return { execFile, calls };
}

test('reports nvidia-smi totals for a single GPU', async () => {
  const { execFile } = fakeExecFile({ stdout: '1024, 8192\n' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, true);
  assert.equal(sample.usedMb, 1024);
  assert.equal(sample.totalMb, 8192);
  assert.equal(sample.utilAvailable, false);
  assert.equal(sample.utilPercent, 0);
  assert.equal(sample.gpuType, 'cuda');
  assert.equal(sample.source, 'nvidia-smi');
  assert.equal(typeof sample.sampledAt, 'string');
  assert.ok(sample.sampledAt.length > 0);
});

test('sums used and total across multiple GPUs', async () => {
  const { execFile } = fakeExecFile({ stdout: '1024, 8192\n512, 4096\n' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, true);
  assert.equal(sample.usedMb, 1536);
  assert.equal(sample.totalMb, 12288);
});

test('clamps used down to total when nvidia-smi over-reports', async () => {
  const { execFile } = fakeExecFile({ stdout: '9000, 8192\n' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, true);
  assert.equal(sample.usedMb, 8192);
  assert.equal(sample.totalMb, 8192);
});

test('invokes nvidia-smi with the memory query args', async () => {
  const { execFile, calls } = fakeExecFile({ stdout: '1, 2\n' });
  await probeNvidiaSmiVram({ execFile });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'nvidia-smi');
  assert.deepEqual(calls[0].args, [
    '--query-gpu=memory.used,memory.total,utilization.gpu',
    '--format=csv,noheader,nounits',
  ]);
  assert.equal(typeof calls[0].options.timeout, 'number');
  assert.ok(calls[0].options.timeout > 0);
});

test('returns unavailable on a non-zero exit', async () => {
  const error = Object.assign(new Error('Command failed'), { code: 9 });
  const { execFile } = fakeExecFile({ error, stdout: '' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, false);
  assert.equal(sample.usedMb, 0);
  assert.equal(sample.totalMb, 0);
  assert.equal(sample.utilAvailable, false);
  assert.equal(sample.utilPercent, 0);
  assert.equal(sample.source, 'nvidia-smi');
});

test('returns unavailable when nvidia-smi is missing (ENOENT)', async () => {
  const error = Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
  const { execFile } = fakeExecFile({ error });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, false);
  assert.equal(sample.usedMb, 0);
  assert.equal(sample.totalMb, 0);
  assert.equal(sample.source, 'nvidia-smi');
});

test('returns unavailable on a timeout kill', async () => {
  const error = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  const { execFile } = fakeExecFile({ error });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, false);
  assert.equal(sample.totalMb, 0);
  assert.equal(sample.source, 'nvidia-smi');
});

test('returns unavailable on unparseable output', async () => {
  const { execFile } = fakeExecFile({ stdout: 'not-a-number, ???\n' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, false);
  assert.equal(sample.usedMb, 0);
  assert.equal(sample.totalMb, 0);
  assert.equal(sample.source, 'nvidia-smi');
});

test('returns unavailable on empty output', async () => {
  const { execFile } = fakeExecFile({ stdout: '' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, false);
});

test('returns unavailable when total capacity is zero', async () => {
  const { execFile } = fakeExecFile({ stdout: '0, 0\n' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, false);
});

test('parses GPU utilization from three-column output', async () => {
  const { execFile } = fakeExecFile({ stdout: '1024, 8192, 37\n' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, true);
  assert.equal(sample.utilAvailable, true);
  assert.equal(sample.utilPercent, 37);
});

test('keeps memory available when utilization is not numeric', async () => {
  const { execFile } = fakeExecFile({ stdout: '1024, 8192, [N/A]\n' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, true);
  assert.equal(sample.usedMb, 1024);
  assert.equal(sample.totalMb, 8192);
  assert.equal(sample.utilAvailable, false);
  assert.equal(sample.utilPercent, 0);
});

test('uses maximum utilization across multiple GPUs', async () => {
  const { execFile } = fakeExecFile({ stdout: '1024, 8192, 21\n512, 4096, 88\n' });
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.usedMb, 1536);
  assert.equal(sample.totalMb, 12288);
  assert.equal(sample.utilAvailable, true);
  assert.equal(sample.utilPercent, 88);
});

test('clamps utilization to the zero-to-100 range', async () => {
  const high = await probeNvidiaSmiVram({
    execFile: fakeExecFile({ stdout: '1, 2, 125\n' }).execFile,
  });
  const low = await probeNvidiaSmiVram({
    execFile: fakeExecFile({ stdout: '1, 2, -5\n' }).execFile,
  });

  assert.equal(high.utilAvailable, true);
  assert.equal(high.utilPercent, 100);
  assert.equal(low.utilAvailable, true);
  assert.equal(low.utilPercent, 0);
});

test('an empty utilization column reads as unavailable, not 0%', async () => {
  const execFile = (cmd, args, opts, cb) => cb(null, '1024, 8192, \n', '');
  const sample = await probeNvidiaSmiVram({ execFile });

  assert.equal(sample.available, true);
  assert.equal(sample.usedMb, 1024);
  assert.equal(sample.utilAvailable, false, "Number('') is 0 — must not fabricate an available 0%");
  assert.equal(sample.utilPercent, 0);
});
