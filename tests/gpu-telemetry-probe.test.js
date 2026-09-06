const test = require('node:test');
const assert = require('node:assert/strict');

const { probeGpuTelemetry } = require('../services/gpu-telemetry-probe');

function routingExecFile(calls) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options });
    const stdout = file === 'ioreg'
      ? '"PerformanceStatistics" = {"Device Utilization %"=64}'
      : '100, 1000, 25\n';
    callback(null, stdout, '');
  };
}

test('routes darwin to the macOS probe', async () => {
  const calls = [];
  const sample = await probeGpuTelemetry({
    platform: 'darwin',
    execFile: routingExecFile(calls),
  });

  assert.equal(sample.source, 'ioreg');
  assert.equal(sample.utilPercent, 64);
  assert.equal(calls[0].file, 'ioreg');
});

for (const platform of ['win32', 'linux']) {
  test(`routes ${platform} to the NVIDIA probe`, async () => {
    const calls = [];
    const sample = await probeGpuTelemetry({
      platform,
      execFile: routingExecFile(calls),
    });

    assert.equal(sample.source, 'nvidia-smi');
    assert.equal(sample.utilPercent, 25);
    assert.equal(calls[0].file, 'nvidia-smi');
  });
}

test('threads injected execFile and timeout through to the selected probe', async () => {
  const calls = [];
  const execFile = routingExecFile(calls);
  await probeGpuTelemetry({ platform: 'darwin', execFile, timeoutMs: 777 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 777);
});
