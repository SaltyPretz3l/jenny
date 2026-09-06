'use strict';

/**
 * scripts/dev/run-onboarding-demo.js  (npm run demo:onboarding)
 *
 * Manual, click-through walkthrough of the guided first-run onboarding flow.
 * The HARDWARE SCAN runs for real (your actual GPU/VRAM/RAM + real model
 * recommendations from the live sidecar); the Ollama detect/install/pull are
 * faked, so nothing is downloaded, installed, or pulled.
 * See services/dev/onboarding-demo-fixtures.js.
 *
 * It boots the REAL app (Electron spawned directly — no intermediate launcher
 * process) in a throwaway profile that is wiped on each run, so the first-run
 * flow always re-triggers. Close the window or Ctrl+C to exit; the entire
 * process tree (Electron, the Python sidecar, conhost.exe, node) is force-killed
 * on the way out so nothing lingers.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electronPath = require('electron'); // resolves to the electron executable

const repoRoot = path.join(__dirname, '..', '..');
const profileDir = path.join(os.tmpdir(), 'jenny-onboarding-demo');

// Fresh profile each run => firstRunCompleted resets => the guided flow
// auto-starts on launch.
try {
  fs.rmSync(profileDir, { recursive: true, force: true });
} catch (_error) {
  // best-effort; a stale profile only risks the flow not re-triggering
}

// Start from a clean env: scrub inherited JENNY_* (a stray flag can silently
// break the live app — see AGENTS.md), then set only what the demo needs.
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('JENNY_')) {
    env[key] = value;
  }
}
delete env.ELECTRON_RUN_AS_NODE; // ensure Electron launches as the app, not as node
env.JENNY_ONBOARDING_DEMO = '1';
env.JENNY_USER_DATA_DIR = profileDir;

console.log('Jenny onboarding demo (manual walkthrough)');
console.log(`  profile : ${profileDir}`);
console.log('            (wiped each run — the guided flow auto-starts)');
console.log('  real    : hardware scan — your actual GPU/VRAM/RAM + recommendations');
console.log('  faked   : Ollama detect, install download + run, model pull');
console.log('  no      : network calls, subprocesses, or model downloads');
console.log('  walk    : Welcome -> Scan (your real hardware) -> recommendation appears');
console.log('            -> tick "Download & install Ollama"');
console.log('            -> "Install Ollama & download model"');
console.log('            -> install bar (0->100) -> pull bar (0->100) -> done');
console.log('  note    : if the scan is empty, the sidecar is still warming —');
console.log('            wait a few seconds and click "Try again".');
console.log('  exit    : close the window, or Ctrl+C here\n');

// Keep the desktop shortcut current (Windows-only, best-effort) so it self-heals
// if the repo moved or Electron updated since it was last created.
try {
  const { refreshOnboardingShortcut } = require('./refresh-onboarding-shortcut');
  const shortcut = refreshOnboardingShortcut(repoRoot);
  if (shortcut.ok && shortcut.lnkPath) {
    console.log(`  shortcut: refreshed -> ${shortcut.lnkPath}\n`);
  }
} catch (_error) {
  // a missing/stale shortcut is a convenience issue only — never block the demo
}

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env,
  cwd: repoRoot,
  windowsHide: false,
});

// Force-kill the whole descendant tree (Electron + sidecar + conhost + node) so
// nothing survives the terminal closing. taskkill /T walks the PPID tree.
let cleanedUp = false;
function killTree() {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  const pid = child && child.pid;
  if (!pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (_error) {
    // best-effort; the child may already be gone
  }
}

// SIGHUP fires on Windows console-window close; SIGBREAK on Ctrl+Break.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(signal, () => {
      killTree();
      process.exit(0);
    });
  } catch (_error) {
    // some signals aren't registrable on every platform
  }
}
process.on('exit', killTree);

child.on('error', (error) => {
  console.error(`Failed to launch the demo: ${String((error && error.message) || error)}`);
  process.exit(1);
});
child.on('close', (code) => {
  cleanedUp = true; // Electron already exited; it owns sidecar teardown on a clean exit
  process.exit(code ?? 0);
});
