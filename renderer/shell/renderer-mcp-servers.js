(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../inventory/drawer'));
    return;
  }
  root.rendererMcpServers = factory(root, root.inventoryDrawer);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, drawerModule) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var GROUP_ID = 'mcpServersGroup';
  var HOST_ID = 'mcpServersHost';
  // Connection presets (row 53 S4). Code-owned: the limits a preset sets travel on
  // the created row as hidden values; the editor has no fields for them.
  var PRESETS = {
    rea: {
      windowsOnly: true,
      label: function () { return jt('mcp.servers.presetRea', 'Reverse engineering (rea)'); },
      note: function () { return jt('mcp.servers.presetReaNote', 'Filled from the rea preset. Needs Node.js 22.19, 24.11 or newer at C:\\Program Files\\nodejs. The first Test downloads rea-agents and can take about 30 seconds. The preset also sets limits the form does not show: 2,048 MB of memory, 16 processes, Test waits up to 120 seconds and a tool call may run for 300 seconds.'); },
      row: { name: 'rea', transport: 'stdio', command: 'C:\\Program Files\\nodejs\\npx.cmd',
        args: ['-y', 'rea-agents@6.4.0', 'mcp'] },
      extensions: { memory_limit_mb: 2048, max_processes: 16, inspect_timeout_seconds: 120,
        request_timeout_seconds: 300 },
    },
  };

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  // Row 53: the rea row's readiness copy (S9) and Installation section (S8b) live beside this file.
  var reaModule = root.rendererMcpServersRea || (typeof require === 'function' ? require('./renderer-mcp-servers-rea') : null);
  var readinessCopy = reaModule.readinessCopy;
  // Row 53 S9: the readiness probe is preset-owned (services/mcp-readiness-probe.js keys it by the
  // same exact names as PRESETS); only those rows render the Check action or a readiness line.
  function hasReadinessProbe(name) { return Object.prototype.hasOwnProperty.call(PRESETS, name); }
  function resolveMcpServerBadge(signals) {
    var source = signals || {};
    if (source.builtin) return { state: 'info', text: 'Built-in' };
    if (source.enabled === false) return { state: 'muted', text: 'Off' };
    if (source.trustStatus !== 'approved') return { state: 'warn', text: jt('mcp.servers.reviewRequired', 'Review required') };
    var status = String(source.status || 'configured').toLowerCase();
    if (status === 'running') return { state: 'success', text: 'Running' };
    if (status === 'failed') return { state: 'error', text: 'Failed' };
    if (status === 'cooldown') return { state: 'warn', text: jt('mcp.servers.coolingDown', 'Cooling down') };
    return { state: 'info', text: 'Approved' };
  }
  function resolveMcpServerStatusDot(signals) {
    var badge = resolveMcpServerBadge(signals);
    return badge.state === 'success' ? 'ok' : badge.state === 'error' ? 'error'
      : badge.state === 'warn' ? 'warn' : 'muted';
  }
  function mapMcpFailureMessage(message) {
    var text = String(message || '').trim();
    if (/:\s*PermissionError\s*$/.test(text)) return jt('mcp.servers.privateAddressBlocked', 'URL points to a private or local address, which is blocked.');
    if (/:\s*ValueError\s*$/.test(text)) return jt('mcp.servers.invalidUrl', 'URL is invalid. Use http or https without embedded credentials.');
    return text;
  }
  function normalizeDiscoveryServer(value) {
    var row = value && typeof value === 'object' ? value : {};
    var trust = row.trust && typeof row.trust === 'object' ? row.trust : {};
    return { name: String(row.name || ''), builtin: row.builtin === true, transport: String(row.transport || 'stdio'),
      status: String(row.status || 'configured'), toolsCount: Number(row.toolsCount) || 0, promptsCount: Number(row.promptsCount) || 0,
      command: String(row.command || ''), url: String(row.url || ''), enabled: row.enabled === true,
      args: Array.isArray(row.args) ? row.args.map(function (item) { return String(item); }) : [],
      trustStatus: String(trust.status || 'pending'), reviewedAt: String(trust.reviewed_at || ''),
      configurationDigest: String(trust.configuration_digest || ''),
      toolsDigest: String(trust.advertised_tools_digest || ''), failure: row.failure || null,
      auth: row.auth || null, readOnlyAutoAllow: row.readOnlyAutoAllow === true,
      readiness: hasReadinessProbe(row.name) && row.readiness && typeof row.readiness === 'object' ? row.readiness : null };
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
      muted: server.enabled === false, authHint: server.auth ? jt('mcp.servers.authenticationConfigured', 'authentication configured') : '' };
  }
  function encodeName(name) {
    var encoded = '';
    for (var index = 0; index < name.length; index += 1) encoded += name.charCodeAt(index).toString(16) + '_';
    return encoded;
  }
  function toggleId(name) { return 'mcpServerToggle_' + encodeName(name); }
  function readOnlyToggleId(name) { return 'mcpServerReadOnly_' + encodeName(name); }

  function createMcpServersController(deps) {
    var options = deps || {};
    var windowRef = options.windowRef || root;
    var documentRef = options.documentRef || windowRef.document;
    var platform = String(options.platform || windowRef.navigator?.platform || '');
    var isWindows = /^win/i.test(platform);
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
    var installSection = reaModule.createInstallSection({ hasReadinessProbe: hasReadinessProbe, bridge: bridge,
      servers: function () { return discovery.servers; }, run: run, confirmDanger: confirmDanger,
      drawerActiveFor: drawerActiveFor, drawDrawer: drawDrawer,
      drawerPanel: function () { return documentRef?.querySelector('#mcpServerDetailsDrawer .inv-drawer-panel'); },
      isBusy: function () { return Boolean(busy); }, isDisposed: function () { return disposed; },
      showToast: function (message, toastOptions) { options.showToastMessage?.(message, toastOptions); } });
    var drawer = drawerModule.createDrawer({ documentRef: documentRef,
      overlayManager: options.overlayManager, id: 'mcpServerDetailsDrawer' });
    function availablePresets() {
      return Object.keys(PRESETS).filter(function (id) { return !PRESETS[id].windowsOnly || isWindows; });
    }
    function bridge() { return windowRef.jennyShell?.mcpDiscovery || null; }
    function authBridge() { return windowRef.jennyShell?.mcpAuth || null; }
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
      return !disposed && drawer.isOpen() && drawerState
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
        '<p class="settings-note" role="status" data-mcp-drawer-operation-status>' + escapeHtml(jt('mcp.servers.working', 'Working…')) + '</p>');
      else if (!active) status?.remove();
    }
    function editorMarkup(name, server) {
      if (!textField || !selectField) return '<div class="settings-note">' + escapeHtml(jt('mcp.servers.editorUnavailable', 'Connection editor is unavailable.')) + '</div>';
      var row = server || {};
      var authKind = String(row.auth?.kind || 'none');
      var remote = row.transport === 'sse';
      var presets = !name && availablePresets().length ? '<div class="mcp-presets"><span>' + escapeHtml(jt('mcp.servers.startFromPreset', 'Start from a preset')) + '</span>'
        + availablePresets().map(function (id) { return actionButton({ label: PRESETS[id].label(), variant: 'ghost', size: 'sm',
          disabled: Boolean(busy), dataset: { 'mcp-servers-action': 'preset', 'mcp-server-name': '', 'mcp-preset': id } }); }).join('')
        + '</div>' : '';
      var presetNote = !name && PRESETS[drawerState?.preset] ? '<p class="settings-note" data-mcp-preset-note>'
        + escapeHtml(PRESETS[drawerState.preset].note()) + '</p>' : '';
      return '<div class="mcp-server-editor" data-mcp-editor data-mcp-original-name="' + escapeHtml(name) + '">' + presets
        + textField({ id: 'mcpServerName', label: jt('mcp.servers.connectionName', 'Connection name'), value: row.name || '', maxLength: 64 })
        + selectField({ id: 'mcpServerTransport', label: jt('mcp.servers.transport', 'Transport'), value: row.transport || 'stdio',
          options: [{ value: 'stdio', label: jt('mcp.servers.localStdio', 'Local stdio') }, { value: 'sse', label: jt('mcp.servers.remoteSse', 'Remote SSE') }] })
        + textField({ id: 'mcpServerTarget', label: row.transport === 'sse' ? jt('mcp.servers.httpsUrl', 'HTTPS URL') : jt('mcp.servers.command', 'Command'),
          value: row.transport === 'sse' ? row.url || '' : row.command || '', maxLength: 2048 })
        + '<div class="mcp-editor-group" data-mcp-field-group="stdio"' + (remote ? ' hidden' : '') + '>'
        + textField({ id: 'mcpServerArgs', label: jt('mcp.servers.arguments', 'Arguments (one per line)'),
          value: Array.isArray(row.args) ? row.args.join('\n') : '', maxLength: 4096, multiline: true })
        + '</div><div class="mcp-editor-group" data-mcp-field-group="remote"' + (remote ? '' : ' hidden') + '>'
        + selectField({ id: 'mcpServerAuthKind', label: jt('mcp.servers.authentication', 'Authentication'), value: authKind,
          options: [{ value: 'none', label: jt('common.none', 'None') }, { value: 'bearer', label: jt('mcp.servers.bearerToken', 'Bearer token') },
            { value: 'oauth_client_credentials', label: jt('mcp.servers.oauthClientCredentials', 'OAuth client credentials') }] })
        + '<div class="mcp-editor-group" data-mcp-field-group="oauth"' + (authKind === 'oauth_client_credentials' ? '' : ' hidden') + '>'
        + textField({ id: 'mcpServerTokenUrl', label: jt('mcp.servers.oauthTokenUrl', 'OAuth token URL'), value: row.auth?.token_url || '', maxLength: 2048 })
        + textField({ id: 'mcpServerClientId', label: jt('mcp.servers.oauthClientId', 'OAuth client ID'), value: row.auth?.client_id || '', maxLength: 512 })
        + textField({ id: 'mcpServerScope', label: jt('mcp.servers.oauthScope', 'OAuth scope'), value: row.auth?.scope || '', maxLength: 1024 })
        + '</div></div>' + presetNote
        + '<div class="settings-actions">' + actionButton({ label: name ? jt('mcp.servers.saveChanges', 'Save changes') : jt('mcp.servers.createConnection', 'Create connection'), size: 'sm',
          dataset: { 'mcp-servers-action': 'save-editor', 'mcp-server-name': name } })
        + actionButton({ label: jt('common.cancel', 'Cancel'), variant: 'ghost', size: 'sm', dataset: {
          'mcp-servers-action': 'cancel-drawer', 'mcp-server-name': name } }) + '</div></div>';
    }
    function credentialMarkup(name) {
      return '<div class="mcp-server-editor" data-mcp-credential-editor>'
        + textField({ id: 'mcpServerCredential', label: jt('mcp.servers.secret', 'Secret'), value: '', type: 'password', maxLength: 8192 })
        + '<div class="settings-actions">' + actionButton({ label: jt('mcp.servers.saveCredential', 'Save credential'), size: 'sm',
          dataset: { 'mcp-servers-action': 'save-credential', 'mcp-server-name': name } })
        + actionButton({ label: jt('mcp.servers.clearCredential', 'Clear credential'), variant: 'danger', size: 'sm',
          dataset: { 'mcp-servers-action': 'clear-credential', 'mcp-server-name': name } })
        + actionButton({ label: jt('common.cancel', 'Cancel'), variant: 'ghost', size: 'sm', dataset: {
          'mcp-servers-action': 'details', 'mcp-server-name': name } }) + '</div></div>';
    }
    function toolReviewMarkup(server) {
      var inspection = inspections.get(server.name);
      if (!inspection && server.trustStatus === 'approved') {
        return '<div class="mcp-trust-review"><p><strong>' + escapeHtml(jt('mcp.servers.approvedToolSurface', 'Approved tool surface')) + '</strong></p>'
          + (server.reviewedAt ? '<p>Reviewed ' + escapeHtml(server.reviewedAt) + '</p>' : '')
          + '<p>' + escapeHtml(jt('mcp.servers.advertisedToolsDigest', 'Advertised tools digest')) + '</p><code>' + escapeHtml(server.toolsDigest || jt('mcp.servers.evidenceUnavailable', 'Evidence unavailable')) + '</code>'
          + '<p>' + escapeHtml(jt('mcp.servers.configurationDigest', 'Configuration digest')) + '</p><code>' + escapeHtml(server.configurationDigest || jt('mcp.servers.evidenceUnavailable', 'Evidence unavailable'))
          + '</code></div>';
      }
      if (!inspection) return '<p class="settings-note">' + escapeHtml(jt('mcp.servers.runInspectionHint', 'Run an inspection to review this connection’s advertised tools.')) + '</p>';
      var claimed = inspection.tools.filter(function (tool) { return tool.readOnlyClaim; }).length;
      return '<div class="mcp-trust-review"><p><strong>' + escapeHtml(jt('mcp.servers.discoveredTools', '{count} discovered tool(s)', { count: inspection.toolCount })) + '</strong></p><code>'
        + escapeHtml(inspection.toolsDigest) + '</code>'
        + (server.configurationDigest ? '<p>' + escapeHtml(jt('mcp.servers.configurationDigest', 'Configuration digest')) + '</p><code>'
          + escapeHtml(server.configurationDigest) + '</code>' : '')
        + (claimed ? '<p class="settings-note">' + escapeHtml(jt('mcp.servers.readOnlyClaimsNote', '{claimed} of {count} tools claim to be read-only. Claims are shown as the server reports them; nothing changes unless you turn on the switch below.', { claimed: claimed, count: inspection.toolCount })) + '</p>' : '')
        + inspection.tools.map(function (tool) {
          return '<p><strong>' + escapeHtml(tool.name) + '</strong>'
            + (tool.readOnlyClaim ? ' <span class="mcp-tool-claim">' + escapeHtml(jt('mcp.servers.readOnlyClaimTag', 'read-only')) + '</span>' : '')
            + (tool.description ? ' — ' + escapeHtml(tool.description) : '') + '</p>';
        }).join('') + (inspection.prompts.length ? '<p>' + escapeHtml(jt('mcp.servers.discoveredPrompts', '{count} discovered prompt(s)', { count: inspection.prompts.length })) + '</p>'
          + inspection.prompts.map(function (prompt) { return '<code>' + escapeHtml(prompt.name + '(' + (prompt.arguments || []).map(function (arg) { return arg.name + (arg.required ? '*' : ''); }).join(', ') + ')') + '</code>'; }).join(' ') : '') + '</div>';
    }
    function detailsMarkup(server) {
      var pending = server.trustStatus !== 'approved';
      var authRow = auth.servers.find(function (row) { return row.name === server.name; });
      var target = server.transport === 'sse' ? server.url : [server.command].concat(server.args || []).filter(Boolean).join(' ');
      var failure = server.failure ? '<p class="mcp-servers-note mcp-servers-note--danger">'
        + escapeHtml(mapMcpFailureMessage(server.failure.message)) + '</p>' : '';
      return '<div class="mcp-server-details"><dl><div><dt>Transport</dt><dd>'
        + escapeHtml(server.transport === 'sse' ? jt('mcp.servers.remoteSse', 'Remote SSE') : jt('mcp.servers.localStdio', 'Local stdio')) + '</dd></div>'
        + '<div><dt>Target</dt><dd><code>' + escapeHtml(target || jt('mcp.servers.notConfigured', 'Not configured')) + '</code></dd></div>'
        + '<div><dt>Tools</dt><dd>' + server.toolsCount + '</dd></div><div><dt>Status</dt><dd>'
        + escapeHtml(resolveMcpServerBadge(server).text) + '</dd></div>'
        + '<div><dt>' + escapeHtml(jt('mcp.servers.detailsPrompts', 'Prompts')) + '</dt><dd>' + (server.promptsCount || Number(server.readiness?.prompts) || 0) + '</dd></div>' + (server.readiness ? '<div><dt>'
          + escapeHtml(jt('mcp.servers.readiness', 'Readiness')) + '</dt><dd>'
          + escapeHtml(readinessCopy(server.readiness).details) + '</dd></div>' : '') + '</dl>' + failure
        + '<section><h3>' + escapeHtml(jt('mcp.servers.trustReview', 'Trust review')) + '</h3>' + toolReviewMarkup(server) + '</section>'
        + '<section><h3>' + escapeHtml(jt('mcp.servers.approval', 'Approval')) + '</h3>'
        + '<div class="settings-field-row mcp-approval-row"><span class="settings-field-row-text"><strong>'
        + escapeHtml(jt('mcp.servers.readOnlyAutoAllowLabel', 'Read-only tools run without asking')) + '</strong><small>'
        + escapeHtml(jt('mcp.servers.readOnlyAutoAllowHelp', 'Tools this server marks read-only (and neither open-world nor destructive) skip the per-call approval, retry automatically and run in Plan mode. Turn this on only for a server you trust to label its tools honestly. Changing it sends the connection back to review: Test and approve again. While it is on, a label the server changes later does the same.'))
        + '</small></span>'
        + (root.inventoryToggleSwitch?.toggleSwitch?.({ id: readOnlyToggleId(server.name),
          label: jt('mcp.servers.readOnlyAutoAllowLabel', 'Read-only tools run without asking'),
          checked: server.readOnlyAutoAllow === true, disabled: discovery.readOnly || Boolean(busy),
          className: 'mcp-servers-row-toggle' }) || '')
        + '</div></section>' + installSection.markup(server)
        + '<div class="settings-actions">'
        + actionButton({ label: jt('mcp.servers.testConnection', 'Test connection'), size: 'sm', disabled: Boolean(busy), dataset: {
          'mcp-servers-action': 'test', 'mcp-server-name': server.name } })
        + (hasReadinessProbe(server.name) ? actionButton({ label: jt('mcp.servers.checkReadiness', 'Check readiness'),
          variant: 'ghost', size: 'sm', disabled: Boolean(busy), dataset: {
            'mcp-servers-action': 'check-readiness', 'mcp-server-name': server.name } }) : '')
        + (pending ? actionButton({ label: jt('mcp.servers.approveTools', 'Approve tools'), size: 'sm', disabled: Boolean(busy) || !inspections.has(server.name),
          dataset: { 'mcp-servers-action': 'approve', 'mcp-server-name': server.name } }) : '')
        + actionButton({ label: jt('common.edit', 'Edit'), variant: 'ghost', size: 'sm', disabled: Boolean(busy), dataset: {
          'mcp-servers-action': 'edit', 'mcp-server-name': server.name } })
        + (server.auth ? actionButton({ label: authRow?.configured ? jt('mcp.servers.updateCredential', 'Update credential') : jt('mcp.servers.setCredential', 'Set credential'),
          variant: 'ghost', size: 'sm', disabled: Boolean(busy), dataset: {
            'mcp-servers-action': 'configure-credential', 'mcp-server-name': server.name } }) : '')
        + actionButton({ label: jt('common.remove', 'Remove'), variant: 'danger', size: 'sm', disabled: Boolean(busy), dataset: {
          'mcp-servers-action': 'remove', 'mcp-server-name': server.name } }) + '</div></div>';
    }
    function drawDrawer() {
      if (!drawerState || disposed) return;
      var server = drawerState.kind === 'editor' ? drawerState.server : serverByName(drawerState.name);
      if (drawerState.kind !== 'editor' && !server) { drawer.close(); drawerState = null; return; }
      var title = drawerState.kind === 'editor' ? (drawerState.name ? jt('mcp.servers.editConnection', 'Edit MCP connection') : jt('mcp.servers.addConnection', 'Add MCP connection'))
        : drawerState.kind === 'credential' ? jt('mcp.servers.credentialFor', 'Credential for {name}', { name: drawerState.name }) : drawerState.name;
      var body = drawerState.kind === 'editor' ? editorMarkup(drawerState.name, server)
        : drawerState.kind === 'credential' ? credentialMarkup(drawerState.name) : detailsMarkup(server);
      drawer.open({ title: title, bodyHtml: body,
        restoreFocusTo: focusRestoreHandle(drawerState.restoreFocusIdentity) });
    }
    // The editor shows only the fields its choices use: arguments for a local
    // command, authentication for a remote URL, the OAuth fields for OAuth.
    function syncEditorFields() {
      var editor = documentRef.querySelector('[data-mcp-editor]');
      if (!editor) return;
      var remote = documentRef.getElementById('mcpServerTransport')?.value === 'sse';
      var oauth = documentRef.getElementById('mcpServerAuthKind')?.value === 'oauth_client_credentials';
      var shown = { stdio: !remote, remote: remote, oauth: oauth };
      editor.querySelectorAll('[data-mcp-field-group]').forEach(function (group) {
        group.hidden = !shown[group.getAttribute('data-mcp-field-group')];
      });
      // A preset describes a local command and its limits; moving the row to SSE leaves it.
      var presetNote = editor.querySelector('[data-mcp-preset-note]');
      if (presetNote) presetNote.hidden = remote;
      var targetLabel = remote ? jt('mcp.servers.httpsUrl', 'HTTPS URL') : jt('mcp.servers.command', 'Command');
      var target = documentRef.getElementById('mcpServerTarget');
      var labelText = target?.closest('label')?.querySelector('.inv-text-field-label');
      if (labelText) labelText.textContent = targetLabel;
      target?.setAttribute('aria-label', targetLabel);
    }
    function handleChange(event) {
      var id = event.target && event.target.id;
      if (id === 'mcpServerTransport' || id === 'mcpServerAuthKind') syncEditorFields();
    }
    function rowMarkup(server) {
      if (server.builtin) return '<div class="settings-field-row mcp-servers-row" data-mcp-server-row="'
        + escapeHtml(server.name) + '"><span class="settings-field-row-text"><strong>'
        + escapeHtml(server.name) + '</strong><small>Built-in</small></span></div>';
      var pending = server.trustStatus !== 'approved';
      var secondary = [server.transport === 'sse' ? 'remote' : 'local', server.toolsCount + ' tools',
        resolveMcpServerBadge(server).text.toLowerCase()];
      if (server.readiness) {
        secondary = [secondary[0], server.readiness.tools + ' tools'];
        secondary.push(resolveMcpServerBadge(server).text.toLowerCase(), readinessCopy(server.readiness).summary);
      }
      var promptsCount = server.promptsCount || Number(server.readiness?.prompts) || 0; if (promptsCount > 0) secondary.splice(2, 0, jt('mcp.servers.promptsCount', '{count} prompts', { count: promptsCount }));
      if (!server.enabled && pending) secondary.push(jt('mcp.servers.turnOnUnavailablePendingReview', 'turn on unavailable until its tools are reviewed'));
      if (busy) secondary.push(jt('mcp.servers.operationInProgress', 'operation in progress'));
      if (server.failure) secondary.push(mapMcpFailureMessage(server.failure.message));
      var disabled = discovery.readOnly || Boolean(busy) || (!server.enabled && pending);
      return '<div class="settings-field-row mcp-servers-row" data-mcp-server-row="' + escapeHtml(server.name) + '">'
        + '<span class="status-dot status-dot--' + resolveMcpServerStatusDot(server) + '"></span>'
        + '<span class="settings-field-row-text"><strong>' + escapeHtml(server.name) + '</strong><small>'
        + escapeHtml(secondary.join(' · ')) + '</small></span><span class="mcp-servers-row-actions">'
        + actionButton({ label: pending ? jt('mcp.servers.review', 'Review') : jt('mcp.servers.details', 'Details'), variant: 'ghost', size: 'sm', ariaHaspopup: 'dialog',
          dataset: { 'mcp-servers-action': 'details', 'mcp-server-name': server.name } })
        + (root.inventoryToggleSwitch?.toggleSwitch?.({ id: toggleId(server.name), label: jt('mcp.servers.enabledLabel', '{name} enabled', { name: server.name }),
          checked: server.enabled, disabled: disabled, className: 'mcp-servers-row-toggle' }) || '') + '</span></div>';
    }
    function groupMarkup() {
      var readonly = discovery.readOnly ? '<div class="settings-note extensions-settings-error" data-mcp-read-only>'
        + escapeHtml(jt('mcp.servers.configurationPreserved', 'This MCP configuration was preserved unchanged.')) + ' ' + escapeHtml(discovery.remediationReason) + '.</div>' : '';
      var operation = busy ? '<p class="settings-note" role="status">Working…</p>' : '';
      return '<div class="settings-group settings-group--wide mcp-servers-group" role="group" '
        + 'aria-labelledby="mcpServersHeading" id="' + GROUP_ID + '"><div class="mcp-servers-header"><div>'
        + '<h4 class="settings-group-heading" id="mcpServersHeading">' + escapeHtml(jt('mcp.servers.heading', 'MCP connections')) + '</h4>'
        + '<p class="settings-group-copy">' + escapeHtml(jt('mcp.servers.trustReviewRequirement', 'Standalone connections require an explicit tool-surface trust review before they can be enabled.')) + '</p></div>'
        + actionButton({ label: jt('mcp.servers.addConnectionShort', 'Add connection'), size: 'sm', disabled: discovery.readOnly || Boolean(busy),
          ariaHaspopup: 'dialog', dataset: { 'mcp-servers-action': 'add' } }) + '</div>' + readonly + operation
        + '<div class="mcp-servers-list">' + (discovery.servers.map(rowMarkup).join('') + (discovery.servers.some(function (server) { return !server.builtin; }) ? ''
          : '<div class="settings-note">' + escapeHtml(jt('mcp.servers.noneConfigured', 'No standalone MCP connections.')) + '</div>')) + '</div></div>';
    }
    function render() {
      var target = host(); if (!target || disposed) return;
      var focus = captureFocus() || pendingFocusIdentity;
      if (focus) pendingFocusIdentity = focus;
      target.innerHTML = actionButton ? groupMarkup() : '';
      restoreFocus(focus);
      if (!busy) pendingFocusIdentity = null;
    }
    async function load() {
      if (disposed) return null;
      if (loadPromise) return loadPromise;
      loadPromise = Promise.allSettled([bridge()?.getState?.(), authBridge()?.getStatus?.()]).then(async function (results) {
        if (disposed) return null;
        if (results[0].status === 'fulfilled' && results[0].value) discovery = normalizeDiscoveryState(results[0].value);
        if (results[1].status === 'fulfilled' && results[1].value) auth = normalizeAuthState(results[1].value);
        render(); // the rows never wait on the install plan's Node probe
        await installSection.load();
        if (disposed) return null;
        return discovery;
      }).finally(function () { loadPromise = null; });
      return loadPromise;
    }
    // The sse auth block the store expects, rebuilt from a row's non-secret summary.
    function authPayload(summary) {
      if (!summary?.kind) return null;
      var block = { kind: summary.kind };
      if (summary.secretRef) block.secret_ref = summary.secretRef;
      if (summary.kind === 'oauth_client_credentials') {
        block.token_url = summary.token_url || ''; block.client_id = summary.client_id || ''; block.scope = summary.scope || '';
      }
      return block;
    }
    function rowPayload(server, overrides) {
      var row = server.transport === 'sse' ? { name: server.name, transport: 'sse', url: server.url, auth: authPayload(server.auth) }
        : { name: server.name, transport: 'stdio', command: server.command, args: server.args.slice() };
      return Object.assign(row, overrides);
    }
    function editorPayload() {
      var name = documentRef.getElementById('mcpServerName')?.value?.trim() || '';
      var transport = documentRef.getElementById('mcpServerTransport')?.value || 'stdio';
      var target = documentRef.getElementById('mcpServerTarget')?.value?.trim() || '';
      var args = String(documentRef.getElementById('mcpServerArgs')?.value || '').split(/\r?\n/).filter(Boolean);
      var authKind = documentRef.getElementById('mcpServerAuthKind')?.value || 'none';
      var field = function (id) { return documentRef.getElementById(id)?.value?.trim() || ''; };
      var authBlock = authKind === 'none' ? null : authPayload({ kind: authKind,
        secretRef: drawerState?.server?.auth?.secretRef, token_url: field('mcpServerTokenUrl'),
        client_id: field('mcpServerClientId'), scope: field('mcpServerScope') });
      var payload = transport === 'sse' ? { name: name, transport: transport, url: target,
        auth: authBlock } : { name: name, transport: transport, command: target, args: args };
      var preset = drawerState?.kind === 'editor' && !drawerState.name ? PRESETS[drawerState.preset] : null;
      if (preset && transport === 'stdio') Object.assign(payload, preset.extensions);
      return payload;
    }
    async function runOperation(name, payload, api, messages, allowConfirmation) {
      if (busy) return null;
      if (typeof api?.[name] !== 'function') {
        reportBridgeFailure(messages.family + 'bridge_method_missing', name, messages.unavailable);
        return { ok: false, reason: 'bridge_method_missing' };
      }
      busy = name; render(); setDrawerBusy(true);
      var result;
      try {
        result = await api[name](payload);
        if (result?.ok === false && !(allowConfirmation && result?.confirmation_required === true)) {
          reportBridgeFailure(messages.family + 'operation_failed', name, messages.incomplete(result));
        }
      }
      catch (_error) {
        reportBridgeFailure(messages.family + 'bridge_call_failed', name, messages.failed);
        result = { ok: false, reason: 'bridge_call_failed' };
      }
      finally {
        busy = '';
        if (!disposed) await load();
        if (!disposed) setDrawerBusy(false);
      }
      return result;
    }
    function run(name, payload) {
      return runOperation(name, payload, bridge(), {
        family: 'mcp_settings.',
        unavailable: jt('mcp.servers.actionUnavailable', 'This MCP action is unavailable in this build.'),
        incomplete: function (result) { return name === 'installRea' || name === 'uninstallRea' ? installSection.failureCopy(result, name === 'uninstallRea')
          : result.saved && result.runtimeApplied === false
          ? jt('mcp.servers.runtimeApplyPending', 'Saved, but not applied yet. The previous setup may still be running.')
          : jt('mcp.servers.operationIncomplete', 'The MCP operation could not be completed.'); },
        failed: jt('mcp.servers.operationFailed', 'The MCP operation failed.'),
      }, true);
    }
    // A saved change whose runtime refresh failed still moved the config:
    // navigate as on success; run() already showed the pending warning.
    function wasSaved(result) { return result?.ok === true || result?.saved === true; }
    function runAuth(name, payload) {
      return runOperation(name, payload, authBridge(), {
        family: 'mcp_settings.auth_',
        unavailable: jt('mcp.servers.credentialManagementUnavailable', 'Credential management is unavailable in this build.'),
        incomplete: function () { return jt('mcp.servers.credentialOperationIncomplete', 'The credential operation could not be completed.'); },
        failed: jt('mcp.servers.credentialOperationFailed', 'The credential operation failed.'),
      }, false);
    }
    async function testServer(name) {
      var result = await run('testServer', { name: name });
      if (!drawerActiveFor(name)) return;
      if (result?.confirmation_required) {
        var exact = [result.command].concat(result.args || []).join(' ');
        var confirmed = await confirmDanger({ title: jt('mcp.servers.inspectConfirmTitle', 'Inspect MCP connection?'),
          message: jt('mcp.servers.inspectConfirmMessage', 'Run this one-time MCP inspection?\n\n{command}', { command: exact }), confirmLabel: jt('mcp.servers.runInspection', 'Run inspection'), cancelLabel: jt('common.cancel', 'Cancel') });
        if (confirmed && drawerActiveFor(name)) result = await run('testServer', { name: name, confirmed: true });
      }
      if (result?.ok && !disposed) {
        inspections.set(name, { toolCount: Number(result.tool_count) || 0, prompts: Array.isArray(result.prompts) ? result.prompts : [],
          toolsDigest: String(result.tools_digest || ''), tools: Array.isArray(result.tools)
            ? result.tools.map(function (tool) { return { name: String(tool.name || ''),
              description: String(tool.description || ''), readOnlyClaim: tool.read_only_claim === true }; }) : [] });
        render();
        if (drawerActiveFor(name)) { drawerState.kind = 'details'; drawDrawer(); }
        options.showToastMessage?.(jt('mcp.servers.inspectionFound', 'Inspection found {count} tool(s).', { count: result.tool_count }));
      }
    }
    async function setReadOnlyAutoAllow(server, enabled) {
      // The redraw below would hand focus to Close; keep the user on the switch they used.
      var focus = { kind: 'toggle', id: readOnlyToggleId(server.name) };
      var hadFocus = documentRef.activeElement?.dataset?.invToggle === focus.id;
      var result = await run('updateServer', { name: server.name,
        server: rowPayload(server, { read_only_auto_allow: enabled }) });
      if (wasSaved(result)) inspections.delete(server.name);
      if (!drawerActiveFor(server.name, 'details')) return;
      drawDrawer();
      if (hadFocus) resolveFocusTarget(focus)?.focus?.();
    }
    async function removeServer(name) {
      if (!await confirmDanger({ title: jt('mcp.servers.removeConfirmTitle', 'Remove MCP connection?'), message: jt('mcp.servers.removeConfirmMessage', 'Remove MCP connection “{name}”?', { name: name }),
        confirmLabel: jt('common.remove', 'Remove'), cancelLabel: jt('mcp.servers.keep', 'Keep') }) || !drawerActiveFor(name)) return;
      var result = await run('removeServer', { name: name });
      if (wasSaved(result) && drawerActiveFor(name)) { inspections.delete(name); drawerState = null; drawer.close(); }
    }
    function showDetails(name, target) {
      if (disposed) return;
      drawerState = { kind: 'details', name: name,
        restoreFocusIdentity: drawerState?.restoreFocusIdentity || focusIdentityFor(target) };
      drawDrawer();
    }
    function handleClick(event) {
      var target = event.target?.closest?.('[data-mcp-servers-action]'); if (!target) return;
      var action = target.dataset.mcpServersAction; var name = target.dataset.mcpServerName || '';
      if (action === 'add') { drawerState = { kind: 'editor', name: '', server: {},
        restoreFocusIdentity: focusIdentityFor(target) }; drawDrawer(); }
      else if (action === 'preset') {
        var presetId = target.dataset.mcpPreset || '';
        if (drawerState?.kind !== 'editor' || drawerState.name || !PRESETS[presetId]
          || availablePresets().indexOf(presetId) < 0) return;
        drawerState.server = Object.assign({}, PRESETS[presetId].row); drawerState.preset = presetId;
        drawDrawer(); documentRef.getElementById('mcpServerName')?.focus?.();
      } else if (action === 'details') showDetails(name, target);
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
          if (!wasSaved(result) || !drawerActiveFor(name, 'editor')) return;
          if (name) inspections.delete(name);
          var nextName = payload.name;
          drawerState = serverByName(nextName) ? { kind: 'details', name: nextName,
            restoreFocusIdentity: drawerState?.restoreFocusIdentity || focusIdentityFor(target) } : null;
          if (drawerState) drawDrawer(); else drawer.close();
        });
      } else if (action === 'test') testServer(name);
      else if (action === 'install-rea' || action === 'uninstall-rea') installSection.manage(name, action === 'uninstall-rea');
      else if (action === 'check-readiness') run('checkReadiness', { name: name }).then(function (result) {
        if (result?.ok && drawerActiveFor(name, 'details')) showDetails(name);
      });
      else if (action === 'approve') run('approveServer', { name: name }).then(function (result) {
        if (wasSaved(result) && drawerActiveFor(name, 'details')) showDetails(name);
      });
      else if (action === 'remove') removeServer(name);
    }
    function handleToggle(event) {
      var id = String(event.detail?.id || '');
      var server = discovery.servers.find(function (row) { return toggleId(row.name) === id; });
      if (server) { void run('setServerEnabled', { name: server.name, enabled: event.detail?.checked === true }); return; }
      server = discovery.servers.find(function (row) { return readOnlyToggleId(row.name) === id; });
      if (server) void setReadOnlyAutoAllow(server, event.detail?.checked === true);
    }
    function syncFeatureState() {
      load();
    }
    function bind() {
      if (disposed) return;
      root.inventoryToggleSwitch?.initToggleHandlers?.(documentRef);
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('inv-toggle-change', handleToggle);
      documentRef.addEventListener('change', handleChange);
      installSection.subscribe();
      syncFeatureState();
    }
    function dispose() {
      disposed = true;
      installSection.release();
      documentRef.removeEventListener('click', handleClick);
      documentRef.removeEventListener('inv-toggle-change', handleToggle);
      documentRef.removeEventListener('change', handleChange);
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
