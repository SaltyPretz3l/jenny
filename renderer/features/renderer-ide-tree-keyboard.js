/* renderer/features/renderer-ide-tree-keyboard.js - Workspace tree keyboard behavior. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeKeyboard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
    return {};
  }

  function createIdeTreeKeyboard(deps) {
    const getMountEl = typeof deps?.getMountEl === 'function' ? deps.getMountEl : () => null;
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getFocusedPath = typeof deps?.getFocusedPath === 'function' ? deps.getFocusedPath : () => '';
    const setFocusedPath = typeof deps?.setFocusedPath === 'function' ? deps.setFocusedPath : noop;
    const setFocusAfterRender = typeof deps?.setFocusAfterRender === 'function'
      ? deps.setFocusAfterRender : noop;
    const toggleDir = typeof deps?.toggleDir === 'function' ? deps.toggleDir : noop;
    const onOpenFile = typeof deps?.onOpenFile === 'function' ? deps.onOpenFile : noop;
    const selection = deps?.selection || {};
    const isQolEnabled = typeof deps?.isQolEnabled === 'function' ? deps.isQolEnabled : () => false;
    const render = typeof deps?.render === 'function' ? deps.render : noop;
    const onBeginRename = typeof deps?.onBeginRename === 'function' ? deps.onBeginRename : noop;
    const onDeleteSelection = typeof deps?.onDeleteSelection === 'function'
      ? deps.onDeleteSelection : noop;
    const onNotify = typeof deps?.onNotify === 'function' ? deps.onNotify : noop;
    const onClipboardCopy = typeof deps?.onClipboardCopy === 'function' ? deps.onClipboardCopy : null;
    const onClipboardCut = typeof deps?.onClipboardCut === 'function' ? deps.onClipboardCut : null;
    const onClipboardPaste = typeof deps?.onClipboardPaste === 'function' ? deps.onClipboardPaste : null;
    const onClipboardDuplicate = typeof deps?.onClipboardDuplicate === 'function'
      ? deps.onClipboardDuplicate : null;
    const clipboardActions = {
      c: onClipboardCopy,
      x: onClipboardCut,
      v: onClipboardPaste,
      d: onClipboardDuplicate,
    };
    const commitEdit = typeof deps?.commitEdit === 'function' ? deps.commitEdit : noop;
    const cancelEdit = typeof deps?.cancelEdit === 'function' ? deps.cancelEdit : noop;
    const editSession = deps?.editSession || {};
    const treeMarkup = resolveModule('rendererIdeTreeMarkup', './renderer-ide-tree-markup');
    const { parentDirOf, nameOf } = treeMarkup;
    let typeAheadBuffer = '';
    let typeAheadAt = 0;

    // Re-applies the roving tabindex after an innerHTML swap: exactly one
    // row is tabbable (the remembered focus path, else the selected row,
    // else the first row). restoreFocus re-focuses that row when the swap
    // displaced focus that lived inside the panel - watcher-driven
    // re-renders never steal focus from the editor.
    function syncRovingFocus(panel, restoreFocus) {
      const rows = [...panel.querySelectorAll('[data-ide-tree-path]')];
      if (!rows.length) {
        setFocusedPath('');
        return;
      }
      let target = rows.find((row) => row.dataset.ideTreePath === getFocusedPath()) || null;
      if (!target) {
        target = rows.find((row) => row.classList.contains('ide-tree-row--active'))
          || rows.find((row) => row.classList.contains('ide-tree-row--selected')) || rows[0];
        setFocusedPath(target.dataset.ideTreePath);
      }
      for (const row of rows) {
        row.tabIndex = row === target ? 0 : -1;
      }
      if (restoreFocus) {
        target.focus();
      }
    }

    function moveTreeFocus(rows, index) {
      const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
      if (!target) {
        return;
      }
      for (const row of rows) {
        row.tabIndex = row === target ? 0 : -1;
      }
      setFocusedPath(target.dataset.ideTreePath);
      target.focus();
    }

    function handleTypeAhead(event, rows, index) {
      const key = String(event.key || '');
      if (key.length !== 1 || key === ' ' || event.shiftKey
        || event.ctrlKey || event.metaKey || event.altKey) {
        return false;
      }
      const now = Date.now();
      if (now - typeAheadAt > 700) {
        typeAheadBuffer = '';
      }
      typeAheadAt = now;
      typeAheadBuffer += key.toLocaleLowerCase();
      for (let offset = 1; offset <= rows.length; offset += 1) {
        const candidateIndex = (index + offset) % rows.length;
        const candidate = rows[candidateIndex];
        const candidateName = String(nameOf?.(candidate.dataset.ideTreePath) || '').toLocaleLowerCase();
        if (candidateName.startsWith(typeAheadBuffer)) {
          moveTreeFocus(rows, candidateIndex);
          selection.replace([candidate.dataset.ideTreePath], candidate.dataset.ideTreePath);
          render();
          break;
        }
      }
      return true;
    }

    // WAI-ARIA tree keyboard pattern over the rendered rows: arrows move a
    // roving tabindex, Right/Left expand/collapse (Left from a leaf jumps to
    // the parent), Enter/Space activates. Expansion re-renders, so those
    // paths route focus restoration through syncRovingFocus.
    function handleTreeNavKeydown(event) {
      const row = event.target?.closest?.('[data-ide-tree-path]');
      const panel = getMountEl();
      if (!row || !panel) {
        return;
      }
      const rows = [...panel.querySelectorAll('[data-ide-tree-path]')];
      const index = rows.indexOf(row);
      if (index === -1) {
        return;
      }
      const path = row.dataset.ideTreePath;
      const isDir = row.dataset.ideTreeKind === 'directory';
      const expanded = isDir && getIde().expandedDirs?.has(path);
      const qolEnabled = isQolEnabled();
      switch (event.key) {
        case 'ArrowDown':
          moveTreeFocus(rows, index + 1);
          if (qolEnabled && event.shiftKey) {
            const target = rows[Math.min(rows.length - 1, index + 1)];
            if (selection.has(path) !== true) selection.replace([path], path);
            selection.extendRange(rows.map((item) => item.dataset.ideTreePath), target.dataset.ideTreePath);
            render();
          } else if (qolEnabled && !event.ctrlKey && !event.metaKey) {
            const target = rows[Math.min(rows.length - 1, index + 1)];
            selection.replace([target.dataset.ideTreePath], target.dataset.ideTreePath);
            render();
          }
          break;
        case 'ArrowUp':
          moveTreeFocus(rows, index - 1);
          if (qolEnabled && event.shiftKey) {
            const target = rows[Math.max(0, index - 1)];
            if (selection.has(path) !== true) selection.replace([path], path);
            selection.extendRange(rows.map((item) => item.dataset.ideTreePath), target.dataset.ideTreePath);
            render();
          } else if (qolEnabled && !event.ctrlKey && !event.metaKey) {
            const target = rows[Math.max(0, index - 1)];
            selection.replace([target.dataset.ideTreePath], target.dataset.ideTreePath);
            render();
          }
          break;
        case 'Home':
          moveTreeFocus(rows, 0);
          if (qolEnabled && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            selection.replace([rows[0].dataset.ideTreePath], rows[0].dataset.ideTreePath);
            render();
          }
          break;
        case 'End':
          moveTreeFocus(rows, rows.length - 1);
          if (qolEnabled && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            const target = rows[rows.length - 1];
            selection.replace([target.dataset.ideTreePath], target.dataset.ideTreePath);
            render();
          }
          break;
        case 'ArrowRight':
          if (isDir && !expanded) {
            setFocusedPath(path);
            setFocusAfterRender(true);
            if (qolEnabled && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
              selection.replace([path], path);
              render();
            }
            toggleDir(path);
          } else if (isDir && expanded) {
            moveTreeFocus(rows, index + 1);
            if (qolEnabled && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
              const target = rows[Math.min(rows.length - 1, index + 1)];
              selection.replace([target.dataset.ideTreePath], target.dataset.ideTreePath);
              render();
            }
          }
          break;
        case 'ArrowLeft':
          if (isDir && expanded) {
            setFocusedPath(path);
            setFocusAfterRender(true);
            if (qolEnabled && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
              selection.replace([path], path);
              render();
            }
            toggleDir(path);
          } else {
            const parentIndex = rows.findIndex(
              (candidate) => candidate.dataset.ideTreePath === parentDirOf(path)
            );
            if (parentIndex !== -1) {
              moveTreeFocus(rows, parentIndex);
              if (qolEnabled && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                const target = rows[parentIndex];
                selection.replace([target.dataset.ideTreePath], target.dataset.ideTreePath);
                render();
              }
            }
          }
          break;
        case 'Enter':
        case ' ':
          setFocusedPath(path);
          setFocusAfterRender(true);
          if (isDir) {
            toggleDir(path);
          } else {
            onOpenFile(path, { preview: true });
          }
          break;
        case 'F2': {
          if (!qolEnabled) return;
          const targets = selection.resolveTargets(getFocusedPath());
          if (targets.length === 1) {
            const targetRow = rows.find((candidate) => candidate.dataset.ideTreePath === targets[0]);
            if (targetRow) onBeginRename(targets[0], targetRow.dataset.ideTreeKind);
          } else if (targets.length > 1) {
            onNotify('Rename one item at a time.');
          }
          break;
        }
        case 'Delete':
          if (!qolEnabled) return;
          onDeleteSelection();
          break;
        case 'Escape':
          if (!qolEnabled || selection.size() === 0) return;
          selection.replace(getFocusedPath() ? [getFocusedPath()] : [], getFocusedPath());
          render();
          break;
        default:
          if (qolEnabled && (event.ctrlKey || event.metaKey)) {
            const shortcutKey = String(event.key || '').toLocaleLowerCase();
            if (shortcutKey === 'a') {
              selection.selectAll(rows.map((item) => item.dataset.ideTreePath));
              render();
              break;
            }
            const clipboardAction = clipboardActions[shortcutKey];
            if (clipboardAction) {
              clipboardAction();
              break;
            }
          }
          if (qolEnabled && handleTypeAhead(event, rows, index)) {
            break;
          }
          return;
      }
      event.preventDefault();
    }

    function handleKeydown(event) {
      const control = event.target?.closest?.('[data-ide-tree-edit-control]');
      if (!control) {
        handleTreeNavKeydown(event);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (isQolEnabled() && editSession.onInput?.(control)?.ok === false) {
          return;
        }
        commitEdit(control.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelEdit();
      }
    }

    return { syncRovingFocus, handleKeydown };
  }

  return { createIdeTreeKeyboard };
});
