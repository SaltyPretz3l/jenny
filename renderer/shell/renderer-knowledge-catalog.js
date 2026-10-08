/* renderer/shell/renderer-knowledge-catalog.js
 *
 * "Search by meaning" inside Settings > Tools > Knowledge folders (roadmap
 * row 41, owner-picked placement A, 2026-10-06): the semantic catalog's
 * per-folder status signal and its sub-block (toggle, bring-your-own embedding
 * model, CPU/GPU, Advanced: prompt profile, dimensions, rebuild/delete).
 *
 * The knowledge folders controller owns the group's markup and render cycle;
 * this controller supplies HTML fragments and owns the catalog.* bridge,
 * its click/toggle/segmented/select handlers and the delete confirmation.
 * Inert unless the `semantic_catalog` flag is on and the bridge exists.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererKnowledgeCatalog = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var CONFIRM_MODAL_ID = 'knowledge-catalog-confirm-delete';
  var TOGGLE_ID = 'knowledge-catalog-enabled';
  var DEVICE_ID = 'knowledge-catalog-device';
  var DIMS_ID = 'knowledge-catalog-dims';
  var PROFILE_SELECT_ID = 'knowledgeCatalogProfile';
  var REFRESH_THROTTLE_MS = 2000;

  function resolve(name, path) {
    return (root && root[name]) || (typeof require === 'function' ? require(path) : null) || null;
  }

  var escapeHtml = (resolve('stringUtils', '../shared/string-utils') || {}).escapeHtml;

  function actionButton(opts) {
    var fn = resolve('inventoryActionButton', '../inventory/action-button');
    return fn ? fn(Object.assign({ plain: true }, opts)) : '';
  }

  function toggleHtml(opts) {
    var mod = resolve('inventoryToggleSwitch', '../inventory/toggle-switch');
    var fn = mod && (mod.toggleSwitch || mod);
    return typeof fn === 'function' ? fn(opts) : '';
  }

  function segmentedHtml(opts) {
    var mod = resolve('inventorySegmentedControl', '../inventory/segmented-control');
    var fn = typeof mod === 'function' ? mod : mod && mod.segmentedControl;
    return typeof fn === 'function' ? fn(opts) : '';
  }

  function selectHtml(opts) {
    var fn = resolve('inventorySelectField', '../inventory/select-field');
    return typeof fn === 'function' ? fn(opts) : '';
  }

  function samePath(left, right) {
    return String(left || '').replace(/[\\/]+$/, '').toLowerCase() === String(right || '').replace(/[\\/]+$/, '').toLowerCase();
  }

  function formatCount(value) {
    var i18n = globalThis.jennyI18n;
    return (Number(value) || 0).toLocaleString(i18n && typeof i18n.tag === 'function' ? i18n.tag() : undefined);
  }

  function formatSize(bytes) {
    var value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + ' KB';
    return Math.round(value / (1024 * 1024)) + ' MB';
  }

  function dot(tone) {
    return '<span class="status-dot status-dot--' + tone + (tone === 'active' ? ' knowledge-catalog-dot--working' : '') + '" aria-hidden="true"></span>';
  }

  var SKIP_REASON_COPY = {
    pdf_addon_missing: function (n) { return jt('catalog.skip.pdfAddon', '{count} PDFs need the PDF reading add-on', { count: n }); },
    needs_ocr: function (n) { return jt('catalog.skip.needsOcr', '{count} scanned PDFs have no text layer', { count: n }); },
    cap_reached: function (n) { return jt('catalog.skip.capReached', '{count} files are past the catalog size limit', { count: n }); },
  };

  function skipTooltip(reasons) {
    var parts = [];
    Object.keys(reasons || {}).forEach(function (key) {
      var copy = SKIP_REASON_COPY[key];
      parts.push(copy ? copy(reasons[key]) : jt('catalog.skip.other', '{count} skipped ({reason})', { count: reasons[key], reason: key }));
    });
    return parts.join(' · ');
  }

  function refusalCopy(reason) {
    var map = {
      not_embedding_model: jt('catalog.refused.notEmbedding', 'That file is a chat model, not an embedding model.'),
      not_gguf: jt('catalog.refused.notGguf', 'That file isn’t a GGUF model.'),
      unreadable: jt('catalog.refused.unreadable', 'That file can’t be read.'),
      path_invalid: jt('catalog.refused.pathInvalid', 'Pick a file on this computer, not a network drive.'),
    };
    return map[reason] || map.unreadable;
  }

  // The status line under the toggle: { tone, strong, text, action }.
  function statusLine(status, settings) {
    var state = status && status.state;
    var error = (status && status.lastError) || null;
    if (!settings || settings.enabled === false || state === 'off') {
      var files = status && status.counts && status.counts.indexed;
      var size = formatSize(status && status.sizeBytes);
      return {
        tone: 'muted',
        text: files
          ? jt('catalog.status.offKept', 'Off · the catalog is kept ({files} files{size}) and searches use exact words', {
            files: formatCount(files), size: size ? ', ' + size : '',
          })
          : jt('catalog.status.off', 'Off · searches use exact words'),
      };
    }
    if (!settings.modelPath || state === 'waiting_model') {
      return { tone: 'muted', text: jt('catalog.status.needsModel', 'Needs an embedding model'), action: 'choose' };
    }
    if (state === 'error' && error) {
      if (error.code === 'embedding_model_refused') {
        return { tone: 'error', error: refusalCopy(error.reason), action: 'chooseAnother' };
      }
      // The engine keeps the real cause while the catalog backs off: a model newer than the
      // llama.cpp build never loads, so retrying cannot help (row 41 gate: EmbeddingGemma 2).
      // The embedder takes a chat model's newer build when it has one (semantic-catalog-wiring).
      if (/^llama_server_model_unsupported(:|$)/.test(String(status.engine && status.engine.lastError || ''))) {
        return {
          tone: 'error',
          strong: jt('catalog.status.unsupported', 'Can’t load this model'),
          text: jt('catalog.status.unsupportedDetail', 'this llama-server build doesn’t support its format. Pick a newer llama.cpp build for a chat model, or choose another embedding model.'),
          action: 'chooseAnother',
        };
      }
      if (error.code === 'embedder_start_failed' || /^llama_server_/.test(String(error.code))) {
        return {
          tone: 'error',
          strong: jt('catalog.status.startFailed', 'Couldn’t start'),
          text: jt('catalog.status.startFailedDetail', 'the embedding model did not load. Check that your chat model starts on llama-server in Model Library, then try again.'),
          action: 'retry',
        };
      }
      if (/^embedder_/.test(String(error.code))) {
        return {
          tone: 'error',
          strong: jt('catalog.status.stopped', 'Stopped'),
          text: jt('catalog.status.stoppedDetail', 'the embedding model quit unexpectedly. Searches use exact words only for now.'),
          action: 'retry',
        };
      }
      return {
        tone: 'warn',
        strong: jt('catalog.status.problem', 'Interrupted'),
        text: jt('catalog.status.problemDetail', 'cataloging hit a problem and tries again in a minute'),
        action: 'retry',
      };
    }
    if (state === 'starting_engine') {
      return { tone: 'active', strong: jt('catalog.status.starting', 'Starting'), text: jt('catalog.status.startingDetail', 'loading the embedding model') };
    }
    if (state === 'indexing') {
      return { tone: 'active', strong: jt('catalog.status.cataloging', 'Cataloging'), text: jt('catalog.status.catalogingDetail', 'pauses the moment you start a chat') };
    }
    if (state === 'paused_busy') {
      return { tone: 'muted', strong: jt('catalog.status.paused', 'Paused'), text: jt('catalog.status.pausedDetail', 'Jenny is working; cataloging resumes 30 s after she’s done') };
    }
    if (state === 'caught_up') {
      return { tone: 'ok', strong: jt('catalog.status.upToDate', 'Up to date'), text: jt('catalog.status.upToDateDetail', 'checks for changes every 10 minutes while idle') };
    }
    return { tone: 'muted', text: jt('catalog.status.waiting', 'Starts once Jenny has been idle for 30 s') };
  }

  function createKnowledgeCatalogController(deps) {
    var d = deps || {};
    var state = d.state || {};
    var windowRef = d.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    var documentRef = d.documentRef || windowRef.document || null;
    var requestRender = typeof d.requestRender === 'function' ? d.requestRender : function () {};
    var isHostEnabled = typeof d.isHostEnabled === 'function' ? d.isHostEnabled : function () { return true; };
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};
    var stepModal = d.stepModal || resolve('inventoryStepModal', '../inventory/step-modal');
    var setTimeoutImpl = d.setTimeoutImpl || setTimeout;
    var clearTimeoutImpl = d.clearTimeoutImpl || clearTimeout;
    var announcerModule = d.liveAnnouncer || resolve('rendererLiveAnnouncer', '../shared/renderer-live-announcer');

    var view = { settings: null, status: null, profiles: [], busy: false, message: '', explainerOpen: false, advancedOpen: false, confirmDelete: false };
    var unsubscribe = null;
    var refreshTimer = null;
    var lastRefreshAt = 0;
    var disposed = false;
    var bound = false;
    var modalLifecycle = null;
    var announcer = null;
    // null until the first render, which is shown, not spoken.
    var lastSpokenStatus = null;
    var lastSpokenMessage = '';

    // The group re-renders by outerHTML, so status changes are spoken through
    // the app's one pair of persistent live regions (UIUX-029), not a nested
    // aria-live inside the fragment.
    function announce(text, assertive) {
      if (!text || !documentRef || typeof documentRef.getElementById !== 'function') return;
      if (!announcer && announcerModule && typeof announcerModule.createLiveAnnouncer === 'function') {
        announcer = announcerModule.createLiveAnnouncer({
          dom: {
            politeRegion: documentRef.getElementById('srAnnouncePolite'),
            assertiveRegion: documentRef.getElementById('srAnnounceAssertive'),
          },
          setTimeout: setTimeoutImpl,
          clearTimeout: clearTimeoutImpl,
        });
      }
      if (announcer) announcer.announce(text, { politeness: assertive ? 'assertive' : 'polite', key: 'knowledge-catalog' });
    }

    function speakChanges(line) {
      var spoken = line.error || (line.strong ? line.strong + ' · ' + line.text : line.text);
      if (lastSpokenStatus !== null && spoken !== lastSpokenStatus) announce(spoken, line.tone === 'error');
      lastSpokenStatus = spoken;
      if (view.message && view.message !== lastSpokenMessage) announce(view.message, true);
      lastSpokenMessage = view.message;
    }

    function bridge() {
      return (windowRef.jennyShell && windowRef.jennyShell.catalog) || null;
    }

    function isEnabled() {
      return Boolean(isHostEnabled() && state && state.features && state.features.featureFlags
        && state.features.featureFlags.semantic_catalog === true && bridge());
    }

    function applyResult(result) {
      if (disposed || !result || result.ok !== true) return;
      if (result.settings) view.settings = result.settings;
      if (result.status) view.status = result.status;
      if (Array.isArray(result.profiles)) view.profiles = result.profiles;
    }

    function refresh() {
      var api = bridge();
      if (!api || typeof api.getStatus !== 'function' || disposed) return Promise.resolve();
      lastRefreshAt = Date.now();
      return Promise.resolve(api.getStatus()).then(function (result) {
        applyResult(result);
        requestRender();
      }).catch(function (error) {
        appendClientLog('WARN', 'knowledge_catalog.status_failed', { message: String(error && error.message || error) });
      });
    }

    function scheduleRefresh() {
      if (refreshTimer || disposed) return;
      var wait = Math.max(0, REFRESH_THROTTLE_MS - (Date.now() - lastRefreshAt));
      refreshTimer = setTimeoutImpl(function () {
        refreshTimer = null;
        void refresh();
      }, wait);
    }

    function rowSignalHtml(rootPath) {
      if (!isEnabled() || !view.settings || view.settings.enabled === false || !view.settings.modelPath) return '';
      var roots = (view.status && view.status.roots) || [];
      var entry = null;
      for (var i = 0; i < roots.length; i += 1) {
        if (samePath(roots[i].path, rootPath)) { entry = roots[i]; break; }
      }
      var tone = 'muted';
      var text = jt('catalog.row.waiting', 'Waiting');
      var title = '';
      if (entry) {
        var indexed = Number(entry.indexed) || 0;
        var skipped = Number(entry.skipped) || 0;
        var failed = Number(entry.failed) || 0;
        var total = indexed + (Number(entry.pending) || 0) + failed + skipped;
        var done = entry.scanComplete && !(Number(entry.pending) > 0);
        if (!done) {
          tone = view.status && view.status.state === 'indexing' ? 'active' : 'muted';
          text = jt('catalog.row.progress', '{done} of {total} files', { done: formatCount(indexed), total: formatCount(total) });
        } else if (skipped + failed > 0) {
          tone = 'warn';
          text = jt('catalog.row.doneSkipped', '{files} files · {skipped} skipped', { files: formatCount(indexed), skipped: formatCount(skipped + failed) });
          title = skipTooltip(entry.skippedReasons) + (failed ? ' · ' + jt('catalog.skip.failed', '{count} couldn’t be read', { count: failed }) : '');
        } else {
          tone = 'ok';
          text = jt('catalog.row.done', '{files} files', { files: formatCount(indexed) });
        }
      }
      return '<div class="knowledge-catalog-signal"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>'
        + dot(tone) + '<span>' + escapeHtml(text) + '</span></div>';
    }

    function factsHtml(settings, status) {
      var model = status && status.model;
      var name = (model && model.name) || String(settings.modelPath || '').split(/[\\/]/).pop();
      var detail = model
        ? jt('catalog.facts.profile', 'detected profile, {dims}', {
          dims: model.dims ? jt('catalog.facts.dims', '{dims} dims', { dims: model.dims }) : jt('catalog.facts.nativeDims', 'native dims'),
        })
        : '';
      return '<dl class="knowledge-catalog-facts">'
        + '<dt>' + escapeHtml(jt('catalog.facts.model', 'Model')) + '</dt><dd>'
        + '<span class="knowledge-catalog-model-name">' + escapeHtml(name) + '</span>'
        + (detail ? ' <span class="settings-field-description">· ' + escapeHtml(detail) + '</span>' : '')
        + ' ' + actionButton({ className: 'settings-link knowledge-catalog-link', label: jt('catalog.facts.change', 'Change…'), dataset: { 'catalog-action': 'choose' }, disabled: view.busy })
        + '</dd>'
        + '<dt>' + escapeHtml(jt('catalog.facts.runsOn', 'Runs on')) + '</dt><dd>'
        + segmentedHtml({
          id: DEVICE_ID,
          ariaLabel: jt('catalog.facts.runsOn', 'Runs on'),
          value: settings.device === 'gpu' ? 'gpu' : 'cpu',
          options: [{ value: 'cpu', label: jt('catalog.facts.cpu', 'CPU') }, { value: 'gpu', label: jt('catalog.facts.gpu', 'GPU') }],
        })
        + ' <span class="settings-field-description">' + escapeHtml(settings.device === 'gpu'
          ? jt('catalog.facts.gpuNote', 'uses a little GPU memory beside your chat model')
          : jt('catalog.facts.cpuNote', 'CPU leaves all GPU memory to your chat model')) + '</span>'
        + '</dd></dl>';
    }

    function advancedHtml(settings, status) {
      var profiles = view.profiles || [];
      var options = [{ value: '', label: jt('catalog.advanced.detected', 'Detected') }].concat(profiles.map(function (profile) {
        return { value: profile.id, label: profile.label || profile.id };
      }));
      var activeProfileId = (status && status.model && status.model.profileId) || '';
      var active = null;
      for (var i = 0; i < profiles.length; i += 1) {
        if (profiles[i].id === (settings.profileId || activeProfileId)) active = profiles[i];
      }
      var dimsOptions = active && Array.isArray(active.dims) && active.dims.length >= 2 && active.dims.length <= 4
        ? active.dims.slice().sort(function (a, b) { return a - b; }).map(function (value) { return { value: String(value), label: String(value) }; })
        : null;
      var currentDims = String((status && status.model && status.model.dims) || settings.dims || '');
      var on = settings.enabled !== false;
      return '<details class="knowledge-catalog-advanced"' + (view.advancedOpen ? ' open' : '') + ' data-catalog-advanced>'
        + '<summary>' + escapeHtml(jt('catalog.advanced.title', 'Advanced')) + '</summary>'
        + '<dl class="knowledge-catalog-facts">'
        + '<dt>' + escapeHtml(jt('catalog.advanced.profile', 'Prompt profile')) + '</dt><dd>'
        + selectHtml({ id: PROFILE_SELECT_ID, ariaLabel: jt('catalog.advanced.profile', 'Prompt profile'), value: settings.profileId || '', options: options, dataset: { 'catalog-select': 'profile' } })
        + '</dd>'
        + (dimsOptions ? '<dt>' + escapeHtml(jt('catalog.advanced.dims', 'Dimensions')) + '</dt><dd>'
          + segmentedHtml({ id: DIMS_ID, ariaLabel: jt('catalog.advanced.dims', 'Dimensions'), value: currentDims, options: dimsOptions })
          + ' <span class="settings-field-description">' + escapeHtml(jt('catalog.advanced.dimsNote', 'smaller is faster to search')) + '</span></dd>' : '')
        + '</dl>'
        + '<div class="settings-actions knowledge-catalog-danger">'
        + (on
          ? actionButton({ className: 'settings-secondary', label: jt('catalog.advanced.rebuild', 'Rebuild catalog'), dataset: { 'catalog-action': 'rebuild' }, disabled: view.busy })
          : actionButton({ className: 'settings-secondary settings-danger', label: jt('catalog.advanced.delete', 'Delete catalog…'), dataset: { 'catalog-action': 'delete' }, disabled: view.busy }))
        + '</div>'
        + '<p class="settings-note">' + escapeHtml(jt('catalog.advanced.noteRecatalog', 'Changing the model, profile or dimensions re-catalogs in the background; search by meaning covers more of your folders as it goes.')) + '</p>'
        + '</details>';
    }

    function blockHtml() {
      if (!isEnabled() || !view.settings) return '';
      var settings = view.settings;
      var status = view.status;
      var line = statusLine(status, settings);
      speakChanges(line);
      var lineHtml = '<p class="knowledge-catalog-status">' + dot(line.tone)
        + (line.error
          ? '<span class="knowledge-catalog-error">' + escapeHtml(line.error) + '</span>'
          : (line.strong ? '<strong>' + escapeHtml(line.strong) + '</strong> · ' : '') + '<span>' + escapeHtml(line.text) + '</span>')
        + '</p>';
      var actions = '';
      if (line.action === 'choose' || line.action === 'chooseAnother') {
        actions = actionButton({
          className: 'settings-secondary',
          label: line.action === 'choose' ? jt('catalog.action.choose', 'Choose model file…') : jt('catalog.action.chooseAnother', 'Choose another file…'),
          dataset: { 'catalog-action': 'choose' },
          disabled: view.busy,
        });
        if (line.action === 'choose') {
          actions += actionButton({ className: 'settings-link knowledge-catalog-link', label: jt('catalog.action.whatIs', 'What’s an embedding model?'), dataset: { 'catalog-action': 'explain' } });
        }
      } else if (line.action === 'retry') {
        actions = actionButton({ className: 'settings-secondary', label: jt('catalog.action.retry', 'Try again'), dataset: { 'catalog-action': 'retry' }, disabled: view.busy });
      }
      var explainer = view.explainerOpen
        ? '<p class="settings-note">' + escapeHtml(jt('catalog.explainer', 'A small model that turns text into numbers so similar meanings land close together. Use any embedding GGUF, for example EmbeddingGemma, nomic-embed or bge. Jenny doesn’t download one for you.')) + '</p>'
        : '';
      var hasModel = Boolean(settings.modelPath) && !(status && status.lastError && status.lastError.code === 'embedding_model_refused');
      return '<div class="knowledge-catalog-block" data-knowledge-catalog>'
        + '<div class="settings-field-row knowledge-catalog-toggle-row">'
        + '<div class="settings-field-row-text">'
        + '<span class="settings-field-label" id="knowledgeCatalogLabel">' + escapeHtml(jt('catalog.title', 'Search by meaning')) + '</span>'
        + '<p class="settings-field-description" id="knowledgeCatalogDescription">' + escapeHtml(jt('catalog.description', 'Catalogs these folders while Jenny is idle, so searches also find passages that use different words.')) + '</p>'
        + '</div>'
        + toggleHtml({ id: TOGGLE_ID, bare: true, checked: settings.enabled !== false, labelledBy: 'knowledgeCatalogLabel', describedBy: 'knowledgeCatalogDescription', disabled: view.busy })
        + '</div>'
        + lineHtml
        + (actions ? '<div class="settings-actions">' + actions + '</div>' : '')
        + explainer
        + (hasModel ? factsHtml(settings, status) + advancedHtml(settings, status) : '')
        + (view.message ? '<p class="settings-note knowledge-catalog-error">' + escapeHtml(view.message) + '</p>' : '')
        + '</div>';
    }

    function run(method, payload, onDone) {
      var api = bridge();
      if (!api || typeof api[method] !== 'function') return;
      view.busy = true;
      view.message = '';
      requestRender();
      Promise.resolve(api[method](payload)).then(function (result) {
        if (disposed) return;
        view.busy = false;
        if (result && result.ok === false && result.reason !== 'canceled') {
          view.message = method === 'chooseModel'
            ? refusalCopy(result.reason)
            : result.reason === 'catalog_in_use'
              ? jt('catalog.message.inUse', 'The catalog is still in use. Try again in a moment.')
              : jt('catalog.message.failed', 'That didn’t work. Try again.');
        }
        applyResult(result && result.settings ? { ok: true, settings: result.settings } : null);
        if (typeof onDone === 'function') onDone(result);
        void refresh();
      }).catch(function (error) {
        if (disposed) return;
        view.busy = false;
        view.message = jt('catalog.message.failed', 'That didn’t work. Try again.');
        appendClientLog('WARN', 'knowledge_catalog.action_failed', { method: method, message: String(error && error.message || error) });
        requestRender();
      });
    }

    function removeConfirm() {
      if (modalLifecycle) {
        modalLifecycle.dispose();
        modalLifecycle = null;
      }
      var existing = documentRef && documentRef.querySelector('[data-step-modal="' + CONFIRM_MODAL_ID + '"]');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    }

    function renderConfirm() {
      removeConfirm();
      if (!view.confirmDelete || !stepModal || typeof stepModal.renderStepModal !== 'function' || !documentRef || !documentRef.body) return;
      documentRef.body.insertAdjacentHTML('beforeend', stepModal.renderStepModal({
        id: CONFIRM_MODAL_ID,
        tone: 'danger',
        title: jt('catalog.confirm.title', 'Delete the catalog?'),
        summary: jt('catalog.confirm.summary', 'Your folders are not touched. Jenny will catalog them again next time she’s idle, if Search by meaning is on.'),
        bodyHtml: '',
        actions: [
          { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary' },
          { id: 'confirm', label: jt('catalog.confirm.delete', 'Delete'), variant: 'danger' },
        ],
      }));
      var mountRoot = documentRef.querySelector('[data-step-modal="' + CONFIRM_MODAL_ID + '"]');
      if (!mountRoot || typeof stepModal.createLifecycle !== 'function') return;
      // Focus moves into the dialog, the app behind it goes inert, and focus
      // returns to the Delete button when it closes.
      modalLifecycle = stepModal.createLifecycle({
        documentRef: documentRef,
        mountRoot: mountRoot,
        getOverlayManager: function () { return d.overlayManager || windowRef.rendererOverlayManagerController || null; },
        inertTargets: function () {
          var appShell = documentRef.getElementById('appShell');
          return appShell ? [appShell] : [];
        },
        appendClientLog: appendClientLog,
      });
      modalLifecycle.open({ id: CONFIRM_MODAL_ID, onRequestClose: function () { setConfirm(false); } });
    }

    function setConfirm(open) {
      view.confirmDelete = open;
      renderConfirm();
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      var modalAction = target.closest('[data-step-modal-action]');
      if (modalAction && modalAction.closest('[data-step-modal="' + CONFIRM_MODAL_ID + '"]')) {
        var confirmed = modalAction.getAttribute('data-step-modal-action') === 'confirm';
        setConfirm(false);
        if (confirmed) run('deleteCatalog');
        return;
      }
      if (view.confirmDelete && target.closest('[data-step-modal="' + CONFIRM_MODAL_ID + '"]') && !target.closest('.inv-step-modal')) {
        setConfirm(false);
        return;
      }
      var actionEl = target.closest('[data-catalog-action]');
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-catalog-action');
      if (action === 'choose') run('chooseModel');
      else if (action === 'retry') run('retry');
      else if (action === 'rebuild') run('rebuild');
      else if (action === 'delete') setConfirm(true);
      else if (action === 'explain') {
        view.explainerOpen = !view.explainerOpen;
        requestRender();
      }
    }

    function handleToggle(event) {
      if (!event || !event.detail || event.detail.id !== TOGGLE_ID) return;
      run('updateSettings', { enabled: event.detail.checked === true });
    }

    function handleSegmented(event) {
      var detail = event && event.detail;
      if (!detail) return;
      if (detail.id === DEVICE_ID) run('updateSettings', { device: detail.value === 'gpu' ? 'gpu' : 'cpu' });
      else if (detail.id === DIMS_ID) run('updateSettings', { dims: Number(detail.value) || 0 });
    }

    function handleChange(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function' || !target.closest('[data-catalog-select="profile"]')) return;
      run('updateSettings', { profileId: String(target.value || '') });
    }

    function handleToggleAdvanced(event) {
      var target = event && event.target;
      if (target && target.matches && target.matches('[data-catalog-advanced]')) view.advancedOpen = target.open === true;
    }

    function handleKeydown(event) {
      if (event && event.key === 'Escape' && view.confirmDelete) setConfirm(false);
    }

    function syncFeatureState() {
      if (!isEnabled()) {
        if (typeof unsubscribe === 'function') {
          try { unsubscribe(); } catch (_error) { /* ignore */ }
          unsubscribe = null;
        }
        view.settings = null;
        return;
      }
      var api = bridge();
      if (!unsubscribe && typeof api.onStatus === 'function') {
        unsubscribe = api.onStatus(function () { scheduleRefresh(); });
      }
      void refresh();
    }

    function bind() {
      if (bound || !documentRef || typeof documentRef.addEventListener !== 'function') return;
      bound = true;
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('inv-toggle-change', handleToggle);
      documentRef.addEventListener('inv-segmented-change', handleSegmented);
      documentRef.addEventListener('change', handleChange);
      documentRef.addEventListener('toggle', handleToggleAdvanced, true);
      documentRef.addEventListener('keydown', handleKeydown);
    }

    // The folders group re-renders by outerHTML; keep keyboard focus on the
    // catalog control the user just operated.
    function captureFocus() {
      var active = documentRef && documentRef.activeElement;
      if (!active || typeof active.closest !== 'function' || !active.closest('[data-knowledge-catalog]')) return '';
      var attrs = ['data-catalog-action', 'data-inv-toggle', 'data-catalog-select'];
      for (var i = 0; i < attrs.length; i += 1) {
        var value = active.getAttribute(attrs[i]);
        if (value) return '[' + attrs[i] + '="' + value + '"]';
      }
      var group = active.closest('[data-inv-segmented]');
      if (group) return '[data-inv-segmented="' + group.getAttribute('data-inv-segmented') + '"] [aria-checked="true"]';
      if (active.tagName === 'SUMMARY') return '[data-catalog-advanced] > summary';
      return '';
    }

    function restoreFocus(selector) {
      if (!selector || !documentRef) return;
      var el = documentRef.querySelector('[data-knowledge-catalog] ' + selector);
      if (el && typeof el.focus === 'function') el.focus();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (refreshTimer) clearTimeoutImpl(refreshTimer);
      refreshTimer = null;
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* ignore */ }
      }
      unsubscribe = null;
      if (bound && documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('click', handleClick);
        documentRef.removeEventListener('inv-toggle-change', handleToggle);
        documentRef.removeEventListener('inv-segmented-change', handleSegmented);
        documentRef.removeEventListener('change', handleChange);
        documentRef.removeEventListener('toggle', handleToggleAdvanced, true);
        documentRef.removeEventListener('keydown', handleKeydown);
      }
      view.confirmDelete = false;
      renderConfirm();
      if (announcer) announcer.dispose();
      announcer = null;
    }

    return {
      bind: bind,
      dispose: dispose,
      captureFocus: captureFocus,
      restoreFocus: restoreFocus,
      blockHtml: blockHtml,
      rowSignalHtml: rowSignalHtml,
      syncFeatureState: syncFeatureState,
      refresh: refresh,
      _view: view,
    };
  }

  return {
    createKnowledgeCatalogController: createKnowledgeCatalogController,
    statusLine: statusLine,
  };
});
