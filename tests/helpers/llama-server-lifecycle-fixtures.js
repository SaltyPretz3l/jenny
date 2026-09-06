'use strict';

// Shared fixtures for the llama-server lifecycle suites: a fake child process,
// throwaway HTTP servers on 127.0.0.1, and tracked temp userData dirs.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { PID_FILENAME, startLlamaServer } = require('../../services/llama-server-lifecycle');
const { trackDirectory } = require('./resource-cleanup');

function createStream() {
  const stream = new EventEmitter();
  stream.encoding = '';
  stream.setEncoding = (encoding) => {
    stream.encoding = encoding;
  };
  return stream;
}

class FakeChildProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = createStream();
    this.stderr = createStream();
  }

  kill() {}
}

async function listen(server) {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}/v1`;
}

async function getClosedPort() {
  const server = http.createServer();
  const baseUrl = await listen(server);
  await closeServer(server);
  return Number(new URL(baseUrl).port);
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function makeUserDataDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(dir);
  return dir;
}

function writeIdentityPidFile(userDataPath, record) {
  fs.writeFileSync(path.join(userDataPath, PID_FILENAME), JSON.stringify(record), 'utf8');
}

async function startReadyFakeServer({ userDataPath, child, logs }) {
  let probeCount = 0;
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    probeCount += 1;
    response.end(JSON.stringify(
      probeCount === 1
        ? { ok: true }
        : { object: 'list', data: [{ id: 'qwen3:0.5b' }] }
    ));
  });
  const baseUrl = await listen(server);
  const handle = await startLlamaServer({
    modelTag: 'qwen3:0.5b',
    binaryPath: path.join(userDataPath, 'llama-server.exe'),
    modelPath: path.join(userDataPath, 'model.gguf'),
    userDataPath,
    port: Number(new URL(baseUrl).port),
    readinessTimeoutMs: 1000,
    readinessPollIntervalMs: 1,
    platform: 'win32',
    spawnImpl: () => child,
    spawnSyncImpl: () => ({ status: 0 }),
    isProcessAliveImpl: () => true,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  return { handle, server };
}

module.exports = {
  FakeChildProcess,
  closeServer,
  createStream,
  getClosedPort,
  listen,
  makeUserDataDir,
  startReadyFakeServer,
  writeIdentityPidFile,
};
