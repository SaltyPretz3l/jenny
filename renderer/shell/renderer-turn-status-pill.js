/* renderer/shell/renderer-turn-status-pill.js
 *
 * Sources publish payloads keyed by SOURCES.*; the controller renders the
 * highest-priority active source in the titlebar slot.
 *
 * Payload: { message, tone, spinner, badgeText, indeterminate?, progressPercent? }
 */
(function exposeTurnStatusPill(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('../shared/math-utils')
    );
    return;
  }
  root.rendererTurnStatusPill = factory(
    root.stringUtils || {},
    root.mathUtils || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function turnStatusPillFactory(stringUtils, mathUtils) {

  var SOURCES = Object.freeze({
    LIFECYCLE_SHUTDOWN: 'lifecycle.shutdown',
    LIFECYCLE_MODEL_SWITCH: 'lifecycle.modelSwitch',
    LIFECYCLE_STARTUP: 'lifecycle.startup',
    TURN_NEEDS_APPROVAL: 'turn.needs_approval',
    TURN_RUNNING_TOOL: 'turn.running_tool',
    TURN_THINKING: 'turn.thinking',
    TURN_RESPONDING: 'turn.responding',
    TURN_SENDING: 'turn.sending',
  });

  var SOURCE_PRIORITY = Object.freeze([
    SOURCES.LIFECYCLE_SHUTDOWN,
    SOURCES.LIFECYCLE_MODEL_SWITCH,
    SOURCES.LIFECYCLE_STARTUP,
    SOURCES.TURN_NEEDS_APPROVAL,
    SOURCES.TURN_RUNNING_TOOL,
    SOURCES.TURN_THINKING,
    SOURCES.TURN_RESPONDING,
    SOURCES.TURN_SENDING,
  ]);

  var TURN_SOURCES = Object.freeze([
    SOURCES.TURN_NEEDS_APPROVAL,
    SOURCES.TURN_RUNNING_TOOL,
    SOURCES.TURN_THINKING,
    SOURCES.TURN_RESPONDING,
    SOURCES.TURN_SENDING,
  ]);

  var escapeHtml = typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : function fallbackEscapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };

  var clamp = typeof mathUtils.clamp === 'function'
    ? mathUtils.clamp
    : function fallbackClamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    };

  function normalizeTone(value) {
    var token = String(value || '').trim().toLowerCase();
    if (token === 'pending' || token === 'success' || token === 'warning' || token === 'danger' || token === 'info') {
      return token;
    }
    return 'info';
  }

  function priorityIndex(source) {
    var idx = SOURCE_PRIORITY.indexOf(String(source || ''));
    return idx === -1 ? SOURCE_PRIORITY.length : idx;
  }

  function normalizePayload(payload) {
    if (!payload || typeof payload !== 'object') { return null; }
    var message = String(payload.message || '').trim();
    if (!message) { return null; }
    var percent = payload.progressPercent;
    return {
      message: message,
      tone: normalizeTone(payload.tone),
      spinner: payload.spinner === true,
      badgeText: String(payload.badgeText || '').trim(),
      indeterminate: payload.indeterminate === true,
      progressPercent: percent == null || !Number.isFinite(Number(percent))
        ? null
        : clamp(Number(percent), 0, 100),
    };
  }

  function payloadsEqual(a, b) {
    if (a === b) { return true; }
    if (!a || !b) { return false; }
    return a.message === b.message
      && a.tone === b.tone
      && a.spinner === b.spinner
      && a.badgeText === b.badgeText
      && a.indeterminate === b.indeterminate
      && a.progressPercent === b.progressPercent;
  }

  function buildMarkup(payload) {
    var spinner = payload.spinner;
    var badge = payload.badgeText;
    var hasProgress = payload.indeterminate || payload.progressPercent != null;
    var percent = payload.indeterminate ? 30 : (payload.progressPercent || 0);
    var indeterminateAttr = payload.indeterminate ? ' data-indeterminate="true"' : '';
    return ''
      + (spinner ? '<span class="turn-status-pill__spinner" aria-hidden="true"></span>' : '')
      + (badge ? '<span class="turn-status-pill__badge" data-tone="' + escapeHtml(payload.tone) + '">' + escapeHtml(badge) + '</span>' : '')
      + '<span class="turn-status-pill__message">' + escapeHtml(payload.message) + '</span>'
      + (hasProgress
        ? '<span class="turn-status-pill__progress"' + indeterminateAttr + ' style="--turn-status-pill-progress:' + percent + '%"></span>'
        : '');
  }

  function createTurnStatusPillController(deps) {
    var resolvedDeps = deps && typeof deps === 'object' ? deps : {};
    var dom = resolvedDeps.dom && typeof resolvedDeps.dom === 'object' ? resolvedDeps.dom : {};
    var turnStatusPill = dom.turnStatusPill || null;
    var metricList = dom.metricList || null;
    var titlebarStatus = dom.titlebarStatus
      || (turnStatusPill && turnStatusPill.parentElement)
      || null;

    var sources = new Map();
    var lastRenderedSource = null;
    var lastRenderedPayload = null;

    function pickActiveSource() {
      var best = null;
      var bestIdx = SOURCE_PRIORITY.length;
      sources.forEach(function evaluateSource(_payload, source) {
        var idx = priorityIndex(source);
        if (idx < bestIdx) {
          bestIdx = idx;
          best = source;
        }
      });
      return best;
    }

    function render() {
      if (!turnStatusPill) { return; }
      var active = pickActiveSource();
      if (!active) {
        if (lastRenderedSource === null) { return; }
        lastRenderedSource = null;
        lastRenderedPayload = null;
        turnStatusPill.classList.add('hidden');
        turnStatusPill.innerHTML = '';
        turnStatusPill.removeAttribute('data-source');
        turnStatusPill.removeAttribute('data-tone');
        turnStatusPill.removeAttribute('data-shutdown');
        if (titlebarStatus) {
          titlebarStatus.classList.remove('titlebar-status--shutdown');
        }
        if (metricList) {
          metricList.classList.remove('hidden-by-pill');
        }
        return;
      }
      var payload = sources.get(active);
      if (active === lastRenderedSource && payloadsEqual(payload, lastRenderedPayload)) {
        return;
      }
      lastRenderedSource = active;
      lastRenderedPayload = payload;
      turnStatusPill.classList.remove('hidden');
      turnStatusPill.setAttribute('data-source', active);
      turnStatusPill.setAttribute('data-tone', payload.tone);
      turnStatusPill.innerHTML = buildMarkup(payload);

      var isShutdown = active === SOURCES.LIFECYCLE_SHUTDOWN;
      if (isShutdown) {
        turnStatusPill.setAttribute('data-shutdown', 'true');
        if (titlebarStatus) { titlebarStatus.classList.add('titlebar-status--shutdown'); }
        if (metricList) { metricList.classList.add('hidden-by-pill'); }
      } else {
        turnStatusPill.removeAttribute('data-shutdown');
        if (titlebarStatus) { titlebarStatus.classList.remove('titlebar-status--shutdown'); }
        if (metricList) { metricList.classList.remove('hidden-by-pill'); }
      }
    }

    function setSource(source, payload) {
      var key = String(source || '').trim();
      if (!key) { return; }
      var normalized = normalizePayload(payload);
      if (!normalized) {
        clearSource(key);
        return;
      }
      var previous = sources.get(key) || null;
      if (payloadsEqual(previous, normalized)) {
        return;
      }
      sources.set(key, normalized);
      render();
    }

    function clearSource(source) {
      var key = String(source || '').trim();
      if (!key) { return; }
      if (!sources.has(key)) { return; }
      sources.delete(key);
      render();
    }

    function clearSources(sourceList) {
      var list = Array.isArray(sourceList) ? sourceList : [];
      var changed = false;
      for (var i = 0; i < list.length; i++) {
        var key = String(list[i] || '').trim();
        if (key && sources.has(key)) {
          sources.delete(key);
          changed = true;
        }
      }
      if (changed) { render(); }
    }

    function clearAll() {
      if (sources.size === 0) { return; }
      sources.clear();
      render();
    }

    function getActiveSource() {
      return pickActiveSource();
    }

    function getSourcePayload(source) {
      var key = String(source || '').trim();
      if (!key || !sources.has(key)) { return null; }
      return sources.get(key);
    }

    function dispose() {
      sources.clear();
      lastRenderedSource = null;
      lastRenderedPayload = null;
      if (turnStatusPill) {
        turnStatusPill.classList.add('hidden');
        turnStatusPill.innerHTML = '';
        turnStatusPill.removeAttribute('data-source');
        turnStatusPill.removeAttribute('data-tone');
        turnStatusPill.removeAttribute('data-shutdown');
      }
      if (titlebarStatus) {
        titlebarStatus.classList.remove('titlebar-status--shutdown');
      }
      if (metricList) {
        metricList.classList.remove('hidden-by-pill');
      }
    }

    return {
      set: setSource,
      clear: clearSource,
      clearSources: clearSources,
      clearAll: clearAll,
      render: render,
      getActiveSource: getActiveSource,
      getSourcePayload: getSourcePayload,
      dispose: dispose,
    };
  }

  return {
    createTurnStatusPillController: createTurnStatusPillController,
    SOURCES: SOURCES,
    SOURCE_PRIORITY: SOURCE_PRIORITY,
    TURN_SOURCES: TURN_SOURCES,
  };
});
