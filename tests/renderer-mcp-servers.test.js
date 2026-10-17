'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { resolveMcpServerBadge, mapMcpFailureMessage } = require('../renderer/shell/renderer-mcp-servers');
const { flush, discovery, pendingServer, harness, REA_COMMAND, openDrawer, saveEditor,
  drawerSwitch } = require('./helpers/renderer-mcp-servers-harness');

test('prompt counts appear once in summary and Details, including zero without readiness', async t => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer({ name: 'rea', promptsCount: 2,
    readiness: { healthy: true, tools: 3, prompts: 99, checkedAt: '2026-10-14T12:00:00Z' } })] }) });
  h.controller.bind(); await flush();
  const row = h.extensionsCard.querySelector('[data-mcp-server-row]');
  assert.match(row.textContent, /3 tools.*2 prompts/);
  assert.equal(row.textContent.includes('99 prompts'), false);
  let drawer = openDrawer(h, 'details');
  let labels = [...drawer.querySelectorAll('dt')].filter(dt => dt.textContent === 'Prompts');
  assert.equal(labels.length, 1); assert.equal(labels[0].nextElementSibling.textContent, '2');
  h.setState(discovery({ servers: [pendingServer({ name: 'rea' })] })); await h.controller.refresh();
  assert.equal(h.extensionsCard.querySelector('[data-mcp-server-row]').textContent.includes('prompts'), false);
  drawer = openDrawer(h, 'details');
  labels = [...drawer.querySelectorAll('dt')].filter(dt => dt.textContent === 'Prompts');
  assert.equal(labels.length, 1); assert.equal(labels[0].nextElementSibling.textContent, '0');
});

test('Test review renders discovered prompts with required argument stars and escaped names', async t => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }), bridge: {
    testServer: async () => ({ ok: true, tools: [], tool_count: 0, tools_digest: 'b'.repeat(64),
      prompts: [{ name: '<prompt>', arguments: [{ name: 'feature', required: true }, { name: 'optional' }] },
        { name: 'plain', arguments: [] }] }),
  } });
  h.controller.bind(); await flush();
  const drawer = openDrawer(h, 'details');
  drawer.querySelector('[data-mcp-servers-action="test"]').click(); await flush();
  assert.match(drawer.textContent, /2 discovered prompt\(s\)/);
  assert.ok([...drawer.querySelectorAll('code')].some(code => code.textContent === '<prompt>(feature*, optional)'));
  assert.ok([...drawer.querySelectorAll('code')].some(code => code.textContent === 'plain()'));
  assert.equal(drawer.querySelector('prompt'), null);
});

test('flat MCP rows mount in their stable host with only drawer action and switch', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  const group = h.dom.window.document.getElementById('mcpServersGroup');
  const row = group.querySelector('[data-mcp-server-row="weather"]');
  assert.ok(group.classList.contains('settings-group--wide'));
  assert.equal(group.parentElement.id, 'mcpServersHost');
  assert.equal(group.closest('.settings-card'), h.extensionsCard);
  assert.equal(h.toolsCard.querySelector('#mcpServersGroup'), null);
  assert.ok(row.classList.contains('settings-field-row'));
  assert.deepEqual(Array.from(row.querySelectorAll('button')).map((button) => button.textContent.trim()), ['Review', '']);
  const toggle = row.querySelector('[role="switch"]');
  assert.equal(toggle.disabled, true);
  assert.match(row.textContent, /turn on unavailable until its tools are reviewed/);
});

test('read-only future state explains preservation and disables creation', async (t) => {
  const h = harness(t, { initialState: discovery({ schemaVersion: 2, readOnly: true,
    remediationReason: 'future_schema' }) });
  h.controller.bind();
  await flush();
  assert.match(h.extensionsCard.textContent, /preserved unchanged/);
  assert.match(h.extensionsCard.textContent, /future_schema/);
  assert.equal(h.extensionsCard.querySelector('[data-mcp-servers-action="add"]').disabled, true);
});

