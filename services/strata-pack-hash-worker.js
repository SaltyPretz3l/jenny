'use strict';

// worker_threads script: streams one file through sha256 in 8 MiB reads off the main thread.
// workerData: { path }. Posts { done } (bytes read, every PROGRESS_BYTES), then { sha256 } or { error }.

const crypto = require('crypto');
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

const READ_BYTES = 8 * 1024 * 1024;
const PROGRESS_BYTES = 256 * 1024 * 1024;

function hashFileSync(file, onProgress = () => {}) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_BYTES);
  const fd = fs.openSync(file, 'r');
  let done = 0;
  let reported = 0;
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, READ_BYTES, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      done += bytesRead;
      if (done - reported >= PROGRESS_BYTES) { reported = done; onProgress(done); }
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

if (parentPort) {
  try {
    const sha256 = hashFileSync(String(workerData && workerData.path), (done) => parentPort.postMessage({ done }));
    parentPort.postMessage({ sha256 });
  } catch (error) {
    parentPort.postMessage({ error: String((error && error.code) || (error && error.message) || error) });
  }
}

module.exports = { hashFileSync };
