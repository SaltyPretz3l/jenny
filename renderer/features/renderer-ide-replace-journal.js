/* renderer/features/renderer-ide-replace-journal.js - bounded, root-scoped
 * completion journal for replace-all. Records only paths already written;
 * content recovery remains Source Control's responsibility. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeReplaceJournal = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_APPLIED = 200;
  const MAX_QUERY = 500;
  const FLUSH_INTERVAL = 25;
  function noop() {}

  function createIdeReplaceJournal(deps) {
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const schedulePersist = typeof deps?.schedulePersist === 'function' ? deps.schedulePersist : noop;
    const flushPersist = typeof deps?.flushPersist === 'function' ? deps.flushPersist : noop;
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const showToast = typeof deps?.showToast === 'function' ? deps.showToast : noop;
    let openedJournal = null;
    let openedToken = null;
    let openedMarks = 0;
    let nextToken = 0;

    async function open({ query, total } = {}) {
      const ide = getIde();
      if (ide.replaceJournal && ide.replaceJournal !== openedJournal) checkRecovery();
      const token = ++nextToken;
      openedJournal = {
        startedAt: Date.now(),
        query: String(query || '').slice(0, MAX_QUERY),
        total: Number.isFinite(total) && total >= 0 ? total : 0,
        applied: [],
        truncated: false,
      };
      openedToken = token;
      openedMarks = 0;
      ide.replaceJournal = openedJournal;
      schedulePersist();
      await flushPersist();
      return token;
    }

    async function markApplied(token, relPath) {
      const journal = openedJournal;
      if (token !== openedToken || !journal || getIde().replaceJournal !== journal || !Array.isArray(journal.applied)) return false;
      const appended = journal.applied.length < MAX_APPLIED;
      if (appended) journal.applied.push(String(relPath || ''));
      else journal.truncated = true;
      openedMarks += 1;
      schedulePersist();
      if (openedMarks % FLUSH_INTERVAL === 0) await flushPersist();
      return true;
    }

    function close(token) {
      const ide = getIde();
      if (token !== openedToken || openedJournal === null || ide.replaceJournal !== openedJournal) return false;
      ide.replaceJournal = null;
      openedJournal = null;
      openedToken = null;
      openedMarks = 0;
      schedulePersist();
      return true;
    }

    function checkRecovery() {
      const journal = getIde().replaceJournal;
      if (!journal) return;
      const paths = Array.isArray(journal.applied) ? [...journal.applied] : [];
      const meta = {
        applied: paths.length,
        total: journal.total,
        truncated: journal.truncated === true,
        paths,
      };
      appendClientLog('WARN', 'ide.replace_journal_recovered', meta);
      showToast(
        `A replace-all was interrupted after at least ${meta.applied} of ${meta.total} files — review those files or use Source Control to verify.`,
        { title: 'Replace Interrupted', dedupeKey: 'ide:replace:journal-recovery' }
      );
      getIde().replaceJournal = null;
      if (journal === openedJournal) {
        openedJournal = null;
        openedToken = null;
        openedMarks = 0;
      }
      schedulePersist();
    }

    return { open, markApplied, close, checkRecovery };
  }

  return {
    createIdeReplaceJournal,
    REPLACE_JOURNAL_MAX_APPLIED: MAX_APPLIED,
    REPLACE_JOURNAL_QUERY_MAX: MAX_QUERY,
  };
});
