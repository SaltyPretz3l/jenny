'use strict';

// Prerequisite detection for the Jenny setup orchestrator: git, Node, npm,
// Python. Pure + dependency-injected (runImpl) so the orchestrator can re-verify
// and the tests can drive every branch without touching the real machine.
//
// Minimum versions track the repo contract:
//   - Node 22.23.2–22.x or 24.19.0–24.x / npm >= 10 -> package.json "engines"
//   - Python >= 3.11               -> pyproject.toml "requires-python"

const { spawnSync } = require('child_process');

const MIN_NODE = { major: 22, minor: 23, patch: 2 };
const MIN_NODE_24 = { major: 24, minor: 19, patch: 0 };
const MIN_NPM = { major: 10, minor: 0, patch: 0 };
const MIN_PYTHON = { major: 3, minor: 11, patch: 0 };

// Candidate launchers in priority order, per platform. The orchestrator probes
// these to find a working Python 3.11+ interpreter for venv creation.
function pythonCandidates(platform) {
  if (platform === 'win32') {
    return [
      { cmd: 'py', args: ['-3.11'] },
      { cmd: 'py', args: ['-3'] },
      { cmd: 'python', args: [] },
      { cmd: 'python3', args: [] },
    ];
  }
  return [
    { cmd: 'python3.11', args: [] },
    { cmd: 'python3', args: [] },
    { cmd: 'python', args: [] },
  ];
}

function defaultRun(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    // Honor an explicit cwd (installSidecarDeps relies on this so
    // `pip install -e ".[dev]"` resolves the package at the repo root rather
    // than wherever node happened to be launched from).
    cwd: opts.cwd || undefined,
  });
  return {
    status: typeof result.status === 'number' ? result.status : (result.error ? 127 : 1),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

// Extract the first dotted version triple from arbitrary `--version` output.
function parseSemver(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
  };
}

function satisfiesMin(version, min) {
  if (!version) {
    return false;
  }
  if (version.major !== min.major) {
    return version.major > min.major;
  }
  if (version.minor !== min.minor) {
    return version.minor > min.minor;
  }
  return version.patch >= min.patch;
}

function formatVersion(version) {
  if (!version) {
    return 'unknown';
  }
  return `${version.major}.${version.minor}.${version.patch}`;
}

function formatMin(min) {
  return `${min.major}.${min.minor}.${min.patch}`;
}

// Generic "run <cmd> --version, parse, compare to min" probe.
function probeVersioned(run, cmd, args, min, label) {
  const result = run(cmd, [...args, '--version']);
  if (result.status !== 0) {
    return { name: label, found: false, version: null, satisfiesMin: false, min: formatMin(min) };
  }
  const version = parseSemver(`${result.stdout} ${result.stderr}`);
  return {
    name: label,
    found: Boolean(version),
    version,
    versionText: formatVersion(version),
    satisfiesMin: satisfiesMin(version, min),
    min: formatMin(min),
  };
}

function checkNode(run, { nodeVersion } = {}) {
  // The orchestrator runs under Node, so trust process.versions.node when given.
  if (nodeVersion) {
    const version = parseSemver(nodeVersion);
    return {
      name: 'node',
      found: true,
      version,
      versionText: formatVersion(version),
      satisfiesMin: isSupportedNode(version),
      min: `${formatMin(MIN_NODE)} on Node 22 or ${formatMin(MIN_NODE_24)} on Node 24`,
    };
  }
  const probe = probeVersioned(run, 'node', [], MIN_NODE, 'node');
  return {
    ...probe,
    satisfiesMin: isSupportedNode(probe.version),
    min: `${formatMin(MIN_NODE)} on Node 22 or ${formatMin(MIN_NODE_24)} on Node 24`,
  };
}

function isSupportedNode(version) {
  if (!version) return false;
  if (version.major === 22) return satisfiesMin(version, MIN_NODE);
  if (version.major === 24) return satisfiesMin(version, MIN_NODE_24);
  return false;
}

function checkNpm(run) {
  return probeVersioned(run, 'npm', [], MIN_NPM, 'npm');
}

function checkGit(run) {
  return probeVersioned(run, 'git', [], { major: 0, minor: 0, patch: 0 }, 'git');
}

// Python is special: try each candidate launcher until one reports >= 3.11.
function checkPython(run, { platform = process.platform } = {}) {
  const candidates = pythonCandidates(platform);
  let lastSeen = null;
  for (const candidate of candidates) {
    const probe = probeVersioned(run, candidate.cmd, candidate.args, MIN_PYTHON, 'python');
    if (probe.found) {
      lastSeen = { ...probe, launcher: candidate };
      if (probe.satisfiesMin) {
        return lastSeen;
      }
    }
  }
  return (
    lastSeen || {
      name: 'python',
      found: false,
      version: null,
      versionText: 'unknown',
      satisfiesMin: false,
      min: formatMin(MIN_PYTHON),
      launcher: null,
    }
  );
}

module.exports = {
  MIN_NODE,
  MIN_NODE_24,
  MIN_NPM,
  MIN_PYTHON,
  pythonCandidates,
  parseSemver,
  satisfiesMin,
  formatVersion,
  defaultRun,
  checkNode,
  isSupportedNode,
  checkNpm,
  checkGit,
  checkPython,
};
