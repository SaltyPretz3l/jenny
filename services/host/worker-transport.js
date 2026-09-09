'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { HOST_ERROR_CODES } = require('../backend/error-codes');
const protocol = require('../execution/worker-protocol');

const CONTROL_DIRECTORY = '/run/jenny-worker';
const { workerError, MAX_RESPONSE_BYTES } = protocol;

function readControllerKey(directory = CONTROL_DIRECTORY) {
  const dir = fs.lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || dir.gid !== 10003
    || (dir.mode & 0o777) !== 0o770) throw workerError('worker_control_permissions_invalid');
  const fd = fs.openSync(path.join(directory, 'controller.key'),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32 || stat.uid !== 0
      || stat.gid !== 10003 || (stat.mode & 0o777) !== 0o640) throw workerError('worker_key_invalid');
    const bytes = Buffer.alloc(33);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== 32) throw workerError('worker_key_invalid');
    return bytes.subarray(0, 32);
  } finally { fs.closeSync(fd); }
}

function requestWorker(operation, fields = {}, { directory = CONTROL_DIRECTORY,
  key = readControllerKey(directory), timeoutMs = 5000 } = {}) {
  const request = { ...fields, schema_version: 1, request_id: randomUUID(), operation };
  protocol.validateRequest(request);
  const wire = protocol.encodeEnvelope(request, key);
  if (Buffer.byteLength(wire) > 128 * 1024) return Promise.reject(workerError('worker_request_limit', HOST_ERROR_CODES.LIMIT));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(directory, 'control.sock'));
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(workerError('worker_transport_timeout')), timeoutMs);
    socket.once('connect', () => socket.write(wire));
    socket.on('data', (chunk) => {
      if (buffer.length + chunk.length > MAX_RESPONSE_BYTES) return finish(workerError('worker_response_limit'));
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) return finish(workerError('worker_response_invalid'));
      try {
        finish(null, protocol.validateResponse(
          protocol.decodeEnvelope(buffer.subarray(0, newline), key, { response: true }), request));
      } catch (error) { finish(error); }
    });
    socket.once('error', () => finish(workerError('worker_transport_unavailable')));
    socket.once('end', () => { if (!settled) finish(workerError('worker_response_incomplete')); });
  });
}

// Keep the hosted adapter's public path stable while making the desktop and
// hosted callers share one implementation of the pure wire contract.
module.exports = { ...protocol, CONTROL_DIRECTORY, readControllerKey, requestWorker };
