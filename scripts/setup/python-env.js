'use strict';

// Python virtualenv management for the setup orchestrator. Creates the
// project-local <repoRoot>/.venv that the app's sidecar manager looks for
// (see services/backend/sidecar-manager.js resolvePythonExecutable) and installs
// the sidecar's dev dependencies into it.
//
// Pure + dependency-injected (run/fileExists) so tests drive every branch.

const path = require('path');
const fs = require('fs');

// MUST stay in sync with services/backend/sidecar-manager.js
// venvPythonRelativePath — the app resolves the interpreter the same way.
function venvPythonRelativePath(platform) {
  return platform === 'win32'
    ? path.join('.venv', 'Scripts', 'python.exe')
    : path.join('.venv', 'bin', 'python');
}

function venvPythonPath(repoRoot, platform = process.platform) {
  return path.join(repoRoot, venvPythonRelativePath(platform));
}

function venvExists(repoRoot, { platform = process.platform, fileExists = fs.existsSync } = {}) {
  return fileExists(venvPythonPath(repoRoot, platform));
}

// Create <repoRoot>/.venv using the resolved interpreter launcher (from
// prereqs.checkPython). Idempotent: returns { created: false } when present.
function ensureVenv(repoRoot, launcher, {
  run,
  platform = process.platform,
  fileExists = fs.existsSync,
  rename = fs.renameSync,
  nowProvider = () => new Date(),
} = {}) {
  const venvDir = path.join(repoRoot, '.venv');
  const interpreter = venvPythonPath(repoRoot, platform);
  if (venvExists(repoRoot, { platform, fileExists })) {
    const pythonProbe = run(interpreter, ['--version']);
    const pipProbe = run(interpreter, ['-m', 'pip', '--version']);
    const versionText = `${pythonProbe.stdout || ''} ${pythonProbe.stderr || ''}`;
    const match = versionText.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
    const major = match ? Number(match[1]) : 0;
    const minor = match ? Number(match[2]) : 0;
    const pythonValid = pythonProbe.status === 0 && match
      && (major > 3 || (major === 3 && minor >= 11));
    if (pythonValid && pipProbe.status === 0) {
      return { created: false, venvPython: interpreter };
    }
    const stamp = nowProvider().toISOString().replace(/[:.]/g, '-');
    const recoveredPath = path.join(repoRoot, `.venv.invalid-${stamp}`);
    try {
      rename(venvDir, recoveredPath);
    } catch (error) {
      return {
        created: false,
        error: 'venv_recovery_failed',
        detail: String(error?.message || error),
        venvPython: interpreter,
      };
    }
  } else if (fileExists(venvDir)) {
    const stamp = nowProvider().toISOString().replace(/[:.]/g, '-');
    try {
      rename(venvDir, path.join(repoRoot, `.venv.invalid-${stamp}`));
    } catch (error) {
      return { created: false, error: 'venv_recovery_failed', detail: String(error?.message || error), venvPython: interpreter };
    }
  }
  if (!launcher || !launcher.cmd) {
    return { created: false, error: 'no_python_launcher', venvPython: venvPythonPath(repoRoot, platform) };
  }
  const result = run(launcher.cmd, [...(launcher.args || []), '-m', 'venv', venvDir]);
  if (result.status !== 0) {
    return {
      created: false,
      error: 'venv_create_failed',
      detail: (result.stderr || result.stdout || '').trim(),
      venvPython: venvPythonPath(repoRoot, platform),
    };
  }
  return { created: true, venvPython: venvPythonPath(repoRoot, platform) };
}

// Install the editable sidecar package into the venv interpreter.
//
// Defaults to the BASE package — everything a run-only user needs. The optional
// file-inspect tools (PDF/image/spreadsheet) degrade gracefully when their extras
// are absent, so a friend who only wants to run Jenny does not need them. Pass
// { dev: true } to add the `.[dev]` extra (test/lint/type/build tooling) for
// contributors. The editable install is idempotent (a no-op reinstall when
// already satisfied).
function installSidecarDeps(repoRoot, { run, platform = process.platform, dev = false } = {}) {
  const venvPython = venvPythonPath(repoRoot, platform);
  // Upgrading pip is best-effort: a transient network hiccup here must not abort
  // setup when the venv's bundled pip can already install the package.
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  const target = dev ? '.[dev]' : '.';
  const install = run(venvPython, ['-m', 'pip', 'install', '-e', target], { cwd: repoRoot });
  if (install.status !== 0) {
    return { ok: false, phase: 'pip_install', detail: (install.stderr || install.stdout || '').trim() };
  }
  return { ok: true, venvPython, target };
}

module.exports = {
  venvPythonRelativePath,
  venvPythonPath,
  venvExists,
  ensureVenv,
  installSidecarDeps,
};