test('create editor stays outside the list and preserves typed values through refresh', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  const trigger = h.extensionsCard.querySelector('[data-mcp-servers-action="add"]');
  trigger.focus();
  trigger.click();
  const drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  assert.equal(drawer.hidden, false);
  assert.equal(h.extensionsCard.querySelector('[data-mcp-editor]'), null);
  h.dom.window.document.getElementById('mcpServerName').value = 'docs';
  h.dom.window.document.getElementById('mcpServerTarget').value = 'node';
  h.dom.window.document.getElementById('mcpServerArgs').value = 'server.js\n--safe';
  await h.controller.refresh();
  assert.equal(h.dom.window.document.getElementById('mcpServerName').value, 'docs');
  assert.equal(h.dom.window.document.getElementById('mcpServerArgs').value, 'server.js\n--safe');
  drawer.querySelector('[data-mcp-servers-action="save-editor"]').click();
  await flush();
  assert.deepEqual(h.calls[0], ['create', { server: { name: 'docs', transport: 'stdio',
    command: 'node', args: ['server.js', '--safe'] } }]);
});

test('Edit stays in the drawer and preserves bounded stdio arguments', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="edit"]').click();
  assert.equal(h.dom.window.document.getElementById('mcpServerArgs').value, '--stdio');
  h.dom.window.document.getElementById('mcpServerTarget').value = 'weather-mcp-v2';
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-editor"]').click();
  await flush();
  assert.deepEqual(h.calls[0], ['update', { name: 'weather', server: { name: 'weather', transport: 'stdio',
    command: 'weather-mcp-v2', args: ['--stdio'] } }]);
});

test('pending Review opens one drawer for inspection and approval', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  const trigger = h.extensionsCard.querySelector('[data-mcp-servers-action="details"]');
  trigger.focus();
  trigger.click();
  let drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  assert.equal(drawer.hidden, false);
  assert.match(drawer.textContent, /Trust review/);
  assert.equal(drawer.querySelector('[data-mcp-servers-action="approve"]').disabled, true);
  drawer.querySelector('[data-mcp-servers-action="test"]').click();
  await flush();
  assert.match(h.confirms[0].title, /Inspect MCP connection/);
  assert.match(h.confirms[0].message, /weather-mcp --stdio/);
  assert.deepEqual(h.calls.slice(0, 2), [['test', { name: 'weather' }],
    ['test', { name: 'weather', confirmed: true }]]);
  drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  assert.match(drawer.textContent, /forecast/);
  assert.match(drawer.textContent, /Get a forecast/);
  const approve = drawer.querySelector('[data-mcp-servers-action="approve"]');
  assert.equal(approve.disabled, false);
  approve.click();
  await flush();
  assert.deepEqual(h.calls[2], ['approve', { name: 'weather' }]);
});

test('in-progress drawer actions are visibly disabled and restored after failure', async (t) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const approved = pendingServer({ enabled: true, trust: { status: 'approved' } });
  const h = harness(t, { initialState: discovery({ servers: [approved] }), bridge: {
    testServer: () => pending,
  } });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="details"]').click();
  const drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  drawer.querySelector('[data-mcp-servers-action="test"]').click();
  assert.equal(drawer.querySelector('.inv-drawer-panel').getAttribute('aria-busy'), 'true');
  assert.match(drawer.querySelector('[data-mcp-drawer-operation-status]').textContent, /Working/);
  assert.equal(drawer.querySelector('[data-mcp-servers-action="remove"]').disabled, true);
  assert.equal(drawer.querySelector('.mcp-approval-row [data-inv-toggle]').disabled, true);
  assert.match(h.extensionsCard.querySelector('[data-mcp-server-row]').textContent, /operation in progress/);
  finish({ ok: false, reason: 'unavailable' });
  await flush();
  assert.equal(drawer.querySelector('[data-mcp-drawer-operation-status]'), null);
  assert.equal(drawer.querySelector('[data-mcp-servers-action="remove"]').disabled, false);
  assert.equal(h.toasts.at(-1).message, 'The MCP operation could not be completed.');
  assert.deepEqual(h.logs.at(-1), ['WARN', 'mcp_settings.operation_failed', { name: 'testServer' }]);
});

