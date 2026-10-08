/* renderer/features/renderer-ide-tree-markup.js - Workspace IDE tree markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeMarkup = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
    const isSelected = deps.isSelected;
    const isCut = typeof deps.isCut === 'function' ? deps.isCut : () => false;
    // Projects v2: when a switcher is wired the header title is the current
    // project's name and opens the project menu; otherwise the static label.
    const getProjectTitle = typeof deps.getProjectTitle === 'function' ? deps.getProjectTitle : null;
    // Split view W3-4: { projectId, projectName } | null - the one-line nudge
    // under the header when the reference chat works in another project.
    const getProjectNudge = typeof deps.getProjectNudge === 'function' ? deps.getProjectNudge : null;
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
        placeholder: mode === 'create-directory' ? jt('ide.tree.folderNamePlaceholder', 'folder name') : jt('ide.tree.fileNamePlaceholder', 'file name'),
        ariaLabel: mode === 'rename'
          ? jt('ide.tree.newName', 'New name')
          : mode === 'create-directory' ? jt('ide.tree.newFolderName', 'New folder name') : jt('ide.tree.newFileName', 'New file name'),
        maxLength: 255,
        dataset: { 'ide-tree-edit-control': '1' },
      });
      return `<div class="ide-tree-row ide-tree-row--edit" style="--ide-tree-depth:${depth}">${field}</div>`;
    }

    function buildEntryRowMarkup(entry, depth) {
      const pendingEdit = getPendingEdit();
      if (pendingEdit?.mode === 'rename' && pendingEdit.targetPath === entry.relPath) {
        const editName = pendingEdit.draftName ?? pendingEdit.originalName;
        return buildEditRowMarkup(depth, 'rename', editName);
      }
      const ide = getIde();
      const isDir = entry.kind === 'directory';
      const expanded = isDir && ide.expandedDirs?.has(entry.relPath);
      const active = !isDir && entry.relPath === ide.activeTabPath;
      const selected = isSelected(entry.relPath);
      const classes = ['ide-tree-row', `ide-tree-row--${entry.kind}`];
      if (active) {
        classes.push('ide-tree-row--active');
      }
      if (selected) {
        classes.push('ide-tree-row--selected');
      }
      if (isCut(entry.relPath)) {
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
          gitBadge = `<span class="ide-tree-git-badge" aria-label="${escapeHtml(jt('ide.tree.gitStatus', 'git: {status}', { status: gitState }))}">`
            + `${GIT_TREE_BADGE[gitState] || 'M'}</span>`;
        }
      }
      const twisty = isDir ? (expanded ? '▾' : '▸') : entry.kind === 'symlink' ? '↗' : '';
      const icon = ideIcons.fileIconMarkup?.(entry.name, entry.kind, { expanded }) || '';
      return `<div class="${classes.join(' ')}" role="treeitem" aria-level="${depth + 1}"`
        + (isDir ? ` aria-expanded="${expanded ? 'true' : 'false'}"` : '')
        // Files, symlinks and directories are draggable (editor-stage open and
        // internal tree moves).
        + ' draggable="true"'
        + (active ? ' aria-current="true"' : '')
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
        markup += buildEditRowMarkup(depth, pendingEdit.mode, pendingEdit.draftName);
      }
      const cachedEntries = childrenByDir.get(dirPath);
      if (!cachedEntries) {
        const failure = errorByDir.get(dirPath);
        return markup + buildStatusRow(failure || 'Loading…', depth);
      }
      const entries = [...cachedEntries]
        .sort((left, right) => compareEntries(left, right, getIde().explorerSortMode));
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
        markup += buildStatusRow(jt('ide.tree.folderListTruncated', 'Folder list truncated.'), depth);
      }
      return markup;
    }

    function buildTreeHeaderMarkup() {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const showGenerated = getIde().showGenerated === true;
      const generatedTitle = showGenerated ? jt('ide.tree.hideGeneratedDirectories', 'Hide generated directories') : jt('ide.tree.showGeneratedDirectories', 'Show generated directories');
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
          label: jt('ide.tree.generated', 'Generated'), ariaPressed: showGenerated,
          ariaLabel: generatedTitle, title: generatedTitle,
          dataset: { 'ide-tree-action': 'toggle-generated' },
        },
        { ariaLabel: jt('ide.tree.refreshExplorer', 'Refresh Explorer'), title: jt('common.refresh', 'Refresh'), trustedHtml: refreshSvg, dataset: { 'ide-tree-action': 'refresh' } },
        { ariaLabel: jt('ide.tree.collapseAllFolders', 'Collapse All Folders'), title: jt('ide.tree.collapseAll', 'Collapse All'), trustedHtml: collapseSvg, dataset: { 'ide-tree-action': 'collapse-all' } },
      ];
      const sortMode = EXPLORER_SORT_MODES.includes(getIde().explorerSortMode)
        ? getIde().explorerSortMode
        : 'name';
      const sortTitle = jt('ide.tree.sortTitle', 'Sort: {mode} — click to change', { mode: sortMode });
      buttons.unshift(
        { ariaLabel: jt('ide.tree.newFile', 'New File'), title: jt('ide.tree.newFile', 'New File'), trustedHtml: newFileSvg, dataset: { 'ide-tree-action': 'new-file' } },
        { ariaLabel: jt('ide.tree.newFolder', 'New Folder'), title: jt('ide.tree.newFolder', 'New Folder'), trustedHtml: newFolderSvg, dataset: { 'ide-tree-action': 'new-folder' } },
        { ariaLabel: sortTitle, title: sortTitle, trustedHtml: sortSvg, dataset: { 'ide-tree-action': 'cycle-sort' } }
      );
      const buttonMarkup = (getRootNeedsChoose() ? [] : buttons)
        .map((options) => actionButton({ plain: true, className: 'ide-tree-header-button', ...options }))
        .join('');
      const chevronSvg = `${svgOpen}<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>`;
      const titleMarkup = getProjectTitle
        ? actionButton({
          plain: true,
          className: 'ide-tree-header-title ide-tree-header-project',
          ariaHaspopup: 'menu',
          ariaLabel: jt('projects.switcher.switchCurrentAria', 'Switch project, current: {name}', { name: getProjectTitle() }),
          title: jt('ide.tree.switchProject', 'Switch project'),
          dataset: { 'ide-tree-action': 'project-menu' },
          trustedHtml: `<span class="ide-tree-header-project-name">${escapeHtml(getProjectTitle())}</span>${chevronSvg}`,
        })
        : `<span class="ide-tree-header-title">${escapeHtml(jt('ide.tree.explorer', 'Explorer'))}</span>`;
      return '<div class="ide-tree-header">'
        + titleMarkup
        + `<span class="ide-tree-header-actions">${buttonMarkup}</span></div>`
        + buildProjectNudge().markup;
    }

    // The nudge line and its identity key ('' when absent). The key is what a
    // live node reads back as (data attribute + textContent), so an in-place
    // header repaint can compare without re-serializing markup.
    function buildProjectNudge() {
      const nudge = getProjectNudge && typeof actionButton === 'function' ? getProjectNudge() : null;
      if (!nudge || !nudge.projectId) {
        return { key: '', markup: '' };
      }
      const params = { project: nudge.projectName };
      const text = jt('ide.explorer.nudge.text', 'The focused chat is in {project}.', params);
      const label = jt('ide.explorer.nudge.open', 'Open {project}', params);
      const markup = `<p class="ide-explorer-project-nudge" data-ide-project-nudge="${escapeHtml(nudge.projectId)}">`
        + `${escapeHtml(text)} `
        + actionButton({
          plain: true,
          className: 'ide-explorer-project-nudge-action',
          label,
          dataset: { 'ide-tree-action': 'project-nudge', 'ide-project-id': nudge.projectId },
        })
        + '</p>';
      return { key: projectNudgeKey(nudge.projectId, `${text} ${String(label).trim()}`), markup };
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
              label: jt('ide.tree.chooseFolderLink', 'Choose a folder'),
              plain: true,
              className: 'ide-tree-choose-root-action',
              dataset: { 'ide-tree-choose-root': '1' },
            })
            + '</div>';
        }
      } else {
        body = buildChildrenMarkup('', 0);
        if (!body) {
          body = buildStatusRow(jt('ide.tree.emptyWorkspace', 'Workspace is empty - right-click to create a file.'), 0);
        }
      }
      return buildTreeHeaderMarkup()
        + `<div class="ide-tree ide-tree--qol" role="tree" aria-label="${escapeHtml(jt('ide.tree.workspaceFiles', 'Workspace files'))}" aria-multiselectable="true">${body}</div>`;
    }

    return {
      buildTreeMarkup,
      buildChildrenMarkup,
      buildProjectNudge,
    };
  }

  function projectNudgeKey(projectId, text) {
    return projectId ? `${projectId}\n${text}` : '';
  }

  // The key a rendered nudge node carries ('' for no node).
  function readProjectNudgeKey(node) {
    return node ? projectNudgeKey(node.getAttribute('data-ide-project-nudge') || '', node.textContent || '') : '';
  }

  return {
    createIdeTreeMarkup,
    readProjectNudgeKey,
    parentDirOf,
    nameOf,
  };
});
