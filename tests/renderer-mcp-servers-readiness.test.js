'use strict';

// Row 53 S9: the rea readiness probe on the MCP connection row (the one-line
// summary, the Details rows and the Check readiness action).

const assert = require('node:assert/strict');
const test = require('node:test');

const { flush, discovery, pendingServer, harness, openDrawer } = require('./helpers/renderer-mcp-servers-harness');

const healthyReadiness = { healthy: true, tools: 170, prompts: 6,
  checkedAt: '2026-10-14T14:02:00.000Z', reason: '' };

test('rea readiness appears in the summary and Details with an explicit check action', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer({ name: 'rea', readiness: healthyReadiness })] }) });
  h.controller.bind();
  await flush();
  const summary = h.extensionsCard.querySelector('[data-mcp-server-row="rea"] small');
  assert.match(summary.textContent, /170 tools · 6 prompts/);
  assert.match(summary.textContent, /ready, checked/);
  const drawer = openDrawer(h, 'details');
  assert.equal(drawer.querySelector('[data-mcp-servers-action="check-readiness"]').textContent.trim(), 'Check readiness');
  const rows = Array.from(drawer.querySelectorAll('dl > div'));
  assert.equal(rows.find((row) => row.querySelector('dt').textContent === 'Prompts').querySelector('dd').textContent, '6');
  assert.match(rows.find((row) => row.querySelector('dt').textContent === 'Readiness').textContent, /Ready · checked/);
  h.setState(discovery({ servers: [pendingServer({ name: 'rea', readiness: {
    ...healthyReadiness, healthy: false, reason: 'exit_nonzero' } })] }));
  await h.controller.refresh();
  assert.match(h.extensionsCard.querySelector('[data-mcp-server-row="rea"] small').textContent,
    /needs attention: the health check failed/);
});

test('absent and null readiness produce byte-identical rows and other names have no check action', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  const before = h.extensionsCard.querySelector('[data-mcp-server-row="weather"]').innerHTML;
  assert.equal(h.extensionsCard.querySelector('[data-mcp-server-row="weather"] small').textContent,
    'local · 0 tools · off · turn on unavailable until its tools are reviewed');
  h.setState(discovery({ servers: [pendingServer({ readiness: null })] }));
  await h.controller.refresh();
  assert.equal(h.extensionsCard.querySelector('[data-mcp-server-row="weather"]').innerHTML, before);
  const drawer = openDrawer(h, 'details');
  assert.equal(drawer.querySelector('[data-mcp-servers-action="check-readiness"]'), null);
  assert.equal(Array.from(drawer.querySelectorAll('dt')).some((dt) => dt.textContent === 'Readiness'), false);
});

test('Check readiness refreshes the rea row and keeps Details open', async (t) => {
  let finish;
  const calls = [];
  const h = harness(t, { initialState: discovery({ servers: [pendingServer({ name: 'rea' })] }), bridge: {
    checkReadiness: (payload) => { calls.push(payload); return new Promise((resolve) => { finish = resolve; }); },
  } });
  h.controller.bind();
  await flush();
  const drawer = openDrawer(h, 'details');
  drawer.querySelector('[data-mcp-servers-action="check-readiness"]').click();
  assert.equal(drawer.querySelector('[data-mcp-servers-action="check-readiness"]').disabled, true);
  h.setState(discovery({ servers: [pendingServer({ name: 'rea', readiness: healthyReadiness })] }));
  finish({ ok: true, readiness: healthyReadiness });
  await flush();
  assert.deepEqual(calls, [{ name: 'rea' }]);
  assert.equal(h.dom.window.document.getElementById('mcpServerDetailsDrawer').hidden, false);
  assert.equal(h.controller._test.getView().drawerState.kind, 'details');
  assert.match(h.dom.window.document.getElementById('mcpServerDetailsDrawer').textContent, /Ready · checked/);
});
