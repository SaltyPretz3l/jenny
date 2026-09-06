const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseIoregGpuUtilization,
  probeMacGpuTelemetry,
} = require('../services/gpu-mac-probe');

const IOREG_FIXTURE = `
+-o AGXAccelerator  <class IOAccelerator, id 0x100000001, registered, matched, active, busy 0 (0 ms), retain 9>
  | {
  |   "PerformanceStatistics" = {
  |     "Device Utilization %" = 47
  |     "Renderer Utilization %" = 12
  |   }
  | }
`;

function fakeExecFile({ error = null, stdout = '' } = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(error, stdout, '');
  };
  return { execFile, calls };
}

test('parses Device Utilization from a PerformanceStatistics dictionary', () => {
  assert.equal(parseIoregGpuUtilization(IOREG_FIXTURE), 47);
});

test('uses the maximum utilization across accelerator nodes with renderer fallback', () => {
  const stdout = `${IOREG_FIXTURE}
+-o IntelAccelerator  <class IOAccelerator, id 0x100000002, registered, matched, active, busy 0 (0 ms), retain 9>
  | {
  |   "PerformanceStatistics" = {"Renderer Utilization %"=83}
  | }
`;

  assert.equal(parseIoregGpuUtilization(stdout), 83);
});

test('reports Metal utilization and invokes ioreg with the exact contract', async () => {
  const { execFile, calls } = fakeExecFile({ stdout: IOREG_FIXTURE });
  const sample = await probeMacGpuTelemetry({ execFile, timeoutMs: 321 });

  assert.equal(sample.available, false);
  assert.equal(sample.usedMb, 0);
  assert.equal(sample.totalMb, 0);
  assert.equal(sample.utilAvailable, true);
  assert.equal(sample.utilPercent, 47);
  assert.equal(sample.gpuType, 'metal');
  assert.equal(sample.source, 'ioreg');
  assert.equal(typeof sample.sampledAt, 'string');
  assert.deepEqual(calls, [{
    file: 'ioreg',
    args: ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'],
    options: {
      timeout: 321,
      maxBuffer: 1048576,
      windowsHide: true,
    },
  }]);
});

test('returns unavailable when the utilization key is missing', async () => {
  const { execFile } = fakeExecFile({
    stdout: '"PerformanceStatistics" = {"GPU Core Clock"=1000}',
  });
  const sample = await probeMacGpuTelemetry({ execFile });

  assert.equal(sample.utilAvailable, false);
  assert.equal(sample.utilPercent, 0);
  assert.equal(sample.gpuType, 'unknown');
  assert.equal(sample.source, 'ioreg');
});

test('returns unavailable when ioreg is missing', async () => {
  const error = Object.assign(new Error('spawn ioreg ENOENT'), { code: 'ENOENT' });
  const sample = await probeMacGpuTelemetry({ execFile: fakeExecFile({ error }).execFile });

  assert.equal(sample.utilAvailable, false);
  assert.equal(sample.utilPercent, 0);
  assert.equal(sample.gpuType, 'unknown');
  assert.equal(sample.source, 'ioreg');
});

test('returns unavailable on timeout', async () => {
  const error = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  const sample = await probeMacGpuTelemetry({ execFile: fakeExecFile({ error }).execFile });

  assert.equal(sample.utilAvailable, false);
  assert.equal(sample.utilPercent, 0);
  assert.equal(sample.gpuType, 'unknown');
  assert.equal(sample.source, 'ioreg');
});
