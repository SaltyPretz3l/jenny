'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRemoteMcpDiagnostics } = require('../../../services/plugins/remote-mcp/diagnostics');

test('remote diagnostics retain bounded authority while dropping raw sensitive material', () => {
  const rows = [];
  const diagnostics = createRemoteMcpDiagnostics((level, event, fields) => rows.push({ level, event, fields }));
  diagnostics.emit('WARN', 'plugins.remote_mcp.call_failed', {
    descriptor_digest: 'a'.repeat(64), reason: 'Transport Failed!',
    url: 'https://secret.test?q=token', headers: 'Bearer secret', arguments: '{secret}',
  });
  assert.equal(rows[0].fields.descriptor_digest, 'a'.repeat(64));
  assert.equal(rows[0].fields.reason, 'transport_failed_');
  assert.doesNotMatch(JSON.stringify(rows), /secret\.test|Bearer|\{secret\}/);
});