test('structured editor failures retain typed values and surface bounded diagnostics', async (t) => {
  const h = harness(t, { bridge: { createServer: async () => ({ ok: false, reason: 'invalid' }) } });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="add"]').click();
  h.dom.window.document.getElementById('mcpServerName').value = 'docs';
  h.dom.window.document.getElementById('mcpServerTarget').value = 'node';
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-editor"]').click();
  await flush();
  assert.equal(h.dom.window.document.getElementById('mcpServerName').value, 'docs');
  assert.equal(h.dom.window.document.getElementById('mcpServerTarget').value, 'node');
  assert.equal(h.toasts.at(-1).message, 'The MCP operation could not be completed.');
  assert.deepEqual(h.logs.at(-1), ['WARN', 'mcp_settings.operation_failed', { name: 'createServer' }]);
});

test('approved switch uses inv-toggle-change and removal uses shared danger confirmation', async (t) => {
  const approved = pendingServer({ trust: { status: 'approved', configuration_digest: 'a'.repeat(64),
    advertised_tools_digest: 'b'.repeat(64), reviewed_at: '2026-08-17T00:00:00Z' } });
  const h = harness(t, { initialState: discovery({ servers: [approved] }) });
  h.controller.bind();
  await flush();
  const toggle = h.extensionsCard.querySelector('[role="switch"]');
  assert.equal(toggle.disabled, false);
  toggle.focus();
  toggle.click();
  await flush();
  assert.deepEqual(h.calls[0], ['toggle', { name: 'weather', enabled: true }]);
  assert.equal(h.dom.window.document.activeElement.dataset.invToggle, toggle.dataset.invToggle);
  h.extensionsCard.querySelector('[data-mcp-servers-action="details"]').click();
  const drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  assert.match(drawer.textContent, /Approved tool surface/);
  assert.match(drawer.textContent, new RegExp('a{64}'));
  assert.match(drawer.textContent, new RegExp('b{64}'));
  assert.match(drawer.textContent, /2026-08-17/);
  drawer.querySelector('[data-mcp-servers-action="remove"]').click();
  await flush();
  assert.deepEqual(h.calls[1], ['remove', { name: 'weather' }]);
  assert.match(h.confirms[0].title, /Remove MCP connection/);
  assert.equal(h.dom.window.document.getElementById('mcpServerDetailsDrawer').hidden, true);
});

test('remote credentials use the safeStorage bridge and never render the secret', async (t) => {
  const saved = [];
  const remote = pendingServer({ name: 'remote', transport: 'sse', command: '', args: [],
    url: 'https://mcp.example.test/sse', auth: { kind: 'bearer', secretRef: null } });
  const h = harness(t, { initialState: discovery({ servers: [remote] }), authBridge: {
    getStatus: async () => ({ loaded: true, store: { status: 'ready' },
      servers: [{ name: 'remote', hasAuthBlock: true, configured: false }] }),
    set: async (payload) => { saved.push(payload); return { ok: true, loaded: true,
      store: { status: 'ready' }, servers: [{ name: 'remote', configured: true }] }; },
  } });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="configure-credential"]').click();
  h.dom.window.document.getElementById('mcpServerCredential').value = 'secret-value';
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-credential"]').click();
  await flush();
  assert.deepEqual(saved, [{ serverName: 'remote', value: 'secret-value' }]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.dom.window.document.body.innerHTML.includes('secret-value'), false);
});

