#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function resolvePython() {
  const candidates = [
    process.env.JENNY_BACKEND_PYTHON,
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate))
    || (process.platform === 'win32' ? 'python' : 'python3');
}

function run() {
  const python = resolvePython();
  const args = [path.join(ROOT, 'scripts', 'tests', 'live-local-evidence.py'), ...process.argv.slice(2)];
  const child = spawn(python, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('error', (error) => {
    console.error(`[live-local-evidence] failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      console.error(`[live-local-evidence] terminated by ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code || 0;
  });
}

run();
