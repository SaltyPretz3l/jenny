/* renderer/features/renderer-ide-gutter-decorations.js - git change-bars for the
 * active Monaco editor: a green / blue / red gutter strip showing lines added /
 * modified / deleted since git HEAD. Owns its own thin workspace-git client
 * (HEAD reads, self-bootstrapped off windowRef - no controller wire), a per-path
 * HEAD cache, a debounce, and the recompute lifecycle (buffer change, file
 * switch via the ide:active-file-changed event, and git refresh). The pure
 * line-diff + decoration mapping are exported for unit tests and never touch
 * Monaco. Decorations apply to the file's model through the editor host, so they
 * survive tab switches and vanish when the model is disposed on close. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererIdeGutterDecorations = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  const DEBOUNCE_MS = 200;
  // Upper bound on the debounce: a burst of model changes (format-document,
  // project-wide replace, auto-save + refresh) keeps resetting the 200ms timer,
  // so without this the change-bars could lag arbitrarily. Guarantee at least one
  // recompute per this window measured from the burst's first schedule().
  const MAX_WAIT_MS = 2000;
  // Diff guards: degrade to a coarse whole-region diff past either. The per-side
  // line cap is the cheap, predictable bail (catches an edit at both ends of a
  // big-but-not-flagged file, where prefix/suffix trim can't shrink the core);
  // the cell cap then bounds the admitted search for asymmetric cores.
  const MAX_DIFF_LINES = 5000;
  const MAX_DIFF_CELLS = 4000000;
  // Bound HEAD-cache growth over a long session (FIFO eviction); entries are
  // also dropped wholesale on every git refresh (refreshActive).
  const MAX_HEAD_CACHE = 64;

  // Gutter decoration classes (styles/ide-gutter.css). The palette state vars are
  // shared with the tree git decorations so the strip re-themes automatically.
  const GUTTER_CLASS = {
    added: 'ide-gutter-change ide-gutter-change--added',
    modified: 'ide-gutter-change ide-gutter-change--modified',
    deleted: 'ide-gutter-change ide-gutter-change--deleted',
  };

  // Normalize EOL then split into lines. A trailing newline yields a trailing ''
  // on both sides, so it cancels out of the diff.
  function splitLines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  }

  // Myers diff over the changed core of two line arrays -> an ordered op script of
  // 'equal' | 'delete' | 'insert'. Common prefix/suffix are trimmed by the
  // caller; over either guard the core degrades to one delete-all + insert-all
  // block (a single coarse "modified" region) before any frontier allocation.
  function diffCore(a, b) {
    const n = a.length;
    const m = b.length;
    if (n === 0) { return new Array(m).fill('insert'); }
    if (m === 0) { return new Array(n).fill('delete'); }
    if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES || n * m > MAX_DIFF_CELLS) {
      return new Array(n).fill('delete').concat(new Array(m).fill('insert'));
    }
    const max = n + m;
    const offset = max + 1;
    // Myers costs O((n + m) * D), so an unbounded D is slower than the matrix it
    // replaced on a wholly-rewritten core: 2000x2000 with nothing in common
    // measured 128ms against the old 23ms. Spend the SAME cell budget the matrix
    // had, re-expressed for this algorithm - past it, take the existing coarse
    // degrade, which is what a fully-rewritten region renders as anyway.
    const maxDistance = Math.min(max, Math.max(64, Math.floor(MAX_DIFF_CELLS / max)));
    const frontier = new Int32Array((2 * max) + 3);
    const trace = [];
    frontier[offset + 1] = 0;

    for (let d = 0; ; d += 1) {
      if (d > maxDistance) {
        return new Array(n).fill('delete').concat(new Array(m).fill('insert'));
      }
      // Only the k-range [-d, d] is live at depth d; snapshotting the whole
      // frontier per level would make the trace O(D * (n + m)) instead of O(D^2).
      trace.push(frontier.slice(offset - d - 1, offset + d + 2));
      for (let k = -d; k <= d; k += 2) {
        const index = offset + k;
        let x;
        if (k === -d || (k !== d && frontier[index - 1] < frontier[index + 1])) {
          x = frontier[index + 1];
        } else {
          x = frontier[index - 1] + 1;
        }
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
        frontier[index] = x;
        if (x < n || y < m) { continue; }

        const ops = [];
        let backX = n;
        let backY = m;
        for (let backD = d; backD >= 0; backD -= 1) {
          const previous = trace[backD];
          const backK = backX - backY;
          // trace[backD] is the trimmed k-range [-backD-1, backD+1], so k maps
          // to index k + backD + 1 rather than k + offset. The extra slot each
          // side carries the k=+/-(d+1) neighbours the backtrack reads, including
          // the d=0 seed at k=1 that seeds the leading equal-run.
          const backIndex = backD + 1 + backK;
          const previousK = backK === -backD
            || (backK !== backD && previous[backIndex - 1] < previous[backIndex + 1])
            ? backK + 1
            : backK - 1;
          const previousX = previous[backD + 1 + previousK];
          const previousY = previousX - previousK;
          while (backX > previousX && backY > previousY) {
            ops.push('equal');
            backX -= 1;
            backY -= 1;
          }
          if (backD === 0) { break; }
          if (backX === previousX) { ops.push('insert'); backY -= 1; }
          else { ops.push('delete'); backX -= 1; }
        }
        return ops.reverse();
      }
    }
  }

  // Trim the common prefix (length `lo`) and suffix so the Myers search only
  // spans the changed region, then diff that core. The prefix/suffix lines are
  // unchanged, so the caller starts at line `lo` and ignores the suffix entirely
  // (no need to materialize an 'equal' op per unchanged line).
  function diffOps(oldLines, newLines) {
    const n = oldLines.length;
    const m = newLines.length;
    let lo = 0;
    while (lo < n && lo < m && oldLines[lo] === newLines[lo]) { lo += 1; }
    let hiA = n;
    let hiB = m;
    while (hiA > lo && hiB > lo && oldLines[hiA - 1] === newLines[hiB - 1]) { hiA -= 1; hiB -= 1; }
    return { lo, core: diffCore(oldLines.slice(lo, hiA), newLines.slice(lo, hiB)) };
  }

  // HEAD-vs-buffer line diff -> change regions in NEW-file coordinates (1-based).
  // added: new lines with no removed counterpart; modified: new lines replacing
  // removed ones; deleted: a single boundary marker at the line now occupying the
  // deletion point (the removed lines no longer exist in the buffer).
  function diffLineRegions(oldText, newText) {
    const newLines = splitLines(newText);
    const { lo, core } = diffOps(splitLines(oldText), newLines);
    const regions = [];
    const deletedLines = new Set();
    let newIdx = lo; // the `lo` common-prefix lines are unchanged
    let k = 0;
    while (k < core.length) {
      if (core[k] === 'equal') { newIdx += 1; k += 1; continue; }
      const hunkStart = newIdx;
      let dels = 0;
      let ins = 0;
      while (k < core.length && core[k] !== 'equal') {
        if (core[k] === 'insert') { ins += 1; newIdx += 1; } else { dels += 1; }
        k += 1;
      }
      if (ins > 0) {
        regions.push({ type: dels > 0 ? 'modified' : 'added', startLine: hunkStart + 1, endLine: hunkStart + ins });
      } else if (dels > 0) {
        // Several deletion-only hunks can clamp to the same boundary line (e.g. a
        // multi-line file edited down to one line, losing its trailing newline):
        // collapse them into one marker so the gutter never double-paints a line.
        const startLine = Math.min(hunkStart, Math.max(0, newLines.length - 1)) + 1;
        if (!deletedLines.has(startLine)) {
          deletedLines.add(startLine);
          regions.push({ type: 'deleted', startLine, endLine: startLine });
        }
      }
    }
    return regions;
  }

  // Change regions -> Monaco model decorations (linesDecorationsClassName paints
  // the gutter lane). range columns are 1 (the strip is whole-line).
  function computeGutterDecorations(oldText, newText) {
    return diffLineRegions(oldText, newText).map((region) => ({
      range: { startLineNumber: region.startLine, startColumn: 1, endLineNumber: region.endLine, endColumn: 1 },
      options: { isWholeLine: false, linesDecorationsClassName: GUTTER_CLASS[region.type], description: 'jenny-gutter-change' },
    }));
  }

  function createIdeGutterDecorations(deps) {
    const options = deps || {};
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const editorHost = options.editorHost || null;
    const windowRef = options.windowRef || globalRef.window || globalRef;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : function noop() {};
    const debounceMs = Number.isFinite(options.debounceMs) ? Number(options.debounceMs) : DEBOUNCE_MS;
    const maxWaitMs = Number.isFinite(options.maxWaitMs) ? Number(options.maxWaitMs) : MAX_WAIT_MS;
    const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
    const setTimeoutFn = typeof options.setTimeoutFn === 'function'
      ? options.setTimeoutFn
      : (typeof setTimeout === 'function' ? setTimeout : null);
    const clearTimeoutFn = typeof options.clearTimeoutFn === 'function'
      ? options.clearTimeoutFn
      : (typeof clearTimeout === 'function' ? clearTimeout : null);

    // Own thin git client for HEAD reads (self-bootstraps off windowRef). HEAD
    // text is cached per path: undefined = not yet fetched (cache miss), null =
    // no git baseline (skip), '' = new/untracked file (all-added), string = the
    // committed text.
    const clientUtils = options.clientUtils
      || globalRef.rendererWorkspaceGitClient
      || (typeof require === 'function' ? (() => {
        try { return require('./renderer-workspace-git-client'); } catch (_error) { return null; }
      })() : null)
      || {};
    const gitClient = options.gitClient
      || (typeof clientUtils.createWorkspaceGitClient === 'function'
        ? clientUtils.createWorkspaceGitClient({ windowRef })
        : null);

    const headCache = new Map();
    const fence = asyncFence.createDisposalFence();
    const headCacheGate = asyncFence.createGenerationGate();
    let timer = null;
    let pendingPath = '';
    // Timestamp of the first schedule() in the current debounce burst (0 = idle).
    // Bounds the total debounce latency to maxWaitMs even under a continuous
    // change stream; reset once the timer fires so the next burst gets a fresh
    // window.
    let firstScheduledAt = 0;

    function clearGutter(path) {
      if (editorHost && typeof editorHost.setGutterDecorations === 'function') {
        editorHost.setGutterDecorations(path, []);
      }
    }

    async function recompute(path) {
      const norm = String(path || '');
      // Active-file only: the large-file reader + the model decorations both
      // target the live editor.
      if (fence.isDisposed() || !editorHost || !norm || !gitClient || editorHost.getActivePath() !== norm) {
        return;
      }
      if (typeof editorHost.getDocumentKind === 'function' && editorHost.getDocumentKind(norm) !== 'file') {
        clearGutter(norm);
        return;
      }
      const reader = windowRef && windowRef.rendererIdeActiveEditorReader;
      if (reader && typeof reader.isLargeFile === 'function' && reader.isLargeFile() === true) {
        clearGutter(norm);
        return;
      }
      let head = headCache.get(norm);
      if (head === undefined) {
        const cacheToken = headCacheGate.capture();
        const res = await gitClient.getFileAtHead({ path: norm }).catch((error) => {
          appendClientLog('WARN', 'ide.gutter_head_read_failed', { message: String((error && error.message) || error || '') });
          return null;
        });
        if (fence.isDisposed() || !headCacheGate.isCurrent(cacheToken)) return;
        head = (res && res.ok === true) ? (res.found ? String(res.content == null ? '' : res.content) : '') : null;
        headCache.set(norm, head);
        if (headCache.size > MAX_HEAD_CACHE) {
          headCache.delete(headCache.keys().next().value);
        }
        if (editorHost.getActivePath() !== norm) {
          return;
        }
      }
      if (head === null) {
        clearGutter(norm);
        return;
      }
      editorHost.setGutterDecorations(norm, computeGutterDecorations(head, editorHost.getValue(norm)));
    }

    function schedule(path) {
      if (fence.isDisposed() || !setTimeoutFn) {
        return;
      }
      pendingPath = String(path || '') || (editorHost ? editorHost.getActivePath() : '');
      const now = nowFn();
      if (firstScheduledAt === 0) {
        firstScheduledAt = now;
      }
      if (timer && clearTimeoutFn) {
        clearTimeoutFn(timer);
      }
      // Cap the delay so the timer never extends past maxWaitMs from the burst's
      // first schedule(): once the window is exhausted the recompute fires now.
      const elapsed = now - firstScheduledAt;
      const delay = elapsed >= maxWaitMs ? 0 : Math.min(debounceMs, maxWaitMs - elapsed);
      timer = setTimeoutFn(() => {
        timer = null;
        firstScheduledAt = 0;
        recompute(pendingPath);
      }, delay);
    }

    // A git refresh (commit / branch switch / discard) can move HEAD for ANY
    // file, not just the active one, so the whole cache is dropped (per-path
    // invalidation would leave backgrounded files showing a diff vs a stale
    // HEAD when reactivated). Only the active file is refetched eagerly here;
    // backgrounded entries simply re-fetch lazily on their next activation.
    function refreshActive() {
      headCacheGate.bump();
      headCache.clear();
      schedule(editorHost ? editorHost.getActivePath() : '');
    }

    function handleActiveFileChanged(event) {
      const detailPath = event && event.detail && event.detail.path;
      schedule(detailPath || (editorHost ? editorHost.getActivePath() : ''));
    }

    if (windowRef && typeof windowRef.addEventListener === 'function') {
      windowRef.addEventListener('ide:active-file-changed', handleActiveFileChanged);
    }

    return {
      schedule,
      refreshActive,
      recompute,
      dispose() {
        headCacheGate.bump();
        fence.dispose();
        if (timer && clearTimeoutFn) {
          clearTimeoutFn(timer);
        }
        timer = null;
        firstScheduledAt = 0;
        headCache.clear();
        if (windowRef && typeof windowRef.removeEventListener === 'function') {
          windowRef.removeEventListener('ide:active-file-changed', handleActiveFileChanged);
        }
      },
    };
  }

  return {
    createIdeGutterDecorations,
    diffLineRegions,
    computeGutterDecorations,
    splitLines,
    GUTTER_CLASS,
  };
});
