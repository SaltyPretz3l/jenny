/* renderer/features/renderer-ide-scm-row-actions.js - the Source Control panel's
 * row hover actions, group header actions and commit options (row 82 G1, VS Code
 * parity; docs/plans/IDE_VSCODE_PARITY_2026-10-26.md 7.6). Split out of
 * renderer-ide-source-control-panel.js at its size ceiling: the panel calls these
 * markup builders and hands its delegated clicks here first.
 *
 *   rows      Changed: Open, Discard (Delete for a new file), Stage
 *             Ready to commit: Open, Unstage
 *             Injected on a row's first pointerenter or focusin (cleanup G6, owner
 *             D5): idle rows carry no buttons; a re-render re-injects the last row
 *   headers   Changed: Discard All, Stage All; Ready to commit: Unstage All
 *   commit    "Amend last commit" (prefills the previous message into an empty
 *             draft; a commit with nothing staged is allowed) and "Sign off"
 *
 * Every operation is a callback (the git feature's actions own git and confirms);
 * nothing here touches the store. Buttons are the panel's inventory action-buttons,
 * the options are inventory checkboxes. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeScmRowActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveCheckbox() {
    const resolved = globalRef.inventoryCheckbox
      || (typeof require === 'function' ? (() => { try { return require('../inventory/checkbox'); } catch (_error) { return null; } })() : null);
    return resolved && typeof resolved.checkbox === 'function' ? resolved.checkbox : null;
  }

  function createScmRowActions(deps) {
    const d = deps || {};
    // actionBtn(label, action, title, extraClass) is the panel's inventory button helper.
    const actionBtn = typeof d.actionBtn === 'function' ? d.actionBtn : () => '';
    const checkbox = typeof d.checkbox === 'function' ? d.checkbox : resolveCheckbox();
    const gitActions = d.gitActions || null;
    const onOpenFile = typeof d.onOpenFile === 'function' ? d.onOpenFile : noop;
    const getMessage = typeof d.getCommitMessage === 'function' ? d.getCommitMessage : () => '';
    const setMessage = typeof d.setCommitMessage === 'function' ? d.setCommitMessage : noop;
    const rerender = typeof d.rerender === 'function' ? d.rerender : noop;
    const getFile = typeof d.getFile === 'function' ? d.getFile : () => null;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;

    let amend = false;
    let signoff = false;
    // The message the amend toggle put into the draft; unticking clears it only
    // when the draft is still exactly that text.
    let prefilled = '';
    let generation = 0;
    let lastRow = null; // { path, staged }: the row last hovered or focused

    const has = (method) => Boolean(gitActions) && typeof gitActions[method] === 'function';

    function rowActionsMarkup(file, inStagedGroup) {
      const open = actionBtn(jt('ide.scmRowActions.open', 'Open'), 'open-file', jt('ide.scmRowActions.openFileTitle', 'Open File'));
      if (inStagedGroup) {
        return open + actionBtn(jt('ide.sourceControl.unstage', 'Unstage'), 'unstage', jt('ide.sourceControl.unstageFileTitle', 'Remove this file from the next commit'));
      }
      const remove = file && file.state === 'untracked'
        ? actionBtn(jt('ide.sourceControl.delete', 'Delete'), 'delete', jt('ide.sourceControl.deleteUntrackedTitle', 'Move this untracked file to the recycle bin'), 'ide-scm-danger')
        : actionBtn(jt('ide.sourceControl.discard', 'Discard'), 'discard', jt('ide.sourceControl.discardEditsTitle', 'Discard all edits since the last commit (cannot be undone)'), 'ide-scm-danger');
      return open + remove + actionBtn(jt('ide.sourceControl.stage', 'Stage'), 'stage', jt('ide.sourceControl.stageFileTitle', 'Stage this file for commit'));
    }

    // A Changed or Ready-to-commit row's actions, written into its empty slot once.
    function injectRow(rowEl) {
      const slot = rowEl.querySelector('.ide-scm-row-actions');
      const path = rowEl.getAttribute('data-ide-scm-path');
      const group = rowEl.closest('[data-ide-scm-group]')?.getAttribute('data-ide-scm-group');
      if (!slot || !path || (group !== 'staged' && group !== 'changed')) return;
      lastRow = { path, staged: group === 'staged' };
      const file = slot.firstElementChild ? null : getFile(path);
      if (file) slot.innerHTML = rowActionsMarkup(file, lastRow.staged);
    }

    // The panel host's delegated pointerenter (capture) and focusin listener.
    function revealRow(event) {
      const rowEl = event && event.target && typeof event.target.closest === 'function' ? event.target.closest('.ide-scm-row') : null;
      if (rowEl) injectRow(rowEl);
    }

    // After the list is repainted: the row under the pointer or focus gets its actions back.
    function reinject(hostEl) {
      if (!lastRow || !hostEl) return;
      const rows = hostEl.querySelectorAll(`[data-ide-scm-group="${lastRow.staged ? 'staged' : 'changed'}"] .ide-scm-row`);
      const rowEl = Array.prototype.find.call(rows, (el) => el.getAttribute('data-ide-scm-path') === lastRow.path);
      if (rowEl) injectRow(rowEl);
    }

    // kind: 'staged' | 'changed'. Stage All keeps its existing action id.
    function groupHeadMarkup(kind) {
      let inner = '';
      if (kind === 'staged' && has('unstageAll')) {
        inner = actionBtn(jt('ide.scmRowActions.unstageAll', 'Unstage All'), 'unstage-all', jt('ide.scmRowActions.unstageAllTitle', 'Remove every file from the next commit'));
      } else if (kind === 'changed') {
        inner = (has('discardAll')
          ? actionBtn(jt('ide.scmRowActions.discardAll', 'Discard All'), 'discard-all', jt('ide.scmRowActions.discardAllTitle', 'Discard every change since the last commit (asks first)'), 'ide-scm-danger')
          : '') + actionBtn(jt('ide.sourceControl.stageAll', 'Stage All'), 'stage-all');
      }
      return inner ? `<span class="ide-scm-group-actions">${inner}</span>` : '';
    }

    function commitOptionsMarkup() {
      if (!checkbox) return '';
      return '<div class="ide-scm-commit-options">'
        + checkbox({
          label: jt('ide.scmRowActions.amend', 'Amend last commit'),
          checked: amend,
          className: 'ide-scm-commit-option',
          dataset: { 'ide-scm-action': 'commit-amend' },
        })
        + checkbox({
          label: jt('ide.scmRowActions.signoff', 'Sign off'),
          checked: signoff,
          className: 'ide-scm-commit-option',
          dataset: { 'ide-scm-action': 'commit-signoff' },
        })
        + '</div>';
    }

    // The commit box is patched in place (never re-created), so the boxes follow state here.
    function syncCommitOptions(commitEl) {
      if (!commitEl || typeof commitEl.querySelector !== 'function') return;
      for (const [action, value] of [['commit-amend', amend], ['commit-signoff', signoff]]) {
        const input = commitEl.querySelector(`[data-ide-scm-action="${action}"]`);
        if (!input) continue;
        input.checked = value;
        input.closest?.('.inv-checkbox')?.classList.toggle('inv-checkbox--on', value);
      }
    }

    async function prefillFromLastCommit() {
      if (!has('getLastCommitMessage') || String(getMessage() || '').trim()) return;
      const token = generation;
      let message = '';
      try {
        message = String(await gitActions.getLastCommitMessage() || '');
      } catch (error) {
        appendClientLog('WARN', 'ide.scm_amend_prefill_failed', { message: String((error && error.message) || error || '').slice(0, 200) });
      }
      if (token !== generation || !amend || !message || String(getMessage() || '').trim()) return;
      prefilled = message;
      setMessage(message);
      rerender();
    }

    function setAmend(value) {
      amend = value === true;
      generation += 1;
      if (amend) {
        prefillFromLastCommit();
      } else if (prefilled && getMessage() === prefilled) {
        setMessage('');
      }
      if (!amend) prefilled = '';
      rerender();
    }

    // Returns true when the click was one of ours.
    function handleClick(action, actionEl, path) {
      switch (action) {
        case 'open-file':
          if (path) onOpenFile(path);
          return true;
        case 'stage-all':
          // One "Changed" membership rule for the button and the palette row; the
          // panel's own collector stays only as the fallback without git actions.
          if (!has('stageAll')) return false;
          gitActions.stageAll();
          return true;
        case 'unstage-all':
          if (has('unstageAll')) gitActions.unstageAll();
          return true;
        case 'discard-all':
          if (has('discardAll')) gitActions.discardAll();
          return true;
        case 'commit-amend':
          setAmend(Boolean(actionEl && actionEl.checked));
          return true;
        case 'commit-signoff':
          signoff = Boolean(actionEl && actionEl.checked);
          rerender();
          return true;
        default:
          return false;
      }
    }

    // A root switch clears both options; a successful commit keeps Sign off (as VS Code's setting does).
    function reset({ keepSignoff = false } = {}) {
      amend = false;
      if (!keepSignoff) signoff = false;
      prefilled = '';
      generation += 1;
      if (!keepSignoff) lastRow = null;
    }

    return {
      rowActionsMarkup,
      revealRow,
      reinject,
      groupHeadMarkup,
      commitOptionsMarkup,
      syncCommitOptions,
      handleClick,
      setAmend,
      commitOptions: () => ({ amend, signoff }),
      // An amend may only reword: the Commit button does not need staged files.
      allowsEmptyCommit: () => amend,
      reset,
    };
  }

  return { createScmRowActions };
});
