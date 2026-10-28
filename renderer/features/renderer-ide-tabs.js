/* renderer/features/renderer-ide-tabs.js - Workspace IDE open-file tab strip.
 * Pure markup builder + renderer over #ideTabStrip; click/keyboard intent is
 * delegated by the tab-strip events module. All button markup renders through the
 * inventory action-button primitive (no raw primitives in this file). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTabs = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveActionButton() {
    if (typeof globalRef.inventoryActionButton === 'function') {
      return globalRef.inventoryActionButton;
    }
    if (typeof require === 'function') {
      try {
        return require('../inventory/action-button');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  // Drag payload for a file tab moving between editor groups (row 40 W5); the
  // primary strip's controller and every group view share it.
  const TAB_MIME = 'application/x-jenny-editor-tab';

  // The dragged tab's { path, fromGroup } from a drag event, or null.
  function readTabPayload(event) {
    try {
      const value = JSON.parse(event?.dataTransfer?.getData?.(TAB_MIME) || 'null');
      if (!value || typeof value.path !== 'string' || !value.path) return null;
      return { path: value.path, fromGroup: typeof value.fromGroup === 'string' ? value.fromGroup : '' };
    } catch (_error) {
      return null;
    }
  }

  const hasTabPayload = (event) => Array.from(event?.dataTransfer?.types || []).includes(TAB_MIME);

  // Insert index for a tab dropped at `clientX`: the tabs whose midpoint lies
  // before the pointer (mirrored right-to-left). A tab reordered within its own
  // strip (`skipPath`) does not count itself, so the index is its final place.
  function tabDropIndex(tabEls, clientX, { rtl = false, skipPath = '' } = {}) {
    let index = 0;
    for (const tabEl of tabEls || []) {
      if (skipPath && tabEl.getAttribute?.('data-ide-tab') === skipPath) continue;
      const rect = tabEl.getBoundingClientRect?.();
      const mid = rect ? rect.left + rect.width / 2 : 0;
      if (rtl ? mid > clientX : mid < clientX) index += 1;
    }
    return index;
  }

  function fileNameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  // The label a tab shows: diff/preview review surfaces carry an explicit
  // label (their path is a diff:// or preview:// id); file tabs show their
  // basename. Exported so the tab-strip controller's overflow quick-pick
  // resolves names through the same helper instead of re-deriving them.
  function tabDisplayName(tab) {
    if (tab.kind === 'diff' || tab.kind === 'preview') {
      return String(tab.label || (tab.kind === 'preview' ? 'Preview' : 'Diff'));
    }
    return fileNameOf(tab.path);
  }

  // Hand-written 16x16 stroke glyphs for the strip's own marks (the file icon
  // comes from rendererIdeIcons). Static constants - nothing is interpolated.
  const GLYPHS = {
    diff: '<path d="M5 2.5v7"/><path d="M2.5 6h5"/><path d="M8.5 12.5h5"/><path d="M11 2.5 13.5 5 11 7.5"/>',
    eye: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="2"/>',
    map: '<path d="M2 4l4-1.5 4 1.5 4-1.5v9.5L10 13.5 6 12 2 13.5z"/><path d="M6 2.5V12M10 4v9.5"/>',
    pin: '<path d="M9.5 2.5l4 4-1.6.5-2 2-.3 2.6-1.1-1.1-2.6 2.6M5.9 10.1l-1.1-1.1 2.6-.3 2-2 .5-1.6"/>',
    x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  };
  const SURFACE_GLYPHS = { preview: 'eye', file_map: 'map' };
  const GIT_STATUSES = ['modified', 'renamed', 'copied', 'untracked', 'added', 'deleted', 'conflicted'];

  function glyphSvg(key, size) {
    return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor"`
      + ' stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
      + ` focusable="false">${GLYPHS[key]}</svg>`;
  }

  function safeRequire(id) {
    try {
      return require(id);
    } catch (_error) {
      return null;
    }
  }

  // The icons script loads after this one (renderer-ide-script-manifest), so
  // resolve it at call time, never at factory time.
  function fileIcon(name) {
    const icons = globalRef.rendererIdeIcons
      || (typeof require === 'function' ? safeRequire('./renderer-ide-icons') : null);
    return icons && typeof icons.fileIconMarkup === 'function' ? icons.fileIconMarkup(name, 'file') : '';
  }

  const isReviewTab = (tab) => tab?.kind === 'diff' || tab?.kind === 'preview';

  // Diff labels read "{file} (Jenny's change)" / "{file} (unsaved vs saved)":
  // the strip shows the file name and moves the parenthetical to the suffix slot.
  function diffParts(tab) {
    const label = tabDisplayName(tab);
    const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(label);
    const isJennyChange = String(tab.path || '').startsWith('diff://change/');
    const name = match && match[1] ? match[1] : label;
    let suffix = match && match[1] ? match[2] : '';
    if (isJennyChange) suffix = jt('ide.tabs.jennyChange', "Jenny's change");
    return { name, suffix };
  }

  // For file tabs sharing a basename, the shortest trailing parent-folder path
  // that tells each one apart from the others. A root-level file reads as the
  // workspace label. Diff/preview tabs never take part. -> Map<path, suffix>
  function disambiguateTabs(tabs) {
    const groups = new Map();
    for (const tab of tabs || []) {
      if (!tab || isReviewTab(tab) || typeof tab.path !== 'string') continue;
      const segments = tab.path.replace(/\\/g, '/').split('/').filter(Boolean);
      const name = segments.pop() || tab.path;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push({ path: tab.path, parents: segments });
    }
    const result = new Map();
    const tail = (entry, depth) => entry.parents.slice(-depth).join('/');
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const maxDepth = Math.max(...group.map((entry) => entry.parents.length));
      for (const entry of group) {
        let depth = 1;
        while (depth < maxDepth
          && group.some((other) => other !== entry && tail(other, depth) === tail(entry, depth))) {
          depth += 1;
        }
        result.set(entry.path, tail(entry, depth) || jt('ide.tabs.rootFolder', 'root'));
      }
    }
    return result;
  }

  function countChipFor(strip) {
    const next = strip.nextElementSibling;
    return next && next.classList.contains('ide-tabstrip-count') ? next : null;
  }

  // Recount the tabs that are not fully inside the strip's box and update the
  // "+N" chip (hidden at 0). jsdom reports 0-sized rects: a 0-width strip is
  // "not laid out", so it counts nothing hidden.
  function syncTabOverflow(strip) {
    const chip = strip ? countChipFor(strip) : null;
    if (!chip) return 0;
    const tabs = strip.querySelectorAll('.ide-tab:not(.ide-tab--surface)');
    const box = strip.getBoundingClientRect();
    let hidden = 0;
    if (box.width > 0) {
      for (const tab of tabs) {
        const rect = tab.getBoundingClientRect();
        if (rect.left < box.left - 1 || rect.right > box.right + 1) hidden += 1;
      }
    }
    // Scroll frames recount often; touch the chip only when a count moved.
    const counts = `${hidden}/${tabs.length}`;
    if (chip.__jennyIdeTabCounts === counts) return hidden;
    chip.__jennyIdeTabCounts = counts;
    const label = jt('ide.tabs.showAllCount', 'Show all {count} open tabs', { count: tabs.length });
    chip.hidden = hidden === 0;
    chip.textContent = `+${hidden}`;
    chip.title = label;
    chip.setAttribute('aria-label', label);
    return hidden;
  }

  function createIdeTabStrip(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
    const getGitDecoration = typeof deps?.getGitDecoration === 'function' ? deps.getGitDecoration : () => null;
    const actionButton = resolveActionButton();
    // A secondary editor group points its tabs at its own stage panel.
    const ariaControls = String(deps?.ariaControls || 'ideEditorStage');

    function buildTabMarkup(tab, { active, dirty, stale, pinned, suffix, git }) {
      if (!actionButton) {
        return '';
      }
      // Diff/preview review tabs carry a display label (their path is a
      // diff:// or preview:// id) and never show dirty/stale decorations -
      // they are read-only views.
      const isDiff = isReviewTab(tab);
      const isTransientPreview = tab.kind === 'file' && tab.transientPreview === true;
      // Only real file tabs pin (review surfaces are session-scoped); the caller
      // already passes a normalized boolean.
      const isPinned = pinned && !isDiff;
      const fullName = tabDisplayName(tab);
      const parts = isDiff ? diffParts(tab) : { name: fullName, suffix };
      const name = parts.name;
      const dir = parts.suffix || '';
      // Screen-reader label: a diff surface reads only "(diff view)"; a file tab
      // joins its state suffixes (stale takes precedence over dirty) so a pinned
      // unsaved tab reads "(unsaved changes, pinned)".
      let ariaLabel = name;
      if (isDiff) {
        ariaLabel = jt('ide.tabs.diffView', '{name} (diff view)', { name: fullName });
      } else {
        // The folder suffix leads, so two same-named tabs also read apart.
        const states = dir ? [dir] : [];
        if (stale) {
          states.push(jt('ide.tabs.changedOnDiskState', 'changed on disk'));
        } else if (dirty) {
          states.push(jt('ide.tabs.unsavedChangesState', 'unsaved changes'));
        }
        if (isPinned) {
          states.push(jt('ide.tabs.pinnedState', 'pinned'));
        }
        if (isTransientPreview) {
          states.push(jt('ide.tabs.previewState', 'preview'));
        }
        if (states.length) {
          ariaLabel = `${name} (${states.join(', ')})`;
        }
      }
      const icon = isDiff
        ? `<span class="ide-tab-glyph" aria-hidden="true">${glyphSvg('diff', 14)}</span>`
        : fileIcon(name);
      const labelButton = actionButton({
        plain: true,
        className: 'ide-tab-label',
        role: 'tab',
        ariaSelected: active,
        // Every tab drives its group's editor stage (role="tabpanel").
        ariaControls,
        tabIndex: active ? 0 : -1,
        title: isDiff ? fullName : stale ? jt('ide.tabs.changedOnDisk', '{path} - changed on disk', { path: tab.path }) : tab.path,
        dataset: { 'ide-tab-path': tab.path },
        trustedHtml: icon
          + `<span class="ide-tab-name">${escapeHtml(name)}</span>`
          + (dir ? `<span class="ide-tab-dir">${escapeHtml(dir)}</span>` : ''),
        ariaLabel,
      });
      const closeButton = actionButton({
        plain: true,
        className: 'ide-tab-close',
        ariaLabel: jt('ide.tabs.closeLabel', 'Close {name}', { name }),
        // One title for every tab: the close prompt (Save / Don't Save / Cancel)
        // guards unsaved work, so a dirty tab needs no separate warning.
        title: jt('ide.tabs.closeTitle', 'Close {name} (Ctrl+F4)', { name }),
        tabIndex: -1,
        dataset: { 'ide-tab-close': tab.path },
        trustedHtml: glyphSvg('x', 12),
      });
      const hasMark = !isDiff && (dirty || stale);
      const slot = '<span class="ide-tab-slot">'
        + (hasMark ? '<span class="ide-tab-mark" aria-hidden="true"></span>' : '')
        + (isPinned ? `<span class="ide-tab-pin" aria-hidden="true">${glyphSvg('pin', 12)}</span>` : '')
        + closeButton
        + '</span>';
      const gitStatus = !isDiff && !dirty && !stale && GIT_STATUSES.includes(git) ? git : '';
      const flags = `${active ? ' ide-tab--active' : ''}${dirty && !isDiff ? ' ide-tab--dirty' : ''}`
        + `${stale && !isDiff ? ' ide-tab--stale' : ''}${isDiff ? ' ide-tab--diff' : ''}`
        + `${isPinned ? ' ide-tab--pinned' : ''}${isTransientPreview ? ' ide-tab--preview' : ''}`
        + `${dir ? ' ide-tab--has-dir' : ''}${gitStatus ? ` ide-tab--git-${gitStatus}` : ''}`;
      // draggable: HTML5 DnD reorder handled by the tab-strip events module.
      return `<div class="ide-tab${flags}" data-ide-tab="${escapeHtml(tab.path)}" draggable="true">${labelButton}${slot}</div>`;
    }

    // The stage surface (Preview / File Map) as a real tab after the file tabs.
    function buildSurfaceTabMarkup(surfaceTab) {
      if (!actionButton || !surfaceTab?.surface) {
        return '';
      }
      const { surface } = surfaceTab;
      const label = String(surfaceTab.label || surface);
      const subject = String(surfaceTab.subject || '').split('/').pop();
      const labelButton = actionButton({
        plain: true,
        className: 'ide-tab-label',
        role: 'tab',
        ariaSelected: true,
        ariaControls,
        tabIndex: 0,
        title: subject ? `${label} - ${subject}` : label,
        dataset: { 'ide-surface-label': surface },
        trustedHtml: `<span class="ide-tab-glyph" aria-hidden="true">${glyphSvg(SURFACE_GLYPHS[surface] || 'eye', 14)}</span>`
          + `<span class="ide-tab-name">${escapeHtml(label)}</span>`
          + (subject ? `<span class="ide-tab-dir">${escapeHtml(subject)}</span>` : ''),
      });
      const close = actionButton({
        plain: true,
        className: 'ide-tab-close',
        ariaLabel: jt('ide.tabs.closeLabel', 'Close {name}', { name: label }),
        title: jt('ide.stageSwitch.closeSurface', 'Close {label} and return to the editor', { label }),
        tabIndex: -1,
        dataset: { 'ide-surface-close': surface },
        trustedHtml: glyphSvg('x', 12),
      });
      return `<div class="ide-tab ide-tab--active ide-tab--surface${subject ? ' ide-tab--has-dir' : ''}"`
        + ` data-ide-surface-tab="${escapeHtml(surface)}">${labelButton}<span class="ide-tab-slot">${close}</span></div>`;
    }

    // The "+N" count chip: the strip's next sibling (the strip scrolls and masks
    // its edges, so the chip cannot live inside it). Created on first render.
    function ensureCountChip(strip) {
      if (!actionButton || countChipFor(strip) || typeof strip.insertAdjacentElement !== 'function') {
        return;
      }
      const template = strip.ownerDocument.createElement('template');
      template.innerHTML = actionButton({
        plain: true,
        className: 'ide-tabstrip-count',
        ariaHaspopup: 'menu',
        title: jt('ide.tabs.showAll', 'Show all open tabs'),
        ariaLabel: jt('ide.tabs.showAll', 'Show all open tabs'),
        dataset: { 'ide-tab-overflow': '' },
        label: '+0',
      });
      const chip = template.content.firstElementChild;
      if (!chip) return;
      chip.hidden = true;
      strip.insertAdjacentElement('afterend', chip);
    }

    function renderTabs({ openTabs = [], activeTabPath = '', dirtyByPath = {}, staleByPath = {}, surfaceTab = null } = {}) {
      const strip = getDom().ideTabStrip || null;
      if (!strip) {
        return;
      }
      const suffixes = disambiguateTabs(openTabs);
      const onStage = Boolean(surfaceTab?.surface);
      const markup = openTabs
        .map((tab) => buildTabMarkup(tab, {
          // A surface on stage owns the selection; every file tab reads inactive.
          active: !onStage && tab.path === activeTabPath,
          dirty: dirtyByPath[tab.path] === true,
          stale: staleByPath[tab.path] === true,
          pinned: tab.pinned === true,
          suffix: suffixes.get(tab.path) || '',
          git: tab.kind === 'file' ? getGitDecoration(tab.path) : null,
        }))
        .join('') + (onStage ? buildSurfaceTabMarkup(surfaceTab) : '');
      if (openTabs.length) {
        ensureCountChip(strip);
      }
      const changed = strip.__jennyIdeTabsMarkup !== markup;
      if (changed) {
        strip.innerHTML = markup;
        strip.__jennyIdeTabsMarkup = markup;
      }
      // Bring the active tab into view only when the selection or the tab count
      // moved - a dirty flip, git refresh or diff update must never snap the
      // strip back while the user is scrolled elsewhere.
      const activeKey = onStage ? `surface:${surfaceTab.surface}` : activeTabPath;
      const meta = strip.__jennyIdeTabsMeta;
      const moved = !meta || meta.activeKey !== activeKey || meta.count !== openTabs.length;
      strip.__jennyIdeTabsMeta = { activeKey, count: openTabs.length };
      if (moved) {
        const active = strip.querySelector('.ide-tab--active');
        if (active && typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        }
      }
      if (changed || moved) {
        syncTabOverflow(strip);
      }
    }

    return {
      renderTabs,
    };
  }

  return {
    TAB_MIME,
    createIdeTabStrip,
    disambiguateTabs,
    hasTabPayload,
    readTabPayload,
    syncTabOverflow,
    tabDisplayName,
    tabDropIndex,
  };
});
