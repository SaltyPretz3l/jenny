'use strict';

/* services/backend/llama-server-memory-fit.js - the GPU memory plan for one
 * managed llama-server launch.
 *
 * llama.cpp's built-in `--fit` adjusts only the arguments a caller left unset:
 * an explicit `-c` is never shrunk, so a context that does not fit spills model
 * layers to the CPU instead (2026-11-04: Qwen3.8-27B Q6_K at 256K with an f16
 * KV cache held 35 GB of system RAM and decoded on the CPU). Before the spawn:
 *  - the KV cache defaults to q8_0 (half of f16, near-lossless) and the slot
 *    count to 1, unless the profile names them;
 *  - the build's own `llama-fit-params` reports the largest context that keeps
 *    every layer on the GPU with the acceleration and projector headroom free,
 *    and the requested context is capped there (never below FLOOR_CONTEXT);
 *  - the server gets `--fit-target` without the acceleration headroom: its
 *    own fit already counts the MTP draft context (`llama-fit-params` rejects
 *    the speculative flags, so only the dry run needs the estimate). Charging
 *    it twice moved 8 of 66 Qwen3.8 layers back to the CPU.
 * A profile that places layers or turns `--fit` off owns placement. Every
 * failure keeps the requested context: the plan never blocks a launch.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const KV_CACHE_TYPE = 'q8_0';
// llama.cpp's own default --fit-target margin per device.
const BASE_MARGIN_MB = 1024;
// Jenny's system prompt with its tool schemas runs ~20K tokens; a cap below
// this would trade a slow chat for a broken one.
const FLOOR_CONTEXT = 32768;
const FIT_TIMEOUT_MS = 30000;
const MIB = 1024 * 1024;

// Profile flags that decide layer placement: the user owns the fit.
const PLACEMENT_FLAGS = new Set([
  '-ngl', '--gpu-layers', '--n-gpu-layers', '-ot', '--override-tensor',
  '-ts', '--tensor-split', '-sm', '--split-mode', '-mg', '--main-gpu',
  '-dev', '--device', '-cmoe', '--cpu-moe', '-ncmoe', '--n-cpu-moe',
  '-fit', '--fit', '-fitt', '--fit-target', '-fitc', '--fit-ctx',
]);
// Profile flags (with their value) that change the estimate; the dry run sees
// them so it measures the launch that will actually run.
const ESTIMATE_FLAGS = new Set([
  '-ctk', '--cache-type-k', '-ctv', '--cache-type-v', '-fa', '--flash-attn',
  '-np', '--parallel', '-b', '--batch-size', '-ub', '--ubatch-size',
]);

function flagName(arg) {
  return String(arg).split('=', 1)[0];
}

function isFlagToken(token) {
  return /^--?[a-z]/i.test(String(token));
}

function scanProfile(extraArgs) {
  const list = Array.isArray(extraArgs) ? extraArgs.map((arg) => String(arg)) : [];
  const names = new Set(list.map(flagName));
  const estimate = [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (!ESTIMATE_FLAGS.has(flagName(arg))) {
      continue;
    }
    estimate.push(arg);
    const next = list[index + 1];
    if (!arg.includes('=') && next !== undefined && !isFlagToken(next)) {
      estimate.push(next);
      index += 1;
    }
  }
  return { names, estimate };
}

function memoryDefaultArgs(profileExtraArgs) {
  const { names } = scanProfile(profileExtraArgs);
  const args = [];
  // One slot: Jenny is a single-user harness, and llama.cpp's auto (4 slots)
  // gives a hybrid model four recurrent states (Qwen3.8-27B: ~750 MB each)
  // that the dry run would otherwise not see.
  if (!names.has('-np') && !names.has('--parallel')) {
    args.push('-np', '1');
  }
  if (!names.has('-ctk') && !names.has('--cache-type-k')) {
    args.push('-ctk', KV_CACHE_TYPE);
  }
  if (!names.has('-ctv') && !names.has('--cache-type-v')) {
    args.push('-ctv', KV_CACHE_TYPE);
  }
  return args;
}

function fitToolPath(binaryPath, { platform = process.platform, fsImpl = fs } = {}) {
  if (!binaryPath) {
    return '';
  }
  const candidate = path.join(
    path.dirname(binaryPath),
    platform === 'win32' ? 'llama-fit-params.exe' : 'llama-fit-params'
  );
  try {
    return fsImpl.statSync(candidate).isFile() ? candidate : '';
  } catch (_error) {
    return '';
  }
}

function projectorMb(projectorPath, fsImpl) {
  if (!projectorPath) {
    return 0;
  }
  try {
    return Math.ceil(fsImpl.statSync(projectorPath).size / MIB);
  } catch (_error) {
    return 0;
  }
}

// The tool prints the fitted CLI arguments as its last stdout line, e.g.
// `-c 220928 -ngl -1` (-1: every layer on the GPU).
function parseFitOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = ` ${lines[index]} `;
    const context = /\s-c\s+(\d+)\s/.exec(line);
    const layers = /\s-ngl\s+(-?\d+)\s/.exec(line);
    if (context || layers) {
      return {
        contextSize: context ? Number(context[1]) : null,
        gpuLayers: layers ? Number(layers[1]) : null,
        overrides: /\s-ot\s/.test(line),
      };
    }
  }
  return null;
}

function runFitTool(execFileImpl, tool, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const options = { timeout: timeoutMs, windowsHide: true, maxBuffer: MIB, ...(signal ? { signal } : {}) };
    execFileImpl(tool, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

async function planLaunchMemory({
  binaryPath = '',
  modelPath = '',
  projectorPath = '',
  requestedContext,
  profileExtraArgs = [],
  headroomMb = 0,
  platform = process.platform,
  fsImpl = fs,
  execFileImpl = execFile,
  timeoutMs = FIT_TIMEOUT_MS,
  // A stop during the dry run kills the tool instead of waiting it out.
  signal = null,
} = {}) {
  const defaults = memoryDefaultArgs(profileExtraArgs);
  const keep = (reason, extra = {}) => ({
    contextSize: requestedContext,
    extraArgs: defaults,
    reason,
    fittedContext: null,
    gpuLayers: null,
    marginMb: null,
    ...extra,
  });
  try {
    const { names, estimate } = scanProfile(profileExtraArgs);
    if ([...names].some((name) => PLACEMENT_FLAGS.has(name))) {
      return keep('profile_owns_placement');
    }
    const tool = fitToolPath(binaryPath, { platform, fsImpl });
    if (!tool || !modelPath) {
      return keep('fit_tool_missing');
    }
    const headroom = Number.isFinite(headroomMb) && headroomMb > 0 ? Math.ceil(headroomMb) : 0;
    const serverMarginMb = BASE_MARGIN_MB + projectorMb(projectorPath, fsImpl);
    const marginMb = serverMarginMb + headroom;
    const stdout = await runFitTool(execFileImpl, tool, [
      '-m', modelPath, ...defaults, ...estimate,
      '--fit-target', String(marginMb), '--fit-ctx', String(FLOOR_CONTEXT),
    ], timeoutMs, signal);
    const fitted = parseFitOutput(stdout);
    if (!fitted) {
      return keep('fit_unparsed', { marginMb });
    }
    const allOnGpu = fitted.gpuLayers === -1 && !fitted.overrides;
    const cap = Number.isInteger(fitted.contextSize) && fitted.contextSize > 0
      ? Math.max(fitted.contextSize, FLOOR_CONTEXT)
      : requestedContext;
    const contextSize = Math.min(requestedContext, cap);
    let reason = 'fits';
    if (!allOnGpu) {
      reason = 'spill';
    } else if (contextSize < requestedContext) {
      reason = 'context_reduced';
    }
    return {
      contextSize,
      extraArgs: [...defaults, '--fit-target', String(serverMarginMb)],
      reason,
      fittedContext: fitted.contextSize,
      gpuLayers: fitted.gpuLayers,
      marginMb,
    };
  } catch (_error) {
    return keep('fit_failed');
  }
}

module.exports = {
  BASE_MARGIN_MB,
  FLOOR_CONTEXT,
  KV_CACHE_TYPE,
  fitToolPath,
  memoryDefaultArgs,
  parseFitOutput,
  planLaunchMemory,
};
