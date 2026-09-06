(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../inventory/drawer'));
    return;
  }
  root.rendererMcpServers = factory(root, root.inventoryDrawer);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, drawerModule) {
  'use strict';
  var GROUP_ID = 'mcpServersGroup';
  var HOST_ID = 'mcpServersHost';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }
  function resolveMcpServerBadge(signals) {
    var source = signals || {};
    if (source.enabled === false) return { state: 'muted', text: 'Off' };
    if (source.trustStatus !== 'approved') return { state: 'warn', text: 'Review required' };
    var status = String(source.status || 'configured').toLowerCase();
    if (status === 'running') return { state: 'success', text: 'Running' };
    if (status === 'failed') return { state: 'error', text: 'Failed' };
    if (status === 'cooldown') return { state: 'warn', text: 'Cooling down' };
    return { state: 'info', text: 'Approved' };
  }
  function resolveMcpServerStatusDot(signals) {
    var badge = resolveMcpServerBadge(signals);
    return badge.state === 'success' ? 'ok' : badge.state === 'error' ? 'error'
      : badge.state === 'warn' ? 'warn' : 'muted';
  }
  function mapMcpFailureMessage(message) {
    var text = String(message || '').trim();
    if (/:\s*PermissionError\s*$/.test(text)) return 'URL points to a private or local address, which is blocked.';
    if (/:\s*ValueError\s*$/.test(text)) return 'URL is invalid. Use http or https without embedded credentials.';
    return text;
  }
  function normalizeDiscoveryServer(value) {
    var row = value && typeof value === 'object' ? value : {};
    var trust = row.trust && typeof row.trust === 'object' ? row.trust : {};
    return { name: String(row.name || ''), transport: String(row.transport || 'stdio'),
      status: String(row.status || 'configured'), toolsCount: Number(row.toolsCount) || 0,
      command: String(row.command || ''), url: String(row.url || ''), enabled: row.enabled === true,
      args: Array.isArray(row.args) ? row.args.map(function (item) { return String(item); }) : [],
      trustStatus: String(trust.status || 'pending'), reviewedAt: String(trust.reviewed_at || ''),
      configurationDigest: String(trust.configuration_digest || ''),
      toolsDigest: String(trust.advertised_tools_digest || ''), failure: row.failure || null,
      auth: row.auth || null };
  }
  function normalizeDiscoveryState(payload) {
    var source = payload && typeof payload === 'object' ? payload : {};
    return { loaded: true, schemaVersion: Number(source.schemaVersion) || 1,
      readOnly: source.readOnly === true, remediationReason: String(source.remediationReason || ''),
      migrated: source.migrated === true, sseEnabled: source.sseEnabled === true,
      servers: Array.isArray(source.servers) ? source.servers.map(normalizeDiscoveryServer) : [] };
  }
  function normalizeAuthState(payload) {
    var source = payload && typeof payload === 'object' ? payload : {};
    return { loaded: source.loaded !== false, store: source.store || { status: 'unavailable' },
      servers: Array.isArray(source.servers) ? source.servers : [] };
  }
  function buildServerViewModel(server) {
    return { server: server, badge: resolveMcpServerBadge(server), dot: resolveMcpServerStatusDot(server),
      muted: server.enabled === false, authHint: server.auth ? 'authentication configured' : '' };
  }
  function toggleId(name) {
    var encoded = '';
    for (var index = 0; index < name.length; index += 1) encoded += name.charCodeAt(index).toString(16) + '_';
    return 'mcpServerToggle_' + encoded;
  }

  function createMcpServersController(deps) {
    var options = deps || {};
    var state = options.state || {};
    var windowRef = options.windowRef || root;
    var documentRef = options.documentRef || windowRef.document;
    var actionButton = root.inventoryActionButton;
    var textField = root.inventoryTextField;
    var selectField = root.inventorySelectField;
    var discovery = normalizeDiscoveryState({});
    var auth = normalizeAuthState({});
    var busy = '';
    var inspections = new Map();
    var drawerState = null;
    var disposed = false;
    var loadPromise = null;
    var pendingFocusIdentity = null;
    var confirmDialog = null;
    var drawer = drawerModule.createDrawer({ documentRef: documentRef,
      overlayManager: options.overlayManager, id: 'mcpServerDetailsDrawer' });
    function bridge() { return windowRef.jennyShell?.mcpDiscovery || null; }
    function authBridge() { return windowRef.jennyShell?.mcpAuth || null; }
    function enabled() { return state.features?.featureFlags?.mcp_management_ui === true; }
    function host() { return documentRef?.getElementById(HOST_ID) || null; }
    function serverByName(name) { return discovery.servers.find(function (row) { return row.name === name; }) || null; }
    function reportBridgeFailure(event, name, message) {
      options.showToastMessage?.(message, { tone: 'warning' });
      options.appendClientLog?.('WARN', event, { name: name });
    }

    function ensureConfirmDialog() {
      if (confirmDialog) return confirmDialog;
      var factory = root.rendererIdeConfirmDialog?.createIdeConfirmDialog;
      var overlay = root.inventoryHelpOverlay?.createHelpOverlay;
      if (!factory || !overlay) return null;
      confirmDialog = factory({ document: documentRef, actionButton: actionButton,
        helpOverlayFactory: overlay, hostId: 'mcpServersConfirmOverlay' });
      return confirmDialog;
    }
    async function confirmDanger(config) {
      if (typeof options.confirmDanger === 'function') return options.confirmDanger(config);
      try { return await ensureConfirmDialog()?.confirm?.({ ...config, variant: 'danger' }) === true; }
      catch (_error) { return false; }
    }
    function focusIdentityFor(target) {
      if (target?.dataset?.invToggle) return { kind: 'toggle', id: target.dataset.invToggle };
      if (target?.dataset?.mcpServersAction) return { kind: 'action', action: target.dataset.mcpServersAction,
        name: target.dataset.mcpServerName || '' };
      return null;
    }
    function captureFocus() {
      var active = documentRef?.activeElement;
      return host()?.contains(active) ? focusIdentityFor(active) : null;
    }
    function resolveFocusTarget(identity) {
      if (!identity) return null;
      return identity.kind === 'toggle'
        ? Array.from(documentRef.querySelectorAll('[data-inv-toggle]')).find(function (node) {
          return node.dataset.invToggle === identity.id;
        })
        : Array.from(documentRef.querySelectorAll('[data-mcp-servers-action]')).find(function (node) {
          return node.dataset.mcpServersAction === identity.action
            && (node.dataset.mcpServerName || '') === identity.name;
        });
    }
    function restoreFocus(identity) {
      resolveFocusTarget(identity)?.focus?.();
    }
    function focusRestoreHandle(identity) {
      if (!identity) return null;
      return { get isConnected() { return Boolean(resolveFocusTarget(identity)); },
        focus: function () { resolveFocusTarget(identity)?.focus?.(); } };
    }
    function drawerActiveFor(name, kind) {
      return !disposed && enabled() && drawer.isOpen() && drawerState
        && (name === undefined || drawerState.name === name)
        && (kind === undefined || drawerState.kind === kind);
    }
    function setDrawerBusy(active) {
      var panel = documentRef?.querySelector('#mcpServerDetailsDrawer .inv-drawer-panel');
      if (!panel) return;
      panel.setAttribute('aria-busy', String(Boolean(active)));
      panel.querySelectorAll('button:not([data-drawer-close]),input,select,textarea').forEach(function (control) {
        if (active) {
          control.dataset.mcpBusyWasDisabled = String(Boolean(control.disabled));
          control.disabled = true;
        } else if (control.dataset.mcpBusyWasDisabled !== undefined) {
          control.disabled = control.dataset.mcpBusyWasDisabled === 'true';
          delete control.dataset.mcpBusyWasDisabled;
        }
      });
      var status = panel.querySelector('[data-mcp-drawer-operation-status]');
      if (active && !status) panel.querySelector('.inv-drawer-body')?.insertAdjacentHTML('afterbegin',
        '<p class="settings-note" role="status" data-mcp-drawer-operation-status>Working…</p>');
      else if (!active) status?.remove();
    }
    function editorMarkup(name, server) {
      if (!textField || !selectField) return '<div class="settings-note">Connection editor is unavailable.</div>';
      var row = server || {};
      var authKind = String(row.auth?.kind || 'none');
      return '<div class="mcp-server-editor" data-mcp-editor data-mcp-original-name="' + escapeHtml(name) + '">'
        + textField({ id: 'mcpServerName', label: 'Connection name', value: row.name || '', maxLength: 64 })
        + selectField({ id: 'mcpServerTransport', label: 'Transport', value: row.transport || 'stdio',
          options: [{ value: 'stdio', label: 'Local stdio' }, { value: 'sse', label: 'Remote SSE' }] })
        + textField({ id: 'mcpServerTarget', label: row.transport === 'sse' ? 'HTTPS URL' : 'Command',
          value: row.transport === 'sse' ? row.url || '' : row.command || '', maxLength: 2048 })
        + textField({ id: 'mcpServerArgs', label: 'Arguments (one per line)',
          value: Array.isArray(row.args) ? row.args.join('\n') : '', maxLength: 4096, multiline: true })
        + selectField({ id: 'mcpServerAuthKind', label: 'Authentication', value: authKind,
          options: [{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' },
            { value: 'oauth_client_credentials', label: 'OAuth client credentials' }] })
        + textField({ id: 'mcpServerTokenUrl', label: 'OAuth token URL', value: row.auth?.token_url || '', maxLength: 2048 })
        + textField({ id: 'mcpServerClientId', label: 'OAuth client ID', value: row.auth?.client_id || '', maxLength: 512 })
        + textField({ id: 'mcpServerScope', label: 'OAuth scope', value: row.auth?.scope || '', maxLength: 1024 })
        + '<div class="settings-actions">' + actionButton({ label: name ? 'Save changes' : 'Create connection', size: 'sm',
          dataset: { 'mcp-servers-action': 'save-editor', 'mcp-server-name': name } })
        + actionButton({ label: 'Cancel', variant: 'ghost', size: 'sm', dataset: {
          'mcp-servers-action': 'cancel-drawer', 'mcp-server-name': name } }) + '</div></div>';
    }
    function credentialMarkup(name) {
      return '<div class="mcp-server-editor" data-mcp-credential-editor>'
        + textField({ id: 'mcpServerCredential', label: 'Secret', value: '', type: 'password', maxLength: 8192 })
        + '<div class="settings-actions">' + actionButton({ label: 'Save credential', size: 'sm',
          dataset: { 'mcp-servers-action': 'save-credential', 'mcp-server-name': name } })
        + actionButton({ label: 'Clear credential', variant: 'danger', size: 'sm',
          dataset: { 'mcp-servers-action': 'clear-credential', 'mcp-server-name': name } })
        + actionButton({ label: 'Cancel', variant: 'ghost', size: 'sm', dataset: {
          'mcp-servers-action': 'details', 'mcp-server-name': name } }) + '</div></div>';
    }
    function toolReviewMarkup(server) {
      var inspection = inspections.get(server.name);
      if (!inspection && server.trustStatus === 'approved') {
        return '<div class="mcp-trust-review"><p><strong>Approved tool surface</strong></p>'
          + (server.reviewedAt ? '<p>Reviewed ' + escapeHtml(server.reviewedAt) + '</p>' : '')
          + '<p>Advertised tools digest</p><code>' + escapeHtml(server.toolsDigest || 'Evidence unavailable') + '</code>'
          + '<p>Configuration digest</p><code>' + escapeHtml(server.configurationDigest || 'Evidence unavailable')
          + '</code></div>';
      }
      if (!inspection) return '<p class="settings-note">Run an inspection to review this connection’s advertised tools.</p>';
      return '<div class="mcp-trust-review"><p><strong>' + inspection.toolCount + ' discovered tool(s)</strong></p><code>'
        + escapeHtml(inspection.toolsDigest) + '</code>'
        + (server.configurationDigest ? '<p>Configuration digest</p><code>'
          + escapeHtml(server.configurationDigest) + '</code>' : '') + inspection.tools.map(function (tool) {
          return '<p><strong>' + escapeHtml(tool.name) + '</strong>'
            + (tool.description ? ' — ' + escapeHtml(tool.description) : '') + '</p>';
        }).join('') + '</div>';
    }
    function detailsMarkup(server) {
      var pending = server.trustStatus !== 'approved';
      var authRow = auth.servers.find(function (row) { return row.name === server.name; });
      var target = server.transport === 'sse' ? server.url : [server.command].concat(server.args || []).filter(Boolean).join(' ');
      var failure = server.failure ? '<p class="mcp-servers-note mcp-servers-note--danger">'
        + escapeHtml(mapMcpFailureMessage(server.failure.message)) + '</p>' : '';
      return '<div class="mcp-server-details"><dl><div><dt>Transport</dt><dd>'
        + escapeHtml(server.transport === 'sse' ? 'Remote SSE' : 'Local stdio') + '</dd></div>'
        + '<div><dt>Target</dt><dd><code>' + escapeHtml(target || 'Not configured') + '</code></dd></div>'
        + '<div><dt>Tools</dt><dd>' + server.toolsCount + '</dd></div><div><dt>Status</dt><dd>'
        + escapeHtml(resolveMcpServerBadge(server).text) + '</dd></div></dl>' + failure
        + '<section><h3>Trust review</h3>' + toolReviewMarkup(server) + '</section>'
        + '<div class="settings-actions">'
        + actionButton({ label: 'Test connection', size: 'sm', disabled: Boolean(busy), dataset: {
          'mcp-servers-action': 'test', 'mcp-server-name': server.name } })
        + (pending ? actionButton({ label: 'Approve tools', size: 'sm', disabled: Boolean(busy) || !inspections.has(server.name),
          dataset: { 'mcp-servers-action': 'approve', 'mcp-server-name': server.name } }) : '')
        + actionButton({ label: 'Edit', variant: 'ghost', size: 'sm', disabled: Boolean(busy), dataset: {
          'mcp-servers-action': 'edit', 'mcp-server-name': server.name } })
        + (server.auth ? actionButton({ label: authRow?.configured ? 'Update credential' : 'Set credential',
          variant: 'ghost', size: 'sm', disabled: Boolean(busy), dataset: {
            'mcp-servers-action': 'configure-credential', 'mcp-server-name': server.name } }) : '')
        + actionButton({ label: 'Remove', variant: 'danger', size: 'sm', disabled: Boolean(busy), dataset: {
          'mcp-servers-action': 'remove', 'mcp-server-name': server.name } }) + '</div></div>';
    }
    function drawDrawer() {
      if (!drawerState || disposed) return;
      var server = drawerState.kind === 'editor' ? drawerState.server : serverByName(drawerState.name);
      if (drawerState.kind !== 'editor' && !server) { drawer.close(); drawerState = null; return; }
      var title = drawerState.kind === 'editor' ? (drawerState.name ? 'Edit MCP connection' : 'Add MCP connection')
        : drawerState.kind === 'credential' ? 'Credential for ' + drawerState.name : drawerState.name;
      var body = drawerState.kind === 'editor' ? editorMarkup(drawerState.name, server)
        : drawerState.kind === 'credential' ? credentialMarkup(drawerState.name) : detailsMarkup(server);
      drawer.open({ title: title, bodyHtml: body,
        restoreFocusTo: focusRestoreHandle(drawerState.restoreFocusIdentity) });
    }
    function rowMarkup(server) {
      var pending = server.trustStatus !== 'approved';
      var secondary = [server.transport === 'sse' ? 'remote' : 'local', server.toolsCount + ' tools',
        resolveMcpServerBadge(server).text.toLowerCase()];
      if (!server.enabled && pending) secondary.push('turn on unavailable until its tools are reviewed');
      if (busy) secondary.push('operation in progress');
      if (server.failure) secondary.push(mapMcpFailureMessage(server.failure.message));
      var disabled = discovery.readOnly || Boolean(busy) || (!server.enabled && pending);
      return '<div class="settings-field-row mcp-servers-row" data-mcp-server-row="' + escapeHtml(server.name) + '">'
        + '<span class="status-dot status-dot--' + resolveMcpServerStatusDot(server) + '"></span>'
        + '<span class="settings-field-row-text"><strong>' + escapeHtml(server.name) + '</strong><small>'
        + escapeHtml(secondary.join(' · ')) + '</small></span><span class="mcp-servers-row-actions">'
        + actionButton({ label: pending ? 'Review' : 'Details', variant: 'ghost', size: 'sm', ariaHaspopup: 'dialog',
          dataset: { 'mcp-servers-action': 'details', 'mcp-server-name': server.name } })
        + (root.inventoryToggleSwitch?.toggleSwitch?.({ id: toggleId(server.name), label: server.name + ' enabled',
          checked: server.enabled, disabled: disabled, className: 'mcp-servers-row-toggle' }) || '') + '</span></div>';
    }
    function groupMarkup() {
      var readonly = discovery.readOnly ? '<div class="settings-note plugins-settings-error" data-mcp-read-only>'
        + 'This MCP configuration was preserved unchanged. ' + escapeHtml(discovery.remediationReason) + '.</div>' : '';
      var operation = busy ? '<p class="settings-note" role="status">Working…</p>' : '';
      return '<div class="settings-group settings-group--wide mcp-servers-group" role="group" '
        + 'aria-labelledby="mcpServersHeading" id="' + GROUP_ID + '"><div class="mcp-servers-header"><div>'
        + '<h4 class="settings-group-heading" id="mcpServersHeading">MCP connections</h4>'
        + '<p class="settings-group-copy">Standalone connections require an explicit tool-surface trust review before they can be enabled.</p></div>'
        + actionButton({ label: 'Add connection', size: 'sm', disabled: discovery.readOnly || Boolean(busy),
          ariaHaspopup: 'dialog', dataset: { 'mcp-servers-action': 'add' } }) + '</div>' + readonly + operation
        + '<div class="mcp-servers-list">' + (discovery.servers.length ? discovery.servers.map(rowMarkup).join('')
          : '<div class="settings-note">No standalone MCP connections.</div>') + '</div></div>';
    }
    function render() {
      var target = host(); if (!target || disposed) return;
      var focus = captureFocus() || pendingFocusIdentity;
      if (focus) pendingFocusIdentity = focus;
      target.innerHTML = enabled() && actionButton ? groupMarkup() : '';
      restoreFocus(focus);
      if (!busy) pendingFocusIdentity = null;
    }
    async function load() {
      if (disposed || !enabled()) return null;
      if (loadPromise) return loadPromise;
      loadPromise = Promise.allSettled([bridge()?.getState?.(), authBridge()?.getStatus?.()]).then(function (results) {
        if (disposed) return null;
        if (results[0].status === 'fulfilled' && results[0].value) discovery = normalizeDiscoveryState(results[0].value);
        if (results[1].status === 'fulfilled' && results[1].value) auth = normalizeAuthState(results[1].value);
        render(); return discovery;
      }).finally(function () { loadPromise = null; });
      return loadPromise;
    }
    function editorPayload() {
      var name = documentRef.getElementById('mcpServerName')?.value?.trim() || '';
      var transport = documentRef.getElementById('mcpServerTransport')?.value || 'stdio';
      var target = documentRef.getElementById('mcpServerTarget')?.value?.trim() || '';
      var args = String(documentRef.getElementById('mcpServerArgs')?.value || '').split(/\r?\n/).filter(Boolean);
      var authKind = documentRef.getElementById('mcpServerAuthKind')?.value || 'none';
      var authBlock = authKind === 'none' ? null : { kind: authKind };
      if (authKind === 'oauth_client_credentials') {
        authBlock.token_url = documentRef.getElementById('mcpServerTokenUrl')?.value?.trim() || '';
        authBlock.client_id = documentRef.getElementById('mcpServerClientId')?.value?.trim() || '';
        authBlock.scope = documentRef.getElementById('mcpServerScope')?.value?.trim() || '';
      }
      return transport === 'sse' ? { name: name, transport: transport, url: target,
        ...(authBlock ? { auth: authBlock } : {}) } : { name: name, transport: transport, command: target, args: args };
    }
    async function run(name, payload) {
      if (busy) return null;
      if (typeof bridge()?.[name] !== 'function') {
        reportBridgeFailure('mcp_settings.bridge_method_missing', name, 'This MCP action is unavailable in this build.');
        return { ok: false, reason: 'bridge_method_missing' };
      }
      busy = name; render(); setDrawerBusy(true);
      var result;
      try {
        result = await bridge()[name](payload);
        if (result?.ok === false && result?.confirmation_required !== true) {
          reportBridgeFailure('mcp_settings.operation_failed', name, 'The MCP operation could not be completed.');
        }
      }
      catch (_error) {
        reportBridgeFailure('mcp_settings.bridge_call_failed', name, 'The MCP operation failed.');
        result = { ok: false, reason: 'bridge_call_failed' };
      }
      finally {
        busy = '';
        if (!disposed) await load();
        if (!disposed) setDrawerBusy(false);
      }
      return result;
    }
    async function runAuth(name, payload) {
      if (busy) return null;
      if (typeof authBridge()?.[name] !== 'function') {
        reportBridgeFailure('mcp_settings.auth_bridge_method_missing', name,
          'Credential management is unavailable in this build.');
        return { ok: false, reason: 'bridge_method_missing' };
      }
      busy = name; render(); setDrawerBusy(true);
      var result;
      try {
        result = await authBridge()[name](payload);
        if (result?.ok === false) reportBridgeFailure('mcp_settings.auth_operation_failed', name,
          'The credential operation could not be completed.');
      }
      catch (_error) {
        reportBridgeFailure('mcp_settings.auth_bridge_call_failed', name, 'The credential operation failed.');
        result = { ok: false, reason: 'bridge_call_failed' };
      }
      finally {
        busy = '';
        if (!disposed) await load();
        if (!disposed) setDrawerBusy(false);
      }
      return result;
    }
    async function testServer(name) {
      var result = await run('testServer', { name: name });
      if (!drawerActiveFor(name)) return;
      if (result?.confirmation_required) {
        var exact = [result.command].concat(result.args || []).join(' ');
        var confirmed = await confirmDanger({ title: 'Inspect MCP connection?',
          message: 'Run this one-time MCP inspection?\n\n' + exact, confirmLabel: 'Run inspection', cancelLabel: 'Cancel' });
        if (confirmed && drawerActiveFor(name)) result = await run('testServer', { name: name, confirmed: true });
      }
      if (result?.ok && !disposed && enabled()) {
        inspections.set(name, { toolCount: Number(result.tool_count) || 0,
          toolsDigest: String(result.tools_digest || ''), tools: Array.isArray(result.tools)
            ? result.tools.map(function (tool) { return { name: String(tool.name || ''),
              description: String(tool.description || '') }; }) : [] });
        render();
        if (drawerActiveFor(name)) { drawerState.kind = 'details'; drawDrawer(); }
        options.showToastMessage?.('Inspection found ' + result.tool_count + ' tool(s).');
      }
    }
    async function removeServer(name) {
      if (!await confirmDanger({ title: 'Remove MCP connection?', message: 'Remove MCP connection “' + name + '”?',
        confirmLabel: 'Remove', cancelLabel: 'Keep' }) || !drawerActiveFor(name)) return;
      var result = await run('removeServer', { name: name });
      if (result?.ok && drawerActiveFor(name)) { inspections.delete(name); drawerState = null; drawer.close(); }
    }
    function showDetails(name, target) {
      if (disposed || !enabled()) return;
      drawerState = { kind: 'details', name: name,
        restoreFocusIdentity: drawerState?.restoreFocusIdentity || focusIdentityFor(target) };
      drawDrawer();
    }
    function handleClick(event) {
      var target = event.target?.closest?.('[data-mcp-servers-action]'); if (!target) return;
      var action = target.dataset.mcpServersAction; var name = target.dataset.mcpServerName || '';
      if (action === 'add') { drawerState = { kind: 'editor', name: '', server: {},
        restoreFocusIdentity: focusIdentityFor(target) }; drawDrawer(); }
      else if (action === 'details') showDetails(name, target);
      else if (action === 'edit') { var server = serverByName(name); if (server) {
        drawerState = { kind: 'editor', name: name, server: server,
          restoreFocusIdentity: drawerState?.restoreFocusIdentity || focusIdentityFor(target) }; drawDrawer(); } }
      else if (action === 'cancel-drawer') { drawerState = null; drawer.close(); }
      else if (action === 'configure-credential') { drawerState = { kind: 'credential', name: name,
        restoreFocusIdentity: drawerState?.restoreFocusIdentity || focusIdentityFor(target) }; drawDrawer(); }
      else if (action === 'save-credential') {
        var value = documentRef.getElementById('mcpServerCredential')?.value || '';
        runAuth('set', { serverName: name, value: value }).then(function (result) {
          if (result?.ok && drawerActiveFor(name, 'credential')) { auth = normalizeAuthState(result); showDetails(name); }
        });
      } else if (action === 'clear-credential') runAuth('delete', { serverName: name }).then(function (result) {
        if (result?.ok && drawerActiveFor(name, 'credential')) { auth = normalizeAuthState(result); showDetails(name); }
      });
      else if (action === 'save-editor') {
        var payload = editorPayload(); var method = name ? 'updateServer' : 'createServer';
        run(method, name ? { name: name, server: payload } : { server: payload }).then(function (result) {
          if (!result?.ok || !drawerActiveFor(name, 'editor')) return;
          if (name) inspections.delete(name);
          var nextName = payload.name;
          drawerState = serverByName(nextName) ? { kind: 'details', name: nextName,
            restoreFocusIdentity: drawerState?.restoreFocusIdentity || focusIdentityFor(target) } : null;
          if (drawerState) drawDrawer(); else drawer.close();
        });
      } else if (action === 'test') testServer(name);
      else if (action === 'approve') run('approveServer', { name: name }).then(function (result) {
        if (result?.ok && drawerActiveFor(name, 'details')) showDetails(name);
      });
      else if (action === 'remove') removeServer(name);
    }
    function handleToggle(event) {
      var id = String(event.detail?.id || '');
      var server = discovery.servers.find(function (row) { return toggleId(row.name) === id; });
      if (!server) return;
      void run('setServerEnabled', { name: server.name, enabled: event.detail?.checked === true });
    }
    function syncFeatureState() {
      if (enabled()) load();
      else { pendingFocusIdentity = null; render(); drawerState = null; drawer.close(); }
    }
    function bind() {
      if (disposed) return;
      root.inventoryToggleSwitch?.initToggleHandlers?.(documentRef);
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('inv-toggle-change', handleToggle);
      syncFeatureState();
    }
    function dispose() {
      disposed = true;
      documentRef.removeEventListener('click', handleClick);
      documentRef.removeEventListener('inv-toggle-change', handleToggle);
      drawer.dispose(); confirmDialog?.dispose?.();
    }
    return { bind: bind, dispose: dispose, render: render, refresh: load, syncFeatureState: syncFeatureState,
      _test: { getView: function () { return { discoveryState: discovery, authState: auth, drawerState: drawerState }; } } };
  }
  return { createMcpServersController: createMcpServersController,
    resolveMcpServerBadge: resolveMcpServerBadge, resolveMcpServerStatusDot: resolveMcpServerStatusDot,
    mapMcpFailureMessage: mapMcpFailureMessage, normalizeDiscoveryState: normalizeDiscoveryState,
    normalizeAuthState: normalizeAuthState, buildServerViewModel: buildServerViewModel };
});
