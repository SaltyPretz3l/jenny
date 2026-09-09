(function initializeDataLifecycleSettings(root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var RESTORE_SUPPRESSION_KEY = 'jenny.restore.suppressedFingerprint.v1';

  function start() {
    var api = root.jennyShell && root.jennyShell.dataLifecycle;
    var mount = root.document.getElementById('dataLifecycleSettingsMount');
    var actionButton = root.inventoryActionButton;
    var textField = root.inventoryTextField;
    var toggle = root.inventoryToggleSwitch;
    var progressBar = root.inventoryProgressBar;
    var utils = root.dataLifecycleUtils;
    if (!api || !mount || !actionButton || !textField || !toggle || !progressBar || !utils) return;

    var overview = utils.normalizeOverview(null);
    var modal = null;
    var modalBusy = false;
    var previousFocus = null;
    var selectedArchive = null;
    var disposed = false;
    var modalEpoch = 0;

    function captureModal() {
      return { element: modal, epoch: modalEpoch };
    }

    function isCurrentModal(context) {
      return !disposed && modal === context.element && modalEpoch === context.epoch;
    }

    function escapeHtml(value) {
      return actionButton.escapeHtml(String(value == null ? '' : value));
    }

    function button(id, label, variant, extra) {
      return actionButton(Object.assign({ id: id, label: label, variant: variant || 'secondary' }, extra || {}));
    }

    function setStatus(message, tone) {
      var status = root.document.getElementById('dataLifecycleSettingsStatus');
      if (!status) return;
      status.textContent = String(message || '');
      status.dataset.tone = String(tone || 'muted');
    }

    function renderSettings() {
      mount.innerHTML = '<div class="settings-setup-row data-lifecycle-settings-row">'
        + '<div><h4 class="settings-setup-row-title">' + jt('dataLifecycle.settings.title', 'Data & removal') + '</h4>'
        + '<p class="settings-group-copy">' + jt('dataLifecycle.settings.description', 'Archive, restore, or remove Jenny without touching shared models or ordinary project files.') + '</p>'
        + '<p class="settings-group-copy">' + jt('dataLifecycle.settings.localDataDescription', 'Chats, attachments, preferences, personality, calendar, and memory remain local until you delete or remove them. Usage diagnostics retain at most 30 days and 500 turns. Optional workspace archives include only reviewed portable data under the current .jenny folder.') + '</p>'
        + '<div class="data-lifecycle-settings-counts">'
        + '<span>' + escapeHtml(utils.formatCount(overview.chats, 'chat', 'chats')) + '</span>'
        + '<span>' + escapeHtml(utils.formatCount(overview.attachments, 'attachment', 'attachments')) + '</span>'
        + '<span>' + escapeHtml(jt('dataLifecycle.settings.preferencesIncluded', 'Preferences included · {memory}', { memory: utils.formatCount(overview.memory, 'memory store', 'memory stores') })) + '</span>'
        + '<span>' + escapeHtml(overview.workspaceAvailable ? jtn('dataLifecycle.settings.workspaceItemCount', Math.max(0, Math.floor(Number(overview.workspace) || 0)), { count: Math.max(0, Math.floor(Number(overview.workspace) || 0)).toLocaleString(globalThis.jennyI18n?.tag?.()) }, '{count} workspace item', '{count} workspace items') : jt('dataLifecycle.settings.noCurrentWorkspace', 'No current workspace')) + '</span>'
        + '</div><div class="settings-note" id="dataLifecycleSettingsStatus" aria-live="polite">' + jt('dataLifecycle.settings.summaryReady', 'Data summary is ready.') + '</div></div>'
        + '<div class="settings-actions data-lifecycle-settings-actions">'
        + button('settings-create-archive', jt('dataLifecycle.actions.createArchive', 'Create archive'), 'secondary')
        + button('settings-restore-archive', jt('dataLifecycle.actions.restoreProfile', 'Restore profile'), 'secondary')
        + (overview.workspaceAvailable ? button('settings-restore-workspace', jt('dataLifecycle.actions.restoreWorkspaceData', 'Restore workspace data'), 'secondary') : '')
        + button('settings-uninstall', jt('dataLifecycle.actions.uninstallJenny', 'Uninstall Jenny'), 'danger')
        + '</div></div>';
    }

    function closeModal() {
      if (modalBusy || !modal) return;
      modal.remove();
      modal = null;
      modalEpoch += 1;
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    }

    function installModalKeyboard() {
      if (!modal) return;
      modal.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !modalBusy) {
          event.preventDefault();
          closeModal();
          return;
        }
        if (event.key !== 'Tab') return;
        var focusable = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled])'))
          .filter(function (element) { return !element.closest('[hidden]'); });
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && root.document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && root.document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      var initial = modal.querySelector('input, button');
      if (initial) initial.focus();
    }

    function modalShell(title, copy, body, footer) {
      return '<div class="data-lifecycle-modal-backdrop"><section class="data-lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="dataLifecycleModalTitle">'
        + '<header><h2 id="dataLifecycleModalTitle">' + escapeHtml(title) + '</h2><p>' + escapeHtml(copy) + '</p></header>'
        + '<div class="data-lifecycle-modal-body">' + body + '<div class="data-lifecycle-modal-status" id="dataLifecycleModalStatus" aria-live="polite"></div></div>'
        + '<footer>' + footer + '</footer></section></div>';
    }

    function openArchiveModal() {
      modalBusy = false;
      previousFocus = root.document.activeElement;
      var body = '<div class="data-lifecycle-mode-options" role="group" aria-label="' + escapeHtml(jt('dataLifecycle.archive.privacyLabel', 'Archive privacy')) + '">'
        + button('modal-mode-encrypted', 'Encrypted (recommended)', 'secondary', { ariaPressed: true })
        + '</div><details class="data-lifecycle-advanced"><summary>Advanced</summary>'
        + '<p class="data-lifecycle-privacy-warning">' + escapeHtml(jt('dataLifecycle.archive.plainPrivacyWarning', 'Plain archives have no password protection. Anyone with folder access can read them.')) + '</p>'
        + button('modal-mode-plain', jt('dataLifecycle.archive.useReadablePlain', 'Use readable plain archive'), 'danger', { ariaPressed: false })
        + '</details>'
        + '<p class="data-lifecycle-privacy-warning" id="settingsArchivePrivacy">' + escapeHtml(jt('dataLifecycle.archive.protectedByPassphrase', 'Your archive is protected by a passphrase that Jenny never stores.')) + '</p>'
        + '<div class="data-lifecycle-destination"><span id="settingsArchiveDestination">' + escapeHtml(overview.defaultArchiveRoot) + '</span>'
        + button('modal-change-destination', 'Change', 'secondary', { size: 'sm' }) + '</div>'
        + '<div class="data-lifecycle-fields" id="settingsArchivePassphraseFields">'
        + textField({ id: 'settingsArchivePassphrase', type: 'password', label: jt('dataLifecycle.archive.passphraseLabel', 'Passphrase'), maxLength: 1024, hint: jt('dataLifecycle.archive.passphraseHint', '12–1024 characters.') })
        + textField({ id: 'settingsArchiveConfirmation', type: 'password', label: jt('dataLifecycle.archive.confirmPassphraseLabel', 'Confirm passphrase'), maxLength: 1024 })
        + '</div>'
        + (overview.workspaceAvailable ? toggle.toggleSwitch({ id: 'settings-archive-workspace', label: jt('dataLifecycle.archive.includeWorkspace', 'Include current workspace .jenny data'), checked: false }) : '');
      var wrapper = root.document.createElement('div');
      wrapper.innerHTML = modalShell(jt('dataLifecycle.archive.createTitle', 'Create a Jenny archive'), jt('dataLifecycle.archive.createDescription', 'This makes a verified encrypted copy and does not remove anything.'), body,
        button('modal-close', 'Cancel', 'secondary') + button('modal-create-archive', jt('dataLifecycle.actions.createArchive', 'Create archive'), 'primary'));
      modal = wrapper.firstElementChild;
      modalEpoch += 1;
      modal.dataset.destinationRoot = overview.defaultArchiveRoot;
      modal.dataset.encrypted = 'true';
      root.document.body.appendChild(modal);
      toggle.initToggleHandlers(modal);
      installModalKeyboard();
    }

    function openRestoreModal(candidate, automatic, workspaceOnly) {
      modalBusy = false;
      selectedArchive = candidate;
      previousFocus = root.document.activeElement;
      var details = '<div class="data-lifecycle-review-card"><h3>' + escapeHtml(jt('dataLifecycle.restore.recoverableArchive', 'Recoverable archive')) + '</h3><dl><dt>Created</dt><dd>'
        + escapeHtml(candidate.createdAt || 'Unknown') + '</dd><dt>Contents</dt><dd>'
        + escapeHtml(utils.formatCount(candidate.counts && candidate.counts.entries, 'item', 'items')) + ', '
        + escapeHtml(utils.formatBytes(candidate.counts && candidate.counts.bytes)) + '</dd></dl></div>'
        + (candidate.encrypted ? textField({ id: 'settingsRestorePassphrase', type: 'password', label: jt('dataLifecycle.restore.passphraseLabel', 'Archive passphrase'), maxLength: 1024 }) : '')
        + (workspaceOnly ? '<div id="settingsWorkspaceRestoreReview" class="data-lifecycle-review-card"><p>' + escapeHtml(jt('dataLifecycle.restore.reviewExactWorkspaceTarget', 'Review the exact .jenny target and conflicts before any workspace file changes.')) + '</p></div>' : '');
      var footer = button(automatic ? 'modal-not-now' : 'modal-close', automatic ? jt('dataLifecycle.actions.notNow', 'Not now') : 'Cancel', 'secondary')
        + button('modal-choose-archive', jt('dataLifecycle.actions.chooseAnother', 'Choose another'), 'secondary')
        + button(workspaceOnly ? 'modal-review-workspace-restore' : 'modal-restore', workspaceOnly ? jt('dataLifecycle.actions.reviewWorkspaceRestore', 'Review workspace restore') : jt('dataLifecycle.actions.stageProfileRestore', 'Stage profile restore'), 'primary');
      var wrapper = root.document.createElement('div');
      wrapper.innerHTML = modalShell(
        workspaceOnly ? jt('dataLifecycle.actions.restoreWorkspaceData', 'Restore workspace data') : jt('dataLifecycle.restore.profileTitle', 'Restore Jenny profile'),
        workspaceOnly
          ? jt('dataLifecycle.restore.workspaceScopeDescription', 'Only the current workspace .jenny data can change, after target and conflict review.')
          : jt('dataLifecycle.restore.profileDescription', 'Profile restore is staged now and promoted safely on restart. It never changes workspace files.'),
        details,
        footer
      );
      modal = wrapper.firstElementChild;
      modalEpoch += 1;
      modal.dataset.workspaceOnly = workspaceOnly ? 'true' : 'false';
      root.document.body.appendChild(modal);
      toggle.initToggleHandlers(modal);
      installModalKeyboard();
    }

    function setModalStatus(message, tone, progress) {
      var status = modal && modal.querySelector('#dataLifecycleModalStatus');
      if (!status) return;
      status.dataset.tone = String(tone || 'muted');
      status.innerHTML = progress
        ? '<p>' + escapeHtml(message) + '</p>' + progressBar({ value: progress.percent, max: 100, label: message })
        : escapeHtml(message);
    }

    async function chooseArchiveDestination() {
      var context = captureModal();
      try {
        var result = await api.chooseArchiveDestination();
      } catch (_error) {
        if (isCurrentModal(context)) setModalStatus(jt('dataLifecycle.archive.destinationUnavailable', 'Archive destination selection is unavailable.'), 'danger');
        return;
      }
      if (isCurrentModal(context) && result && result.ok && result.destinationRoot) {
        context.element.dataset.destinationRoot = result.destinationRoot;
        var label = context.element.querySelector('#settingsArchiveDestination');
        if (label) label.textContent = result.destinationRoot;
      }
    }

    async function createSettingsArchive() {
      var context = captureModal();
      if (!context.element) return;
      var passphrase = context.element.querySelector('#settingsArchivePassphrase');
      var confirmation = context.element.querySelector('#settingsArchiveConfirmation');
      var workspaceToggle = context.element.querySelector('[data-inv-toggle="settings-archive-workspace"]');
      var encrypted = context.element.dataset.encrypted !== 'false';
      var includeWorkspace = workspaceToggle ? workspaceToggle.getAttribute('aria-checked') === 'true' : false;
      if (includeWorkspace && !context.element.dataset.workspaceReviewId) {
        if (typeof api.previewWorkspaceArchive !== 'function') {
          setModalStatus(jt('dataLifecycle.archive.workspaceReviewUnavailable', 'Workspace archive review is unavailable in this build.'), 'danger');
          return;
        }
        modalBusy = true;
        setModalStatus(jt('dataLifecycle.archive.reviewingWorkspaceScope', 'Reviewing bounded workspace scope…'), 'pending');
        try {
          var preview = await api.previewWorkspaceArchive();
        } catch (_error) {
          if (isCurrentModal(context)) setModalStatus(jt('dataLifecycle.archive.workspaceReviewBridgeUnavailable', 'Workspace review failed safely: bridge_unavailable'), 'danger');
          return;
        } finally {
          if (isCurrentModal(context)) modalBusy = false;
        }
        if (!isCurrentModal(context)) return;
        if (!preview || !preview.ok) {
          setModalStatus(jt('dataLifecycle.archive.workspaceReviewFailed', 'Workspace review failed safely: {reason}', { reason: String(preview?.error?.reason || 'review_failed') }), 'danger');
          return;
        }
        context.element.dataset.workspaceReviewId = preview.reviewId;
        setModalStatus(jt('dataLifecycle.archive.scopeApprovalPrompt', 'Approve {workspaceName} ({workspaceId}): {itemCount}, {totalBytes}, scope: {scope}. Click Create archive again to approve this exact scope.', { workspaceName: preview.workspace.name, workspaceId: preview.workspace.id, itemCount: utils.formatCount(preview.itemCount, 'item', 'items'), totalBytes: utils.formatBytes(preview.totalBytes), scope: preview.scope }),
          'warning');
        return;
      }
      var workspaceReviewId = context.element.dataset.workspaceReviewId || '';
      delete context.element.dataset.workspaceReviewId;
      modalBusy = true;
      setModalStatus(jt('dataLifecycle.archive.preparing', 'Preparing archive…'), 'pending');
      try {
        var result = await api.createArchive({
          destinationRoot: context.element.dataset.destinationRoot,
          encrypted: encrypted,
          passphrase: encrypted && passphrase ? passphrase.value : '',
          passphraseConfirmation: encrypted && confirmation ? confirmation.value : '',
          includeWorkspace: includeWorkspace,
          workspaceReviewId: workspaceReviewId,
        });
      } catch (_error) {
        if (isCurrentModal(context)) setModalStatus(jt('dataLifecycle.archive.failedBridgeUnavailable', 'Archive failed safely: bridge_unavailable'), 'danger');
        return;
      } finally {
        if (isCurrentModal(context)) modalBusy = false;
      }
      if (!isCurrentModal(context)) return;
      if (!result || !result.ok) {
        setModalStatus(jt('dataLifecycle.archive.failed', 'Archive failed safely: {reason}', { reason: String(result && result.error && result.error.reason || 'operation_failed') }), 'danger');
        return;
      }
      setStatus(jt('dataLifecycle.archive.createdVerified', 'Archive created and verified.'), 'success');
      closeModal();
    }

    async function restoreSelectedArchive() {
      var context = captureModal();
      if (!context.element) return;
      var passphrase = context.element.querySelector('#settingsRestorePassphrase');
      modalBusy = true;
      setModalStatus(jt('dataLifecycle.restore.validatingArchive', 'Validating archive…'), 'pending');
      try {
        var result = await api.stageRestore({
          archivePath: selectedArchive.archivePath,
          passphrase: passphrase ? passphrase.value : '',
        });
      } catch (_error) {
        if (isCurrentModal(context)) setModalStatus(jt('dataLifecycle.restore.stoppedBridgeUnavailable', 'Restore stopped safely: bridge_unavailable'), 'danger');
        return;
      } finally {
        if (isCurrentModal(context)) modalBusy = false;
      }
      if (!isCurrentModal(context)) return;
      if (!result || !result.ok) {
        var reason = String(result && result.error && result.error.reason || 'restore_failed');
        setModalStatus(reason === 'profile_not_fresh'
          ? jt('dataLifecycle.restore.profileNotFresh', 'This profile already contains data. Use the existing session importer for individual chats.')
          : jt('dataLifecycle.restore.stopped', 'Restore stopped safely: {reason}', { reason: reason }), 'danger');
        return;
      }
      setStatus(jt('dataLifecycle.restore.stagedRestart', 'Restore staged. Restart Jenny to finish restoring your data.'), 'success');
      closeModal();
    }

    async function reviewOrRestoreWorkspace() {
      var context = captureModal();
      if (!context.element) return;
      var passphrase = context.element.querySelector('#settingsRestorePassphrase');
      var payload = {
        archivePath: selectedArchive.archivePath,
        passphrase: passphrase ? passphrase.value : '',
      };
      var reviewId = context.element.dataset.workspaceReviewId || '';
      var isRestore = Boolean(reviewId);
      if (isRestore) delete context.element.dataset.workspaceReviewId;
      modalBusy = true;
      setModalStatus(isRestore ? jt('dataLifecycle.restore.restoringWorkspace', 'Restoring reviewed workspace data…') : jt('dataLifecycle.restore.reviewingWorkspace', 'Reviewing workspace target and conflicts…'), 'pending');
      var operation = isRestore ? api.restoreWorkspace : api.previewWorkspaceRestore;
      if (typeof operation !== 'function') {
        modalBusy = false;
        setModalStatus(jt('dataLifecycle.restore.workspaceReviewUnavailable', 'Workspace restore review is unavailable in this build.'), 'danger');
        return;
      }
      try {
        var result = await operation.call(api, isRestore
          ? Object.assign({}, payload, { reviewId: reviewId })
          : payload);
      } catch (_error) {
        if (isCurrentModal(context)) setModalStatus(jt('dataLifecycle.restore.workspaceStoppedBridgeUnavailable', 'Workspace restore stopped safely: bridge_unavailable'), 'danger');
        return;
      } finally {
        if (isCurrentModal(context)) modalBusy = false;
      }
      if (!isCurrentModal(context)) return;
      if (!result || !result.ok) {
        setModalStatus(jt('dataLifecycle.restore.workspaceStopped', 'Workspace restore stopped safely: {reason}', { reason: String(result?.error?.reason || 'restore_failed') }), 'danger');
        return;
      }
      if (!isRestore) {
        context.element.dataset.workspaceReviewId = result.reviewId;
        var review = context.element.querySelector('#settingsWorkspaceRestoreReview');
        if (review) {
          review.innerHTML = '<h3>' + jt('dataLifecycle.restore.exactWorkspaceScope', 'Exact workspace scope') + '</h3><dl><dt>' + jt('dataLifecycle.restore.target', 'Target') + '</dt><dd>'
            + escapeHtml(result.workspace.name + ' (' + result.workspace.id + ')')
            + '</dd><dt>' + jt('dataLifecycle.restore.scope', 'Scope') + '</dt><dd>' + escapeHtml(result.scope)
            + '</dd><dt>' + jt('dataLifecycle.restore.contents', 'Contents') + '</dt><dd>' + escapeHtml(utils.formatCount(result.itemCount, 'item', 'items') + ', ' + utils.formatBytes(result.totalBytes))
            + '</dd><dt>' + jt('dataLifecycle.restore.conflicts', 'Conflicts') + '</dt><dd>' + escapeHtml(jtn('dataLifecycle.restore.existingFileCount', Math.max(0, Math.floor(Number(result.conflictCount) || 0)), { count: Math.max(0, Math.floor(Number(result.conflictCount) || 0)).toLocaleString(globalThis.jennyI18n?.tag?.()) }, '{count} existing file', '{count} existing files'))
            + (result.conflicts?.length ? ': ' + escapeHtml(result.conflicts.join(', ')) : '')
            + '</dd></dl>';
        }
        var confirm = context.element.querySelector('[data-action="modal-review-workspace-restore"]');
        if (confirm) confirm.textContent = jt('dataLifecycle.restore.approveWorkspace', 'Approve and restore workspace');
        setModalStatus(jt('dataLifecycle.restore.approveReviewedTarget', 'Review the exact target and conflicts, then approve the workspace mutation.'), 'warning');
        return;
      }
      setStatus(jt('dataLifecycle.restore.workspaceRestored', 'Workspace data restored with rollback protection.'), 'success');
      closeModal();
    }

    async function chooseAnotherArchive() {
      var restoreFocus = previousFocus;
      var workspaceOnly = modal?.dataset?.workspaceOnly === 'true';
      modalBusy = true;
      var result;
      try {
        result = await api.findRestoreCandidates({ chooseAnother: true });
      } finally {
        modalBusy = false;
      }
      if (result && result.ok && result.candidates && result.candidates[0]) {
        if (modal) { modal.remove(); modal = null; }
        openRestoreModal(result.candidates[0], false, workspaceOnly);
        previousFocus = restoreFocus;
      } else if (!result || !result.ok) {
        setModalStatus(jt('dataLifecycle.restore.incompatibleFolder', 'That folder is not a complete compatible Jenny archive.'), 'danger');
      } else {
        setModalStatus(jt('dataLifecycle.restore.noArchiveSelected', 'No archive was selected.'), 'muted');
      }
    }

    function setArchiveEncryption(encrypted) {
      if (!modal) return;
      modal.dataset.encrypted = encrypted ? 'true' : 'false';
      var encryptedButton = modal.querySelector('[data-action="modal-mode-encrypted"]');
      var plainButton = modal.querySelector('[data-action="modal-mode-plain"]');
      var fields = modal.querySelector('#settingsArchivePassphraseFields');
      var warning = modal.querySelector('#settingsArchivePrivacy');
      if (encryptedButton) encryptedButton.setAttribute('aria-pressed', encrypted ? 'true' : 'false');
      if (plainButton) plainButton.setAttribute('aria-pressed', encrypted ? 'false' : 'true');
      if (fields) fields.hidden = !encrypted;
      if (warning) warning.textContent = encrypted
        ? jt('dataLifecycle.archive.encryptedWarning', 'Your archive is protected by a passphrase that Jenny never stores.')
        : jt('dataLifecycle.archive.plainWarning', 'Plain archives are readable by anyone with access to the folder. Store this archive privately.');
    }

    async function handleSettingsClick(event) {
      var target = event.target.closest('[data-action]');
      if (!target) return;
      if (target.dataset.action === 'settings-create-archive') openArchiveModal();
      if (target.dataset.action === 'settings-restore-archive') {
        var result = await api.findRestoreCandidates();
        if (!result || !result.ok) {
          setStatus(jt('dataLifecycle.restore.temporarilyUnavailable', 'Restore is temporarily unavailable.'), 'danger');
        } else if (!result.freshProfile) {
          setStatus(jt('dataLifecycle.restore.requiresFreshProfile', 'Full restore requires a fresh profile. Use the session importer for individual chats.'), 'warning');
        } else if (result.candidates && result.candidates[0]) {
          openRestoreModal(result.candidates[0], false, false);
        } else {
          var chosen = await api.findRestoreCandidates({ chooseAnother: true });
          if (chosen.ok && chosen.candidates && chosen.candidates[0]) openRestoreModal(chosen.candidates[0], false, false);
          else setStatus(jt('dataLifecycle.restore.noCompatibleArchive', 'No complete compatible Jenny archive was selected.'), 'warning');
        }
      }
      if (target.dataset.action === 'settings-restore-workspace') {
        var workspaceCandidates = await api.findRestoreCandidates();
        var workspaceCandidate = workspaceCandidates?.candidates?.[0];
        if (!workspaceCandidate) {
          var selected = await api.findRestoreCandidates({ chooseAnother: true });
          workspaceCandidate = selected?.candidates?.[0];
        }
        if (workspaceCandidate) openRestoreModal(workspaceCandidate, false, true);
        else setStatus(jt('dataLifecycle.restore.noCompatibleArchive', 'No complete compatible Jenny archive was selected.'), 'warning');
      }
      if (target.dataset.action === 'settings-uninstall') {
        var launch = await api.launchUninstallAssistant();
        setStatus(launch && launch.instructions
          ? launch.instructions
          : jt('dataLifecycle.uninstall.usePlatformHelper', 'Use your platform uninstall helper to continue.'), launch && launch.ok ? 'warning' : 'danger');
      }
    }
    mount.addEventListener('click', function (event) {
      void handleSettingsClick(event).catch(function () {
        if (!disposed) setStatus(jt('dataLifecycle.errors.actionUnavailable', 'Data action is temporarily unavailable.'), 'danger');
      });
    });

    async function handleModalClick(event) {
      if (!modal) return;
      var target = event.target.closest('[data-action]');
      if (!target || modalBusy) return;
      var action = target.dataset.action;
      if (action === 'modal-close') closeModal();
      else if (action === 'modal-not-now') {
        try { root.localStorage.setItem(RESTORE_SUPPRESSION_KEY, selectedArchive.fingerprint); } catch (_error) { /* optional */ }
        closeModal();
      } else if (action === 'modal-change-destination') await chooseArchiveDestination();
      else if (action === 'modal-mode-encrypted') setArchiveEncryption(true);
      else if (action === 'modal-mode-plain') setArchiveEncryption(false);
      else if (action === 'modal-create-archive') await createSettingsArchive();
      else if (action === 'modal-restore') await restoreSelectedArchive();
      else if (action === 'modal-review-workspace-restore') await reviewOrRestoreWorkspace();
      else if (action === 'modal-choose-archive') await chooseAnotherArchive();
    }
    root.document.body.addEventListener('click', function (event) {
      void handleModalClick(event).catch(function () {
        if (!disposed && modal) {
          modalBusy = false;
          setModalStatus(jt('dataLifecycle.errors.bridgeUnavailable', 'This action stopped safely because the app bridge became unavailable.'), 'danger');
        }
      });
    });

    var stopProgress = api.onProgress(function (progress) {
      if (!disposed && modal && modalBusy) setModalStatus(progress.label || 'Working…', 'pending', progress);
    });

    function syncPortablePreferences() {
      var appearance = root.appearanceUtils?.loadAppearancePreferences?.(root.localStorage) || {};
      var chatZoomPercent = Number(root.document.documentElement.dataset.chatZoom || 100);
      var preferredModel = String(root.document.getElementById('composerModelSelect')?.value || '').trim();
      var preferences = { appearance: appearance, chatZoomPercent: chatZoomPercent };
      if (preferredModel) preferences.preferredModel = preferredModel;
      void Promise.resolve(api.syncPortablePreferences(preferences)).catch(function () {});
    }
    syncPortablePreferences();
    var syncTimer = null;
    var observer = new root.MutationObserver(function () {
      root.clearTimeout(syncTimer);
      syncTimer = root.setTimeout(syncPortablePreferences, 250);
    });
    observer.observe(root.document.documentElement, {
      attributes: true,
      attributeFilter: [
        'data-palette', 'data-typography', 'data-motion', 'data-surface-effect',
        'data-composer-holo', 'data-sprite-holo', 'data-thread-style',
        'data-timeline-style', 'data-font-scale', 'data-chat-zoom',
        'data-chat-width',
      ],
    });
    function dispose() {
      if (disposed) return;
      disposed = true;
      modalEpoch += 1;
      modalBusy = false;
      root.clearTimeout(syncTimer);
      observer.disconnect();
      if (typeof stopProgress === 'function') stopProgress();
    }
    if (typeof root.addEventListener === 'function') root.addEventListener('beforeunload', dispose, { once: true });
    root.document.addEventListener('change', function (event) {
      // aria-disabled = the inert-readable lock (offline/auth/plugin): a
      // label-forwarded change on a locked select must not reach the
      // portable-preferences store.
      if (event.target && event.target.id === 'composerModelSelect'
        && event.target.getAttribute('aria-disabled') !== 'true') syncPortablePreferences();
      if (event.target?.closest?.('[data-inv-toggle="settings-archive-workspace"]') && modal) {
        delete modal.dataset.workspaceReviewId;
      }
    });

    api.getOverview().then(async function (result) {
      if (disposed) return;
      if (!result || !result.ok) {
        renderSettings();
        setStatus(jt('dataLifecycle.settings.summaryUnavailable', 'Data summary is temporarily unavailable.'), 'danger');
        return;
      }
      overview = utils.normalizeOverview(result);
      renderSettings();
      var candidates = await api.findRestoreCandidates();
      if (disposed) return;
      var candidate = candidates && candidates.ok && candidates.freshProfile
        && candidates.candidates && candidates.candidates[0];
      var suppressed = '';
      try { suppressed = root.localStorage.getItem(RESTORE_SUPPRESSION_KEY) || ''; } catch (_error) { /* optional */ }
      if (!modal && candidate && candidate.fingerprint !== suppressed) openRestoreModal(candidate, true, false);
    }).catch(function () {
      if (disposed) return;
      renderSettings();
      setStatus(jt('dataLifecycle.settings.summaryUnavailable', 'Data summary is temporarily unavailable.'), 'danger');
    });
  }

  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
