'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tool = require('../services/tools/builtin/jenny-help-tool');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { createAppGuideService } = require('../services/app-guide-service');
const manifest = require('../services/tools/tool-manifest.json');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const output = result => JSON.parse(result.content);

function fakeGuide() {
  const calls = [];
  return {
    calls,
    search(query) { calls.push(['search', query]); return { ok: true, results: [{ page: 'welcome', title: 'What Jenny is', excerpt: 'x' }] }; },
    read(page) {
      calls.push(['read', page]);
      return page === 'welcome' ? { ok: true, page, title: 'What Jenny is', text: 'text' } : { ok: false, reason: 'not_found', pages: ['welcome'] };
    },
  };
}

test('the manifest entry is a flag-less, read-only runtime tool with two read actions', () => {
  const entry = manifest.tools.find(candidate => candidate.name === 'jenny_help');
  assert.equal(entry.owner, 'electron');
  assert.equal(entry.tool_family, 'runtime');
  assert.deepEqual(entry.surfaces, ['managed_sidecar']);
  assert.equal(entry.availability.config_flag, null);
  assert.equal(entry.availability.workspace_required, false);
  assert.equal(entry.read_only, true);
  assert.equal(entry.side_effecting, false);
  assert.deepEqual(Object.keys(entry.actions), ['search', 'read']);
  assert.ok(Object.values(entry.actions).every(action => action.side_effecting === false));
  assert.equal(entry.parameters.additionalProperties, false);
  assert.deepEqual(entry.parameters.properties.action.enum, ['search', 'read']);
  assert.equal(entry.parameters.properties.query.maxLength, 200);
  assert.deepEqual(entry.parameters.required, ['action']);
  assert.equal(tool.readOnly, true);
  assert.equal(tool.workspaceRequired, false);
});

test('inputs are closed: unknown keys, wrong shapes and a bad action never reach the guide', async () => {
  const guide = fakeGuide();
  const context = { appGuideService: guide };
  for (const input of [undefined, null, [], {}, { action: 'list' }, { action: 'search' }, { action: 'search', query: '' },
    { action: 'search', query: '   ' }, { action: 'search', query: 'x'.repeat(201) }, { action: 'search', query: 7 },
    { action: 'search', query: 'a', page: 'welcome' }, { action: 'read' }, { action: 'read', page: '' },
    { action: 'read', page: 'p'.repeat(65) }, { action: 'read', page: 3 }, { action: 'read', page: 'welcome', query: 'a' },
    { action: 'search', query: 'a', path: '../x' }]) {
    const result = await tool.execute(input, context);
    assert.deepEqual(output(result), { ok: false, reason: 'invalid_request' }, JSON.stringify(input));
    assert.equal(result.isError, false);
    assert.equal(result.metadata.status, 'refused');
  }
  assert.deepEqual(guide.calls, []);
});

test('search and read pass the guide result through with ids-only metadata', async () => {
  const guide = fakeGuide();
  const context = { appGuideService: guide };
  const searched = await tool.execute({ action: 'search', query: ' modes ' }, context);
  assert.deepEqual(output(searched), { ok: true, results: [{ page: 'welcome', title: 'What Jenny is', excerpt: 'x' }] });
  assert.equal(searched.metadata.result_kind, 'jenny_help');
  assert.equal(searched.metadata.status, 'ok');
  const read = await tool.execute({ action: 'read', page: 'welcome' }, context);
  assert.deepEqual(output(read), { ok: true, page: 'welcome', title: 'What Jenny is', text: 'text' });
  const missing = await tool.execute({ action: 'read', page: 'nope' }, context);
  assert.deepEqual(output(missing), { ok: false, reason: 'not_found', pages: ['welcome'] });
  assert.equal(missing.metadata.reason, 'not_found');
  assert.deepEqual(guide.calls, [['search', 'modes'], ['read', 'welcome'], ['read', 'nope']]);
  assert.doesNotMatch(JSON.stringify([searched.metadata, read.metadata, missing.metadata]), /modes|text/);
  assert.equal(tool.summarize({ action: 'search', query: 'q'.repeat(5000) }), 'Jenny help: search');
  assert.equal(tool.summarize({ action: 'read', page: 'welcome' }), 'Jenny help: read');
});

test('a throwing or unloadable guide stays a normal unavailable result without leaking', async () => {
  const throwing = { search() { throw new Error('C:\\private\\path'); }, read() { throw new Error('boom'); } };
  const searched = await tool.execute({ action: 'search', query: 'a' }, { appGuideService: throwing });
  assert.deepEqual(output(searched), { ok: false, reason: 'unavailable' });
  assert.doesNotMatch(searched.content, /private/);
  const read = await tool.execute({ action: 'read', page: 'a' }, { appGuideService: throwing });
  assert.deepEqual(output(read), { ok: false, reason: 'unavailable' });
});

test('with no injected service the tool answers from the shipped guide', async () => {
  const result = output(await tool.execute({ action: 'search', query: 'approvals' }, {}));
  assert.equal(result.ok, true);
  assert.ok(result.results.length > 0 && result.results.length <= 6);
  const page = output(await tool.execute({ action: 'read', page: 'run-modes-and-approvals' }, { backendService: {} }));
  assert.equal(page.ok, true);
  assert.ok(page.text.length > 1000 && page.text.length <= 16000);
  assert.ok(createAppGuideService().listPages().some(entry => entry.id === 'run-modes-and-approvals'));
});

test('jenny_help is always registered, Plan-mode safe, policy auto and refused when hosted', async () => {
  const registry = createDefaultRegistry({});
  assert.ok(registry.getTool('jenny_help'));
  const executor = new ToolExecutor({ registry, permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  const context = { sessionId: 'caller', mode: 'auto', readOnly: true, planMode: true };
  assert.ok(executor._preflightTool({ toolName: 'jenny_help', callId: 'call', input: { action: 'search', query: 'a' } },
    context, { preApproved: true }).tool);
  const descriptor = executor.registry.getTool('jenny_help');
  assert.equal(executor._evaluateToolPolicy(descriptor, { action: 'read', page: 'welcome' }, { ...context, readOnly: false, planMode: false }).decision, 'auto');
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'jenny_help' } });
  assert.equal(hosted.success, false);
});
