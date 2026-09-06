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

  if (!formatUtils || typeof formatUtils.formatHumanSize !== 'function'
    || typeof inventoryBadge !== 'function'
    || typeof inventoryChip !== 'function'
    || typeof inventoryProgressBar !== 'function'
    || typeof inventoryActionButton !== 'function'
    || !mergeUtils || typeof mergeUtils.fitTone !== 'function'
    || typeof mergeUtils.filterModelCards !== 'function'
    || typeof mergeUtils.isLocalEngine !== 'function'
    || typeof mergeUtils.isLocalOrUnknownEngine !== 'function'
    || typeof mergeUtils.groupModelCards !== 'function'
    || typeof mergeUtils.filterCounts !== 'function') {
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
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
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

  var FIT_SOURCE_SUFFIX = {
    estimated: ' · estimated',
    observed: ' · measured',
  };

  function fitSourceSuffix(card) {
    return FIT_SOURCE_SUFFIX[String(card && card.fitSource || '')] || '';
  }

  function formatDisk(card) {
    var sizeBytes = positiveNumber(card.sizeBytes);
    if (card.installed === true) {
      return sizeBytes ? formatUtils.formatHumanSize(sizeBytes) : 'Size unknown';
    }
    return formatMbAsDownload(card.downloadSizeMb) || 'Disk size unknown';
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
    if (action === 'use') {
      return card.installed === true && card.engineVisible === true && card.active !== true;
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
    if (action === 'pull') return card.installed !== true && !running;
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
      use: { label: 'Use', variant: 'primary' },
      unload: { label: 'Unload', variant: 'secondary' },
      tune: { label: 'Tune', variant: 'secondary' },
      remove: { label: 'Remove', variant: 'danger' },
      pull: { label: 'Pull', variant: 'primary' },
      cancel: { label: 'Cancel', variant: 'danger' },
      menu: { label: '⋯', variant: 'ghost', ariaLabel: 'More actions for ' + name },
    }[action];
    var pendingUse = pending && action === 'use';
    return {
      id: action,
      label: pendingUse ? 'Starting…' : config.label,
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

  function renderActions(card, actions, pull, compact, activation) {
    var allowed = actionSet(actions);
    var order = compact === true
      ? ['use', 'unload', 'tune', 'remove', 'pull']
      : ['use', 'unload', 'tune', 'pull', 'menu'];
    var html = order.map(function (action) {
      return allowed.has(action) ? renderAction(action, card, pull, compact, activation) : '';
    }).join('');
    var className = compact === true ? 'model-card-actions' : 'model-row-actions';
    return html ? '<div class="' + className + '">' + html + '</div>' : '';
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
    }
    if (model.selectedEngine === 'llama-server') {
      badges.push(inventoryBadge({ tone: 'muted', size: 'sm', text: 'llama-server' + (mtpOn ? ' \u00b7 MTP' : '') }));
    }
    if (model.accelerationEligible === true && !mtpOn) {
      badges.push(inventoryBadge({ tone: 'muted', size: 'sm', text: 'MTP ready' }));
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
        text: card.fitState === 'fits' ? 'Best fit for your GPU' : 'Recommended',
      }));
    }
    badges.push.apply(badges, engineBadges(card));
    if (card.ollamaOnly === true) {
      badges.push(inventoryBadge({ tone: 'muted', size: 'sm', text: 'Ollama only' }));
      badges.push('<span class="model-card-engine-note">Not available to the current engine</span>');
    }
    return badges.length ? '<div class="model-card-badges">' + badges.join('') + '</div>' : '';
  }

  function renderFitBar(card) {
    var unknown = card.fitState === 'unknown';
    var budgetMb = positiveNumber(card.budgetMb);
    var proportional = budgetMb > 0 && !unknown;
    var name = String(card.displayName || card.tag || 'model');
    return inventoryProgressBar({
      value: proportional ? positiveNumber(card.vramRequiredMb) : 0,
      max: proportional ? budgetMb : 1,
      // Thresholds above 1 suppress primitive tone; fitState owns the bar tone.
      warningThreshold: 2,
      dangerThreshold: 2,
      displayText: (unknown
        ? String(card.fitLabel || 'Fit unknown')
        : String(card.fitLabel || '')) + fitSourceSuffix(card),
      label: 'VRAM fit for ' + name,
      className: 'model-card-fit model-card-fit--' + mergeUtils.fitTone(card),
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
        label: 'Pull progress for ' + String(card.displayName || card.tag || 'model'),
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
      pieces.push(inventoryBadge({ tone: 'danger', size: 'sm', text: 'Cancel failed' }));
    }
    return pieces.length ? '<div class="model-card-pull-state">' + pieces.join('') + '</div>' : '';
  }

  function buildModelRow(card, options) {
    var model = objectOrEmpty(card);
    var opts = objectOrEmpty(options);
    var pull = objectOrEmpty(opts.pull);
    var activation = Object.assign(
      { status: 'idle', key: '', message: '' },
      objectOrEmpty(opts.activation)
    );
    var tag = String(model.tag || '');
    var name = String(model.displayName || model.tag || 'Local model');
    var sourceInstalled = model.source === 'installed';
    var cloud = model.installed === true && Boolean(model.engineType)
      && !mergeUtils.isLocalEngine(model);
    var activationMatches = activation.key === model.key;
    var pending = activation.status === 'running' && activationMatches;
    var badges = [];
    var meta = [];
    var context = formatContext(model.contextLength);

    if (model.active === true) {
      badges.push(inventoryBadge({ tone: 'pending', size: 'sm', text: 'Active' }));
    }
    if (model.recommended === true) {
      badges.push(inventoryBadge({
        tone: 'success',
        size: 'sm',
        text: model.fitState === 'fits' ? 'Best fit' : 'Recommended',
      }));
    }
    badges.push.apply(badges, engineBadges(model));
    if (model.ollamaOnly === true) {
      badges.push(inventoryBadge({ tone: 'muted', size: 'sm', text: 'Ollama only' }));
    }

    if (!sourceInstalled && tag) meta.push(tag);
    if (model.params) meta.push(String(model.params));
    if (model.quant) meta.push(String(model.quant));
    if (context) meta.push(context + ' context');
    if (cloud) {
      meta.push('Hosted');
      meta.push('no download');
    } else if (model.installed === true) {
      meta.push(positiveNumber(model.sizeBytes)
        ? formatUtils.formatHumanSize(model.sizeBytes)
        : 'Size unknown');
    } else {
      meta.push(formatMbAsDownload(model.downloadSizeMb) || 'Disk size unknown');
    }
    if (model.preferredLocal === true) meta.push('default for local inference');

    var nameHtml = sourceInstalled
      ? '<code class="model-row-name model-row-name--tag" title="' + escapeHtml(tag) + '">'
        + escapeHtml(tag) + '</code>'
      : '<span class="model-row-name" title="' + escapeHtml(tag) + '">'
        + escapeHtml(name) + '</span>';
    var engineNote = model.ollamaOnly === true
      ? '<span class="model-card-engine-note">Not available to the current engine</span>'
      : '';
    var noteHtml = activation.status === 'idle' && activationMatches
      && String(activation.message || '').trim()
      ? '<div class="model-card-note model-card-note--error">'
        + escapeHtml(activation.message) + '</div>'
      : '';
    var fitHtml;
    if (cloud) {
      fitHtml = '<span class="model-row-fit-none" aria-hidden="true">—</span>';
    } else if (model.fitState === 'unknown') {
      var unknownLabel = String(model.fitLabel || '').trim();
      fitHtml = '<span class="model-row-fit-text">'
        + escapeHtml((unknownLabel && unknownLabel !== 'Not in catalog'
          ? unknownLabel
          : 'Not in catalog · fit unknown') + fitSourceSuffix(model))
        + '</span>';
    } else {
      fitHtml = '<span class="model-row-fit-text">'
        + escapeHtml(String(model.fitLabel || '') + fitSourceSuffix(model)) + '</span>'
        + renderFitBar(model);
    }

    return ''
      + '<div class="model-row" data-model-key="' + escapeHtml(model.key || '') + '" data-active="'
      + (model.active === true ? 'true' : 'false') + '" data-pending="'
      + (pending ? 'true' : 'false') + '">'
      + '<div class="model-row-main">'
      + '<div class="model-row-title">' + nameHtml + badges.join('') + '</div>'
      + '<div class="model-row-meta">' + escapeHtml(meta.join(' · ')) + '</div>'
      + engineNote
      + renderPullState(model, pull, opts.actions)
      + noteHtml
      + '</div>'
      + '<div class="model-row-fit">' + fitHtml + '</div>'
      + renderActions(model, opts.actions, pull, false, activation)
      + '</div>';
  }

  function buildModelCard(card, options) {
    var model = objectOrEmpty(card);
    var opts = objectOrEmpty(options);
    if (opts.compact !== true) return buildModelRow(model, opts);
    var pull = objectOrEmpty(opts.pull);
    var activation = Object.assign(
      { status: 'idle', key: '', message: '' },
      objectOrEmpty(opts.activation)
    );
    var name = String(model.displayName || model.tag || 'Local model');
    var icon = Array.from(name.trim())[0] || '?';
    var stats = [
      model.params ? String(model.params) : '',
      model.quant ? String(model.quant) : '',
      formatContext(model.contextLength) ? formatContext(model.contextLength) + ' context' : '',
      formatDisk(model),
    ].filter(Boolean);
    var compact = true;
    var tierHtml = '';
    var reasonHtml = model.reason
      ? '<div class="model-card-reason">' + escapeHtml(model.reason) + '</div>'
      : '';
    var activationMatches = activation.key === model.key;
    var pending = activation.status === 'running' && activationMatches;
    var noteHtml = activation.status === 'idle' && activationMatches
      && String(activation.message || '').trim()
      ? '<div class="model-card-note model-card-note--error">'
        + escapeHtml(activation.message) + '</div>'
      : '';

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
      + noteHtml
      + renderActions(model, opts.actions, pull, compact, activation)
      + '</div>';
  }

  function formatGb(megabytes) {
    var number = positiveNumber(megabytes);
    return number ? (Math.round((number / 1024) * 10) / 10) + ' GB' : '';
  }

  function buildHardwareSummaryLine(hardware) {
    var profile = objectOrEmpty(hardware);
    if (profile.detected !== true) {
      return '<div class="model-library-hardware-summary">Hardware not detected</div>';
    }
    var parts = [];
    var unified = profile.type === 'metal' || profile.memoryArchitecture === 'unified';
    if (unified) {
      parts.push(String(profile.name || 'Apple Silicon GPU'));
      if (positiveNumber(profile.unifiedMemoryMb)) {
        parts.push(formatGb(profile.unifiedMemoryMb) + ' unified memory');
      }
    } else if (profile.type === 'cpu' || !positiveNumber(profile.vramMb)) {
      parts.push('CPU inference');
    } else {
      parts.push(String(profile.name || 'GPU'));
      parts.push(formatGb(profile.vramMb) + ' VRAM');
    }
    if (positiveNumber(profile.ramAvailableMb)) {
      parts.push(formatGb(profile.ramAvailableMb) + ' RAM available');
    } else if (positiveNumber(profile.ramTotalMb)) {
      parts.push(formatGb(profile.ramTotalMb) + ' RAM');
    }
    return '<div class="model-library-hardware-summary">' + escapeHtml(parts.join(' · ')) + '</div>';
  }

  function buildFilterChips(filter, counts) {
    var active = ['all', 'installed', 'recommended'].includes(filter) ? filter : 'all';
    var totals = objectOrEmpty(counts);
    var allOptions = { id: 'all', label: 'All', pressed: active === 'all' };
    var installedOptions = { id: 'installed', label: 'Installed', pressed: active === 'installed' };
    var recommendedOptions = {
      id: 'recommended',
      label: 'Recommended',
      pressed: active === 'recommended',
    };
    if (Number.isInteger(totals.all) && totals.all >= 0) allOptions.count = totals.all;
    if (Number.isInteger(totals.installed) && totals.installed >= 0) {
      installedOptions.count = totals.installed;
    }
    if (Number.isInteger(totals.recommended) && totals.recommended >= 0) {
      recommendedOptions.count = totals.recommended;
    }
    return '<div class="model-library-filter-chips" role="group" aria-label="Filter models">'
      + inventoryChip(allOptions)
      + inventoryChip(installedOptions)
      + inventoryChip(recommendedOptions)
      + '</div>';
  }

  function pullForCard(pulls, key) {
    var source = objectOrEmpty(pulls);
    return Object.prototype.hasOwnProperty.call(source, key) ? objectOrEmpty(source[key]) : {};
  }

  function buildModelGroups(groups, options) {
    var source = Array.isArray(groups) ? groups : [];
    var opts = objectOrEmpty(options);
    return source.map(function (group) {
      var current = objectOrEmpty(group);
      var cards = Array.isArray(current.cards) ? current.cards : [];
      if (!cards.length) return '';
      var rows = cards.map(function (card) {
        return buildModelRow(card, {
          actions: opts.actions,
          pull: pullForCard(opts.pulls, card && card.key),
          activation: opts.activation,
        });
      }).join('');
      return '<section class="model-row-group" data-model-group="'
        + escapeHtml(current.id || '') + '"><h4 class="model-row-group-title">'
        + escapeHtml(current.label || '') + ' <span class="model-row-group-count">'
        + cards.length + '</span></h4>' + rows + '</section>';
    }).join('');
  }

  function buildModelGrid(mergedViewModel, options) {
    var merged = objectOrEmpty(mergedViewModel);
    var opts = objectOrEmpty(options);
    var cards = Array.isArray(merged.cards) ? merged.cards : [];
    var filter = ['all', 'installed', 'recommended'].includes(opts.filter) ? opts.filter : 'all';
    var filtered = mergeUtils.filterModelCards(cards, filter);
    var hardware = objectOrEmpty(merged.hardware);
    if (opts.compact === true) {
      var cardHtml = filtered.map(function (card) {
        var model = Object.assign({}, card, { budgetMb: positiveNumber(hardware.budgetMb) });
        return buildModelCard(model, {
          actions: opts.actions,
          pull: pullForCard(opts.pulls, model.key),
          compact: true,
          activation: opts.activation,
        });
      }).join('');
      var compactCounts = {
        installed: cards.filter(function (card) { return card && card.installed === true; }).length,
      };
      return ''
        + '<div class="model-library-view">'
        + buildHardwareSummaryLine(hardware)
        + buildFilterChips(filter, compactCounts)
        + '<div class="model-card-grid">'
        + (cardHtml || '<div class="model-library-empty">No models match this filter.</div>')
        + '</div>'
        + '</div>';
    }
    var grouped = mergeUtils.groupModelCards(mergeUtils.orderModelCards(filtered).map(function (card) {
      return Object.assign({}, card, { budgetMb: positiveNumber(hardware.budgetMb) });
    }));
    var groupHtml = buildModelGroups(grouped, {
      actions: opts.actions,
      pulls: opts.pulls,
      activation: opts.activation,
    });
    var counts = mergeUtils.filterCounts(cards);
    return ''
      + '<div class="model-library-view">'
      + buildHardwareSummaryLine(hardware)
      + buildFilterChips(filter, counts)
      + '<div class="model-row-list">'
      + (groupHtml || '<div class="model-library-empty">No models match this filter.</div>')
      + '</div>'
      + '</div>';
  }

  return {
    buildModelCard: buildModelCard,
    buildModelRow: buildModelRow,
    buildModelGroups: buildModelGroups,
    buildModelGrid: buildModelGrid,
    buildHardwareSummaryLine: buildHardwareSummaryLine,
    buildFilterChips: buildFilterChips,
  };
});
