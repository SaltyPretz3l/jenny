/* renderer/features/renderer-ide-problems-filter.js - pure filter state for the
 * Workspace IDE Problems panel toolbar: text + severity toggles + "Active file
 * only". Runtime-only (never persisted). `hint` markers follow the Info toggle.
 * The panel owns the DOM; this module owns what passes the filter, the painted-row
 * cap, the F8 / Shift+F8 walk order, plus the toolbar's inline glyphs (currentColor,
 * CSP-safe). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeProblemsFilter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const TOGGLES = ['error', 'warning', 'info', 'activeOnly'];
  const GLYPH_OPEN = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const GLYPHS = {
    chevron: GLYPH_OPEN + '<path d="M5.5 6.5 8 9l2.5-2.5"></path></svg>',
    collapseAll: GLYPH_OPEN + '<path d="M4 3.5 8 7l4-3.5"></path><path d="M4 12.5 8 9l4 3.5"></path></svg>',
    expandAll: GLYPH_OPEN + '<path d="M4 7 8 3.5 12 7"></path><path d="M4 9 8 12.5 12 9"></path></svg>',
  };
  // The panel's inline SVG severity glyphs (CSP-safe, currentColor; colour is set per
  // data-diag-severity in styles/ide-problems.css so they re-theme).
  const SEVERITY_ICON = {
    error: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><path d="M10 6 6 10M6 6l4 4"></path></svg>',
    warning: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 14 13H2L8 2.5Z"></path><path d="M8 6.4v3"></path><path d="M8 11.2v.1"></path></svg>',
    info: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><path d="M8 7.2v3.2"></path><path d="M8 5.2v.1"></path></svg>',
    hint: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="2.6"></circle></svg>',
  };

  function createProblemsFilter() {
    const state = { text: '', error: true, warning: true, info: true, activeOnly: false };

    function isActive() {
      return Boolean(state.text.trim()) || !state.error || !state.warning || !state.info || state.activeOnly;
    }

    function clear() {
      Object.assign(state, { text: '', error: true, warning: true, info: true, activeOnly: false });
    }

    function toggle(key) {
      if (TOGGLES.includes(key)) state[key] = !state[key];
    }

    // Narrows model groups ({ path, items, worst }) to the markers that pass;
    // `total` is the unfiltered marker count (returned as `shown` when inactive).
    function apply(groups, activePath, total) {
      if (!isActive()) return { groups, shown: total };
      const needle = state.text.trim().toLowerCase();
      const out = [];
      let shown = 0;
      for (const group of groups) {
        if (state.activeOnly && group.path !== String(activePath || '')) continue;
        const items = group.items.filter((marker) => {
          if (!state[marker.severity === 'hint' ? 'info' : marker.severity]) return false;
          if (!needle) return true;
          return [marker.message, marker.source, marker.code, group.path].join('\n').toLowerCase().includes(needle);
        });
        if (items.length) {
          out.push({ path: group.path, items, worst: group.worst });
          shown += items.length;
        }
      }
      return { groups: out, shown };
    }

    return { state, isActive, clear, toggle, apply };
  }

  // Worst-first ordering for file groups + the statusbar/summary buckets.
  const SEVERITY_ORDER = { error: 0, warning: 1, info: 2, hint: 3 };

  // Markers ({ path, line, column, severity, ... }) -> { groups, counts }: one group per
  // file (rows by line, column), files by worst severity then path, plus the severity
  // counts the statusbar reads.
  function groupMarkers(markers) {
    const byPath = new Map();
    const counts = { error: 0, warning: 0, info: 0, hint: 0, total: 0 };
    for (const marker of markers || []) {
      counts[marker.severity] = (counts[marker.severity] || 0) + 1;
      counts.total += 1;
      if (!byPath.has(marker.path)) byPath.set(marker.path, []);
      byPath.get(marker.path).push(marker);
    }
    const groups = [...byPath.entries()].map(([path, items]) => {
      items.sort((a, b) => (a.line - b.line) || (a.column - b.column));
      const worst = items.reduce((acc, marker) => Math.min(acc, SEVERITY_ORDER[marker.severity] ?? 3), 3);
      return { path, items, worst };
    });
    groups.sort((a, b) => (a.worst - b.worst) || a.path.localeCompare(b.path));
    return { groups, counts };
  }

  // The panel paints at most MAX_ROWS marker rows (cleanup T4): groups past the cap drop,
  // the group at the edge keeps its first rows (its header still counts them all: `total`),
  // and a collapsed group costs nothing. -> { groups, capped }
  const MAX_ROWS = 1000;
  function capRows(groups, isCollapsed, limit) {
    const max = Number.isFinite(limit) ? limit : MAX_ROWS;
    const out = [];
    let rows = 0;
    for (const group of groups) {
      if (isCollapsed(group.path)) {
        out.push(group);
        continue;
      }
      const room = max - rows;
      if (room <= 0) return { groups: out, capped: true };
      if (group.items.length > room) {
        out.push({ path: group.path, items: group.items.slice(0, room), worst: group.worst, total: group.items.length });
        return { groups: out, capped: true };
      }
      out.push(group);
      rows += group.items.length;
    }
    return { groups: out, capped: false };
  }

  function fileNameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  function parentDirOf(path) {
    const index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : String(path).slice(0, index);
  }

  // F8 / Shift+F8: every listed marker in path, line, column order, the first one
  // strictly after (direction > 0) or before the cursor spot, wrapping at either end.
  function compareSpot(a, b) {
    return String(a.path).localeCompare(String(b.path)) || (a.line - b.line) || (a.column - b.column);
  }

  function findAdjacentProblem(groups, from, direction) {
    const flat = [];
    for (const group of groups || []) {
      for (const marker of group.items || []) flat.push(marker);
    }
    if (!flat.length) return null;
    flat.sort(compareSpot);
    if (direction > 0) return flat.find((marker) => compareSpot(marker, from) > 0) || flat[0];
    for (let i = flat.length - 1; i >= 0; i -= 1) {
      if (compareSpot(flat[i], from) < 0) return flat[i];
    }
    return flat[flat.length - 1];
  }

  // The toolbar's actions region: severity chips with counts, "Active file only"
  // and Collapse / Expand All, rendered through the inventory action-button.
  function buildToolbarActionsMarkup({ actionButton, escapeHtml, filter, counts, severityIcons, allCollapsed, hasGroups }) {
    const names = {
      error: jt('ide.problems.filterErrors', 'Errors'),
      warning: jt('ide.problems.filterWarnings', 'Warnings'),
      info: jt('ide.problems.filterInfo', 'Info'),
    };
    const chips = ['error', 'warning', 'info'].map((severity) => {
      const count = severity === 'info' ? (counts.info || 0) + (counts.hint || 0) : (counts[severity] || 0);
      return actionButton({
        plain: true,
        className: 'ide-prb-filter-chip',
        ariaPressed: filter[severity],
        title: names[severity],
        ariaLabel: `${names[severity]}: ${count}`,
        dataset: { 'ide-prb-severity': severity },
        trustedHtml: `<span class="ide-prb-chip-icon" data-diag-severity="${severity}" aria-hidden="true">${severityIcons[severity]}</span>`
          + `<span class="ide-prb-chip-count" aria-hidden="true">${escapeHtml(String(count))}</span>`,
      });
    }).join('');
    const activeOnly = actionButton({
      plain: true,
      className: 'ide-prb-filter-chip ide-prb-active-only',
      ariaPressed: filter.activeOnly,
      dataset: { 'ide-prb-active-only': '1' },
      label: jt('ide.problems.activeFileOnly', 'Active file only'),
    });
    const collapseTitle = allCollapsed ? jt('ide.problems.expandAll', 'Expand All') : jt('ide.problems.collapseAll', 'Collapse All');
    const collapse = actionButton({
      plain: true,
      className: 'ide-prb-collapse-all',
      title: collapseTitle,
      ariaLabel: collapseTitle,
      disabled: !hasGroups,
      dataset: { 'ide-prb-action': 'collapse-all' },
      trustedHtml: (allCollapsed ? GLYPHS.expandAll : GLYPHS.collapseAll) || '',
    });
    return `<div class="ide-prb-toolbar-actions">${chips}${activeOnly}${collapse}</div>`;
  }

  return { createProblemsFilter, groupMarkers, findAdjacentProblem, buildToolbarActionsMarkup, capRows, fileNameOf, parentDirOf, GLYPHS, SEVERITY_ICON, MAX_ROWS };
});
