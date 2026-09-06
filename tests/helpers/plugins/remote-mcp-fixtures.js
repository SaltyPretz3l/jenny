'use strict';

function remoteBinding(overrides = {}) {
  return {
    binding_schema_version: 1,
    publisher_id: 'jenny-official', plugin_id: 'remote', contribution_id: 'server',
    artifact_digest: 'a'.repeat(64), generation_id: 'gen-stage5', commit_epoch: 3,
    descriptor_digest: 'b'.repeat(64), schema_digest: 'c'.repeat(64),
    endpoint_url: 'https://mcp.test/mcp', endpoint_origin_digest: 'd'.repeat(64),
    destination_scope: 'internet', protocol_versions: ['2026-07-28', '2025-11-25'],
    feature_classes: ['tools'], consent_digest: 'e'.repeat(64),
    auth_profile_ref: 'f'.repeat(64), binding_digest: '1'.repeat(64),
    ...overrides,
  };
}

function transportContext(overrides = {}) {
  return { request_id: 'turn-1', operation_id: 'operation-1',
    deadline_epoch_ms: Date.now() + 60000, total_timeout_ms: 30000, ...overrides };
}

function jsonResponse(id, result, overrides = {}) {
  return { ok: true, status_code: 200,
    headers: { 'content-type': 'application/json', ...(overrides.headers || {}) },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })),
    endpoint_origin_digest: 'd'.repeat(64), ...overrides };
}

function createScriptedBroker(handler) {
  const calls = [];
  return { calls, async request(input) { calls.push(input); return handler(input, calls.length - 1); } };
}

module.exports = { remoteBinding, transportContext, jsonResponse, createScriptedBroker };
