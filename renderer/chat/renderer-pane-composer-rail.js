/* renderer/chat/renderer-pane-composer-rail.js -- pane rails and Chat/Workspace toolbar fit (UMD) */
/**
 * Split view W2-2a. Pane 0's rail (index.html .composer-rail) is document
 * chrome; a pane that is not pane 0 gets its own rail, built at mount INTO the
 * template's empty .composer-rail, reading and writing ITS session:
 *
 *   createPaneComposerRail({ state, paneRoot, railEl, hintHost, sessionContext,
 *       documentRef, deps }) -> { dom, sync(flags), dispose() } or null
 *
 *   - a run-mode slot with the SAME run-mode switcher pane 0 mounts
 *     (renderer-composer-v2-render.js createRunModeSwitcherRenderer), its chip
 *     id-less, `getRunMode` = this pane session's projected run mode;
 *   - a deep clone of pane 0's #composerModelPillSlot (the model pill, the
 *     popover with the picker host and the hidden model/effort carriers): every
 *     id stripped, `data-chat-node` names set, the popover given a per-pane id
 *     so the pill's aria-controls opens THIS popover; pane 0's sr-only disabled
 *     reasons are not cloned (they stay pane 0's);
 *   - an empty .composer-mode-chips row after `hintHost`: the model-loading
 *     line's anchor (the mode's hint is the run-mode chip's title).
 *
 * The listeners that WRITE (model change, effort change, chip click) are the
 * settings bindings' bindComposerRailEvents, bound by pane 1's chat event
 * bindings on the nodes this returns in `dom`. This module owns the pane's
 * picker instance (never the module singleton, which stays pane 0's), its
 * reasoning-effort carrier pair (reasoningEffortControls.attachCarriers) and
 * its switcher. `sync(flags)` runs from the pane composition's
 * syncPaneComposer (composer-kind renders of this pane only) and writes an
 * attribute only when it changes. `dispose()` removes every listener, the
 * observer, the picker instance, the switcher and the nodes it added.
 *
 * New lookups go through `paneRoot`-scoped `[data-chat-node]` queries; the one
 * document read is pane 0's #composerModelPillSlot, the clone source.
 *
 * Split view W3-3 (spec W3_SPEC_2026-09-26 §5): the
 * pane's two slots sit in a `.composer-settings-group` (one rail item until
 * the toolbar collapses), and
 *
 *   createComposerSettingsFit({ groupEl, paneRoot, documentRef, getRunMode,
 *       deps }) -> { summary, sync(), recheck(), isCompact(), isOpen(),
 *                    setOpen(open, { restoreFocus }), dispose() } or null
 *
 * gives ANY chat-view composer (pane 0 from the shell bindings, pane 1 here)
 * its toolbar fit (renderer-composer-toolbar-fit.js) and the summary pill
 * placed right after the group: the model pill's visible label, prefixed by
 * the run mode when it is not `ask`. `apply(compact)` writes
 * `data-toolbar-compact` on the `.composer` and `data-composer-compact` on the
 * pane root; the pill toggles `data-settings-open` (Escape and an outside
 * click close it and return focus to the pill). The label follows the model
 * pill and the run-mode chip through one MutationObserver; the fit rechecks
 * only when the summary text or one of the rail's own
 * buttons (Stop, Pause, the Send/Queue label) changed, never per frame.
 *
 * Settings popover polish (spec: owner-approved PO review 2026-09-26, the
 * settings list): the open popover's rows are whole-row clickable and walk
 * with Up/Down/Home/End (Left/Right across the run-mode segments); the pill
 * carries the run mode's icon and a caret. The body-level popovers a row
 * opens (the context/plan details) cover the
 * list through resolveSettingsPopoverAnchor / placePopoverOverAnchor /
 * clearPopoverCover.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererPaneComposerRail = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var NODE = 'data-chat-node';
  var jtFallback = function (key, fallback) { return fallback; };
  var CLONE_CLEARED_ATTRIBUTES = ['id', 'for', 'aria-describedby', 'aria-disabled', 'tabindex'];
  var CLONE_CLEARED_CLASSES = ['composer-control-inert', 'inv-chip--open'];

  function safely(fn) { try { fn(); } catch (_error) { /* best-effort teardown */ } }
  function setAttr(node, name, value) {
    if (!node) return;
    if (value === null) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== value) {
      node.setAttribute(name, value);
    }
  }
  function toggleClass(node, name, on) {
    if (node && node.classList.contains(name) !== on) node.classList.toggle(name, on);
  }
  function clearDataset(node) {
    Object.keys(node.dataset).forEach(function (key) { delete node.dataset[key]; });
  }

  /* Pane 0's slot minus everything that is pane 0's: ids (a clone would
     duplicate them), label `for`s and aria-describedby (they point at pane
     0's ids), lock state, the disabled-reason spans, the rendered picker. */
  function cloneModelPillSlot(sourceSlot) {
    var slot = sourceSlot.cloneNode(true);
    slot.querySelectorAll('#composerModelDisabledReason, #composerEffortDisabledReason, .composer-model-pill-dot')
      .forEach(function (node) { node.remove(); });
    [slot].concat(Array.prototype.slice.call(slot.querySelectorAll('*'))).forEach(function (node) {
      CLONE_CLEARED_ATTRIBUTES.forEach(function (name) { node.removeAttribute(name); });
      CLONE_CLEARED_CLASSES.forEach(function (name) { node.classList.remove(name); });
    });
    slot.querySelectorAll('select').forEach(clearDataset);
    return slot;
  }

  /* ── W3-3: the toolbar fit and the settings summary pill ── */

  var FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  /* Popovers a control inside the group opens (model picker and tools are
     .inv-popover; the context/plan details are body-level
     .composer-popover): a press inside one is not an outside click. */
  var FLOATING_POPOVER = '.inv-popover, .composer-popover';

  function settingsRowLabels(jt) {
    return {
      'composer-run-mode-slot': jt('composer.settingsSummary.rowRunMode', 'Run mode'),
      'composer-model-pill-slot': jt('composer.settingsSummary.rowModel', 'Model'),
      'composer-context-usage-slot': jt('composer.settingsSummary.rowContext', 'Context'),
      'composer-plan-usage-slot': jt('composer.settingsSummary.rowPlanUsage', 'Plan usage'),
    };
  }

  /* Row anatomy of the open popover (collapsed composer settings polish,
     2026-09-26). A row's primary control: the slot itself when it is a
     button element, else its first enabled chip or button outside any
     popover. The run-mode row's focus target is its pressed segment (first
     enabled segment, else the cycling chip when no segments render). */
  var ROW_CONTROL = '[data-inv-chip]:not([disabled]), button:not([disabled])';
  var SUMMARY_CARET_SVG = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>';

  function rowPrimaryControl(slot) {
    if (slot.tagName === 'BUTTON') return slot.disabled ? null : slot;
    return Array.prototype.find.call(slot.querySelectorAll(ROW_CONTROL), function (node) {
      return !node.closest('[hidden], .inv-popover');
    }) || null;
  }
  function rowFocusTarget(slot) {
    if (!slot.classList.contains('composer-run-mode-slot')) return rowPrimaryControl(slot);
    var segments = Array.prototype.filter.call(slot.querySelectorAll('.composer-run-mode-segment'), function (node) { return !node.disabled; });
    if (slot.querySelector('.composer-run-mode-segment')) {
      return segments.find(function (node) { return node.getAttribute('aria-pressed') === 'true'; }) || segments[0] || null;
    }
    return rowPrimaryControl(slot);
  }

  /* Sub-menus replace in place: a body-level popover opened from a row of an
     open compact settings group covers that group. `resolveSettingsPopoverAnchor`
     names the group (or null); `placePopoverOverAnchor` puts the popover's
     bottom-end corner on the group's, at least the group's size, clamped to
     the viewport, in the popover's offsetParent coordinates (null for a
     body-level fixed popover, so viewport coordinates);
     `clearPopoverCover` undoes the size floor on the next ordinary placement. */
  function resolveSettingsPopoverAnchor(trigger) {
    if (!trigger || typeof trigger.closest !== 'function') return null;
    return trigger.closest('.composer[data-toolbar-compact][data-settings-open] .composer-settings-group') || null;
  }
  function placePopoverOverAnchor(popover, anchorEl, options) {
    var margin = options && Number.isFinite(options.margin) ? options.margin : 16;
    if (!popover || !anchorEl || typeof anchorEl.getBoundingClientRect !== 'function'
        || typeof popover.getBoundingClientRect !== 'function') return null;
    var view = (popover.ownerDocument && popover.ownerDocument.defaultView) || root;
    var anchor = anchorEl.getBoundingClientRect();
    // Never below the popover's own stylesheet floor (a style read, not layout).
    clearPopoverCover(popover);
    var own = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(popover) : {};
    var px = function (value) { return /px$/.test(String(value || '')) ? parseFloat(value) || 0 : 0; };
    popover.style.minWidth = Math.round(Math.max(anchor.width, px(own.minWidth))) + 'px';
    popover.style.minHeight = Math.round(Math.max(anchor.height, px(own.minHeight))) + 'px';
    popover.dataset.settingsCover = '1';
    var rect = popover.getBoundingClientRect();
    var width = Math.max(Number(rect.width) || 0, anchor.width);
    var height = Math.max(Number(rect.height) || 0, anchor.height);
    var viewportWidth = Number(view.innerWidth) || 0;
    var viewportHeight = Number(view.innerHeight) || 0;
    var rtl = typeof view.getComputedStyle === 'function' && view.getComputedStyle(anchorEl).direction === 'rtl';
    var left = rtl ? anchor.left : anchor.right - width;
    var top = anchor.bottom - height;
    if (viewportWidth) left = Math.min(Math.max(left, margin), Math.max(viewportWidth - margin - width, margin));
    if (viewportHeight) top = Math.min(Math.max(top, margin), Math.max(viewportHeight - margin - height, margin));
    var parentRect = (popover.offsetParent && popover.offsetParent.getBoundingClientRect && popover.offsetParent.getBoundingClientRect()) || { left: 0, top: 0 };
    popover.style.left = Math.round(left - (Number(parentRect.left) || 0)) + 'px';
    popover.style.top = Math.round(top - (Number(parentRect.top) || 0)) + 'px';
    return {
      left: left,
      top: top,
      maxHeight: viewportHeight ? Math.max(viewportHeight - margin * 2, 0) : 0,
    };
  }
  function clearPopoverCover(popover) {
    if (!popover || !popover.dataset || popover.dataset.settingsCover !== '1') return;
    popover.style.minWidth = '';
    popover.style.minHeight = '';
    delete popover.dataset.settingsCover;
  }

  /* One layout read per call. `available` is the toolbar's clientWidth.
     `needed` (expanded only) is the one-line width of the toolbar's content:
     per half, the sum of its in-flow items' offsetWidths plus the half's
     column gap between them, plus the toolbar's own gap between the halves.
     A flex item keeps its own width whether or not its line wraps, so the sum
     is the unwrapped width even while the rail is wrapping: nothing is
     toggled (no temporary nowrap) and nothing is written between the reads,
     so the first offsetWidth flushes layout at most once and every later read
     hits that same fresh layout. getComputedStyle reads style, not layout.
     The settings group is walked through, plus its end margin (the break
     before Stop/Send); display: none children (an empty slot) and absolutely
     positioned children (sr-only spans) take no line space and are skipped. */
  function measureComposerToolbar(toolbarEl, options) {
    var o = options || {};
    var view = toolbarEl && toolbarEl.ownerDocument && toolbarEl.ownerDocument.defaultView;
    if (!toolbarEl || !view || typeof view.getComputedStyle !== 'function') return { available: 0, needed: 0 };
    var available = Number(toolbarEl.clientWidth) || 0;
    if (o.skipNeeded === true || available <= 0) return { available: available, needed: 0 };
    var gapOf = function (element) {
      var gap = parseFloat(view.getComputedStyle(element).columnGap);
      return Number.isFinite(gap) ? gap : 0;
    };
    function lineWidth(container) {
      var total = 0;
      var count = 0;
      (function walk(parent) {
        for (var child = parent.firstElementChild; child; child = child.nextElementSibling) {
          var style = view.getComputedStyle(child);
          if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') continue;
          if (style.display === 'contents' || child.classList.contains('composer-settings-group')) {
            var before = count;
            walk(child);
            // The break between the group and the primary controls is the group's own margin.
            if (count > before) total += parseFloat(style.marginInlineEnd) || 0;
            continue;
          }
          var width = Number(child.offsetWidth) || 0;
          if (width <= 0) continue;
          total += width;
          count += 1;
        }
      })(container);
      return count > 0 ? total + gapOf(container) * (count - 1) : 0;
    }
    var halves = Array.prototype.filter.call(toolbarEl.children, function (child) {
      return child.classList.contains('composer-toolbar-left') || child.classList.contains('composer-toolbar-right');
    });
    var widths = halves.map(lineWidth).filter(function (width) { return width > 0; });
    var needed = widths.reduce(function (sum, width) { return sum + width; }, 0);
    if (widths.length > 1) needed += gapOf(toolbarEl) * (widths.length - 1);
    return { available: available, needed: needed };
  }

  function chipRunMode(groupEl) {
    var chip = groupEl.querySelector('[data-inv-chip="composer-run-mode"]');
    if (!chip) return 'ask';
    if (chip.classList.contains('composer-run-mode-plan')) return 'plan';
    return chip.classList.contains('composer-run-mode-auto') ? 'auto' : 'ask';
  }

  function createComposerSettingsFit(options) {
    var o = options || {};
    var groupEl = o.groupEl || null;
    var doc = o.documentRef || (groupEl && groupEl.ownerDocument) || null;
    var view = doc && doc.defaultView;
    var deps = o.deps || {};
    var fitModule = deps.toolbarFit || root.rendererComposerToolbarFit;
    var chipModule = deps.chip || (root.inventory && root.inventory.chip);
    var composerEl = groupEl && groupEl.closest('.composer');
    var toolbarEl = groupEl && groupEl.closest('.composer-toolbar');
    if (!groupEl || !doc || !view || !composerEl || !toolbarEl || typeof chipModule !== 'function'
        || !fitModule || typeof fitModule.createToolbarFit !== 'function') {
      return null;
    }
    var paneRoot = o.paneRoot || composerEl.closest('.chat-pane');
    var jt = typeof deps.jt === 'function' ? deps.jt
      : (root.jennyI18n && typeof root.jennyI18n.t === 'function' ? root.jennyI18n.t : jtFallback);
    var getRunMode = typeof o.getRunMode === 'function' ? o.getRunMode : function () { return chipRunMode(groupEl); };
    var MutationObserverCtor = deps.MutationObserverCtor !== undefined ? deps.MutationObserverCtor : view.MutationObserver;
    var tooltip = deps.tooltip || root.inventoryTooltip || null;

    var rowLabels = settingsRowLabels(jt);
    var labelled = [];
    Array.prototype.forEach.call(groupEl.children, function (slot) {
      var key = Object.keys(rowLabels).find(function (name) { return slot.classList.contains(name); });
      if (!key) return;
      slot.setAttribute('data-settings-label', rowLabels[key]);
      labelled.push(slot);
    });
    groupEl.insertAdjacentHTML('afterend', chipModule({
      id: 'composer-settings-summary',
      label: jt('composer.settingsSummary.label', 'Settings'),
      hasPopup: true,
      ariaControls: groupEl.id || '',
      className: 'composer-settings-summary',
    }));
    var summary = groupEl.nextElementSibling;
    var labelEl = summary.querySelector('.inv-chip-label');
    // The caret stays the pill's last child (CSS flips it while open); the
    // mode icon, when there is one, sits right before the label so both stay
    // visible when the label ellipsizes to nothing.
    var caretEl = doc.createElement('span');
    caretEl.className = 'composer-settings-summary-caret';
    caretEl.setAttribute('aria-hidden', 'true');
    caretEl.innerHTML = SUMMARY_CARET_SVG;
    summary.appendChild(caretEl);
    var modeIconEl = null;

    var compact = false;
    var open = false;
    var disposed = false;
    var summaryKey = null;

    function setFlag(node, name, on) { if (node && node.hasAttribute(name) !== on) node.toggleAttribute(name, on); }
    function focusFirstControl() {
      var target = Array.prototype.find.call(groupEl.querySelectorAll(FOCUSABLE), function (node) { return !node.closest('[hidden]'); });
      if (target) target.focus();
    }
    /* The open popover's rows: labelled slots still in the group that show
       something (an empty slot hides) and have
       a focus target. Read only on open and on a row key. */
    function settingsRows() {
      return labelled.filter(function (slot) {
        if (slot.parentNode !== groupEl || slot.hidden || (slot.tagName !== 'BUTTON' && !slot.firstElementChild)) return false;
        if (view.getComputedStyle(slot).display === 'none') return false;
        return Boolean(rowFocusTarget(slot));
      });
    }
    function focusFirstRow() {
      var first = settingsRows()[0];
      var target = first && rowFocusTarget(first);
      if (target) target.focus();
      else focusFirstControl();
    }
    function innerPopoverOpen() {
      // A popover opened from inside the group owns the keyboard (and Escape) first.
      // A body-level popover covering the list (context/plan details) carries data-settings-cover.
      return Boolean(groupEl.querySelector('.inv-popover:not([hidden])')
        || doc.querySelector('.composer-popover:not(.hidden):not([hidden])')
        || doc.querySelector('[data-settings-cover="1"]:not(.hidden):not([hidden])'));
    }
    function onRowKey(event) {
      var active = doc.activeElement;
      if (!active || !groupEl.contains(active) || active.matches('input, select, textarea')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // Left/Right move between the run-mode segments; focus only, no activation.
        var bar = active.classList.contains('composer-run-mode-segment') ? active.parentNode : null;
        if (!bar) return;
        var segments = Array.prototype.filter.call(bar.querySelectorAll('.composer-run-mode-segment'), function (node) { return !node.disabled; });
        var at = segments.indexOf(active);
        if (at < 0 || segments.length < 2) return;
        event.preventDefault();
        segments[(at + (event.key === 'ArrowRight' ? 1 : -1) + segments.length) % segments.length].focus();
        return;
      }
      var rows = settingsRows();
      if (!rows.length) return;
      var current = rows.findIndex(function (slot) { return slot.contains(active); });
      var last = rows.length - 1;
      var index = event.key === 'Home' ? 0
        : event.key === 'End' ? last
          : event.key === 'ArrowDown' ? (current < 0 || current === last ? 0 : current + 1)
            : (current <= 0 ? last : current - 1);
      event.preventDefault();
      var target = rowFocusTarget(rows[index]);
      if (target) target.focus();
    }
    var ROW_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight'];
    function visibleControls() {
      return Array.prototype.filter.call(groupEl.querySelectorAll(FOCUSABLE), function (node) {
        return !node.closest('[hidden], .hidden') && node.getAttribute('aria-disabled') !== 'true'
          && view.getComputedStyle(node).display !== 'none' && view.getComputedStyle(node).visibility !== 'hidden';
      });
    }
    function onFocusOut(event) {
      var next = event.relatedTarget;
      // No target is a press on a row's label or padding (outside presses close through
      // onPointerDown); a row's own floating popover still belongs to the list.
      if (!next || groupEl.contains(next) || summary.contains(next) || next.closest(FLOATING_POPOVER)) return;
      setOpen(false);
    }
    function onKeydown(event) {
      if (event.defaultPrevented) return;
      if (event.key === 'Tab' && !innerPopoverOpen()) {
        var items = visibleControls();
        var target = event.shiftKey && doc.activeElement === items[0] ? items[items.length - 1]
          : !event.shiftKey && doc.activeElement === items[items.length - 1] ? items[0] : null;
        if (target) { event.preventDefault(); target.focus(); }
        return;
      }
      if (event.key !== 'Escape') {
        if (ROW_KEYS.indexOf(event.key) >= 0 && !innerPopoverOpen()) onRowKey(event);
        return;
      }
      if (innerPopoverOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false, { restoreFocus: true });
    }
    /* A press on a row's label or padding (the slot itself is the target)
       clicks the row's primary control. The run-mode row has no single
       control. */
    function onGroupClick(event) {
      var slot = event.target;
      if (!slot || slot.parentNode !== groupEl || !slot.hasAttribute('data-settings-label')
          || slot.classList.contains('composer-run-mode-slot')) return;
      var control = rowPrimaryControl(slot);
      if (!control || control === slot) return;
      control.click();
      // The press is spent: bubbling on, the popover module's document click-away would close what it just opened.
      event.stopPropagation();
    }
    function onPointerDown(event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (groupEl.contains(target) || summary.contains(target) || target.closest(FLOATING_POPOVER)) return;
      var focusInside = groupEl.contains(doc.activeElement);
      setOpen(false);
      // Gate D12: the mousedown moves focus after this capture listener; return it to the pill only if it focused nothing.
      if (focusInside) (doc.defaultView || root).setTimeout(function () { if (!doc.activeElement || doc.activeElement === doc.body) summary.focus(); }, 0);
    }
    function getSettingsHost() {
      return toolbarEl.closest('.ide-chat-dock-body') || toolbarEl.closest('.chat-pane, #chatView');
    }
    function capOpenSettings(maxInline) {
      var host = getSettingsHost();
      // Floor of two rows: a taller floor than the host has room for would put
      // the first rows above a clipping dock body.
      var maxBlock = host ? Math.max(64, toolbarEl.getBoundingClientRect().top - host.getBoundingClientRect().top - 12) : 120;
      if (maxInline > 0) groupEl.style.setProperty('--settings-max-inline', maxInline + 'px');
      groupEl.style.setProperty('--settings-max-block', maxBlock + 'px');
    }
    // A height-only host resize moves the toolbar without resizing it, so the
    // toolbar's own observer stays quiet: while the list is open, the host is
    // observed too.
    var hostObserver = null;
    function watchHost(on) {
      if (hostObserver) { hostObserver.disconnect(); hostObserver = null; }
      var Ctor = deps.ResizeObserverCtor !== undefined ? deps.ResizeObserverCtor : view.ResizeObserver;
      var host = on ? getSettingsHost() : null;
      if (!host || typeof Ctor !== 'function') return;
      hostObserver = new Ctor(function onHostResize() { if (open) capOpenSettings(Number(toolbarEl.clientWidth) || 0); });
      hostObserver.observe(host);
    }
    function setOpen(next, opts) {
      var wanted = next === true && compact && !disposed;
      if (wanted === open) return;
      open = wanted;
      setFlag(composerEl, 'data-settings-open', open);
      // Gate N2: no tooltip over the open list (a row's focus or the pill's hover).
      setFlag(groupEl, 'data-tooltip-suppressed', open);
      setFlag(summary, 'data-tooltip-suppressed', open);
      if (open && tooltip && typeof tooltip.hide === 'function') tooltip.hide();
      if (typeof chipModule.setExpanded === 'function') chipModule.setExpanded(summary, open);
      if (open) {
        groupEl.setAttribute('role', 'dialog');
        groupEl.setAttribute('aria-label', jt('composer.settings.dialogLabel', 'Composer settings'));
        // Bound the list to its current host, including a short stacked dock.
        capOpenSettings(Number(toolbarEl.clientWidth) || 0);
        watchHost(true);
        doc.addEventListener('keydown', onKeydown, true);
        doc.addEventListener('mousedown', onPointerDown, true);
        groupEl.addEventListener('click', onGroupClick);
        groupEl.addEventListener('focusout', onFocusOut);
        summary.addEventListener('focusout', onFocusOut);
        focusFirstRow();
        return;
      }
      groupEl.removeAttribute('role');
      groupEl.removeAttribute('aria-label');
      groupEl.style.removeProperty('--settings-max-inline');
      groupEl.style.removeProperty('--settings-max-block');
      watchHost(false);
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('mousedown', onPointerDown, true);
      groupEl.removeEventListener('click', onGroupClick);
      groupEl.removeEventListener('focusout', onFocusOut);
      summary.removeEventListener('focusout', onFocusOut);
      if (opts && opts.restoreFocus === true) summary.focus();
    }
    function onSummaryClick() { setOpen(!open, { restoreFocus: open }); }
    summary.addEventListener('click', onSummaryClick);
    var lastSessionId = '';
    function onComposerRendered(event) {
      var sessionId = String(event.detail && event.detail.sessionId || '');
      if (sessionId === lastSessionId) return;
      lastSessionId = sessionId;
      setOpen(false);
    }
    composerEl.addEventListener('composer-state-rendered', onComposerRendered);

    function apply(next) {
      compact = next === true;
      var active = doc.activeElement;
      setFlag(composerEl, 'data-toolbar-compact', compact);
      setFlag(paneRoot, 'data-composer-compact', compact);
      if (compact) {
        // The group leaves the line: a control that had focus hands it to the pill.
        if (active && groupEl.contains(active)) summary.focus();
        return;
      }
      setOpen(false);
      if (active === summary) focusFirstControl();
      else if (active && active.classList && active.classList.contains('composer-run-mode-segment')) {
        // The segments exist only in the open list: the toolbar's cycling chip takes the focus.
        var modeSlot = active.closest('.composer-run-mode-slot');
        var modeChip = modeSlot && modeSlot.querySelector('[data-inv-chip="composer-run-mode"]');
        if (modeChip) modeChip.focus();
      }
    }

    var fit = fitModule.createToolbarFit({
      target: toolbarEl,
      measure: typeof deps.measure === 'function' ? deps.measure : function () {
        var reading = measureComposerToolbar(toolbarEl, { skipNeeded: compact });
        // A resize while the list is open re-caps both host bounds.
        if (open && reading.available > 0) capOpenSettings(reading.available);
        return reading;
      },
      apply: apply,
      requestFrame: deps.requestFrame || (view.requestAnimationFrame && view.requestAnimationFrame.bind(view)),
      cancelFrame: deps.cancelFrame || (view.cancelAnimationFrame && view.cancelAnimationFrame.bind(view)),
      ResizeObserverCtor: deps.ResizeObserverCtor !== undefined ? deps.ResizeObserverCtor : view.ResizeObserver,
      getHost: deps.getHost,
    });

    /* The summary text: the model pill's visible label, run mode first when it
       is not `ask`. Rewritten, and the fit rechecked, only when it changed. */
    function sync() {
      if (disposed) return false;
      var pillLabel = groupEl.querySelector('[data-inv-chip="composer-model"] .inv-chip-label');
      var modelText = pillLabel ? String(pillLabel.textContent || '').trim() : '';
      var mode = String(getRunMode() || 'ask');
      var modeText = mode === 'plan' ? jt('composer.runMode.plan', 'Plan') : mode === 'auto' ? jt('composer.runMode.auto', 'Auto') : '';
      // The mode icon is the run-mode chip's own svg (keyed by its markup, so
      // a chip that re-renders after the projection still updates the clone).
      var iconSource = modeText ? groupEl.querySelector('[data-inv-chip="composer-run-mode"] .inv-chip-icon svg') : null;
      var key = modeText + '\u0000' + modelText + '\u0000' + (iconSource ? iconSource.outerHTML : '');
      if (key === summaryKey) return false;
      summaryKey = key;
      if (iconSource) {
        if (!modeIconEl) {
          modeIconEl = doc.createElement('span');
          modeIconEl.className = 'composer-settings-summary-mode-icon';
          modeIconEl.setAttribute('aria-hidden', 'true');
        }
        modeIconEl.replaceChildren(iconSource.cloneNode(true));
        if (modeIconEl.nextSibling !== labelEl) summary.insertBefore(modeIconEl, labelEl);
      } else if (modeIconEl) {
        modeIconEl.remove();
      }
      labelEl.replaceChildren();
      if (modeText) {
        var tag = doc.createElement('span');
        tag.className = 'composer-settings-summary-mode';
        tag.textContent = modeText + ' ·';
        labelEl.append(tag, ' ');
      }
      labelEl.append(modelText || jt('composer.settingsSummary.label', 'Settings'));
      var text = String(labelEl.textContent || '').trim();
      var name = jt('composer.settingsSummary.ariaLabel', 'Composer settings: {summary}', { summary: text }).replace('{summary}', function () { return text; });
      summary.setAttribute('aria-label', name);
      summary.setAttribute('title', name);
      fit.recheck();
      return true;
    }

    var observer = null;
    if (typeof MutationObserverCtor === 'function') {
      var railEl = groupEl.parentNode;
      /* Gate F3: Stop, Pause and the queue label come and go with a reply;
         they move the one-line width without resizing the toolbar. Only the
         rail's own buttons count (a record inside the group or the pill does not). */
      var railButtonChanged = function (record) {
        if (record.target === railEl) return record.type === 'childList';
        var node = record.target.nodeType === 1 ? record.target : record.target.parentNode;
        return Boolean(node && node.parentNode === railEl && node !== groupEl && node !== summary);
      };
      observer = new MutationObserverCtor(function onRailMutation(records) {
        if (!sync() && records.some(railButtonChanged)) fit.recheck();
      });
      [groupEl.querySelector('.composer-model-pill-slot'), groupEl.querySelector('.composer-run-mode-slot'), railEl]
        .forEach(function (node) {
          if (node) observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
        });
    }
    sync();

    function dispose() {
      if (disposed) return;
      setOpen(false);
      disposed = true;
      fit.dispose();
      if (observer) observer.disconnect();
      observer = null;
      summary.removeEventListener('click', onSummaryClick);
      composerEl.removeEventListener('composer-state-rendered', onComposerRendered);
      summary.remove();
      setFlag(composerEl, 'data-toolbar-compact', false);
      setFlag(paneRoot, 'data-composer-compact', false);
      labelled.forEach(function (slot) { slot.removeAttribute('data-settings-label'); });
    }

    return {
      summary: summary,
      sync: sync,
      recheck: function () { if (!disposed) fit.recheck(); },
      isCompact: function () { return compact; },
      isOpen: function () { return open; },
      setOpen: setOpen,
      dispose: dispose,
    };
  }

  function createPaneComposerRail(options) {
    var o = options || {};
    var state = o.state;
    var paneRoot = o.paneRoot;
    var railEl = o.railEl;
    var hintHost = o.hintHost || null;
    var sessionContext = o.sessionContext || {};
    var doc = o.documentRef || (paneRoot && paneRoot.ownerDocument) || null;
    var deps = o.deps || {};
    var composerState = deps.composerState || root.rendererComposerV2State;
    var composerRender = deps.composerV2Render || root.rendererComposerV2Render;
    var pickerModule = deps.modelPicker || root.rendererComposerModelPicker;
    var effortControls = deps.reasoningEffortControls || root.reasoningEffortControls;
    var buildModelOptionMarkup = deps.buildModelOptionMarkup
      || (root.rendererLifecycleFormatUtils && root.rendererLifecycleFormatUtils.buildModelOptionMarkup);
    var fromSession = deps.getRuntimePreferencesFromSession;
    var jt = typeof deps.jt === 'function' ? deps.jt
      : (root.jennyI18n && typeof root.jennyI18n.t === 'function' ? root.jennyI18n.t : jtFallback);
    var sourceSlot = deps.sourcePillSlot || (doc && doc.getElementById('composerModelPillSlot'));
    if (!state || !paneRoot || !railEl || !doc || !sourceSlot || typeof sessionContext.getSessionId !== 'function'
        || typeof fromSession !== 'function' || !composerState || !composerRender) {
      return null;
    }
    var paneId = Number.isInteger(sessionContext.paneId) ? sessionContext.paneId : 1;

    /* ── build ── */
    var runModeSlot = doc.createElement('div');
    runModeSlot.className = 'composer-run-mode-slot';
    runModeSlot.setAttribute(NODE, 'composerRunModeSlot');
    var pillSlot = cloneModelPillSlot(sourceSlot);
    pillSlot.setAttribute(NODE, 'composerModelPillSlot');
    // W3-3: the pane's settings slots sit in one group (pane 0's markup shape).
    var group = doc.createElement('div');
    group.className = 'composer-settings-group';
    group.id = 'composerSettingsGroupPane' + paneId;
    group.setAttribute(NODE, 'composerSettingsGroup');
    group.append(runModeSlot, pillSlot);
    railEl.insertBefore(group, railEl.firstChild);
    var chipsRow = doc.createElement('div');
    chipsRow.className = 'composer-mode-chips chat-pane-mode-chips';
    chipsRow.setAttribute(NODE, 'composerModeChips');
    if (hintHost) hintHost.after(chipsRow);
    else railEl.after(chipsRow);

    var node = function (name) { return paneRoot.querySelector('[' + NODE + '="' + name + '"]'); };
    var popoverEl = pillSlot.querySelector('.composer-model-popover');
    var host = popoverEl ? popoverEl.querySelector('[data-composer-model-picker]') : null;
    var selects = pillSlot.querySelectorAll('select');
    var modelSelect = selects[0] || null;
    var effortSelect = selects[1] || null;
    if (host) host.replaceChildren();
    if (modelSelect) {
      modelSelect.replaceChildren();
      modelSelect.setAttribute(NODE, 'composerModelSelect');
    }
    if (effortSelect) effortSelect.setAttribute(NODE, 'composerEffortSelect');
    var popoverId = 'composerModelPopoverPane' + paneId;
    if (popoverEl) {
      popoverEl.hidden = true;
      popoverEl.id = popoverId;
      popoverEl.setAttribute(NODE, 'composerModelPopover');
    }
    var pill = pillSlot.querySelector('[data-inv-chip="composer-model"]');
    if (!pill && root.inventory && typeof root.inventory.chip === 'function') {
      pillSlot.insertAdjacentHTML('afterbegin', root.inventory.chip({
        id: 'composer-model',
        label: jt('app.shell.model', 'Model'),
        hasPopup: true,
        ariaLabel: jt('app.shell.modelAndReasoningEffort', 'Model and reasoning effort'),
        title: jt('app.shell.modelAndReasoningEffort', 'Model and reasoning effort'),
        className: 'composer-model-pill',
      }));
      pill = pillSlot.querySelector('[data-inv-chip="composer-model"]');
    }
    if (pill) {
      pill.setAttribute(NODE, 'composerModelPill');
      pill.setAttribute('aria-controls', popoverId);
      pill.setAttribute('aria-expanded', 'false');
    }

    function paneSession() {
      var id = String(sessionContext.getSessionId() || '').trim();
      return id ? (Array.isArray(state.sessions) ? state.sessions : []).find(function (entry) { return entry && entry.id === id; }) || null : null;
    }
    function paneProjection(prefs) {
      return composerState.projectRunMode(prefs.runMode, { planModeFallback: prefs.planMode === true });
    }

    var picker = null;
    if (pickerModule && typeof pickerModule.createComposerModelPicker === 'function' && popoverEl && modelSelect && effortSelect) {
      picker = pickerModule.createComposerModelPicker({
        state: state,
        documentRef: doc,
        idSuffix: 'Pane' + paneId,
        dom: { popover: popoverEl, host: host, modelSelect: modelSelect, effortSelect: effortSelect, pill: pill },
      });
      picker.bind();
    }
    var detachCarriers = effortControls && typeof effortControls.attachCarriers === 'function'
      ? effortControls.attachCarriers({ modelSelect: modelSelect, effortSelect: effortSelect, pillSlot: pillSlot })
      : null;
    var lastRunMode = paneProjection(fromSession(paneSession())).runMode;
    var switcher = composerRender.createRunModeSwitcherRenderer({
      slot: runModeSlot,
      domId: '',
      getRunMode: function () { return paneProjection(fromSession(paneSession())).runMode; },
    });
    var settings = createComposerSettingsFit({
      groupEl: group,
      paneRoot: paneRoot,
      documentRef: doc,
      getRunMode: function () { return paneProjection(fromSession(paneSession())).runMode; },
      deps: Object.assign({ jt: jt }, deps.settingsFit || {}),
    });

    /* ── sync ── */
    var optionsSignature = '';
    var disposed = false;
    function syncModelOptions(preferred) {
      if (!modelSelect || typeof buildModelOptionMarkup !== 'function') return;
      var models = Array.isArray(state.modelList && state.modelList.data) ? state.modelList.data : [];
      var status = state.status || {};
      var backendModel = String(status.model || (state.modelList && state.modelList.active_model) || '').trim();
      var backendEngine = String(status.engine || status.engine_type || (state.modelList && state.modelList.engine_type) || '')
        .trim().toLowerCase();
      var signature = JSON.stringify([
        models.map(function (model) {
          return [model && model.id, model && (model.engine_type || model.engineType), model && model.available, model && model.reason];
        }),
        preferred, backendModel, backendEngine,
      ]);
      if (signature === optionsSignature) return;
      optionsSignature = signature;
      // As renderSettings does for pane 0: "Use default" runs on the backend
      // model, stamped before the rebuild so its reconcile sees the pair.
      modelSelect.dataset.backendModel = backendModel;
      modelSelect.dataset.backendEngineType = backendEngine;
      modelSelect.innerHTML = buildModelOptionMarkup(models, preferred, { compact: true });
    }
    function lockControl(control, locked) {
      if (!control) return;
      if (control.disabled) control.disabled = false;
      toggleClass(control, 'composer-control-inert', locked);
      toggleClass(control.closest('.composer-select-shell'), 'composer-control-inert', locked);
      setAttr(control, 'aria-disabled', locked ? 'true' : null);
      setAttr(control, 'tabindex', locked ? '-1' : null);
    }
    // W3-1: a save is keyed by its session (activity-utils sessionScope), so only this pane shimmers: gate §D,
    // the control's select shell gets pane 0's activity attributes (written only while a save is in view).
    function isBusy(control, scope) {
      if (!scope || typeof deps.isActivityBusy !== 'function' || typeof deps.getActivitySnapshot !== 'function') return false;
      var utils = root.activityUtils || (typeof require === 'function' ? require('../shared/activity-utils') : null);
      var snapshot = deps.getActivitySnapshot(utils && utils.sessionScope ? utils.sessionScope(scope, sessionContext.getSessionId()) : scope);
      if (control && typeof deps.applyActivityAttributes === 'function') deps.applyActivityAttributes(control.closest('.composer-select-shell'), snapshot, { setAriaBusy: true });
      return deps.isActivityBusy(snapshot) === true;
    }

    /* flags: { offline, authenticated }: the composition's reads that lock the pane's input. */
    function sync(flags) {
      if (disposed) return;
      var f = flags || {};
      var session = paneSession();
      var prefs = fromSession(session);
      var scopes = deps.ACTIVITY_SCOPE || {};
      var authenticated = f.authenticated !== undefined ? f.authenticated !== false : !(state.auth && state.auth.authenticated === false);
      var offline = f.offline === true;
      var pluginReadOnly = Boolean(session && session.session_type === 'plugin');
      var preferred = String(prefs.preferredModel || '');
      syncModelOptions(preferred);
      if (modelSelect && modelSelect.value !== preferred) modelSelect.value = preferred;
      if (effortSelect) {
        var effort = String(prefs.reasoningEffort || '');
        if (effortSelect.dataset.requestedEffort !== effort) effortSelect.dataset.requestedEffort = effort;
        if (effortSelect.value !== effort) effortSelect.value = effort;
        // No matching option (a model without that effort): let the effort
        // control normalize it now, once per effort/model pair (as pane 0).
        var reconcileKey = effort + '\u0000' + (modelSelect ? modelSelect.value : '');
        if (effortSelect.value === '' && effortSelect.dataset.reconciledFor !== reconcileKey) {
          effortSelect.dataset.reconciledFor = reconcileKey;
          if (effortControls && typeof effortControls.reconcile === 'function') effortControls.reconcile();
        }
        var unsupported = effortSelect.dataset.reasoningSupported === 'false';
        var effortShell = effortSelect.closest('.composer-select-shell');
        if (effortShell && effortShell.hidden !== unsupported) effortShell.hidden = unsupported;
        lockControl(effortSelect, isBusy(effortSelect, scopes.composerReasoningEffort) || pluginReadOnly || !authenticated || offline || unsupported);
      }
      lockControl(modelSelect, isBusy(modelSelect, scopes.composerPreferredModel) || pluginReadOnly || !authenticated || offline);
      if (picker) picker.renderIfOpen();
      var projection = paneProjection(prefs);
      if (projection.runMode !== lastRunMode) {
        lastRunMode = projection.runMode;
        switcher.sync();
      }
      var chip = runModeSlot.querySelector('[data-inv-chip="composer-run-mode"]');
      if (chip && chip.disabled !== pluginReadOnly) {
        chip.disabled = pluginReadOnly;
        toggleClass(chip, 'inv-chip--disabled', pluginReadOnly);
      }
      // The popover's Ask / Auto / Plan segments lock with the chip (a plugin session is read-only).
      if (typeof composerRender.syncRunModeSegmentsDisabled === 'function') composerRender.syncRunModeSegmentsDisabled(runModeSlot, pluginReadOnly);
      toggleClass(hintHost, 'composer-plan-active', projection.planMode === true);
      if (settings) settings.sync(); // W3-3: the summary label; rechecks the fit only on a change
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof detachCarriers === 'function') safely(detachCarriers);
      if (picker) safely(function () { picker.dispose(); });
      if (settings) safely(function () { settings.dispose(); });
      safely(function () { switcher.destroy(); });
      safely(function () { runModeSlot.remove(); });
      safely(function () { pillSlot.remove(); });
      safely(function () { group.remove(); });
      safely(function () { chipsRow.remove(); });
      if (hintHost) safely(function () { hintHost.classList.remove('composer-plan-active'); });
      picker = null;
      settings = null;
    }

    return {
      dom: {
        composerSettingsGroup: node('composerSettingsGroup'),
        composerRunModeSlot: node('composerRunModeSlot'),
        composerModelPillSlot: node('composerModelPillSlot'),
        composerModelPopover: node('composerModelPopover'),
        composerModelSelect: node('composerModelSelect'),
        composerEffortSelect: node('composerEffortSelect'),
        composerModelPill: node('composerModelPill'),
      },
      getPicker: function () { return picker; },
      getSettingsFit: function () { return settings; },
      sync: sync,
      dispose: dispose,
    };
  }

  return {
    createPaneComposerRail: createPaneComposerRail,
    createComposerSettingsFit: createComposerSettingsFit,
    measureComposerToolbar: measureComposerToolbar,
    resolveSettingsPopoverAnchor: resolveSettingsPopoverAnchor,
    placePopoverOverAnchor: placePopoverOverAnchor,
    clearPopoverCover: clearPopoverCover,
  };
});
