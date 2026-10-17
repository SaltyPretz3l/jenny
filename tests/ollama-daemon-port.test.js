'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readLinuxListeners, probeOllamaPort } = require('../services/backend/ollama-daemon-port');

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
const row = (port, inode = 42, state = '0A') =>
  `  0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}\n`;

test('port occupancy is independent of HTTP and includes IPv4 and IPv6 listeners', async () => {
  for (const table of ['tcp', 'tcp6']) {
    const value = await readLinuxListeners({
      readFileImpl: async (file) => HEADER + (file.endsWith('/' + table) ? row(11434) : ''),
    });
    assert.equal(value.state, 'occupied');
    assert.deepEqual(value.inodes, ['42']);
  }
});

test('free requires readable valid tables, and established sockets do not hold the listening port', async () => {
  assert.deepEqual(await probeOllamaPort({
    platform: 'linux', readFileImpl: async () => HEADER + row(11434, 42, '01'),
  }), { state: 'free', port: 11434 });
  for (const readFileImpl of [
    async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    async () => 'invalid',
    async () => HEADER + 'malformed row\n',
  ]) {
    assert.equal((await probeOllamaPort({ platform: 'linux', readFileImpl })).state, 'unknown');
  }
});

test('disabled IPv6 does not make a readable empty IPv4 table unknown', async () => {
  const result = await probeOllamaPort({
    platform: 'linux',
    readFileImpl: async (file) => {
      if (file.endsWith('tcp6')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return HEADER;
    },
  });
  assert.equal(result.state, 'free');
});

test('probe deadline settles a stalled reader and non-Linux is not reported free', async () => {
  assert.equal((await probeOllamaPort({
    platform: 'linux', timeoutMs: 10, readFileImpl: () => new Promise(() => {}),
  })).state, 'unknown');
  assert.equal(await probeOllamaPort({ platform: 'win32' }), null);
});
