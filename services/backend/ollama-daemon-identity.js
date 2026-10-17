'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const { readLinuxListeners, withDeadline } = require('./ollama-daemon-port');
const { readDaemonProcess, isServiceCgroup } = require('./ollama-daemon-proc');

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const bounded = (value) => Array.from(String(value || '')).filter((char) => {
  const code = char.charCodeAt(0);
  return code >= 32 && code !== 127;
}).slice(0, 256).join('');

function probeCommand(execFileImpl, command, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFileImpl(command, args, {
        encoding: 'utf8', timeout: Math.max(1, Math.min(1500, timeout)),
        maxBuffer: 64 * 1024, windowsHide: true, shell: false,
      }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
    } catch (_error) { resolve(''); }
  });
}

function parseUnit(text, kind) {
  const fields = Object.fromEntries(text.split('\n').filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (fields.ActiveState !== 'active' || !/^[1-9]\d*$/.test(fields.MainPID || '')) return null;
  return { kind, pid: Number(fields.MainPID), unit: 'ollama.service',
    user: bounded(fields.User || (kind === 'systemd-system' ? 'root' : '')),
    program: bounded(/path=([^ ;}]+)/.exec(fields.ExecStart || '')?.[1]) };
}

function remedyFor(kind, container) {
  if (kind === 'systemd-system') return {
    upgradeCommand: 'curl -fsSL https://ollama.com/install.sh | sh',
    stopCommand: 'sudo systemctl disable --now ollama',
    reenableCommand: 'sudo systemctl enable --now ollama',
  };
  if (kind === 'systemd-user') return {
    stopCommand: 'systemctl --user disable --now ollama',
    reenableCommand: 'systemctl --user enable --now ollama',
  };
  if (kind === 'snap') return {
    upgradeCommand: 'sudo snap refresh ollama', stopCommand: 'sudo snap stop --disable ollama',
    reenableCommand: 'sudo snap start --enable ollama',
  };
  if (kind === 'docker') return {
    upgradeCommand: 'docker pull ollama/ollama',
    ...(CONTAINER_NAME.test(container || '') ? {
      stopCommand: 'docker stop ' + container,
      restartHint: 'docker update --restart=no ' + container,
    } : {}),
  };
  return {};
}

function resultFor(candidate, extra = {}) {
  const kind = candidate?.kind || 'unknown';
  return Object.freeze({
    kind, sameUser: false, confidence: 'inferred', ...candidate, ...extra,
    remedy: Object.freeze(remedyFor(kind, candidate?.container)),
  });
}

async function identifyWithinDeadline(options, end) {
  const { port, getOwnedPid, execFileImpl, readdirImpl } = options;
  const listeners = await readLinuxListeners(options);
  if (listeners.state !== 'occupied') return null;
  if (Date.now() >= end) return resultFor(null);
  const ownedPid = Number(await getOwnedPid());
  const args = ['show', 'ollama.service', '--property=ActiveState,MainPID,User,ExecStart', '--no-pager'];
  const units = (await Promise.all([
    probeCommand(execFileImpl, 'systemctl', args, end - Date.now()).then((text) => parseUnit(text, 'systemd-system')),
    probeCommand(execFileImpl, 'systemctl', ['--user', ...args], end - Date.now()).then((text) => parseUnit(text, 'systemd-user')),
  ])).filter(Boolean);
  let names = [];
  try { names = await readdirImpl('/proc'); } catch (_error) { /* may infer a service */ }
  const pids = [...new Set([...units.map((unit) => unit.pid),
    ...names.filter((name) => /^[1-9]\d*$/.test(name)).map(Number)])].slice(0, 4096);
  const inferred = [];
  const confirmed = [];
  let managedListener = false;
  for (let offset = 0; offset < pids.length && Date.now() < end; offset += 16) {
    const group = await Promise.all(pids.slice(offset, offset + 16).map((pid) =>
      readDaemonProcess(pid, { ...options, inodes: listeners.inodes })));
    for (const proc of group.filter(Boolean)) {
      if (proc.pid === ownedPid) {
        if (proc.matched.length) managedListener = true;
        continue;
      }
      let candidate = units.find((unit) => unit.pid === proc.pid);
      // Another user's exe link is unreadable: argv0 may label and display it (inferred),
      // while stopping still requires the verified executable link (proc.program).
      const argv0 = (proc.argv[0] || '').startsWith('/') ? bounded(proc.argv[0]) : '';
      if ((proc.program || argv0).startsWith('/snap/')) candidate = { kind: 'snap' };
      if (proc.docker) {
        const index = proc.argv.indexOf('-host-port');
        if (index < 0 || proc.argv[index + 1] !== String(port)) continue;
        candidate = { kind: 'docker' };
      }
      if (!candidate && proc.ollama) {
        // A service whose manager cannot be inspected is not a user-stop candidate.
        candidate = { kind: proc.cgroup === null || !proc.program || isServiceCgroup(proc.cgroup) ? 'unknown' : 'process' };
      }
      if (!candidate) continue;
      const entry = { ...candidate, pid: proc.pid, startTime: proc.startTime,
        program: proc.program || candidate.program || argv0, sameUser: proc.sameUser,
        confidence: proc.matched.length === listeners.inodes.length ? 'confirmed' : 'inferred' };
      (proc.matched.length ? confirmed : inferred).push(entry);
    }
  }
  // More than one listener/process is ambiguous, including a managed/external mix.
  if (confirmed.length > 1 || (managedListener && confirmed.length)) return resultFor(null);
  if (managedListener) return null;
  if (confirmed[0]?.confidence !== 'confirmed' && confirmed.length) return resultFor(null);
  let candidate = confirmed[0] || inferred[0] || units.find((unit) => unit.pid !== ownedPid);
  if (candidate?.kind === 'docker' && Date.now() < end) {
    const output = await probeCommand(execFileImpl, 'docker',
      ['ps', '--filter', 'publish=' + port, '--format', '{{.Names}}\t{{.Image}}'], end - Date.now());
    const rows = output.trim().split('\n').filter(Boolean);
    if (rows.length === 1) {
      const [container, image] = rows[0].split('\t');
      if (CONTAINER_NAME.test(container || '')) candidate = { ...candidate, container, image: bounded(image) };
    }
  }
  return resultFor(candidate);
}

async function identifyOllamaDaemon({
  platform = process.platform, port = 11434, timeoutMs = 3000,
  execFileImpl = execFile, readdirImpl = fs.promises.readdir,
  getOwnedPid = () => 0, ...deps
} = {}) {
  if (platform !== 'linux') return null;
  const timeout = Math.max(1, Math.min(3000, Number(timeoutMs) || 3000));
  return withDeadline(() => identifyWithinDeadline({
    ...deps, port, execFileImpl, readdirImpl, getOwnedPid,
  }, Date.now() + timeout), timeout, resultFor(null));
}

module.exports = { identifyOllamaDaemon, remedyFor };
