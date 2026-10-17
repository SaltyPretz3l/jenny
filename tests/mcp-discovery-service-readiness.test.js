'use strict';

// Row 53 S9: the rea readiness probe seen from McpDiscoveryService (consent,
// transient state, the Test hook and the stale-result guard).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { McpDiscoveryService } = require('../services/mcp-discovery-service');
const { pendingTrust } = require('../services/mcp-config-store');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { userData, writeConfig, approvedServer, REA_ROW } = require('./helpers/mcp-discovery-fixtures');

test.afterEach(cleanupTrackedResources);

test('successful rea Test probes once, exposes transient readiness and records consent', async () => {
  const directory = userData();
  writeConfig(directory, [{ ...REA_ROW, enabled: false, trust: pendingTrust(REA_ROW) }]);
  const before = fs.readFileSync(path.join(directory, 'mcp-servers.json'), 'utf8');
  const readiness = { healthy: true, tools: 170, prompts: 6, checkedAt: '2026-10-14T14:02:00.000Z', reason: '' };
  const probes = [], logs = [];
  const inspection = { ok: true, tools_digest: 'a'.repeat(64), tool_count: 170 };
  const service = new McpDiscoveryService({ userDataPath: directory,
    readinessProbe: async ({ server }) => { probes.push(server); return readiness; },
    log: (...entry) => logs.push(entry), backendService: { currentStatus: {}, sidecarClient: {
      connected: true, request: async () => inspection } } });
  assert.equal(service.getState().servers.find((row) => row.name === 'rea').readiness, null);
  await service.refresh();
  assert.equal(probes.length, 0);
  await service.testServer({ name: 'rea' });
  assert.equal(probes.length, 0);
  assert.equal(await service.testServer({ name: 'rea', confirmed: true }), inspection);
  assert.equal(probes.length, 1);
  assert.deepEqual(probes[0].env, REA_ROW.env);
  assert.equal(service.getState().servers.find((row) => row.name === 'rea').readiness, readiness);
  assert.deepEqual(logs.at(-1), ['INFO', 'mcp.readiness.checked', { server_name: 'rea', healthy: true, reason: '' }]);
  assert.deepEqual(await service.checkReadiness({ name: 'rea' }), { ok: true, readiness });
  assert.equal(fs.readFileSync(path.join(directory, 'mcp-servers.json'), 'utf8'), before);
  await service.updateServer({ name: 'rea', server: { ...REA_ROW, args: ['new.mjs', 'mcp'] } });
  assert.equal((await service.checkReadiness({ name: 'rea' })).error.code, 'readiness_unconsented');
});

test('readiness refuses unavailable and unconsented rows, permits approved rows and clears removal', async () => {
  const directory = userData();
  const docs = { ...REA_ROW, name: 'docs' };
  writeConfig(directory, [{ ...REA_ROW, enabled: false, trust: pendingTrust(REA_ROW) }, approvedServer(docs)]);
  let calls = 0;
  const readiness = { healthy: false, tools: 170, prompts: 6, checkedAt: '2026-10-14T14:02:00.000Z', reason: 'exit_nonzero' };
  const service = new McpDiscoveryService({ userDataPath: directory,
    readinessProbe: async () => { calls += 1; return readiness; } });
  for (const name of ['missing', 'docs']) assert.deepEqual(await service.checkReadiness({ name }),
    { ok: false, error: { code: 'readiness_unavailable', message: 'This connection has no readiness check.' } });
  assert.deepEqual(await service.checkReadiness({ name: 'rea' }),
    { ok: false, error: { code: 'readiness_unconsented', message: 'Test the connection first.' } });
  assert.equal(calls, 0);
  service.configStore.update((document) => ({ ...document, mcp_servers: [approvedServer(REA_ROW)] }));
  assert.deepEqual(await service.checkReadiness({ name: 'rea' }), { ok: true, readiness });
  assert.equal(calls, 1);
  assert.equal((await service.removeServer({ name: 'rea' })).ok, true);
  assert.equal(service.readiness.has('rea'), false);
  await service.createServer(REA_ROW);
  assert.equal(service.getState().servers.find((row) => row.name === 'rea').readiness, null);
});

test('failed inspections and non-rea Tests never probe; unhealthy readiness never fails Test', async () => {
  const directory = userData();
  writeConfig(directory, [approvedServer(REA_ROW), approvedServer({ ...REA_ROW, name: 'docs' })]);
  let calls = 0;
  let inspection = { ok: false };
  const service = new McpDiscoveryService({ userDataPath: directory,
    readinessProbe: async () => { calls += 1; return { healthy: false, tools: 0, prompts: 0,
      checkedAt: '2026-10-14T14:02:00.000Z', reason: 'timed_out' }; },
    backendService: { sidecarClient: { connected: true, request: async () => inspection } } });
  await service.testServer({ name: 'rea', confirmed: true });
  inspection = { ok: true, tools_digest: 'a'.repeat(64) };
  await service.testServer({ name: 'docs', confirmed: true });
  assert.equal(calls, 0);
  assert.equal(await service.testServer({ name: 'rea', confirmed: true }), inspection);
  assert.equal(calls, 1);
});

test('a rejecting probe is logged and never fails the Test; a mid-probe edit drops the result', async () => {
  const directory = userData();
  writeConfig(directory, [approvedServer(REA_ROW)]);
  const logs = [];
  let service;
  let mode = 'reject';
  const inspection = { ok: true, tools_digest: 'a'.repeat(64) };
  service = new McpDiscoveryService({ userDataPath: directory, log: (...entry) => logs.push(entry),
    readinessProbe: async () => {
      if (mode === 'reject') throw new Error('private probe failure');
      await service.updateServer({ name: 'rea', server: { ...REA_ROW, args: ['-y', 'rea-agents@6.4.1', 'mcp'] } });
      return { healthy: true, tools: 1, prompts: 0, checkedAt: '2026-10-14T14:02:00.000Z', reason: '' };
    },
    backendService: { sidecarClient: { connected: true, request: async () => inspection } } });
  assert.equal(await service.testServer({ name: 'rea', confirmed: true }), inspection);
  assert.deepEqual(logs.at(-1), ['WARN', 'mcp.readiness.failed', { server_name: 'rea', error_name: 'Error' }]);
  assert.equal(JSON.stringify(logs).includes('private'), false);
  mode = 'edit';
  assert.equal((await service.checkReadiness({ name: 'rea' })).ok, true);
  assert.equal(service.readiness.has('rea'), false);
  assert.equal(service.getState().servers.find((row) => row.name === 'rea').readiness, null);
});
