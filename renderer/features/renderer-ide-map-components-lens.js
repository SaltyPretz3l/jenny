/* renderer/features/renderer-ide-map-components-lens.js - the File Map's
 * Components lens (row 77 phase 3): the workspace's drafted component tree
 * (`graph.components`, services/workspace-file-map-components.js) drawn one
 * level at a time as boxes in the atlas's district style, importers above what
 * they import, with weighted import links. A box opens onto its own components
 * or, when it is not split further, onto its files; a file hands off to the
 * atlas. Tests, docs and other files sit beside the boxes in the bucket-chip
 * strip. Layout, labels and link choice live in the pure
 * renderer-ide-map-components-model.js; this module owns the DOM.
 *
 * ── Public interface — createComponentsLens(deps) → lens ──────────────────
 * deps:
 *   viewportEl    (Element) the map viewport; the lens, its status line and
 *                 its beside strip are appended here.
 *   controlsEl    (Element?) the controls bar; the lens starts below it.
 *   escapeHtml    (fn?) shared escaper.
 *   onRevealFile  (fn?) (path) => void. A file row was chosen.
 *   onShowAtlas   (fn?) () => void. "Show the atlas" from the unavailable state.
 *   log           (fn?) (level, event, fields) => void. Draft failures, once per graph.
 *   windowRef     (object?) ResizeObserver / requestAnimationFrame source.
 * lens: update(graph), show(), hide(), isVisible(), setSearch(text), dispose().
 *
 * Markup is inventory actionButton({ plain: true }) for every control (boxes,
 * breadcrumb links, file rows) so it passes check_no_raw_html_primitives.py.
 * Styles: styles/ide-file-map-components.css.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapComponentsLens = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count: count }, params || {})); };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }
  const model = resolveModule('rendererIdeMapComponentsModel', './renderer-ide-map-components-model');
  const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
  const langClassFor = (globalRef.rendererIdeMapAtlasLayout && globalRef.rendererIdeMapAtlasLayout.langClassFor)
    || require('./renderer-ide-map-atlas-layout').langClassFor;
  const defaultEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const STATUS_LIMIT = 6;
  // A leaf lists its files a page at a time ("Show N more files").
  const LEAF_PAGE = 200;
  let instanceCount = 0;

  function noop() {}
  function fmt(n) {
    return Number(n || 0).toLocaleString(globalThis.jennyI18n?.tag?.());
  }
  // The model's label descriptors, worded here with literal keys for the
  // string ledger.
  function word(descriptor) {
    const p = descriptor.params;
    switch (descriptor.key) {
      case undefined: return descriptor.text;
      case 'ide.map.components.label.familyMore': return jt('ide.map.components.label.familyMore', '{name} and more', p);
      case 'ide.map.components.label.residual': return jt('ide.map.components.label.residual', '{name} (rest)', p);
      case 'ide.map.components.label.other': return jt('ide.map.components.label.other', 'Other files');
      case 'ide.map.components.label.otherWord': return jt('ide.map.components.label.otherWord', 'Other {word} files', p);
      case 'ide.map.components.label.all': return jt('ide.map.components.label.all', 'All files');
      case 'ide.map.components.label.ungrouped': return jt('ide.map.components.label.ungrouped', 'Ungrouped files');
      case 'ide.map.components.label.topLevel': return jt('ide.map.components.label.topLevel', 'Top-level files');
      case 'ide.map.components.label.filesIn': return jt('ide.map.components.label.filesIn', 'Files directly in {dir}/', p);
      default: return String(descriptor.key);
    }
  }
  function filesText(n) {
    return jtn('ide.map.components.fileCount', n, { n: fmt(n) }, '{n} file', '{n} files');
  }
  function howText(kind) {
    if (kind === 'families') return jt('ide.map.components.how.families', 'grouped by file-name families');
    if (kind === 'roles') return jt('ide.map.components.how.roles', 'grouped by role words');
    if (kind === 'merged') return jt('ide.map.components.how.merged', 'grouped by the folders merged here');
    return jt('ide.map.components.how.folder', 'grouped by folder');
  }
  function outsideName(id) {
    if (id === 'tests') return jt('ide.map.components.outside.tests', 'tests');
    if (id === 'docs') return jt('ide.map.components.outside.docs', 'docs');
    return jt('ide.map.components.outside.other', 'other');
  }
  function outsideTitle(id) {
    if (id === 'tests') return jt('ide.map.components.outside.testsTitle', 'Test files: beside the components, not in them');
    if (id === 'docs') return jt('ide.map.components.outside.docsTitle', 'Docs and examples');
    return jt('ide.map.components.outside.otherTitle', 'Config, build output and other files that are not source');
  }
  function importersText(group, n) {
    const params = { n: fmt(n) };
    if (group === 'tests') return jtn('ide.map.components.importers.tests', n, params, '{n} test file imports this', '{n} test files import this');
    if (group === 'docs') return jtn('ide.map.components.importers.docs', n, params, '{n} doc imports this', '{n} docs import this');
    return jtn('ide.map.components.importers.other', n, params, '{n} other file imports this', '{n} other files import this');
  }

  function createComponentsLens(deps) {
    const d = deps || {};
    const viewportEl = d.viewportEl;
    const controlsEl = d.controlsEl || null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;
    const onRevealFile = typeof d.onRevealFile === 'function' ? d.onRevealFile : noop;
    const onShowAtlas = typeof d.onShowAtlas === 'function' ? d.onShowAtlas : noop;
    const log = typeof d.log === 'function' ? d.log : noop;
    const windowRef = d.windowRef || globalRef;
    const documentRef = viewportEl.ownerDocument;
    instanceCount += 1;
    const markerPrefix = `ide-components-head-${instanceCount}`;

    let graph = null;
    let draft = null;
    let index = null;
    let scopeId = null;
    let openPath = [];
    let relations = [];
    let hoverId = null;
    let besideHover = null;
    let search = '';
    let visible = false;
    let disposed = false;
    let loggedFor = null;
    let frame = null;
    let leafFiles = [];
    let leafBase = '';
    let leafShown = 0;

    const lensEl = documentRef.createElement('div');
    lensEl.className = 'ide-map-components hidden';
    lensEl.tabIndex = -1;
    lensEl.setAttribute('role', 'region');
    lensEl.setAttribute('aria-label', jt('ide.map.components.region', 'Components'));
    const statusEl = documentRef.createElement('div');
    statusEl.className = 'ide-components-status hidden';
    const besideEl = documentRef.createElement('div');
    besideEl.className = 'ide-atlas-bucket-strip ide-components-beside hidden';
    viewportEl.appendChild(lensEl);
    viewportEl.appendChild(statusEl);
    viewportEl.appendChild(besideEl);

    const observers = [];
    const Observer = windowRef.ResizeObserver;
    if (typeof Observer === 'function') {
      const lensObserver = new Observer(() => scheduleLinks());
      lensObserver.observe(lensEl);
      observers.push(lensObserver);
      if (controlsEl) {
        const controlsObserver = new Observer(() => applyInset());
        controlsObserver.observe(controlsEl);
        observers.push(controlsObserver);
      }
    }

    // The lens starts under the controls bar, which wraps at narrow widths
    // (the same measured inset the atlas transform uses).
    function applyInset() {
      if (!controlsEl || disposed) return;
      lensEl.style.paddingTop = `${controlsEl.offsetTop + controlsEl.offsetHeight + 14}px`;
    }

    function labelOf(component) {
      const parent = component.parentId == null ? null : index.byId.get(component.parentId);
      return word(model.labelFor(component, parent, index.filesOf));
    }

    function crumbsHtml() {
      const chain = [];
      for (let id = scopeId; id != null; id = index.byId.get(id).parentId) chain.unshift(index.byId.get(id));
      const rootLabel = jt('ide.map.components.root', 'Workspace');
      const item = (label, id, current) => (current
        ? `<span class="ide-components-crumb" aria-current="page">${escapeHtml(label)}</span>`
        : actionButton({ plain: true, className: 'ide-components-crumb', label, dataset: { scope: id == null ? 'root' : id } }));
      const parts = [item(rootLabel, null, chain.length === 0)];
      chain.forEach((component, i) => {
        parts.push('<span class="ide-components-crumb-sep" aria-hidden="true">›</span>');
        parts.push(item(labelOf(component), component.id, i === chain.length - 1));
      });
      return `<nav class="ide-components-crumbs" aria-label="${escapeHtml(jt('ide.map.components.path', 'Component path'))}">${parts.join('')}</nav>`;
    }

    function headHtml(caption) {
      return `<div class="ide-components-head">${crumbsHtml()}<span class="ide-components-caption">${escapeHtml(caption)}</span></div>`;
    }

    function partialSuffix(parts) {
      if (graph && graph.meta && graph.meta.truncated === true) parts.push(jt('ide.map.components.partial', 'partial map'));
      return parts.join(' · ');
    }

    function boxHtml(component, largest) {
      const files = index.filesOf(component.id);
      const segments = model.languageMix(files, langClassFor, 4)
        .map(([lang, n]) => `<span class="ide-atlas-langseg ide-atlas-langseg--${escapeHtml(lang)}" style="flex:${n}"></span>`).join('');
      const hits = search ? model.searchCount(files, search) : 0;
      const extra = hits
        ? `<span class="ide-components-extra is-match">${escapeHtml(jtn('ide.map.components.matches', hits, { n: fmt(hits) }, '{n} match', '{n} matches'))}</span>`
        : '';
      const dim = Boolean(search) && !hits;
      const label = labelOf(component);
      const loose = component.label && component.label.kind === 'loose';
      return actionButton({
        plain: true,
        className: `ide-components-box${loose ? ' ide-components-box--loose' : ''}${dim ? ' is-dim' : ''}`,
        dataset: { component: component.id },
        title: label,
        style: `--box-w:${model.boxWidth(component.fileCount, largest)}px`,
        trustedHtml: `<span class="ide-components-name">${escapeHtml(label)}</span>`
          + `<span class="ide-components-meta"><span>${escapeHtml(filesText(component.fileCount))}</span><span class="ide-atlas-langbar">${segments}</span></span>`
          + extra,
      });
    }

    function renderDiagram(children) {
      relations = model.levelRelations(draft, scopeId);
      const total = children.reduce((sum, c) => sum + c.fileCount, 0);
      const largest = Math.max(1, ...children.map((c) => c.fileCount));
      const caption = partialSuffix([
        jtn('ide.map.components.caption', children.length, { files: fmt(total), n: children.length }, '{files} files in {n} component', '{files} files in {n} components'),
        howText(model.axisKind(index.scopeOf(scopeId))),
        scopeId == null
          ? jt('ide.map.components.captionRoot', 'source files only; arrows are file imports')
          : jt('ide.map.components.captionLinks', 'arrows are file imports'),
      ]);
      const rows = model.layoutRows(children, relations).map((row) => {
        const label = row.unlinked ? `<div class="ide-components-row-label">${escapeHtml(jt('ide.map.components.unlinked', 'No import links'))}</div>` : '';
        return `<div class="ide-components-row">${label}${row.components.map((c) => boxHtml(c, largest)).join('')}</div>`;
      }).join('');
      lensEl.innerHTML = headHtml(caption)
        + `<div class="ide-components-diagram"><svg class="ide-components-arrows" aria-hidden="true"></svg>${rows}</div>`;
      applyBesideHover();
      scheduleLinks();
    }

    // Hovering a beside chip marks, in place, the root boxes its files import.
    function applyBesideHover() {
      if (search || scopeId != null || !draft) return;
      for (const el of lensEl.querySelectorAll('.ide-components-box')) {
        const id = el.getAttribute('data-component');
        const into = besideHover ? (draft.outsideRelations || []).find((r) => r.from === besideHover && r.to === id) : null;
        const files = into && into.files ? into.files : 0;
        el.classList.toggle('is-dim', Boolean(besideHover) && !files);
        let extra = el.querySelector('.ide-components-extra');
        if (!files) {
          if (extra) extra.remove();
          continue;
        }
        if (!extra) {
          extra = documentRef.createElement('span');
          extra.className = 'ide-components-extra';
          el.appendChild(extra);
        }
        extra.textContent = importersText(besideHover, files);
      }
    }

    function renderLeaf() {
      relations = [];
      const files = index.filesOf(scopeId).slice().sort();
      const base = model.commonDir(files);
      const scope = index.scopeOf(scopeId);
      const kind = model.leafCaptionKind(scope && scope.rung === 'leaf' ? scope : null);
      const reason = kind === 'small'
        ? jt('ide.map.components.leaf.small', 'small enough to read as one list')
        : kind === 'cohesive'
          ? jt('ide.map.components.leaf.cohesive', 'nothing separates these files further')
          : jt('ide.map.components.leaf.unsplit', 'not split further on this scan');
      const parts = [filesText(files.length), reason];
      if (base) parts.push(jt('ide.map.components.leaf.in', 'in {dir}/', { dir: base }));
      // Matches first under a search, so a hit is never past the first page.
      const isHit = (path) => path.toLowerCase().includes(search.toLowerCase());
      leafFiles = search ? files.filter(isHit).concat(files.filter((path) => !isHit(path))) : files;
      leafBase = base;
      leafShown = Math.min(leafFiles.length, Math.max(LEAF_PAGE, leafShown));
      const remaining = leafFiles.length - leafShown;
      const next = Math.min(LEAF_PAGE, remaining);
      const more = remaining > 0
        ? actionButton({ id: 'more-files', plain: true, className: 'ide-components-more', label: jtn('ide.map.components.moreFiles', next, { n: fmt(next) }, 'Show {n} more file', 'Show {n} more files') })
        : '';
      lensEl.innerHTML = headHtml(partialSuffix(parts))
        + `<div class="ide-components-files">${leafFiles.slice(0, leafShown).map(fileRowHtml).join('')}${more}</div>`;
    }

    function fileRowHtml(path) {
      const slash = path.lastIndexOf('/');
      const full = slash < 0 ? '' : path.slice(0, slash);
      // Folders only when the files span several, relative to their shared one.
      const dir = full === leafBase ? '' : full.slice(leafBase ? leafBase.length + 1 : 0);
      const hit = search && path.toLowerCase().includes(search.toLowerCase());
      return actionButton({
        plain: true,
        className: `ide-components-file${hit ? ' is-match' : ''}`,
        dataset: { file: path },
        title: jt('ide.map.components.fileTitle', '{path} · show in the atlas', { path }),
        trustedHtml: `<span class="ide-components-file-dot ide-atlas-langseg--${escapeHtml(langClassFor(path))}"></span>`
          + `<span class="ide-components-file-name">${escapeHtml(path.slice(slash + 1))}</span>`
          + (dir ? `<span class="ide-components-file-dir">${escapeHtml(dir)}</span>` : ''),
      });
    }

    // The next page joins the list; focus moves to its first row.
    function showMoreFiles() {
      const from = leafShown;
      leafShown = Math.min(leafFiles.length, leafShown + LEAF_PAGE);
      renderLeaf();
      const first = lensEl.querySelectorAll('.ide-components-file')[from];
      if (first) first.focus({ preventScroll: true });
    }

    function renderMessage(title, body, withAtlas) {
      relations = [];
      lensEl.innerHTML = '<div class="ide-components-empty">'
        + `<div class="ide-components-empty-title">${escapeHtml(title)}</div>`
        + (body ? `<p>${escapeHtml(body)}</p>` : '')
        + (withAtlas ? actionButton({ id: 'show-atlas', label: jt('ide.map.components.showAtlas', 'Show the atlas') }) : '')
        + '</div>';
    }

    function renderBeside() {
      const groups = draft && Array.isArray(draft.outside) ? draft.outside : [];
      besideEl.classList.toggle('hidden', !visible || !groups.length);
      besideEl.innerHTML = groups.map((g) => `<span class="ide-atlas-bucket-chip" data-beside="${escapeHtml(g.id)}" title="${escapeHtml(outsideTitle(g.id))}">`
        + `<span class="ide-atlas-bucket-glyph">${escapeHtml(outsideName(g.id))}</span> `
        + `<span class="ide-atlas-bucket-count">${escapeHtml(fmt(g.fileCount))}</span></span>`).join('');
    }

    function linkList(list, end) {
      const shown = list.slice(0, STATUS_LIMIT).map((r) => `${labelOf(index.byId.get(r[end]))} ${fmt(r.weight)}`);
      if (list.length > STATUS_LIMIT) shown.push(jt('ide.map.components.more', '+{n} more', { n: list.length - STATUS_LIMIT }));
      return shown.join(', ');
    }

    function renderStatus() {
      const diagram = Boolean(draft && index && index.childrenOf(scopeId).length);
      statusEl.classList.toggle('hidden', !visible || !draft || !index || (!diagram && scopeId == null));
      if (!diagram) {
        statusEl.textContent = jt('ide.map.components.status.files', 'Click a file to show it in the atlas');
        return;
      }
      const hovered = hoverId ? index.byId.get(hoverId) : null;
      if (!hovered) {
        const shown = model.strongLinks(relations).length;
        statusEl.textContent = relations.length
          ? jt('ide.map.components.status.rest', 'Showing the {shown} strongest of {total} links · hover a component for all of its links · click to open it', { shown, total: relations.length })
          : jt('ide.map.components.status.open', 'Click a component to open it');
        return;
      }
      const byWeight = (a, b) => b.weight - a.weight;
      const out = relations.filter((r) => r.from === hoverId).sort(byWeight);
      const inn = relations.filter((r) => r.to === hoverId).sort(byWeight);
      statusEl.innerHTML = `<b>${escapeHtml(labelOf(hovered))}</b> · `
        + (out.length
          ? `<span class="is-out">${escapeHtml(jt('ide.map.components.status.imports', 'imports {list}', { list: linkList(out, 'to') }))}</span>`
          : escapeHtml(jt('ide.map.components.status.importsNothing', 'imports nothing here')))
        + ' · '
        + (inn.length
          ? `<span class="is-in">${escapeHtml(jt('ide.map.components.status.importedBy', 'imported by {list}', { list: linkList(inn, 'from') }))}</span>`
          : escapeHtml(jt('ide.map.components.status.importedByNothing', 'imported by nothing here')));
    }

    function scheduleLinks() {
      if (disposed || !visible) return;
      const raf = typeof windowRef.requestAnimationFrame === 'function' ? windowRef.requestAnimationFrame.bind(windowRef) : (fn) => setTimeout(fn, 0);
      const cancel = typeof windowRef.cancelAnimationFrame === 'function' ? windowRef.cancelAnimationFrame.bind(windowRef) : clearTimeout;
      if (frame !== null) cancel(frame);
      frame = raf(() => {
        frame = null;
        drawLinks();
      });
    }

    // One SVG layer under the boxes: the strong links at rest, every link of
    // the hovered box; a two-way pair draws once with heads at both ends.
    function drawLinks() {
      const svg = lensEl.querySelector('.ide-components-arrows');
      if (!svg || disposed) return;
      const diagram = svg.parentNode;
      const base = diagram.getBoundingClientRect();
      const rects = new Map();
      for (const el of diagram.querySelectorAll('.ide-components-box')) {
        const r = el.getBoundingClientRect();
        const l = r.left - base.left;
        const t = r.top - base.top;
        rects.set(el.getAttribute('data-component'), { l, r: l + r.width, t, b: t + r.height, cx: l + r.width / 2, cy: t + r.height / 2 });
      }
      const strong = new Set(model.strongLinks(relations));
      const drawn = relations.filter((r) => strong.has(r) || (hoverId && (r.from === hoverId || r.to === hoverId)));
      const drawnKeys = new Set(drawn.map((r) => `${r.from}>${r.to}`));
      const heaviest = model.heaviest(relations);
      const paths = [];
      for (const rel of drawn) {
        const back = drawnKeys.has(`${rel.to}>${rel.from}`) ? relations.find((r) => r.from === rel.to && r.to === rel.from) : null;
        if (back && (back.weight > rel.weight || (back.weight === rel.weight && rel.from > rel.to))) continue;
        const s = rects.get(rel.from);
        const t = rects.get(rel.to);
        if (!s || !t) continue;
        let tone = '';
        if (hoverId) tone = rel.from === hoverId || (back && rel.to === hoverId) ? 'out' : rel.to === hoverId ? 'in' : 'dim';
        const head = tone === 'out' || tone === 'in' ? tone : 'rest';
        const total = rel.weight + (back ? back.weight : 0);
        const width = (1 + 3.2 * Math.sqrt(total / heaviest)).toFixed(2);
        const tip = back
          ? jt('ide.map.components.linkPair', '{a} file imports one way, {b} back', { a: fmt(rel.weight), b: fmt(back.weight) })
          : jtn('ide.map.components.link', rel.weight, { n: fmt(rel.weight) }, '{n} file import', '{n} file imports');
        paths.push(`<path class="ide-components-arrow${tone ? ` is-${tone}` : ''}" d="${model.linkPath(s, t)}" stroke-width="${width}"`
          + ` marker-end="url(#${markerPrefix}-${head})"${back ? ` marker-start="url(#${markerPrefix}-${head})"` : ''}><title>${escapeHtml(tip)}</title></path>`);
      }
      const marker = (kind) => `<marker id="${markerPrefix}-${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"`
        + ` markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="ide-components-arrow-head ide-components-arrow-head--${kind}" d="M0,1 L10,5 L0,9 z"/></marker>`;
      svg.innerHTML = `<defs>${marker('rest')}${marker('out')}${marker('in')}</defs>${paths.join('')}`;
    }

    function setHover(id) {
      if (hoverId === id) return;
      hoverId = id;
      for (const el of lensEl.querySelectorAll('.ide-components-box')) {
        const boxId = el.getAttribute('data-component');
        el.classList.toggle('is-hover', boxId === id);
        if (search || besideHover) continue;
        const linked = id && (boxId === id || relations.some((r) => (r.from === id && r.to === boxId) || (r.to === id && r.from === boxId)));
        el.classList.toggle('is-dim', Boolean(id) && !linked);
      }
      drawLinks();
      renderStatus();
    }

    function render() {
      if (disposed) return;
      hoverId = null;
      // No graph yet, or a failed/empty scan: the map's state panel speaks.
      lensEl.classList.toggle('hidden', !graph);
      if (!graph) {
        lensEl.innerHTML = '';
      } else if (!draft) {
        renderMessage(
          jt('ide.map.components.unavailable', 'Components aren’t available for this map'),
          jt('ide.map.components.unavailableBody', 'The grouping is turned off, or it failed on this scan. The atlas still shows every file.'),
          true,
        );
      } else if (!index.childrenOf(null).length) {
        renderMessage(jt('ide.map.components.empty', 'No source files to group'), '', false);
      } else {
        const children = index.childrenOf(scopeId);
        if (children.length) renderDiagram(children);
        else renderLeaf();
      }
      renderBeside();
      renderStatus();
    }

    function openScope(id) {
      scopeId = id;
      leafShown = 0;
      openPath = id == null ? [] : model.namePath(index, id);
      render();
      lensEl.scrollTop = 0;
      if (typeof lensEl.focus === 'function') lensEl.focus({ preventScroll: true });
    }

    function onClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const crumb = target.closest('[data-scope]');
      if (crumb) {
        const id = crumb.getAttribute('data-scope');
        openScope(id === 'root' ? null : id);
        return;
      }
      const componentEl = target.closest('[data-component]');
      if (componentEl) {
        openScope(componentEl.getAttribute('data-component'));
        return;
      }
      const fileEl = target.closest('[data-file]');
      if (fileEl) {
        onRevealFile(fileEl.getAttribute('data-file'));
        return;
      }
      if (target.closest('[data-action="more-files"]')) showMoreFiles();
      else if (target.closest('[data-action="show-atlas"]')) onShowAtlas();
    }
    function onOver(event) {
      const el = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-component]') : null;
      setHover(el ? el.getAttribute('data-component') : null);
    }
    function onLeave() {
      setHover(null);
    }
    function onKeydown(event) {
      if ((event.key === 'Escape' || event.key === 'Backspace') && scopeId != null && index) {
        event.preventDefault();
        openScope(index.byId.get(scopeId).parentId == null ? null : index.byId.get(scopeId).parentId);
      }
    }
    function onBesideOver(event) {
      const chip = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-beside]') : null;
      const next = chip ? chip.getAttribute('data-beside') : null;
      if (next === besideHover) return;
      besideHover = next;
      applyBesideHover();
    }

    const listeners = [
      [lensEl, 'click', onClick], [lensEl, 'mouseover', onOver], [lensEl, 'focusin', onOver],
      [lensEl, 'mouseleave', onLeave], [lensEl, 'keydown', onKeydown],
      [besideEl, 'mouseover', onBesideOver], [besideEl, 'mouseleave', onBesideOver],
    ];
    for (const [el, type, fn] of listeners) el.addEventListener(type, fn);

    // A rescan rebuilds the lens: focus stays on the same file row or box
    // (boxes by name, since ids renumber), else on the lens itself.
    function captureFocus() {
      const active = documentRef.activeElement;
      if (!active || !lensEl.contains(active)) return null;
      const id = active.getAttribute('data-component');
      return { file: active.getAttribute('data-file'), name: id && index ? (index.byId.get(id) || {}).name : null };
    }
    function restoreFocus(saved) {
      if (!saved || lensEl.classList.contains('hidden')) return;
      const match = Array.from(lensEl.querySelectorAll('[data-file], [data-component]')).find((el) => (saved.file
        ? el.getAttribute('data-file') === saved.file
        : Boolean(saved.name && index && (index.byId.get(el.getAttribute('data-component')) || {}).name === saved.name)));
      (match || lensEl).focus({ preventScroll: true });
    }

    function update(nextGraph) {
      if (disposed) return;
      const saved = visible ? captureFocus() : null;
      graph = nextGraph || null;
      const next = graph && graph.components && typeof graph.components === 'object' && Array.isArray(graph.components.components)
        ? graph.components
        : null;
      draft = next;
      index = next ? model.indexComponents(next) : null;
      scopeId = index ? model.resolvePath(index, openPath) : null;
      if (graph && !draft && loggedFor !== graph && graph.meta && graph.meta.componentsError) {
        loggedFor = graph;
        log('INFO', 'ide_map.components_unavailable', { reason: String(graph.meta.componentsError).slice(0, 256) });
      }
      if (!visible) return;
      render();
      restoreFocus(saved);
    }

    function show() {
      if (disposed) return;
      visible = true;
      applyInset();
      render();
    }

    function hide() {
      if (disposed) return;
      visible = false;
      hoverId = null;
      besideHover = null;
      lensEl.classList.add('hidden');
      statusEl.classList.add('hidden');
      besideEl.classList.add('hidden');
    }

    function setSearch(text) {
      const next = String(text || '').trim();
      if (next === search) return;
      search = next;
      if (visible) render();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const observer of observers) observer.disconnect();
      if (frame !== null && typeof windowRef.cancelAnimationFrame === 'function') windowRef.cancelAnimationFrame(frame);
      for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
      lensEl.remove();
      statusEl.remove();
      besideEl.remove();
      graph = null;
      draft = null;
      index = null;
    }

    return { update, show, hide, isVisible: () => visible, setSearch, dispose };
  }

  return { createComponentsLens };
});
