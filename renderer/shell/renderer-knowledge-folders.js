/* renderer/shell/renderer-knowledge-folders.js
 *
 * The Knowledge folders group mounts dynamically in Settings > Tools.
 *
 * No-op when `knowledge_layer` is off (flag-off parity is a pinned
 * invariant): render() removes any previously-rendered group and returns,
 * and bind() never probes the knowledge bridge (flag-off means the
 * knowledge.* IPC handlers are not even registered).
 *
 * Registered folders flow KnowledgeService -> knowledge.json -> managed
 * sidecar config -> the knowledge_search/view/exec tools; this surface only
 * talks to `window.jennyShell.knowledge.*`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererKnowledgeFolders = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var GROUP_ID = 'knowledgeFoldersGroup';
  // MUST be card-scoped: the settings NAV items carry the same
  // data-settings-section attribute (renderer-settings-nav-utils.js) and
  // precede the cards in the DOM, so a bare attribute selector mounts the
  // group into the nav sidebar. Same scoping renderer-model-library.js uses.
  var TOOLS_SECTION_SELECTOR = '.settings-card[data-settings-section="tools"]';
  var CONFIRM_MODAL_ID = 'knowledge-folders-confirm-remove';

  function resolveStringUtils() {
    return (root && root.stringUtils)
      || (typeof require === 'function' ? require('../shared/string-utils') : null)
      || {};
  }

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null)
      || null;
  }

  function resolveTextField() {
    return (root && root.inventoryTextField)
      || (typeof require === 'function' ? require('../inventory/text-field') : null)
      || null;
  }

  function resolveAsyncFence() {
    return (root && root.rendererAsyncFence)
      || (typeof require === 'function' ? require('../shared/async-fence') : null);
  }

  var escapeHtml = resolveStringUtils().escapeHtml || function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // Human copy for the structured addFolder rejection reasons. Never leaks
  // the raw enum (the service's reason strings stay wire-only).
  var ADD_FOLDER_REASON_COPY = {
    sensitive_path: 'That folder looks sensitive (keys, credentials, or browser data) and can’t be registered.',
    not_a_directory: 'That path points at a file, not a folder.',
    not_found: 'That folder doesn’t exist. Check the path and try again.',
    duplicate: 'That folder is already registered.',
    limit_reached: 'You’ve reached the folder limit. Remove one before adding another.',
    feature_disabled: 'The knowledge layer is currently turned off.',
    invalid_path: 'Enter a full, absolute folder path.',
    picker_unavailable: 'The folder picker is unavailable right now. Type the path instead.',
  };

  function mapAddFolderReason(reason) {
    return ADD_FOLDER_REASON_COPY[String(reason || '')]
      || 'That folder can’t be registered right now.';
  }

  var REMOVE_FOLDER_REASON_COPY = {
    not_found: 'That folder is no longer registered.',
    feature_disabled: 'The knowledge layer is currently turned off.',
    schema_too_new: 'Knowledge folders saved by a newer Jenny version are read-only.',
  };

  function mapRemoveFolderReason(reason) {
    return REMOVE_FOLDER_REASON_COPY[String(reason || '')]
      || 'That folder could not be removed right now.';
  }

  function normalizeRoots(snapshot) {
    var roots = snapshot && Array.isArray(snapshot.roots) ? snapshot.roots : [];
    return roots
      .map(function (entry) {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        var id = String(entry.id || '').trim();
        var rootPath = String(entry.path || '').trim();
        if (!id || !rootPath) {
          return null;
        }
        return {
          id: id,
          path: rootPath,
          label: String(entry.label || '').trim(),
        };
      })
      .filter(Boolean);
  }

  function rootDisplayLabel(entry) {
    if (entry.label) {
      return entry.label;
    }
    var normalized = entry.path.replace(/[\\/]+$/, '');
    var separatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
    return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
  }

  function buildRowHtml(entry, pendingRemoveId) {
    var isPending = pendingRemoveId === entry.id;
    return ''
      + '<div class="settings-field-row knowledge-folders-row" data-root-id="' + escapeHtml(entry.id) + '">'
      + '<div class="settings-field-row-text">'
      + '<span class="settings-field-label">' + escapeHtml(rootDisplayLabel(entry)) + '</span>'
      + '<p class="settings-field-description knowledge-folders-row-path">' + escapeHtml(entry.path) + '</p>'
      + '</div>'
      + '<div class="knowledge-folders-row-actions">'
      + resolveActionButton()({
        plain: true,
        className: 'settings-secondary knowledge-folders-remove-btn',
        label: isPending ? 'Removing…' : 'Remove',
        disabled: isPending,
        dataset: { 'knowledge-folders-action': 'remove', 'root-id': entry.id },
      })
      + '</div>'
      + '</div>';
  }

  function buildConfirmModalHtml(entry, stepModal) {
    if (!entry || !stepModal || typeof stepModal.renderStepModal !== 'function') {
      return '';
    }
    return stepModal.renderStepModal({
      id: CONFIRM_MODAL_ID,
      tone: 'danger',
      title: 'Remove folder?',
      summary: 'The assistant will no longer be able to search "' + entry.path + '". The folder itself is not touched.',
      bodyHtml: '',
      actions: [
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
        { id: 'confirm', label: 'Remove', variant: 'danger' },
      ],
    });
  }

  function buildGroupHtml(view, hasPicker) {
    var actionButton = resolveActionButton();
    var rowsHtml = view.roots.length
      ? view.roots.map(function (entry) {
        return buildRowHtml(entry, view.pendingRemoveId);
      }).join('')
      : '<p class="settings-note">No folders registered yet. Registered folders become searchable by the assistant.</p>';

    var browseButtonHtml = hasPicker
      ? actionButton({
        plain: true,
        className: 'settings-secondary',
        label: 'Browse…',
        disabled: view.addBusy,
        dataset: { 'knowledge-folders-action': 'browse' },
      })
      : '';

    return ''
      + '<div class="settings-group knowledge-folders-group" role="group" aria-labelledby="knowledgeFoldersHeading" id="' + GROUP_ID + '">'
      + '<h4 class="settings-group-heading" id="knowledgeFoldersHeading">Knowledge folders</h4>'
      + '<p class="settings-group-copy">Folders the assistant can search and read with the knowledge tools.</p>'
      + '<div class="knowledge-folders-list">' + rowsHtml + '</div>'
      + '<div class="settings-field-row knowledge-folders-add-row">'
      + '<div class="settings-field-row-text">'
      + '<label class="settings-field-label" for="knowledgeFolderPathInput">Add a folder</label>'
      + '<p class="settings-field-description">Pick a folder or paste its full path.</p>'
      + '</div>'
      + resolveTextField()({
        id: 'knowledgeFolderPathInput',
        placeholder: 'C:\\Users\\you\\Documents\\notes',
        value: view.addInputValue || '',
        disabled: view.addBusy,
        ariaLabel: 'Folder path to register',
        className: 'knowledge-folders-add-input',
      })
      + '</div>'
      + '<div class="settings-actions">'
      + actionButton({
        plain: true,
        className: 'settings-primary',
        label: view.addBusy ? 'Adding…' : 'Add folder',
        disabled: view.addBusy,
        dataset: { 'knowledge-folders-action': 'add' },
      })
      + browseButtonHtml
      + '</div>'
      + '<div class="settings-note knowledge-folders-error" aria-live="polite">' + escapeHtml(view.errorMessage || '') + '</div>'
      + '</div>';
  }

  function createKnowledgeFoldersController(deps) {
    var d = deps || {};
    var state = d.state || {};
    var windowRef = d.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    var documentRef = d.documentRef || windowRef.document || null;
    var disposalFence = resolveAsyncFence().createDisposalFence();
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function noop() {};
    var stepModal = d.stepModal
      || (root && root.inventoryStepModal)
      || (typeof require === 'function' ? require('../inventory/step-modal') : null)
      || null;

    var unsubscribeChanged = null;
    var confirmRemoveId = '';

    var view = {
      roots: [],
      pendingRemoveId: '',
      addBusy: false,
      addInputValue: '',
      errorMessage: '',
    };

    function isFeatureEnabled() {
      return Boolean(
        state
        && state.features
        && state.features.featureFlags
        && state.features.featureFlags.knowledge_layer === true
      );
    }

    function knowledgeBridge() {
      return (windowRef.jennyShell && windowRef.jennyShell.knowledge) || null;
    }

    function findToolsCard() {
      if (!documentRef || typeof documentRef.querySelector !== 'function') {
        return null;
      }
      return documentRef.querySelector(TOOLS_SECTION_SELECTOR);
    }

    function removeExistingGroup() {
      var card = findToolsCard();
      var existing = card ? card.querySelector('#' + GROUP_ID) : (documentRef && documentRef.getElementById(GROUP_ID));
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }

    function confirmTarget() {
      if (!confirmRemoveId) {
        return null;
      }
      for (var i = 0; i < view.roots.length; i += 1) {
        if (view.roots[i].id === confirmRemoveId) {
          return view.roots[i];
        }
      }
      return null;
    }

    function render() {
      if (!isFeatureEnabled()) {
        removeExistingGroup();
        return;
      }
      var card = findToolsCard();
      if (!card) {
        return;
      }
      // Preserve a half-typed path across re-renders (opening the Remove
      // confirm re-renders the group and would otherwise wipe the input).
      var liveInput = card.querySelector('#knowledgeFolderPathInput');
      if (liveInput && !view.addBusy) {
        view.addInputValue = String(liveInput.value || '');
      }
      var bridge = knowledgeBridge();
      var hasPicker = Boolean(bridge && typeof bridge.chooseFolder === 'function');
      var html = buildGroupHtml(view, hasPicker);
      var existing = card.querySelector('#' + GROUP_ID);
      if (existing) {
        existing.outerHTML = html;
      } else {
        card.insertAdjacentHTML('beforeend', html);
      }
      renderConfirmModalIfNeeded();
    }

    function renderConfirmModalIfNeeded() {
      var existingBackdrop = documentRef && documentRef.querySelector('[data-step-modal="' + CONFIRM_MODAL_ID + '"]');
      if (existingBackdrop && existingBackdrop.parentNode) {
        existingBackdrop.parentNode.removeChild(existingBackdrop);
      }
      var target = confirmTarget();
      if (!target || !documentRef || !documentRef.body) {
        return;
      }
      var html = buildConfirmModalHtml(target, stepModal);
      if (!html) {
        return;
      }
      documentRef.body.insertAdjacentHTML('beforeend', html);
    }

    function applySnapshot(snapshot) {
      view.roots = normalizeRoots(snapshot);
      if (confirmRemoveId && !confirmTarget()) {
        confirmRemoveId = '';
      }
    }

    function loadState() {
      var bridge = knowledgeBridge();
      if (!bridge || typeof bridge.getState !== 'function') {
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(disposalFence.guard(function () {
          return bridge.getState();
        }))
        .then(disposalFence.guard(function (snapshot) {
          applySnapshot(snapshot);
        }))
        .catch(disposalFence.guard(function (error) {
          appendClientLog('WARN', 'knowledge_folders.get_state_failed', {
            message: error && error.message ? error.message : String(error),
          });
        }));
    }

    function refreshFromService() {
      return loadState().then(disposalFence.guard(function () {
        render();
      }));
    }

    function applyAddResult(result) {
      view.addBusy = false;
      if (result && result.ok === true) {
        view.addInputValue = '';
        view.errorMessage = '';
        return refreshFromService();
      }
      var reason = result && result.reason;
      if (reason === 'canceled') {
        render();
        return null;
      }
      view.errorMessage = mapAddFolderReason(reason);
      render();
      return null;
    }

    function handleAddTyped() {
      var bridge = knowledgeBridge();
      var input = documentRef && documentRef.getElementById('knowledgeFolderPathInput');
      var typedPath = input ? String(input.value || '').trim() : '';
      view.addInputValue = typedPath;
      if (!typedPath) {
        view.errorMessage = mapAddFolderReason('invalid_path');
        render();
        return;
      }
      if (!bridge || typeof bridge.addFolder !== 'function') {
        view.errorMessage = mapAddFolderReason('feature_disabled');
        render();
        return;
      }
      view.addBusy = true;
      view.errorMessage = '';
      render();
      Promise.resolve(bridge.addFolder({ path: typedPath }))
        .then(disposalFence.guard(applyAddResult))
        .catch(disposalFence.guard(function (error) {
          view.addBusy = false;
          view.errorMessage = mapAddFolderReason('');
          appendClientLog('WARN', 'knowledge_folders.add_failed', {
            message: error && error.message ? error.message : String(error),
          });
          render();
        }));
    }

    function handleBrowse() {
      var bridge = knowledgeBridge();
      if (!bridge || typeof bridge.chooseFolder !== 'function') {
        return;
      }
      view.addBusy = true;
      view.errorMessage = '';
      render();
      Promise.resolve(bridge.chooseFolder())
        .then(disposalFence.guard(applyAddResult))
        .catch(disposalFence.guard(function (error) {
          view.addBusy = false;
          view.errorMessage = mapAddFolderReason('');
          appendClientLog('WARN', 'knowledge_folders.choose_failed', {
            message: error && error.message ? error.message : String(error),
          });
          render();
        }));
    }

    function handleRemoveClick(rootId) {
      confirmRemoveId = rootId;
      render();
    }

    function handleConfirmCancel() {
      confirmRemoveId = '';
      render();
    }

    function handleConfirmRemove() {
      var rootId = confirmRemoveId;
      confirmRemoveId = '';
      if (!rootId) {
        render();
        return;
      }
      var bridge = knowledgeBridge();
      if (!bridge || typeof bridge.removeFolder !== 'function') {
        render();
        return;
      }
      view.pendingRemoveId = rootId;
      render();
      Promise.resolve(bridge.removeFolder({ id: rootId }))
        .then(disposalFence.guard(function (result) {
          view.pendingRemoveId = '';
          if (result && result.ok === true) {
            view.errorMessage = '';
            return refreshFromService();
          }
          view.errorMessage = mapRemoveFolderReason(result && result.reason);
          render();
          return null;
        }))
        .catch(disposalFence.guard(function (error) {
          view.pendingRemoveId = '';
          view.errorMessage = 'That folder could not be removed right now.';
          appendClientLog('WARN', 'knowledge_folders.remove_failed', {
            message: error && error.message ? error.message : String(error),
          });
          render();
        }));
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      var actionEl = target.closest('[data-knowledge-folders-action]');
      if (actionEl) {
        var action = actionEl.getAttribute('data-knowledge-folders-action');
        if (action === 'add') {
          handleAddTyped();
        } else if (action === 'browse') {
          handleBrowse();
        } else if (action === 'remove') {
          handleRemoveClick(actionEl.getAttribute('data-root-id') || '');
        }
        return;
      }
      var stepModalAction = target.closest('[data-step-modal-action]');
      if (stepModalAction && stepModalAction.closest('[data-step-modal="' + CONFIRM_MODAL_ID + '"]')) {
        var stepAction = stepModalAction.getAttribute('data-step-modal-action');
        if (stepAction === 'confirm') {
          handleConfirmRemove();
        } else if (stepAction === 'cancel') {
          handleConfirmCancel();
        }
        return;
      }
      // Backdrop click (inside the modal's backdrop but outside the dialog
      // panel) dismisses, matching standard modal affordances.
      var backdrop = target.closest('[data-step-modal="' + CONFIRM_MODAL_ID + '"]');
      if (backdrop && confirmRemoveId && !target.closest('.inv-step-modal')) {
        handleConfirmCancel();
      }
    }

    function handleKeydown(event) {
      if (event && event.key === 'Escape' && confirmRemoveId) {
        handleConfirmCancel();
      }
    }

    // Re-run after feature hydration because the boot seed omits knowledge_layer;
    // subscription and mounting are idempotent.
    function syncFeatureState() {
      if (!isFeatureEnabled()) {
        if (typeof unsubscribeChanged === 'function') {
          try { unsubscribeChanged(); } catch (_error) { /* ignore */ }
          unsubscribeChanged = null;
        }
        removeExistingGroup();
        return;
      }
      var bridge = knowledgeBridge();
      if (!unsubscribeChanged && bridge && typeof bridge.onChanged === 'function') {
        // Changed pushes carry the snapshot — no getState round-trip needed.
        unsubscribeChanged = bridge.onChanged(disposalFence.guard(function (snapshot) {
          applySnapshot(snapshot);
          render();
        }));
      }
      refreshFromService();
    }

    function bind() {
      if (!documentRef || typeof documentRef.addEventListener !== 'function') {
        return;
      }
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('keydown', handleKeydown);
      syncFeatureState();
    }

    function dispose() {
      if (!disposalFence.dispose()) return;
      if (typeof unsubscribeChanged === 'function') {
        try {
          unsubscribeChanged();
        } catch (_error) {
          /* ignore */
        }
        unsubscribeChanged = null;
      }
      if (documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('click', handleClick);
        documentRef.removeEventListener('keydown', handleKeydown);
      }
      removeExistingGroup();
      var backdrop = documentRef && documentRef.querySelector('[data-step-modal="' + CONFIRM_MODAL_ID + '"]');
      if (backdrop && backdrop.parentNode) {
        backdrop.parentNode.removeChild(backdrop);
      }
    }

    return {
      bind: bind,
      dispose: dispose,
      render: render,
      syncFeatureState: syncFeatureState,
      isFeatureEnabled: isFeatureEnabled,
      _view: view,
    };
  }

  return {
    createKnowledgeFoldersController: createKnowledgeFoldersController,
    mapAddFolderReason: mapAddFolderReason,
    normalizeRoots: normalizeRoots,
  };
});
