/* renderer/features/renderer-ide-commit-history.js - the friendly, read-only
 * commit History view folded into the Source Control panel. Renders recent commits as
 * readable cards - subject / author / relative time ("3 hours ago") / short
 * hash - from workspaceGit.getLog. Beginner-friendly: no git jargon, no
 * mutations.
 *
 * DETERMINISTIC ONLY: relative-time + card formatting are pure functions; there
 * are NO model calls anywhere (commits are never summarized/narrated by a
 * model). The pure helpers are exported for unit tests.
 *
 * Mirrors the panel's delegation pattern: the controller owns no part of this -
 * the Source Control panel constructs it, embeds a [data-ide-scm-history]
 * container in its markup, paints cached state into the fresh container after
 * each panel re-render, and re-pulls the log on git changes. The collapsible
 * "History" header toggle + Retry route through the panel's existing
 * data-ide-scm-action click delegation (history-toggle / history-retry). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererIdeCommitHistory = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  function noop() {}

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;

  // Largest-unit-first ladder. Weeks are intentionally omitted (days roll
  // straight into months) to keep the phrasing simple for non-experts.
  const RELATIVE_UNITS = [
    [YEAR, 'year'],
    [MONTH, 'month'],
    [DAY, 'day'],
    [HOUR, 'hour'],
    [MINUTE, 'minute'],
  ];

  const DEFAULT_LIMIT = 20;

  // Inline SVG carets (CSP-safe: no external src; fill=currentColor inherits the
  // toggle's themed text colour).
  const CARET_RIGHT = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"'
    + ' focusable="false" fill="currentColor"><path d="M6 4l4 4-4 4z"/></svg>';
  const CARET_DOWN = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"'
    + ' focusable="false" fill="currentColor"><path d="M4 6l4 4 4-4z"/></svg>';

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function firstLine(value) {
    return String(value == null ? '' : value).split('\n')[0].trim();
  }

  function shortHashOf(commit) {
    const short = String((commit && commit.shortSha) || '').trim();
    if (short) {
      return short;
    }
    const full = String((commit && commit.sha) || '').trim();
    return full ? full.slice(0, 7) : '';
  }

  // Pure: ISO date -> "just now" / "5 minutes ago" / "3 hours ago" / "2 days
  // ago" / "1 month ago" / "2 years ago". nowMs is injectable for deterministic
  // tests; production passes the current clock. A future-dated commit (clock
  // skew) clamps to "just now" rather than a negative span.
  function formatRelativeTime(dateISO, nowMs) {
    const then = Date.parse(String(dateISO || ''));
    if (!Number.isFinite(then)) {
      return '';
    }
    const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
    let diff = now - then;
    if (diff < 0) {
      diff = 0;
    }
    if (diff < MINUTE) {
      return 'just now';
    }
    for (let i = 0; i < RELATIVE_UNITS.length; i += 1) {
      const span = RELATIVE_UNITS[i][0];
      if (diff >= span) {
        const count = Math.floor(diff / span);
        const name = RELATIVE_UNITS[i][1];
        return `${count} ${name}${count === 1 ? '' : 's'} ago`;
      }
    }
    return 'just now';
  }

  // Best-effort absolute timestamp for the card's hover tooltip. Locale/timezone
  // dependent on purpose (it's a human hint, never asserted); falls back to the
  // raw ISO string if Date formatting throws.
  function formatExactTime(dateISO) {
    const then = Date.parse(String(dateISO || ''));
    if (!Number.isFinite(then)) {
      return '';
    }
    try {
      return new Date(then).toLocaleString();
    } catch (_error) {
      return String(dateISO || '');
    }
  }

  // Pure: a raw getLog commit -> the display model a card renders. Empty/odd
  // fields degrade to friendly placeholders rather than blanks.
  function toCardModel(commit, nowMs) {
    const c = commit || {};
    const dateISO = String(c.dateISO || '');
    return {
      subject: firstLine(c.subject) || '(no commit message)',
      author: String(c.author || '').trim() || 'Unknown author',
      shortHash: shortHashOf(c),
      // Full SHA (when present) is the unambiguous ref passed to getCommitDiff;
      // shortHash is the fallback (git resolves abbreviated hashes too).
      sha: String(c.sha || '').trim(),
      dateISO,
      relativeTime: formatRelativeTime(dateISO, nowMs),
      exactTime: formatExactTime(dateISO),
      isMerge: c.isMerge === true,
    };
  }

  function toCardModels(commits, nowMs) {
    return (Array.isArray(commits) ? commits : []).map((commit) => toCardModel(commit, nowMs));
  }

  function createIdeCommitHistory(deps) {
    const options = deps || {};
    const disposalFence = asyncFence.createDisposalFence();
    const refreshGate = asyncFence.createGenerationGate();
    const onGetLog = typeof options.onGetLog === 'function' ? options.onGetLog : null;
    // Optional: open a commit's read-only diff tab. When wired the cards become
    // clickable; absent -> the cards render as static (read-only) cards.
    const onGetCommitDiff = typeof options.onGetCommitDiff === 'function' ? options.onGetCommitDiff : null;
    const getMount = typeof options.getMount === 'function' ? options.getMount : () => null;
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : defaultEscapeHtml;
    const actionButton = typeof options.actionButton === 'function' ? options.actionButton : null;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : noop;
    const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
    const limit = Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_LIMIT;

    // commits === null means "never loaded"; an array (possibly empty) means a
    // result has landed. `silenced` is set for any no-repo degrade shape
    // (unavailable / not-a-repo) so the History renders nothing - the panel
    // already explains those states.
    let commits = null;
    let silenced = false;
    let loadError = false;
    let loading = false;
    let expanded = true;
    // Single-in-flight coalescing (mirrors the git status store): an overlapping
    // refresh request re-runs exactly once afterwards, so a burst of panel
    // re-renders collapses into at most one trailing fetch.
    let inFlight = null;
    let refreshAgain = false;

    function applyLogResult(result) {
      if (!result || result.available === false || result.isRepo === false) {
        silenced = true;
        loadError = false;
        commits = [];
        return;
      }
      silenced = false;
      if (result.ok === true && Array.isArray(result.commits)) {
        commits = result.commits.slice(0, limit);
        loadError = false;
        return;
      }
      // A degraded { ok:false } (exec failure / validation). Keep the last good
      // list if we have one (transient hiccup); only surface an error when we
      // have nothing to show.
      if (commits && commits.length) {
        return;
      }
      loadError = true;
      commits = [];
    }

    function headerMarkup() {
      const count = Array.isArray(commits) ? commits.length : 0;
      const label = `History${count ? ` (${count})` : ''}`;
      if (!actionButton) {
        return `<div class="ide-scm-history-head"><span class="ide-scm-history-title">${escapeHtml(label)}</span></div>`;
      }
      const toggle = actionButton({
        plain: true,
        className: 'ide-scm-history-toggle',
        ariaExpanded: expanded ? 'true' : 'false',
        ariaLabel: 'Toggle commit history',
        title: expanded ? 'Hide recent commits' : 'Show recent commits',
        dataset: { 'ide-scm-action': 'history-toggle' },
        trustedHtml: `<span class="ide-scm-history-chevron" aria-hidden="true">${expanded ? CARET_DOWN : CARET_RIGHT}</span>`
          + `<span class="ide-scm-history-title">${escapeHtml(label)}</span>`,
      });
      return `<div class="ide-scm-history-head">${toggle}</div>`;
    }

    function cardMarkup(modelEntry) {
      const mergeTag = modelEntry.isMerge
        ? '<span class="ide-scm-card-merge" title="Merge commit">merge</span>'
        : '';
      const hash = modelEntry.shortHash
        ? `<span class="ide-scm-card-hash" title="Commit ${escapeHtml(modelEntry.shortHash)}">${escapeHtml(modelEntry.shortHash)}</span>`
        : '';
      // Clickable only when both a diff opener is wired and we have a ref to
      // pass; the panel's click delegation routes the data-ide-scm-action.
      const ref = String(modelEntry.sha || modelEntry.shortHash || '').trim();
      const clickable = onGetCommitDiff && ref;
      const cardAttrs = clickable
        ? ` class="ide-scm-card ide-scm-card--clickable" role="button" tabindex="0"`
          + ` data-ide-scm-action="history-open" data-ide-scm-hash="${escapeHtml(ref)}"`
          + ` aria-label="View changes in commit ${escapeHtml(modelEntry.shortHash || ref)}"`
        : ' class="ide-scm-card"';
      return `<div${cardAttrs}>`
        + `<div class="ide-scm-card-subject" title="${escapeHtml(modelEntry.subject)}">${escapeHtml(modelEntry.subject)}</div>`
        + '<div class="ide-scm-card-meta">'
        + `<span class="ide-scm-card-author">${escapeHtml(modelEntry.author)}</span>`
        + '<span class="ide-scm-card-dot" aria-hidden="true">·</span>'
        + `<span class="ide-scm-card-time" title="${escapeHtml(modelEntry.exactTime)}">${escapeHtml(modelEntry.relativeTime)}</span>`
        + mergeTag
        + hash
        + '</div>'
        + '</div>';
    }

    function cardsMarkup() {
      const models = toCardModels(commits, nowFn());
      return `<div class="ide-scm-history-list">${models.map(cardMarkup).join('')}</div>`;
    }

    function errorMarkup() {
      const retry = actionButton
        ? actionButton({
          variant: 'secondary',
          size: 'sm',
          className: 'ide-scm-history-retry',
          dataset: { 'ide-scm-action': 'history-retry' },
          label: 'Try again',
        })
        : '';
      return '<div class="ide-scm-history-error" role="status">Couldn’t load recent commits.</div>' + retry;
    }

    function buildMarkup() {
      // No repo -> stay silent; the panel itself already explains the state.
      if (silenced) {
        return '';
      }
      if (commits === null) {
        return loading ? '<div class="ide-scm-history-loading">Loading recent commits…</div>' : '';
      }
      const header = headerMarkup();
      if (!expanded) {
        return header;
      }
      if (loadError && commits.length === 0) {
        return header + errorMarkup();
      }
      if (commits.length === 0) {
        return header + '<div class="ide-scm-history-empty">No commits yet.</div>';
      }
      return header + cardsMarkup();
    }

    function render() {
      if (disposalFence.isDisposed()) {
        return;
      }
      const mount = getMount();
      if (!mount) {
        return;
      }
      const markup = buildMarkup();
      if (mount.__jennyScmHistoryMarkup === markup) {
        return;
      }
      mount.innerHTML = markup;
      mount.__jennyScmHistoryMarkup = markup;
    }

    function refresh() {
      if (!onGetLog || disposalFence.isDisposed()) {
        return Promise.resolve();
      }
      // Show the loading line only on the very first load; later refreshes keep
      // the current cards visible (no flash) and swap in place when they land.
      if (commits === null && !loading) {
        loading = true;
        render();
      }
      // Single-in-flight: a refresh requested while one is running re-runs once
      // more after it settles (mirrors the git status store). The loop - rather
      // than a recursive call - keeps the RETURNED promise pending until every
      // queued re-run has settled, so `await refresh()` reflects the final
      // state; the finally resets loading/inFlight even on an unexpected throw.
      if (inFlight) {
        refreshAgain = true;
        return inFlight;
      }
      inFlight = (async () => {
        try {
          do {
            refreshAgain = false;
            const token = refreshGate.capture();
            let result;
            try {
              result = await onGetLog({ limit });
            } catch (error) {
              appendClientLog('WARN', 'ide.scm_history_load_failed', {
                message: String((error && error.message) || error || ''),
              });
              result = { ok: false, available: true, isRepo: true, op: 'getLog' };
            }
            if (!disposalFence.isDisposed() && refreshGate.isCurrent(token)) {
              applyLogResult(result);
            }
          } while (refreshAgain);
        } finally {
          // Render once, after the loop: intermediate (already-superseded)
          // results never paint, and the content-hash guard makes this a no-op
          // when nothing changed.
          loading = false;
          inFlight = null;
          if (!disposalFence.isDisposed()) {
            render();
          }
        }
      })();
      return inFlight;
    }

    // First-load gate: fetch only when the log has never loaded and none is in
    // flight. The panel calls this on every re-render so opening the panel loads
    // the History once, while staging/unstaging (which re-render the panel but
    // don't move HEAD) repaint cached cards with no wasted git call. Actual
    // re-pulls come from the events that move HEAD - a commit and onGitMetaChange
    // (the same signal the tree/statusbar/gutter trust).
    function ensureLoaded() {
      if (commits === null && !inFlight) {
        return refresh();
      }
      return Promise.resolve();
    }

    // Root switch (JCA-002): forget the previous root's log entirely so the
    // next panel render pulls the NEW root's history instead of repainting the
    // old root's cards. An in-flight load belongs to the old root — queue one
    // more loop run so its stale result is re-pulled before the final paint.
    function reset() {
      refreshGate.bump();
      commits = null;
      silenced = false;
      loadError = false;
      if (inFlight) {
        refreshAgain = true;
      }
    }

    function dispose() {
      refreshGate.bump();
      refreshAgain = false;
      disposalFence.dispose();
    }

    function toggle() {
      expanded = !expanded;
      render();
    }

    // Open the clicked commit's read-only diff tab. The git feature's
    // onGetCommitDiff owns the fetch + tab plumbing (and the error toast); this
    // only forwards the ref and logs an unexpected throw. Never throws.
    async function openCommit(hash) {
      const ref = String(hash || '').trim();
      if (!ref || !onGetCommitDiff) {
        return;
      }
      try {
        await onGetCommitDiff({ hash: ref });
      } catch (error) {
        appendClientLog('WARN', 'ide.scm_history_open_commit_failed', {
          message: String((error && error.message) || error || ''),
        });
      }
    }

    return {
      render,
      refresh,
      ensureLoaded,
      reset,
      dispose,
      toggle,
      openCommit,
    };
  }

  return {
    createIdeCommitHistory,
    formatRelativeTime,
    formatExactTime,
    toCardModel,
    toCardModels,
  };
});