test('credential bridge failures keep raw errors out of UI diagnostics', async (t) => {
  const remote = pendingServer({ name: 'remote', transport: 'sse', command: '', args: [],
    url: 'https://mcp.example.test/sse', auth: { kind: 'bearer', secretRef: null } });
  const h = harness(t, { initialState: discovery({ servers: [remote] }), authBridge: {
    getStatus: async () => ({ loaded: true, store: { status: 'ready' },
      servers: [{ name: 'remote', hasAuthBlock: true, configured: false }] }),
    set: async () => { throw new Error('secret-value at C:\\private'); },
  } });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="configure-credential"]').click();
  h.dom.window.document.getElementById('mcpServerCredential').value = 'secret-value';
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-credential"]').click();
  await flush();
  assert.equal(h.toasts.at(-1).message, 'The credential operation failed.');
  assert.deepEqual(h.logs.at(-1), ['WARN', 'mcp_settings.auth_bridge_call_failed', { name: 'set' }]);
  assert.equal(JSON.stringify([h.toasts, h.logs]).includes('secret-value'), false);
  assert.equal(JSON.stringify([h.toasts, h.logs]).includes('C:\\private'), false);
});

test('drawer close restores the current row focus after an operation rerenders the list', async (t) => {
  const approved = pendingServer({ trust: { status: 'approved' }, enabled: true });
  const h = harness(t, { initialState: discovery({ servers: [approved] }), bridge: {
    testServer: async () => ({ ok: false, reason: 'unavailable' }),
  } });
  h.controller.bind();
  await flush();
  const trigger = h.extensionsCard.querySelector('[data-mcp-servers-action="details"]');
  trigger.focus();
  trigger.click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="test"]').click();
  await flush();
  const currentTrigger = h.extensionsCard.querySelector('[data-mcp-servers-action="details"]');
  assert.notEqual(currentTrigger, trigger);
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-drawer-close]').click();
  assert.equal(h.dom.window.document.activeElement, currentTrigger);
  h.controller.dispose();
  assert.equal(h.dom.window.document.getElementById('mcpServerDetailsDrawer'), null);
});

test('closing a drawer during an operation prevents async completion from reopening it', async (t) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const approved = pendingServer({ trust: { status: 'approved' }, enabled: true });
  const h = harness(t, { initialState: discovery({ servers: [approved] }), bridge: {
    testServer: () => pending,
  } });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="test"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-drawer-close]').click();
  finish({ ok: true, tool_count: 1, tools_digest: 'b'.repeat(64), tools: [] });
  await flush();
  assert.equal(h.dom.window.document.getElementById('mcpServerDetailsDrawer').hidden, true);
});

test('badge and failure mapping make trust state primary', () => {
  assert.deepEqual(resolveMcpServerBadge({ enabled: false, trustStatus: 'pending' }),
    { state: 'muted', text: 'Off' });
  assert.deepEqual(resolveMcpServerBadge({ enabled: true, trustStatus: 'pending', status: 'running' }),
    { state: 'warn', text: 'Review required' });
  assert.deepEqual(resolveMcpServerBadge({ enabled: true, trustStatus: 'approved', status: 'running' }),
    { state: 'success', text: 'Running' });
  assert.match(mapMcpFailureMessage('blocked: PermissionError'), /private or local/);
  assert.equal(mapMcpFailureMessage('custom failure'), 'custom failure');
});

test('MCP controller does not use native window confirmation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shell',
    'renderer-mcp-servers.js'), 'utf8');
  assert.doesNotMatch(source, /windowRef\.confirm|window\.confirm/);
  assert.match(source, /confirmDanger/);
});

test('authenticated editor preserves the opaque credential reference', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer({
    transport: 'sse', url: 'https://example.test/sse',
    auth: { kind: 'bearer', secretRef: 'mcp:weather' },
  })] }) });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="edit"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-editor"]').click();
  await flush();
  assert.equal(h.calls[0][1].server.auth.secret_ref, 'mcp:weather');
});

test('builtin row is labeled and has no management actions', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer({
    name: 'jenny_local_tools', builtin: true, enabled: true, status: 'running',
  })] }) });
  h.controller.bind();
  await flush();
  const row = h.extensionsCard.querySelector('[data-mcp-server-row="jenny_local_tools"]');
  assert.match(row.textContent, /Built-in/);
  assert.equal(row.querySelectorAll('button, [role="switch"]').length, 0);
  assert.match(h.extensionsCard.textContent, /No standalone MCP connections/);
});

