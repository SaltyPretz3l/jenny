/* renderer/features/renderer-ide-map-overview.js - Workspace File Map's
 * Project Overview panel (P5 scope): a derived, DOM-free summary of the
 * current graph (file/edge counts, top directories, language mix, entry
 * points, findings counts) plus the Ask-the-Map composer affordance — a
 * question field + "Ask Jenny" button that prefills the chat composer with
 * a bounded text summary of the graph via `onAsk({kind:'file_map_query', ...})`
 * (wired to `renderer-ide-send-utils.js`'s buildSendToJennyText branch).
 *
 * Two pure, DOM-free exports for unit testing:
 *   deriveOverview(graph)              → { fileCount, edgeCount, topDirs,
 *                                          languages, entryPoints, hubs,
 *                                          cycles, orphans }
 *   serializeGraphSummary(graph)        → bounded text (≤ SUMMARY_CHAR_CAP
 *                                          chars), used as the Ask-the-Map
 *                                          payload.summary.
 *
 * ── Public interface — createMapOverview(deps) → controller ────────────────
 * deps:
 *   hostEl      (Element) mount point; innerHTML fully owned here. Caller
 *               appends this element to the map viewport and starts it
 *               with the 'hidden' class (see renderer-ide-map-controller.js).
 *   escapeHtml  (fn?)     shared escaper.
 *   onAsk       (fn?)     ({kind:'file_map_query', question, summary}) => void.
 *   onClose     (fn?)     () => void. Called by the panel's close button (in
 *               addition to hide(), which the controller also calls itself).
 *
 * controller methods:
 *   update(graph)     Rebuilds the panel markup from the current graph.
 *   show()            Removes the 'hidden' class from hostEl.
 *   hide()             Adds the 'hidden' class to hostEl.
 *   isVisible()       → boolean.
 *   dispose()         Removes listeners + clears hostEl. Idempotent.
 *
 * Markup uses the owner-authored classes in styles/ide-file-map.css
 * (ide-map-overview, -title, -section, -heading, -row, -path, -count, -chips,
 * -ask) and inventory primitives exclusively (actionButton/textField/chip) so
 * it passes check_no_raw_html_primitives.py.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapOverview = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
  const textField = resolveModule('inventoryTextField', '../inventory/text-field');
  const chip = resolveModule('inventoryChip', '../inventory/chip');

  const defaultEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // Bounded so a huge workspace never balloons the composer prefill.
  const SUMMARY_CHAR_CAP = 4000;
  const TRUNCATION_MARKER = '… (truncated)';

  // The atlas's language classes (pure, DOM-free; loads earlier in the IDE
  // script manifest): 7 named classes plus 'other'.
  const { langClassFor } = globalThis.rendererIdeMapAtlasLayout || require('./renderer-ide-map-atlas-layout');
  const LANGUAGE_SLOTS = 8;

  function dirOf(relPath) {
    const path = String(relPath || '');
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '.' : path.slice(0, idx);
  }

  function topNByCount(map, n) {
    return Array.from(map.entries())
      .sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))
      .slice(0, n);
  }

  // Pure, DOM-free: derives the overview stats from a graph shape
  // { nodes: [{id, inbound, outbound, importance, isTest}], edges, findings }.
  function deriveOverview(graph) {
    const g = graph || {};
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    const edges = Array.isArray(g.edges) ? g.edges : [];
    const findings = g.findings || {};

    const dirCounts = new Map();
    const langCounts = new Map();
    // Ignored-directory bucket pseudo-nodes are rollups, not files.
    const files = nodes.filter((node) => node && typeof node.id === 'string' && !node.bucket);
    for (const node of files) {
      const dir = dirOf(node.id);
      dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
      const lang = langClassFor(node.id);
      langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    }
    const topDirs = topNByCount(dirCounts, 5).map(([dir, count]) => ({ dir, count }));
    const languages = topNByCount(langCounts, LANGUAGE_SLOTS)
      .map(([lang, count]) => ({ lang, count }));

    // Entry points: files with zero inbound edges, ranked by outbound
    // (biggest "roots" first); fall back to top importance when every node
    // has at least one inbound edge (no clear entry points by that signal).
    const zeroInbound = files.filter((n) => (Number(n.inbound) || 0) === 0);
    const pool = zeroInbound.length > 0 ? zeroInbound : files;
    const entryPoints = pool
      .slice()
      .sort((a, b) => {
        const byOutbound = (Number(b.outbound) || 0) - (Number(a.outbound) || 0);
        if (byOutbound !== 0) return byOutbound;
        const byImportance = (Number(b.importance) || 0) - (Number(a.importance) || 0);
        if (byImportance !== 0) return byImportance;
        return String(a.id).localeCompare(String(b.id));
      })
      .slice(0, 5)
      .map((n) => n.id);

    return {
      fileCount: files.length,
      edgeCount: edges.length,
      topDirs,
      languages,
      entryPoints,
      hubs: Array.isArray(findings.hubs) ? findings.hubs.length : 0,
      cycles: Array.isArray(findings.cycles) ? findings.cycles.length : 0,
      orphans: Array.isArray(findings.orphans) ? findings.orphans.length : 0,
    };
  }

  // Appends a line only if doing so keeps the running text within the cap;
  // otherwise appends the truncation marker (once) and stops accepting more.
  function makeBoundedWriter(cap) {
    const lines = [];
    let total = 0;
    let truncated = false;
    function push(line) {
      if (truncated) return;
      const addition = (lines.length > 0 ? 1 : 0) + line.length;
      if (total + addition > cap) {
        truncated = true;
        return;
      }
      lines.push(line);
      total += addition;
    }
    function finish() {
      if (truncated) {
        // Reserve room for the marker by dropping tail lines if needed.
        let text = lines.join('\n');
        const markerAddition = (text.length > 0 ? 1 : 0) + TRUNCATION_MARKER.length;
        while (text.length + markerAddition > cap && lines.length > 0) {
          lines.pop();
          text = lines.join('\n');
        }
        return text + (text.length > 0 ? '\n' : '') + TRUNCATION_MARKER;
      }
      return lines.join('\n');
    }
    return { push, finish };
  }

  // Row 77: the drafted component tree (graph.components from
  // services/workspace-file-map-components.js) as summary lines: the root
  // components largest first with what each opens onto, the strongest root
  // links, and the tests/docs/other groups beside them. Each line is bounded
  // so the directories and hubs still fit under the cap.
  const COMPONENT_LINE_CHARS = 160;
  const COMPONENT_LINKS = 8;
  const OUTSIDE_TARGETS = 3;

  function bySize(a, b) {
    return (b.fileCount - a.fileCount) || String(a.name).localeCompare(String(b.name));
  }

  function boundedList(head, items, limit) {
    let line = head;
    for (let i = 0; i < items.length; i += 1) {
      const more = items.length - i;
      const next = `${line}${i ? ', ' : ''}${items[i]}`;
      // Keep room for the ", +N more" tail unless this is the last item.
      if (next.length + (more > 1 ? 10 : 0) > limit) return `${line}${i ? ', ' : ''}+${more} more`;
      line = next;
    }
    return line;
  }

  function componentSummaryLines(draft) {
    const list = draft && Array.isArray(draft.components) ? draft.components : [];
    const valid = list.filter((c) => c && typeof c.id === 'string' && Number.isFinite(c.fileCount));
    const roots = valid.filter((c) => c.parentId === null).sort(bySize);
    if (!roots.length) return [];
    const names = new Map(valid.map((c) => [c.id, c.name]));
    const lines = [`Components (source files; ${roots.length} at the top level):`];
    for (const root of roots) {
      const inside = valid.filter((c) => c.parentId === root.id).sort(bySize).map((c) => `${c.name} ${c.fileCount}`);
      const head = `- ${root.name}: ${root.fileCount} files`;
      lines.push(inside.length ? boundedList(`${head}; inside: `, inside, COMPONENT_LINE_CHARS) : head);
    }
    const links = (Array.isArray(draft.relations) ? draft.relations : [])
      .filter((r) => r && r.scopeId === 'root' && names.has(r.from) && names.has(r.to))
      .sort((a, b) => (b.weight - a.weight) || String(a.from).localeCompare(String(b.from)) || String(a.to).localeCompare(String(b.to)))
      .slice(0, COMPONENT_LINKS);
    if (links.length) {
      lines.push('Links between components (importer -> imported: file imports):');
      for (const r of links) lines.push(`- ${names.get(r.from)} -> ${names.get(r.to)}: ${r.weight}`);
    }
    const groups = (Array.isArray(draft.outside) ? draft.outside : []).filter((o) => o && Number.isFinite(o.fileCount));
    if (groups.length) {
      const into = Array.isArray(draft.outsideRelations) ? draft.outsideRelations : [];
      const parts = groups.map((group) => {
        const targets = into
          .filter((r) => r && r.from === group.id && names.has(r.to))
          .sort((a, b) => (b.files - a.files) || String(a.to).localeCompare(String(b.to)));
        const shown = targets.slice(0, OUTSIDE_TARGETS).map((r) => `${names.get(r.to)} ${r.files}`);
        if (targets.length > OUTSIDE_TARGETS) shown.push(`+${targets.length - OUTSIDE_TARGETS} more`);
        return `${group.id} ${group.fileCount} files${shown.length ? ` (importing ${shown.join(', ')})` : ''}`;
      });
      lines.push(`Beside the components: ${parts.join(', ')}.`);
    }
    return lines;
  }

  // Bounded text summary of the graph for the Ask-the-Map composer prefill.
  // Hard cap: SUMMARY_CHAR_CAP characters, never truncated mid-line.
  function serializeGraphSummary(graph) {
    const g = graph || {};
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    const overview = deriveOverview(g);
    const w = makeBoundedWriter(SUMMARY_CHAR_CAP);

    w.push(`Project: ${overview.fileCount} files, ${overview.edgeCount} edges.`);
    w.push(
      `Findings: ${overview.hubs} hub(s), ${overview.cycles} cycle(s), ${overview.orphans} orphan(s).`
    );

    for (const line of componentSummaryLines(g.components)) w.push(line);

    w.push('Top directories:');
    for (const { dir, count } of overview.topDirs) {
      w.push(`- ${dir} (${count})`);
    }

    const topHubs = nodes
      .slice()
      .sort((a, b) => (Number(b.inbound) || 0) - (Number(a.inbound) || 0))
      .slice(0, 10);
    w.push('Top hubs (by inbound):');
    for (const node of topHubs) {
      if (!node || typeof node.id !== 'string') continue;
      w.push(`- ${node.id} (in:${Number(node.inbound) || 0}, out:${Number(node.outbound) || 0})`);
    }

    return w.finish();
  }

  function renderRow(escapeHtml, path, countText) {
    return ''
      + '<div class="ide-map-overview-row">'
      + `<span class="ide-map-overview-path">${escapeHtml(path)}</span>`
      + `<span class="ide-map-overview-count">${escapeHtml(countText)}</span>`
      + '</div>';
  }

  function createMapOverview(deps) {
    const d = deps || {};
    const hostEl = d.hostEl || null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;
    const onAsk = typeof d.onAsk === 'function' ? d.onAsk : noop;
    const onClose = typeof d.onClose === 'function' ? d.onClose : noop;

    let disposed = false;
    let visible = false;
    let currentGraph = null;
    let questionInputEl = null;

    function render() {
      if (!hostEl || disposed) return;
      const overview = deriveOverview(currentGraph);
      const parts = [];
      parts.push('<div class="ide-map-overview-title">'
        + '<span>' + escapeHtml(jt('ide.map.overview.projectOverview', 'Project Overview')) + '</span>'
        + (typeof actionButton === 'function'
          ? actionButton({ id: 'close', label: '×', plain: true, className: 'ide-map-overview-close', ariaLabel: jt('ide.map.overview.close', 'Close overview'), title: jt('ide.map.overview.close', 'Close overview') })
          : '')
        + '</div>');

      parts.push('<div class="ide-map-overview-section">'
        + '<div class="ide-map-overview-heading">Files &amp; edges</div>'
        + renderRow(escapeHtml, 'Files', String(overview.fileCount))
        + renderRow(escapeHtml, 'Edges', String(overview.edgeCount))
        + '</div>');

      parts.push('<div class="ide-map-overview-section">'
        + '<div class="ide-map-overview-heading">' + escapeHtml(jt('ide.map.overview.topDirectories', 'Top directories')) + '</div>'
        + overview.topDirs.map((entry) => renderRow(escapeHtml, entry.dir, String(entry.count))).join('')
        + '</div>');

      const languageChips = overview.languages.map((entry) => {
        if (typeof chip === 'function') {
          return chip({ id: `lang-${entry.lang}`, label: entry.lang, count: String(entry.count) });
        }
        return `<span class="inv-chip">${escapeHtml(entry.lang)} (${escapeHtml(String(entry.count))})</span>`;
      }).join('');
      parts.push('<div class="ide-map-overview-section">'
        + '<div class="ide-map-overview-heading">Languages</div>'
        + `<div class="ide-map-overview-chips">${languageChips}</div>`
        + '</div>');

      parts.push('<div class="ide-map-overview-section">'
        + '<div class="ide-map-overview-heading">' + escapeHtml(jt('ide.map.overview.entryPoints', 'Entry points')) + '</div>'
        + overview.entryPoints.map((id) => renderRow(escapeHtml, id, '')).join('')
        + '</div>');

      parts.push('<div class="ide-map-overview-section">'
        + '<div class="ide-map-overview-heading">Findings</div>'
        + renderRow(escapeHtml, 'Hubs', String(overview.hubs))
        + renderRow(escapeHtml, 'Cycles', String(overview.cycles))
        + renderRow(escapeHtml, 'Orphans', String(overview.orphans))
        + '</div>');

      // Map key: the non-obvious encodings only (language tint is already
      // shown by the chips above). Swatch colors ride palette-token classes.
      parts.push('<div class="ide-map-overview-section">'
        + '<div class="ide-map-overview-heading">' + escapeHtml(jt('ide.map.overview.mapKey', 'Map key')) + '</div>'
        + '<div class="ide-map-overview-legend">'
        + '<span class="ide-map-overview-legend-swatch ide-map-overview-legend-swatch--activity" aria-hidden="true"></span>'
        + '<span>' + escapeHtml(jt('ide.map.overview.activityLegend', 'Warm glow — Jenny touched it this turn')) + '</span></div>'
        + '<div class="ide-map-overview-legend">'
        + '<span class="ide-map-overview-legend-swatch ide-map-overview-legend-swatch--deps" aria-hidden="true"></span>'
        + '<span>' + escapeHtml(jt('ide.map.overview.dependenciesLegend', 'Rays — the selected file’s imports')) + '</span></div>'
        + '<div class="ide-map-overview-legend">'
        + '<span class="ide-map-overview-legend-swatch ide-map-overview-legend-swatch--health" aria-hidden="true"></span>'
        + '<span>' + escapeHtml(jt('ide.map.overview.healthLegend', 'District tick — size-cap / cycle health')) + '</span></div>'
        + '</div>');

      const questionField = typeof textField === 'function'
        ? textField({
          id: 'ide-map-overview-question',
          value: '',
          placeholder: jt('ide.map.overview.questionPlaceholder', 'Ask about this project…'),
          spellcheck: true,
          className: 'ide-map-overview-question',
          ariaLabel: jt('ide.map.overview.questionLabel', 'Ask the map a question'),
        })
        : '';
      const askButton = typeof actionButton === 'function'
        ? actionButton({ id: 'ask', label: jt('ide.map.overview.askJenny', 'Ask Jenny'), variant: 'primary', className: 'ide-map-overview-ask-btn' })
        : '';
      parts.push(`<div class="ide-map-overview-ask">${questionField}${askButton}</div>`);

      hostEl.innerHTML = parts.join('');
      questionInputEl = hostEl.querySelector('.ide-map-overview-question .inv-text-field-control');
    }

    function handleClick(event) {
      const target = event && event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-action]')
        : null;
      if (!target || disposed) return;
      const action = target.getAttribute('data-action');
      if (action === 'close') {
        hide();
        onClose();
        return;
      }
      if (action === 'ask') {
        const question = String((questionInputEl && questionInputEl.value) || '').trim();
        const summary = serializeGraphSummary(currentGraph);
        onAsk({ kind: 'file_map_query', question, summary });
      }
    }

    function bindEvents() {
      if (!hostEl || typeof hostEl.addEventListener !== 'function') return;
      hostEl.addEventListener('click', handleClick);
    }
    function unbindEvents() {
      if (!hostEl || typeof hostEl.removeEventListener !== 'function') return;
      hostEl.removeEventListener('click', handleClick);
    }

    function update(graph) {
      if (disposed) return;
      currentGraph = graph || null;
      render();
    }

    function show() {
      if (disposed || !hostEl) return;
      visible = true;
      hostEl.classList.remove('hidden');
    }

    function hide() {
      if (disposed || !hostEl) return;
      visible = false;
      hostEl.classList.add('hidden');
    }

    function isVisible() {
      return visible;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      unbindEvents();
      if (hostEl) {
        hostEl.innerHTML = '';
      }
      questionInputEl = null;
      currentGraph = null;
    }

    render();
    bindEvents();

    return {
      update,
      show,
      hide,
      isVisible,
      dispose,
    };
  }

  return {
    createMapOverview,
    deriveOverview,
    serializeGraphSummary,
    SUMMARY_CHAR_CAP,
  };
});
