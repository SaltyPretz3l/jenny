'use strict';

// Where the `jenny-team-bridge` binary is: `<resources>/sidecar/` in a packaged
// app, `build/sidecar/` in a source checkout. No binary means the transport is
// unavailable, which the team host reports as `team_transport_down`.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { childEnv, spawnBridgeChild } = require('./control-channel');

const BINARY_NAME = process.platform === 'win32' ? 'jenny-team-bridge.exe' : 'jenny-team-bridge';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The first existing candidate, or null. */
function resolveBridgeBinary({
  resourcesPath = process.resourcesPath, root = REPO_ROOT, exists = fs.existsSync,
} = {}) {
  const candidates = [];
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    candidates.push(path.join(resourcesPath, 'sidecar', BINARY_NAME));
  }
  candidates.push(path.join(root, 'build', 'sidecar', BINARY_NAME));
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** Spawns the resolved binary in `mode`; throws `transport_unavailable` when there is none. */
function defaultSpawnChild(mode) {
  const binaryPath = resolveBridgeBinary();
  if (!binaryPath) throw Object.assign(new Error('transport_unavailable'), { code: 'transport_unavailable' });
  return spawnBridgeChild(mode, { binaryPath });
}

const PROBE_TIMEOUT_MS = 5_000;
const VERSION_LINE_RE = /^jenny-team-bridge protocol (0|[1-9]\d{0,5})$/u;

/**
 * Runs `<binaryPath> --version` with no window and no inherited environment
 * and parses its one line, the crate's VERSION_LINE, once stdout has closed.
 * Answers `{ ok, line, protocol }`, or `{ ok: false, reason }` with
 * `not_started`, `exited` (plus the exit `code`), `bad_line` or `timeout`;
 * never a path. On the timeout path the child is ended by its own handle and
 * let go, so one that ignores the signal cannot hold the caller open. Used by
 * `jenny doctor --team` (cli/doctor-team.js).
 */
function probeBridgeVersion({ binaryPath, spawnChild = spawn, timers = { setTimeout, clearTimeout } }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnChild(binaryPath, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() });
    } catch (_error) {
      resolve({ ok: false, reason: 'not_started' });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      resolve(answer);
    };
    const timer = timers.setTimeout(() => {
      try { child.kill(); } catch (_error) { /* already gone */ }
      child.stdout?.destroy?.();
      child.unref?.();
      finish({ ok: false, reason: 'timeout' });
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => { if (output.length < 4096) output += String(chunk); });
    // Attached for the child's life: a second 'error' (after a failed kill) is never unhandled.
    child.on('error', () => finish({ ok: false, reason: 'not_started' }));
    child.once('close', (code) => {
      if (code !== 0) { finish({ ok: false, reason: 'exited', code }); return; }
      const lines = output.split(/\r?\n/u).filter((line) => line !== '');
      const match = lines.length === 1 ? VERSION_LINE_RE.exec(lines[0]) : null;
      finish(match ? { ok: true, line: lines[0], protocol: Number(match[1]) } : { ok: false, reason: 'bad_line' });
    });
  });
}

module.exports = { BINARY_NAME, PROBE_TIMEOUT_MS, defaultSpawnChild, probeBridgeVersion, resolveBridgeBinary };
