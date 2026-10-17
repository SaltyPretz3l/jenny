'use strict';

const fs = require('fs');

// /proc socket state is independent of Ollama's HTTP readiness. Never infer a
// free port from a failed HTTP request, an unreadable table, or a timed-out read.
async function readLinuxListeners({
  port = 11434,
  readFileImpl = fs.promises.readFile,
} = {}) {
  const inodes = new Set();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { state: 'unknown', inodes: [] };
  try {
    for (const table of ['tcp', 'tcp6']) {
      let text;
      try {
        text = String(await readFileImpl('/proc/net/' + table, 'utf8'));
      } catch (error) {
        if (table === 'tcp6' && error?.code === 'ENOENT') continue;
        throw error;
      }
      if (text.length > 1024 * 1024 || !/local_address/.test(text.split('\n')[0])) {
        throw new Error('invalid socket table');
      }
      for (const line of text.split('\n').slice(1)) {
        if (!line.trim()) continue;
        const cells = line.trim().split(/\s+/);
        if (cells.length < 10 || !/^[0-9A-F]+:[0-9A-F]{4}$/i.test(cells[1])
          || !/^[0-9A-F]{2}$/i.test(cells[3]) || !/^\d+$/.test(cells[9])) {
          throw new Error('invalid socket row');
        }
        if (cells[3] === '0A' && parseInt(cells[1].split(':')[1], 16) === port) {
          inodes.add(cells[9]);
        }
      }
    }
    return { state: inodes.size ? 'occupied' : 'free', inodes: [...inodes] };
  } catch (_error) {
    return { state: 'unknown', inodes: [] };
  }
}

async function withDeadline(operation, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch(() => fallback),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeOllamaPort({ platform = process.platform, timeoutMs = 1500, port = 11434, ...deps } = {}) {
  if (platform !== 'linux') return null;
  const value = await withDeadline(
    () => readLinuxListeners({ ...deps, port }),
    Math.max(1, Math.min(3000, Number(timeoutMs) || 1500)),
    { state: 'unknown' },
  );
  return Object.freeze({ state: value.state, port });
}

module.exports = { readLinuxListeners, probeOllamaPort, withDeadline };
