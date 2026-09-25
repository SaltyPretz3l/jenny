'use strict';

const TOMBSTONE_KIND = 'terminal_tombstone';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const KEYS = ['canonical_result_ref', 'compacted_at', 'kind', 'original_input_bytes', 'schema_version'];

function retainedMetadata(input) {
  if (!['root_chat', 'child_chat'].includes(input?.kind)) return {};
  const key = input.kind === 'root_chat' ? 'root_run' : 'child_run';
  return { schema_version: 2, original_kind: input.kind,
    route: { provider_id: input.route.provider_id }, [key]: JSON.parse(JSON.stringify(input[key])) };
}
function validRetainedMetadata(input) {
  const root = input.original_kind === 'root_chat';
  if (!root && input.original_kind !== 'child_chat') return false;
  const key = root ? 'root_run' : 'child_run';
  if (Object.keys(input).sort().join(',') !== [...KEYS, 'original_kind', 'route', key].sort().join(',')
    || !input.route || Object.keys(input.route).join(',') !== 'provider_id'
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.route.provider_id)) return false;
  const data = input[key];
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  if (!data || !id(data.root_run_id) || !sha(data.authority_fingerprint)) return false;
  if (!root) return Object.keys(data).sort().join(',') === 'args_sha256,authority_fingerprint,parent_turn_id,parent_work_id,root_run_id,root_work_id,schema_version,spawn_call_id'
    && data.schema_version === 1 && sha(data.args_sha256)
    && ['parent_turn_id', 'parent_work_id', 'root_work_id', 'spawn_call_id'].every(name => id(data[name]));
  const keys = ['allowed_provider_ids', 'authority_fingerprint', 'limits', 'root_run_id', 'schema_version'];
  if (data.schema_version === 2) keys.push('orchestration_limits');
  const counters = ['inference_requests', 'input_tokens', 'output_tokens'];
  if (Object.keys(data).sort().join(',') !== keys.sort().join(',') || ![1, 2].includes(data.schema_version)
    || !Array.isArray(data.allowed_provider_ids) || data.allowed_provider_ids.length !== 1
    || data.allowed_provider_ids[0] !== input.route.provider_id || !data.limits
    || Object.keys(data.limits).sort().join(',') !== counters.join(',')
    || !counters.every(name => Number.isSafeInteger(data.limits[name]) && data.limits[name] > 0 && data.limits[name] <= 1e12)) return false;
  const limits = data.orchestration_limits;
  return data.schema_version === 1 || Boolean(limits && Object.keys(limits).sort().join(',') === 'descendant_depth,descendants'
    && Number.isSafeInteger(limits.descendants) && limits.descendants >= 0 && limits.descendants <= 512
    && Number.isSafeInteger(limits.descendant_depth) && limits.descendant_depth >= 0 && limits.descendant_depth <= 8);
}
function isTerminalTombstone(input) { return input?.kind === TOMBSTONE_KIND; }

// This closed input variant retains the ORIGINAL submission hash on the work
// record. It can never become executable input or reauthorize an old request.
function validTerminalTombstone(work) {
  const input = work.input;
  const shape = input?.schema_version === 2 ? validRetainedMetadata(input)
    : input?.schema_version === 1 && Object.keys(input).sort().join(',') === KEYS.join(',');
  if (!shape || !TERMINAL.has(work.status)
    || work.checkpoint_ref !== null || !Number.isSafeInteger(input.original_input_bytes)
    || input.original_input_bytes < 2 || input.original_input_bytes > 16 * 1024 * 1024
    || typeof input.compacted_at !== 'string' || input.compacted_at.length > 40
    || !Number.isFinite(Date.parse(input.compacted_at))) return false;
  if (!work.attempt) return work.status === 'cancelled' && input.canonical_result_ref === null;
  const ref = input.canonical_result_ref;
  return Boolean(ref && Object.keys(ref).sort().join(',') === 'session_id,turn_id'
    && ref.session_id === work.session_id && ref.turn_id === work.turn_id);
}

module.exports = { TOMBSTONE_KIND, RETENTION_MS, TERMINAL,
  isTerminalTombstone, validTerminalTombstone, retainedMetadata };
