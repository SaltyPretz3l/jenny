'use strict';

// Pure command-worker wire validation. Filesystem and socket access belongs to
// services/host/worker-transport.js, allowing desktop transports to reuse this
// exact HMAC/frame contract without importing a hosted adapter.
const { createHmac, timingSafeEqual } = require('node:crypto');
const { HOST_ERROR_CODES } = require('../backend/error-codes');

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_CWD_BYTES = 1024;
const MAX_CWD_DEPTH = 32;
const MAX_REASON_BYTES = 1024;
const CONTROLLER_KEY_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ERROR = /^[a-z_]{1,80}$/u;
const PHASES = new Set(['starting', 'ready', 'running', 'recycling']);
const RESULTS = new Set(['completed', 'cancelled', 'timed_out', 'output_limit', 'interrupted', 'failed']);
const OPERATIONS = new Set(['status', 'submit', 'cancel']);

function workerError(reason, code = HOST_ERROR_CODES.UNAVAILABLE) {
  return Object.assign(new Error(reason), { code, reason });
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function closed(value, keys) {
  return record(value) && Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value, field, limit) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > limit) {
    throw workerError(`${field}_invalid`, HOST_ERROR_CODES.INVALID);
  }
  return value;
}

function validateCwd(value) {
  boundedText(value, 'cwd', MAX_CWD_BYTES);
  if (!value || value.startsWith('/') || /[\\]/u.test(value)) {
    throw workerError('sandbox_cwd_invalid', HOST_ERROR_CODES.INVALID);
  }
  const parts = value.split('/');
  if (parts.length > MAX_CWD_DEPTH || (value !== '.' && parts.some((part) => ['', '.', '..'].includes(part)))
    || parts[0].includes(':')) {
    throw workerError('sandbox_cwd_invalid', HOST_ERROR_CODES.INVALID);
  }
  return value;
}

function validateTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 120) {
    throw workerError('sandbox_timeout_invalid', HOST_ERROR_CODES.INVALID);
  }
  return value;
}

function validateExitCodes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16
    || value.some((code) => !Number.isInteger(code) || code < 0 || code > 255)
    || new Set(value).size !== value.length) {
    throw workerError('sandbox_exit_codes_invalid', HOST_ERROR_CODES.INVALID);
  }
  return [...value];
}

function validateCommand(input) {
  if (!record(input)) throw workerError('sandbox_arguments_invalid', HOST_ERROR_CODES.INVALID);
  const allowed = ['command', 'cwd', 'timeoutSeconds', 'expectedExitCodes'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw workerError('sandbox_arguments_invalid', HOST_ERROR_CODES.INVALID);
  }
  if (typeof input.command !== 'string' || !input.command.trim()) {
    throw workerError('sandbox_command_invalid', HOST_ERROR_CODES.INVALID);
  }
  boundedText(input.command, 'sandbox_command', MAX_COMMAND_BYTES);
  const cwd = input.cwd === undefined ? '.' : input.cwd;
  const timeoutSeconds = input.timeoutSeconds === undefined ? 10 : input.timeoutSeconds;
  const expectedExitCodes = input.expectedExitCodes === undefined ? [0] : input.expectedExitCodes;
  validateCwd(cwd);
  validateTimeout(timeoutSeconds);
  validateExitCodes(expectedExitCodes);
  return { command: input.command, cwd, timeoutSeconds, expectedExitCodes: [...expectedExitCodes] };
}

function validateRequest(request) {
  if (!record(request) || request.schema_version !== PROTOCOL_VERSION
    || !UUID.test(request.request_id) || !OPERATIONS.has(request.operation)) {
    throw workerError('worker_request_invalid', HOST_ERROR_CODES.INVALID);
  }
  const required = request.operation === 'status'
    ? ['schema_version', 'request_id', 'operation']
    : request.operation === 'submit'
      ? ['schema_version', 'request_id', 'operation', 'incarnation', 'job_id', 'command', 'cwd', 'timeout_seconds']
      : ['schema_version', 'request_id', 'operation', 'incarnation', 'job_id'];
  if (Object.keys(request).length !== required.length || Object.keys(request).some((key) => !required.includes(key))) {
    throw workerError('worker_request_keys_invalid', HOST_ERROR_CODES.INVALID);
  }
  if (request.operation !== 'status'
    && (!UUID.test(request.incarnation) || !UUID.test(request.job_id))) {
    throw workerError('worker_request_identity_invalid', HOST_ERROR_CODES.INVALID);
  }
  if (request.operation === 'submit') {
    boundedText(request.command, 'command', MAX_COMMAND_BYTES);
    if (!request.command.trim()) throw workerError('command_invalid', HOST_ERROR_CODES.INVALID);
    validateCwd(request.cwd);
    validateTimeout(request.timeout_seconds);
  }
  return request;
}

