'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMcpSse } = require('../../../services/plugins/remote-mcp/sse-parser');

test('request-scoped SSE accepts comments and notifications before one final response', () => {
  const body = [': keepalive', '',
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}', '',
    'data: {"jsonrpc":"2.0","id":"req-1","result":{"ok":true}}', '', ''].join('\r\n');
  const parsed = parseMcpSse(Buffer.from(body), 'req-1');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.notifications.length, 1);
  assert.equal(parsed.response.result.ok, true);
});

test('SSE rejects server requests, duplicate settlement, malformed JSON, and bounds', () => {
  const serverRequest = 'data: {"jsonrpc":"2.0","id":2,"method":"sampling/createMessage"}\n\n';
  assert.equal(parseMcpSse(serverRequest, 'req').reason, 'server_initiated_request_unsupported');
  const duplicate = [
    'data: {"jsonrpc":"2.0","id":"req","result":{}}', '',
    'data: {"jsonrpc":"2.0","id":"req","result":{}}', '',
  ].join('\n');
  assert.equal(parseMcpSse(duplicate, 'req').reason, 'mcp_response_id_invalid');
  assert.equal(parseMcpSse('data: {bad}\n\n', 'req').reason, 'sse_json_invalid');
  assert.equal(parseMcpSse(`data: ${'x'.repeat(80)}\n\n`, 'req', {
    max_bytes: 1024, max_line_bytes: 32, max_events: 2,
  }).reason, 'sse_line_limit_exceeded');
});

test('SSE rejects malformed UTF-8 before parsing messages', () => {
  assert.equal(parseMcpSse(Buffer.from([0xff, 0xfe]), 'req-1').reason, 'sse_utf8_invalid');
});
