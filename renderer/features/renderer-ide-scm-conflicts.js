/* renderer/features/renderer-ide-scm-conflicts.js - row 75: unmerged
 * (conflicted) entries in the Source Control panel. Pure helpers (conflict
 * kind from the porcelain XY pair, conflict-block count), the "Needs
 * resolving" row markup and its one-line markers confirm, and the resolver the
 * git feature wires behind Mark resolved / Delete. Stage is "mark resolved"
 * here: `git add` for a resolved file, `git rm` (resolveDelete) when the
 * resolution is to delete it. Split out of the panel and the git feature so
 * neither grows past its size ratchet. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeScmConflicts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  function noop() {}

  const KINDS = new Set(['UU', 'AA', 'DD', 'UD', 'DU', 'AU', 'UA']);
  // A marker is exactly seven '<' (start) or '>' (end) at a line start, then a
  // space or EOL. A block counts by whichever end survived a half-edit.
  const START_RE = /^<{7}(?: |\r?$)/gm;
  const END_RE = /^>{7}(?: |\r?$)/gm;
  // The workspace read cap (READ_MAX_BYTES_DEFAULT in services/workspace-ide-service.js):
  // a larger file is refused (CMP-WORKSPACEFS-0011), so its markers cannot be checked.
  const READ_CAP_BYTES = 5 * 1024 * 1024;
  const TOO_LARGE_CODE = 'CMP-WORKSPACEFS-0011';

  function conflictKindOf(file) {
    const pair = `${(file && file.index) || ''}${(file && file.worktree) || ''}`;
    return KINDS.has(pair) ? pair : 'UU';
  }

  // During a rebase git swaps the sides: "us" is the branch being rebased
  // onto and "them" is your commit being replayed, so a deletion conflict
  // reads the other way round for the user. Keep / Delete stay the same.
  function displayKindOf(kind, rebasing) {
    if (!rebasing) return kind;
    if (kind === 'UD') return 'DU';
    if (kind === 'DU') return 'UD';
    return kind;
  }

  function countConflictBlocks(text) {
    if (typeof text !== 'string') return 0;
    return Math.max((text.match(START_RE) || []).length, (text.match(END_RE) || []).length);
  }

  function fileNameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  function parentDirOf(path) {
    const index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : String(path).slice(0, index);
  }

  // Only the kinds that change the decision get a visible label; a plain
  // both-edited file (and the one-side-added pairs) shows none.
  function kindLabel(kind) {
    if (kind === 'AA') return jt('ide.sourceControl.conflictBothAdded', 'both added');
    if (kind === 'UD') return jt('ide.sourceControl.conflictTheyDeleted', 'they deleted');
    if (kind === 'DU') return jt('ide.sourceControl.conflictYouDeleted', 'you deleted');
    if (kind === 'DD') return jt('ide.sourceControl.conflictBothDeleted', 'both deleted');
    return '';
  }

  function kindTitle(kind, path) {
    if (kind === 'DD') return jt('ide.sourceControl.conflictBothDeletedTitle', 'Both sides deleted this file');
    const params = { path };
    if (kind === 'AA') return jt('ide.sourceControl.conflictBothAddedTitle', 'Both sides added a file at this path — open {path} to resolve', params);
    if (kind === 'UD') return jt('ide.sourceControl.conflictTheyDeletedTitle', 'You edited this file; the other branch deleted it — open {path} to resolve', params);
    if (kind === 'DU') return jt('ide.sourceControl.conflictYouDeletedTitle', 'The other branch edited this file; you deleted it — open {path} to resolve', params);
    return jt('ide.sourceControl.conflictBothEditedTitle', 'Both sides edited this file — open {path} to resolve', params);
  }

  function conflictHint(count) {
    return jtn('ide.sourceControl.resolveBeforeCommit', count, { count }, 'Resolve {count} file before committing.', 'Resolve {count} files before committing.');
  }

  // deps: { escapeHtml, actionButton, actionBtn } (actionBtn is the panel's
  // own row-action builder); confirmCount > 0 renders the markers confirm
  // line under the row; rebasing flips the deletion-conflict wording;
  // tooLarge adds a muted note that the markers could not be checked.
  function buildConflictRowMarkup(file, deps, confirmCount, rebasing, tooLarge) {
    const { escapeHtml, actionButton, actionBtn: act } = deps;
    if (!actionButton) return '';
    const path = String(file.path || '');
    const kind = displayKindOf(conflictKindOf(file), rebasing === true);
    const dir = parentDirOf(path);
    const label = kindLabel(kind);
    // A both-deleted file has nothing on disk to open: the button stays a
    // focusable row label with no action.
    const fileButton = actionButton({
      plain: true,
      className: 'ide-scm-file',
      title: kindTitle(kind, path),
      dataset: kind === 'DD' ? {} : { 'ide-scm-action': 'open-conflict' },
      trustedHtml: '<span class="ide-scm-badge" data-git-state="conflicted" aria-hidden="true">!</span>'
        + `<span class="ide-scm-row-name">${escapeHtml(fileNameOf(path))}</span>`
        + (dir ? `<span class="ide-scm-row-dir">${escapeHtml(dir)}</span>` : '')
        + (label ? `<span class="ide-scm-row-kind">${escapeHtml(label)}</span>` : ''),
    });
    const markResolved = jt('ide.sourceControl.markResolved', 'Mark resolved');
    const actions = kind === 'UD' || kind === 'DU'
      ? act(jt('ide.sourceControl.keep', 'Keep'), 'keep', jt('ide.sourceControl.keepTitle', 'Keep this file and mark it resolved'))
        + act(jt('ide.sourceControl.deleteResolve', 'Delete'), 'delete-resolve', jt('ide.sourceControl.deleteResolveTitle', 'Delete this file and mark it resolved'), 'ide-scm-danger')
      : act(markResolved, 'resolve', jt('ide.sourceControl.markResolvedTitle', 'Mark this file resolved (stages it for the merge commit)'));
    let markup = `<div class="ide-scm-row" data-ide-scm-path="${escapeHtml(path)}" title="${escapeHtml(path)}">`
      + fileButton
      + `<span class="ide-scm-row-actions">${actions}</span></div>`;
    if (tooLarge === true && !(confirmCount > 0)) {
      markup += '<div class="ide-scm-row-confirm" data-ide-scm-conflict-note>'
        + escapeHtml(jt('ide.sourceControl.conflictTooLargeToCheck', 'Too large to check for conflict markers.'))
        + '</div>';
    }
    if (confirmCount > 0) {
      const blocks = jtn('ide.sourceControl.conflictBlockCount', confirmCount, { count: confirmCount }, '{count} conflict block', '{count} conflict blocks');
      const rest = jt('ide.sourceControl.conflictMarkersLeft', 'still in this file.');
      markup += `<div class="ide-scm-row-confirm" role="alert" data-ide-scm-confirm-path="${escapeHtml(path)}">`
        + `<span><b>${escapeHtml(blocks)}</b> ${escapeHtml(rest)}</span>`
        + act(jt('ide.sourceControl.markResolvedAnyway', 'Mark resolved anyway'), 'confirm-resolve', '', 'ide-scm-action--confirm')
        + act(jt('ide.sourceControl.openFile', 'Open file'), 'open-conflict')
        + '</div>';
    }
    return markup;
  }

  // The backend's own refusal reasons carry user-facing copy; anything else
  // (a bare git failure) gets the generic line, never raw git text.
  const OWN_REASONS = new Set(['not_conflicted', 'directory_unsupported', 'trash_unavailable', 'trash_failed']);

  // The git-feature side: Mark resolved checks the file for leftover markers
  // first (an unreadable, binary or over-cap file skips the guard: the click
  // was explicit; an over-cap row says so beforehand through probeSizes), and
  // Delete resolves through the confirm-gated resolveDelete (recycle bin, then
  // the deletion is staged).
  function createConflictResolver(deps) {
    const options = deps || {};
    const store = options.store || null;
    const getWorkspaceFsApi = typeof options.getWorkspaceFsApi === 'function' ? options.getWorkspaceFsApi : () => null;
    const getFileLifecycle = typeof options.getFileLifecycle === 'function' ? options.getFileLifecycle : () => null;
    const confirmDialog = options.confirmDialog || null;
    const editorHost = options.editorHost || null;
    const stage = typeof options.stage === 'function' ? options.stage : async () => ({ ok: false });
    const toast = typeof options.toast === 'function' ? options.toast : noop;
    // Conflicted paths too large to read for the markers check, and the size
    // probes in flight (one per path).
    const tooLarge = new Set();
    const probing = new Set();
    // Last probe time per path: a panel render re-probes a path at most every PROBE_EVERY_MS.
    const probedAt = new Map();
    const PROBE_EVERY_MS = 30000;

    function setTooLarge(path, value) {
      if (value === tooLarge.has(path)) return false;
      if (value) tooLarge.add(path);
      else tooLarge.delete(path);
      return true;
    }

    // Stats each conflicted path; onChange runs when a path's over-cap state flips.
    function probeSizes(paths, onChange) {
      const api = getWorkspaceFsApi();
      if (!api || typeof api.stat !== 'function') return;
      const current = new Set(Array.isArray(paths) ? paths : []);
      for (const known of [...probedAt.keys()]) {
        if (!current.has(known)) { probedAt.delete(known); tooLarge.delete(known); }
      }
      const now = Date.now();
      for (const path of current) {
        if (!path || probing.has(path) || now - (probedAt.get(path) ?? -Infinity) < PROBE_EVERY_MS) continue;
        probing.add(path);
        probedAt.set(path, now);
        Promise.resolve()
          .then(() => api.stat({ path }))
          .then((info) => {
            const over = Boolean(info && info.exists === true && info.kind === 'file' && Number(info.size) > READ_CAP_BYTES);
            if (setTooLarge(path, over) && typeof onChange === 'function') onChange();
          }, noop)
          .finally(() => probing.delete(path));
      }
    }

    async function resolve(path) {
      const api = getWorkspaceFsApi();
      let count = 0;
      try {
        const payload = api && typeof api.readFile === 'function' ? await api.readFile({ path }) : null;
        count = countConflictBlocks(payload && payload.content);
      } catch (error) {
        /* unreadable, binary or over the read cap: skip the guard (count stays 0) */
        if (String((error && error.code) || '') === TOO_LARGE_CODE) setTooLarge(path, true);
      }
      if (count > 0) {
        return { needsConfirm: true, count };
      }
      return stage([path]);
    }

    async function resolveDelete(path) {
      if (!path || !store || typeof store.resolveDelete !== 'function') {
        return false;
      }
      const file = fileNameOf(path);
      // Unsaved edits in an open tab are named in the confirm and discarded with the file.
      const dirtyTab = editorHost?.hasDocument?.(path) === true && editorHost?.isDirty?.(path) === true;
      const message = jt('ide.git.resolveDeleteConfirmMessage', 'This moves {file} to the recycle bin and marks the conflict resolved.', { file })
        + (dirtyTab ? ` ${jt('ide.git.resolveDeleteUnsavedTab', '{file} has unsaved changes in an open tab; they will be discarded.', { file })}` : '');
      const approved = confirmDialog && typeof confirmDialog.confirm === 'function'
        ? await confirmDialog.confirm({
          title: jt('ide.git.resolveDeleteConfirmTitle', 'Delete {file}?', { file }),
          message,
          confirmLabel: jt('ide.git.resolveDeleteConfirm', 'Delete'),
          cancelLabel: jt('ide.git.resolveDeleteCancel', 'Cancel'),
          variant: 'danger',
        })
        : false;
      if (!approved) {
        return false;
      }
      const result = await store.resolveDelete({ paths: [path] });
      if (!result || result.ok !== true) {
        const specific = OWN_REASONS.has(result?.reason) ? String(result.message || '').trim() : '';
        toast(specific || jt('ide.git.resolveDeleteFailed', 'Could not delete {file} to resolve the conflict.', { file }), `ide:resolve-delete:${path}`);
        return false;
      }
      // The file is gone: close its open tab when it is clean or the confirm
      // named its unsaved edits (closeTab never prompts); edits made after the
      // confirm stay open.
      if (editorHost?.hasDocument?.(path) === true && (dirtyTab || editorHost?.isDirty?.(path) !== true)) {
        getFileLifecycle()?.closeTab?.(path);
      }
      return true;
    }

    return { resolve, resolveDelete, probeSizes, isTooLargeToCheck: (path) => tooLarge.has(path) };
  }

  return {
    buildConflictRowMarkup,
    conflictHint,
    conflictKindOf,
    countConflictBlocks,
    createConflictResolver,
  };
});
