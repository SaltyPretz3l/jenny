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

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // Bounded so a huge workspace never balloons the composer prefill.
  const SUMMARY_CHAR_CAP = 4000;
  const TRUNCATION_MARKER = '… (truncated)';

  // Reimplemented locally (not imported from renderer-ide-map-view.js) per
  // the plan: this module must stay DOM-free / independently testable.
  const LANG_CLASS_RULES = [
    { re: /\.(mjs|cjs|jsx|js)$/i, cls: 'js' },
    { re: /\.(tsx|ts)$/i, cls: 'ts' },
    { re: /\.py$/i, cls: 'py' },
    { re: /\.css$/i, cls: 'css' },
    { re: /\.(html|htm)$/i, cls: 'html' },
    { re: /\.(md|markdown)$/i, cls: 'md' },
    { re: /\.(json|ya?ml|toml)$/i, cls: 'data' },
  ];

  function langClassFor(relPath) {
    for (const rule of LANG_CLASS_RULES) {
      if (rule.re.test(relPath)) return rule.cls;
    }
    return 'other';
  }

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
    for (const node of nodes) {
      if (!node || typeof node.id !== 'string') continue;
      const dir = dirOf(node.id);
      dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
      const lang = langClassFor(node.id);
      langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    }
    const topDirs = topNByCount(dirCounts, 5).map(([dir, count]) => ({ dir, count }));
    const languages = topNByCount(langCounts, LANG_CLASS_RULES.length + 1)
      .map(([lang, count]) => ({ lang, count }));

    // Entry points: files with zero inbound edges, ranked by outbound
    // (biggest "roots" first); fall back to top importance when every node
    // has at least one inbound edge (no clear entry points by that signal).
    const zeroInbound = nodes.filter((n) => n && (Number(n.inbound) || 0) === 0);
    const pool = zeroInbound.length > 0 ? zeroInbound : nodes.slice();
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
      fileCount: nodes.length,
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
        + '<span>Project Overview</span>'
        + (typeof actionButton === 'function'
          ? actionButton({ id: 'close', label: '×', plain: true, className: 'ide-map-overview-close', ariaLabel: 'Close overview', title: 'Close overview' })
          : '')
        + '</div>');

      parts.push('<div class="ide-map-overview-section">'
        + '<div class="ide-map-overview-heading">Files &amp; edges</div>'
        + renderRow(escapeHtml, 'Files', String(overview.fileCount))
        + renderRow(escapeHtml, 'Edges', String(overview.edgeCount))
        + '</div>');

      parts.push('<div class="ide-map-overview-section">'
        + '<div class="ide-map-overview-heading">Top directories</div>'
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
        + '<div class="ide-map-overview-heading">Entry points</div>'
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
        + '<div class="ide-map-overview-heading">Map key</div>'
        + '<div class="ide-map-overview-legend">'
        + '<span class="ide-map-overview-legend-swatch ide-map-overview-legend-swatch--activity" aria-hidden="true"></span>'
        + '<span>Warm glow — Jenny touched it this turn</span></div>'
        + '<div class="ide-map-overview-legend">'
        + '<span class="ide-map-overview-legend-swatch ide-map-overview-legend-swatch--deps" aria-hidden="true"></span>'
        + '<span>Rays — the selected file’s imports</span></div>'
        + '<div class="ide-map-overview-legend">'
        + '<span class="ide-map-overview-legend-swatch ide-map-overview-legend-swatch--health" aria-hidden="true"></span>'
        + '<span>District tick — size-cap / cycle health</span></div>'
        + '</div>');

      const questionField = typeof textField === 'function'
        ? textField({
          id: 'ide-map-overview-question',
          value: '',
          placeholder: 'Ask about this project…',
          spellcheck: true,
          className: 'ide-map-overview-question',
          ariaLabel: 'Ask the map a question',
        })
        : '';
      const askButton = typeof actionButton === 'function'
        ? actionButton({ id: 'ask', label: 'Ask Jenny', variant: 'primary', className: 'ide-map-overview-ask-btn' })
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
