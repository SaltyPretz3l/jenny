'use strict';

const fs = require('fs');
const path = require('path');

function startTimeFromStat(value) {
  const tail = String(value).slice(String(value).lastIndexOf(')') + 2).trim().split(/\s+/);
  return /^\d+$/.test(tail[19] || '') ? tail[19] : '';
}

// A unit-managed process sits in a cgroup whose leaf is a .service. The systemd
// hierarchy line decides; user@UID.service/app.slice/*.scope is a session process.
function isServiceCgroup(cgroup) {
  const rows = String(cgroup).split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split(':')).filter((cells) => cells.length >= 3);
  const systemd = rows.filter(([, controllers]) => controllers === '' || controllers.split(',').includes('name=systemd'));
  return (systemd.length ? systemd : rows)
    .some((cells) => (cells.slice(2).join(':').split('/').pop() || '').endsWith('.service'));
}

async function readDaemonProcess(pid, {
  readFileImpl = fs.promises.readFile, readdirImpl = fs.promises.readdir,
  readlinkImpl = fs.promises.readlink, statImpl = fs.promises.stat,
  uid = typeof process.getuid === 'function' ? process.getuid() : -1,
  inodes = [],
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const base = '/proc/' + pid;
  try {
    const argv = String(await readFileImpl(base + '/cmdline', 'utf8')).split('\0').filter(Boolean);
    const name = path.posix.basename(argv[0] || '');
    const ollama = name === 'ollama' && argv[1] === 'serve';
    const docker = name === 'docker-proxy';
    if (!ollama && !docker) return null;
    const firstStart = startTimeFromStat(await readFileImpl(base + '/stat', 'utf8'));
    if (!firstStart) return null;
    const owner = await statImpl(base);
    // Another user's exe link is unreadable; that may still be identified, never stopped.
    let program = '';
    try { program = String(await readlinkImpl(base + '/exe')); } catch (_error) { /* identification only */ }
    if (program && path.posix.basename(program.replace(/ \(deleted\)$/, '')) !== name) return null;
    let cgroup = null;
    try { cgroup = String(await readFileImpl(base + '/cgroup', 'utf8')); } catch (_error) { /* unknown */ }
    const matched = new Set();
    try {
      const fds = program ? await readdirImpl(base + '/fd') : [];
      for (const fd of fds.slice(0, 1024)) {
        try {
          const link = String(await readlinkImpl(base + '/fd/' + fd));
          const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
          if (inodes.includes(inode)) matched.add(inode);
        } catch (_error) { /* inaccessible descriptors cannot establish identity */ }
      }
    } catch (_error) { /* identity remains inferred */ }
    if (startTimeFromStat(await readFileImpl(base + '/stat', 'utf8')) !== firstStart) return null;
    return { pid, startTime: firstStart, program: String(program).slice(0, 256), argv,
      sameUser: owner.uid === uid, cgroup, ollama, docker, matched: [...matched] };
  } catch (_error) {
    return null;
  }
}

module.exports = { startTimeFromStat, readDaemonProcess, isServiceCgroup };
