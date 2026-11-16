/* Model Library section › rendering: the search line and scope chips, the keyed
 * row list (only a changed row is repainted), one row patched in place, the
 * row hover/focus preview, each keeping the focused control focused, and the
 * Running now group (the loaded model, its GPU memory bar and the ghost preview). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.modelLibrarySectionRender = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var SEARCH_SELECTOR = '[data-model-library-section-input="search"]';
  var PREVIEW_EVENT = 'jenny:model-library-preview';

  function focusQuietly(element) {
    try { element.focus({ preventScroll: true }); }
    catch (_focusError) { element.focus(); }
  }

  // ---- Running now: the loaded model, a GPU memory bar and the hover/focus ghost preview ----
  function lazy(name, load) { return globalThis[name] || (typeof require === 'function' ? load() : null); }
  var escapeHtml = function (value) { return lazy('stringUtils', function () { return require('../../shared/string-utils'); }).escapeHtml(value); };
  function gb(mb) { return (Math.round((Number(mb) / 1024) * 10) / 10) + ' GB'; }
  function percent(mb, total) { return total > 0 ? Math.round(Math.max(0, Math.min(100, (mb / total) * 100)) * 10) / 10 : 0; }
  function contextLabel(tokens) {
    var n = Number(tokens) || 0;
    if (n <= 0) return '';
    return n < 1024 ? String(Math.round(n)) : String(Math.round((n / 1024) * 10) / 10).replace(/\.0$/, '') + 'K';
  }

  function viewHelpers() { return lazy('modelLibraryView', function () { return require('./model-library-view'); }); }
  function isHosted(card) { return viewHelpers().isHostedCard(card); }
  function engineName(card) { return viewHelpers().libraryEngineName(card); }

  function runningButton(action, tag, name, variant, disabled) {
    var label = action === 'unload' ? jt('settings.models.running.unload', 'Unload') : jt('settings.models.running.tune', 'Tune');
    return lazy('inventoryActionButton', function () { return require('../../inventory/action-button'); })({
      id: action, label: label, variant: variant, size: 'sm', disabled: disabled, ariaLabel: label + ' ' + name,
      className: 'model-card-action model-card-action--' + action,
      dataset: { 'model-card-action': action, 'model-tag': tag },
    });
  }

  // The card line, worded like the Library's own hardware summary.
  function cardLine(hardware, pending) {
    var view = lazy('modelLibraryView', function () { return require('./model-library-view'); });
    return view.buildHardwareSummaryLine(hardware, { pending: pending === true })
      .replace(/^<div[^>]*>/, '<span class="mm-gpu">').replace(/<\/div>$/, '</span>');
  }

  function runningMeta(card) {
    if (isHosted(card)) return jt('settings.models.running.hosted', '{provider} · runs on the provider\'s servers', { provider: String(card.engineType) });
    var parts = [engineName(card)];
    if (contextLabel(card.contextLength)) parts.push(jt('settings.models.running.context', '{n} context', { n: contextLabel(card.contextLength) }));
    if (card.mtp && card.mtp.enabled === true) parts.push(jt('settings.models.running.mtp', 'MTP'));
    if (card.servingPaused === true) parts.push(jt('models.library.pausedForImageRender', 'Paused for an image render'));
    else if (Number(card.servingPort) > 0 && card.selectedEngine !== 'ollama') parts.push(jt('settings.models.running.port', 'port {port}', { port: Number(card.servingPort) }));
    return parts.join(' · ');
  }

  function previewLegend(preview, vramMb) {
    var need = Number(preview.vramRequiredMb) || 0;
    var over = need > vramMb;
    var measured = preview.fitSource === 'observed';
    var name = String(preview.displayName || '');
    if (name.length > 34) name = name.slice(0, 33) + '…';
    var params = { n: gb(need), m: gb(Math.abs(vramMb - need)) };
    var words = over
      ? (measured ? jt('settings.models.running.previewOverMeasured', 'would use {n} · {m} more than this card has', params) : jt('settings.models.running.previewOver', 'would use about {n} · {m} more than this card has', params))
      : (measured ? jt('settings.models.running.previewFitsMeasured', 'would use {n} · {m} left free', params) : jt('settings.models.running.previewFits', 'would use about {n} · {m} left free', params));
    return '<span class="mm-preview' + (over ? ' mm-preview--over' : '') + '"><b>' + escapeHtml(name) + '</b> ' + escapeHtml(words) + '</span>';
  }

  // input: { merged: { cards, hardware }, activation, activeModelId, preferredModel, hardwarePending, preview }
  function buildRunningNow(input) {
    var o = input || {};
    var merged = o.merged || {};
    var cards = Array.isArray(merged.cards) ? merged.cards : [];
    var hardware = merged.hardware || {};
    var activation = o.activation || {};
    var modelId = String(o.activeModelId || '').trim();
    var active = cards.find(function (card) { return card && card.active === true; }) || null;
    var loading = null;
    if (activation.status === 'running') {
      var target = cards.find(function (card) { return card && card.key === activation.key; }) || null;
      if (target ? target !== active : !active) loading = target || { key: activation.key, tag: activation.key, displayName: activation.key };
    }
    var shown = loading || active;
    var vramMb = Number(hardware.vramMb) || 0;
    var need = shown ? Number(shown.vramRequiredMb) || 0 : 0;
    var hosted = Boolean(shown) && isHosted(shown);
    var idle = !shown && !modelId;
    var bar = hardware.detected === true && vramMb > 0 && !hosted && (Boolean(shown) || idle);
    var disabled = activation.status === 'running';
    var name = shown ? String(shown.displayName || shown.tag || shown.key || '') : modelId;
    var tag = shown ? String(shown.tag || shown.key || '') : modelId;
    var head;
    if (loading) {
      var spinner = lazy('inventorySpinner', function () { return require('../../inventory/spinner'); });
      head = '<span class="mm-name">' + escapeHtml(name) + '</span><span class="mm-meta">'
        + (spinner ? spinner({ size: 'sm', label: jt('settings.models.running.startingLabel', 'Starting') }) : '') + ' '
        + escapeHtml(jt('settings.models.running.starting', 'Starting on {engine}…', { engine: engineName(loading) })) + '</span><span class="mm-actions"></span>';
    } else if (idle) {
      head = '<span class="mm-name mm-name--idle">' + escapeHtml(jt('settings.models.running.nothing', 'Nothing loaded')) + '</span><span class="mm-meta">'
        + escapeHtml(o.preferredModel
          ? jt('settings.models.running.idleHint', 'Pick a model below, or Jenny loads {model} with your next message.', { model: o.preferredModel })
          : jt('settings.models.running.idleHintPlain', 'Pick a model below.')) + '</span><span class="mm-actions"></span>';
    } else {
      head = '<span class="mm-name" title="' + escapeHtml(tag) + '">' + escapeHtml(name) + '</span><span class="mm-meta">' + escapeHtml(shown ? runningMeta(shown) : '') + '</span>'
        + '<span class="mm-actions">' + runningButton('unload', tag, name, 'secondary', disabled)
        + (shown && lazy('modelLibraryMerge', function () { return require('./model-library-merge'); }).isLocalOrUnknownEngine(shown)
          ? runningButton('tune', tag, name, 'ghost', disabled) : '') + '</span>';
    }
    var preview = bar && !loading && o.preview && Number(o.preview.vramRequiredMb) > 0 ? o.preview : null;
    var fill = loading || shown ? percent(need, vramMb) : 0;
    var barHtml = '';
    if (bar) {
      var aria = loading ? jt('settings.models.running.ariaReserving', 'GPU memory: reserving about {n} of {total}', { n: gb(need), total: gb(vramMb) })
        : need > 0 && shown ? jt('settings.models.running.ariaInUse', 'GPU memory: {n} in use of {total}', { n: gb(need), total: gb(vramMb) })
          : jt('settings.models.running.ariaFree', 'GPU memory: {total} free', { total: gb(vramMb) });
      barHtml = '<div class="mm-bar" role="img" aria-label="' + escapeHtml(aria) + '"><i class="mm-fill" style="width:' + fill + '%"></i>'
        + (preview ? '<i class="mm-ghost' + (preview.vramRequiredMb > vramMb ? ' mm-ghost--over' : '') + '" style="width:' + percent(preview.vramRequiredMb, vramMb) + '%"></i>' : '')
        + [8, 16, 24].filter(function (t) { return t * 1024 < vramMb; }).map(function (t) {
          return '<i class="mm-tick" style="inset-inline-start:' + percent(t * 1024, vramMb) + '%"><span>' + t + '</span></i>';
        }).join('') + '</div>';
    }
    var legend = '';
    if (bar && loading) {
      legend = '<span>' + escapeHtml(jt('settings.models.running.reserving', 'Reserving about {n}', { n: gb(need) })) + '</span><span class="mm-free">'
        + escapeHtml(jt('settings.models.running.willStayFree', '{n} will stay free', { n: gb(Math.max(0, vramMb - need)) })) + '</span>';
    } else if (bar && shown && need > 0) {
      legend = (preview ? previewLegend(preview, vramMb) : '<span><b>' + escapeHtml(gb(need)) + '</b> '
        + escapeHtml(shown.fitSource === 'observed' ? jt('settings.models.running.inUseMeasured', 'in use · measured') : jt('settings.models.running.inUseEstimated', 'in use · estimated')) + '</span>')
        + '<span class="mm-free">' + escapeHtml(jt('settings.models.running.free', '{n} free', { n: gb(Math.max(0, vramMb - need)) })) + '</span>';
    } else if (bar && idle) {
      legend = (preview ? previewLegend(preview, vramMb) : '') + '<span class="mm-free">' + escapeHtml(jt('settings.models.running.free', '{n} free', { n: gb(vramMb) })) + '</span>';
    }
    return '<div class="mm' + (loading ? ' mm--loading' : idle ? ' mm--idle' : '') + '"><div class="mm-head">' + head + '</div>' + barHtml
      + (hosted ? '' : '<div class="mm-legend">' + legend + cardLine(hardware, o.hardwarePending) + '</div>') + '</div>';
  }

  // Patch the bar in place: the fill and the ghost keep their nodes so their width transitions play.
  function patchBar(current, next) {
    var ticks = function (bar) { return Array.from(bar.querySelectorAll('.mm-tick')).map(function (tick) { return tick.outerHTML; }).join(''); };
    if (ticks(current) !== ticks(next)) return false;
    current.setAttribute('aria-label', next.getAttribute('aria-label') || '');
    current.querySelector('.mm-fill').style.width = next.querySelector('.mm-fill').style.width;
    var ghost = current.querySelector('.mm-ghost');
    var wanted = next.querySelector('.mm-ghost');
    if (!wanted) { if (ghost) ghost.remove(); return true; }
    if (!ghost) { current.querySelector('.mm-fill').after(wanted); return true; }
    ghost.className = wanted.className;
    ghost.style.width = wanted.style.width;
    return true;
  }

  // Replace only the parts whose markup changed; a hover preview touches the bar and the legend, never the buttons.
  function patchRunningNow(host, html) {
    var template = host.ownerDocument.createElement('template');
    template.innerHTML = html;
    var next = template.content.firstElementChild;
    var current = host.firstElementChild;
    var parts = next ? Array.from(next.children) : [];
    if (!current || current.className !== next.className || current.children.length !== parts.length) {
      host.innerHTML = html;
      return;
    }
    parts.forEach(function (part, index) {
      var have = current.children[index];
      if (have.outerHTML === part.outerHTML) return;
      if (have.classList.contains('mm-bar') && part.classList.contains('mm-bar') && patchBar(have, part)) return;
      current.replaceChild(part, have);
    });
  }

  // deps: { host(), card(), isDisposed(), getMerged(), hardwarePending(), activationState(), activeModel(), preferredModel() }
  function createRunningNow(d) {
    var last = '';
    var preview = null;
    var boundCard = null;

    function render() {
      if (d.isDisposed()) return;
      var host = d.host();
      if (!host) return;
      var html = buildRunningNow({
        merged: d.getMerged() || { cards: [], hardware: {} }, activation: d.activationState(), activeModelId: d.activeModel(),
        preferredModel: d.preferredModel(), hardwarePending: d.hardwarePending(), preview: preview,
      });
      if (html === last && host.firstElementChild) return;
      // Keep keyboard focus on Unload or Tune across a repaint (or on the group when the button goes away).
      var focused = host.ownerDocument && host.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement : null;
      var action = focused && focused.getAttribute('data-model-card-action');
      patchRunningNow(host, html);
      last = html;
      var next = focused && !host.contains(focused) ? host.querySelector('[data-model-card-action="' + action + '"]') || host.querySelector('[data-model-card-action]') : null;
      if (next) focusQuietly(next);
    }

    function onPreview(event) {
      if (d.isDisposed()) return;
      preview = event.detail || null;
      render();
    }

    function unbind() {
      if (boundCard) boundCard.removeEventListener(PREVIEW_EVENT, onPreview);
      boundCard = null;
    }

    function bind() {
      var target = d.card();
      if (!target || target === boundCard) return;
      unbind();
      boundCard = target;
      target.addEventListener(PREVIEW_EVENT, onPreview);
    }

    return { render: render, bind: bind, dispose: function () { unbind(); preview = null; } };
  }

  // deps: { documentRef, view, actions, viewModule, inventoryTextField,
  //   inventoryActionButton, segmentedControl, host(), toolbarHost(), card(), isDisposed(),
  //   getMerged(), hardwarePending(), accelerationFlagEnabled(), getEngineBlocks(),
  //   renderFolders(), hideMenu(), currentPulls(), activationState(),
  //   renderConfirmModal(), findModel(key), runningHost(), activeModel(), preferredModel(),
  //   share() (slice 6-7, optional: model-library-share-section.js once loaded, else null) }
  function createModelLibrarySectionRender(deps) {
    var d = deps || {};
    var documentRef = d.documentRef;
    var view = d.view;
    var viewModule = d.viewModule;
    var lastChips = '';
    var scaffold = null; // { cols, list, colsHtml }: the caption and the list inside the rows host
    var painted = { keys: [], html: [] };
    var previewKey = '';
    var previewHost = null;
    var share = function () { return typeof d.share === 'function' ? d.share() : null; };
    var running = createRunningNow({
      host: d.runningHost, card: d.card, isDisposed: d.isDisposed, getMerged: d.getMerged, hardwarePending: d.hardwarePending,
      activationState: d.activationState, activeModel: d.activeModel, preferredModel: d.preferredModel,
    });

    function modelView() {
      return d.getMerged() || { hardware: {}, cards: [] };
    }

    function itemOptions() {
      return {
        query: view.query, scope: view.scope, sort: view.sort, showAllCatalog: view.showAllCatalog,
        actions: d.actions, pulls: d.currentPulls(), activation: d.activationState(),
        // Slice 6-7: model sharing (model-library-share-section.js), when the team assets loaded it.
        shareOf: share() ? share().shareOf : null, before: share() ? share().before(view) : [],
      };
    }

    function chipsHtml(counts) {
      lastChips = viewModule.buildScopeChips(view.scope, counts || viewModule.libraryRowsModel(modelView(), itemOptions()).counts);
      return lastChips;
    }

    function toolbarHtml() {
      var hardware = modelView().hardware;
      var sortOptions = [
        { value: 'name', label: jt('settings.models.library.sort.name', 'Name') },
        { value: 'size', label: jt('settings.models.library.sort.size', 'Size') },
      ];
      return '<div class="mlib-searchline">'
        + d.inventoryTextField({
          id: 'modelLibrarySearch',
          value: view.query,
          placeholder: jt('settings.models.library.searchPlaceholder', 'Search your models, or paste an Ollama tag or Hugging Face address'),
          ariaLabel: jt('settings.models.library.searchAria', 'Search or add models'),
          className: 'mlib-search',
          dataset: { 'model-library-section-input': 'search' },
        })
        + (d.accelerationFlagEnabled() ? d.inventoryActionButton({
          id: 'add-gguf',
          label: jt('settings.models.library.addGguf', 'Add GGUF file…'),
          variant: 'secondary',
          size: 'sm',
          dataset: { 'model-library-section-action': 'add-gguf' },
        }) : '')
        + '</div>'
        + '<div class="mlib-tools">' + chipsHtml()
        + '<div class="mlib-tools-end">'
        + d.segmentedControl({ id: 'modelLibrarySort', ariaLabel: jt('settings.models.library.sort.aria', 'Sort'), value: view.sort, options: sortOptions })
        + d.inventoryActionButton({
          id: 'refresh',
          label: '↻',
          ariaLabel: jt('settings.modelLibrary.refreshCatalog', 'Refresh catalog'),
          variant: 'ghost',
          size: 'sm',
          className: 'model-library-section-refresh',
          dataset: { 'model-library-section-action': 'refresh' },
        })
        + '</div></div>'
        // Running now owns the card line; this one speaks only while there is no verdict to show.
        + (d.hardwarePending() || hardware.detected !== true
          ? viewModule.buildHardwareSummaryLine(hardware, { pending: d.hardwarePending() }) : '');
    }

    function renderToolbar() {
      if (d.isDisposed()) return;
      var target = d.toolbarHost();
      if (!target) return;
      var activeElement = documentRef.activeElement;
      var searchFocus = activeElement && target.contains(activeElement)
        && activeElement.getAttribute?.('data-model-library-section-input') === 'search' ? {
          value: String(activeElement.value || ''),
          selectionStart: activeElement.selectionStart,
          selectionEnd: activeElement.selectionEnd,
          selectionDirection: activeElement.selectionDirection,
        } : null;
      if (searchFocus) view.query = searchFocus.value;
      target.innerHTML = toolbarHtml();
      d.renderFolders();
      var engineBlocks = d.getEngineBlocks();
      if (engineBlocks) engineBlocks.render();
      if (!searchFocus) return;
      var nextInput = target.querySelector(SEARCH_SELECTOR);
      if (!nextInput) return;
      nextInput.value = searchFocus.value;
      focusQuietly(nextInput);
      if (typeof nextInput.setSelectionRange === 'function'
        && Number.isInteger(searchFocus.selectionStart) && Number.isInteger(searchFocus.selectionEnd)) {
        nextInput.setSelectionRange(searchFocus.selectionStart, searchFocus.selectionEnd, searchFocus.selectionDirection || 'none');
      }
    }

    // Typing and chip clicks change only the counts and the pressed chip; the search field stays.
    function renderChips(counts) {
      if (d.isDisposed()) return;
      var target = d.toolbarHost();
      var group = target && target.querySelector('.model-library-filter-chips');
      if (!group) return;
      var previous = lastChips;
      var html = chipsHtml(counts);
      if (html === previous) return;
      var focusedChip = documentRef.activeElement && group.contains(documentRef.activeElement)
        ? documentRef.activeElement.getAttribute('data-inv-chip') : '';
      group.outerHTML = html;
      if (!focusedChip) return;
      var next = target.querySelector('[data-inv-chip="' + focusedChip + '"]');
      if (next) focusQuietly(next);
    }

    function colsHtml() {
      var vramMb = Number(modelView().hardware && modelView().hardware.vramMb) || 0;
      var vram = vramMb > 0 ? gb(vramMb) : '';
      var help = vram
        ? jt('settings.models.library.vramNeededHelp', 'How much of this card\'s {vram} the model needs at its context size. A number with ~ is an estimate; a plain number was measured the last time the model ran.', { vram: vram })
        : jt('settings.models.library.vramNeededHelpNoCard', 'How much video memory the model needs at its context size. A number with ~ is an estimate; a plain number was measured the last time the model ran.');
      return '<span aria-hidden="true"></span><span class="mrow-cols-fit">'
        + escapeHtml(jt('settings.models.library.vramNeeded', 'VRAM needed')) + ' '
        + d.inventoryActionButton({
          plain: true,
          className: 'settings-field-detail inv-tooltip-pin',
          label: '?',
          ariaLabel: jt('settings.models.library.vramNeededAria', 'More about VRAM needed'),
          dataset: { tooltip: help, 'tooltip-placement': 'below' },
        }) + '</span><span aria-hidden="true"></span>';
    }

    function ensureScaffold(target) {
      if (scaffold && scaffold.cols.parentNode === target && scaffold.list.parentNode === target) return scaffold;
      target.innerHTML = '<div class="mrow-cols"></div><div class="mrow-list"></div>';
      scaffold = { cols: target.firstElementChild, list: target.lastElementChild, colsHtml: '' };
      painted = { keys: [], html: [] };
      return scaffold;
    }

    function elementFromHtml(html) {
      var template = documentRef.createElement('template');
      template.innerHTML = html;
      return template.content.firstElementChild;
    }

    // The focused button of a row, by its action and (a share button, 6-7) the ids it acts on, compared as attributes.
    var FOCUS_ATTRS = ['data-model-card-action', 'data-mshare-action', 'data-mshare-offer', 'data-mshare-request', 'data-mshare-transfer', 'data-mshare-tag'];
    function captureRowFocus(target) {
      var activeElement = documentRef.activeElement;
      var activeRow = activeElement && target.contains(activeElement)
        ? activeElement.closest?.('[data-model-key]') : null;
      if (!activeRow || !(activeElement.hasAttribute?.('data-model-card-action') || activeElement.hasAttribute?.('data-mshare-action'))) return null;
      var attrs = FOCUS_ATTRS.filter(function (name) { return activeElement.hasAttribute(name); }).map(function (name) { return [name, activeElement.getAttribute(name)]; });
      return { attrs: attrs, key: activeRow.getAttribute('data-model-key') || '' };
    }

    function restoreRowFocus(target, rowFocus) {
      if (!rowFocus || !rowFocus.key) return;
      var row = Array.from(target.querySelectorAll('[data-model-key]')).find(function (candidate) {
        return candidate.getAttribute('data-model-key') === rowFocus.key;
      });
      var next = row && Array.from(row.querySelectorAll('[' + rowFocus.attrs[0][0] + ']')).find(function (node) {
        return rowFocus.attrs.every(function (pair) { return node.getAttribute(pair[0]) === pair[1]; });
      });
      if (next && documentRef.activeElement !== next) focusQuietly(next);
    }

    // Reconcile by key: a row whose markup is unchanged keeps its node (and its hover and focus);
    // only new or changed rows are parsed, stale ones removed, the rest moved into order.
    function paintList(list, items) {
      var old = new Map();
      if (list.children.length === painted.keys.length) {
        painted.keys.forEach(function (key, index) { old.set(key, { node: list.children[index], html: painted.html[index] }); });
      } else {
        list.textContent = '';
      }
      var nodes = items.map(function (item) {
        var previous = old.get(item.key);
        if (previous && previous.html === item.html) { old.delete(item.key); return previous.node; }
        return elementFromHtml(item.html);
      });
      old.forEach(function (entry) { entry.node.remove(); });
      nodes.forEach(function (node, index) {
        if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
      });
      painted = { keys: items.map(function (item) { return item.key; }), html: items.map(function (item) { return item.html; }) };
    }

    function renderRows() {
      d.hideMenu();
      if (d.isDisposed()) return;
      running.render();
      var target = d.host();
      if (!target) return;
      var rowFocus = captureRowFocus(target);
      var parts = ensureScaffold(target);
      var cols = colsHtml();
      if (cols !== parts.colsHtml) {
        parts.cols.innerHTML = cols;
        parts.colsHtml = cols;
      }
      var built = viewModule.buildLibraryItems(modelView(), itemOptions());
      paintList(parts.list, built.items);
      renderChips(built.model.counts);
      restoreRowFocus(target, rowFocus);
      if (previewKey && painted.keys.indexOf(previewKey) < 0) emitPreview('');
      d.renderConfirmModal();
    }

    // Progress ticks patch one row in place; group membership only changes on
    // 'done', which goes through the section's refresh(). A `:offer:<id>` key is an incoming model's row (6-7).
    function replaceRow(key) {
      var target = d.host();
      var offer = String(key).indexOf(':offer:') === 0;
      var model = offer ? { key: String(key) } : d.findModel(key);
      var index = model ? painted.keys.indexOf(model.key) : -1;
      if (!target || !scaffold || index < 0) return false;
      var current = scaffold.list.children[index];
      if (!current || current.getAttribute('data-model-key') !== model.key) return false;
      var pulls = d.currentPulls();
      var merged = modelView();
      var hardware = merged.hardware || {};
      var markup = offer ? (share() ? share().rowHtml(key) : '') : viewModule.buildLibraryRow(model, Object.assign({
        actions: d.actions,
        pull: pulls[key] || pulls[model.key] || {},
        activation: d.activationState(),
        budgetMb: Number(hardware.vramMb) || Number(hardware.budgetMb) || 0,
      }, share() ? share().shareOf(model) : null));
      if (!markup) return false;
      if (markup === painted.html[index]) return true;
      var rowFocus = captureRowFocus(target);
      scaffold.list.replaceChild(elementFromHtml(markup), current);
      painted.html[index] = markup;
      restoreRowFocus(target, rowFocus);
      return true;
    }

    // Running pull ticks coalesce: each dirty row paints once per animation frame.
    var dirtyKeys = new Set();
    var frame = null;

    function flushFrame() {
      frame = null;
      if (d.isDisposed()) return;
      var keys = Array.from(dirtyKeys);
      dirtyKeys.clear();
      keys.forEach(replaceRow);
    }

    function queueRow(key) {
      dirtyKeys.add(key);
      if (frame) return;
      var win = d.windowRef;
      if (win && typeof win.requestAnimationFrame === 'function') {
        var id = win.requestAnimationFrame(flushFrame);
        frame = { cancel: function () { if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(id); } };
      } else {
        var timer = setTimeout(flushFrame, 16);
        frame = { cancel: function () { clearTimeout(timer); } };
      }
    }

    // The hovered or focused row tells Running now how much VRAM it would need.
    function emitPreview(key) {
      if (key === previewKey) return;
      previewKey = key;
      var card = d.card();
      var win = documentRef.defaultView;
      if (!card || !win) return;
      var model = key ? d.findModel(key) : null;
      card.dispatchEvent(new win.CustomEvent(PREVIEW_EVENT, {
        bubbles: true,
        detail: model ? {
          key: model.key,
          vramRequiredMb: Number(model.vramRequiredMb) || 0,
          fitSource: String(model.fitSource || ''),
          displayName: String(model.displayName || model.tag || ''),
        } : null,
      }));
    }

    function rowKeyOf(node) {
      var row = node && node.closest ? node.closest('.mrow[data-model-key]') : null;
      return row ? row.getAttribute('data-model-key') || '' : '';
    }

    var previewHandlers = {
      pointerover: function (event) { emitPreview(rowKeyOf(event.target)); },
      pointerout: function (event) { emitPreview(rowKeyOf(event.relatedTarget)); },
      focusin: function (event) { emitPreview(rowKeyOf(event.target)); },
      focusout: function (event) { emitPreview(rowKeyOf(event.relatedTarget)); },
    };

    function bindPreview() {
      running.bind();
      var target = d.host();
      if (!target || previewHost === target) return;
      unbindPreview();
      previewHost = target;
      Object.keys(previewHandlers).forEach(function (type) { target.addEventListener(type, previewHandlers[type]); });
    }

    function unbindPreview() {
      if (!previewHost) return;
      Object.keys(previewHandlers).forEach(function (type) { previewHost.removeEventListener(type, previewHandlers[type]); });
      previewHost = null;
    }

    return {
      renderToolbar: renderToolbar,
      renderChips: renderChips,
      renderRows: renderRows,
      replaceRow: replaceRow,
      queueRow: queueRow,
      bindPreview: bindPreview,
      dispose: function () {
        running.dispose();
        unbindPreview();
        if (frame) frame.cancel();
        frame = null;
        dirtyKeys.clear();
      },
    };
  }

  return {
    createModelLibrarySectionRender: createModelLibrarySectionRender, focusQuietly: focusQuietly,
    buildRunningNow: buildRunningNow, createRunningNow: createRunningNow,
  };
});
