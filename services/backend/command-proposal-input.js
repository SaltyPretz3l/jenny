'use strict';

/* The closed `commandProposal` record of the exact-command Run (row 59
 * checkpoint 3, Batch B contract E1) and the durable runtime input kind it
 * becomes. The record carries the exact command, so it lives only in the runtime
 * ledger work input; nothing here logs or echoes it. Validation mirrors the
 * sidecar's closed decoder (sidecar/runtime/command_proposal_request.py), so a
 * malformed record is refused before any durable work exists.
 */

const crypto = require('node:crypto');

const COMMAND_PROPOSAL_KIND = 'command_proposal';
const MAX_COMMAND_BYTES = 8 * 1024;
const MAX_PURPOSE_CHARS = 1024;
const MAX_CWD_CHARS = 4096;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_DOCKER_TIMEOUT_SECONDS = 120;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TOP_KEYS = ['schema_version', 'proposal_id', 'accepted_revision', 'decision_id', 'command_operation_id',
  'tool_call_id', 'command_sha256', 'command_binding', 'command_input'].sort();
const BINDING_KEYS = ['backend', 'shell', 'cwd', 'root_revision'].sort();
const INPUT_KEYS = ['command', 'cwd', 'timeout_seconds', 'expected_exit_codes', 'purpose'].sort();

function invalid(reason) {
  return Object.assign(new TypeError('command_proposal_invalid'), { code: 'command_proposal_invalid', reason,
    retryable: false });
}

function plain(value, keys, reason) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.join(',')) throw invalid(reason);
  return value;
}

function integer(value, reason, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(reason);
  return value;
}

function text(value, reason, { maxChars = Infinity, maxBytes = Infinity } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')
    || Array.from(value).length > maxChars || Buffer.byteLength(value, 'utf8') > maxBytes) throw invalid(reason);
  return value;
}

// A closed, frozen, deep copy; throws a coded TypeError (`reason` names the field, never the value).
function normalizeCommandProposal(value) {
  const record = plain(value, TOP_KEYS, 'record');
  integer(record.schema_version, 'schema_version', 1, 1);
  for (const key of ['proposal_id', 'tool_call_id']) {
    if (typeof record[key] !== 'string' || !TOKEN.test(record[key])) throw invalid(key);
  }
  integer(record.accepted_revision, 'accepted_revision', 1);
  for (const key of ['decision_id', 'command_operation_id']) {
    if (typeof record[key] !== 'string' || !UUID.test(record[key])) throw invalid(key);
  }
  if (typeof record.command_sha256 !== 'string' || !SHA256.test(record.command_sha256)) throw invalid('command_sha256');
  const binding = plain(record.command_binding, BINDING_KEYS, 'command_binding');
  if (!['native', 'docker'].includes(binding.backend) || !['cmd.exe', '/bin/sh'].includes(binding.shell)) {
    throw invalid('command_binding');
  }
  text(binding.cwd, 'command_binding', { maxChars: MAX_CWD_CHARS });
  integer(binding.root_revision, 'command_binding', 0);
  const input = plain(record.command_input, INPUT_KEYS, 'command_input');
  text(input.command, 'command', { maxBytes: MAX_COMMAND_BYTES });
  text(input.cwd, 'cwd', { maxChars: MAX_CWD_CHARS });
  integer(input.timeout_seconds, 'timeout_seconds', 1, MAX_TIMEOUT_SECONDS);
  text(input.purpose, 'purpose', { maxChars: MAX_PURPOSE_CHARS });
  if (!Array.isArray(input.expected_exit_codes) || input.expected_exit_codes.length < 1
    || input.expected_exit_codes.length > 16 || new Set(input.expected_exit_codes).size !== input.expected_exit_codes.length) {
    throw invalid('expected_exit_codes');
  }
  for (const code of input.expected_exit_codes) integer(code, 'expected_exit_codes', 0, 255);
  if (input.cwd !== binding.cwd) throw invalid('cwd_mismatch');
  if (crypto.createHash('sha256').update(Buffer.from(input.command, 'utf8')).digest('hex') !== record.command_sha256) {
    throw invalid('hash_mismatch');
  }
  if (binding.backend === 'docker' && (input.timeout_seconds > MAX_DOCKER_TIMEOUT_SECONDS || binding.shell !== '/bin/sh')) {
    throw invalid('docker_binding_limits');
  }
  return Object.freeze({
    schema_version: 1,
    proposal_id: record.proposal_id,
    accepted_revision: record.accepted_revision,
    decision_id: record.decision_id,
    command_operation_id: record.command_operation_id,
    tool_call_id: record.tool_call_id,
    command_sha256: record.command_sha256,
    command_binding: Object.freeze({ backend: binding.backend, shell: binding.shell, cwd: binding.cwd,
      root_revision: binding.root_revision }),
    command_input: Object.freeze({ command: input.command, cwd: input.cwd, timeout_seconds: input.timeout_seconds,
      expected_exit_codes: Object.freeze([...input.expected_exit_codes]), purpose: input.purpose }),
  });
}

module.exports = { COMMAND_PROPOSAL_KIND, normalizeCommandProposal };
