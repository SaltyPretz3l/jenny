(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-phase-percentiles-utils'),
      require('./renderer-observability-markup-utils'),
      require('../inventory/empty-note')
    );
    return;
  }
  root.rendererDiagnosticsPerformanceUtils = factory(
    root.rendererPhasePercentilesUtils,
    root.rendererObservabilityMarkupUtils,
    root.inventoryEmptyNote
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (phaseUtils, observabilityMarkup, emptyNote) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var FACETS = ['tool_observability', 'slow_operations', 'trace_timing'];

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  // A step's samples come from the dedicated phase payload; the status facet stands in only until that
  // payload has ever loaded, so a reset can never bring the cleared numbers back.
  function phasePayload(phaseState, status) {
    if (isRecord(phaseState.payload)) return phaseState.payload;
    if (!phaseState.loadedAt && isRecord(status.phase_percentiles) && status.phase_percentiles.available !== false) return status.phase_percentiles;
    return null;
  }

  function availableFacet(value) {
    return isRecord(value) && value.available !== false;
  }

  // Not fetched yet is different from fetched and empty: the first reads "Checking…", never a failure. A source
  // that reports itself unavailable has not loaded anything.
  function hasLoaded(phaseState, status) {
    return isRecord(phaseState.payload) || Number(phaseState.loadedAt) > 0
      || availableFacet(status.phase_percentiles)
      || FACETS.some(function (facet) { return availableFacet(status[facet]); });
  }

  function reportedUnavailable(status) {
    return ['phase_percentiles'].concat(FACETS).some(function (facet) { return isRecord(status[facet]) && status[facet].available === false; });
  }

  function emptyNoteMarkup(text, hint, role) {
    return emptyNote({ text: text, hint: hint, role: role });
  }

  // The "12 chats · 5 of 8 steps measured" count that sits in the Chat timing heading.
  function paintTimingCount(doc, view) {
    var heading = doc.getElementById('diagnosticsChatTimingHeading');
    if (!heading) return;
    var count = heading.querySelector('.diagnostics-group-count');
    if (!view.measured) {
      if (count) count.remove();
      return;
    }
    if (!count) {
      count = doc.createElement('small');
      count.className = 'diagnostics-group-count';
      heading.appendChild(count);
    }
    var text = jt('diagnostics.performance.timingCount', '{chats} · {steps}', {
      chats: jtn('diagnostics.performance.chatCount', view.chats, { count: view.chats.toLocaleString(globalThis.jennyI18n?.tag?.()) }, '{count} chat', '{count} chats'),
      steps: jt('diagnostics.performance.stepsMeasured', '{measured} of {total} steps measured', { measured: view.measured, total: view.total }),
    });
    if (count.textContent !== text) count.textContent = text;
  }

  /**
   * Paints the Overview's Performance section. The chat-timing table is painted here; the tool, over-target and
   * recent-chat tables belong to the observability controller, so this decides which groups show and what the
   * section says when there is nothing to show.
   * @param {Object} state - renderer state (phasePercentiles, diagnosticsStatus)
   * @param {{backend: Object, paintMarkup: Function, prior?: boolean, document?: Document}} context - prior: a
   *   launch other than the live one is selected; timings exist for the live launch only.
   */
  function renderPerformanceSection(state, context) {
    var ctx = context || {};
    var doc = ctx.document || globalThis.document;
    if (!doc || !state) return;
    var paint = typeof ctx.paintMarkup === 'function' ? ctx.paintMarkup : function (node, markup) { node.innerHTML = markup; };
    var node = function (id) { return doc.getElementById(id); };
    var phaseState = isRecord(state.phasePercentiles) ? state.phasePercentiles : {};
    var status = isRecord(state.diagnosticsStatus) ? state.diagnosticsStatus : {};
    var view = phaseUtils.buildPhaseTimingView(phasePayload(phaseState, status));
    var counts = {
      tools: observabilityMarkup.toolRows(status.tool_observability).length,
      slow: observabilityMarkup.slowRows(status.slow_operations).length,
      recent: observabilityMarkup.traceRows(status.trace_timing).length,
    };
    var measured = view.measured > 0 || counts.tools > 0 || counts.recent > 0 || counts.slow > 0;
    var failure = String(phaseState.error || '').trim();
    var loaded = hasLoaded(phaseState, status);
    var backendReady = phaseUtils.classifyBackendPhase(ctx.backend && ctx.backend.phase) === 'ready';

    var emptyHost = node('diagnosticsPerformanceEmpty');
    var note = '';
    if (ctx.prior) {
      note = emptyNoteMarkup(jt('diagnostics.performance.currentLaunchOnly', 'Timings cover the current launch only.'), '', 'status');
      measured = false;
    } else if (!loaded && !failure && reportedUnavailable(status)) {
      note = emptyNoteMarkup(jt('diagnostics.performance.loadFailed', 'Timings could not be loaded.'), '', 'status');
    } else if (!loaded && !failure) {
      // Not fetched yet makes no claim about what was measured.
      note = emptyNoteMarkup(jt('diagnostics.performance.checking', 'Checking…'), '', 'status');
    } else if (!measured) {
      if (failure) {
        note = emptyNoteMarkup(jt('diagnostics.performance.loadFailed', 'Timings could not be loaded.'), failure, 'status');
      } else {
        note = emptyNoteMarkup(
          jt('diagnostics.performance.nothingMeasured', 'No chats measured in this launch yet.'),
          backendReady ? jt('diagnostics.performance.sendChatHint', 'Send a chat and its timings appear here.')
            : jt('diagnostics.performance.waitForEngine', 'Timings start once the engine is ready.'),
          'status'
        );
      }
    } else if (failure) {
      note = emptyNoteMarkup(jt('diagnostics.performance.refreshFailed', 'Timings could not be refreshed.'), failure, 'status');
    }
    if (emptyHost) {
      paint(emptyHost, note);
      emptyHost.hidden = !note;
    }

    var groups = node('diagnosticsPerformanceGroups');
    if (groups) groups.hidden = !measured;
    var timingHost = node('phasePercentilesTable');
    if (timingHost) paint(timingHost, view.markup);
    paintTimingCount(doc, view);
    var visibility = {
      diagnosticsChatTiming: view.measured > 0,
      diagnosticsOverTarget: counts.slow > 0,
      diagnosticsTools: counts.tools > 0,
      diagnosticsRecentChats: counts.recent > 0,
    };
    Object.keys(visibility).forEach(function (id) {
      var group = node(id);
      if (group) group.hidden = !visibility[id];
    });
    // Reset clears the phase timings, so it is offered only while there are some.
    var reset = node('diagnosticsResetControl');
    if (reset) {
      var hideReset = !measured || view.measured === 0;
      // A Reset that hides itself while focused hands focus to the section heading, not the page body.
      var heading = node('diagnosticsPerformanceHeading');
      if (hideReset && !reset.hidden && heading && reset.contains(doc.activeElement)) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      reset.hidden = hideReset;
    }
  }

  return Object.freeze({
    renderPerformanceSection: renderPerformanceSection,
  });
});
