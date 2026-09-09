/* Settings > Remote Control. Core renderer over the descriptor-backed remote.* bridge. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/action-button'),
      require('../inventory/url-field'),
      require('../inventory/text-field'),
      require('../inventory/status-row'),
      require('../inventory/collapsible')
    );
    return;
  }
  root.rendererSettingsRemoteSection = factory(
    root.inventoryActionButton,
    root.inventoryUrlField,
    root.inventoryTextField,
    root.inventoryStatusRow,
    root.inventoryCollapsible
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  injectedActionButton,
  injectedUrlField,
  injectedTextField,
  injectedStatusRow,
  injectedCollapsible
) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const STATE_PRESENTATION = Object.freeze({
    off: ['Off', 'default'],
    starting: ['Connecting', 'pending'],
    connecting: ['Connecting', 'pending'],
    ready: ['Ready', 'success'],
    reconnecting: ['Reconnecting', 'warning'],
    stopping: ['Stopping', 'warning'],
    unavailable: ['Unavailable', 'danger'],
  });
  const REMOTE_PLUGIN_ID = 'remote-control';
  const REMOTE_PLUGIN_PUBLISHER = 'jenny-official';
  const REASON_LIMIT = 160;
  const GENERIC_FAILURE_COPY = jt('settings.remote.setup.failure', 'Something went wrong. Try again.');
  const REASON_COPY = Object.freeze(Object.fromEntries(`
app_quit|Remote Control is stopping because Jenny is closing.
claim_rejected|Your relay refused this connection. Check that Jenny is using the correct relay address.
claim_send_failed|Jenny couldn't finish connecting to your relay. Try again.
claim_timeout,relay_claim_timeout|Your relay didn't confirm the connection in time. Try again.
connect_failed|Jenny couldn't reach your relay. Check your internet connection and relay address.
disabled,remote_disabled|Remote Control is off.
displaced|Another Jenny connection replaced this one.
dispose|Remote Control is shutting down.
disposed|Remote Control has shut down.
enable_cancelled|Connection cancelled.
enable_failed|Jenny couldn't turn on Remote Control. Try again.
feature_disabled|Remote Control is disabled for this Jenny installation.
forget_all|Removing paired phones and saved relay settings…
forget_not_deleted|Jenny couldn't finish removing saved access. Remote Control remains blocked. Try Forget all devices again.
heartbeat_timeout|Your relay stopped responding.
idle_timeout|The connection closed after a period of inactivity.
lease_expired|Your relay connection expired.
load_failed|Jenny couldn't load your saved Remote Control settings.
no_desktop|Your relay has no active Jenny connection.
not_reachable|Connect Jenny to your relay before adding a phone.
plugin_disabled,plugin_inactive|Enable the Remote Control plugin in Settings → Plugins.
plugin_state_unavailable|Jenny couldn't check whether the Remote Control plugin is enabled.
rate_limited|Your relay received too many requests. Wait a moment and try again.
ready|Connected to your relay.
relay_error|Jenny couldn't complete the relay connection. Check the address and try again.
relay_host_changed|The connection led to a different relay address. Jenny stopped it. Check the address you entered.
relay_reconnecting|Reconnecting to your relay…
relay_not_set|Set up and save your relay before turning on Remote Control.
relay_url_invalid|Enter your relay's address, such as https://name.account.workers.dev.
revocation_not_saved|Jenny couldn't save the phone's removal. Remote Control remains blocked.
socket_closed|The connection to your relay closed.
starting|Connecting to your relay…
storage_unavailable|Your relay's storage is unavailable. Check its Cloudflare deployment.
websocket_unavailable|This Jenny installation can't open the required connection. Restart Jenny; if this continues, update Jenny.
window_closed|Remote Control stopped because the Jenny window closed.
window_unavailable|Open the Jenny window to use Remote Control.
remote_unavailable|Remote Control is unavailable. Restart Jenny and try again.
not_off|Turn Remote Control off before changing its setup.
pairing_unavailable|Jenny couldn't create a pairing code. Try Add device again.
secure_store_error|Jenny couldn't securely read or save your Remote Control settings.
record_malformed|Jenny couldn't read your saved Remote Control settings.
record_version_unsupported|These Remote Control settings require a newer Jenny version.
store_not_loaded|Remote Control settings haven't finished loading. Try again.
device_not_found|This phone is no longer paired.
device_revoked|This phone's access has been removed.
device_exists|This phone is already paired.
device_limit|The paired-phone limit has been reached. Remove a phone before adding another.
device_malformed|Jenny couldn't use this phone's pairing details. Pair it again.
session_id_invalid,session_not_shareable|This chat can't be shared with your phone.
shared_sessions_limit|The shared-chat limit has been reached. Remove access to a chat first.
epoch_invalid,grant_suppressed|This connection is no longer active. Reconnect before sharing the chat.
invalid_request|Jenny couldn't process that request. Refresh this section and try again.
clipboard_unavailable|Select and copy the link manually.
`.trim().split(/\r?\n/).flatMap((row) => {
    const separator = row.indexOf('|');
    const codes = row.slice(0, separator).split(',');
    return codes.map((code) => [code, row.slice(separator + 1)]);
  })));
  const NON_FAILURE_REASONS = new Set(
    ['app_quit', 'disabled', 'remote_disabled', 'dispose', 'disposed', 'enable_cancelled',
      'forget_all', 'ready', 'relay_reconnecting', 'starting', 'window_closed']
  );
  const RELAY_COMMANDS = Object.freeze(['npm --prefix remote/relay ci',
    'npm --prefix remote/relay exec wrangler login', 'npm run remote:relay:deploy']);

  function escapeMarkup(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function boundedText(value, limit = REASON_LIMIT) {
    return Array.from(String(value == null ? '' : value).trim()).slice(0, limit).join('');
  }

  function reasonCopy(code) {
    return REASON_COPY[boundedText(code)] || GENERIC_FAILURE_COPY;
  }

  function invalidRelay() {
    return { ok: false, reason: 'relay_url_invalid' };
  }

  function normalizeRelayInput(text) {
    let value = String(text == null ? '' : text).trim();
    const hasControl = Array.from(value).some((character) => character.charCodeAt(0) < 32
      || character.charCodeAt(0) === 127);
    if (!value || /[\s\\]/.test(value) || hasControl) return invalidRelay();
    const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (schemeMatch) {
      if (!/^(https|wss)$/i.test(schemeMatch[1])) return invalidRelay();
      value = value.slice(schemeMatch[0].length);
    } else if (/^(?:https?|wss?):/i.test(value) || value.includes('://')) return invalidRelay();
    if (value.endsWith('/')) value = value.slice(0, -1);
    if (!value || /[/@?#]/.test(value)) return invalidRelay();
    const match = value.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!match) return invalidRelay();
    const host = match[1];
    const port = match[2] || '';
    const portNumber = port ? Number(port) : 443;
    if (!host || (port && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535))) {
      return invalidRelay();
    }
    return { ok: true, relay_url: 'wss://' + host.toLowerCase() + (port && portNumber !== 443 ? ':' + port : '') };
  }

  function normalizeStatus(value, pluginEnabled) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const state = boundedText(source.state, 32).toLowerCase() || 'unavailable';
    const reason = boundedText(source.reason);
    const relayHost = boundedText(source.relay_host, 512);
    const setupProvided = source._setup_authoritative === true
      || (source._setup_authoritative !== false
        && Object.prototype.hasOwnProperty.call(source, 'setup'));
    const sourcePluginEnabled = typeof source.plugin_enabled === 'boolean'
      ? source.plugin_enabled
      : (typeof source.pluginEnabled === 'boolean' ? source.pluginEnabled : pluginEnabled);
    const effectivePluginEnabled = typeof sourcePluginEnabled === 'boolean'
      ? sourcePluginEnabled
      : (['plugin_inactive', 'plugin_disabled', 'feature_disabled'].includes(reason) ? false : null);
    const canConfigure = state === 'off' && effectivePluginEnabled !== false;
    const canEnable = canConfigure && Boolean(relayHost);
    const setupSource = setupProvided && source.setup && typeof source.setup === 'object'
      ? source.setup : null;
    const setup = setupProvided ? {
      loaded: setupSource?.loaded === true,
      can_configure: setupSource?.can_configure === true,
      can_enable: setupSource?.can_enable === true,
      reason: boundedText(setupSource?.reason),
    } : {
      loaded: true,
      can_configure: canConfigure,
      can_enable: canEnable,
      reason: canEnable ? '' : (state !== 'off'
        ? 'not_off' : (effectivePluginEnabled === false ? 'plugin_inactive' : 'relay_not_set')),
    };
    return {
      state,
      reachable: source.reachable === true,
      reason,
      relay_host: relayHost,
      epoch_active: source.epoch_active === true,
      pairing: source.pairing && typeof source.pairing === 'object' ? source.pairing : null,
      devices: Array.isArray(source.devices) ? source.devices.slice(0, 64) : [],
      shared_sessions: Array.isArray(source.shared_sessions) ? source.shared_sessions.slice(0, 64) : [],
      last_error: source.last_error && typeof source.last_error === 'object' ? source.last_error : null,
      plugin_enabled: source.plugin_enabled,
      setup,
      _setup_authoritative: setupProvided,
      _normalized_status: true,
    };
  }

  function presentRemoteStatus(value, options = {}) {
    const status = value?._normalized_status === true ? value : normalizeStatus(value);
    const presentation = STATE_PRESENTATION[status.state] || STATE_PRESENTATION.unavailable;
    const isFailure = status.reason && !NON_FAILURE_REASONS.has(status.reason);
    let message;
    if (status.state === 'unavailable' || isFailure) message = reasonCopy(status.reason);
    else if (status.state === 'starting' || status.state === 'connecting') message = reasonCopy('starting');
    else if (status.state === 'reconnecting') message = reasonCopy('relay_reconnecting');
    else if (status.state === 'stopping') message = jt('settings.remote.setup.stopping', 'Turning Remote Control off…');
    else if (status.state === 'ready' && status.pairing) {
      message = jt('settings.remote.setup.scan', "Scan this code with your phone's camera. Keep Jenny open.");
    } else if (status.state === 'ready' && options.pairedBefore != null
      && status.devices.length > Number(options.pairedBefore)) {
      message = jt('settings.remote.setup.paired', 'Phone paired. Setup is complete. Start a new chat on your phone, or share the current chat below.');
    } else if (status.state === 'ready' && !status.devices.length) {
      message = jt('settings.remote.setup.addPhone', 'Connected to your relay. Add your phone to finish setup.');
    } else if (status.state === 'ready' && status.devices.some((device) => device?.connected === true)) {
      message = jt('settings.remote.setup.connected', 'Your phone is connected. Keep Jenny open while using Remote Control.');
    } else if (status.state === 'ready') {
      message = jt('settings.remote.setup.offline', 'Your phone is paired and currently offline. Open the saved Jenny page on your phone to reconnect.');
    } else if (status.state === 'off' && status.setup.can_enable) {
      message = jt('settings.remote.setup.saved', 'Relay saved. Turn on Remote Control to connect your phone.');
    } else if (status.state === 'off') message = reasonCopy(status.setup.reason);
    else message = reasonCopy(status.reason);
    return { label: presentation[0], tone: presentation[1], message };
  }

  function pluginEnabledFromState(value) {
    const plugins = Array.isArray(value?.plugins) ? value.plugins : null;
    if (!plugins) return null;
    return plugins.some((plugin) => plugin?.publisher_id === REMOTE_PLUGIN_PUBLISHER
      && plugin?.plugin_id === REMOTE_PLUGIN_ID
      && plugin?.effective_state === 'active');
  }

  function createRemoteSettingsSection(options = {}) {
    const shell = options.shell || {};
    const remote = shell.remote || {};
    const callbacks = options.callbacks || {};
    const appendClientLog = typeof callbacks.appendClientLog === 'function'
      ? callbacks.appendClientLog : function noopLog() {};
    const getCurrentSessionId = typeof callbacks.getCurrentSessionId === 'function'
      ? callbacks.getCurrentSessionId : () => '';
    const now = typeof callbacks.now === 'function' ? callbacks.now : Date.now;
    const scheduleInterval = typeof callbacks.setInterval === 'function'
      ? callbacks.setInterval : setInterval;
    const cancelInterval = typeof callbacks.clearInterval === 'function'
      ? callbacks.clearInterval : clearInterval;
    const actionButton = injectedActionButton;
    const urlField = injectedUrlField;
    const textField = injectedTextField;
    const statusRow = injectedStatusRow;
    const collapsible = injectedCollapsible;
    const suppliedDom = options.dom || {};
    const section = suppliedDom.section || suppliedDom.remoteSettingsSection || null;
    const documentRef = suppliedDom.document || section?.ownerDocument
      || (typeof document !== 'undefined' ? document : null);
    const navigatorRef = suppliedDom.navigator || documentRef?.defaultView?.navigator
      || (typeof navigator !== 'undefined' ? navigator : null);
    const byId = (id) => suppliedDom[id] || documentRef?.getElementById?.(id) || null;
    const listeners = [];
    const pending = new Set();
    let status = normalizeStatus(null);
    let pluginEnabled = null;
    let disposed = false;
    let refreshVersion = 0;
    let pluginReadVersion = 0;
    let unsubscribeRemote = null;
    let unsubscribePlugins = null;
    let countdownTimer = null;
    let countdownKey = '';
    let relayDraft = null;
    let setupExpandedOverride = null;
    let pairedBefore = null;
    let pairingProducedDevice = false;

    function mountInventory(hostId, builder, config) {
      const host = byId(hostId);
      if (host && typeof builder === 'function' && !host.firstElementChild) host.innerHTML = builder(config);
    }

    mountInventory('remoteStatusHost', statusRow, {
      label: jt('settings.remote.title', 'Remote Control'), message: '', badgeText: '', className: 'remote-status-row',
    });
    const statusMessage = byId('remoteStatusHost')?.querySelector?.('.inv-status-row-message');
    if (statusMessage) {
      const statusText = documentRef.createElement('span');
      statusText.id = 'remoteStateText';
      statusMessage.append(statusText);
    }
    mountInventory('remoteRelayFieldHost', urlField, {
      id: 'remoteRelayInput', label: jt('settings.remote.relayUrlLabel', 'Relay address'), placeholder: jt('settings.remote.relayUrlPlaceholder', 'https://name.account.workers.dev'),
    });
    mountInventory('remotePairingLinkHost', textField, {
      id: 'remotePairingLink', label: jt('settings.remote.pairingLinkLabel', 'Pairing link'), readonly: true, ariaLabel: jt('settings.remote.pairingLinkLabel', 'Pairing link'),
    });
    const sharedListHost = byId('remoteSharedSessionsList');
    if (sharedListHost?.parentNode && !byId('remoteShareCurrentHost')) {
      const shareHost = documentRef.createElement('div');
      shareHost.id = 'remoteShareCurrentHost';
      shareHost.className = 'remote-group-heading-row';
      sharedListHost.parentNode.insertBefore(shareHost, sharedListHost);
    }
    const buttons = [
      ['remoteRelaySaveHost', { domId: 'remoteRelaySave', id: 'remote-relay-save', label: jt('common.save', 'Save'), variant: 'secondary' }],
      ['remotePrimaryActionHost', { domId: 'remotePrimaryAction', id: 'remote-primary', label: jt('settings.remote.turnOn', 'Turn on'), variant: 'primary' }],
      ['remoteAddDeviceHost', { domId: 'remoteAddDevice', id: 'remote-add-device', label: jt('settings.remote.addDevice', 'Add device'), variant: 'secondary', size: 'sm' }],
      ['remotePairingCopyHost', { domId: 'remotePairingCopy', id: 'remote-pairing-copy', label: jt('common.copy', 'Copy'), variant: 'secondary', size: 'sm' }],
      ['remoteShareCurrentHost', { domId: 'remoteShareCurrent', id: 'remote-share-current', label: jt('settings.remote.shareCurrentChat', 'Share current chat'), variant: 'secondary', size: 'sm' }],
      ['remoteForgetAllHost', { domId: 'remoteForgetAll', id: 'remote-forget-all', label: jt('settings.remote.forgetAllDevices', 'Forget all devices'), variant: 'danger' }],
      ['remoteForgetCancelHost', { domId: 'remoteForgetCancel', id: 'remote-forget-cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary', size: 'sm' }],
      ['remoteForgetConfirmHost', { domId: 'remoteForgetConfirmButton', id: 'remote-forget-confirm', label: jt('settings.remote.forgetAll', 'Forget all'), variant: 'danger', size: 'sm' }],
    ];
    buttons.forEach(([hostId, config]) => mountInventory(hostId, actionButton, config));

    const setupHost = byId('remoteSetupHost');
    let setupTrigger = null;
    if (setupHost && collapsible?.trigger && collapsible?.content) {
      const steps = byId('remoteSetupStepsTemplate')?.innerHTML || '';
      const commands = byId('remoteTerminalCommandsTemplate')?.innerHTML || '';
      setupHost.innerHTML = '<div class="remote-setup-card"><h4></h4>'
        + collapsible.trigger({
          id: 'remoteSetupSteps', children: escapeMarkup(jt('settings.remote.setup.how', 'How to set up')), open: true, className: 'remote-setup-trigger',
        })
        + collapsible.content({
          id: 'remoteSetupSteps', children: steps, open: true, className: 'remote-setup-content',
        }) + '</div>';
      setupHost.querySelector('h4').textContent = jt('settings.remote.setup.heading', 'Set up phone access');
      const terminalHost = byId('remoteTerminalHost');
      if (terminalHost) terminalHost.innerHTML = collapsible.trigger({
        id: 'remoteTerminalSetup', children: escapeMarkup(jt('settings.remote.setup.terminal', 'Deploy from a terminal (needs the Jenny source folder and Node)')),
        className: 'remote-terminal-trigger',
      }) + collapsible.content({ id: 'remoteTerminalSetup', children: commands, className: 'remote-terminal-content' });
      setupHost.querySelectorAll('[data-remote-command-copy]').forEach((host) => {
        const index = host.dataset.remoteCommandCopy;
        host.innerHTML = actionButton({ domId: 'remoteCommandCopy' + index,
          id: 'remote-command-copy-' + index, label: jt('common.copy', 'Copy'), size: 'sm', title: jt('settings.remote.setup.copyCommand', 'Copy command') });
      });
      setupTrigger = setupHost.querySelector('[data-inv-collapsible="remoteSetupSteps"]');
      const terminalTrigger = setupHost.querySelector('[data-inv-collapsible="remoteTerminalSetup"]');
      setupTrigger?.setAttribute('title', jt('settings.remote.setup.toggleSteps', 'Show or hide the setup steps'));
      terminalTrigger?.setAttribute('title', jt('settings.remote.setup.toggleCommands', 'Show or hide terminal setup commands'));
    }

    const ui = {
      statusRow: byId('remoteStatusHost')?.querySelector?.('.inv-status-row'),
      stateText: byId('remoteStateText'),
      statusMessage: byId('remoteStatusMessage'),
      setupHost,
      setupTrigger,
      relayInput: byId('remoteRelayInput'),
      relaySave: byId('remoteRelaySave'),
      relaySummary: byId('remoteRelaySummary'),
      actionStatus: byId('remoteActionStatus'),
      primary: byId('remotePrimaryAction'),
      addDevice: byId('remoteAddDevice'),
      pairingCard: byId('remotePairingCard'),
      pairingQr: byId('remotePairingQr'),
      pairingLink: byId('remotePairingLink'),
      pairingCopy: byId('remotePairingCopy'),
      pairingCountdown: byId('remotePairingCountdown'),
      devicesList: byId('remoteDevicesList'),
      sharedList: byId('remoteSharedSessionsList'),
      shareCurrentHost: byId('remoteShareCurrentHost'),
      shareCurrent: byId('remoteShareCurrent'),
      forgetAll: byId('remoteForgetAll'),
      forgetConfirm: byId('remoteForgetConfirm'),
      forgetCancel: byId('remoteForgetCancel'),
      forgetConfirmButton: byId('remoteForgetConfirmButton'),
    };

    function listen(target, eventName, handler) {
      if (!target?.addEventListener) return;
      target.addEventListener(eventName, handler);
      listeners.push(() => target.removeEventListener(eventName, handler));
    }

    function setCollapsibleState(triggerEl, expanded) {
      if (!triggerEl) return;
      triggerEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      const content = documentRef.getElementById(triggerEl.getAttribute('aria-controls'));
      if (!content) return;
      content.hidden = !expanded;
      content.dataset.state = expanded ? 'open' : 'closed';
      content.classList.toggle('expanded', expanded);
      content.style.maxHeight = expanded ? 'none' : '';
    }

    function bindCollapsible(triggerEl, onToggle) {
      const remember = () => onToggle(triggerEl.getAttribute('aria-expanded') !== 'true');
      listen(triggerEl, 'click', remember);
      listen(triggerEl, 'keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') remember();
      });
    }

    function selectCodeText(codeElement) {
      const selection = documentRef.defaultView?.getSelection?.();
      if (!selection || !documentRef.createRange) return;
      const range = documentRef.createRange();
      range.selectNodeContents(codeElement);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    function renderSetupGuide() {
      if (!ui.setupHost) return;
      const relayDone = Boolean(status.relay_host);
      const conditions = { relay: relayDone, connect: relayDone, pair: status.devices.length > 0 };
      let foundCurrent = false;
      ui.setupHost.querySelectorAll('[data-remote-step]').forEach((step) => {
        const done = conditions[step.dataset.remoteStep] === true;
        const stepState = done ? 'done' : (!foundCurrent ? 'current' : 'todo');
        if (!done && !foundCurrent) foundCurrent = true;
        step.dataset.stepState = stepState;
      });
      const expanded = setupExpandedOverride == null ? !relayDone : setupExpandedOverride;
      if (ui.setupTrigger?.getAttribute('aria-expanded') !== String(expanded)) {
        setCollapsibleState(ui.setupTrigger, expanded);
      }
    }

    function logFailure(operation, reason) {
      try {
        appendClientLog('WARN', 'remote.settings_operation_failed', {
          operation: boundedText(operation, 48), reason: boundedText(reason),
        });
      } catch (_error) { /* logging is optional */ }
    }

    function showFailure(operation, result) {
      const reason = boundedText(result?.reason || 'operation_failed');
      if (ui.actionStatus) ui.actionStatus.textContent = reasonCopy(reason);
      logFailure(operation, reason);
    }

    function clearCountdown() {
      if (countdownTimer != null) cancelInterval(countdownTimer);
      countdownTimer = null;
      countdownKey = '';
    }

    function renderCountdown() {
      const expiry = Number(status.pairing?.expires_at);
      const remaining = Number.isFinite(expiry) ? Math.max(0, expiry - Number(now())) : 0;
      const totalSeconds = Math.ceil(remaining / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (ui.pairingCountdown) {
        ui.pairingCountdown.textContent = String(minutes).padStart(2, '0')
          + ':' + String(seconds).padStart(2, '0');
      }
      if (remaining <= 0) clearCountdown();
    }

    function isSectionVisible() {
      if (!section?.isConnected) return false;
      let node = section;
      while (node) {
        if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
        if (node === documentRef.body) break;
        node = node.parentElement;
      }
      return true;
    }

    function syncCountdown() {
      const key = boundedText(status.pairing?.pairing_id, 128);
      if (!status.pairing || !key || !isSectionVisible()) {
        clearCountdown();
        return;
      }
      renderCountdown();
      if (countdownTimer == null && Number(status.pairing.expires_at) > Number(now())) {
        countdownKey = key;
        countdownTimer = scheduleInterval(() => {
          if (disposed || countdownKey !== key || !status.pairing) return;
          if (!isSectionVisible()) { clearCountdown(); return; }
          renderCountdown();
        }, 1000);
      }
    }

    function formatDate(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return 'unknown';
      try { return new Date(numeric).toLocaleDateString(globalThis.jennyI18n?.tag?.()); } catch (_error) { return 'unknown'; }
    }

    function appendInventoryButton(parent, config, handler, disabled) {
      const wrapper = documentRef.createElement('span');
      wrapper.innerHTML = actionButton({ ...config, disabled });
      const button = wrapper.firstElementChild;
      if (button) {
        button.addEventListener('click', handler);
        parent.appendChild(button);
      }
      return button;
    }

    function renderDevices() {
      if (!ui.devicesList) return;
      ui.devicesList.replaceChildren();
      if (!status.devices.length) {
        const empty = documentRef.createElement('p');
        empty.className = 'settings-note remote-list-empty';
        empty.textContent = jt('settings.remote.noPairedPhones', 'No paired phones.');
        ui.devicesList.appendChild(empty);
        return;
      }
      status.devices.forEach((device) => {
        const id = boundedText(device?.device_id, 128);
        const row = documentRef.createElement('div');
        row.className = 'remote-list-row';
        const dot = documentRef.createElement('span');
        dot.className = 'remote-device-dot' + (device?.connected === true ? ' is-connected' : '');
        dot.title = device?.connected === true ? jt('settings.remote.connected', 'Connected') : jt('settings.remote.offline', 'Offline');
        dot.setAttribute('aria-label', dot.title);
        const copy = documentRef.createElement('div');
        copy.className = 'remote-list-copy';
        const label = documentRef.createElement('span');
        label.className = 'remote-list-label';
        label.textContent = boundedText(device?.label, 64) || jt('settings.remote.unnamedPhone', 'Unnamed phone');
        const meta = documentRef.createElement('span');
        meta.className = 'remote-list-meta';
        meta.textContent = jt('settings.remote.deviceMeta', 'Paired {pairedDate} · Last seen {lastSeenDate}', { pairedDate: formatDate(device?.paired_at), lastSeenDate: formatDate(device?.last_seen_at) });
        copy.append(label, meta);
        row.append(dot, copy);
        appendInventoryButton(row, { label: jt('settings.remote.revoke', 'Revoke'), variant: 'secondary', size: 'sm' }, () => {
          void invoke('revoke:' + id, 'revokeDevice', { device_id: id });
        }, pending.has('revoke:' + id) || !id);
        ui.devicesList.appendChild(row);
      });
    }

    function renderSharedSessions() {
      if (!ui.sharedList) return;
      ui.sharedList.replaceChildren();
      if (!status.shared_sessions.length) {
        const empty = documentRef.createElement('p');
        empty.className = 'settings-note remote-list-empty';
        empty.textContent = jt('settings.remote.noSharedChats', 'No shared chats. New chats started from your phone are shared automatically.');
        ui.sharedList.appendChild(empty);
        return;
      }
      status.shared_sessions.forEach((session) => {
        const id = boundedText(session?.id, 128);
        const row = documentRef.createElement('div');
        row.className = 'remote-list-row';
        const copy = documentRef.createElement('div');
        copy.className = 'remote-list-copy';
        const title = documentRef.createElement('span');
        title.className = 'remote-list-label';
        title.textContent = boundedText(session?.title, 200) || jt('settings.remote.untitledChat', 'Untitled chat');
        const meta = documentRef.createElement('span');
        meta.className = 'remote-list-meta';
        const controller = boundedText(session?.controlled_by, 128).toLowerCase();
        meta.textContent = controller && controller !== 'desktop' ? jt('settings.remote.controlledByPhone', 'Controlled by phone') : jt('settings.remote.desktop', 'Desktop');
        copy.append(title, meta);
        row.appendChild(copy);
        appendInventoryButton(row, { label: jt('settings.remote.removeAccess', 'Remove access'), variant: 'secondary', size: 'sm' }, () => {
          void invoke('unshare:' + id, 'unshareSession', { session_id: id });
        }, pending.has('unshare:' + id) || !id);
        ui.sharedList.appendChild(row);
      });
    }

    function inferPluginEnabled() {
      if (status.plugin_enabled === false) return false;
      if (status.plugin_enabled === true) return true;
      if (['plugin_inactive', 'plugin_disabled', 'feature_disabled'].includes(status.reason)) return false;
      return pluginEnabled;
    }

    function render(nextStatus = status) {
      const pairingWasOpen = Boolean(status.pairing);
      status = normalizeStatus(nextStatus, inferPluginEnabled());
      if (status.pairing && !pairingWasOpen) {
        pairedBefore = status.devices.length;
        pairingProducedDevice = false;
      } else if (pairingWasOpen && pairedBefore != null && status.devices.length > pairedBefore) {
        pairingProducedDevice = true;
      }
      const presentation = presentRemoteStatus(status, {
        pairedBefore: pairingProducedDevice ? pairedBefore : null,
      });
      if (ui.stateText) ui.stateText.textContent = presentation.label;
      if (ui.statusMessage) ui.statusMessage.textContent = presentation.message;
      if (ui.statusRow) {
        ui.statusRow.dataset.statusTone = presentation.tone;
        ui.statusRow.className = 'inv-status-row remote-status-row'
          + (presentation.tone === 'default' ? '' : ' inv-status-row--' + presentation.tone);
      }
      if (ui.relayInput && relayDraft === null) {
        ui.relayInput.value = status.relay_host ? 'wss://' + status.relay_host : '';
      }
      if (ui.relayInput) ui.relayInput.disabled = !status.setup.can_configure;
      const draftValue = relayDraft === null ? String(ui.relayInput?.value || '') : relayDraft;
      if (ui.relaySave) {
        ui.relaySave.disabled = !status.setup.can_configure || !draftValue.trim() || pending.has('relay');
      }
      if (ui.relaySummary) {
        ui.relaySummary.textContent = status.relay_host
          ? jt('settings.remote.relayConfigured', 'Relay: {relayHost}', { relayHost: status.relay_host })
          : '';
      }
      renderSetupGuide();
      const turnOffState = ['ready', 'reconnecting', 'starting', 'connecting'].includes(status.state);
      if (ui.primary) {
        ui.primary.textContent = status.state === 'off' ? jt('settings.remote.turnOn', 'Turn on') : jt('settings.remote.turnOff', 'Turn off');
        ui.primary.disabled = pending.has('toggle') || (status.state === 'off'
          ? !status.setup.can_enable : !turnOffState);
      }
      if (ui.addDevice) {
        ui.addDevice.hidden = status.state !== 'ready';
        ui.addDevice.disabled = status.reachable !== true || pending.has('pair');
      }
      if (ui.pairingCard) ui.pairingCard.hidden = !status.pairing;
      if (status.pairing) {
        if (ui.pairingQr) ui.pairingQr.src = 'data:image/svg+xml;utf8,'
          + encodeURIComponent(String(status.pairing.qr_svg || ''));
        if (ui.pairingLink) ui.pairingLink.value = boundedText(status.pairing.url, 2048);
        if (ui.pairingCopy) ui.pairingCopy.disabled = pending.has('copy');
      } else {
        if (ui.pairingQr) ui.pairingQr.removeAttribute('src');
        if (ui.pairingLink) ui.pairingLink.value = '';
      }
      syncCountdown();
      renderDevices();
      renderSharedSessions();
      const currentSessionId = boundedText(getCurrentSessionId(), 128);
      const alreadyShared = status.shared_sessions.some((session) => boundedText(session?.id, 128) === currentSessionId);
      if (ui.shareCurrent) {
        ui.shareCurrent.disabled = !currentSessionId || alreadyShared
          || pending.has('share:' + currentSessionId);
      }
      if (ui.shareCurrentHost) ui.shareCurrentHost.hidden = !status.relay_host;
      const forgetting = pending.has('forget');
      const nothingToForget = !status.relay_host && !status.devices.length && !status.shared_sessions.length;
      const retryForget = status.reason === 'forget_not_deleted'
        || status.setup.reason === 'forget_not_deleted';
      if (ui.forgetAll) ui.forgetAll.disabled = forgetting || (nothingToForget && !retryForget);
      if (ui.forgetCancel) ui.forgetCancel.disabled = forgetting;
      if (ui.forgetConfirmButton) ui.forgetConfirmButton.disabled = forgetting;
    }

    async function invoke(key, method, payload) {
      if (disposed || pending.has(key)) return null;
      pending.add(key);
      if (ui.actionStatus) ui.actionStatus.textContent = '';
      render(status);
      try {
        if (typeof remote[method] !== 'function') throw new Error('remote_unavailable');
        const result = await remote[method](payload);
        if (disposed) return result;
        if (!result || result.ok !== true) showFailure(method, result);
        else if (key === 'forget' && ui.forgetConfirm) ui.forgetConfirm.hidden = true;
        await refresh();
        return result;
      } catch (error) {
        if (!disposed) showFailure(method, error);
        return null;
      } finally {
        pending.delete(key);
        if (!disposed) render(status);
      }
    }

    async function refresh() {
      if (disposed) return null;
      const version = ++refreshVersion;
      try {
        const next = typeof remote.getState === 'function'
          ? await remote.getState() : normalizeStatus(null);
        if (disposed || version !== refreshVersion) return null;
        render(next);
        return status;
      } catch (error) {
        if (disposed || version !== refreshVersion) return null;
        status = normalizeStatus({ state: 'unavailable', reason: 'remote_unavailable' });
        showFailure('getState', error);
        render(status);
        return null;
      }
    }

    async function refreshPluginState(nextState) {
      const version = ++pluginReadVersion;
      try {
        const value = Array.isArray(nextState?.plugins)
          ? nextState : await shell.plugins?.getState?.();
        if (disposed || version !== pluginReadVersion || !Array.isArray(value?.plugins)) return;
        pluginEnabled = pluginEnabledFromState(value);
        render(status);
      } catch (_error) { /* remote status remains authoritative when plugin state is unavailable */ }
    }

    collapsible?.initCollapsibleHandlers?.(documentRef);
    bindCollapsible(ui.setupTrigger, (expanded) => { setupExpandedOverride = expanded; });
    ui.setupHost?.querySelectorAll?.('[data-action^="remote-command-copy-"]').forEach((button) => {
      listen(button, 'click', async () => {
        const index = Number(String(button.dataset.action || '').split('-').pop());
        const codeElement = ui.setupHost.querySelector('[data-remote-command="' + index + '"]');
        const command = RELAY_COMMANDS[index];
        try {
          if (!command || typeof navigatorRef?.clipboard?.writeText !== 'function') {
            throw new Error('clipboard_unavailable');
          }
          await navigatorRef.clipboard.writeText(command);
        } catch (_error) {
          if (codeElement) selectCodeText(codeElement);
        }
      });
    });
    listen(ui.relayInput, 'input', () => {
      const value = String(ui.relayInput?.value || '');
      relayDraft = value ? value : null;
      if (ui.relaySave) {
        ui.relaySave.disabled = !status.setup.can_configure || !value.trim() || pending.has('relay');
      }
    });
    listen(ui.relaySave, 'click', async () => {
      const normalized = normalizeRelayInput(relayDraft === null ? ui.relayInput?.value : relayDraft);
      if (!normalized.ok) {
        showFailure('setRelay', normalized);
        return;
      }
      const result = await invoke('relay', 'setRelay', { relay_url: normalized.relay_url });
      if (result?.ok === true && !disposed) {
        relayDraft = null;
        render(status);
      }
    });
    listen(ui.primary, 'click', () => {
      void invoke('toggle', status.state === 'off' ? 'enable' : 'disable', {});
    });
    listen(ui.addDevice, 'click', () => { void invoke('pair', 'openPairing', {}); });
    listen(ui.shareCurrent, 'click', () => {
      const sessionId = boundedText(getCurrentSessionId(), 128);
      if (sessionId) void invoke('share:' + sessionId, 'shareSession', { session_id: sessionId });
    });
    listen(ui.pairingCopy, 'click', async () => {
      const url = String(ui.pairingLink?.value || '');
      try {
        if (!url || typeof navigatorRef?.clipboard?.writeText !== 'function') throw new Error('clipboard_unavailable');
        await navigatorRef.clipboard.writeText(url);
      } catch (_error) {
        ui.pairingLink?.focus?.();
        ui.pairingLink?.select?.();
      }
    });
    listen(ui.forgetAll, 'click', () => { if (ui.forgetConfirm) ui.forgetConfirm.hidden = false; });
    listen(ui.forgetCancel, 'click', () => { if (ui.forgetConfirm) ui.forgetConfirm.hidden = true; });
    listen(ui.forgetConfirmButton, 'click', () => { void invoke('forget', 'forgetAll', { confirm: true }); });

    if (typeof remote.onStateChanged === 'function') {
      try { unsubscribeRemote = remote.onStateChanged((next) => { if (!disposed) render(next); }); }
      catch (error) { showFailure('onStateChanged', error); }
    }
    if (typeof shell.plugins?.onChanged === 'function') {
      try { unsubscribePlugins = shell.plugins.onChanged((next) => { void refreshPluginState(next); }); }
      catch (_error) { unsubscribePlugins = null; }
    }
    if (typeof shell.plugins?.getState === 'function') void refreshPluginState();
    void refresh();

    function dispose() {
      if (disposed) return;
      disposed = true;
      refreshVersion += 1;
      pluginReadVersion += 1;
      clearCountdown();
      try { unsubscribeRemote?.(); } catch (_error) { /* best effort */ }
      try { unsubscribePlugins?.(); } catch (_error) { /* best effort */ }
      unsubscribeRemote = null;
      unsubscribePlugins = null;
      while (listeners.length) listeners.pop()();
    }

    return { refresh, dispose };
  }

  return {
    createRemoteSettingsSection,
    normalizeStatus,
    pluginEnabledFromState,
    normalizeRelayInput,
    presentRemoteStatus,
    reasonCopy,
  };
});
