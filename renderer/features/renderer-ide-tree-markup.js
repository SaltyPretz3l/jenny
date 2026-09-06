/* renderer/features/renderer-ide-tree-markup.js - Workspace IDE tree markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeMarkup = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const EXPLORER_SORT_MODES = ['name', 'type', 'modified'];

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
    return {};
  }

  function parentDirOf(path) {
    const index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : String(path).slice(0, index);
  }

  function nameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  // Mirrors the service's listDirectory ordering (workspace-ide-service.js):
  // lowercased localeCompare, so flag-on 'name' mode never reorders a listing.
  function compareNames(left, right) {
    const leftName = String(left?.name || '').toLowerCase();
    const rightName = String(right?.name || '').toLowerCase();
    return leftName.localeCompare(rightName);
  }

  function extensionOf(entry) {
    const name = String(entry?.name || '');
    const dotIndex = name.lastIndexOf('.');
    return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
  }

  function compareEntries(left, right, mode) {
    const directoryOrder = Number(right?.kind === 'directory') - Number(left?.kind === 'directory');
    if (directoryOrder) return directoryOrder;
    if (mode === 'type' && left?.kind !== 'directory') {
      const leftExtension = extensionOf(left);
      const rightExtension = extensionOf(right);
      if (leftExtension !== rightExtension) return leftExtension.localeCompare(rightExtension);
    } else if (mode === 'modified') {
      const leftMtime = Number(left?.mtimeMs) > 0 ? Number(left.mtimeMs) : 0;
      const rightMtime = Number(right?.mtimeMs) > 0 ? Number(right.mtimeMs) : 0;
      if (leftMtime !== rightMtime) return rightMtime - leftMtime;
    }
    return compareNames(left, right);
  }

  // Single path segment only: inline inputs never create nested paths.
  function isValidEntryName(name) {
    if (!name || name === '.' || name === '..') {
      return false;
    }
    return !/[\\/\0:*?"<>|]/.test(name);
  }

  // Tier-2 git slice: file-tree decoration badges by git state.
  const GIT_TREE_BADGE = {
    modified: 'M',
    added: 'A',
    untracked: 'U',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    conflicted: '!',
  };

  function createIdeTreeMarkup(deps) {
    const getIde = deps.getIde;
    const escapeHtml = deps.escapeHtml;
    const getGitDecoration = deps.getGitDecoration;
    const childrenByDir = deps.childrenByDir;
    const errorByDir = deps.errorByDir;
    const truncatedDirs = deps.truncatedDirs;
    const loadingDirs = deps.loadingDirs;
    const getPendingEdit = deps.getPendingEdit;
    const getRootError = deps.getRootError;
    const getRootNeedsChoose = deps.getRootNeedsChoose;
    const hasChooseRoot = deps.hasChooseRoot;
    const onLazyLoad = deps.onLazyLoad;
    const isQolEnabled = deps.isQolEnabled;
    const isSelected = deps.isSelected;
    const isCut = typeof deps.isCut === 'function' ? deps.isCut : () => false;
    const textField = resolveModule('inventoryTextField', '../inventory/text-field');
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const ideIcons = resolveModule('rendererIdeIcons', './renderer-ide-icons');

    function buildStatusRow(text, depth) {
      return `<div class="ide-tree-status" style="--ide-tree-depth:${depth}">${escapeHtml(text)}</div>`;
    }

    function buildEditRowMarkup(depth, mode, initialName) {
      if (typeof textField !== 'function') {
        return '';
      }
      const field = textField({
        className: 'ide-tree-edit-field',
        value: initialName || '',
        placeholder: mode === 'create-directory' ? 'folder name' : 'file name',
        ariaLabel: mode === 'rename'
          ? 'New name'
          : mode === 'create-directory' ? 'New folder name' : 'New file name',
        maxLength: 255,
        dataset: { 'ide-tree-edit-control': '1' },
      });
      return `<div class="ide-tree-row ide-tree-row--edit" style="--ide-tree-depth:${depth}">${field}</div>`;
    }

    function buildEntryRowMarkup(entry, depth) {
      const pendingEdit = getPendingEdit();
      if (pendingEdit?.mode === 'rename' && pendingEdit.targetPath === entry.relPath) {
        const editName = isQolEnabled()
          ? pendingEdit.draftName ?? pendingEdit.originalName
          : pendingEdit.originalName;
        return buildEditRowMarkup(depth, 'rename', editName);
      }
      const ide = getIde();
      const isDir = entry.kind === 'directory';
      const expanded = isDir && ide.expandedDirs?.has(entry.relPath);
      const qolEnabled = isQolEnabled();
      const active = !isDir && entry.relPath === ide.activeTabPath;
      const selected = qolEnabled ? isSelected(entry.relPath) : active;
      const classes = ['ide-tree-row', `ide-tree-row--${entry.kind}`];
      if (qolEnabled && active) {
        classes.push('ide-tree-row--active');
      }
      if (selected) {
        classes.push('ide-tree-row--selected');
      }
      if (qolEnabled && isCut(entry.relPath)) {
        classes.push('ide-tree-row--cut');
      }
      // Git decoration: a colour class + an M/A/U badge (files) or a roll-up dot
      // (directories with dirty descendants). No-op when git is off / clean.
      let gitBadge = '';
      const gitState = getGitDecoration(entry.relPath, entry.kind);
      if (gitState) {
        if (isDir) {
          classes.push(`ide-tree-row--git-rollup-${gitState}`);
          gitBadge = '<span class="ide-tree-git-dot" aria-hidden="true"></span>';
        } else {
          classes.push(`ide-tree-row--git-${gitState}`);
          gitBadge = `<span class="ide-tree-git-badge" aria-label="git: ${escapeHtml(gitState)}">`
            + `${GIT_TREE_BADGE[gitState] || 'M'}</span>`;
        }
      }
      const twisty = isDir ? (expanded ? '▾' : '▸') : entry.kind === 'symlink' ? '↗' : '';
      const icon = ideIcons.fileIconMarkup?.(entry.name, entry.kind, { expanded }) || '';
      return `<div class="${classes.join(' ')}" role="treeitem" aria-level="${depth + 1}"`
        + (isDir ? ` aria-expanded="${expanded ? 'true' : 'false'}"` : '')
        // Files/symlinks stay draggable for editor-stage open. With Explorer
        // QoL enabled, directories join them for internal tree moves; flag-off
        // markup remains the legacy file-only shape.
        + (!isDir || qolEnabled ? ' draggable="true"' : '')
        + (qolEnabled && active ? ' aria-current="true"' : '')
        + (selected ? ' aria-selected="true"' : '')
        + ` data-ide-tree-path="${escapeHtml(entry.relPath)}" data-ide-tree-kind="${escapeHtml(entry.kind)}"`
        + ` style="--ide-tree-depth:${depth}" tabindex="-1" title="${escapeHtml(entry.relPath)}">`
        + `<span class="ide-tree-twisty" aria-hidden="true">${twisty}</span>`
        + icon
        + `<span class="ide-tree-name">${escapeHtml(entry.name)}</span>`
        + gitBadge
        + '</div>';
    }

    function buildChildrenMarkup(dirPath, depth) {
      const ide = getIde();
      const pendingEdit = getPendingEdit();
      let markup = '';
      if (pendingEdit && pendingEdit.mode !== 'rename' && pendingEdit.dirPath === dirPath) {
        const editName = isQolEnabled() ? pendingEdit.draftName : undefined;
        markup += buildEditRowMarkup(depth, pendingEdit.mode, editName);
      }
      const cachedEntries = childrenByDir.get(dirPath);
      if (!cachedEntries) {
        const failure = errorByDir.get(dirPath);
        return markup + buildStatusRow(failure || 'Loading…', depth);
      }
      const entries = isQolEnabled()
        ? [...cachedEntries].sort((left, right) => compareEntries(left, right, getIde().explorerSortMode))
        : cachedEntries;
      for (const entry of entries) {
        markup += buildEntryRowMarkup(entry, depth);
        if (entry.kind === 'directory' && ide.expandedDirs?.has(entry.relPath)) {
          if (!childrenByDir.has(entry.relPath) && !loadingDirs.has(entry.relPath)
            && !errorByDir.has(entry.relPath)) {
            onLazyLoad(entry.relPath);
          }
          markup += buildChildrenMarkup(entry.relPath, depth + 1);
        }
      }
      if (truncatedDirs.has(dirPath)) {
        markup += buildStatusRow('Folder list truncated.', depth);
      }
      return markup;
    }

    function buildTreeHeaderMarkup() {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const showGenerated = getIde().showGenerated === true;
      const generatedTitle = showGenerated ? 'Hide generated directories' : 'Show generated directories';
      const svgOpen = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"'
        + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
      const newFileSvg = `${svgOpen}<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/><path d="M5.5 9h5M8 6.5v5"/></svg>`;
      const newFolderSvg = `${svgOpen}<path d="M1.5 4h5l1.5 2h6.5v7.5h-13z"/><path d="M5.5 9.5h5M8 7v5"/></svg>`;
      const refreshSvg = `${svgOpen}<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V5h-2.5"/></svg>`;
      const collapseSvg = `${svgOpen}<path d="M3 4.5h10M5.5 8H13M8 11.5h5"/><path d="m4.5 7 1.5 1.5L4.5 10"/></svg>`;
      const sortSvg = `${svgOpen}<path d="M3 4h7M3 8h5M3 12h3"/><path d="m11 9 2 2 2-2M13 4v7"/></svg>`;
      const buttons = [
        {
          className: `ide-tree-header-button ide-tree-generated-toggle${showGenerated ? ' ide-tree-generated-toggle--active' : ''}`,
          label: 'Generated', ariaPressed: showGenerated,
          ariaLabel: generatedTitle, title: generatedTitle,
          dataset: { 'ide-tree-action': 'toggle-generated' },
        },
        { ariaLabel: 'Refresh Explorer', title: 'Refresh', trustedHtml: refreshSvg, dataset: { 'ide-tree-action': 'refresh' } },
        { ariaLabel: 'Collapse All Folders', title: 'Collapse All', trustedHtml: collapseSvg, dataset: { 'ide-tree-action': 'collapse-all' } },
      ];
      if (isQolEnabled()) {
        const sortMode = EXPLORER_SORT_MODES.includes(getIde().explorerSortMode)
          ? getIde().explorerSortMode
          : 'name';
        const sortTitle = `Sort: ${sortMode} — click to change`;
        buttons.unshift(
          { ariaLabel: 'New File', title: 'New File', trustedHtml: newFileSvg, dataset: { 'ide-tree-action': 'new-file' } },
          { ariaLabel: 'New Folder', title: 'New Folder', trustedHtml: newFolderSvg, dataset: { 'ide-tree-action': 'new-folder' } },
          { ariaLabel: sortTitle, title: sortTitle, trustedHtml: sortSvg, dataset: { 'ide-tree-action': 'cycle-sort' } }
        );
      }
      const buttonMarkup = buttons
        .map((options) => actionButton({ plain: true, className: 'ide-tree-header-button', ...options }))
        .join('');
      return '<div class="ide-tree-header">'
        + '<span class="ide-tree-header-title">Explorer</span>'
        + `<span class="ide-tree-header-actions">${buttonMarkup}</span></div>`;
    }

    function buildTreeMarkup() {
      const rootError = getRootError();
      const rootNeedsChoose = getRootNeedsChoose();
      let body;
      if (rootError) {
        body = buildStatusRow(rootError, 0);
        if (rootNeedsChoose && hasChooseRoot() && typeof actionButton === 'function') {
          body += '<div class="ide-tree-choose-root">'
            + actionButton({
              label: 'Choose Folder',
              variant: 'primary',
              dataset: { 'ide-tree-choose-root': '1' },
            })
            + '</div>';
        }
      } else {
        body = buildChildrenMarkup('', 0);
        if (!body) {
          body = buildStatusRow('Workspace is empty - right-click to create a file.', 0);
        }
      }
      return buildTreeHeaderMarkup()
        + (isQolEnabled()
          ? `<div class="ide-tree ide-tree--qol" role="tree" aria-label="Workspace files" aria-multiselectable="true">${body}</div>`
          : `<div class="ide-tree" role="tree" aria-label="Workspace files">${body}</div>`);
    }

    return {
      buildTreeMarkup,
      buildChildrenMarkup,
    };
  }

  return {
    createIdeTreeMarkup,
    parentDirOf,
    nameOf,
    isValidEntryName,
  };
});
