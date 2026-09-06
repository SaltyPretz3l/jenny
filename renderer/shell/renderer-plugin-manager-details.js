(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../inventory/drawer'), require('../shared/async-fence'));
    return;
  }
  root.rendererPluginManagerDetails = factory(root, root.inventoryDrawer, root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, drawerModule, asyncFenceModule) {
  'use strict';

  // A view opens only while its contribution is effectively enabled. The button stays
  // visible but inert rather than vanishing, because an enabled-looking control that
  // fails with the host's generic "could not open this isolated view" reads as a broken
  // view instead of a plugin that is simply turned off.
  var VIEW_BLOCKED_COPY = Object.freeze({
    master_disabled: 'Turn this plugin on to open its view.',
    managed_policy: 'Managed policy blocks this plugin view.' });

  function viewBlockedTitle(contribution) {
    return VIEW_BLOCKED_COPY[String(contribution?.blocked_reason || '')]
      || 'This plugin view is not running.';
  }

  function createPluginDetailsController(deps) {
    var options = deps || {};
    var button = options.actionButton;
    var escapeHtml = button.escapeHtml;
    var documentRef = options.documentRef;
    var drawer = drawerModule.createDrawer({
      documentRef: documentRef,
      overlayManager: options.overlayManager,
      id: 'pluginManagerDetailsDrawer',
    });
    var disposed = false;
    var busy = false;
    var currentIdentity = null;
    var currentPlugin = null;
    var restoreFocusTo = null;
    var restoreFocusIdentity = null;
    var lastError = '';
    var loadGate = asyncFenceModule.createGenerationGate();

    function identityFor(node) {
      if (!node?.dataset?.pluginsSettingsAction) return null;
      return { action: node.dataset.pluginsSettingsAction, publisherId: node.dataset.publisherId || '',
        pluginId: node.dataset.pluginId || '', contributionId: node.dataset.contributionId || '' };
    }

    function currentRestoreFocusTarget() {
      if (!restoreFocusIdentity) return restoreFocusTo;
      return { get isConnected() { return Boolean(resolveRestoreFocusTarget()); },
        focus: function () { resolveRestoreFocusTarget()?.focus?.(); } };
    }

    function resolveRestoreFocusTarget() {
      if (!restoreFocusIdentity) return restoreFocusTo?.isConnected ? restoreFocusTo : null;
      return Array.from(documentRef.querySelectorAll('[data-plugins-settings-action]')).find(function (node) {
        return node.dataset.pluginsSettingsAction === restoreFocusIdentity.action
          && (node.dataset.publisherId || '') === restoreFocusIdentity.publisherId
          && (node.dataset.pluginId || '') === restoreFocusIdentity.pluginId
          && (node.dataset.contributionId || '') === restoreFocusIdentity.contributionId;
      }) || (restoreFocusTo?.isConnected ? restoreFocusTo : null);
    }

    function settingsControlId(pluginId, contributionId, index) {
      return ('pluginDetailSetting_' + pluginId + '_' + contributionId + '_' + index)
        .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180);
    }

    function settingsMarkup(plugin, item) {
      var settings = item.settings;
      var fields = Array.isArray(settings?.fields) ? settings.fields : [];
      if (!fields.length) return '';
      var values = settings.values || {};
      var controls = fields.map(function (field, index) {
        var id = settingsControlId(plugin.plugin_id, item.contribution_id, index);
        var value = Object.hasOwn(values, field.key) ? values[field.key] : field.default;
        if (field.type === 'boolean') return root.inventoryToggleSwitch?.toggleSwitch?.({
          id: id, label: field.label, checked: value, className: 'plugin-setting-control',
        }) || '';
        if (field.type === 'integer') return root.inventoryNumberInput?.({
          id: id, label: field.label, value: value, min: field.minimum, max: field.maximum,
          className: 'plugin-setting-control',
        }) || '';
        if (field.type === 'enum') return root.inventorySelectField?.({
          id: id, label: field.label, value: value,
          options: (field.values || []).map(function (entry) { return { value: entry, label: entry }; }),
          className: 'plugin-setting-control',
        }) || '';
        return root.inventoryTextField?.({ id: id, label: field.label, value: value,
          maxLength: field.max_length, className: 'plugin-setting-control' }) || '';
      }).join('');
      return '<div class="plugin-settings-fields" data-plugin-detail-settings="'
        + escapeHtml(item.contribution_id) + '" aria-busy="' + String(busy) + '">' + controls
        + button({ label: busy ? 'Saving…' : 'Save settings', size: 'sm', disabled: busy,
          dataset: { 'plugin-details-action': 'settings-save',
            'contribution-id': item.contribution_id, 'generation-id': plugin.generation_id } }) + '</div>';
    }

    function contributionMarkup(plugin) {
      var contributions = Array.isArray(plugin.contributions) ? plugin.contributions : [];
      if (!contributions.length) return '<div class="settings-note">No renderer-visible contributions.</div>';
      return contributions.map(function (item) {
        var permissions = item.mcp ? 'MCP · ' + String(item.mcp.auth_policy || 'no auth')
          : item.view ? 'View · ' + String(item.view.view_kind || 'sandboxed')
          : item.theme ? 'Theme tokens' : item.settings ? 'Typed settings'
          : String(item.kind || 'contribution');
        var detail = item.settings ? '<small>Settings revision ' + escapeHtml(item.settings.revision || 0)
          + ' · ' + escapeHtml(Object.keys(item.settings.values || {}).length) + ' stored value(s)</small>'
          : item.view ? '<small>' + escapeHtml((item.view.artifact_kinds || []).join(', ') || 'No artifact kinds') + '</small>'
          : item.mcp ? '<small>' + escapeHtml(item.mcp.transport_class || '') + ' · '
            + escapeHtml(item.mcp.active ? 'authorized' : 'inactive or revoked') + '</small>' : '';
        var opensView = item.kind === 'view' || item.kind === 'setup_scene' || Boolean(item.view);
        var viewReady = item.effective_enabled === true;
        var openButton = opensView ? button({
          label: item.kind === 'setup_scene' || item.view?.view_kind === 'setup_scene' ? 'Set up' : 'Open',
          disabled: !viewReady, title: viewReady ? '' : viewBlockedTitle(item),
          variant: 'ghost', size: 'sm', dataset: { 'plugins-settings-action': 'open-view',
            'publisher-id': plugin.publisher_id, 'plugin-id': plugin.plugin_id,
            'contribution-id': item.contribution_id, 'generation-id': plugin.generation_id,
            'display-name': item.display_name || plugin.display_name } }) : '';
        return '<div class="plugin-detail-contribution" data-contribution-id="'
          + escapeHtml(item.contribution_id) + '"><strong>'
          + escapeHtml(item.display_name || item.contribution_id) + '</strong><span>'
          + escapeHtml(permissions) + '</span>' + detail + openButton + settingsMarkup(plugin, item) + '</div>';
      }).join('');
    }

    function evidenceMarkup(plugin) {
      var source = plugin.source_evidence || {};
      var signature = plugin.signature_evidence || {};
      var lifecycle = plugin.lifecycle || {};
      var revocation = plugin.revocation || {};
      return '<dl><div><dt>Publisher</dt><dd>' + escapeHtml(plugin.publisher_id) + '</dd></div>'
        + '<div><dt>Plugin ID</dt><dd>' + escapeHtml(plugin.plugin_id) + '</dd></div>'
        + '<div><dt>Version</dt><dd>' + escapeHtml(plugin.resolved_version || '') + '</dd></div>'
        + '<div><dt>Source</dt><dd>' + escapeHtml(source.kind || 'verified package') + '</dd></div>'
        + '<div><dt>Source evidence</dt><dd><code>' + escapeHtml(source.evidence_digest || 'verified') + '</code></dd></div>'
        + '<div><dt>Signing key</dt><dd><code>' + escapeHtml(signature.publisher_key_id || 'current publisher trust') + '</code></dd></div>'
        + '<div><dt>Artifact digest</dt><dd><code>' + escapeHtml(signature.artifact_digest || '') + '</code></dd></div>'
        + '<div><dt>Effective state</dt><dd>' + escapeHtml(lifecycle.effective_state || plugin.effective_state || '') + '</dd></div>'
        + '<div><dt>Cleanup</dt><dd>' + escapeHtml(lifecycle.cleanup_status || 'not pending') + '</dd></div>'
        + '<div><dt>Revocation</dt><dd>' + escapeHtml(revocation.status || 'current') + '</dd></div></dl>';
    }

    function authenticationMarkup(plugin) {
      var rows = Array.isArray(plugin.authentication) ? plugin.authentication : [];
      if (!rows.length) return '<div class="settings-note">No plugin-managed authentication.</div>';
      return rows.map(function (row) { return '<div class="plugin-detail-contribution"><strong>'
        + escapeHtml(row.contribution_id) + '</strong><span>' + escapeHtml(row.kind + ' · ' + row.policy)
        + ' · ' + escapeHtml(row.active ? 'authorized' : 'inactive or revoked') + '</span></div>'; }).join('');
    }

    function body(plugin) {
      var active = plugin.effective_state === 'active';
      var actions = button({ label: active ? 'Disable' : 'Enable', size: 'sm',
        disabled: !active && plugin.activation_eligible !== true,
        dataset: { 'plugins-settings-action': active ? 'disable' : 'enable',
          'publisher-id': plugin.publisher_id, 'plugin-id': plugin.plugin_id } })
        + button({ label: 'Uninstall', variant: 'danger', size: 'sm',
          dataset: { 'plugins-settings-action': 'uninstall', 'publisher-id': plugin.publisher_id,
            'plugin-id': plugin.plugin_id, 'display-name': plugin.display_name } });
      var error = lastError ? '<div class="settings-note plugins-settings-error" role="alert">'
        + escapeHtml(lastError) + '</div>' : '';
      return error + '<section class="plugin-detail-evidence"><h3>Trust &amp; lifecycle</h3>'
        + evidenceMarkup(plugin) + '</section>'
        + '<section><h3>Authentication &amp; revocation</h3>' + authenticationMarkup(plugin) + '</section>'
        + '<section><h3>Permissions &amp; contributions</h3>' + contributionMarkup(plugin) + '</section>'
        + '<section><h3>Administration</h3><div class="settings-actions">' + actions + '</div></section>';
    }

    function draw() {
      if (!currentPlugin || !drawer.isOpen()) return;
      drawer.open({ title: currentPlugin.display_name || currentIdentity?.displayName || 'Plugin details',
        bodyHtml: body(currentPlugin), restoreFocusTo: currentRestoreFocusTarget() });
    }

    async function loadCurrent() {
      if (!currentIdentity) return;
      var requestedIdentity = { publisherId: currentIdentity.publisherId, pluginId: currentIdentity.pluginId,
        displayName: currentIdentity.displayName };
      loadGate.bump();
      var loadToken = loadGate.capture();
      function isActiveRequest() {
        return !disposed && loadGate.isCurrent(loadToken)
          && currentIdentity?.publisherId === requestedIdentity.publisherId
          && currentIdentity?.pluginId === requestedIdentity.pluginId;
      }
      try {
        var result = await options.getApi()?.getDetails?.({
          publisher_id: requestedIdentity.publisherId, plugin_id: requestedIdentity.pluginId,
        });
        if (!isActiveRequest() || !drawer.isOpen()) return;
        if (!result?.ok || !result.plugin) {
          drawer.open({ title: requestedIdentity.displayName || 'Plugin details',
            bodyHtml: '<div class="settings-note plugins-settings-error">Plugin details are unavailable.</div>',
            restoreFocusTo: currentRestoreFocusTarget() });
          return;
        }
        currentPlugin = result.plugin;
        draw();
      } catch (_error) {
        if (isActiveRequest() && drawer.isOpen()) drawer.open({ title: requestedIdentity.displayName || 'Plugin details',
          bodyHtml: '<div class="settings-note plugins-settings-error">Plugin details are unavailable.</div>',
          restoreFocusTo: currentRestoreFocusTarget() });
      }
    }

    async function saveSettings(target) {
      if (disposed || busy || !currentPlugin) return;
      var contributionId = String(target.dataset.contributionId || '');
      var contribution = (currentPlugin.contributions || []).find(function (item) {
        return item.contribution_id === contributionId;
      });
      if (!contribution?.settings) return;
      var values = {};
      contribution.settings.fields.forEach(function (field, index) {
        var id = settingsControlId(currentPlugin.plugin_id, contributionId, index);
        var control = documentRef.getElementById(id)
          || documentRef.querySelector('[data-inv-toggle="' + id + '"]');
        if (field.type === 'boolean') values[field.key] = control?.getAttribute('aria-checked') === 'true';
        else if (field.type === 'integer') values[field.key] = Number(control?.value);
        else values[field.key] = String(control?.value ?? '');
      });
      busy = true;
      lastError = '';
      var group = target.closest('.plugin-settings-fields');
      group?.setAttribute('aria-busy', 'true');
      target.closest('.inv-drawer-panel')?.querySelectorAll(
        '[data-plugin-details-action],[data-plugins-settings-action],input,select,textarea,[data-inv-toggle]'
      ).forEach(function (control) {
        control.disabled = true;
      });
      var result;
      try {
        result = await options.getApi()?.updateSettings?.({
          publisher_id: currentPlugin.publisher_id, plugin_id: currentPlugin.plugin_id,
          contribution_id: contributionId, values: values,
          expected_generation_id: currentPlugin.generation_id,
        });
      } catch (_error) { result = { ok: false, reason: 'bridge_unavailable' }; }
      busy = false;
      if (disposed || !drawer.isOpen()) return;
      if (!result?.ok) {
        lastError = 'Settings update failed: ' + String(result?.reason || result?.code || 'unknown failure');
        draw();
        return;
      }
      options.onChanged?.();
      await loadCurrent();
    }

    function handleClick(event) {
      var target = event.target?.closest?.('[data-plugin-details-action]');
      if (target?.dataset.pluginDetailsAction === 'settings-save') void saveSettings(target);
    }

    async function open(identity, focusTarget) {
      if (disposed) return;
      currentIdentity = identity;
      currentPlugin = null;
      restoreFocusTo = focusTarget;
      restoreFocusIdentity = identityFor(focusTarget);
      lastError = '';
      drawer.open({ title: identity.displayName || 'Plugin details',
        bodyHtml: '<div class="settings-note">Loading verified plugin details…</div>',
        restoreFocusTo: currentRestoreFocusTarget() });
      await loadCurrent();
    }

    documentRef.addEventListener('click', handleClick);
    function setBusy(active) {
      var panel = documentRef?.querySelector('#pluginManagerDetailsDrawer .inv-drawer-panel');
      if (!panel) return;
      panel.setAttribute('aria-busy', String(Boolean(active)));
      panel.querySelectorAll('button:not([data-drawer-close]),input,select,textarea').forEach(function (control) {
        if (active) {
          control.dataset.pluginBusyWasDisabled = String(Boolean(control.disabled));
          control.disabled = true;
        } else if (control.dataset.pluginBusyWasDisabled !== undefined) {
          control.disabled = control.dataset.pluginBusyWasDisabled === 'true';
          delete control.dataset.pluginBusyWasDisabled;
        }
      });
      var status = panel.querySelector('[data-plugin-drawer-operation-status]');
      if (active && !status) panel.querySelector('.inv-drawer-body')?.insertAdjacentHTML('afterbegin',
        '<p class="settings-note" role="status" data-plugin-drawer-operation-status>Working…</p>');
      else if (!active) status?.remove();
    }

    async function reload() {
      if (disposed || !drawer.isOpen()) return null;
      return loadCurrent();
    }

    return Object.freeze({ open: open, close: drawer.close, reload: reload, setBusy: setBusy,
      dispose: function () { disposed = true; loadGate.bump();
        documentRef.removeEventListener('click', handleClick); drawer.dispose(); } });
  }

  return Object.freeze({ createPluginDetailsController: createPluginDetailsController,
    viewBlockedTitle: viewBlockedTitle });
});
