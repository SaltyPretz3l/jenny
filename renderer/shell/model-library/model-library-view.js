/* Pure HTML-string builders for the shared Model Library card surface. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../renderer-model-library-format-utils'),
      require('../../inventory/badge'),
      require('../../inventory/chip'),
      require('../../inventory/progress-bar'),
      require('../../inventory/action-button'),
      require('./model-library-merge')
    );
    return;
  }
  root.modelLibraryView = factory(
    root.rendererModelLibraryFormatUtils,
    root.inventoryBadge,
    root.inventoryChip,
    root.inventoryProgressBar,
    root.inventoryActionButton,
    root.modelLibraryMerge
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  formatUtils,
  inventoryBadge,
  inventoryChip,
  inventoryProgressBar,
  inventoryActionButton,
  mergeUtils
) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  if (!formatUtils || typeof formatUtils.formatHumanSize !== 'function'
    || typeof inventoryBadge !== 'function'
    || typeof inventoryChip !== 'function'
    || typeof inventoryProgressBar !== 'function'
    || typeof inventoryActionButton !== 'function'
    || !mergeUtils || typeof mergeUtils.fitTone !== 'function'
    || typeof mergeUtils.filterModelCards !== 'function'
    || typeof mergeUtils.isLocalEngine !== 'function'
    || typeof mergeUtils.isLocalOrUnknownEngine !== 'function') {
    throw new Error('model-library-view: missing required dependencies');
  }

  var ALLOWED_ACTIONS = {
    use: true,
    unload: true,
    tune: true,
    remove: true,
    pull: true,
    cancel: true,
    menu: true,
    retry: true,
    loadSmaller: true,
    showFits: true,
    diagnostics: true,
    copyDetails: true,
  };
  // Row 38 item 1 (B): the recovery that matches a classified load failure.
  var RECOVERY_ACTIONS = { retry: true, loadSmaller: true, showFits: true, diagnostics: true, copyDetails: true };

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../../shared/string-utils') : null)).escapeHtml;
  var loadFailureUtils = (typeof globalThis !== 'undefined' && globalThis.jennyModelLoadFailure)
    || (typeof require === 'function' ? require('../../shared/model-load-failure') : null);

  function cardLoadFailure(card) {
    return card && card.loadFailure && typeof card.loadFailure === 'object' ? card.loadFailure : null;
  }

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function positiveNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function formatContext(tokens) {
    var number = positiveNumber(tokens);
    if (!number) return '';
    if (number < 1024) return String(Math.round(number));
    var value = Math.round((number / 1024) * 10) / 10;
    return String(value).replace(/\.0$/, '') + 'K';
  }

  function formatMbAsDownload(megabytes) {
    var number = positiveNumber(megabytes);
    if (!number) return '';
    var bytes = number * 1024 * 1024;
    var formatted = formatUtils.formatHumanSize(bytes);
    return formatted ? '~' + formatted + ' download' : '';
  }

  function fitText(card, label, full) {
    if (card.fitSource === 'estimated') {
      return full
        ? jt('models.library.estimatedFitDescription', '{label} \u00b7 estimated', { label: label })
        : jt('models.library.estimatedFitCompact', '~{label}', { label: label });
    }
    return card.fitSource === 'observed'
      ? jt('models.library.measuredFitDescription', '{label} · measured', { label: label })
      : label;
  }

  function formatQuant(value) {
    var quant = String(value || '').trim();
    return quant.toLowerCase() === 'unknown' ? '' : quant;
  }

  function formatDisk(card) {
    var sizeBytes = positiveNumber(card.sizeBytes);
    if (card.installed === true) {
      return sizeBytes ? formatUtils.formatHumanSize(sizeBytes) : jt('models.library.sizeUnknown', 'Size unknown');
    }
    return formatMbAsDownload(card.downloadSizeMb) || jt('models.library.diskSizeUnknown', 'Disk size unknown');
  }

  function actionSet(actions) {
    var set = new Set();
    (Array.isArray(actions) ? actions : []).forEach(function (action) {
      if (ALLOWED_ACTIONS[action]) set.add(action);
    });
    return set;
  }

  function actionApplicable(action, card, pull, compact) {
    var running = pull.status === 'running';
    var failure = cardLoadFailure(card);
    if (RECOVERY_ACTIONS[action]) {
      return compact !== true && Boolean(failure) && card.installed === true && card.engineVisible === true
        && (loadFailureUtils ? loadFailureUtils.recoveryActions(failure) : ['retry']).indexOf(action) >= 0;
    }
    if (action === 'use') {
      // Retry (or the cause's own fix) replaces Use on a model that did not load;
      // the compact card has no recovery row, so Use stays as its retry there.
      return card.installed === true && card.engineVisible === true && card.active !== true
        && (!failure || compact === true);
    }
    if (action === 'unload') {
      return compact !== true && card.installed === true
        && card.engineVisible === true && card.active === true;
    }
    if (action === 'tune') {
      return compact !== true && card.installed === true && card.engineVisible === true
        && mergeUtils.isLocalOrUnknownEngine(card);
    }
    if (action === 'remove') {
      return compact !== true && card.installed === true
        && card.engineVisible === true && card.active !== true
        && String(card.engineType || '').toLowerCase() === 'ollama';
    }
    // An NInfer row's Download is the block's set-up: hidden while it runs (one owner per message).
    if (action === 'pull') return card.installed !== true && !running && card.ninferSetupRunning !== true;
    if (action === 'menu') {
      return compact !== true && card.installed === true && card.engineVisible === true
        && mergeUtils.isLocalOrUnknownEngine(card);
    }
    return action === 'cancel' && running;
  }

  function actionOptions(action, card, activation) {
    var state = objectOrEmpty(activation);
    var pending = state.status === 'running' && state.key === card.key;
    var disabled = state.status === 'running'
      && (action === 'use' || action === 'unload'
        || (pending && (action === 'tune' || action === 'remove' || action === 'menu')));
    var name = String(card.displayName || card.tag || 'model');
    var config = {
      use: { label: jt('models.library.use', 'Use'), variant: 'primary' },
      unload: { label: jt('models.library.unload', 'Unload'), variant: 'secondary' },
      tune: { label: jt('models.library.tune', 'Tune'), variant: 'secondary' },
      remove: { label: jt('common.remove', 'Remove'), variant: 'danger' },
      pull: { label: card.selectedEngine === 'ninfer' ? jt('models.library.download', 'Download') : jt('models.library.pull', 'Pull'), variant: 'primary' },
      cancel: { label: jt('common.cancel', 'Cancel'), variant: 'danger' },
      menu: { label: '⋯', variant: 'ghost', ariaLabel: jt('models.library.moreActionsFor', 'More actions for {model}', { model: name }) },
      retry: { label: jt('models.library.retry', 'Retry'), variant: 'primary' },
      loadSmaller: {
        label: jt('models.library.loadAtContext', 'Load at {context} context', {
          context: formatContext(loadFailureUtils ? loadFailureUtils.retryContext(cardLoadFailure(card)) : 8192),
        }),
        variant: 'primary',
      },
      showFits: { label: jt('models.library.showModelsThatFit', 'Show models that fit'), variant: 'secondary' },
      diagnostics: { label: jt('models.library.openDiagnostics', 'Open Diagnostics'), variant: 'secondary' },
      copyDetails: { label: jt('models.library.copyDetails', 'Copy details'), variant: 'ghost' },
    }[action];
    var pendingUse = pending && action === 'use';
    return {
      id: action,
      label: pendingUse ? jt('models.library.starting', 'Starting…') : config.label,
      variant: config.variant,
      size: 'sm',
      disabled: disabled,
      ariaLabel: config.ariaLabel || (pendingUse ? 'Starting' : config.label) + ' ' + name,
      className: 'model-card-action model-card-action--' + action
        + (pendingUse ? ' model-card-action--pending' : ''),
      dataset: {
        'model-card-action': action,
        'model-tag': String(card.tag || ''),
      },
    };
  }

  function renderAction(action, card, pull, compact, activation) {
    if (!actionApplicable(action, card, pull, compact)) return '';
    return inventoryActionButton(actionOptions(action, card, activation));
  }

  function renderActions(card, actions, pull, activation) {
    var allowed = actionSet(actions);
    var html = ['use', 'unload', 'tune', 'remove', 'pull'].map(function (action) {
      return allowed.has(action) ? renderAction(action, card, pull, true, activation) : '';
    }).join('');
    return html ? '<div class="model-card-actions">' + html + '</div>' : '';
  }

  // Pills derived from the per-model engine projection (merge engineFields),
  // shared by compact cards and rows. `mtp.enabled` already implies llama-server
  // selected + eligible, so it alone decides whether "MTP ready" is redundant.
  function engineBadges(model) {
    var badges = [];
    var mtpOn = Boolean(model.mtp && model.mtp.enabled === true);
    if (model.serving === true) {
      badges.push(inventoryBadge({
        tone: 'success',
        size: 'sm',
        text: 'Serving' + (model.servingPort > 0 ? ' on :' + model.servingPort : ''),
      }));
    } else if (model.servingPaused === true) {
      // llama-server is parked while an image render holds the GPU.
      badges.push(inventoryBadge({ tone: 'muted', size: 'sm', text: jt('models.library.pausedForImageRender', 'Paused for an image render') }));
    }
    if (model.selectedEngine === 'ninfer') {
      // The managed NInfer runtime (row 54); MTP is the artifact's own feature.
      badges.push(inventoryBadge({ tone: 'muted', size: 'sm', text: 'NInfer' + (mtpOn ? ' \u00b7 MTP' : '') }));
    }
    if (model.selectedEngine === 'strata') badges.push(inventoryBadge({ tone: 'muted', size: 'sm', text: 'Strata' })); // the owner's own Strata install (row 200)
    if (model.selectedEngine === 'llama-server') {
      // A model on its own llama-server build names it; the bundled build is implied.
      badges.push(inventoryBadge({
        tone: 'muted',
        size: 'sm',
        text: 'llama-server' + (mtpOn ? ' \u00b7 MTP' : '')
          + (model.customBuild > 0 ? jt('models.library.buildSuffix', ' \u00b7 build {build}', { build: model.customBuild }) : ''),
      }));
    }
    if (model.accelerationEligible === true && model.mtpRunnable !== false && !mtpOn) {
      badges.push(inventoryBadge({ tone: 'muted', size: 'sm', text: jt('models.library.mtpReady', 'MTP ready') }));
    }
    return badges;
  }

  function renderBadges(card) {
    var badges = [];
    if (card.active === true) {
      badges.push(inventoryBadge({ tone: 'default', size: 'sm', text: 'Active' }));
    }
    if (card.installed === true) {
      badges.push(inventoryBadge({ tone: 'success', size: 'sm', text: 'Installed' }));
    }
    if (card.recommended === true) {
      badges.push(inventoryBadge({
        tone: 'default',
        size: 'sm',
        text: card.fitState === 'fits' ? jt('models.library.bestFitForGpu', 'Best fit for your GPU') : jt('models.library.recommended', 'Recommended'),
      }));
    }
    badges.push.apply(badges, engineBadges(card));
    if (card.ollamaOnly === true) {
      badges.push(inventoryBadge({ tone: 'muted', size: 'sm', text: jt('models.library.ollamaOnly', 'Ollama only') }));
      badges.push('<span class="model-card-engine-note">' + escapeHtml(jt('models.library.currentEngineUnavailable', 'Not available to the current engine')) + '</span>');
    }
    return badges.length ? '<div class="model-card-badges">' + badges.join('') + '</div>' : '';
  }

  function renderFitBar(card) {
    var unknown = card.fitState === 'unknown';
    var budgetMb = positiveNumber(card.budgetMb);
    var proportional = budgetMb > 0 && !unknown;
    var name = String(card.displayName || card.tag || 'model');
    var estimated = card.fitSource === 'estimated';
    var fitLabel = unknown
      ? String(card.fitLabel || jt('models.library.fitUnknown', 'Fit unknown'))
      : String(card.fitLabel || '');
    var full = fitText(card, fitLabel, true);
    return inventoryProgressBar({
      value: proportional ? positiveNumber(card.vramRequiredMb) : 0,
      max: proportional ? budgetMb : 1,
      // Thresholds above 1 suppress primitive tone; fitState owns the bar tone.
      warningThreshold: 2,
      dangerThreshold: 2,
      displayText: fitText(card, fitLabel, false),
      label: estimated
        ? jt('models.library.estimatedVramFitFor', 'VRAM fit for {model}: {fit}', { model: name, fit: full })
        : jt('models.library.vramFitFor', 'VRAM fit for {model}', { model: name }),
      className: 'model-card-fit model-card-fit--' + mergeUtils.fitTone(card)
        + (estimated ? ' model-card-fit--estimated' : ''),
      title: estimated ? full : '',
    });
  }

  function renderPullState(card, pull, actions) {
    var running = pull.status === 'running';
    var pieces = [];
    if (running) {
      var percent = Math.min(Math.max(Number(pull.percent) || 0, 0), 100);
      pieces.push(inventoryProgressBar({
        value: percent,
        max: 100,
        label: jt('models.library.pullProgressFor', 'Pull progress for {model}', { model: String(card.displayName || card.tag || 'model') }),
        displayText: pull.bytesText || Math.round(percent) + '%',
        // Thresholds above 1 suppress primitive tone; pull progress is neutral.
        warningThreshold: 2,
        dangerThreshold: 2,
        className: 'model-card-pull-progress',
      }));
      if (actionSet(actions).has('cancel')) {
        pieces.push(renderAction('cancel', card, pull, false));
      }
    }
    if (pull.cancelFailed === true) {
      pieces.push(inventoryBadge({ tone: 'danger', size: 'sm', text: jt('models.library.cancelFailed', 'Cancel failed') }));
    }
    return pieces.length ? '<div class="model-card-pull-state">' + pieces.join('') + '</div>' : '';
  }

  // Plain words for a classified load failure (the engine's own message rides as the title), then an activation error.
  function renderRowNotes(loadFailure, activation, activationMatches) {
    var failureHtml = loadFailure && loadFailureUtils
      ? '<div class="model-card-note model-card-note--failed" title="' + escapeHtml(loadFailure.message || '') + '">'
        + escapeHtml(loadFailureUtils.causeSentence(loadFailure)) + '</div>'
      : '';
    var noteHtml = activation.status === 'idle' && activationMatches
      && String(activation.message || '').trim()
      ? '<div class="model-card-note model-card-note--error">'
        + escapeHtml(activation.message) + '</div>' + String(activation.actionsHtml || '')
      : '';
    // Row 142: "Using build N for this model · starting…" while the switched Use runs.
    var startingHtml = activation.status === 'running' && activationMatches && activation.pendingNote
      ? '<div class="model-card-note">' + escapeHtml(activation.pendingNote) + '</div>' : '';
    return failureHtml + noteHtml + startingHtml;
  }

  function buildModelCard(card, options) {
    var model = objectOrEmpty(card);
    var opts = objectOrEmpty(options);
    var pull = objectOrEmpty(opts.pull);
    var activation = Object.assign(
      { status: 'idle', key: '', message: '' },
      objectOrEmpty(opts.activation)
    );
    var name = String(model.displayName || model.tag || jt('models.library.localModel', 'Local model'));
    var icon = Array.from(name.trim())[0] || '?';
    var stats = [
      model.params ? String(model.params) : '',
      formatQuant(model.quant),
      formatContext(model.contextLength) ? formatContext(model.contextLength) + ' context' : '',
      formatDisk(model),
    ].filter(Boolean);
    var tierHtml = '';
    var reasonHtml = model.reason
      ? '<div class="model-card-reason">' + escapeHtml(model.reason) + '</div>'
      : '';
    var activationMatches = activation.key === model.key;
    var pending = activation.status === 'running' && activationMatches;

    return ''
      + '<div class="model-card" data-model-key="' + escapeHtml(model.key || '') + '" data-active="'
      + (model.active === true ? 'true' : 'false') + '" data-pending="'
      + (pending ? 'true' : 'false') + '">'
      + '<div class="model-card-header">'
      + '<span class="model-card-icon" aria-hidden="true">' + escapeHtml(icon) + '</span>'
      + '<div class="model-card-heading">'
      + '<div class="model-card-name">' + escapeHtml(name) + '</div>'
      + tierHtml
      + '</div>'
      + '</div>'
      + renderBadges(model)
      + '<div class="model-card-stats">' + escapeHtml(stats.join(' · ')) + '</div>'
      + renderFitBar(model)
      + reasonHtml
      + renderPullState(model, pull, opts.actions)
      + renderRowNotes(null, activation, activationMatches)
      + renderActions(model, opts.actions, pull, activation)
      + '</div>';
  }

  function formatGb(megabytes) {
    var number = positiveNumber(megabytes);
    return number ? (Math.round((number / 1024) * 10) / 10) + ' GB' : '';
  }

  // options.pending: the probe has not run yet (no read, or a read taken
  // before the managed sidecar was ready). That is no verdict, so the line
  // reads neutral instead of a bare "not detected".
  function buildHardwareSummaryLine(hardware, options) {
    var profile = objectOrEmpty(hardware);
    if (profile.detected !== true && objectOrEmpty(options).pending === true) {
      return '<div class="model-library-hardware-summary" data-hardware-pending="true">'
        + escapeHtml(jt('models.library.hardwareChecking', 'Checking hardware…')) + '</div>';
    }
    if (profile.detected !== true) {
      return '<div class="model-library-hardware-summary">' + escapeHtml(jt('models.library.hardwareNotDetected', 'Hardware not detected')) + '</div>';
    }
    var parts = [];
    var unified = profile.type === 'metal' || profile.memoryArchitecture === 'unified';
    if (unified) {
      parts.push(String(profile.name || jt('models.library.appleSiliconGpu', 'Apple Silicon GPU')));
      if (positiveNumber(profile.unifiedMemoryMb)) {
        parts.push(jt('models.library.unifiedMemory', '{memory} unified memory', { memory: formatGb(profile.unifiedMemoryMb) }));
      }
    } else if (profile.type === 'cpu' || !positiveNumber(profile.vramMb)) {
      parts.push(jt('models.library.cpuInference', 'CPU inference'));
    } else {
      parts.push(String(profile.name || 'GPU'));
      parts.push(formatGb(profile.vramMb) + ' VRAM');
    }
    if (positiveNumber(profile.ramAvailableMb)) {
      parts.push(jt('models.library.ramAvailable', '{memory} RAM available', { memory: formatGb(profile.ramAvailableMb) }));
    } else if (positiveNumber(profile.ramTotalMb)) {
      parts.push(formatGb(profile.ramTotalMb) + ' RAM');
    }
    return '<div class="model-library-hardware-summary">' + escapeHtml(parts.join(' · ')) + '</div>';
  }

  function buildFilterChips(filter, counts) {
    var active = ['all', 'installed', 'recommended'].includes(filter) ? filter : 'all';
    var totals = objectOrEmpty(counts);
    var allOptions = { id: 'all', label: jt('models.library.all', 'All'), pressed: active === 'all' };
    var installedOptions = { id: 'installed', label: jt('models.library.installed', 'Installed'), pressed: active === 'installed' };
    var recommendedOptions = {
      id: 'recommended',
      label: jt('models.library.recommended', 'Recommended'),
      pressed: active === 'recommended',
    };
    if (Number.isInteger(totals.all) && totals.all >= 0) allOptions.count = totals.all;
    if (Number.isInteger(totals.installed) && totals.installed >= 0) {
      installedOptions.count = totals.installed;
    }
    if (Number.isInteger(totals.recommended) && totals.recommended >= 0) {
      recommendedOptions.count = totals.recommended;
    }
    return '<div class="model-library-filter-chips" role="group" aria-label="' + escapeHtml(jt('models.library.filterModels', 'Filter models')) + '">'
      + inventoryChip(allOptions)
      + inventoryChip(installedOptions)
      + inventoryChip(recommendedOptions)
      + '</div>';
  }

  function pullForCard(pulls, key) {
    var source = objectOrEmpty(pulls);
    return Object.prototype.hasOwnProperty.call(source, key) ? objectOrEmpty(source[key]) : {};
  }

  function buildModelGrid(mergedViewModel, options) {
    var merged = objectOrEmpty(mergedViewModel);
    var opts = objectOrEmpty(options);
    var cards = Array.isArray(merged.cards) ? merged.cards : [];
    var filter = ['all', 'installed', 'recommended'].includes(opts.filter) ? opts.filter : 'all';
    var filtered = mergeUtils.filterModelCards(cards, filter);
    var hardware = objectOrEmpty(merged.hardware);
    var cardHtml = filtered.map(function (card) {
      var model = Object.assign({}, card, { budgetMb: positiveNumber(hardware.budgetMb) });
      return buildModelCard(model, {
        actions: opts.actions,
        pull: pullForCard(opts.pulls, model.key),
        activation: opts.activation,
      });
    }).join('');
    var counts = {
      installed: cards.filter(function (card) { return card && card.installed === true; }).length,
    };
    return ''
      + '<div class="model-library-view">'
      + buildHardwareSummaryLine(hardware)
      + buildFilterChips(filter, counts)
      + '<div class="model-card-grid">'
      + (cardHtml || '<div class="model-library-empty">' + escapeHtml(jt('models.library.noFilterMatches', 'No models match this filter.')) + '</div>')
      + '</div>'
      + '</div>';
  }

  // ---- Settings > Models > Library: scope, one search, sort and keyed rows ----
  var ENGINE_NAMES = { ollama: 'Ollama', 'llama-server': 'llama-server', ninfer: 'NInfer', strata: 'Strata' };
  var LIBRARY_SCOPES = ['all', 'mine', 'get'];

  function isHostedCard(card) { return card.installed === true && Boolean(card.engineType) && !mergeUtils.isLocalEngine(card); }

  // A model on its own llama-server build names it; the bundled build is implied.
  function libraryEngineName(card) {
    if (isHostedCard(card)) return String(card.engineType);
    return (ENGINE_NAMES[card.selectedEngine] || ENGINE_NAMES.ollama)
      + (card.selectedEngine === 'llama-server' && card.customBuild > 0
        ? jt('models.library.buildSuffix', ' · build {build}', { build: card.customBuild }) : '');
  }

  function libraryName(card) { return String(card.displayName || card.tag || ''); }

  // A pasted Ollama tag or Hugging Face address: a : or /, no whitespace, over three characters.
  function libraryTagQuery(query) {
    var text = String(query == null ? '' : query).trim();
    return text.length > 3 && /[:/]/.test(text) && !/\s/.test(text) ? text : '';
  }

  function compareByName(a, b) {
    var left = libraryName(a).toLowerCase();
    var right = libraryName(b).toLowerCase();
    if (left !== right) return left < right ? -1 : 1;
    return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
  }

  function compareBySize(a, b) {
    var left = positiveNumber(a.vramRequiredMb);
    var right = positiveNumber(b.vramRequiredMb);
    if (!left !== !right) return left ? -1 : 1;
    return left - right || compareByName(a, b);
  }

  // What the Library lists for a query, scope and sort. The running model is never listed (Running now shows it), nor is a cloud model.
  function libraryRowsModel(merged, options) {
    var opts = objectOrEmpty(options);
    var cards = (Array.isArray(objectOrEmpty(merged).cards) ? merged.cards : []).filter(function (card) { return card && typeof card === 'object' && !Array.isArray(card); });
    var scope = LIBRARY_SCOPES.indexOf(opts.scope) >= 0 ? opts.scope : 'all';
    var query = String(opts.query == null ? '' : opts.query).trim().toLowerCase();
    var bySize = opts.sort === 'size';
    var matched = cards.filter(function (card) { return card.active !== true && !isHostedCard(card) && (!query || [libraryName(card), card.tag, card.quant, libraryEngineName(card)].join(' ').toLowerCase().indexOf(query) >= 0); });
    var mine = matched.filter(function (card) { return card.installed === true; })
      .sort(bySize ? compareBySize : compareByName);
    var catalog = matched.filter(function (card) { return card.installed !== true; }).sort(bySize ? compareBySize : function (a, b) {
      return (b.recommended === true) - (a.recommended === true) || compareByName(a, b);
    });
    var tag = scope === 'mine' ? '' : libraryTagQuery(opts.query);
    if (tag && cards.some(function (card) { return card.installed === true && [card.tag, card.key].some(function (id) { return String(id || '').toLowerCase() === tag.toLowerCase(); }); })) tag = '';
    var collapsed = scope === 'all' && !query && opts.showAllCatalog !== true;
    // A catalog model that is downloading stays listed so its progress is never hidden.
    var pulling = collapsed ? catalog.filter(function (card) { return pullForCard(opts.pulls, card.key).status === 'running'; }) : [];
    var rest = collapsed ? catalog.filter(function (card) { return pulling.indexOf(card) < 0; }) : catalog;
    var fitting = rest.filter(function (card) { return card.fitState === 'fits'; }).length;
    return {
      scope: scope, query: query, pullRow: tag, mine: mine, catalog: catalog, pulling: pulling, collapsed: collapsed,
      counts: { all: mine.length + catalog.length, mine: mine.length, get: catalog.length },
      collapsedCatalogCount: fitting || rest.length, collapsedFits: fitting > 0,
    };
  }

  function buildScopeChips(scope, counts) {
    var active = LIBRARY_SCOPES.indexOf(scope) >= 0 ? scope : 'all';
    var totals = objectOrEmpty(counts);
    var labels = {
      all: jt('settings.models.library.scope.all', 'All'),
      mine: jt('settings.models.library.scope.mine', 'On this PC'),
      get: jt('settings.models.library.scope.get', 'Can download'),
    };
    return '<div class="model-library-filter-chips" role="group" aria-label="' + escapeHtml(jt('settings.models.library.scopeAria', 'Show')) + '">'
      + LIBRARY_SCOPES.map(function (id) {
        var chip = { id: 'scope-' + id, label: labels[id], pressed: active === id };
        if (Number.isInteger(totals[id]) && totals[id] >= 0) chip.count = totals[id];
        return inventoryChip(chip);
      }).join('') + '</div>';
  }

  function libraryLink(label, action) {
    return inventoryActionButton({ plain: true, className: 'settings-row-link', label: label, dataset: { 'model-library-section-action': action } });
  }
  function libraryFlag(text, title, danger) {
    return '<span class="mrow-flag' + (danger ? ' mrow-flag--danger' : '') + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(text) + '</span>';
  }

  function libraryFlags(model, loadFailure) {
    var flags = [];
    if (model.mtp && model.mtp.enabled === true) {
      flags.push(libraryFlag(jt('settings.models.library.flag.mtp', 'MTP'), jt('settings.models.library.flag.mtpTip', 'Multi-token prediction is on')));
    } else if (model.accelerationEligible === true && model.mtpRunnable !== false) {
      flags.push(libraryFlag(jt('models.library.mtpReady', 'MTP ready'), jt('settings.models.library.flag.mtpReadyTip', 'Can use multi-token prediction on llama-server')));
    }
    if (model.serving === true) flags.push(libraryFlag(jt('settings.models.library.flag.serving', 'Serving on :{port}', { port: model.servingPort }), jt('settings.models.library.flag.servingTip', 'Loaded on llama-server and holding GPU memory')));
    else if (model.servingPaused === true) flags.push(libraryFlag(jt('models.library.pausedForImageRender', 'Paused for an image render')));
    if (model.preferredLocal === true) flags.push(libraryFlag(jt('settings.models.library.flag.default', 'Default'), jt('settings.models.library.flag.defaultTip', 'New chats set to Default use this model')));
    if (loadFailure) flags.push(libraryFlag(jt('models.library.didNotLoad', "Didn't load"), '', true));
    if (model.installed !== true && model.recommended === true && model.fitState === 'fits') flags.push(libraryFlag(jt('models.library.bestFit', 'Best fit')));
    if (model.ollamaOnly === true) {
      flags.push(libraryFlag(jt('models.library.ollamaOnly', 'Ollama only'), jt('models.library.currentEngineUnavailable', 'Not available to the current engine')));
    }
    return flags.join('');
  }

  function libraryMeta(model, hosted) {
    var meta = [libraryEngineName(model)];
    if (model.libraryGguf === true) meta.push(jt('models.library.localGguf', 'Local GGUF'));
    if (model.params) meta.push(String(model.params));
    var quant = formatQuant(model.quant);
    if (quant) meta.push(quant);
    var context = formatContext(model.contextLength);
    if (context) meta.push(jt('settings.models.library.context', '{size} context', { size: context }));
    if (hosted) {
      meta.push(jt('models.library.hosted', 'Hosted'), jt('models.library.noDownload', 'no download'));
    } else if (model.installed === true) {
      meta.push(positiveNumber(model.sizeBytes)
        ? jt('settings.models.library.onDisk', '{size} on disk', { size: formatUtils.formatHumanSize(model.sizeBytes) })
        : jt('models.library.sizeUnknown', 'Size unknown'));
    } else {
      meta.push(formatMbAsDownload(model.downloadSizeMb) || jt('models.library.diskSizeUnknown', 'Disk size unknown'));
    }
    return meta.join(' · ');
  }

  function libraryFitCell(model, budgetMb, hosted) {
    var text = function (words, title, none) {
      return '<div class="mrow-fit"><span class="mrow-fit-num mrow-fit-num--text' + (none ? ' mrow-fit-num--none' : '') + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(words) + '</span></div>';
    };
    var need = positiveNumber(model.vramRequiredMb);
    if (hosted) return text('—', '', true);
    if (model.fitState === 'cpu') return text(jt('settings.models.library.runsOnCpu', 'Runs on CPU'));
    if (model.fitState === 'unknown' || !need) return text('—', jt('settings.models.library.fitUnknownTip', 'Jenny has not measured this file yet'), true);
    var width = budgetMb > 0 ? Math.min(100, Math.max(0, Math.round((need / budgetMb) * 1000) / 10)) : 0;
    var label = String(model.fitLabel || '');
    return '<div class="mrow-fit"' + (label ? ' title="' + escapeHtml(fitText(model, label, true)) + '"' : '') + '>'
      + '<span class="mrow-fit-bar' + (model.fitState === 'over' ? ' mrow-fit-bar--over' : '') + '"><i style="width:' + width + '%"></i></span>'
      + '<span class="mrow-fit-num">' + (model.fitSource === 'estimated' ? '~' : '') + escapeHtml(formatGb(need).replace(' GB', '')) + '<small> GB</small></span></div>';
  }

  // The library's own look on the shared action options: Use quiet (CSS lifts it on the hovered row), Tune ghost, Download secondary.
  function libraryActionOptions(action, card, activation) {
    var options = actionOptions(action, card, activation);
    if (action === 'use' || action === 'retry' || action === 'loadSmaller' || action === 'pull') options.variant = 'secondary';
    if (action === 'tune') options.variant = 'ghost';
    if (action === 'pull') {
      options.label = jt('models.library.download', 'Download');
      options.ariaLabel = jt('models.library.downloadModel', 'Download {model}', { model: libraryName(card) });
    }
    if (action === 'use') {
      options.className += ' mrow-use';
      if (options.className.indexOf('--pending') < 0) {
        options.label = jt('settings.models.library.load', 'Load');
        options.ariaLabel = jt('settings.models.library.loadAria', 'Load {model}', { model: libraryName(card) });
      }
    }
    if (action === 'menu') options.className += ' mrow-menu';
    return options;
  }

  function renderLibraryActions(model, opts, pull, activation) {
    var allowed = actionSet(opts.actions);
    var failure = cardLoadFailure(model);
    var order = (failure && loadFailureUtils ? loadFailureUtils.recoveryActions(failure) : []).concat(['use', 'unload', 'tune', 'pull', 'menu']);
    return '<div class="mrow-actions">' + order.map(function (action) {
      return allowed.has(action) && actionApplicable(action, model, pull, false)
        ? inventoryActionButton(libraryActionOptions(action, model, activation)) : '';
    }).join('') + '</div>';
  }

  // One Library row. options: { actions, pull, activation, budgetMb, share, flag }.
  function buildLibraryRow(card, options) {
    var model = objectOrEmpty(card);
    var opts = objectOrEmpty(options);
    var pull = objectOrEmpty(opts.pull);
    var activation = Object.assign({ status: 'idle', key: '', message: '' }, objectOrEmpty(opts.activation));
    var activationMatches = activation.key === model.key;
    var pending = activation.status === 'running' && activationMatches;
    var loadFailure = pending ? null : cardLoadFailure(model);
    var hosted = isHostedCard(model);
    var key = escapeHtml(model.key || '');
    return '<div class="mrow" data-model-key="' + key + '" data-active="' + (model.active === true ? 'true' : 'false')
      + '" data-pending="' + (pending ? 'true' : 'false') + '" data-load-failed="' + (loadFailure ? 'true' : 'false') + '">'
      + '<div class="mrow-main"><div class="mrow-title"><span class="mrow-name" title="' + escapeHtml(model.tag || '') + '">'
      + escapeHtml(model.displayName || model.tag || jt('models.library.localModel', 'Local model')) + '</span>' + libraryFlags(model, loadFailure) + (opts.flag || '') + '</div>'
      + '<div class="mrow-meta">' + escapeHtml(libraryMeta(model, hosted)) + '</div>'
      + renderPullState(model, pull, opts.actions) + (opts.share || '') // slice 6-7: model sharing's state (model-library-share-rows.js)
      + renderRowNotes(loadFailure, activation, activationMatches)
      + '</div>'
      + libraryFitCell(model, positiveNumber(opts.budgetMb), hosted)
      + renderLibraryActions(model, opts, pull, activation)
      + '</div>';
  }

  function buildLibraryPullRow(text) {
    var address = text.indexOf('/') >= 0;
    return '<div class="mrow mrow--pull" data-item="pull"><div class="mrow-main"><div class="mrow-title"><span class="mrow-name" title="' + escapeHtml(text) + '">'
      + escapeHtml(jt('settings.models.library.pullRow', 'Pull “{tag}”', { tag: text })) + '</span></div>'
      + '<div class="mrow-meta">' + escapeHtml(address
        ? jt('settings.models.library.pullRowAddress', 'A Hugging Face GGUF address, pulled through Ollama. Jenny shows the size before anything downloads.')
        : jt('settings.models.library.pullRowTag', 'An Ollama tag from ollama.com. Jenny shows the size before anything downloads.')) + '</div></div>'
      + '<div class="mrow-fit"><span class="mrow-fit-num mrow-fit-num--text">' + escapeHtml(jt('settings.models.library.sizeCheckedFirst', 'Size checked first')) + '</span></div>'
      + '<div class="mrow-actions">' + inventoryActionButton({
        id: 'pull-tag', label: jt('settings.models.library.pull', 'Pull'), variant: 'primary', size: 'sm',
        dataset: { 'model-library-section-action': 'pull-tag' },
      }) + '</div></div>';
  }

  // Row 201 C1 / OD-1: a team model runs on a teammate's GPU, so it is never an "On this PC" row. It lists in
  // its own read-only group: no Load, Tune, Set as default or menu (a team model is picked in a chat).
  function teamModelName(entry) {
    return String(entry.modelId || '') + ' \u00b7 ' + (String(entry.teamName || '').trim() || jt('settings.team.joined.unnamed', 'Unnamed team'));
  }

  function buildTeamModelRow(entry) {
    var name = teamModelName(entry);
    var context = formatContext(entry.contextLength);
    var meta = [jt('models.library.team.sharedGpu', "A team's shared GPU")];
    if (context) meta.push(jt('settings.models.library.context', '{size} context', { size: context }));
    return '<div class="mrow" data-team-model="' + escapeHtml(entry.id) + '" aria-describedby="mlib-team-note">'
      + '<div class="mrow-main"><div class="mrow-title"><span class="mrow-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span></div>'
      + '<div class="mrow-meta">' + escapeHtml(meta.join(' \u00b7 ')) + '</div></div></div>';
  }

  // The group's rows for a scope and query, as keyed items; none outside "All" (it is not on this PC, and not a download).
  function buildTeamModelItems(merged, options) {
    var opts = objectOrEmpty(options);
    var entries = Array.isArray(objectOrEmpty(merged).teamModels) ? merged.teamModels : [];
    var query = String(opts.query == null ? '' : opts.query).trim().toLowerCase();
    var shown = (opts.scope === 'mine' || opts.scope === 'get') ? [] : entries.filter(function (entry) {
      return entry && entry.id && (!query || (teamModelName(entry) + ' ' + entry.id).toLowerCase().indexOf(query) >= 0);
    });
    if (!shown.length) return [];
    var note = '<p class="mlib-team-note" id="mlib-team-note" data-item="team-note"><span class="mp-quiet">' + escapeHtml(jt('team.engine.notice', 'The team’s host and the person whose hardware responds can read your prompts and replies.')) + '</span></p>'; // layout D4: the notice once, under the heading
    return [{ key: ':team-sep', html: '<div class="mrow-sep" data-item="sep-team">' + escapeHtml(jt('models.library.fromTeams', 'From your teams')) + '</div>' }, { key: ':team-note', html: note }]
      .concat(shown.map(function (entry) { return { key: entry.id, html: buildTeamModelRow(entry) }; }));
  }

  // The one line under the list that says where cloud models went.
  function buildCloudNote() {
    return '<p class="mp-more mp-more--inlist mlib-cloud-note" data-item="cloud"><span class="mp-quiet">'
      + escapeHtml(jt('settings.models.library.cloudNote.before', "Cloud models are not listed here. You pick one in a chat's model button; their providers are under ")) + '</span>'
      + libraryLink(jt('settings.models.library.cloudNote.link', 'Cloud providers'), 'cloud-providers')
      + '<span class="mp-quiet">' + escapeHtml(jt('settings.models.library.cloudNote.after', '.')) + '</span></p>';
  }

  // The Library list as one HTML string per element, keyed, so a caller can patch only what changed.
  // options: { query, scope, sort, showAllCatalog, actions, pulls, activation, shareOf(card), before }.
  function buildLibraryItems(merged, options) {
    var opts = objectOrEmpty(options);
    var hardware = objectOrEmpty(objectOrEmpty(merged).hardware);
    // The bar is a share of the whole card, the same scale as Running now and its preview.
    var budgetMb = positiveNumber(hardware.vramMb) || positiveNumber(hardware.budgetMb);
    var model = libraryRowsModel(merged, opts);
    var items = [];
    var addRow = function (card) {
      items.push({ key: String(card.key || ''), html: buildLibraryRow(card, Object.assign({
        actions: opts.actions, pull: pullForCard(opts.pulls, card.key), activation: opts.activation, budgetMb: budgetMb,
      }, opts.shareOf ? opts.shareOf(card) : null)) });
    };
    if (model.pullRow) items.push({ key: ':pull', html: buildLibraryPullRow(model.pullRow) });
    if (model.scope !== 'get') { items.push.apply(items, opts.before || []); model.mine.forEach(addRow); } // before: incoming models (6-7)
    if (model.scope === 'all' && model.collapsed) {
      model.pulling.forEach(addRow);
      if (model.collapsedCatalogCount > 0) {
        var more = model.collapsedFits
          ? jt('settings.models.library.moreFit', '{n} more models fit this PC', { n: model.collapsedCatalogCount })
          : jt('settings.models.library.moreDownload', '{n} models you can download', { n: model.collapsedCatalogCount });
        items.push({ key: ':more', html: '<p class="mp-more mp-more--inlist" data-item="more">' + libraryLink(more, 'show-catalog')
          + '<span class="mp-quiet">' + escapeHtml(jt('settings.models.library.notDownloaded', ' · not downloaded yet')) + '</span></p>' });
      }
    } else if (model.scope !== 'mine' && model.catalog.length) {
      if (model.scope === 'all') {
        items.push({ key: ':sep', html: '<div class="mrow-sep" data-item="sep">' + escapeHtml(jt('settings.models.library.notOnPc', 'Not on this PC yet'))
          + (model.query ? '' : ' · ' + libraryLink(jt('settings.models.library.hide', 'Hide'), 'hide-catalog')) + '</div>' });
      }
      model.catalog.forEach(addRow);
    }
    items.push.apply(items, buildTeamModelItems(merged, opts));
    if (!items.length) {
      var raw = String(opts.query == null ? '' : opts.query).trim();
      items.push({ key: ':empty', html: raw
        ? '<p class="model-library-empty mp-empty" data-item="empty">' + escapeHtml(jt('settings.models.library.nothingMatches', 'Nothing matches “{query}”. To pull a model Jenny does not list, paste its full tag, such as qwen3:8b.', { query: raw }))
          + ' ' + libraryLink(jt('settings.models.library.clear', 'Clear'), 'clear-search') + '</p>'
        : '<p class="model-library-empty mp-empty" data-item="empty">' + escapeHtml(jt('models.library.noFilterMatches', 'No models match this filter.')) + '</p>' });
    }
    items.push({ key: ':cloud', html: buildCloudNote() });
    return { items: items, model: model };
  }

  function buildLibraryList(merged, options) { return buildLibraryItems(merged, options).items.map(function (item) { return item.html; }).join(''); }

  return {
    buildLibraryRow: buildLibraryRow,
    buildLibraryItems: buildLibraryItems,
    buildLibraryList: buildLibraryList,
    libraryRowsModel: libraryRowsModel,
    buildTeamModelItems: buildTeamModelItems,
    buildScopeChips: buildScopeChips,
    buildModelCard: buildModelCard,
    buildModelGrid: buildModelGrid,
    buildHardwareSummaryLine: buildHardwareSummaryLine,
    buildFilterChips: buildFilterChips,
    libraryEngineName: libraryEngineName,
    isHostedCard: isHostedCard,
  };
});
