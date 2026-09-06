'use strict';

const { execFile: nodeExecFile } = require('child_process');

const IOREG_ARGS = ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'];
const DEFAULT_PROBE_TIMEOUT_MS = 1000;

function parseIoregGpuUtilization(stdout) {
  const text = String(stdout || '');
  const dictionaries = text.matchAll(/"PerformanceStatistics"\s*=\s*\{([\s\S]*?)\}/g);
  let maxUtilization = null;

  for (const match of dictionaries) {
    const statistics = match[1];
    const utilizationMatch =
      statistics.match(/"Device Utilization %"\s*=\s*(-?\d+)/) ||
      statistics.match(/"Renderer Utilization %"\s*=\s*(-?\d+)/);
    if (!utilizationMatch) {
      continue;
    }

    const utilization = Number(utilizationMatch[1]);
    if (Number.isFinite(utilization)) {
      maxUtilization = maxUtilization === null
        ? utilization
        : Math.max(maxUtilization, utilization);
    }
  }

  return maxUtilization === null
    ? null
    : Math.max(Math.min(maxUtilization, 100), 0);
}

function unavailableSample(sampledAt) {
  return {
    available: false,
    usedMb: 0,
    totalMb: 0,
    utilAvailable: false,
    utilPercent: 0,
    gpuType: 'unknown',
    source: 'ioreg',
    sampledAt,
  };
}

function probeMacGpuTelemetry({ execFile = nodeExecFile, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const sampledAt = new Date().toISOString();
  return new Promise((resolve) => {
    execFile('ioreg', IOREG_ARGS, {
      timeout: timeoutMs,
      maxBuffer: 1048576,
      windowsHide: true,
    }, (error, stdout) => {
      const utilPercent = error ? null : parseIoregGpuUtilization(stdout);
      if (utilPercent === null) {
        resolve(unavailableSample(sampledAt));
        return;
      }

      resolve({
        available: false,
        usedMb: 0,
        totalMb: 0,
        utilAvailable: true,
        utilPercent,
        gpuType: 'metal',
        source: 'ioreg',
        sampledAt,
      });
    });
  });
}

module.exports = {
  parseIoregGpuUtilization,
  probeMacGpuTelemetry,
};
