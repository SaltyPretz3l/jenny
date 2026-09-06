(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./renderer-plugin-catalog'),
      require('./renderer-plugin-manager-details'), require('./renderer-plugin-manager-operations'));
    return;
  }
  root.rendererPluginsSettingsUtils = factory(root, root.rendererPluginCatalog,
    root.rendererPluginManagerDetails, root.rendererPluginManagerOperations);
})(typeof globalThis !== 'undefined' ? globalThis : this,
  function (root, catalogModule, detailsModule, operationsModule) {
  'use strict';
  var CARD_SELECTOR = '.settings-card[data-settings-section="plugins"]';
  var NAV_SELECTOR = '.settings-nav [data-settings-section="plugins"]';
  var HEADER_ACTIONS_HOST_ID = 'pluginsHeaderActionsHost';
  var INSTALLED_HOST_ID = 'pluginsSettingsHost';
  var SOURCES_HOST_ID = 'pluginsSourcesHost';
  var GROUP_ID = 'pluginsSettingsGroup';
  var SOURCES_GROUP_ID = 'pluginsSourcesGroup';
  var SOURCE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
  var STATE_COPY = Object.freeze({ absent: 'not installed', staged: 'installing…',
    installed_disabled: 'turned off', preparing: 'starting…', active: 'active',
    disabling: 'turning off…', blocked: 'blocked', quarantined: 'quarantined',
    uninstalling: 'uninstalling…' });
  var ACTIVATION_REASON_COPY = Object.freeze({ eligible: '', already_active: 'already active',
    safe_mode: 'plugins are in safe mode', store_read_only: 'plugin state is read-only',
    not_first_party: 'only trusted first-party packages can start',
    publisher_key_not_current: 'publisher trust is no longer current',
    permissions_requested: 'requested permissions are not supported',
    dependencies_not_supported: 'plugin dependencies are not supported',
    no_supported_contributions: 'no supported contributions',
    mixed_or_unsupported_contributions: 'contains unsupported contributions',
    package_record_unavailable: 'verified package record is unavailable' });
  var PROGRESS_COPY = Object.freeze({ staging: 'Staging…', validating: 'Validating…',
    committing: 'Applying changes…', preparing: 'Starting…', cleanup: 'Cleaning up…' });
  // Reasons invented by THIS renderer (never wire codes). Wire refusals keep their
  // CMP-PLUGIN code + bounded reason verbatim; these would otherwise surface a raw
  // enum in a toast, which is the leak the lifecycle copy above exists to prevent.
  var LOCAL_FAILURE_COPY = Object.freeze({
    operation_busy: 'Another plugin operation is still running. Wait for it to finish.',
    bridge_call_failed: 'The plugin service did not respond. Try again.',
    bridge_method_missing: 'This plugin action is unavailable in this build.' });

  function classifyPluginsPlatform(ok, payload) {
    var envelope = ok && payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!envelope) return { kind: 'unavailable', message: 'Plugin platform status is unavailable.' };
    if (envelope.safe_mode_active === true) return { kind: 'safe_mode', source: String(envelope.safe_mode_source || 'unknown') };
    if (envelope.ok !== true) return envelope.enabled === false
      ? { kind: 'unavailable', message: 'The plugin platform is turned off in this build.' }
      : { kind: 'refused', code: String(envelope.code || ''), reason: String(envelope.reason || '') };
    var plugins = Array.isArray(envelope.plugins) ? envelope.plugins : [];
    return { kind: 'ready', revision: Number.isInteger(envelope.revision) ? envelope.revision : 0,
      readOnly: envelope.read_only === true, storeWritable: envelope.store_writable === true,
      runtimeStatus: String(envelope.runtime_status || 'inactive'), recovery: envelope.recovery || null,
      installedCount: Number.isInteger(envelope.installed_count) ? envelope.installed_count : plugins.length,
      plugins: plugins.map(function (entry) { return {
        publisherId: String(entry?.publisher_id || ''), pluginId: String(entry?.plugin_id || ''),
        displayName: String(entry?.display_name || '').trim() || '(unnamed plugin)',
        version: String(entry?.resolved_version || ''), effectiveState: String(entry?.effective_state || ''),
        sourceKind: String(entry?.source_kind || ''),
        desiredState: String(entry?.desired_state || ''), activationEligible: entry?.activation_eligible === true,
        activationReasonCode: String(entry?.activation_reason_code || ''), generationId: String(entry?.generation_id || ''),
        contributions: Array.isArray(entry?.contributions) ? entry.contributions : [],
        updateAvailable: entry?.update_available === true,
      }; }) };
  }

  function formatWireFailure(result) {
    var source = result && typeof result === 'object' ? result : {};
    var code = String(source.code || source.error?.code || '').trim();
    var reason = String(source.reason || source.error?.message || '').trim();
    return code && reason ? code + ' · ' + reason : code || reason || 'The operation failed.';
  }
  function failureMessage(result) {
    var reason = String(result?.reason || '');
    return Object.hasOwn(LOCAL_FAILURE_COPY, reason) ? LOCAL_FAILURE_COPY[reason] : formatWireFailure(result);
  }
  function stateCopy(value) { return STATE_COPY[value] || 'state unavailable'; }
  function activationReasonCopy(value) {
    return Object.hasOwn(ACTIVATION_REASON_COPY, value)
      ? ACTIVATION_REASON_COPY[value] : 'activation unavailable';
  }
  function progressCopy(value) { return PROGRESS_COPY[value] || 'Working…'; }
  function pluginToggleId(plugin) { return 'pluginToggle_' + plugin.publisherId + '_' + plugin.pluginId; }
  function primaryViewContribution(plugin) {
    return plugin.contributions.find(function (item) {
      return item?.kind === 'setup_scene' || item?.kind === 'view' || Boolean(item?.view);
    }) || null;
  }

  function createPluginsSettingsController(deps) {
    var options = deps || {};
    var state = options.state || {};
    var windowRef = options.windowRef || root;
    var documentRef = options.documentRef || windowRef.document;
    var actionButton = root.inventoryActionButton;
    var textField = root.inventoryTextField;
    var platform = null;
    var catalog = null;
    var lastError = '';
    var progressText = '';
    var busyOperationId = '';
    var mirrorDraft = null;
    var mirrorError = '';
    var advancedExpanded = false;
    var disposed = false;
    var refreshPromise = null;
    var refreshPending = false;
    var pendingFocusIdentity = null;
    var unsubscribeChanged = null;
    var unsubscribeProgress = null;
    var unsubscribeFeatures = null;
    var confirmDialog = null;
    var details = null;
    function api() { return windowRef.jennyShell?.plugins || null; }
    function card() { return documentRef?.querySelector(CARD_SELECTOR) || null; }
    function nav() { return documentRef?.querySelector(NAV_SELECTOR) || null; }
    function host(id) { return documentRef?.getElementById(id) || null; }
    function enabled() { return state.features?.featureFlags?.plugins === true; }
    function toast(message, config) { if (!disposed) options.showToastMessage?.(message, config); }
    function log(level, event, data) { options.appendClientLog?.(level, event, data || {}); }
    var operations = operationsModule.createOperationCoordinator({ onChanged: function (active) {
      if (disposed) return;
      if (active && !progressText) progressText = 'Working…';
      details?.setBusy?.(Boolean(active));
      render();
    } });

    function detailsController() {
      if (!details) details = detailsModule.createPluginDetailsController({ documentRef: documentRef,
        overlayManager: options.overlayManager, actionButton: actionButton, getApi: api,
        onChanged: refresh });
      return details;
    }
    function ensureConfirmDialog() {
      if (confirmDialog) return confirmDialog;
      var factory = root.rendererIdeConfirmDialog?.createIdeConfirmDialog;
      var overlay = root.inventoryHelpOverlay?.createHelpOverlay;
      if (!factory || !overlay) return null;
      confirmDialog = factory({ document: documentRef, actionButton: actionButton,
        helpOverlayFactory: overlay, hostId: 'pluginsSettingsConfirmOverlay' });
      return confirmDialog;
    }
    async function confirmDanger(config) {
      try { return await ensureConfirmDialog()?.confirm?.({ ...config, variant: 'danger' }) === true; }
      catch (_error) { return false; }
    }
    function syncVisibility(show) {
      var item = nav(); var section = card();
      if (item) { item.setAttribute('data-feature-gated', 'plugins'); item.hidden = !show; item.classList.toggle('hidden', !show); }
      if (section) { section.hidden = !show; if (!show) section.classList.remove('settings-section-active'); }
      if (!show && state.ui?.activeSettingsSection === 'plugins') {
        options.openSettingsSection?.(root.rendererSettingsSectionRegistry?.getDefaultSettingsSection?.() || 'models');
      }
    }
    async function fetchState() {
      var bridge = api();
      if (!bridge?.getState) return { platform: classifyPluginsPlatform(false, null), catalog: null };
      var results = await Promise.allSettled([bridge.getState(),
        bridge.getCatalogState?.() || Promise.resolve({ ok: true, configured: false, entries: [], sources: [] })]);
      return { platform: results[0].status === 'fulfilled'
        ? classifyPluginsPlatform(true, results[0].value) : classifyPluginsPlatform(false, null),
        catalog: results[1].status === 'fulfilled' ? catalogModule.normalizeCatalogState(results[1].value) : null };
    }
    async function refresh() {
      if (disposed || !enabled()) return null;
      if (refreshPromise) { refreshPending = true; return refreshPromise; }
      refreshPromise = fetchState().then(function (next) {
        if (disposed) return next;
        if (refreshPending) { refreshPending = false; refreshPromise = null; return refresh(); }
        if (!platform || platform.kind !== 'ready' || next.platform.kind !== 'ready'
          || next.platform.revision >= platform.revision) platform = next.platform;
        if (!catalog || !next.catalog || next.catalog.revision >= catalog.revision) catalog = next.catalog;
        render(); return next;
      }).catch(function () {
        if (!disposed) log('INFO', 'plugins_settings.refresh_unavailable', {});
        return null;
      }).finally(function () { refreshPromise = null; });
      return refreshPromise;
    }

    function captureFocus() {
      var active = documentRef?.activeElement;
      if (!active || (!host(INSTALLED_HOST_ID)?.contains(active) && !host(SOURCES_HOST_ID)?.contains(active))) return null;
      if (active.dataset?.invToggle) return { kind: 'toggle', id: active.dataset.invToggle };
      if (active.dataset?.pluginsSettingsAction) return { kind: 'action', action: active.dataset.pluginsSettingsAction,
        publisherId: active.dataset.publisherId || '', pluginId: active.dataset.pluginId || '',
        contributionId: active.dataset.contributionId || '' };
      if (active.id === 'pluginMirrorSourceId') return { kind: 'id', id: active.id };
      return null;
    }
    function restoreFocus(identity) {
      if (!identity) return;
      var match = null;
      if (identity.kind === 'toggle') match = Array.from(documentRef.querySelectorAll('[data-inv-toggle]'))
        .find(function (node) { return node.dataset.invToggle === identity.id; });
      else if (identity.kind === 'action') match = Array.from(documentRef.querySelectorAll('[data-plugins-settings-action]'))
        .find(function (node) { return node.dataset.pluginsSettingsAction === identity.action
          && (node.dataset.publisherId || '') === identity.publisherId
          && (node.dataset.pluginId || '') === identity.pluginId
          && (node.dataset.contributionId || '') === identity.contributionId; });
      else if (identity.kind === 'id') match = documentRef.getElementById(identity.id);
      match?.focus?.();
    }
    function operationStatusMarkup() {
      return '<p class="settings-note plugins-operation-status" role="status" aria-live="polite" '
        + 'data-plugins-operation-status' + (progressText ? '' : ' hidden') + '>'
        + actionButton.escapeHtml(progressText) + '</p>';
    }
    function updateOperationStatus() {
      var node = documentRef?.querySelector('[data-plugins-operation-status]');
      if (!node) return;
      node.textContent = progressText;
      node.hidden = !progressText;
    }

    function headerActionsMarkup() {
      if (!actionButton || platform?.kind !== 'ready') return '';
      return actionButton({ label: 'Install plugin', variant: 'primary', size: 'sm',
        disabled: operations.busy() || platform.readOnly || !platform.storeWritable,
        dataset: { 'plugins-settings-action': 'install-package' } });
    }

    function dropZoneMarkup() {
      return '<div class="plugins-drop-zone" data-plugins-drop-zone>'
        + 'Drop a .jenny-plugin file here or use Install plugin. '
        + 'Unsigned plugins are labelled and run in the developer profile.</div>';
    }

    function installedMarkup(escapeHtml) {
      if (!platform.plugins.length) return '<div class="settings-note" data-plugins-empty-state>No plugins installed.</div>';
      return platform.plugins.map(function (plugin) {
        var active = plugin.effectiveState === 'active';
        var key = plugin.publisherId + '/' + plugin.pluginId;
        var primaryView = primaryViewContribution(plugin);
        var updateAvailable = plugin.updateAvailable || Boolean(catalog?.entries?.some(function (entry) {
          return entry.publisherId === plugin.publisherId && entry.pluginId === plugin.pluginId
            && catalogModule.isNewerVersion(entry.version, plugin.version);
        }));
        var reason = !active && !plugin.activationEligible ? activationReasonCopy(plugin.activationReasonCode) : '';
        var publisher = plugin.sourceKind === 'developer_link'
          ? 'developer (unsigned)' : plugin.publisherId || 'Publisher unavailable';
        var secondary = [plugin.version || 'Version unavailable', publisher,
          stateCopy(plugin.effectiveState)];
        if (updateAvailable) secondary.push('update available');
        if (reason) secondary.push('can’t start — ' + reason);
        var disabled = operations.busy() || platform.readOnly || !platform.storeWritable
          || (!active && !plugin.activationEligible);
        var viewReady = primaryView?.effective_enabled === true;
        var viewButton = primaryView ? actionButton({
          label: primaryView.kind === 'setup_scene' || primaryView.view?.view_kind === 'setup_scene' ? 'Set up' : 'Open',
          disabled: !viewReady, title: viewReady ? '' : detailsModule.viewBlockedTitle(primaryView),
          variant: 'ghost', size: 'sm', dataset: { 'plugins-settings-action': 'open-view',
            'publisher-id': plugin.publisherId, 'plugin-id': plugin.pluginId,
            'contribution-id': primaryView.contribution_id, 'generation-id': plugin.generationId,
            'display-name': primaryView.display_name || plugin.displayName } }) : '';
        var contributionAttr = primaryView ? ' data-contribution-id="' + escapeHtml(primaryView.contribution_id) + '"' : '';
        return '<div class="settings-field-row plugins-settings-row" data-plugin-row="' + escapeHtml(key) + '"'
          + contributionAttr + '><span class="settings-field-row-text"><strong>' + escapeHtml(plugin.displayName)
          + '</strong><small>' + escapeHtml(secondary.join(' · ')) + '</small></span>'
          + '<span class="plugins-settings-row-controls">' + viewButton
          + actionButton({ label: 'Details', variant: 'ghost', size: 'sm', ariaHaspopup: 'dialog', dataset: {
            'plugins-settings-action': 'details', 'publisher-id': plugin.publisherId,
            'plugin-id': plugin.pluginId, 'display-name': plugin.displayName } })
          + (root.inventoryToggleSwitch?.toggleSwitch?.({ id: pluginToggleId(plugin),
            label: plugin.displayName + ' enabled', checked: active, disabled: disabled,
            className: 'plugins-settings-row-toggle' }) || '') + '</span></div>';
      }).join('');
    }
    function installedGroupMarkup() {
      if (!actionButton) return '';
      var escapeHtml = actionButton.escapeHtml;
      var heading = '<h4 class="settings-group-heading" id="pluginsInstalledHeading">Installed</h4>';
      if (!platform) return '<div class="settings-group settings-group--wide plugins-settings-group" role="group" aria-labelledby="pluginsInstalledHeading" id="'
        + GROUP_ID + '">' + heading + '<div class="settings-note">Checking plugin platform…</div>' + operationStatusMarkup() + '</div>';
      if (platform.kind === 'safe_mode') return '<div class="settings-group settings-group--wide plugins-settings-group" role="group" aria-labelledby="pluginsInstalledHeading" id="'
        + GROUP_ID + '">' + heading + '<div class="settings-note plugins-safe-mode-banner" data-plugins-safe-mode>Plugins are in safe mode ('
        + escapeHtml(platform.source) + ').</div>' + operationStatusMarkup() + '</div>';
      if (platform.kind === 'unavailable') return '<div class="settings-group settings-group--wide plugins-settings-group" role="group" aria-labelledby="pluginsInstalledHeading" id="'
        + GROUP_ID + '">' + heading + '<div class="settings-note" data-plugins-unavailable>' + escapeHtml(platform.message)
        + '</div>' + operationStatusMarkup() + '</div>';
      if (platform.kind === 'refused') return '<div class="settings-group settings-group--wide plugins-settings-group" role="group" aria-labelledby="pluginsInstalledHeading" id="'
        + GROUP_ID + '">' + heading + '<div class="settings-note plugins-settings-error" data-plugins-refused>'
        + escapeHtml(formatWireFailure(platform)) + '</div>' + operationStatusMarkup() + '</div>';
      var readOnly = platform.readOnly || !platform.storeWritable
        ? '<div class="settings-note plugins-settings-error" data-plugins-read-only>Plugin state is read-only and preserved unchanged.</div>' : '';
      var error = lastError ? '<div class="settings-note plugins-settings-error" data-plugins-last-error>' + escapeHtml(lastError) + '</div>' : '';
      return '<div class="settings-group settings-group--wide plugins-settings-group" role="group" aria-labelledby="pluginsInstalledHeading" id="'
        + GROUP_ID + '">' + heading + '<p class="settings-group-copy">' + platform.installedCount + ' installed plugin'
        + (platform.installedCount === 1 ? '.' : 's.') + '</p>' + installedMarkup(escapeHtml)
        + dropZoneMarkup() + readOnly + error + operationStatusMarkup() + '</div>';
    }
    function mirrorFormMarkup(escapeHtml) {
      if (!mirrorDraft || !textField) return '';
      var error = mirrorError ? '<p class="settings-note plugins-settings-error" role="alert">' + escapeHtml(mirrorError) + '</p>' : '';
      return '<div class="plugins-mirror-form" data-plugins-mirror-form>'
        + textField({ id: 'pluginMirrorSourceId', label: 'Source ID', value: mirrorDraft.sourceId, maxLength: 64 })
        + '<p class="settings-group-copy">Use lowercase letters, numbers, underscores, or hyphens. This is the name the mirror is stored and shown under. Jenny will ask you to choose the mirror folder next.</p>'
        + error + '<div class="settings-actions">'
        + actionButton({ label: 'Choose mirror folder', size: 'sm', disabled: operations.busy(),
          dataset: { 'plugins-settings-action': 'save-mirror' } })
        + actionButton({ label: 'Cancel', variant: 'ghost', size: 'sm', disabled: operations.busy(),
          dataset: { 'plugins-settings-action': 'cancel-mirror' } }) + '</div></div>';
    }
    function sourcesGroupMarkup() {
      if (!actionButton || platform?.kind !== 'ready') return '';
      var escapeHtml = actionButton.escapeHtml;
      var unavailable = platform.readOnly || !platform.storeWritable;
      return '<div class="settings-group settings-group--wide plugins-settings-group" role="group" aria-labelledby="pluginsSourcesHeading" id="'
        + SOURCES_GROUP_ID + '"><h4 class="settings-group-heading" id="pluginsSourcesHeading">Advanced</h4>'
        + '<div class="settings-field-row plugins-advanced-summary"><span class="settings-field-row-text">'
        + '<strong>Package sources</strong><small>'
        + escapeHtml(catalog?.configured ? catalog.entries.length + ' catalog entr' + (catalog.entries.length === 1 ? 'y' : 'ies')
          : 'No catalog configured') + ' · offline mirrors · audit log</small></span>'
        + actionButton({ label: 'Open', variant: 'ghost', size: 'sm', ariaExpanded: advancedExpanded,
          ariaControls: 'pluginsAdvancedDisclosure', dataset: { 'plugins-settings-action': 'toggle-advanced' } })
        + '</div><div class="plugins-advanced-disclosure" id="pluginsAdvancedDisclosure" data-plugins-advanced-disclosure'
        + (advancedExpanded ? '' : ' hidden') + '><div class="plugin-catalog-list">'
        + catalogModule.renderCatalog(catalog, platform.plugins, actionButton, escapeHtml, operations.busy()) + '</div>'
        + mirrorFormMarkup(escapeHtml) + '<div class="settings-actions plugins-sources-actions">'
        + actionButton({ label: 'Add offline mirror', size: 'sm', disabled: operations.busy() || unavailable,
          dataset: { 'plugins-settings-action': 'add-mirror' } })
        + actionButton({ label: 'Install signed package', size: 'sm', disabled: operations.busy() || unavailable,
          dataset: { 'plugins-settings-action': 'install-package' } })
        + actionButton({ label: 'Export audit log', size: 'sm', disabled: operations.busy(),
          dataset: { 'plugins-settings-action': 'export-audit' } }) + '</div></div></div>';
    }
    function render() {
      if (disposed) return;
      var headerHost = host(HEADER_ACTIONS_HOST_ID); var installedHost = host(INSTALLED_HOST_ID);
      var sourcesHost = host(SOURCES_HOST_ID);
      if (!headerHost || !installedHost || !sourcesHost) return;
      var focus = captureFocus() || pendingFocusIdentity;
      if (focus) pendingFocusIdentity = focus;
      if (!enabled()) { headerHost.innerHTML = ''; installedHost.innerHTML = ''; sourcesHost.innerHTML = '';
        pendingFocusIdentity = null; return; }
      headerHost.innerHTML = headerActionsMarkup();
      installedHost.innerHTML = installedGroupMarkup();
      sourcesHost.innerHTML = sourcesGroupMarkup();
      restoreFocus(focus);
      if (!operations.busy()) pendingFocusIdentity = null;
    }
    async function afterOperation(result, successMessage, reloadDetails) {
      if (disposed) return result;
      if (result?.canceled === true) { busyOperationId = ''; progressText = ''; updateOperationStatus(); return result; }
      if (result?.ok) { lastError = ''; if (successMessage) toast(successMessage); }
      else { lastError = failureMessage(result); toast(lastError, { tone: 'warning' }); }
      busyOperationId = ''; progressText = '';
      await refresh();
      if (!disposed && result?.ok && reloadDetails) await details?.reload?.();
      return result;
    }
    async function runSimple(name, payload, successMessage, reloadDetails) {
      var bridge = api();
      if (typeof bridge?.[name] !== 'function') {
        lastError = LOCAL_FAILURE_COPY.bridge_method_missing;
        toast(lastError, { tone: 'warning' });
        log('WARN', 'plugins_settings.bridge_method_missing', { name: name });
        render(); return { ok: false, reason: 'bridge_method_missing' };
      }
      var result;
      try { result = await operations.run(name, function () { return bridge[name](payload); }); }
      catch (_error) { result = { ok: false, reason: 'bridge_call_failed' };
        log('WARN', 'plugins_settings.bridge_call_failed', { name: name }); }
      return afterOperation(result, successMessage, reloadDetails);
    }
    async function exportAudit() {
      var bridge = api();
      if (typeof bridge?.exportAudit !== 'function') { await runSimple('exportAudit', {}); return; }
      var result;
      try { result = await operations.run('export-audit', function () { return bridge.exportAudit({}); }); }
      catch (_error) { result = { ok: false, reason: 'bridge_call_failed' }; }
      if (disposed) return;
      if (!result?.ok) { await afterOperation(result); return; }
      try {
        await windowRef.jennyShell?.dialog?.saveFile?.({ title: 'Export plugin audit log',
          defaultName: 'jenny-plugin-audit-' + new Date().toISOString().slice(0, 10) + '.json',
          format: 'json', content: JSON.stringify(result.document, null, 2) });
      } catch (_error) {
        if (disposed) return;
        lastError = 'Could not save the plugin audit log. Try again.';
        log('WARN', 'plugins_settings.audit_export_save_failed', { reason: 'save_failed' });
        toast(lastError, { tone: 'warning' });
      }
      if (!disposed) render();
    }
    async function uninstall(target) {
      var identity = { publisher_id: target.dataset.publisherId, plugin_id: target.dataset.pluginId };
      if (!await confirmDanger({ title: 'Uninstall ' + (target.dataset.displayName || 'plugin') + '?',
        message: 'Remove this plugin and revoke its active contributions?', confirmLabel: 'Uninstall', cancelLabel: 'Keep' })) return;
      if (disposed) return;
      var result = await runSimple('uninstall', identity, 'Plugin uninstalled.');
      if (!disposed && result?.ok) details?.close?.();
    }
    function catalogPayload(target) { return { source_id: target.dataset.sourceId,
      publisher_id: target.dataset.publisherId, plugin_id: target.dataset.pluginId,
      version: target.dataset.version, package_sha256: target.dataset.packageSha256 }; }
    async function saveMirror() {
      if (!mirrorDraft || operations.busy()) return;
      var sourceId = String(mirrorDraft.sourceId || '').trim();
      mirrorError = SOURCE_ID_RE.test(sourceId) ? ''
        : 'Source ID must start with a letter and use only lowercase letters, numbers, underscores, or hyphens.';
      if (mirrorError) { render(); return; }
      var result = await runSimple('selectOfflineMirror', { source_id: sourceId }, 'Offline mirror trusted.');
      if (disposed || result?.canceled === true) return;
      if (result?.ok) { mirrorDraft = null; mirrorError = ''; render(); }
    }
    function handleClick(event) {
      var target = event.target?.closest?.('[data-plugins-settings-action]'); if (!target) return;
      var action = target.dataset.pluginsSettingsAction;
      if (action === 'details') detailsController().open({ publisherId: target.dataset.publisherId,
        pluginId: target.dataset.pluginId, displayName: target.dataset.displayName }, target);
      else if (action === 'open-view') options.openPluginView?.({ publisher_id: target.dataset.publisherId,
        plugin_id: target.dataset.pluginId, contribution_id: target.dataset.contributionId,
        generation_id: target.dataset.generationId, display_name: target.dataset.displayName });
      else if (action === 'enable' || action === 'disable') runSimple(action,
        { publisher_id: target.dataset.publisherId, plugin_id: target.dataset.pluginId },
        action === 'enable' ? 'Plugin enabled.' : 'Plugin disabled.', true);
      else if (action === 'uninstall') uninstall(target);
      else if (action === 'install-package') runSimple('installLocalPackage', {}, 'Plugin installed — inactive.');
      else if (action === 'toggle-advanced') { advancedExpanded = !advancedExpanded; render(); }
      else if (action === 'export-audit') exportAudit();
      else if (action === 'add-mirror') { mirrorDraft = { sourceId: '' }; mirrorError = ''; render();
        documentRef.getElementById('pluginMirrorSourceId')?.focus?.(); }
      else if (action === 'cancel-mirror') { mirrorDraft = null; mirrorError = ''; render(); }
      else if (action === 'save-mirror') saveMirror();
      else if (action === 'catalog-install') runSimple('installFromCatalog', catalogPayload(target), 'Plugin installed — inactive.');
      else if (action === 'catalog-update') runSimple('updateFromCatalog', catalogPayload(target), 'Plugin updated — inactive.');
    }
    function handleInput(event) {
      if (!mirrorDraft) return;
      if (event.target?.id === 'pluginMirrorSourceId') mirrorDraft.sourceId = event.target.value;
    }
    function handleToggleChange(event) {
      var id = String(event.detail?.id || '');
      if (!id || !platform || platform.kind !== 'ready') return;
      var plugin = platform.plugins.find(function (item) { return pluginToggleId(item) === id; });
      if (!plugin) return;
      var action = event.detail?.checked === true ? 'enable' : 'disable';
      void runSimple(action, { publisher_id: plugin.publisherId, plugin_id: plugin.pluginId },
        action === 'enable' ? 'Plugin enabled.' : 'Plugin disabled.', true);
    }
    function handleDropZoneEvent(event) {
      var zone = event.target?.closest?.('[data-plugins-drop-zone]');
      if (!zone || !host(INSTALLED_HOST_ID)?.contains(zone)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'dragover') { zone.classList.add('is-active'); return; }
      zone.classList.remove('is-active');
      if (event.type !== 'drop') return;
      var file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (!String(file.name || '').toLowerCase().endsWith('.jenny-plugin')) {
        toast('Choose a .jenny-plugin file.');
        return;
      }
      var getPathForFile = windowRef.jennyShell?.attachments?.getPathForFile;
      var packagePath;
      try { packagePath = typeof getPathForFile === 'function' ? String(getPathForFile(file) || '').trim() : ''; }
      catch (_error) { packagePath = ''; }
      if (!packagePath) {
        toast("Couldn't read that file. Use Install plugin instead.");
        return;
      }
      if (!packagePath.toLowerCase().endsWith('.jenny-plugin')) {
        toast('Choose a .jenny-plugin file.');
        return;
      }
      void runSimple('installLocalPackageFromPath', {
        client_request_id: 'drop_' + Date.now().toString(36), path: packagePath,
      }, 'Plugin installed — inactive.');
    }
    function handleOperationProgress(payload) {
      if (disposed || !operations.busy()) return;
      var operationId = String(payload?.operation_id || '');
      if (busyOperationId && operationId && operationId !== busyOperationId) return;
      if (operationId) busyOperationId = operationId;
      progressText = progressCopy(String(payload?.event?.phase || payload?.status || ''));
      updateOperationStatus();
    }
    function subscribe() {
      var bridge = api();
      if (!unsubscribeChanged && bridge?.onChanged) unsubscribeChanged = bridge.onChanged(function () { refresh(); });
      if (!unsubscribeProgress && bridge?.onOperationProgress) unsubscribeProgress = bridge.onOperationProgress(handleOperationProgress);
    }
    function syncFeatureState() {
      var show = enabled(); syncVisibility(show); if (!show) { render(); return; }
      subscribe(); refresh();
      if (api()?.refreshCatalogs) api().refreshCatalogs().then(function () { if (!disposed) refresh(); }).catch(function () {});
    }
    function bind() {
      if (disposed || !documentRef) return;
      root.inventoryToggleSwitch?.initToggleHandlers?.(documentRef);
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('input', handleInput);
      documentRef.addEventListener('inv-toggle-change', handleToggleChange);
      host(INSTALLED_HOST_ID)?.addEventListener('dragover', handleDropZoneEvent);
      host(INSTALLED_HOST_ID)?.addEventListener('dragleave', handleDropZoneEvent);
      host(INSTALLED_HOST_ID)?.addEventListener('drop', handleDropZoneEvent);
      var features = windowRef.jennyShell?.features;
      if (features?.onChanged) unsubscribeFeatures = features.onChanged(syncFeatureState);
      syncFeatureState();
    }
    function dispose() {
      disposed = true;
      documentRef?.removeEventListener('click', handleClick);
      documentRef?.removeEventListener('input', handleInput);
      documentRef?.removeEventListener('inv-toggle-change', handleToggleChange);
      host(INSTALLED_HOST_ID)?.removeEventListener('dragover', handleDropZoneEvent);
      host(INSTALLED_HOST_ID)?.removeEventListener('dragleave', handleDropZoneEvent);
      host(INSTALLED_HOST_ID)?.removeEventListener('drop', handleDropZoneEvent);
      [unsubscribeChanged, unsubscribeProgress, unsubscribeFeatures].forEach(function (unsubscribe) {
        try { unsubscribe?.(); } catch (_error) { /* disposal remains best effort */ }
      });
      unsubscribeChanged = unsubscribeProgress = unsubscribeFeatures = null;
      confirmDialog?.dispose?.(); details?.dispose?.(); operations.dispose();
    }
    var instance = { bind: bind, dispose: dispose, render: render, refresh: refresh, syncFeatureState: syncFeatureState,
      _test: { buildInstalledGroupMarkup: installedGroupMarkup, buildSourcesGroupMarkup: sourcesGroupMarkup,
        handleOperationProgress: handleOperationProgress, getPlatform: function () { return platform; },
        setPlatform: function (value) { platform = value; }, getLastError: function () { return lastError; } } };
    return instance;
  }
  return { createPluginsSettingsController: createPluginsSettingsController,
    classifyPluginsPlatform: classifyPluginsPlatform, formatWireFailure: formatWireFailure,
    stateCopy: stateCopy, activationReasonCopy: activationReasonCopy, progressCopy: progressCopy,
    failureMessage: failureMessage,
    isNewerVersion: catalogModule.isNewerVersion };
});
