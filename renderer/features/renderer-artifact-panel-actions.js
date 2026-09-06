/** Download, maximize, and overflow actions for Artifact Panel V3. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/context-menu'), require('../shared/log-contract-utils'));
    return;
  }
  root.rendererArtifactPanelActions = factory(root.inventoryContextMenu, root.logContractUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contextMenu, logContractUtils) {
  'use strict';

  function fileExtension(fileName) {
    var match = String(fileName || '').match(/\.([A-Za-z0-9]+)$/);
    return match ? match[1].toLowerCase() : '';
  }

  function safeBaseName(value) {
    return Array.from(String(value || 'artifact').trim(), function (character) {
      return character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '-' : character;
    }).join('').replace(/^[. ]+|[. ]+$/g, '') || 'artifact';
  }

  function isJsonText(value) {
    try {
      var parsed = JSON.parse(String(value || '').trim());
      return parsed !== null && typeof parsed === 'object';
    } catch (_error) { return false; }
  }

  function isMarkdownArtifact(artifact) {
    var file = artifact?.generatedFile || {};
    var language = String(file.language || '').toLowerCase();
    return language === 'markdown' || language === 'md' || /\.(md|markdown)$/i.test(String(file.fileName || file.displayPath || ''));
  }

  function buildDownloadPayload(artifact, source, formatLanguageLabel) {
    if (!artifact || artifact.artifactType === 'image') return null;
    var file = artifact.generatedFile || {};
    var markdown = isMarkdownArtifact(artifact);
    var json = artifact.artifactType === 'tool_output' && isJsonText(source);
    var format = markdown ? 'markdown' : json ? 'json' : 'plain';
    var extension = markdown ? 'md' : json ? 'json' : fileExtension(file.fileName || file.displayPath) || 'txt';
    var label = markdown ? 'Markdown' : json ? 'JSON' : typeof formatLanguageLabel === 'function' && file.language
      ? formatLanguageLabel(file.language)
      : extension.toUpperCase() + ' file';
    var explicitName = String(file.fileName || '').trim();
    var title = safeBaseName(artifact.title || file.title || 'artifact');
    return {
      format: format,
      filters: [{ name: String(label || extension.toUpperCase()), extensions: [extension] }],
      defaultName: explicitName ? safeBaseName(explicitName) : title + '.' + extension,
      content: String(source || ''),
    };
  }

  function createArtifactPanelActions(deps) {
    var options = deps || {};
    var panelEl = options.panelEl || null;
    var windowRef = options.windowRef || (typeof window !== 'undefined' ? window : null);
    var disposed = false;
    var overflowOpen = false;
    var downloadPromise = null;

    function safeErrorMessage(error) {
      var message = String(error?.message || error || 'Unknown error.');
      if (typeof logContractUtils?.redactLogText === 'function') message = logContractUtils.redactLogText(message);
      return message.slice(0, 160) || 'Unknown error.';
    }

    function hiddenClick(selector) {
      if (disposed) return false;
      var target = panelEl?.querySelector?.(selector);
      if (!target || target.disabled) return false;
      target.click();
      return true;
    }

    function download(artifact) {
      if (disposed || !artifact || artifact.artifactType === 'image') return Promise.resolve(null);
      if (downloadPromise) return downloadPromise;
      var source = typeof options.getArtifactSource === 'function' ? options.getArtifactSource() : '';
      var payload = buildDownloadPayload(artifact, source, options.formatLanguageLabel);
      var dialog = windowRef?.jennyShell?.dialog;
      if (!dialog || typeof dialog.saveFile !== 'function') {
        if (!disposed) {
          options.appendClientLog?.('WARN', 'artifacts.download_bridge_unavailable', { artifactId: String(artifact.id || '') });
          options.showToastMessage?.('Export failed. Try again.', { tone: 'danger', title: 'Download' });
        }
        return Promise.resolve(null);
      }
      var pending = Promise.resolve().then(function () { return dialog.saveFile(payload); }).then(function (result) {
        if (disposed) return result || null;
        if (!result || result.canceled === true) {
          options.appendClientLog?.('INFO', 'artifacts.download_canceled', { artifactId: String(artifact.id || '') });
          return result || { canceled: true };
        }
        if (result.canceled !== false || typeof result.path !== 'string' || !result.path.trim()) {
          options.appendClientLog?.('WARN', 'artifacts.download_invalid_result', { artifactId: String(artifact.id || '') });
          options.showToastMessage?.('Export failed. Try again.', { tone: 'danger', title: 'Download' });
          return null;
        }
        options.showToastMessage?.('Saved to ' + result.path, { tone: 'success', title: 'Download' });
        options.appendClientLog?.('INFO', 'artifacts.download_completed', { artifactId: String(artifact.id || ''), bytesWritten: result.bytesWritten || 0 });
        return result;
      }).catch(function (error) {
        if (disposed) return null;
        options.appendClientLog?.('ERROR', 'artifacts.download_failed', { artifactId: String(artifact.id || ''), message: safeErrorMessage(error) });
        options.showToastMessage?.('Export failed. Try again.', { tone: 'danger', title: 'Download' });
        return null;
      });
      var tracked = pending.finally(function () { if (downloadPromise === tracked) downloadPromise = null; });
      downloadPromise = tracked;
      return tracked;
    }

    function showOverflow(artifact, triggerEl) {
      if (disposed || !artifact || !contextMenu?.show || !triggerEl) return false;
      var generated = artifact.artifactType === 'generated_file';
      var isImage = artifact.artifactType === 'image';
      triggerEl.setAttribute('aria-expanded', 'true');
      overflowOpen = true;
      contextMenu.show({
        rootEl: panelEl,
        anchorEl: triggerEl,
        restoreFocusTo: triggerEl,
        onHide: function () {
          overflowOpen = false;
          if (triggerEl.isConnected !== false) triggerEl.setAttribute('aria-expanded', 'false');
        },
        onActionError: function (error) {
          if (!disposed) options.appendClientLog?.('ERROR', 'artifacts.overflow_action_failed', { message: safeErrorMessage(error) });
        },
        items: [
          { label: 'Reveal in folder', disabled: !generated, action: function () { hiddenClick('#artifactReviewRevealButton'); } },
          { label: 'Open externally', disabled: !generated, action: function () { hiddenClick('#artifactReviewOpenExternalButton'); } },
          { label: 'Jump to chat', disabled: !artifact.sourceMessageId, action: function () { hiddenClick('#artifactReviewJumpButton'); } },
          { label: 'Copy', disabled: isImage, action: function () { hiddenClick('[data-artifact-panel-v2-copy]'); } },
          { label: 'Download', disabled: isImage, action: function () { return download(artifact); } },
          { separator: true },
          { label: 'Delete artifact', danger: true, disabled: !generated, action: function () { hiddenClick('#artifactReviewDeleteButton'); } },
        ],
      });
      return true;
    }

    function toggleMaximize() {
      if (disposed || panelEl?.classList?.contains('artifact-review-overlay')) return false;
      return typeof options.toggleMaximize === 'function' ? options.toggleMaximize() : false;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (overflowOpen) contextMenu?.hide?.({ restoreFocus: false });
      overflowOpen = false;
    }

    return { dispose: dispose, download: download, showOverflow: showOverflow, toggleMaximize: toggleMaximize };
  }

  return { buildDownloadPayload: buildDownloadPayload, createArtifactPanelActions: createArtifactPanelActions };
});
