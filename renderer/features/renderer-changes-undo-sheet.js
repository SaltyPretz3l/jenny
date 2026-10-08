/* renderer/features/renderer-changes-undo-sheet.js
 * Pure markup for the Changes undo/redo sheet (row 34 S5; design v3 §3, v6).
 * Files are grouped by consequence: "Goes back to how it was", "Needs your
 * call" (off by default, with a switch), "Stays as is" (deleted only via a
 * switch) and "Can't be undone" (with the reason). The step-modal shell
 * (renderer/inventory/step-modal.js) frames it; the controller
 * (renderer-changes-undo.js) owns events and state.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('../inventory/action-button'),
      require('../inventory/toggle-switch')
    );
    return;
  }
  root.rendererChangesUndoSheet = factory(root.stringUtils || {}, root.inventoryActionButton, root.inventoryToggleSwitch);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, actionButton, toggleSwitchModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const escapeDefault = typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const toggleSwitch = toggleSwitchModule && typeof toggleSwitchModule.toggleSwitch === 'function'
    ? toggleSwitchModule.toggleSwitch
    : null;

  const GROUP_ORDER = ['back', 'call', 'stays', 'cannot'];

  function defaultFormatTime(ms) {
    try {
      return new Intl.DateTimeFormat(globalThis.jennyI18n?.tag?.(), { hour: 'numeric', minute: '2-digit', ...globalThis.jennyI18n?.timeOptions?.() }).format(new Date(ms));
    } catch (_error) {
      return '';
    }
  }

  function groupLabel(group, mode) {
    if (group === 'back') {
      return mode === 'redo'
        ? jt('changes.undo.groupComesBack', 'Comes back')
        : jt('changes.undo.groupBack', 'Goes back to how it was');
    }
    if (group === 'call') return jt('changes.undo.groupCall', 'Needs your call');
    if (group === 'stays') return jt('changes.undo.groupStays', 'Stays as is');
    return jt('changes.undo.groupCannot', "Can't be undone");
  }

  function reasonText(reason) {
    if (reason === 'not_git') return jt('changes.undo.reasonNotGit', "No safety copy was taken before the script changed it (this folder isn't a git repository).");
    if (reason === 'disabled') return jt('changes.undo.reasonDisabled', 'No safety copy was taken before the script changed it (safety copies are off while the command sandbox is on).');
    if (reason === 'copy_gone') return jt('changes.undo.reasonCopyGone', 'The safety copy taken before the script changed it is no longer available.');
    if (reason === 'no_record') return jt('changes.undo.reasonNoRecord', 'There is no undo record for this change.');
    return jt('changes.undo.reasonNoCopy', 'No safety copy was taken before the script changed it.');
  }

  function createUndoSheet(deps = {}) {
    const escape = typeof deps.escapeHtml === 'function' ? deps.escapeHtml : escapeDefault;
    const formatTime = typeof deps.formatTime === 'function' ? deps.formatTime : defaultFormatTime;
    const canPreview = typeof deps.canPreview === 'function' ? deps.canPreview : () => false;

    function at(ms) {
      return Number.isFinite(ms) ? formatTime(ms) : '';
    }

    function callNote(row) {
      if (row.laterTurn) {
        const time = at(row.laterTurn.timeMs);
        return time
          ? jt('changes.undo.noteLaterTurn', "A later turn ({time}) changed this file too. Undoing it would also remove that change, so it's left out unless you switch it on.", { time })
          : jt('changes.undo.noteLaterTurnNoTime', "A later turn changed this file too. Undoing it would also remove that change, so it's left out unless you switch it on.");
      }
      const time = at(row.editedMs);
      return time
        ? jt('changes.undo.noteUserEdit', "You edited this file after Jenny did ({time}). Undoing it would also remove your edit, so it's left out unless you switch it on.", { time })
        : jt('changes.undo.noteUserEditNoTime', "You edited this file after Jenny did. Undoing it would also remove your edit, so it's left out unless you switch it on.");
    }

    function backNote(row) {
      if (row.how === 'remove') return jt('changes.undo.noteRemove', 'Jenny created this file, so undo removes it.');
      if (row.how === 'move') return jt('changes.undo.noteMove', 'Moved back from {path}.', { path: row.from || '' });
      if (row.how === 'checkpoint') {
        const time = at(row.checkpointMs);
        if (row.sensitive) {
          return time
            ? jt('changes.undo.noteCheckpointHidden', 'Restored from the {time} safety copy. Contents not shown.', { time })
            : jt('changes.undo.noteCheckpointHiddenNoTime', 'Restored from the safety copy. Contents not shown.');
        }
        return time
          ? jt('changes.undo.noteCheckpoint', 'Restored from the safety copy taken at {time}.', { time })
          : jt('changes.undo.noteCheckpointNoTime', 'Restored from the safety copy taken before the script ran.');
      }
      return jt('changes.undo.noteRevert', "Jenny's edit is reverted.");
    }

    /** Rows for an undo built from the recovery preflights. */
    function undoRows(plan) {
      return plan.rows.map((row) => {
        if (row.group === 'back') return { key: row.key, path: row.path, note: backNote(row), preview: !row.sensitive && canPreview(row) };
        if (row.group === 'call') return { key: row.key, path: row.path, note: callNote(row), warn: true, toggle: jt('changes.undo.toggleUndoFile', 'Undo this file') };
        if (row.group === 'stays') return { key: row.key, path: row.path, note: jt('changes.undo.noteCreated', "A new file the script created. Undo doesn't delete new files unless you ask."), toggle: jt('changes.undo.toggleDeleteToo', 'Delete it too') };
        return { key: row.key, path: row.path, note: reasonText(row.reason) };
      }).map((row, index) => ({ ...row, group: plan.rows[index].group }));
    }

    /** Rows for a swap (Redo, or Undo again after a Redo), from its verification. */
    function swapRows(verified, mode) {
      const seen = new Set();
      const rows = [];
      for (const item of verified) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        let note;
        if (item.unchanged) {
          note = mode === 'redo'
            ? jt('changes.undo.noteComesBack', 'Put back as it was before the undo.')
            : jt('changes.undo.noteBackAfterRedo', 'Goes back to how it was after the undo.');
        } else {
          note = mode === 'redo'
            ? jt('changes.undo.noteChangedSinceUndo', 'Changed since the undo, so Redo leaves it alone.')
            : jt('changes.undo.noteChangedSinceRedo', 'Changed since the redo, so Undo leaves it alone.');
        }
        rows.push({ key: `s${rows.length}`, path: item.path, group: item.unchanged ? 'back' : 'stays', note });
      }
      return rows;
    }

    function rowHtml(row, choices) {
      const key = escape(row.key);
      let ctrl = '';
      if (row.toggle && toggleSwitch) {
        ctrl = toggleSwitch({ id: row.key, label: row.toggle, checked: Boolean(choices[row.key]), className: 'changes-undo-toggle' });
      } else if (row.preview && typeof actionButton === 'function') {
        ctrl = actionButton({
          label: jt('changes.undo.preview', 'Preview'),
          variant: 'ghost',
          size: 'sm',
          ariaExpanded: false,
          ariaControls: `changesUndoPreview-${row.key}`,
          dataset: { 'changes-undo-preview': row.key },
        });
      }
      return `<li class="changes-undo-row${row.warn ? ' changes-undo-row--warn' : ''}" data-changes-undo-row="${key}">`
        + `<span class="changes-undo-path" title="${escape(row.path)}">${escape(row.path)}</span>`
        + (ctrl ? `<span class="changes-undo-ctrl">${ctrl}</span>` : '')
        + `<span class="changes-undo-note">${escape(row.note)}</span>`
        + (row.preview ? `<div class="changes-undo-preview" id="changesUndoPreview-${key}" hidden></div>` : '')
        + '</li>';
    }

    /**
     * @param {Array} rows from undoRows / swapRows
     * @param {{ mode: 'undo'|'redo', choices?: object }} options
     */
    function buildBodyHtml(rows, options = {}) {
      const choices = options.choices || {};
      const groups = GROUP_ORDER.map((group) => {
        const members = rows.filter((row) => row.group === group);
        if (!members.length) return '';
        const count = jtn('changes.undo.fileCount', members.length, { count: members.length }, '{count} file', '{count} files');
        const labelId = `changesUndoGroup-${group}`;
        return `<section class="changes-undo-group" aria-labelledby="${labelId}">`
          + `<h3 class="changes-undo-label" id="${labelId}"><span class="changes-undo-dot changes-undo-dot--${group}" aria-hidden="true"></span>`
          + `${escape(groupLabel(group, options.mode))} · ${escape(count)}</h3>`
          + `<ul class="changes-undo-rows">${members.map((row) => rowHtml(row, choices)).join('')}</ul>`
          + '</section>';
      }).join('');
      const outside = options.mode === 'redo'
        ? ''
        : `<p class="changes-undo-outside">${escape(jt('changes.undo.outside', 'Things outside the project folder (installed packages, databases) are not undone.'))}</p>`;
      return `<div class="changes-undo">${groups}${outside}</div>`;
    }

    function title(mode, timeMs) {
      const time = at(timeMs);
      if (mode === 'redo') {
        return time
          ? jt('changes.undo.redoTitle', 'Redo the {time} changes?', { time })
          : jt('changes.undo.redoTitleNoTime', 'Redo these changes?');
      }
      return time
        ? jt('changes.undo.title', 'Undo the {time} changes?', { time })
        : jt('changes.undo.titleNoTime', 'Undo these changes?');
    }

    function summary(mode) {
      return mode === 'redo'
        ? jt('changes.undo.redoSummary', 'Puts back what undo removed, except where noted.')
        : jt('changes.undo.summary', "Your project goes back to how it was just before Jenny's turn, except where noted. You can redo this afterwards.");
    }

    function primaryLabel(mode, count) {
      return mode === 'redo'
        ? jtn('changes.undo.redoPrimary', count, { count }, 'Redo {count} file', 'Redo {count} files')
        : jtn('changes.undo.primary', count, { count }, 'Undo {count} file', 'Undo {count} files');
    }

    return { buildBodyHtml, primaryLabel, summary, swapRows, title, undoRows };
  }

  return { createUndoSheet };
});
