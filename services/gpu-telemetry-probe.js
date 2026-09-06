'use strict';

// This wrapper lets main.js swap a single require while staying under its hard line cap.

const { probeMacGpuTelemetry } = require('./gpu-mac-probe');
const { probeNvidiaSmiVram } = require('./gpu-vram-probe');

function probeGpuTelemetry({ platform = process.platform, execFile, timeoutMs } = {}) {
  const probe = platform === 'darwin' ? probeMacGpuTelemetry : probeNvidiaSmiVram;
  const options = {};
  if (execFile !== undefined) {
    options.execFile = execFile;
  }
  if (timeoutMs !== undefined) {
    options.timeoutMs = timeoutMs;
  }
  return probe(options);
}

module.exports = {
  probeGpuTelemetry,
  probeMacGpuTelemetry,
  probeNvidiaSmiVram,
};
