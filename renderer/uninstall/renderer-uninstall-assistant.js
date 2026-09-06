(function initializeUninstallAssistant(root) {
  'use strict';

  var api = root.jennyUninstall;
  var host = root.document && root.document.getElementById('dataLifecycleAssistant');
  var actionButton = root.inventoryActionButton;
  var textField = root.inventoryTextField;
  var toggle = root.inventoryToggleSwitch;
  var progressBar = root.inventoryProgressBar;
  var utils = root.dataLifecycleUtils;
  var asyncFence = root.rendererAsyncFence;
  if (!api || !host || !actionButton || !textField || !toggle || !progressBar || !utils || !asyncFence) return;

  var state = {
    view: 'loading',
    overview: utils.normalizeOverview(null),
    destinationRoot: '',
    encrypted: true,
    includeWorkspace: false,
    workspaceReview: null,
    removeWorkspaceData: false,
    progress: null,
    operationId: '',
    errorReason: '',
    removalMode: '',
    archivePath: '',
    cleanupResults: [],
    warnings: [],
    cancelRequested: false,
    commitStarted: false,
  };
  var focusedView = '';
  // W4-60-F05: the workspace-review preview is the assistant's one await that
  // can race a second click or a view change; the flag is the synchronous
  // in-flight claim and the gate invalidates a stale continuation after the
  // user leaves and re-enters the archive view.
  var workspaceReviewPending = false;
  var workspaceReviewGate = asyncFence.createGenerationGate();

  function escapeHtml(value) {
    return actionButton.escapeHtml(String(value == null ? '' : value));
  }

  function button(id, label, variant, extra) {
    return actionButton(Object.assign({ id: id, label: label, variant: variant || 'secondary' }, extra || {}));
  }

  function shell(content, footer, options) {
    var settings = options || {};
    return '<main class="data-lifecycle-shell" aria-labelledby="dataLifecycleTitle">'
      + '<header class="data-lifecycle-header">'
      + '<span class="data-lifecycle-eyebrow">DATA &amp; REMOVAL</span>'
      + '<h1 id="dataLifecycleTitle" tabindex="-1">' + escapeHtml(settings.title || 'Before Jenny leaves this device') + '</h1>'
      + '<p>' + escapeHtml(settings.subtitle || 'Choose what should happen to your Jenny data.') + '</p>'
      + '</header>'
      + '<div class="data-lifecycle-scroll">' + content + '</div>'
      + '<footer class="data-lifecycle-footer">' + footer + '</footer>'
      + '</main>';
  }

  function summaryMarkup() {
    var o = state.overview;
    var items = [
      ['Chats', utils.formatCount(o.chats, 'chat', 'chats')],
      ['Attachments', utils.formatCount(o.attachments, 'attachment', 'attachments')],
      ['Preferences & memory', 'Included · ' + utils.formatCount(o.memory, 'memory store', 'memory stores')],
      ['Current workspace', o.workspaceAvailable ? utils.formatCount(o.workspace, 'Jenny item', 'Jenny items') : 'Not selected'],
    ];
    return '<section class="data-lifecycle-summary" aria-label="Jenny data summary">'
      + items.map(function (item) {
        return '<div class="data-lifecycle-summary-item"><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong></div>';
      }).join('')
      + '</section>';
  }

  function renderLanding() {
    var safeLane = '<section class="data-lifecycle-lane data-lifecycle-lane--safe">'
      + '<div class="data-lifecycle-lane-copy"><span class="data-lifecycle-glyph" aria-hidden="true">&#10003;</span><div>'
      + '<h2>Keep a recoverable archive</h2><p>Encrypt and verify a portable copy before Jenny data is removed.</p>'
      + '<dl><div><dt>Protection</dt><dd>Encrypted by default</dd></div><div><dt>Destination</dt><dd>' + escapeHtml(state.destinationRoot) + '</dd></div></dl>'
      + '</div></div>'
      + '<div class="data-lifecycle-lane-actions">'
      + button('review-archive', 'Archive & remove', 'primary', { size: 'lg' })
      + button('app-only', 'Remove app only and leave Jenny data in place', 'ghost', { className: 'data-lifecycle-quiet-action' })
      + '</div></section>';
    var dangerLane = '<section class="data-lifecycle-lane data-lifecycle-lane--danger">'
      + '<div class="data-lifecycle-lane-copy"><span class="data-lifecycle-glyph" aria-hidden="true">!</span><div>'
      + '<h2>Permanently remove everything</h2><p>Delete known Jenny-owned profile data. Shared models and ordinary project files stay.</p>'
      + '</div></div>'
      + button('review-permanent', 'Review permanent removal', 'danger')
      + '</section>';
    host.innerHTML = shell(summaryMarkup() + safeLane + dangerLane, button('cancel', 'Cancel', 'secondary'));
  }

  function categoriesMarkup() {
    var workspaceText = state.overview.workspaceAvailable
      ? 'Current workspace .jenny data (' + state.overview.workspaceName + ')'
      : 'No current workspace selected';
    return '<section class="data-lifecycle-review-card"><h2>Archive contents</h2><ul class="data-lifecycle-check-list">'
      + '<li><span aria-hidden="true">&#10003;</span>Chats and managed attachments</li>'
      + '<li><span aria-hidden="true">&#10003;</span>Safe preferences, personality, and memory</li>'
      + '<li><span aria-hidden="true">&#10003;</span>Local calendar and reminders</li>'
      + '<li><span aria-hidden="true">' + (state.includeWorkspace ? '&#10003;' : '&#8212;') + '</span>' + escapeHtml(workspaceText) + '</li>'
      + '</ul></section>';
  }

  function renderArchiveReview() {
    var protection = '<section class="data-lifecycle-review-card"><h2>Protection</h2>'
      + '<div class="data-lifecycle-choice-row" role="radiogroup" aria-label="Archive protection">'
      + button('encrypted', 'Encrypted', state.encrypted ? 'primary' : 'secondary', { ariaPressed: state.encrypted })
      + button('plain', 'Plain files', !state.encrypted ? 'primary' : 'secondary', { ariaPressed: !state.encrypted })
      + '</div>'
      + (state.encrypted
        ? '<div class="data-lifecycle-fields">'
          + textField({ id: 'archivePassphrase', type: 'password', label: 'Passphrase', maxLength: 1024, hint: '12–1024 characters; entered exactly as typed.' })
          + textField({ id: 'archivePassphraseConfirmation', type: 'password', label: 'Confirm passphrase', maxLength: 1024 })
          + '</div>'
        : '<p class="data-lifecycle-warning"><span aria-hidden="true">!</span> Plain archives can be read by anyone who can open the folder.</p>')
      + '</section>';
    var destination = '<section class="data-lifecycle-review-card"><h2>Destination</h2><div class="data-lifecycle-destination">'
      + '<span>' + escapeHtml(state.destinationRoot) + '</span>'
      + button('change-destination', 'Change', 'secondary', { size: 'sm' })
      + '</div></section>';
    var workspace = state.overview.workspaceAvailable
      ? '<section class="data-lifecycle-review-card">'
        + toggle.toggleSwitch({ id: 'include-workspace', label: 'Include current workspace data', description: 'Artifacts, backups, tool results, and compatible .jenny metadata.', checked: state.includeWorkspace })
        + toggle.toggleSwitch({ id: 'remove-workspace-after-archive', label: 'Remove archived .jenny workspace data after verification', description: 'Off by default. Ordinary workspace files always remain.', checked: state.removeWorkspaceData })
        + (state.workspaceReview
          ? '<p class="data-lifecycle-warning">Approved ' + escapeHtml(state.workspaceReview.workspace.name + ' (' + state.workspaceReview.workspace.id + ')')
            + ': ' + escapeHtml(utils.formatCount(state.workspaceReview.itemCount, 'item', 'items')) + ', '
            + escapeHtml(utils.formatBytes(state.workspaceReview.totalBytes)) + ', scope: ' + escapeHtml(state.workspaceReview.scope) + '.</p>'
          : (state.includeWorkspace ? '<p class="data-lifecycle-warning">Workspace data must be reviewed before removal can begin.</p>' : ''))
        + '</section>'
      : '';
    host.innerHTML = shell(categoriesMarkup() + destination + protection + workspace,
      button('back', 'Back', 'secondary') + button('archive-remove', state.includeWorkspace && !state.workspaceReview ? 'Review workspace scope' : 'Create archive & remove', 'primary', { size: 'lg' }),
      { title: 'Review your recoverable archive', subtitle: 'Jenny will verify every item before authorizing removal.' });
    toggle.initToggleHandlers(host);
  }

  function renderPermanentReview() {
    var workspace = state.overview.workspaceAvailable
      ? '<div class="data-lifecycle-review-card">'
        + toggle.toggleSwitch({ id: 'remove-workspace', label: 'Also remove this workspace’s .jenny data', description: 'Ordinary workspace files remain untouched.', checked: state.removeWorkspaceData })
        + '</div>'
      : '';
    var content = '<section class="data-lifecycle-review-card data-lifecycle-review-card--danger"><h2>Selected ownership boundaries</h2>'
      + '<ul class="data-lifecycle-check-list"><li><span aria-hidden="true">!</span>Jenny profile, chats, attachments, preferences, and memory</li>'
      + '<li><span aria-hidden="true">&#8212;</span>Ollama models, shared caches, and external knowledge stay</li>'
      + '<li><span aria-hidden="true">&#8212;</span>Ordinary project files stay</li></ul></section>'
      + workspace
      + '<section class="data-lifecycle-review-card">'
      + textField({ id: 'permanentConfirmation', label: 'Type REMOVE JENNY to continue', maxLength: 64, placeholder: 'REMOVE JENNY' })
      + '</section>';
    host.innerHTML = shell(content,
      button('back', 'Back', 'secondary') + button('permanent-remove', 'Permanently remove Jenny data', 'danger', { size: 'lg' }),
      { title: 'Review permanent removal', subtitle: 'This cannot be undone. No shared model or ordinary project file is selected.' });
    toggle.initToggleHandlers(host);
  }

  function renderProgress() {
    var progress = state.progress || { percent: 0, completedBytes: 0, totalBytes: 0, label: 'Preparing…' };
    var display = progress.totalBytes > 0
      ? utils.formatBytes(progress.completedBytes) + ' of ' + utils.formatBytes(progress.totalBytes)
      : '';
    var content = '<section class="data-lifecycle-progress" aria-live="polite">'
      + '<span class="data-lifecycle-progress-glyph" aria-hidden="true">&#9676;</span>'
      + '<h2>' + escapeHtml(progress.label || 'Working…') + '</h2>'
      + '<p>Your data remains in place until Jenny reaches the verified handoff.</p>'
      + progressBar({ value: progress.percent, max: 100, label: progress.label || 'Removal progress', displayText: display })
      + '</section>';
    var footer = state.commitStarted
      ? button('noop', 'Finishing safely…', 'secondary', { disabled: true })
      : state.cancelRequested
      ? button('noop', 'Cancel requested…', 'secondary', { disabled: true })
      : button('cancel-operation', 'Cancel', 'secondary');
    host.innerHTML = shell(content, footer, { title: 'Preparing your Jenny data', subtitle: 'Keep this window open until the receipt appears.' });
  }

  function renderError() {
    var incomplete = state.errorReason === 'incomplete_cleanup';
    var reason = state.errorReason === 'operation_cancelled'
      ? 'The operation was canceled. No Jenny data was removed.'
      : incomplete
        ? 'Some selected items could not be removed. The receipt below lists the bounded cleanup results.'
        : 'Jenny could not complete that operation. Your live data was not removed.';
    var actions = incomplete
      ? button('cancel', 'Close receipt', 'secondary')
      : state.removalMode === 'archive_and_remove'
      ? button('retry-archive', 'Retry', 'primary') + button('change-destination', 'Change destination', 'secondary') + button('app-only', 'Remove app only', 'ghost')
      : button('back', 'Return to choices', 'secondary');
    var cleanup = state.cleanupResults.length
      ? '<ul class="data-lifecycle-check-list">' + state.cleanupResults.map(function (item) {
          var label = item.kind + (item.name ? ' (' + item.name + ')' : '');
          return '<li><span aria-hidden="true">' + (item.status === 'removed' ? '&#10003;' : '!') + '</span>'
            + escapeHtml(label + ': ' + item.status + (item.reason ? ' (' + item.reason + ')' : '')) + '</li>';
        }).join('') + '</ul>'
      : '';
    host.innerHTML = shell('<section class="data-lifecycle-result data-lifecycle-result--error"><span aria-hidden="true">!</span><h2>Removal stopped safely</h2><p>'
      + escapeHtml(reason) + '</p>' + cleanup + '<code>' + escapeHtml(state.errorReason || 'operation_failed') + '</code></section>', actions,
    { title: incomplete ? 'Cleanup is incomplete' : 'Nothing was deleted', subtitle: incomplete ? 'Jenny will not report this removal as complete.' : 'Resolve the issue or choose app-only removal.' });
  }

  function renderReceipt() {
    var archived = state.removalMode === 'archive_and_remove';
    var permanent = state.removalMode === 'permanent';
    var content = '<section class="data-lifecycle-result data-lifecycle-result--success"><span aria-hidden="true">&#10003;</span><h2>Ready to remove Jenny</h2>'
      + '<p>' + (archived ? 'Your archive was created and verified.' : permanent ? 'Permanent cleanup was authorized.' : 'Your Jenny data will remain available for a future reinstall.') + '</p>'
      + (state.archivePath ? '<dl><dt>Archive</dt><dd>' + escapeHtml(state.archivePath) + '</dd></dl>' : '')
      + '<ul class="data-lifecycle-check-list"><li><span aria-hidden="true">&#10003;</span>Application removal may continue</li>'
      + '<li><span aria-hidden="true">&#8212;</span>Shared models and ordinary project files retained</li>'
      + state.cleanupResults.map(function (item) {
        var label = item.kind + (item.name ? ' (' + item.name + ')' : '');
        return '<li><span aria-hidden="true">' + (item.status === 'removed' ? '&#10003;' : '&#8212;') + '</span>'
          + escapeHtml(label + ': ' + item.status + (item.reason ? ' (' + item.reason + ')' : '')) + '</li>';
      }).join('')
      + state.warnings.map(function (warning) {
        return '<li><span aria-hidden="true">!</span>' + escapeHtml(warning) + '</li>';
      }).join('') + '</ul></section>';
    host.innerHTML = shell(content, button('finish', 'Finish removal', permanent ? 'danger' : 'primary', { size: 'lg' }),
      { title: 'Removal receipt', subtitle: 'Review the outcome before closing Jenny.' });
  }

  function render() {
    if (state.view === 'landing') renderLanding();
    else if (state.view === 'archive') renderArchiveReview();
    else if (state.view === 'permanent') renderPermanentReview();
    else if (state.view === 'progress') renderProgress();
    else if (state.view === 'error') renderError();
    else if (state.view === 'receipt') renderReceipt();
    else host.innerHTML = shell('<div class="data-lifecycle-loading" role="status">Loading your Jenny data…</div>', '');
    if (state.view !== focusedView) {
      focusedView = state.view;
      var title = host.querySelector('#dataLifecycleTitle');
      if (title) title.focus();
    }
  }

  function archiveOptions(workspaceReviewId) {
    var passphrase = host.querySelector('#archivePassphrase');
    var confirmation = host.querySelector('#archivePassphraseConfirmation');
    return {
      encrypted: state.encrypted,
      passphrase: passphrase ? passphrase.value : '',
      passphraseConfirmation: confirmation ? confirmation.value : '',
      destinationRoot: state.destinationRoot,
      includeWorkspace: state.includeWorkspace,
      workspaceReviewId: String(workspaceReviewId || ''),
    };
  }

  async function chooseDestination() {
    var result = await api.chooseArchiveDestination();
    if (result && result.ok && result.destinationRoot) {
      state.destinationRoot = result.destinationRoot;
      if (state.view === 'error') state.view = 'archive';
      render();
    }
  }

  async function prepareRemoval(payload) {
    state.view = 'progress';
    state.progress = null;
    state.operationId = '';
    state.cancelRequested = false;
    state.commitStarted = false;
    render();
    var result = await api.prepareRemoval(payload);
    if (result && result.ok) {
      state.removalMode = result.removalMode;
      state.archivePath = result.archivePath || '';
      state.cleanupResults = Array.isArray(result.cleanupResults) ? result.cleanupResults : [];
      state.warnings = Array.isArray(result.warnings) ? result.warnings : [];
      state.view = 'receipt';
    } else {
      state.errorReason = String(result && result.error && result.error.reason || 'operation_failed');
      state.cleanupResults = Array.isArray(result && result.cleanupResults) ? result.cleanupResults : [];
      state.warnings = Array.isArray(result && result.warnings) ? result.warnings : [];
      state.view = 'error';
    }
    render();
  }

  host.addEventListener('inv-toggle-change', function (event) {
    if (event.detail.id === 'include-workspace') {
      state.includeWorkspace = event.detail.checked;
      state.workspaceReview = null;
      if (!state.includeWorkspace && state.removeWorkspaceData) {
        state.removeWorkspaceData = false;
        render();
      }
    }
    if (event.detail.id === 'remove-workspace-after-archive') state.removeWorkspaceData = event.detail.checked;
    if (event.detail.id === 'remove-workspace') state.removeWorkspaceData = event.detail.checked;
  });

  host.addEventListener('click', async function (event) {
    var target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    var action = target.dataset.action;
    if (action === 'cancel') root.close();
    else if (action === 'back') { workspaceReviewGate.bump(); state.view = 'landing'; render(); }
    else if (action === 'review-archive') { workspaceReviewGate.bump(); state.removeWorkspaceData = false; state.view = 'archive'; render(); }
    else if (action === 'review-permanent') { state.removeWorkspaceData = false; state.view = 'permanent'; render(); }
    else if (action === 'encrypted' || action === 'plain') {
      state.encrypted = action === 'encrypted';
      render();
      var selectedProtection = host.querySelector('[data-action="' + action + '"]');
      if (selectedProtection) selectedProtection.focus();
    }
    else if (action === 'change-destination') await chooseDestination();
    else if (action === 'retry-archive') {
      state.view = 'archive';
      render();
    } else if (action === 'archive-remove') {
      if (state.includeWorkspace && !state.workspaceReview) {
        if (workspaceReviewPending) return;
        workspaceReviewPending = true;
        var reviewToken = workspaceReviewGate.capture();
        try {
          var preview = await api.previewWorkspaceArchive();
          if (!workspaceReviewGate.isCurrent(reviewToken) || state.view !== 'archive') return;
          if (!preview || !preview.ok) throw new Error(String(preview && preview.error && preview.error.reason || 'workspace_review_failed'));
          state.workspaceReview = preview;
          render();
          return;
        } catch (error) {
          if (!workspaceReviewGate.isCurrent(reviewToken) || state.view !== 'archive') return;
          state.errorReason = String(error && error.message || 'workspace_review_failed').slice(0, 80);
          state.view = 'error';
          render();
          return;
        } finally {
          workspaceReviewPending = false;
        }
      }
      state.removalMode = 'archive_and_remove';
      var workspaceReviewId = state.workspaceReview ? state.workspaceReview.reviewId : '';
      var archive = archiveOptions(workspaceReviewId);
      state.workspaceReview = null;
      await prepareRemoval({ choice: 'archive_and_remove', archive: archive, removeWorkspaceData: state.removeWorkspaceData });
    } else if (action === 'app-only') {
      state.removalMode = 'app_only';
      await prepareRemoval({ choice: 'app_only' });
    } else if (action === 'permanent-remove') {
      var field = host.querySelector('#permanentConfirmation');
      state.removalMode = 'permanent';
      await prepareRemoval({ choice: 'permanent', confirmation: field ? field.value : '', removeWorkspaceData: state.removeWorkspaceData });
    } else if (action === 'cancel-operation' && state.operationId) {
      state.cancelRequested = true;
      render();
      await api.cancel(state.operationId);
    } else if (action === 'finish') {
      target.disabled = true;
      var completion = await api.complete(state.removalMode);
      if (!completion || !completion.ok) {
        state.warnings = state.warnings.concat(['Removal handoff did not complete. Review the receipt and try Finish removal again.']).slice(-20);
        state.view = 'receipt';
        render();
      }
    }
  });

  root.document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (state.view === 'archive' || state.view === 'permanent') {
      event.preventDefault();
      state.view = 'landing';
      render();
    } else if (state.view === 'error') {
      event.preventDefault();
      if (state.errorReason === 'incomplete_cleanup') root.close();
      else {
        state.view = 'landing';
        render();
      }
    } else if (state.view === 'landing') {
      root.close();
    } else if (state.view === 'progress' && state.operationId && !state.cancelRequested && !state.commitStarted) {
      event.preventDefault();
      state.cancelRequested = true;
      render();
      void api.cancel(state.operationId);
    }
  });

  api.onProgress(function (progress) {
    state.progress = progress;
    state.operationId = String(progress && progress.operationId || '');
    if (progress && ['verifying', 'handoff', 'complete'].includes(progress.phase)) state.commitStarted = true;
    if (state.view === 'progress') render();
  });

  render();
  api.getOverview().then(function (result) {
    if (!result || !result.ok) {
      state.errorReason = 'overview_unavailable';
      state.view = 'error';
      render();
      return;
    }
    state.overview = utils.normalizeOverview(result);
    state.destinationRoot = state.overview.defaultArchiveRoot;
    state.includeWorkspace = false;
    var appearanceUtils = root.appearanceUtils;
    if (appearanceUtils && typeof appearanceUtils.applyAppearanceToDocument === 'function') {
      appearanceUtils.applyAppearanceToDocument(root.document, state.overview.appearance);
    }
    state.view = 'landing';
    render();
  }).catch(function () {
    state.errorReason = 'overview_unavailable';
    state.view = 'error';
    render();
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
