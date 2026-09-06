/**
 * renderer/inventory/step-modal.js
 *
 * Shared modal shell for compact step/status flows.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.inventoryStepModal = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

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

  function getProgressBarRenderer() {
    if (root && typeof root.inventoryProgressBar === 'function') {
      return root.inventoryProgressBar;
    }
    if (typeof require === 'function') {
      try {
        return require('./progress-bar');
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function renderAction(action) {
    var source = action && typeof action === 'object' ? action : {};
    var id = sanitizeToken(source.id, 'action');
    var label = String(source.label || '').trim();
    if (!label) {
      return '';
    }
    var variant = sanitizeToken(source.variant, 'secondary');
    var className = 'inv-step-modal-action inv-step-modal-action--' + variant;
    var extraClassName = sanitizeClassName(source.className);
    if (extraClassName) {
      className += ' ' + extraClassName;
    }
    return '<button'
      + ' type="button"'
      + ' class="' + className + '"'
      + ' data-step-modal-action="' + id + '"'
      + (source.disabled === true ? ' disabled' : '')
      + '>'
      + escapeHtml(label)
      + '</button>';
  }

  function renderProgress(progress) {
    if (!progress || typeof progress !== 'object') {
      return '';
    }
    var value = Number(progress.value);
    var max = Number(progress.max) || 100;
    if (!Number.isFinite(value)) {
      return '';
    }
    var progressBar = getProgressBarRenderer();
    if (!progressBar) {
      return '';
    }
    return '<div class="inv-step-modal-progress">'
      + progressBar({
        value: Math.max(0, Math.min(value, max)),
        max: max,
        label: progress.label || 'Progress',
        displayText: progress.displayText || '',
        className: 'inv-step-modal-progress-bar',
      })
      + '</div>';
  }

  function renderStepModal(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var id = sanitizeToken(opts.id, 'step-modal');
    var tone = sanitizeToken(opts.tone, 'default');
    var actions = Array.isArray(opts.actions) ? opts.actions.map(renderAction).filter(Boolean) : [];
    return '<div class="inv-step-modal-backdrop" data-step-modal="' + id + '">'
      + '<section class="inv-step-modal inv-step-modal--' + tone + '"'
      + ' role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="' + id + '-title"'
      + (opts.summary ? ' aria-describedby="' + id + '-summary"' : '') + '>'
      + '<header class="inv-step-modal-header">'
      + (opts.eyebrow ? '<div class="inv-step-modal-eyebrow">' + escapeHtml(opts.eyebrow) + '</div>' : '')
      + '<div class="inv-step-modal-title-row">'
      + '<h2 class="inv-step-modal-title" id="' + id + '-title">' + escapeHtml(opts.title || '') + '</h2>'
      + (opts.status ? '<span class="inv-step-modal-status">' + escapeHtml(opts.status) + '</span>' : '')
      + '</div>'
      + (opts.summary ? '<p class="inv-step-modal-summary" id="' + id + '-summary">' + escapeHtml(opts.summary) + '</p>' : '')
      + '</header>'
      + renderProgress(opts.progress)
      + '<div class="inv-step-modal-body">' + String(opts.bodyHtml || '') + '</div>'
      + (actions.length ? '<footer class="inv-step-modal-actions">' + actions.join('') + '</footer>' : '')
      + '</section>'
      + '</div>';
  }

  var FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function focusElement(element) {
    if (!element || typeof element.focus !== 'function') return;
    try { element.focus({ preventScroll: true }); }
    catch (_error) { try { element.focus(); } catch (_fallbackError) { /* ignore */ } }
  }

  function createLifecycle(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var documentRef = opts.documentRef || (root && root.document) || null;
    var mountRoot = opts.mountRoot || null;
    var getOverlayManager = typeof opts.getOverlayManager === 'function'
      ? opts.getOverlayManager
      : function getInjectedManager() { return opts.overlayManager || null; };
    var appendClientLog = typeof opts.appendClientLog === 'function'
      ? opts.appendClientLog
      : function noop() {};
    var active = null;
    var disposed = false;
    var generation = 0;
    var fallbackKeydownAttached = false;

    function resolveInertTargets() {
      var targets;
      try {
        targets = typeof opts.inertTargets === 'function' ? opts.inertTargets() : opts.inertTargets;
      } catch (_error) {
        targets = [];
      }
      if (!Array.isArray(targets)) targets = targets ? [targets] : [];
      return targets.filter(function (target, index) {
        return target && typeof target.setAttribute === 'function' && targets.indexOf(target) === index;
      });
    }

    function applyFallbackInert(targets) {
      return targets.map(function (target) {
        var hadAttribute = target.hasAttribute('inert');
        var attributeValue = hadAttribute ? target.getAttribute('inert') : null;
        var hasProperty = 'inert' in target;
        var propertyValue = hasProperty ? Boolean(target.inert) : false;
        if (hasProperty) target.inert = true;
        else target.setAttribute('inert', '');
        return { target: target, hadAttribute: hadAttribute, attributeValue: attributeValue,
          hasProperty: hasProperty, propertyValue: propertyValue };
      });
    }

    function restoreFallbackInert(records) {
      (records || []).forEach(function (record) {
        if (record.hasProperty) record.target.inert = record.propertyValue;
        if (record.hadAttribute) {
          record.target.setAttribute('inert', record.attributeValue == null ? '' : record.attributeValue);
        } else {
          record.target.removeAttribute('inert');
        }
      });
    }

    function getFocusable() {
      if (!mountRoot || typeof mountRoot.querySelectorAll !== 'function') return [];
      return Array.prototype.slice.call(mountRoot.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(function (element) { return element && element.offsetParent !== null; });
    }

    function handleFallbackKeydown(event) {
      if (!active || !event || event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        try { active.onRequestClose('escape'); } catch (_error) { /* owner reports semantic failures */ }
        return;
      }
      if (event.key !== 'Tab') return;
      var focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        focusElement(mountRoot.querySelector('[role="dialog"]'));
        return;
      }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      var focused = documentRef ? documentRef.activeElement : null;
      if (event.shiftKey && (focused === first || !mountRoot.contains(focused))) {
        event.preventDefault();
        focusElement(last);
      } else if (!event.shiftKey && (focused === last || !mountRoot.contains(focused))) {
        event.preventDefault();
        focusElement(first);
      }
    }

    function attachFallbackKeydown() {
      if (fallbackKeydownAttached || !documentRef) return;
      documentRef.addEventListener('keydown', handleFallbackKeydown, true);
      fallbackKeydownAttached = true;
    }

    function detachFallbackKeydown() {
      if (!fallbackKeydownAttached || !documentRef) return;
      documentRef.removeEventListener('keydown', handleFallbackKeydown, true);
      fallbackKeydownAttached = false;
    }

    function close() {
      if (!active) return false;
      generation += 1;
      var closing = active;
      active = null;
      detachFallbackKeydown();
      if (closing.managed && closing.manager && typeof closing.manager.close === 'function') {
        closing.manager.close(closing.id);
      } else {
        restoreFallbackInert(closing.inertRecords);
        focusElement(closing.restoreFocusTo);
      }
      return true;
    }

    function open(config) {
      if (disposed || !documentRef || !mountRoot) return false;
      if (active) close();
      var conf = config && typeof config === 'object' ? config : {};
      var id = String(conf.id || 'step-modal').trim() || 'step-modal';
      var manager = getOverlayManager() || null;
      var restoreFocusTo = conf.restoreFocusTo || documentRef.activeElement || null;
      var inertTargets = resolveInertTargets();
      var onRequestClose = typeof conf.onRequestClose === 'function'
        ? conf.onRequestClose
        : function noop() {};
      var managed = false;
      if (manager && typeof manager.open === 'function') {
        try {
          managed = manager.open({
            id: id,
            root: mountRoot,
            onRequestClose: onRequestClose,
            restoreFocusTo: restoreFocusTo,
            fallbackFocusTo: conf.fallbackFocusTo || null,
            inertTargets: inertTargets,
          }) === true;
        } catch (_error) {
          managed = false;
        }
      }
      active = {
        id: id,
        manager: manager,
        managed: managed,
        onRequestClose: onRequestClose,
        restoreFocusTo: restoreFocusTo,
        inertRecords: managed ? [] : applyFallbackInert(inertTargets),
      };
      if (!managed) {
        attachFallbackKeydown();
        try { appendClientLog('WARN', 'step_modal.overlay_manager_unavailable', { id: id }); }
        catch (_error) { /* best-effort */ }
      }
      generation += 1;
      var openGeneration = generation;
      Promise.resolve().then(function focusInitialControl() {
        if (!active || disposed || generation !== openGeneration) return;
        var selector = conf.initialFocusSelector
          || '.inv-step-modal-action--primary:not([disabled]), [data-step-modal-action]:not([disabled])';
        var target = mountRoot.querySelector(selector) || mountRoot.querySelector('[role="dialog"]');
        focusElement(target);
      });
      return true;
    }

    function dispose() {
      if (disposed) return;
      close();
      disposed = true;
      generation += 1;
      detachFallbackKeydown();
    }

    return {
      open: open,
      close: close,
      dispose: dispose,
      isOpen: function isOpen() { return Boolean(active); },
    };
  }

  return {
    escapeHtml: escapeHtml,
    renderStepModal: renderStepModal,
    createLifecycle: createLifecycle,
  };
});

