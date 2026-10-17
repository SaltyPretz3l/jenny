(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('../../shared/string-utils').escapeHtml, require('../../inventory/action-button')); return; }
  root.rendererOllamaDaemonView = factory(root.stringUtils.escapeHtml, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (escapeHtml, button) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function startedBy(daemon) {
    if (daemon.kind === 'systemd-system') return jt('setup.ollamaGate.systemService', 'system service ollama.service · runs as {user}', { user: daemon.user || '?' });
    if (daemon.kind === 'systemd-user') return jt('setup.ollamaGate.userService', 'your user service ollama.service');
    if (daemon.kind === 'snap') return jt('setup.ollamaGate.snapService', 'the snap ollama');
    if (daemon.kind === 'docker') return jt('setup.ollamaGate.dockerService', 'Docker container {name} · image {image}', { name: daemon.container || '?', image: daemon.image || '?' });
    if (daemon.kind === 'process' && daemon.sameUser) return jt('setup.ollamaGate.userProcess', 'ollama serve, started by you · PID {pid}', { pid: daemon.pid });
    return jt('setup.ollamaGate.unknownStarter', 'Unknown');
  }
  function facts(daemon) {
    if (!daemon) return '';
    var rows = [[jt('setup.ollamaGate.daemonVersion', 'Version'), daemon.version],
      [jt('setup.ollamaGate.daemonProgram', 'Program'), daemon.program],
      [jt('setup.ollamaGate.daemonStarter', 'Started by'), startedBy(daemon)]];
    return (daemon.confidence === 'inferred' ? '<p>' + escapeHtml(jt('setup.ollamaGate.inferredDaemon', 'Possible daemon; Jenny could not confirm its listener.')) + '</p>' : '')
      + '<dl class="setup-hw-daemon-facts">' + rows.filter(function (row) { return row[1]; }).map(function (row) {
        return '<div><dt>' + escapeHtml(row[0]) + '</dt><dd>' + escapeHtml(row[1]) + '</dd></div>';
      }).join('') + '</dl>';
  }
  function command(value) {
    if (!value) return '';
    return '<div class="setup-hw-daemon-command"><code>' + escapeHtml(value) + '</code>'
      + button({ id: 'copyDaemonCommand', label: jt('common.copy', 'Copy'), size: 'sm', dataset: { command: value } }) + '</div>';
  }
  function upgrade(view) {
    var daemon = view.ollama.daemon;
    var remedy = daemon.remedy || {};
    return '<p>' + escapeHtml(jt('setup.ollamaGate.olderDaemon', 'An older Ollama is running. Jenny needs {minimumVersion} or newer.', { minimumVersion: view.ollama.minimumVersion })) + '</p>'
      + facts(daemon) + '<h3>' + escapeHtml(jt('setup.ollamaGate.upgradeExisting', 'Upgrade this Ollama')) + '</h3>'
      + '<p>' + escapeHtml(jt('setup.ollamaGate.recommendedUpgrade', 'Recommended: keep your existing models and setup.')) + '</p>'
      + command(remedy.upgradeCommand)
      + (!remedy.upgradeCommand ? '<p>' + escapeHtml(jt('setup.ollamaGate.replaceBinary', 'Stop this Ollama and replace its binary from ollama.com/download/linux, then restart it.')) + '</p>' : '')
      + (daemon.kind === 'docker' ? '<p>' + escapeHtml(jt('setup.ollamaGate.recreateContainer', 'Then recreate the container the way you first started it.')) + '</p>' : '')
      + '<hr><p>' + escapeHtml(jt('setup.ollamaGate.managedAlternative', 'Or use Jenny’s own Ollama: a {size} download into your home folder.', { size: view.downloadSize })) + '</p>'
      + button({ id: 'managedFallback', label: jt('setup.ollamaGate.useManaged', 'Use Jenny’s own Ollama instead'), size: 'sm' });
  }
  function fallback(view) {
    var daemon = view.externalDaemon || {};
    var remedy = daemon.remedy || {};
    var free = view.ollama.port?.state === 'free';
    var stop = daemon.kind === 'process' && daemon.sameUser && daemon.confidence === 'confirmed'
      ? button({ id: 'stopUserDaemon', label: jt('setup.ollamaGate.stopForMe', 'Stop it for me'), disabled: view.stopping, size: 'sm' })
      : command(remedy.stopCommand);
    var state = free ? jt('setup.ollamaGate.portFree', 'Port 11434 is free')
      : view.ollama.port?.state === 'occupied' ? jt('setup.ollamaGate.portHeld', 'Port 11434 is still in use')
        : jt('setup.ollamaGate.portUnknown', 'Jenny could not verify whether port 11434 is free');
    return (!free ? '<h3>' + escapeHtml(jt('setup.ollamaGate.stopExisting', '1 · Stop the Ollama that’s running')) + '</h3>'
      + facts(daemon) + stop + command(remedy.restartHint)
      + (!stop ? '<p>' + escapeHtml(jt('setup.ollamaGate.stopManually', 'Stop whichever Ollama you installed earlier, then re-check.')) + '</p>' : '')
      + (remedy.reenableCommand ? '<p>' + escapeHtml(jt('setup.ollamaGate.reenableLater', 'To enable it again later:')) + '</p>' + command(remedy.reenableCommand) : '') : '')
      + '<p class="setup-hw-daemon-port" data-state="' + (free ? 'free' : 'held') + '" role="status">' + escapeHtml(state) + '</p>'
      + button({ id: 'recheck', label: jt('setup.ollamaGate.recheck', 'Re-check'), size: 'sm' })
      + (view.stopFailed ? '<p role="status">' + escapeHtml(jt('setup.ollamaGate.stopUnconfirmed', 'Jenny could not confirm that the daemon stopped. Re-check before installing.')) + '</p>' : '')
      + '<h3>' + escapeHtml(jt('setup.ollamaGate.downloadManaged', '2 · Download Jenny’s Ollama')) + '</h3>';
  }
  return Object.freeze({ facts: facts, upgrade: upgrade, fallback: fallback, startedBy: startedBy });
});
