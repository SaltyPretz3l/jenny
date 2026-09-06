'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  boundedDescription,
  compileRemoteDescriptor,
} = require('../../../services/plugins/remote-mcp/descriptor-compiler');
const { remoteBinding } = require('../../helpers/plugins/remote-mcp-fixtures');

test('descriptor discovery isolates malformed rows and persists content-bound evidence', async () => {
  const calls = [];
  const transport = {
    async negotiate() { return { ok: true, protocol: '2026-07-28' }; },
    async call(method) {
      calls.push(method);
      if (method === 'tools/list') return { ok: true, result: { tools: [
        { name: 'search', description: 'Search', inputSchema: { type: 'object',
          properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } },
        { name: '../bad', inputSchema: { type: 'object' } },
      ] } };
      return { ok: false, reason: 'unexpected_method' };
    },
  };
  const facade = createMemoryFsFacade();
  const result = await compileRemoteDescriptor({ transport,
    bindingDraft: remoteBinding({ binding_digest: '0'.repeat(64), schema_digest: '0'.repeat(64) }),
    facade, baseDir: 'plugins' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['tools/list']);
  assert.equal(result.runtime_binding.contributions.length, 1);
  assert.equal(result.rejected[0].reason, 'remote_name_invalid');
  assert.match(result.runtime_binding.contributions[0].namespaced_name,
    /^plugin:remote:server:tool:search:/);
  assert.equal(result.binding.binding_digest, result.runtime_binding.binding_digest);
});

test('pagination and contribution limits fail closed', async () => {
  let calls = 0;
  const transport = { async negotiate() { return { ok: true, protocol: '2026-07-28' }; },
    async call() { calls += 1; return { ok: true, result: { tools: [], nextCursor: `p${calls}` } }; } };
  const result = await compileRemoteDescriptor({ transport,
    bindingDraft: remoteBinding({ binding_digest: '0'.repeat(64), schema_digest: '0'.repeat(64) }),
    facade: createMemoryFsFacade() });
  assert.equal(result.reason, 'remote_page_limit_exceeded');
  assert.equal(calls, 8);
});

test('invalid binding drafts never reach transport and descriptions are byte bounded', async () => {
  let called = false;
  const transport = { async negotiate() { called = true; return { ok: true }; } };
  const result = await compileRemoteDescriptor({ transport,
    bindingDraft: remoteBinding({ protocol_versions: ['2025-03-26'] }),
    facade: createMemoryFsFacade() });
  assert.equal(result.reason, 'remote_binding_draft_invalid');
  assert.equal(called, false);
  assert.equal(Buffer.byteLength(boundedDescription('😀'.repeat(400)), 'utf8') <= 1024, true);
});
