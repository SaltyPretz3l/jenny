(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererMcpServersRea = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  // Row 53: the rea connection's extras on the Settings > Extensions MCP controller
  // (renderer-mcp-servers.js): the readiness copy (S9) and the Details drawer's
  // Installation section (S8b). The controller owns the drawer, the busy state and
  // the bridge; this module owns the install plan, the progress payload and the copy.
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function readinessCopy(readiness) {
    var time = new Date(readiness.checkedAt).toLocaleTimeString(globalThis.jennyI18n?.tag?.(),
      Object.assign({ hour: '2-digit', minute: '2-digit' }, globalThis.jennyI18n?.timeOptions?.()));
    var reason = readiness.reason === 'exit_nonzero' ? jt('mcp.servers.readinessExitNonzero', 'the health check failed')
      : readiness.reason === 'timed_out' ? jt('mcp.servers.readinessTimedOut', 'the health check timed out')
        : readiness.reason === 'invalid_output' || readiness.reason === 'probe_unavailable'
          ? jt('mcp.servers.readinessInvalidOutput', 'the health check gave no answer')
          : jt('mcp.servers.readinessUnhealthy', 'rea reports a problem');
    return { summary: readiness.healthy ? jt('mcp.servers.readyChecked', 'ready, checked {time}', { time: time })
      : jt('mcp.servers.needsAttention', 'needs attention: {reason}, checked {time}', { reason: reason, time: time }),
    details: readiness.healthy ? jt('mcp.servers.readinessReady', 'Ready · checked {time}', { time: time })
      : jt('mcp.servers.readinessAttention', 'Needs attention · {reason} · checked {time}', { reason: reason, time: time }) };
  }

  // deps: hasReadinessProbe(name), bridge(), servers(), run(name, payload), confirmDanger(config),
  // drawerActiveFor(name, kind), drawDrawer(), drawerPanel(), isBusy(), isDisposed(), showToast(message, options).
  function createInstallSection(deps) {
    var actionButton = root.inventoryActionButton;
    var plan = null;
    var progress = null;
    var unsubscribe = null;
    function params() {
      return { version: plan?.version || '', nodeRoot: String(plan?.nodePath || '').replace(/[\\/][^\\/]*$/, ''),
        nodeVersion: plan?.node?.version || '' };
    }
    function nodeCopy(found) {
      return !found
        ? jt('mcp.servers.install.nodeMissing', 'Node.js was not found at {nodeRoot}.', params())
        : jt('mcp.servers.install.nodeUnsupported', 'Node.js {nodeVersion} at {nodeRoot} is not supported; rea needs 22.19, 24.11 or newer.', params());
    }
    function megabytes(bytes) {
      return (Number(bytes || 0) / 1000000).toLocaleString(globalThis.jennyI18n?.tag?.(),
        { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    }
    function progressCopy() {
      if (progress?.status !== 'running') return '';
      var p = Object.assign(params(), { done: megabytes(progress.downloadedBytes), total: megabytes(progress.totalBytes) });
      switch (progress.phase) {
      case 'downloading': return jt('mcp.servers.install.progressDownloading', 'Downloading rea-agents {version} · {done} of {total} MB…', p);
      case 'verifying': return jt('mcp.servers.install.progressVerifying', 'Checking the download…');
      case 'installing': return jt('mcp.servers.install.progressInstalling', 'Installing with npm (about 102 MB)…');
      case 'probing': return jt('mcp.servers.install.progressProbing', 'Checking rea…');
      case 'publishing': case 'connecting': return jt('mcp.servers.install.progressFinishing', 'Finishing…');
      case 'copying_skill': return jt('mcp.servers.install.progressSkill', 'Copying the skill…');
      default: return '';
      }
    }
    // The status line under the buttons: a running install's phase, else why the buttons are off.
    function noteCopy() {
      return progressCopy() || (plan.active ? jt('mcp.servers.install.fail.in_progress', 'An install is already running.')
        : plan.connection.enabled === true ? jt('mcp.servers.install.turnOffFirst', 'Turn the connection off to install or uninstall.')
          : !plan.node.supported ? nodeCopy(plan.node.found) : '');
    }
    function failureCopy(result, uninstall) {
      var p = params();
      var code = result?.error?.code || result?.code;
      if (uninstall) {
        return code === 'remove_failed' ? jt('mcp.servers.install.fail.remove_failed', 'The rea install could not be removed.')
          : code === 'connection_update_failed' ? jt('mcp.servers.install.fail.uninstall_connection_update_failed', 'The rea install was removed, but the connection could not be updated: Edit it to use npx again.')
            : code === 'connection_enabled' ? jt('mcp.servers.install.fail.connection_enabled', 'Turn the connection off first.')
              : code === 'in_progress' ? jt('mcp.servers.install.fail.in_progress', 'An install is already running.')
                : jt('mcp.servers.install.fail.uninstall_generic', 'The rea uninstall failed.');
      }
      switch (code) {
      case 'download_failed': return jt('mcp.servers.install.fail.download_failed', 'The download failed.');
      case 'integrity_mismatch': return jt('mcp.servers.install.fail.integrity_mismatch', 'The download did not match its fingerprint; nothing was installed.');
      case 'npm_failed': return jt('mcp.servers.install.fail.npm_failed', 'npm could not install rea-agents.');
      case 'install_invalid': return jt('mcp.servers.install.fail.install_invalid', 'The installed package was not rea-agents {version}.', p);
      case 'probe_failed': return jt('mcp.servers.install.fail.probe_failed', 'rea was installed but its health check failed; the connection was not changed.');
      case 'publish_failed': return jt('mcp.servers.install.fail.publish_failed', 'The previous install could not be replaced.');
      case 'connection_update_failed': return jt('mcp.servers.install.fail.connection_update_failed', 'rea was installed, but the connection could not be updated: Edit it to use the install.');
      case 'connection_enabled': return jt('mcp.servers.install.fail.connection_enabled', 'Turn the connection off first.');
      case 'node_missing': return nodeCopy(false);
      case 'node_unsupported': return nodeCopy(true);
      case 'in_progress': return jt('mcp.servers.install.fail.in_progress', 'An install is already running.');
      default: return jt('mcp.servers.install.fail.generic', 'The rea install failed.');
      }
    }
    function markup(server) {
      if (!deps.hasReadinessProbe(server.name) || !plan?.supported) return '';
      var installed = plan.installed;
      var p = params();
      var title = installed.version
        ? jt('mcp.servers.install.installedTitle', 'Installed in Jenny · rea-agents {version}', { version: installed.version })
        : jt('mcp.servers.install.notInstalledTitle', 'Runs through npx');
      var skill = !plan.skill.copied
        ? jt('mcp.servers.install.skillNotCopied', 'The skill was not copied; see the tutorial to copy it by hand.')
        : plan.skill.scopeEnabled
          ? jt('mcp.servers.install.skillCopiedScopeOn', 'The reverse-engineer-anything skill was copied to your skills folder and user skills are on.')
          : jt('mcp.servers.install.skillCopiedScopeOff', 'The reverse-engineer-anything skill was copied to your skills folder; turn on user skills in Settings › Skills to let Jenny read it.');
      var command = installed.managedCommand
        ? jt('mcp.servers.install.commandManaged', 'The connection\'s command points at this install.')
        : jt('mcp.servers.install.commandUnmanaged', 'The connection\'s command does not point at this install: Edit it or install again.');
      // A failed uninstall can leave the command pointing at the removed install.
      var stale = !installed.version && installed.managedCommand
        ? ' ' + jt('mcp.servers.install.commandStale', 'The connection\'s command still points at a removed install: Edit it or install again.') : '';
      var body = installed.version
        ? jt('mcp.servers.install.installedBody', 'Installed under your Jenny profile (about 102 MB). {skill} {command} Uninstall removes the install and puts the npx command back; the skill copy stays.', { skill: skill, command: command })
        : jt('mcp.servers.install.notInstalledBody', 'Each start resolves rea-agents {version} from the npx cache (about 30 seconds the first time). Install rea into Jenny instead: rea-agents {version}, about 102 MB from registry.npmjs.org, checked against a fingerprint built into this version of Jenny and kept under your Jenny profile. The connection then starts from there in about 2 seconds; its command is rewritten, so the tools go back through review once. Needs Node.js at {nodeRoot}.', p) + stale;
      var disabled = deps.isBusy() || plan.connection.enabled === true || Boolean(plan.active);
      var current = Boolean(installed.version && installed.upToDate);
      var buttons = actionButton({ label: current ? jt('mcp.servers.install.upToDate', 'Up to date')
        : installed.version ? jt('mcp.servers.install.update', 'Update to {version}…', p) : jt('mcp.servers.install.install', 'Install rea…'),
      variant: installed.version ? 'ghost' : 'secondary', size: 'sm', disabled: disabled || current || !plan.node.supported,
      dataset: { 'mcp-servers-action': 'install-rea', 'mcp-server-name': server.name } });
      if (installed.version) buttons += actionButton({ label: jt('mcp.servers.install.uninstall', 'Uninstall…'),
        variant: 'ghost', size: 'sm', disabled: disabled, dataset: { 'mcp-servers-action': 'uninstall-rea', 'mcp-server-name': server.name } });
      var note = noteCopy();
      return '<section><h3>' + escapeHtml(jt('mcp.servers.install.sectionTitle', 'Installation')) + '</h3>'
        + '<div class="settings-field-row mcp-approval-row"><span class="settings-field-row-text"><strong>'
        + escapeHtml(title) + '</strong><small>' + escapeHtml(body) + '</small></span>'
        + '<span class="settings-actions mcp-install-actions">' + buttons + '</span></div>'
        + '<p class="settings-note mcp-install-progress" role="status"' + (note ? '' : ' hidden') + '>' + escapeHtml(note) + '</p></section>';
    }
    // The plan is requested only while a preset row exists; a missing bridge method or a
    // rejected call hides the section. The previous plan stands until the answer arrives, so
    // the section never blinks out while the plan is refreshed after an operation.
    async function load() {
      if (!deps.servers().some(function (row) { return deps.hasReadinessProbe(row.name); })) { plan = null; return; }
      var next;
      try { next = await deps.bridge()?.getReaInstallPlan?.() || null; }
      catch (_error) { next = null; }
      plan = next;
    }
    // A progress event updates the status line in place: rebuilding the drawer would move
    // focus to Close and reset its scroll on every download tick.
    function onProgress(payload) {
      if (deps.isDisposed()) return;
      progress = payload;
      if (!plan?.supported || !deps.drawerActiveFor('rea', 'details')) return;
      var node = deps.drawerPanel()?.querySelector('.mcp-install-progress');
      if (!node) return;
      var text = noteCopy();
      node.textContent = text;
      node.hidden = !text;
    }
    function release() {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    }
    function subscribe() {
      release();
      var off = deps.bridge()?.onReaInstallProgress?.(onProgress);
      unsubscribe = typeof off === 'function' ? off : null;
    }
    async function manage(name, uninstall) {
      if (deps.isBusy() || !deps.drawerActiveFor(name, 'details') || !deps.hasReadinessProbe(name) || !plan?.supported
        || plan.connection.enabled === true || (!uninstall && !plan.node.supported)) return;
      var p = params();
      var updating = Boolean(plan.installed.version);
      var config = uninstall ? {
        title: jt('mcp.servers.install.uninstallConfirmTitle', 'Remove the rea install?'),
        message: jt('mcp.servers.install.uninstallConfirmMessage', 'Removes the managed copy under your Jenny profile and puts the npx command back on the connection. The skill copy in your skills folder stays.'),
        confirmLabel: jt('mcp.servers.install.uninstallConfirm', 'Uninstall'),
      } : {
        title: updating ? jt('mcp.servers.install.confirmUpdateTitle', 'Update rea to {version}?', p)
          : jt('mcp.servers.install.confirmTitle', 'Install rea into Jenny?'),
        message: jt('mcp.servers.install.confirmMessage', 'Download rea-agents {version} (1.8 MB) from registry.npmjs.org and check it against the fingerprint built into this version of Jenny, then let npm fetch its dependencies (about 102 MB on disk) under your Jenny profile. Needs Node.js at {nodeRoot}. The connection\'s command is rewritten to the install, so its tools go back through review once.', p),
        confirmLabel: updating ? jt('mcp.servers.install.confirmUpdate', 'Update') : jt('mcp.servers.install.confirmInstall', 'Install'),
      };
      config.cancelLabel = jt('common.cancel', 'Cancel');
      if (!await deps.confirmDanger(config) || !deps.drawerActiveFor(name, 'details')) return;
      var result = await deps.run(uninstall ? 'uninstallRea' : 'installRea', { confirmed: true });
      progress = null; // the terminal event has arrived, or the call failed before one could
      if (deps.isDisposed()) return;
      if (result?.status === 'completed' || (uninstall && result?.ok)) {
        deps.showToast(uninstall
          ? jt('mcp.servers.install.uninstalled', 'rea install removed. The connection runs through npx again; the skill copy stays.')
          : jt('mcp.servers.install.installed', 'rea {version} installed. Test the connection and approve its tools.', p)
            + (result.skillCopied === false ? jt('mcp.servers.install.skillNotCopiedSuffix', ' The skill was not copied.') : ''));
      } else if (result?.status === 'failed' && result.ok !== false) {
        // A refusal (ok === false) already toasted through run(); a terminal failure has not.
        deps.showToast(failureCopy(result, uninstall), { tone: 'warning' });
      }
      if (deps.drawerActiveFor(name, 'details')) deps.drawDrawer();
    }
    return { markup: markup, load: load, subscribe: subscribe, release: release, manage: manage, failureCopy: failureCopy };
  }

  return { readinessCopy: readinessCopy, createInstallSection: createInstallSection };
});