test('the editor shows only the fields its transport and authentication use', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="add"]').click();
  const doc = h.dom.window.document;
  const visible = (id) => !doc.getElementById(id).closest('[hidden]');
  const choose = (id, value) => {
    doc.getElementById(id).value = value;
    doc.getElementById(id).dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  };
  assert.deepEqual(['mcpServerArgs', 'mcpServerAuthKind', 'mcpServerTokenUrl'].map(visible), [true, false, false],
    'a local command has arguments and no authentication');
  choose('mcpServerTransport', 'sse');
  assert.deepEqual(['mcpServerArgs', 'mcpServerAuthKind', 'mcpServerTokenUrl', 'mcpServerScope'].map(visible),
    [false, true, false, false], 'Authentication None hides the OAuth fields');
  assert.equal(doc.querySelector('label[for="mcpServerTarget"] .inv-text-field-label').textContent, 'HTTPS URL');
  choose('mcpServerAuthKind', 'oauth_client_credentials');
  assert.deepEqual(['mcpServerTokenUrl', 'mcpServerClientId', 'mcpServerScope'].map(visible), [true, true, true]);
  choose('mcpServerAuthKind', 'bearer');
  assert.equal(visible('mcpServerTokenUrl'), false);
});

test('editor selecting no authentication explicitly clears the auth block', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer({
    transport: 'sse', url: 'https://example.test/sse',
    auth: { kind: 'bearer', secretRef: 'mcp:weather' },
  })] }) });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="edit"]').click();
  h.dom.window.document.getElementById('mcpServerAuthKind').value = 'none';
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-editor"]').click();
  await flush();
  assert.equal(h.calls[0][1].server.auth, null);
});

test('pending runtime application tells the user the prior configuration may be active', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }), bridge: {
    updateServer: async () => ({ ok: false, saved: true, runtimeApplied: false,
      error: { code: 'CMP-MCP-0004', message: 'server detail must not be exposed' } }),
  } });
  h.controller.bind();
  await flush();
  h.extensionsCard.querySelector('[data-mcp-servers-action="details"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="edit"]').click();
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-editor"]').click();
  await flush();
  assert.match(h.toasts[0].message, /previous setup may still be running/);
  assert.equal(h.toasts[0].message.includes('server detail'), false);
  const editor = h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="save-editor"]');
  assert.equal(editor, null, 'a saved edit leaves the editor even while application is pending');
});

test('Windows Add drawer offers the rea preset and creates the row with its hidden limits', async (t) => {
  const h = harness(t, { platform: 'Win32' });
  h.controller.bind();
  await flush();
  const drawer = openDrawer(h, 'add');
  const doc = h.dom.window.document;
  const presets = drawer.querySelectorAll('[data-mcp-servers-action="preset"]');
  assert.equal(presets.length, 1);
  assert.equal(presets[0].textContent.trim(), 'Reverse engineering (rea)');
  assert.equal(drawer.querySelector('[data-mcp-preset-note]'), null);
  presets[0].click();
  assert.equal(doc.getElementById('mcpServerName').value, 'rea');
  assert.equal(doc.getElementById('mcpServerTarget').value, REA_COMMAND);
  assert.equal(doc.getElementById('mcpServerArgs').value, '-y\nrea-agents@6.4.0\nmcp');
  assert.match(drawer.querySelector('[data-mcp-preset-note]').textContent, /Node\.js 22\.19, 24\.11 or newer/);
  assert.equal(doc.activeElement.id, 'mcpServerName');
  saveEditor(h);
  await flush();
  assert.deepEqual(h.calls[0], ['create', { server: { name: 'rea', transport: 'stdio', command: REA_COMMAND,
    args: ['-y', 'rea-agents@6.4.0', 'mcp'], memory_limit_mb: 2048, max_processes: 16,
    inspect_timeout_seconds: 120, request_timeout_seconds: 300 } }]);
});