function encodeEnvelope(value, key, { response = false } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== CONTROLLER_KEY_BYTES) {
    throw workerError('worker_key_invalid', HOST_ERROR_CODES.INVALID);
  }
  const payloadText = JSON.stringify(value);
  const limit = response ? MAX_RESPONSE_BYTES : MAX_REQUEST_BYTES;
  if (Buffer.byteLength(payloadText, 'utf8') > limit) throw workerError('worker_request_limit', HOST_ERROR_CODES.LIMIT);
  const payload = Buffer.from(payloadText, 'utf8').toString('base64');
  const mac = createHmac('sha256', key).update(payload).digest('hex');
  const envelope = JSON.stringify({ payload, mac });
  if (Buffer.byteLength(envelope, 'utf8') + 1 > limit) throw workerError('worker_request_limit', HOST_ERROR_CODES.LIMIT);
  return envelope + '\n';
}

function decodeEnvelope(line, key, { response = false } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== CONTROLLER_KEY_BYTES) {
    throw workerError('worker_key_invalid', HOST_ERROR_CODES.INVALID);
  }
  if (typeof line !== 'string' && !Buffer.isBuffer(line)) throw workerError('worker_response_invalid');
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(line, 'utf8');
  const limit = response ? MAX_RESPONSE_BYTES : MAX_REQUEST_BYTES;
  if (bytes.length > limit) throw workerError(response ? 'worker_response_limit' : 'worker_request_limit', HOST_ERROR_CODES.LIMIT);
  const text = bytes.toString('utf8').replace(/\n$/u, '');
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw workerError('worker_response_invalid'); }
  if (!closed(envelope, ['payload', 'mac']) || typeof envelope.payload !== 'string'
    || envelope.payload.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(envelope.payload)
    || typeof envelope.mac !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.mac)
    || Buffer.from(envelope.payload, 'base64').toString('base64') !== envelope.payload) {
    throw workerError('worker_response_invalid');
  }
  const expected = createHmac('sha256', key).update(envelope.payload).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) throw workerError('worker_authentication_failed');
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(envelope.payload, 'base64'));
    const value = JSON.parse(decoded);
    if (!record(value)) throw new Error('object required');
    return value;
  } catch (error) {
    throw workerError(response ? 'worker_response_invalid' : 'worker_request_invalid');
  }
}

function validateResult(value) {
  if (!closed(value, ['schema_version', 'incarnation', 'job_id', 'status', 'exit_code',
    'stdout', 'stderr', 'output_truncated', 'reason']) || value.schema_version !== PROTOCOL_VERSION
    || !UUID.test(value.incarnation) || !UUID.test(value.job_id) || !RESULTS.has(value.status)
    || !(value.exit_code === null || Number.isInteger(value.exit_code))
    || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || Buffer.byteLength(value.stdout, 'utf8') + Buffer.byteLength(value.stderr, 'utf8') > MAX_OUTPUT_BYTES
    || typeof value.output_truncated !== 'boolean'
    || !(value.reason === null || (typeof value.reason === 'string' && ERROR.test(value.reason)
      && Buffer.byteLength(value.reason, 'utf8') <= MAX_REASON_BYTES))) {
    throw workerError('worker_result_invalid');
  }
  return value;
}

function validateResponse(value, request) {
  if (!record(value) || value.schema_version !== PROTOCOL_VERSION
    || value.request_id !== request.request_id || typeof value.ok !== 'boolean') {
    throw workerError('worker_response_invalid');
  }
  if (!value.ok) {
    if (!closed(value, ['schema_version', 'request_id', 'ok', 'error'])
      || typeof value.error !== 'string' || !ERROR.test(value.error)) throw workerError('worker_response_invalid');
    throw workerError(value.error);
  }
  if (request.operation === 'status') {
    if (!closed(value, ['schema_version', 'request_id', 'ok', 'incarnation', 'phase', 'job_id', 'previous_result'])
      || !UUID.test(value.incarnation) || !PHASES.has(value.phase)
      || !(value.job_id === null || UUID.test(value.job_id)) || !Object.hasOwn(value, 'previous_result')) {
      throw workerError('worker_status_invalid');
    }
    if ((['starting', 'ready'].includes(value.phase) && value.job_id !== null)
      || (value.phase === 'running' && !UUID.test(value.job_id))) throw workerError('worker_status_invalid');
    if (value.previous_result !== null) {
      validateResult(value.previous_result);
      if (value.previous_result.incarnation === value.incarnation) throw workerError('worker_status_invalid');
    }
  } else if (!closed(value, ['schema_version', 'request_id', 'ok', 'accepted']) || value.accepted !== true) {
    throw workerError('worker_acknowledgement_invalid');
  }
  return value;
}

module.exports = {
  PROTOCOL_VERSION, MAX_REQUEST_BYTES, MAX_OUTPUT_BYTES, MAX_RESPONSE_BYTES,
  MAX_COMMAND_BYTES, MAX_CWD_BYTES, MAX_CWD_DEPTH, CONTROLLER_KEY_BYTES,
  UUID, PHASES, RESULTS, OPERATIONS, workerError, record, closed, validateCommand,
  validateRequest, encodeEnvelope, decodeEnvelope, validateResponse, validateResult,
};
