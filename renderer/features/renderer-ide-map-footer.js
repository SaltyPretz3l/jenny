/* renderer/features/renderer-ide-map-footer.js - the Workspace File Map's
 * footer row: one strip along the bottom edge of the map viewport that owns
 *
 *   start    the Health findings chips (adopted from the findings module,
 *            which keeps owning that element's contents) followed by the
 *            colour KEY - the file types present in the map (plus a ring item
 *            for visible tests), or the three health colours while Health is
 *            on. No key while no map is drawn.
 *   end      a "N files not mapped" trigger that opens a "Left out of the
 *            map" popover (the inventory popover primitive) listing the
 *            ignored-directory rollups and why they are missing. Each row
 *            carries data-map-bucket so the activity rail can heat it; the
 *            trigger shows heat while any row is hot.
 *
 * hostEl is created by the controller inside the map viewport (class
 * `ide-map-footer`); this module owns its innerHTML. Styling lives in
 * styles/ide-file-map-atlas-fit.css; this module assigns classes only.
 *
 * ── Public interface - createMapFooter({hostEl, documentRef, escapeHtml}) ──
 *   .update(model)      model = { buckets, districts, hasTests }
 *                         buckets    layout buckets [{ key, label, count }];
 *                                    key is the ignored dir ('.' = top level)
 *                         districts  public layout districts; depth-1 langMix
 *                                    ([{ cls, count }]) is summed for the key
 *                         hasTests   the map has test files (ring key item)
 *   .setHealth(on)      true swaps the key for the health colours.
 *   .setHideTests(on)   true drops the ring item (no test is visible).
 *   .adoptFindings(el)  Moves the findings host element in as the first child
 *                       of the start group and remembers it across renders.
 *   .dispose()          Clears hostEl. Idempotent.
 *
 * Renders skip when the markup is unchanged; a real re-render keeps the
 * popover open state, a focused trigger, and activity heat on the rows.
 * Escape and click-away come from the inventory popover handlers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapFooter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) { /* unavailable */ }
    }
    return null;
  }

  const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
  const popover = resolveModule('inventoryPopover', '../inventory/popover');
  const defaultEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // The key shows at most this many language classes (most files first).
  const MAX_KEY_LANGS = 6;
  // Literal keys so the i18n ledger can scan them.
  const LANG_LABELS = {
    js: () => jt('ide.map.key.js', 'JavaScript'),
    ts: () => jt('ide.map.key.ts', 'TypeScript'),
    py: () => jt('ide.map.key.py', 'Python'),
    css: () => jt('ide.map.key.css', 'CSS'),
    html: () => jt('ide.map.key.html', 'HTML'),
    md: () => jt('ide.map.key.md', 'Markdown'),
    data: () => jt('ide.map.key.data', 'Data'),
    other: () => jt('ide.map.key.other', 'Other'),
  };

  // Counts in the UI locale (the same formatting the Components lens uses).
  function fmt(n) {
    return Number(n || 0).toLocaleString(globalThis.jennyI18n?.tag?.());
  }

  function langLabel(cls) {
    return (Object.prototype.hasOwnProperty.call(LANG_LABELS, cls) ? LANG_LABELS[cls] : LANG_LABELS.other)();
  }

  // Language classes present across the whole map: depth-1 district mixes
  // already cover their subtrees, so summing them counts each file once.
  function languageOrder(districts) {
    const totals = new Map();
    for (const district of Array.isArray(districts) ? districts : []) {
      if (!district || district.depth !== 1 || !Array.isArray(district.langMix)) continue;
      for (const m of district.langMix) {
        if (!m || !/^[A-Za-z0-9_-]+$/.test(String(m.cls))) continue;
        totals.set(m.cls, (totals.get(m.cls) || 0) + (Number(m.count) || 0));
      }
    }
    return Array.from(totals.entries())
      .filter(([, count]) => count > 0)
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, MAX_KEY_LANGS)
      .map(([cls]) => cls);
  }

  function createMapFooter(deps) {
    const d = deps || {};
    const hostEl = d.hostEl || null;
    const documentRef = d.documentRef || (hostEl && hostEl.ownerDocument) || null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;

    let disposed = false;
    let findingsEl = null;
    let popOpen = false;
    let health = false;
    let hideTests = false;
    let renderedHtml = null;
    let model = { buckets: [], districts: [], hasTests: false };

    if (popover && typeof popover.initPopoverHandlers === 'function') popover.initPopoverHandlers(documentRef);

    function keyItemMarkup(itemClass, dotClass, label) {
      return `<span class="ide-map-key-item${itemClass ? ` ${itemClass}` : ''}">`
        + `<span class="ide-map-key-dot${dotClass ? ` ${dotClass}` : ''}" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
    }

    function keyMarkup() {
      const langs = languageOrder(model.districts);
      if (!langs.length) return '';
      if (health) {
        return keyItemMarkup('', 'is-ok', jt('ide.map.key.healthOk', 'Healthy'))
          + keyItemMarkup('', 'is-amber', jt('ide.map.key.healthAmber', 'Near the size limit or unused'))
          + keyItemMarkup('', 'is-red', jt('ide.map.key.healthRed', 'Over the limit or in a cycle'));
      }
      let html = langs.map((cls) => keyItemMarkup(`ide-map-key--${cls}`, '', langLabel(cls))).join('');
      if (model.hasTests && !hideTests) html += keyItemMarkup('ide-map-key--test', 'is-ring', jt('ide.map.key.test', 'Test'));
      return html;
    }

    function listedBuckets() {
      return (Array.isArray(model.buckets) ? model.buckets : []).filter((b) => b && Number(b.count) > 0);
    }

    function popMarkup(rows) {
      if (!popover) return '';
      const title = jt('ide.map.notMappedTitle', 'Left out of the map');
      const rowsHtml = rows.map((b) => {
        const name = b.key === '.' ? jt('ide.map.notMappedTopLevel', 'Top-level files') : `${b.key}/`;
        return `<div class="ide-map-footer-pop-row" data-map-bucket="${escapeHtml(String(b.key))}">`
          + `<span>${escapeHtml(name)}</span><span>${escapeHtml(fmt(b.count))}</span></div>`;
      }).join('');
      const note = jt('ide.map.notMappedNote', 'Ignored by .gitignore or the built-in skip list (dependencies, build output, caches).');
      return popover({
        id: 'map-not-mapped',
        className: 'ide-map-footer-pop',
        ariaLabel: title,
        trustedHtml: `<div class="ide-map-footer-pop-title">${escapeHtml(title)}</div>${rowsHtml}`
          + `<div class="ide-map-footer-pop-note">${escapeHtml(note)}</div>`,
      });
    }

    function triggerMarkup(total) {
      if (typeof actionButton !== 'function' || total <= 0) return '';
      const label = jtn('ide.map.notMapped', total, { count: fmt(total) }, '{count} file not mapped', '{count} files not mapped');
      return actionButton({
        plain: true,
        className: 'ide-map-footer-unmapped',
        ariaExpanded: false,
        ariaHaspopup: 'dialog',
        label,
      });
    }

    const popEl = () => (hostEl ? hostEl.querySelector('.ide-map-footer-pop') : null);
    const triggerEl = () => (hostEl ? hostEl.querySelector('.ide-map-footer-unmapped') : null);

    function render() {
      if (disposed || !hostEl) return;
      const rows = listedBuckets();
      const total = rows.reduce((sum, b) => sum + Number(b.count), 0);
      const html = `<div class="ide-map-footer-start"><div class="ide-map-key">${keyMarkup()}</div></div>`
        + triggerMarkup(total)
        + popMarkup(rows);
      if (html === renderedHtml) return;
      renderedHtml = html;
      const doc = hostEl.ownerDocument;
      const triggerFocused = Boolean(doc && triggerEl() && doc.activeElement === triggerEl());
      const hot = new Set(Array.from(hostEl.querySelectorAll('.ide-map-footer-pop-row.is-heat'), (el) => el.dataset.mapBucket));
      hostEl.innerHTML = html;
      if (findingsEl) hostEl.firstElementChild.insertBefore(findingsEl, hostEl.firstElementChild.firstChild);
      for (const row of hostEl.querySelectorAll('.ide-map-footer-pop-row')) {
        if (hot.has(row.dataset.mapBucket)) row.classList.add('is-heat');
      }
      if (total <= 0) popOpen = false;
      if (popOpen) popover.open(popEl(), { trigger: triggerEl(), focus: false });
      if (triggerFocused && triggerEl()) triggerEl().focus();
    }

    function onClick(event) {
      const target = event.target;
      const trigger = target && typeof target.closest === 'function' ? target.closest('.ide-map-footer-unmapped') : null;
      if (trigger && hostEl.contains(trigger) && popover) popover.toggle(popEl(), { trigger, focus: false, restoreFocus: true });
    }

    // Escape and click-away close through the shared popover handlers; this
    // keeps the open state in step so a re-render reopens it.
    function onPopoverToggle(event) {
      if (event.target && event.target.classList && event.target.classList.contains('ide-map-footer-pop')) {
        popOpen = Boolean(event.detail && event.detail.open);
      }
    }

    if (hostEl) {
      hostEl.addEventListener('click', onClick);
      hostEl.addEventListener('inv-popover-toggle', onPopoverToggle);
    }

    function update(next) {
      if (disposed) return;
      const m = next || {};
      model = {
        buckets: Array.isArray(m.buckets) ? m.buckets : [],
        districts: Array.isArray(m.districts) ? m.districts : [],
        hasTests: m.hasTests === true,
      };
      render();
    }

    function setHealth(on) {
      if (disposed) return;
      health = on === true;
      render();
    }

    function setHideTests(on) {
      if (disposed) return;
      hideTests = on === true;
      render();
    }

    function adoptFindings(el) {
      if (disposed) return;
      findingsEl = el || null;
      renderedHtml = null;
      render();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (hostEl) {
        hostEl.removeEventListener('click', onClick);
        hostEl.removeEventListener('inv-popover-toggle', onPopoverToggle);
        hostEl.innerHTML = '';
      }
      findingsEl = null;
    }

    return { update, setHealth, setHideTests, adoptFindings, dispose };
  }

  return { createMapFooter, languageOrder };
});
