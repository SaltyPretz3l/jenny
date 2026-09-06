'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RemoteMcpTransport } = require('../../../services/plugins/remote-mcp/transport');
const {
  remoteBinding,
  transportContext,
  jsonResponse,
  createScriptedBroker,
} = require('../../helpers/plugins/remote-mcp-fixtures');

function bodyOf(call) { return JSON.parse(call.body); }

test('2026 transport is stateless, metadata/header complete, and uses request-scoped JSON', async () => {
  const broker = createScriptedBroker((input) => {
    const body = bodyOf(input);
    if (body.method === 'server/discover') {
      return jsonResponse(body.id, { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
    }
    return jsonResponse(body.id, { content: [{ type: 'text', text: 'ok' }] });
  });
  const transport = new RemoteMcpTransport({ networkBroker: broker, binding: remoteBinding(),
    consent: {}, credential: { access_token: 'opaque-token' }, context: transportContext() });
  const result = await transport.call('tools/call', { name: 'search', arguments: { q: 'x' } },
    { extraHeaders: { 'Mcp-Param-Region': 'us-east1' } });
  assert.equal(result.ok, true);
  const call = broker.calls[1];
  assert.equal(call.headers['MCP-Protocol-Version'], '2026-07-28');
  assert.equal(call.headers['Mcp-Method'], 'tools/call');
  assert.equal(call.headers['Mcp-Name'], 'search');
  assert.equal(call.headers['Mcp-Param-Region'], 'us-east1');
  assert.equal(call.headers.authorization, 'Bearer opaque-token');
  assert.equal(bodyOf(call).params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.equal(Object.hasOwn(bodyOf(call).params, 'protocolVersion'), false);
  assert.equal(call.same_origin_redirects_only, true);
});

test('2026 transport parses request-scoped SSE and forwards cancellation', async () => {
  const controller = new AbortController();
  const broker = createScriptedBroker((input) => {
    const body = bodyOf(input);
    if (body.method === 'server/discover') return jsonResponse(body.id,
      { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
    const sse = `: ping\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id,
      result: { content: [] } })}\n\n`;
    return { ok: true, status_code: 200, headers: { 'content-type': 'text/event-stream' },
      body: Buffer.from(sse), endpoint_origin_digest: 'd'.repeat(64) };
  });
  const transport = new RemoteMcpTransport({ networkBroker: broker, binding: remoteBinding(),
    consent: {}, context: transportContext({ signal: controller.signal }) });
  assert.equal((await transport.call('tools/call', { name: 'search', arguments: {} })).ok, true);
  assert.equal(broker.calls.every((call) => call.signal === controller.signal), true);
});

test('bounded 2025 fallback initializes one session and rejects older-era plumbing', async () => {
  const broker = createScriptedBroker((input) => {
    const body = bodyOf(input);
    if (body.method === 'server/discover') return { ok: true, status_code: 400, headers: {},
      body: Buffer.alloc(0), endpoint_origin_digest: 'd'.repeat(64) };
    if (body.method === 'initialize') return jsonResponse(body.id,
      { protocolVersion: '2025-11-25', capabilities: {} }, {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
      });
    if (body.method === 'notifications/initialized') return { ok: true, status_code: 202,
      headers: {}, body: Buffer.alloc(0), endpoint_origin_digest: 'd'.repeat(64) };
    return jsonResponse(body.id, { tools: [] });
  });
  const transport = new RemoteMcpTransport({ networkBroker: broker, binding: remoteBinding(),
    consent: {}, context: transportContext() });
  assert.equal((await transport.call('tools/list')).ok, true);
  assert.equal(transport.protocol, '2025-11-25');
  assert.equal(broker.calls[3].headers['Mcp-Session-Id'], 'session-1');
  assert.equal(broker.calls.some((call) => call.method === 'GET'), false);
});

test('origin changes, malformed sessions, and recognized modern errors fail closed', async () => {
  const drift = createScriptedBroker((input) => {
    const body = bodyOf(input);
    return { ...jsonResponse(body.id, { supportedVersions: ['2026-07-28'] }),
      endpoint_origin_digest: 'e'.repeat(64) };
  });
  assert.equal((await new RemoteMcpTransport({ networkBroker: drift, binding: remoteBinding(),
    consent: {}, context: transportContext() }).negotiate()).reason, 'endpoint_origin_changed');
  const modernError = createScriptedBroker((input) => {
    const body = bodyOf(input);
    return { ok: true, status_code: 400, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id,
        error: { code: -32020, message: 'mismatch' } })), endpoint_origin_digest: 'd'.repeat(64) };
  });
  const failed = await new RemoteMcpTransport({ networkBroker: modernError,
    binding: remoteBinding(), consent: {}, context: transportContext() }).negotiate();
  assert.equal(failed.status_code, 400);
  assert.equal(modernError.calls.length, 1, 'recognized modern errors must not trigger legacy fallback');
});

test('malformed modern discovery and JSON-RPC envelopes fail closed', async () => {
  const broker = createScriptedBroker((input) => {
    const body = bodyOf(input);
    return jsonResponse(body.id, { supportedVersions: ['2026-07-28'] });
  });
  const result = await new RemoteMcpTransport({ networkBroker: broker, binding: remoteBinding(),
    consent: {}, context: transportContext() }).negotiate();
  assert.equal(result.reason, 'remote_protocol_unsupported');
  const invalidUtf8 = createScriptedBroker(() => ({ ok: true, status_code: 200,
    headers: { 'content-type': 'application/json' }, body: Buffer.from([0xff]),
    endpoint_origin_digest: 'd'.repeat(64) }));
  assert.equal((await new RemoteMcpTransport({ networkBroker: invalidUtf8,
    binding: remoteBinding(), consent: {}, context: transportContext() }).negotiate()).reason,
  'mcp_json_invalid');
});
