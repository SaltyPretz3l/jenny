/**
 * renderer/inventory/segmented-control.js
 *
 * Accessible segmented control primitive (UMD). A closed-enum picker
 * rendered as role="radiogroup" with role="radio" options and roving
 * tabindex keyboard navigation (ArrowLeft/ArrowRight/Home/End).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventorySegmentedControl = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Closed-enum size guard: a segmented control only reads well with a small,
  // fixed option set. Below MIN or above MAX we render an empty string rather
  // than a degenerate (single-option) or overcrowded (5+) control — callers
  // get an obvious "nothing rendered" signal instead of a silently-clamped
  // list that would hide missing/extra options upstream.
  var MIN_OPTIONS = 2;
  var MAX_OPTIONS = 4;

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function sanitizeToken(value, fallback) {
    var normalized = String(value || '').trim();
    return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : fallback;
  }

  function sanitizeClassName(value) {
    return String(value || '')
      .trim()
      .split(/\s+/)
      .filter(function (token) {
        return /^[A-Za-z0-9_-]+$/.test(token);
      })
      .join(' ');
  }

  /**
   * Render a segmented control.
   * @param {Object} opts
   * @param {string} [opts.id] - Emitted as data-inv-segmented="<id>" (sanitized token)
   * @param {string} [opts.ariaLabel] - Accessible radiogroup label
   * @param {string} [opts.value] - Currently selected option value
   * @param {Array<{value:string,label:string,disabled?:boolean,tooltip?:string}>} opts.options - 2..4 options
   * @param {boolean} [opts.disabled] - Disables the whole group
   * @param {string} [opts.className] - Extra class names
   * @param {Object<string,string>} [opts.dataset] - Extra data-* attrs (key must match /^[a-z][a-z0-9-]*$/)
   * @returns {string} HTML string (empty string when options.length is out of [2,4])
   */
  function segmentedControl(opts) {
    var o = opts || {};
    var options = Array.isArray(o.options) ? o.options : [];
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return '';

    var id = sanitizeToken(o.id, '');
    var disabled = Boolean(o.disabled);
    var current = String(o.value == null ? '' : o.value);
    var cls = 'inv-segmented';
    if (disabled) cls += ' inv-segmented--disabled';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;

    var dataset = '';
    if (o.dataset && typeof o.dataset === 'object') {
      var keys = Object.keys(o.dataset);
      for (var i = 0; i < keys.length; i += 1) {
        var rawKey = keys[i];
        if (!/^[a-z][a-z0-9-]*$/.test(rawKey)) continue;
        dataset += ' data-' + rawKey + '="' + escapeHtml(o.dataset[rawKey]) + '"';
      }
    }

    // Selection (aria-checked/--on) tracks the value match only; the roving
    // tab stop is a separate concern — it sits on the selected option unless
    // that option is disabled/absent (a disabled button is unfocusable), in
    // which case the first enabled option takes it so the group stays
    // reachable via Tab without faking a selection the caller never made.
    var selectedIndex = -1;
    for (var s = 0; s < options.length; s += 1) {
      if (String(options[s] && options[s].value) === current) {
        selectedIndex = s;
        break;
      }
    }
    var tabStopIndex = selectedIndex;
    if (tabStopIndex === -1 || (options[tabStopIndex] && options[tabStopIndex].disabled)) {
      tabStopIndex = -1;
      for (var f = 0; f < options.length; f += 1) {
        if (!(options[f] && options[f].disabled)) {
          tabStopIndex = f;
          break;
        }
      }
    }

    var rendered = '';
    for (var j = 0; j < options.length; j += 1) {
      var opt = options[j] || {};
      var optValue = String(opt.value == null ? '' : opt.value);
      var optLabel = String(opt.label == null ? optValue : opt.label);
      var optTooltip = typeof opt.tooltip === 'string' ? opt.tooltip : null;
      var optDisabled = Boolean(opt.disabled);
      var isSelected = j === selectedIndex;
      var optCls = 'inv-segmented-option';
      if (isSelected) optCls += ' inv-segmented-option--on';
      rendered += '<button'
        + ' type="button"'
        + ' role="radio"'
        + ' class="' + optCls + '"'
        + ' data-value="' + escapeHtml(optValue) + '"'
        + (optTooltip != null ? ' title="' + escapeHtml(optTooltip) + '"' : '')
        + ' aria-checked="' + (isSelected ? 'true' : 'false') + '"'
        + ' tabindex="' + (j === tabStopIndex ? '0' : '-1') + '"'
        + (optDisabled ? ' disabled aria-disabled="true"' : '')
        + '>'
        + '<span class="inv-segmented-option-label">' + escapeHtml(optLabel) + '</span>'
        + '</button>';
    }

    return '<div'
      + ' class="' + cls + '"'
      + ' role="radiogroup"'
      + (o.ariaLabel ? ' aria-label="' + escapeHtml(o.ariaLabel) + '"' : '')
      + (id ? ' data-inv-segmented="' + id + '"' : '')
      + (disabled ? ' aria-disabled="true"' : '')
      + dataset
      + '>'
      + rendered
      + '</div>';
  }

  function getOptionButtons(groupEl) {
    return Array.prototype.slice.call(groupEl.querySelectorAll('.inv-segmented-option'));
  }

  /**
   * Select an option within a rendered group: syncs aria-checked, the roving
   * tabindex, and the --on modifier, then dispatches a bubbling
   * `inv-segmented-change` custom event.
   * @param {HTMLElement} groupEl - The [role="radiogroup"].inv-segmented element
   * @param {string} nextValue
   */
  function select(groupEl, nextValue) {
    if (!groupEl) return;
    var value = String(nextValue == null ? '' : nextValue);
    var buttons = getOptionButtons(groupEl);
    // Resolve the target before mutating: a no-match or disabled-target select
    // must be a strict no-op, never a state where every tab stop was cleared.
    var target = null;
    for (var t = 0; t < buttons.length; t += 1) {
      if (buttons[t].getAttribute('data-value') === value) {
        target = buttons[t];
        break;
      }
    }
    if (!target || target.disabled) return;
    for (var i = 0; i < buttons.length; i += 1) {
      var btn = buttons[i];
      var isMatch = btn === target;
      btn.setAttribute('aria-checked', isMatch ? 'true' : 'false');
      btn.setAttribute('tabindex', isMatch ? '0' : '-1');
      btn.classList.toggle('inv-segmented-option--on', isMatch);
    }
    var view = groupEl.ownerDocument && groupEl.ownerDocument.defaultView || null;
    var EventCtor = view && typeof view.CustomEvent === 'function' ? view.CustomEvent : typeof CustomEvent === 'function' ? CustomEvent : null;
    if (EventCtor) {
      groupEl.dispatchEvent(new EventCtor('inv-segmented-change', {
        bubbles: true,
        detail: { id: groupEl.getAttribute('data-inv-segmented'), value: value },
      }));
    }
  }

  function isGroupDisabled(groupEl) {
    return groupEl.classList.contains('inv-segmented--disabled') || groupEl.getAttribute('aria-disabled') === 'true';
  }

  function nextEnabledIndex(buttons, fromIndex, direction) {
    var count = buttons.length;
    if (count === 0) return -1;
    var index = fromIndex;
    for (var step = 0; step < count; step += 1) {
      index = (index + direction + count) % count;
      if (!buttons[index].disabled) return index;
    }
    return -1;
  }

  /**
   * Install delegated click + keyboard handlers for segmented controls, once
   * per root (guarded like toggle-switch's initToggleHandlers).
   * @param {HTMLElement|Document} rootEl
   */
  function initSegmentedHandlers(rootEl) {
    if (!rootEl || typeof rootEl.addEventListener !== 'function') return;
    if (rootEl.__invSegmentedHandlersInstalled) return;
    rootEl.__invSegmentedHandlersInstalled = true;

    rootEl.addEventListener('click', function (event) {
      var option = event.target.closest('.inv-segmented-option');
      if (!option || option.disabled) return;
      // Match the keyboard path: re-clicking the selected option is a no-op,
      // never a redundant inv-segmented-change.
      if (option.getAttribute('aria-checked') === 'true') return;
      var group = option.closest('.inv-segmented');
      if (!group || isGroupDisabled(group)) return;
      select(group, option.getAttribute('data-value'));
    });

    rootEl.addEventListener('keydown', function (event) {
      if (event.isComposing) return;
      var key = event.key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
      var option = event.target.closest && event.target.closest('.inv-segmented-option');
      if (!option || option.disabled) return;
      var group = option.closest('.inv-segmented');
      if (!group || isGroupDisabled(group)) return;
      var buttons = getOptionButtons(group);
      var currentIndex = buttons.indexOf(option);
      if (currentIndex === -1) return;

      var targetIndex = -1;
      if (key === 'ArrowRight') {
        targetIndex = nextEnabledIndex(buttons, currentIndex, 1);
      } else if (key === 'ArrowLeft') {
        targetIndex = nextEnabledIndex(buttons, currentIndex, -1);
      } else if (key === 'Home') {
        targetIndex = !buttons[0].disabled ? 0 : nextEnabledIndex(buttons, -1, 1);
      } else if (key === 'End') {
        var lastIndex = buttons.length - 1;
        targetIndex = !buttons[lastIndex].disabled ? lastIndex : nextEnabledIndex(buttons, lastIndex, -1);
      }
      if (targetIndex === -1 || targetIndex === currentIndex) return;

      event.preventDefault();
      select(group, buttons[targetIndex].getAttribute('data-value'));
      buttons[targetIndex].focus();
    });
  }

  segmentedControl.select = select;
  segmentedControl.initSegmentedHandlers = initSegmentedHandlers;
  segmentedControl.escapeHtml = escapeHtml;
  segmentedControl.sanitizeToken = sanitizeToken;
  segmentedControl.sanitizeClassName = sanitizeClassName;
  return segmentedControl;
});