test('the preset line is Windows-only, Add-only, and a blank Add carries no hidden limits', async (t) => {
  for (const platform of ['Linux x86_64', undefined]) {
    const other = harness(t, { platform });
    other.controller.bind();
    await flush();
    assert.equal(openDrawer(other, 'add').querySelector('.mcp-presets'), null, String(platform));
    other.controller.dispose();
  }
  const h = harness(t, { platform: 'Win32', initialState: discovery({ servers: [pendingServer()] }) });
  h.controller.bind();
  await flush();
  openDrawer(h, 'details').querySelector('[data-mcp-servers-action="edit"]').click();
  assert.equal(h.dom.window.document.querySelector('#mcpServerDetailsDrawer .mcp-presets'), null);
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="cancel-drawer"]').click();
  assert.ok(openDrawer(h, 'add').querySelector('.mcp-presets'));
  h.dom.window.document.getElementById('mcpServerName').value = 'docs';
  h.dom.window.document.getElementById('mcpServerTarget').value = 'node';
  saveEditor(h);
  await flush();
  assert.deepEqual(h.calls[0], ['create', { server: { name: 'docs', transport: 'stdio', command: 'node', args: [] } }]);
});

test('review tags read-only claims and the switch sends a pending row back to review', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }), bridge: {
    testServer: async (payload) => (payload.confirmed ? { ok: true, tool_count: 2, tools_digest: 'b'.repeat(64),
      tools: [{ name: 'forecast', description: 'Get a forecast', schema_digest: 'c'.repeat(64), read_only_claim: true },
        { name: 'alert', description: 'Send an alert', schema_digest: 'd'.repeat(64) }] }
      : { ok: false, confirmation_required: true, command: 'weather-mcp', args: ['--stdio'] }),
  } });
  h.controller.bind();
  await flush();
  openDrawer(h, 'details').querySelector('[data-mcp-servers-action="test"]').click();
  await flush();
  const drawer = h.dom.window.document.getElementById('mcpServerDetailsDrawer');
  assert.match(drawer.textContent, /1 of 2 tools claim to be read-only/);
  const claims = drawer.querySelectorAll('.mcp-tool-claim');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].textContent, 'read-only');
  assert.equal(claims[0].parentElement.querySelector('strong').textContent, 'forecast');
  assert.equal(drawer.querySelector('.mcp-approval-row').closest('section').querySelector('h3').textContent, 'Approval');
  const toggle = drawerSwitch(h);
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  toggle.click();
  await flush();
  assert.deepEqual(h.calls.find((call) => call[0] === 'update'), ['update', { name: 'weather', server: {
    name: 'weather', transport: 'stdio', command: 'weather-mcp', args: ['--stdio'], read_only_auto_allow: true } }]);
  assert.match(h.dom.window.document.getElementById('mcpServerDetailsDrawer').textContent, /Run an inspection/);
});

test('approved remote rows show the stored switch and flip it with the opaque credential reference', async (t) => {
  const remote = pendingServer({ name: 'remote', transport: 'sse', command: '', args: [], enabled: true,
    url: 'https://mcp.example.test/sse', readOnlyAutoAllow: true, trust: { status: 'approved' },
    auth: { kind: 'bearer', secretRef: 'mcp:remote', token_url: '', client_id: '', scope: '' } });
  const h = harness(t, { initialState: discovery({ servers: [remote] }) });
  h.controller.bind();
  await flush();
  openDrawer(h, 'details');
  assert.equal(drawerSwitch(h).getAttribute('aria-checked'), 'true');
  drawerSwitch(h).click();
  await flush();
  assert.deepEqual(h.calls[0], ['update', { name: 'remote', server: { name: 'remote', transport: 'sse',
    url: 'https://mcp.example.test/sse', auth: { kind: 'bearer', secret_ref: 'mcp:remote' },
    read_only_auto_allow: false } }]);
});

