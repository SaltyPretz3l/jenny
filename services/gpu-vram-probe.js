'use strict';

// Direct main-process GPU VRAM probe.
//
// The managed sidecar exposes VRAM via a JSON-RPC method, but that path is only
// live once the sidecar is in "managed" mode and "ready". When the user runs a
// different backend (or the sidecar isn't up yet), the titlebar memory meter
// falls back to system RAM. This module gives the main process a self-contained
// `nvidia-smi` probe so VRAM can be shown regardless of backend mode, falling
// back to RAM only when no usable NVIDIA GPU is present.
//
// It deliberately mirrors the sidecar's probe (sidecar/runtime/hardware_vram_usage.py):
// same query, same CSV-sum semantics, same {available, used/total} contract — so
// the renderer formats both identically.

const { execFile: nodeExecFile } = require('child_process');
const {
  createUnavailableGpuMemorySample,
  normalizeGpuMemorySample,
} = require('./system-stats-payload');

const NVIDIA_SMI_QUERY_ARGS = [
  '--query-gpu=memory.used,memory.total,utilization.gpu',
  '--format=csv,noheader,nounits',
];

// nvidia-smi is fast, but a hung/zombie process must not stall the stats tick.
const DEFAULT_PROBE_TIMEOUT_MS = 1000;

// Parse `used, total, utilization` CSV rows (one per GPU), summing memory across GPUs.
// Returns null when there is no usable row (matching the Python helper), so the
// caller emits an "unavailable" sample.
function parseNvidiaMemoryCsv(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  let totalUsed = 0;
  let totalCapacity = 0;
  let maxUtilization = null;
  for (const line of lines) {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 2) {
      return null;
    }
    const usedMb = Number(parts[0]);
    const totalMb = Number(parts[1]);
    if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb)) {
      return null;
    }
    // Number('') is 0 — an empty third column must read as unavailable, not 0%,
    // matching the Python probe's ValueError behavior.
    const utilization = parts.length >= 3 && parts[2] !== '' ? Number(parts[2]) : Number.NaN;
    if (Number.isFinite(utilization)) {
      // Utilization uses the maximum because summing is meaningless and averaging hides a pegged GPU.
      maxUtilization = maxUtilization === null
        ? utilization
        : Math.max(maxUtilization, utilization);
    }

    if (totalMb <= 0) {
      continue;
    }
    totalUsed += Math.max(usedMb, 0);
    totalCapacity += totalMb;
  }

  if (totalCapacity <= 0) {
    return null;
  }
  return {
    usedMb: totalUsed,
    totalMb: totalCapacity,
    utilAvailable: maxUtilization !== null,
    utilPercent: maxUtilization === null ? 0 : Math.max(Math.min(maxUtilization, 100), 0),
  };
}

function runExecFile(execFile, args, options) {
  return new Promise((resolve) => {
    execFile('nvidia-smi', args, options, (error, stdout) => {
      resolve({ error: error || null, stdout: stdout || '' });
    });
  });
}

// Best-effort GPU VRAM sample via nvidia-smi. Resolves to a normalized gpuMemory
// sample ({available, usedMb, totalMb, gpuType, source, sampledAt}); `available`
// is false on any failure (binary missing, non-zero exit, timeout, bad output).
async function probeNvidiaSmiVram({ execFile = nodeExecFile, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const sampledAt = new Date().toISOString();
  const { error, stdout } = await runExecFile(execFile, NVIDIA_SMI_QUERY_ARGS, {
    timeout: timeoutMs,
    windowsHide: true,
  });

  const parsed = error ? null : parseNvidiaMemoryCsv(stdout);
  if (!parsed) {
    return createUnavailableGpuMemorySample({ source: 'nvidia-smi', sampledAt });
  }

  const clampedUsed = Math.max(Math.min(parsed.usedMb, parsed.totalMb), 0);
  return normalizeGpuMemorySample({
    available: true,
    usedMb: clampedUsed,
    totalMb: parsed.totalMb,
    utilAvailable: parsed.utilAvailable,
    utilPercent: parsed.utilPercent,
    gpuType: 'cuda',
    source: 'nvidia-smi',
    sampledAt,
  });
}

module.exports = {
  probeNvidiaSmiVram,
};
