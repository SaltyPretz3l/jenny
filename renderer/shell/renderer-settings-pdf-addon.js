/* renderer/shell/renderer-settings-pdf-addon.js
 *
 * Settings > Tools > PDF reading add-on (PyMuPDF, AGPL-3.0, never bundled).
 * Main owns the download, fingerprint check, install and removal
 * (services/pdf-addon-service.js); this controller owns the view model, the
 * inline licence disclosure and remove confirmation, one bridge subscription,
 * and the "needs the add-on" notes on the Image and PDF reads / Rich file
 * tools toggles.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsPdfAddonUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t)
    || globalThis.jennyI18nFallback
    || function (key, fallback, params) {
      if (!params) return fallback;
      return String(fallback).replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
    };

  const VALID_STATES = new Set([
    'development', 'unsupported', 'not_installed', 'downloading', 'verifying',
    'installing', 'ready', 'failed', 'load_failed',
  ]);
  const WORKING_STATES = new Set(['downloading', 'verifying', 'installing']);
  const ACCEPTANCE = Object.freeze({ licenseAccepted: true });
  const BYTES_PER_MB = 1000 * 1000;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function text(value, max = 200) {
    return String(value == null ? '' : value).trim().slice(0, max);
  }

  function count(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function normalizeState(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const state = VALID_STATES.has(source.state) ? source.state : 'unsupported';
    return {
      state,
      reason: text(source.reason, 100),
      package: text(source.package, 60) || 'PyMuPDF',
      version: text(source.version, 40),
      license: text(source.license, 40),
      licenseUrl: /^https:\/\//.test(String(source.licenseUrl || '')) ? text(source.licenseUrl, 500) : '',
      installedVersion: text(source.installedVersion, 40),
      downloadSizeBytes: count(source.downloadSizeBytes),
      installedSizeBytes: count(source.installedSizeBytes),
      downloadedBytes: count(source.downloadedBytes),
      totalBytes: count(source.totalBytes),
      applyPending: source.applyPending === true,
      cancellable: source.cancellable === true,
      developmentAvailable: typeof source.developmentAvailable === 'boolean' ? source.developmentAvailable : null,
      developmentVersion: text(source.developmentVersion, 40),
    };
  }

  function megabytes(bytes) {
    return (bytes / BYTES_PER_MB).toFixed(1);
  }

  function failureMessage(model) {
    if (model.reason === 'network') {
      return jt('settings.pdfAddon.failedNetwork', 'Not installed · pypi.org could not be reached. Nothing was changed.');
    }
    if (model.reason === 'fingerprint') {
      return jt('settings.pdfAddon.failedFingerprint', 'Not installed · The download did not match the expected fingerprint and was deleted. Nothing was installed.');
    }
    if (model.reason === 'wrong_file') {
      return jt('settings.pdfAddon.failedWrongFile', 'Not installed · That file is not the {package} {version} wheel for this computer. Nothing was changed.', {
        package: model.package, version: model.version,
      });
    }
    if (model.reason === 'disk') {
      return jt('settings.pdfAddon.failedDisk', 'Not installed · The add-on could not be written to disk. Check the free space and try again. Nothing was changed.');
    }
    return jt('settings.pdfAddon.failedOther', 'Not installed · The add-on could not be installed. Nothing was changed.');
  }

  function statusFor(model) {
    switch (model.state) {
      case 'development':
        if (model.developmentAvailable === true) {
          return { tone: 'success', message: jt('settings.pdfAddon.developmentReady', 'Ready · provided by the development environment ({package} {version})', {
            package: model.package, version: model.developmentVersion || model.version,
          }) };
        }
        if (model.developmentAvailable === false) {
          return { tone: 'warning', message: jt('settings.pdfAddon.developmentMissing', 'Not available in this development environment. Install the media extra.') };
        }
        return { tone: 'pending', spinner: true, message: jt('settings.pdfAddon.developmentChecking', 'Checking the development environment…') };
      case 'unsupported':
        return { tone: 'default', message: jt('settings.pdfAddon.unsupported', 'Not available for this platform yet.') };
      case 'downloading':
        return {
          tone: 'pending',
          spinner: true,
          message: model.totalBytes
            ? jt('settings.pdfAddon.downloading', 'Downloading · {done} of {total} MB', {
              done: megabytes(model.downloadedBytes), total: megabytes(model.totalBytes),
            })
            : jt('settings.pdfAddon.downloadingStart', 'Downloading…'),
          progress: model.totalBytes ? {
            value: model.downloadedBytes,
            max: model.totalBytes,
            label: jt('settings.pdfAddon.downloadProgress', 'Download progress'),
            warningThreshold: 2,
            dangerThreshold: 2,
          } : null,
        };
      case 'verifying':
        return { tone: 'pending', spinner: true, message: jt('settings.pdfAddon.verifying', 'Checking the fingerprint…') };
      case 'installing':
        return {
          tone: 'pending',
          spinner: true,
          message: model.applyPending
            ? jt('settings.pdfAddon.installingWaiting', 'Installed · Jenny starts using it once the current chat finishes')
            : jt('settings.pdfAddon.installing', 'Installing…'),
        };
      case 'ready':
        return { tone: 'success', message: jt('settings.pdfAddon.ready', 'Ready · {package} {version} · {license}', {
          package: model.package, version: model.installedVersion || model.version, license: model.license,
        }) };
      case 'failed':
        return { tone: 'warning', message: failureMessage(model) };
      case 'load_failed':
        return { tone: 'danger', message: jt('settings.pdfAddon.loadFailed', 'Installed, but Jenny could not load it. Remove it and install again.') };
      default:
        return {
          tone: 'default',
          message: model.applyPending
            ? jt('settings.pdfAddon.removedWaiting', 'Not installed · Jenny stops using it once the current chat finishes')
            : jt('settings.pdfAddon.notInstalled', 'Not installed'),
        };
    }
  }

  function createPdfAddonController(options = {}) {
    const windowRef = options.windowRef || (typeof globalThis !== 'undefined' ? globalThis.window || globalThis : null);
    const documentRef = options.documentRef || windowRef?.document || null;
    const host = options.host || documentRef?.getElementById?.('toolsPdfAddonHost') || null;
    const fieldList = options.fieldList || documentRef?.getElementById?.('toolsConfigFieldList') || null;
    const inventory = options.inventory || windowRef?.inventory || {};
    const getBridge = typeof options.getBridge === 'function'
      ? options.getBridge
      : () => windowRef?.jennyShell?.pdfAddon || null;
    let model = normalizeState({ state: 'not_installed' });
    let loaded = false;
    let disclosureOpen = false;
    let confirmRemove = false;
    let pending = false;
    let actionError = '';
    let disposed = false;
    let unsubscribe = null;
    let generation = 0;
    const cleanups = [];

    function button(id, label, variant = 'secondary', size = 'md') {
      if (typeof inventory.actionButton !== 'function') return '';
      return inventory.actionButton({ id, label, variant, size, disabled: pending || !getBridge() });
    }

    function disclosureMarkup() {
      const size = model.installedSizeBytes ? Math.round(model.installedSizeBytes / BYTES_PER_MB) : 0;
      const facts = [
        [jt('settings.pdfAddon.factVersion', 'Version'), `${model.package} ${model.version}`],
        [jt('settings.pdfAddon.factSource', 'Source'), jt('settings.pdfAddon.factSourceValue', 'Python Package Index (pypi.org), checked against a fingerprint built into this version of Jenny')],
        [jt('settings.pdfAddon.factSize', 'Size'), jt('settings.pdfAddon.factSizeValue', 'about {size} MB on disk', { size })],
        [jt('settings.pdfAddon.factRuns', 'Runs'), jt('settings.pdfAddon.factRunsValue', 'only on this computer; nothing is sent anywhere')],
      ];
      return '<div class="pdf-addon-disclosure">'
        + '<p class="settings-group-copy">' + escapeHtml(jt('settings.pdfAddon.disclosure', 'The add-on is {package}, an open-source library licensed under the GNU Affero General Public License v3 (AGPL-3.0). Jenny\'s own code is MIT-licensed, and {package} is not included with Jenny. Installing it is your choice.', { package: model.package })) + '</p>'
        + '<dl class="pdf-addon-facts">'
        + facts.map(([term, value]) => '<dt>' + escapeHtml(term) + '</dt><dd>' + escapeHtml(value) + '</dd>').join('')
        + '</dl>'
        + '<p class="settings-field-note">' + escapeHtml(jt('settings.pdfAddon.removeAnyTime', 'You can remove it at any time.')) + '</p>'
        + '</div>';
    }

    function actionsMarkup() {
      const licence = model.licenseUrl ? button('pdfAddonLicence', jt('settings.pdfAddon.readLicence', 'Read the licence'), 'ghost', 'sm') : '';
      const fromFile = button('pdfAddonFromFile', jt('settings.pdfAddon.installFromFile', 'Install from a file…'), 'ghost', 'sm');
      const canInstall = model.state === 'not_installed' || model.state === 'failed';
      if (canInstall && disclosureOpen) {
        return button('pdfAddonAccept', jt('settings.pdfAddon.accept', 'Accept and install'), 'primary')
          + button('pdfAddonCloseDisclosure', jt('settings.pdfAddon.cancel', 'Cancel')) + licence + fromFile;
      }
      if (model.state === 'not_installed' && !model.applyPending) {
        return button('pdfAddonSetUp', jt('settings.pdfAddon.setUp', 'Set up…'));
      }
      if (model.state === 'failed') return button('pdfAddonRetry', jt('settings.pdfAddon.retry', 'Retry')) + fromFile;
      if (WORKING_STATES.has(model.state)) {
        return model.cancellable ? button('pdfAddonCancel', jt('settings.pdfAddon.cancel', 'Cancel')) : '';
      }
      if (model.state === 'ready' || model.state === 'load_failed') {
        if (confirmRemove) {
          return button('pdfAddonConfirmRemove', jt('settings.pdfAddon.remove', 'Remove'), 'danger')
            + button('pdfAddonKeep', jt('settings.pdfAddon.keep', 'Keep it'));
        }
        return button('pdfAddonRemove', jt('settings.pdfAddon.remove', 'Remove')) + (model.state === 'ready' ? licence : '');
      }
      return '';
    }

    function getMarkup() {
      const status = statusFor(model);
      const statusMarkup = typeof inventory.statusRow === 'function'
        ? inventory.statusRow({
          tone: status.tone,
          label: jt('settings.pdfAddon.statusLabel', 'Status'),
          message: status.message,
          spinner: status.spinner === true,
          progress: status.progress || null,
          ariaLive: 'polite',
        })
        : '<p class="settings-note" role="status" aria-live="polite">' + escapeHtml(status.message) + '</p>';
      const canInstall = model.state === 'not_installed' || model.state === 'failed';
      const actions = actionsMarkup();
      return '<h4 class="settings-group-heading" id="toolsPdfAddonHeading">'
        + escapeHtml(jt('settings.pdfAddon.heading', 'PDF reading add-on')) + '</h4>'
        + '<p class="settings-group-copy">'
        + escapeHtml(jt('settings.pdfAddon.description', 'Lets Jenny read PDF text, tables and scanned pages. Viewing and editing PDFs in the Workspace works without it.'))
        + '</p>'
        + statusMarkup
        + (canInstall && disclosureOpen ? disclosureMarkup() : '')
        + (WORKING_STATES.has(model.state) && !model.applyPending
          ? '<p class="settings-field-note">' + escapeHtml(jt('settings.pdfAddon.workingNote', 'Then: verify fingerprint → install → start using it. Chats keep working meanwhile.')) + '</p>'
          : '')
        + (confirmRemove && (model.state === 'ready' || model.state === 'load_failed')
          ? '<p class="settings-field-note">' + escapeHtml(jt('settings.pdfAddon.removeConfirm', 'Remove the PDF reading add-on? Jenny will stop reading PDFs until you install it again.')) + '</p>'
          : '')
        + (actionError ? '<p class="settings-field-note" role="alert">' + escapeHtml(actionError) + '</p>' : '')
        + (actions ? '<div class="settings-actions">' + actions + '</div>' : '');
    }

    function render() {
      if (disposed) return;
      if (fieldList?.dataset) {
        fieldList.dataset.pdfAddonNeeded = model.state === 'ready' || model.state === 'development' ? 'false' : 'true';
      }
      if (!host) return;
      const active = documentRef?.activeElement;
      const activeAction = active && host.contains?.(active) ? active.getAttribute?.('data-action') : '';
      host.dataset.pdfAddonState = model.state;
      host.innerHTML = getMarkup();
      if (activeAction) host.querySelector?.(`[data-action="${activeAction}"]`)?.focus?.();
    }

    function setModel(raw) {
      if (disposed) return;
      const next = normalizeState(raw);
      if (next.state !== 'not_installed' && next.state !== 'failed') disclosureOpen = false;
      if (next.state !== 'ready' && next.state !== 'load_failed') confirmRemove = false;
      model = next;
      loaded = true;
      render();
    }

    async function refresh() {
      const bridge = getBridge();
      if (!bridge || typeof bridge.getState !== 'function') {
        setModel({ state: 'unsupported' });
        return model;
      }
      const request = ++generation;
      try {
        const result = await bridge.getState();
        if (!disposed && request === generation) setModel(result);
      } catch (_error) {
        if (!disposed && request === generation && !loaded) setModel({ state: 'unsupported' });
      }
      return model;
    }

    async function invoke(method, payload) {
      const bridge = getBridge();
      if (pending || !bridge || typeof bridge[method] !== 'function') return;
      pending = true;
      actionError = '';
      render();
      const request = ++generation;
      try {
        const result = payload === undefined ? await bridge[method]() : await bridge[method](payload);
        if (disposed || request !== generation) return;
        if (result && result.ok === false && result.authorized !== false) {
          actionError = jt('settings.pdfAddon.actionFailed', 'That did not work. Try again.');
        }
        if (result && VALID_STATES.has(result.state)) setModel(result);
      } catch (_error) {
        actionError = jt('settings.pdfAddon.actionFailed', 'That did not work. Try again.');
      } finally {
        pending = false;
        render();
      }
    }

    function onClick(event) {
      const target = event?.target?.closest?.('[data-action^="pdfAddon"]');
      if (!target || !host?.contains?.(target)) return;
      const action = target.getAttribute('data-action');
      if (action === 'pdfAddonSetUp') { disclosureOpen = true; actionError = ''; render(); return; }
      if (action === 'pdfAddonCloseDisclosure') { disclosureOpen = false; render(); return; }
      if (action === 'pdfAddonRemove') { confirmRemove = true; render(); return; }
      if (action === 'pdfAddonKeep') { confirmRemove = false; render(); return; }
      if (action === 'pdfAddonLicence') {
        // window.open is denied and routed to the system browser by the main
        // window navigation guard.
        if (model.licenseUrl) windowRef?.open?.(model.licenseUrl, '_blank');
        return;
      }
      if (action === 'pdfAddonAccept' || action === 'pdfAddonRetry') void invoke('install', ACCEPTANCE);
      else if (action === 'pdfAddonFromFile') void invoke('installFromFile', ACCEPTANCE);
      else if (action === 'pdfAddonCancel') void invoke('cancel');
      else if (action === 'pdfAddonConfirmRemove') void invoke('remove');
    }

    function bind() {
      if (disposed) return;
      if (host?.addEventListener) {
        host.addEventListener('click', onClick);
        cleanups.push(() => host.removeEventListener('click', onClick));
      }
      const bridge = getBridge();
      if (bridge && typeof bridge.onChanged === 'function') {
        try {
          const maybe = bridge.onChanged((state) => {
            generation += 1;
            setModel(state);
          });
          if (typeof maybe === 'function') unsubscribe = maybe;
        } catch (_error) { /* refresh() still hydrates once */ }
      }
      render();
      void refresh();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* cleanup is best effort */ }
      }
      for (const cleanup of cleanups.splice(0)) cleanup();
    }

    return { bind, dispose, refresh, render, getModel: () => ({ ...model }) };
  }

  function bindPdfAddonSettings(windowRef, registerCleanup) {
    const controller = createPdfAddonController({ windowRef, documentRef: windowRef.document });
    controller.bind();
    registerCleanup(() => controller.dispose());
  }

  return { bindPdfAddonSettings, createPdfAddonController, normalizeState, statusFor };
});