test('a failed switch flip redraws the stored position and reports the failure', async (t) => {
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }), bridge: {
    updateServer: async () => ({ ok: false, reason: 'x' }) } });
  h.controller.bind();
  await flush();
  openDrawer(h, 'details');
  drawerSwitch(h).click();
  await flush();
  assert.equal(drawerSwitch(h).getAttribute('aria-checked'), 'false');
  assert.equal(h.toasts.at(-1).message, 'The MCP operation could not be completed.');
});

test('the preset button is disabled while an operation runs', async (t) => {
  let finish;
  const h = harness(t, { platform: 'Win32', bridge: {
    createServer: () => new Promise((resolve) => { finish = resolve; }) } });
  h.controller.bind();
  await flush();
  openDrawer(h, 'add').querySelector('[data-mcp-servers-action="preset"]').click();
  saveEditor(h);
  const preset = h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="preset"]');
  assert.equal(preset.disabled, true);
  finish({ ok: false, reason: 'x' });
  await flush();
});

test('moving a preset row to SSE hides the preset note and drops the hidden limits', async (t) => {
  const h = harness(t, { platform: 'Win32' });
  h.controller.bind();
  await flush();
  const doc = h.dom.window.document;
  openDrawer(h, 'add').querySelector('[data-mcp-servers-action="preset"]').click();
  const transport = doc.getElementById('mcpServerTransport');
  transport.value = 'sse';
  transport.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  assert.equal(doc.querySelector('[data-mcp-preset-note]').hidden, true);
  doc.getElementById('mcpServerTarget').value = 'https://mcp.example.test/sse';
  saveEditor(h);
  await flush();
  assert.deepEqual(h.calls[0], ['create', { server: { name: 'rea', transport: 'sse',
    url: 'https://mcp.example.test/sse', auth: null } }]);
  openDrawer(h, 'add').querySelector('[data-mcp-servers-action="preset"]').click();
  assert.equal(doc.querySelector('[data-mcp-preset-note]').hidden, false);
});

test('an OAuth remote row keeps its credential reference and OAuth fields through a switch flip and an edit', async (t) => {
  const remote = pendingServer({ name: 'remote', transport: 'sse', command: '', args: [],
    url: 'https://mcp.example.test/sse', trust: { status: 'approved' },
    auth: { kind: 'oauth_client_credentials', secretRef: 'mcp:remote', token_url: 'https://id.example.test/token',
      client_id: 'jenny', scope: 'read' } });
  const h = harness(t, { initialState: discovery({ servers: [remote] }) });
  h.controller.bind();
  await flush();
  const row = (scope, extra) => ['update', { name: 'remote', server: { name: 'remote', transport: 'sse',
    url: 'https://mcp.example.test/sse', auth: { kind: 'oauth_client_credentials', secret_ref: 'mcp:remote',
      token_url: 'https://id.example.test/token', client_id: 'jenny', scope }, ...extra } }];
  openDrawer(h, 'details');
  drawerSwitch(h).click();
  await flush();
  assert.deepEqual(h.calls[0], row('read', { read_only_auto_allow: true }));
  h.dom.window.document.querySelector('#mcpServerDetailsDrawer [data-mcp-servers-action="edit"]').click();
  h.dom.window.document.getElementById('mcpServerScope').value = ' read write ';
  saveEditor(h);
  await flush();
  assert.deepEqual(h.calls[1], row('read write', {}));
});

test('the switch keeps keyboard focus through a saved and a failed flip', async (t) => {
  let outcome = { ok: true };
  const h = harness(t, { initialState: discovery({ servers: [pendingServer()] }), bridge: {
    updateServer: async () => outcome } });
  h.controller.bind();
  await flush();
  openDrawer(h, 'details');
  const doc = h.dom.window.document;
  for (outcome of [{ ok: true }, { ok: false, reason: 'x' }]) {
    const toggle = drawerSwitch(h);
    toggle.focus();
    toggle.click();
    await flush();
    assert.notEqual(drawerSwitch(h), toggle, 'the drawer was redrawn');
    assert.equal(doc.activeElement, drawerSwitch(h));
  }
});
