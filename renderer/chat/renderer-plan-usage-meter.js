/**
 * renderer/chat/renderer-plan-usage-meter.js
 *
 * ChatGPT plan-usage meter: a second ring chip beside the composer context
 * ring, fed by the `chatgptPlanUsage` bridge (rolling-window used-percent +
 * reset times captured from the provider's response headers by the sidecar).
 *
 * Owns its own store, memo and popover so it never shares state with the
 * context ring. Renders only while the flag is on, ChatGPT is the active
 * engine, and at least one reading exists — otherwise the slot stays empty.
 * Window labels are DERIVED from `window_minutes`; nothing here hardcodes a
 * plan's window length.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererPlanUsageMeter = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var PLAN_METER_ENGINE_TYPE = 'chatgpt';
  var PLAN_METER_FLAG = 'chatgpt_plan_meter';
  var PLAN_WARNING_THRESHOLD = 0.75;
  var PLAN_DANGER_THRESHOLD = 0.9;
  var RING_RADIUS = 8;
  var RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  var CHIP_ID = 'composer-plan-ring';
  var CHIP_DOM_ID = 'composerPlanRing';
  var POPOVER_ID = 'composer-plan-details';
  var POPOVER_DOM_ID = 'composerPlanDetailsPopover';
  var BAR_WIDTH = 100;
  var MINUTE_MS = 60 * 1000;
  var HOUR_MS = 60 * MINUTE_MS;
  var DAY_MS = 24 * HOUR_MS;
  var MINUTES_PER_HOUR = 60;
  var MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
  var WINDOW_KEYS = ['primary', 'secondary'];
  var LEAVE_FALLBACK_DURATION_MS = 160;

  var meter = {
    snapshot: null,
    account: null,
    engineActive: false,
    installEpoch: 0,
  };
  var memo = { html: '' };
  var clock = function defaultClock() { return Date.now(); };
  var pendingLeaveSlot = null;
  var pendingLeaveTimer = null;
  var pendingLeaveHandler = null;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function finiteNumber(value) {
    var numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function clampPercent(value) {
    var numeric = finiteNumber(value);
    if (numeric === null) return null;
    return Math.min(Math.max(numeric, 0), 100);
  }

  function normalizeWindow(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    var usedPercent = clampPercent(input.used_percent);
    if (usedPercent === null) return null;
    var minutes = finiteNumber(input.window_minutes);
    var resetAt = finiteNumber(input.reset_at);
    return {
      usedPercent: usedPercent,
      windowMinutes: minutes !== null && minutes > 0 ? Math.floor(minutes) : 0,
      resetAtMs: resetAt !== null && resetAt > 0 ? Math.floor(resetAt * 1000) : 0,
    };
  }

  function normalizeSnapshot(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    var primary = normalizeWindow(input.primary);
    var secondary = normalizeWindow(input.secondary);
    if (!primary && !secondary) return null;
    var reached = String(input.rate_limit_reached_type || '').trim().toLowerCase();
    var captured = finiteNumber(input.captured_at_ms);
    return {
      primary: primary,
      secondary: secondary,
      rateLimitReachedType: WINDOW_KEYS.indexOf(reached) === -1 ? '' : reached,
      capturedAtMs: captured !== null && captured > 0 ? Math.floor(captured) : 0,
      source: String(input.source || '').trim().slice(0, 32),
    };
  }

  function normalizeAccount(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    var email = String(input.email || '').trim().slice(0, 254);
    var planType = String(input.plan_type || '').trim().slice(0, 64);
    if (!email && !planType) return null;
    return { email: email, planType: planType };
  }

  /* Bridge payload (`chatgptPlanUsage.getSnapshot` / `onSnapshot`) → store.
   * Built key-by-key; the payload is never spread into the store. */
  function applyPayload(payload) {
    var source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    meter.engineActive = source.engine_active === true;
    meter.account = normalizeAccount(source.account);
    meter.snapshot = normalizeSnapshot(source.snapshot);
    return meter.snapshot;
  }

  function clear() {
    meter.snapshot = null;
    meter.account = null;
    meter.engineActive = false;
  }

  function getSnapshot() {
    return meter.snapshot;
  }

  function setClock(fn) {
    clock = typeof fn === 'function' ? fn : function fallbackClock() { return Date.now(); };
  }

  function rendererEngineType(appState) {
    var status = appState && appState.status && typeof appState.status === 'object' ? appState.status : {};
    var modelList = appState && appState.modelList && typeof appState.modelList === 'object'
      ? appState.modelList : {};
    return String(status.engine || status.engine_type || modelList.engine_type || '')
      .trim().toLowerCase();
  }

  function selectedEngineType(appState) {
    var state = appState && typeof appState === 'object' ? appState : {};
    var sessionId = String(state.currentSessionId || '').trim();
    var sessions = Array.isArray(state.sessions) ? state.sessions : [];
    var activeSession = sessionId
      ? sessions.filter(function matchSession(session) {
        return String(session && session.id || '').trim() === sessionId;
      })[0]
      : null;
    var preferredModel = activeSession
      ? String(activeSession.preferred_model || '').trim()
      : String(state.runtimeDraft && state.runtimeDraft.preferredModel || '').trim();
    if (!preferredModel) return '';
    var models = state.modelList && Array.isArray(state.modelList.data) ? state.modelList.data : [];
    var selectedModel = models.filter(function matchModel(model) {
      return String(model && model.id || '').trim() === preferredModel;
    })[0];
    return String(selectedModel && (selectedModel.engine_type ?? selectedModel.engineType) || '')
      .trim().toLowerCase();
  }

  function flagEnabled(appState) {
    var flags = appState && appState.features && appState.features.featureFlags;
    if (!flags || typeof flags !== 'object') return true;
    /* DEFAULT-ON: only an explicit false (the JENNY_ENABLE_CHATGPT_PLAN_METER=0
       kill switch) hides the meter; an older feature payload without the key
       behaves like production's default. */
    return flags[PLAN_METER_FLAG] !== false;
  }

  function isPlanMeterActive(appState) {
    if (!flagEnabled(appState)) return false;
    var selected = selectedEngineType(appState);
    // Product decision: plan usage tracks the selected model, not the still-loaded engine.
    // This hides before the next turn swaps engines; an unknown selection preserves the
    // loaded-engine fallback so older or partial renderer state keeps working.
    if (selected) return selected === PLAN_METER_ENGINE_TYPE;
    return meter.engineActive || rendererEngineType(appState) === PLAN_METER_ENGINE_TYPE;
  }

  function pluralize(count, unit) {
    return count + ' ' + unit;
  }

  /* Label derived from the reported window length — never a fixed plan name. */
  function formatWindowLabel(windowMinutes) {
    var minutes = Math.max(0, Math.floor(Number(windowMinutes) || 0));
    if (minutes <= 0) return 'Usage window';
    if (minutes < MINUTES_PER_HOUR) return pluralize(minutes, 'min') + ' window';
    if (minutes < MINUTES_PER_DAY) {
      var hours = minutes / MINUTES_PER_HOUR;
      return pluralize(Number.isInteger(hours) ? hours : hours.toFixed(1), 'hr') + ' window';
    }
    var days = minutes / MINUTES_PER_DAY;
    return pluralize(Number.isInteger(days) ? days : days.toFixed(1), 'day') + ' window';
  }

  function formatDuration(deltaMs) {
    var remaining = Math.max(0, deltaMs);
    if (remaining < MINUTE_MS) return 'under a minute';
    if (remaining < HOUR_MS) return Math.ceil(remaining / MINUTE_MS) + 'm';
    if (remaining < DAY_MS) {
      var hours = Math.floor(remaining / HOUR_MS);
      var minutes = Math.ceil((remaining - hours * HOUR_MS) / MINUTE_MS);
      if (minutes >= MINUTES_PER_HOUR) { hours += 1; minutes = 0; }
      return hours + 'h' + (minutes > 0 ? ' ' + minutes + 'm' : '');
    }
    var days = Math.floor(remaining / DAY_MS);
    var dayHours = Math.floor((remaining - days * DAY_MS) / HOUR_MS);
    return days + 'd' + (dayHours > 0 ? ' ' + dayHours + 'h' : '');
  }

  function formatResetLabel(resetAtMs, nowMs) {
    var reset = Math.max(0, Number(resetAtMs) || 0);
    if (reset <= 0) return 'reset time unknown';
    var now = Number(nowMs) || clock();
    if (reset <= now) return 'window reset — awaiting next request';
    return 'resets in ' + formatDuration(reset - now);
  }

  function formatUpdatedAgo(capturedAtMs, nowMs) {
    var captured = Math.max(0, Number(capturedAtMs) || 0);
    if (captured <= 0) return 'Updated after the last ChatGPT response';
    var delta = Math.max(0, (Number(nowMs) || clock()) - captured);
    if (delta < MINUTE_MS) return 'Updated just now';
    if (delta < HOUR_MS) return 'Updated ' + Math.floor(delta / MINUTE_MS) + ' min ago';
    if (delta < DAY_MS) return 'Updated ' + Math.floor(delta / HOUR_MS) + ' hr ago';
    return 'Updated ' + Math.floor(delta / DAY_MS) + ' day ago';
  }

  function formatPercent(value) {
    var percent = clampPercent(value);
    if (percent === null) return '0%';
    return (percent >= 99.95 ? '100' : percent < 1 && percent > 0 ? '<1' : String(Math.round(percent))) + '%';
  }

  function describeWindow(key, window, nowMs) {
    var expired = window.resetAtMs > 0 && window.resetAtMs <= nowMs;
    return {
      key: key,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes,
      resetAtMs: window.resetAtMs,
      expired: expired,
      label: formatWindowLabel(window.windowMinutes),
      percentLabel: formatPercent(window.usedPercent),
      resetLabel: formatResetLabel(window.resetAtMs, nowMs),
    };
  }

  function describePlanUsage(snapshot, nowMs) {
    var record = snapshot || meter.snapshot;
    if (!record) return null;
    var now = Number(nowMs) || clock();
    var windows = [];
    var ratio = 0;
    WINDOW_KEYS.forEach(function eachWindow(key) {
      var window = record[key];
      if (!window) return;
      var described = describeWindow(key, window, now);
      windows.push(described);
      if (!described.expired) ratio = Math.max(ratio, described.usedPercent / 100);
    });
    if (!windows.length) return null;
    var reachedWindow = record.rateLimitReachedType
      ? windows.filter(function match(entry) { return entry.key === record.rateLimitReachedType; })[0]
      : null;
    var limitReached = Boolean(reachedWindow && !reachedWindow.expired);
    var severity = limitReached || ratio >= PLAN_DANGER_THRESHOLD ? 'danger'
      : ratio >= PLAN_WARNING_THRESHOLD ? 'warning' : '';
    return {
      windows: windows,
      ringRatio: ratio,
      percentLabel: formatPercent(ratio * 100),
      severity: severity,
      limitReached: limitReached,
      limitResetLabel: limitReached ? reachedWindow.resetLabel : '',
      updatedAgoLabel: formatUpdatedAgo(record.capturedAtMs, now),
      accountLabel: formatAccountLabel(meter.account),
    };
  }

  function formatAccountLabel(account) {
    if (!account) return '';
    var plan = account.planType ? account.planType.charAt(0).toUpperCase() + account.planType.slice(1) : '';
    var parts = [];
    if (plan) parts.push('ChatGPT ' + plan);
    if (account.email) parts.push('signed in as ' + account.email);
    return parts.join(' · ');
  }

  function buildDetailText(summary) {
    var lines = [];
    if (summary.limitReached) lines.push('Limit reached · ' + summary.limitResetLabel);
    summary.windows.forEach(function eachWindow(entry) {
      lines.push(entry.label + ': ' + entry.percentLabel + ' used · ' + entry.resetLabel);
    });
    lines.push(summary.updatedAgoLabel);
    return (summary.accountLabel ? summary.accountLabel + ' · ' : '') + lines.join('\n');
  }

  function ringSvg(ratio) {
    var arc = (Math.min(Math.max(ratio, 0), 1) * RING_CIRCUMFERENCE).toFixed(2);
    return '<svg class="inv-context-ring-svg" viewBox="0 0 20 20" aria-hidden="true" focusable="false">'
      + '<circle class="inv-context-ring-track" cx="10" cy="10" r="' + RING_RADIUS + '"/>'
      + '<circle class="inv-context-ring-arc" cx="10" cy="10" r="' + RING_RADIUS + '"'
      + ' stroke-dasharray="' + arc + ' ' + RING_CIRCUMFERENCE.toFixed(2) + '"/>'
      + '</svg>';
  }

  /* SVG bars: width is an attribute, not an inline style, so the markup stays
     valid under the renderer CSP. */
  function barSvg(percent) {
    var fill = Math.round(Math.min(Math.max(percent, 0), 100) * BAR_WIDTH) / 100;
    return '<svg class="inv-plan-bar" viewBox="0 0 ' + BAR_WIDTH + ' 4" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
      + '<rect class="inv-plan-bar-track" x="0" y="0" width="' + BAR_WIDTH + '" height="4" rx="2"/>'
      + '<rect class="inv-plan-bar-fill" x="0" y="0" width="' + fill + '" height="4" rx="2"/>'
      + '</svg>';
  }

  function renderWindowRow(entry) {
    return '<div class="inv-plan-window' + (entry.expired ? ' inv-plan-window--expired' : '') + '">'
      + '<div class="inv-plan-window-head">'
      + '<span class="inv-plan-window-label">' + escapeHtml(entry.label) + '</span>'
      + '<span class="inv-plan-window-percent">' + escapeHtml(entry.percentLabel) + ' used</span>'
      + '</div>'
      + barSvg(entry.usedPercent)
      + '<p class="inv-plan-window-reset">' + escapeHtml(entry.resetLabel) + '</p>'
      + '</div>';
  }

  function renderPopoverBody(summary) {
    var html = '<h3>ChatGPT plan usage</h3>';
    if (summary.accountLabel) {
      html += '<p class="inv-plan-account">' + escapeHtml(summary.accountLabel) + '</p>';
    }
    if (summary.limitReached) {
      html += '<p class="inv-plan-limit" role="status">Limit reached · '
        + escapeHtml(summary.limitResetLabel) + '</p>';
    }
    summary.windows.forEach(function eachWindow(entry) { html += renderWindowRow(entry); });
    html += '<p class="inv-plan-updated">' + escapeHtml(summary.updatedAgoLabel)
      + ' · from the last ChatGPT response</p>';
    return html;
  }

  function renderPlanUsageMeter(appState, nowMs) {
    if (!isPlanMeterActive(appState)) return '';
    var summary = describePlanUsage(meter.snapshot, nowMs);
    if (!summary) return '';
    var inventory = root && root.inventory;
    var chip = inventory && inventory.chip;
    var popover = inventory && inventory.popover;
    if (typeof chip !== 'function') return '';
    var chipLabel = summary.limitReached ? 'Limit' : summary.percentLabel;
    var ringClass = 'inv-context-ring inv-plan-ring'
      + (summary.severity ? ' inv-context-ring--' + summary.severity + ' inv-plan-ring--' + summary.severity : '')
      + (summary.limitReached ? ' inv-plan-ring--exhausted' : '');
    var html = '<div class="inv-context-usage inv-context-usage--ring inv-plan-usage">'
      + chip({
        id: CHIP_ID,
        domId: CHIP_DOM_ID,
        iconHtml: ringSvg(summary.ringRatio),
        label: chipLabel,
        ariaLabel: 'ChatGPT plan usage: ' + summary.percentLabel + (summary.limitReached ? ', limit reached' : ''),
        title: buildDetailText(summary),
        hasPopup: typeof popover === 'function',
        ariaControls: typeof popover === 'function' ? POPOVER_DOM_ID : '',
        className: ringClass,
      });
    if (typeof popover === 'function') {
      html += popover({
        id: POPOVER_ID,
        domId: POPOVER_DOM_ID,
        ariaLabel: 'ChatGPT plan usage details',
        className: 'inv-context-details-popover inv-plan-details-popover',
        trustedHtml: renderPopoverBody(summary),
      });
    }
    return html + '</div>';
  }

  function positionPopover(popoverEl, trigger) {
    var details = root && root.rendererContextMeterDetails;
    if (details && typeof details.positionPopover === 'function') {
      details.positionPopover(popoverEl, trigger);
    }
  }

  function cancelPendingLeave(slotEl) {
    if (!pendingLeaveSlot || (slotEl && pendingLeaveSlot !== slotEl)) return;
    if (pendingLeaveTimer !== null) {
      clearTimeout(pendingLeaveTimer);
      pendingLeaveTimer = null;
    }
    if (pendingLeaveHandler) {
      pendingLeaveSlot.removeEventListener('transitionend', pendingLeaveHandler);
      pendingLeaveHandler = null;
    }
    pendingLeaveSlot.classList.remove('is-leaving');
    pendingLeaveSlot = null;
  }

  function leaveDurationMs(slotEl) {
    var view = slotEl && slotEl.ownerDocument && slotEl.ownerDocument.defaultView;
    var getStyle = view && typeof view.getComputedStyle === 'function'
      ? view.getComputedStyle.bind(view)
      : root && typeof root.getComputedStyle === 'function' ? root.getComputedStyle.bind(root) : null;
    if (!getStyle) return LEAVE_FALLBACK_DURATION_MS;
    var value = String(getStyle(slotEl).getPropertyValue('--motion-duration-fast') || '').trim();
    var match = value.match(/^([\d.]+)(ms|s)$/i);
    if (!match) return LEAVE_FALLBACK_DURATION_MS;
    var duration = Number(match[1]);
    if (!Number.isFinite(duration)) return LEAVE_FALLBACK_DURATION_MS;
    return match[2].toLowerCase() === 's' ? duration * 1000 : duration;
  }

  /* Same media query the stylesheet keys `transition: none` on. With no
     transition there is no transitionend, and waiting out the timer would
     leave the chip standing at full opacity, so the leave clears at once. */
  function prefersReducedMotion(slotEl) {
    var view = slotEl && slotEl.ownerDocument && slotEl.ownerDocument.defaultView;
    var matchMedia = view && typeof view.matchMedia === 'function'
      ? view.matchMedia.bind(view)
      : root && typeof root.matchMedia === 'function' ? root.matchMedia.bind(root) : null;
    if (!matchMedia) return false;
    try {
      return Boolean(matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_error) {
      return false;
    }
  }

  function beginLeave(slotEl) {
    cancelPendingLeave();
    if (prefersReducedMotion(slotEl)) {
      slotEl.innerHTML = '';
      return;
    }
    var animated = typeof slotEl.querySelector === 'function' ? slotEl.querySelector('.inv-plan-usage') : null;
    var duration = leaveDurationMs(slotEl);
    pendingLeaveSlot = slotEl;
    pendingLeaveHandler = function finishLeave(event) {
      if (pendingLeaveSlot !== slotEl) return;
      // transitionend bubbles: a child's own transition (the ring, the label)
      // ending mid-fade must not clear the slot early. Only the fading root's
      // opacity transition ends the leave; the timer path passes no event.
      if (event && (event.target !== animated || (event.propertyName && event.propertyName !== 'opacity'))) return;
      cancelPendingLeave(slotEl);
      slotEl.innerHTML = '';
    };
    slotEl.classList.add('is-leaving');
    slotEl.addEventListener('transitionend', pendingLeaveHandler);
    pendingLeaveTimer = setTimeout(pendingLeaveHandler, duration);
    pendingLeaveTimer.unref?.();
  }

  /* Slot render with the same memo + open-popover preservation contract as the
     context ring: an identical frame is a no-op, and a repaint under an open
     popover reopens it on the fresh markup. */
  function render(slotEl, appState, nowMs) {
    if (!slotEl) return '';
    var html = renderPlanUsageMeter(appState, nowMs);
    if (memo.html === html && slotEl.dataset && slotEl.dataset.planRendered === '1') return html;
    if (!html && slotEl.querySelector && slotEl.querySelector('.inv-plan-usage')) {
      beginLeave(slotEl);
      if (slotEl.dataset) slotEl.dataset.planRendered = '1';
      memo.html = html;
      return html;
    }
    var wasEmpty = !slotEl.firstChild;
    if (html) cancelPendingLeave(slotEl);
    var wasOpen = Boolean(slotEl.querySelector && slotEl.querySelector('.inv-popover:not([hidden])'));
    if (html && wasEmpty) slotEl.classList.add('is-entering');
    slotEl.innerHTML = html;
    if (html && wasEmpty) {
      void slotEl.offsetHeight;
      slotEl.classList.remove('is-entering');
    }
    if (slotEl.dataset) slotEl.dataset.planRendered = '1';
    memo.html = html;
    if (wasOpen && html) {
      var nextPopover = slotEl.querySelector('#' + POPOVER_DOM_ID);
      var nextChip = slotEl.querySelector('[data-inv-chip="' + CHIP_ID + '"]');
      var popoverApi = root && root.inventory && root.inventory.popover;
      if (nextPopover && nextChip && popoverApi && typeof popoverApi.open === 'function') {
        popoverApi.open(nextPopover, { trigger: nextChip, focus: false });
        positionPopover(nextPopover, nextChip);
      }
    }
    return html;
  }

  function handleClick(options) {
    var event = options && options.event;
    var composerWrap = options && options.composerWrap;
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') return false;
    var chip = target.closest('[data-inv-chip="' + CHIP_ID + '"]');
    if (!chip) return false;
    var tooltipApi = root && root.inventory && root.inventory.tooltip;
    if (tooltipApi) {
      if (typeof tooltipApi.unpin === 'function') tooltipApi.unpin();
      if (typeof tooltipApi.hide === 'function') tooltipApi.hide();
    }
    var doc = composerWrap && composerWrap.ownerDocument;
    var popoverEl = doc && typeof doc.getElementById === 'function' ? doc.getElementById(POPOVER_DOM_ID) : null;
    var popoverApi = root && root.inventory && root.inventory.popover;
    if (popoverEl && popoverApi && typeof popoverApi.toggle === 'function') {
      popoverApi.toggle(popoverEl, { trigger: chip, restoreFocus: true });
      if (!popoverEl.hidden) positionPopover(popoverEl, chip);
    }
    return true;
  }

  /* Bridge wiring. Optional at every step: an older preload without the
     `chatgptPlanUsage` namespace simply leaves the meter hidden. */
  function install(options) {
    var opts = options || {};
    var shell = opts.shell || (root && root.jennyShell) || null;
    var api = shell && shell.chatgptPlanUsage;
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function noop() {};
    if (!api || typeof api !== 'object') return function noopTeardown() {};
    var epoch = meter.installEpoch += 1;
    var active = true;
    var unsubscribe = typeof api.onSnapshot === 'function'
      ? api.onSnapshot(function onSnapshot(payload) {
        if (!active || epoch !== meter.installEpoch) return;
        applyPayload(payload);
        onChange();
      })
      : null;
    if (typeof api.getSnapshot === 'function') {
      Promise.resolve().then(function seed() { return api.getSnapshot(); }).then(function apply(payload) {
        if (!active || epoch !== meter.installEpoch) return;
        applyPayload(payload);
        onChange();
      }).catch(function ignore() { /* the meter stays hidden until the next push */ });
    }
    return function teardown() {
      if (!active) return;
      active = false;
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* bridge already gone */ }
      }
    };
  }

  function dispose() {
    meter.installEpoch += 1;
    var leavingSlot = pendingLeaveSlot;
    cancelPendingLeave();
    // A leave in flight at dispose time would otherwise keep the old account's
    // chip standing, un-faded, until something happens to render again.
    if (leavingSlot) leavingSlot.innerHTML = '';
    clear();
    // null, not '': the next render() must repaint even when it produces ''
    // (the slot still holds the previous session's chip otherwise).
    memo.html = null;
  }

  return {
    PLAN_METER_ENGINE_TYPE: PLAN_METER_ENGINE_TYPE,
    PLAN_METER_FLAG: PLAN_METER_FLAG,
    PLAN_WARNING_THRESHOLD: PLAN_WARNING_THRESHOLD,
    PLAN_DANGER_THRESHOLD: PLAN_DANGER_THRESHOLD,
    CHIP_ID: CHIP_ID,
    POPOVER_DOM_ID: POPOVER_DOM_ID,
    applyPayload: applyPayload,
    clear: clear,
    getSnapshot: getSnapshot,
    setClock: setClock,
    install: install,
    isPlanMeterActive: isPlanMeterActive,
    describePlanUsage: describePlanUsage,
    formatWindowLabel: formatWindowLabel,
    formatResetLabel: formatResetLabel,
    formatUpdatedAgo: formatUpdatedAgo,
    renderPlanUsageMeter: renderPlanUsageMeter,
    render: render,
    handleClick: handleClick,
    dispose: dispose,
  };
});
