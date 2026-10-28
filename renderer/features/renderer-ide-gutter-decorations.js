/* renderer/features/renderer-ide-gutter-decorations.js - git change-bars for the
 * active Monaco editor: a green / blue / red gutter strip showing lines added /
 * modified / deleted since git HEAD. Owns its own thin workspace-git client
 * (HEAD reads, self-bootstrapped off windowRef - no controller wire), a per-path
 * HEAD cache, a debounce, and the recompute lifecycle (buffer change, file
 * switch via the ide:active-file-changed event, and git refresh). The pure
 * line-diff + decoration mapping are exported for unit tests and never touch
 * Monaco. Decorations apply to the file's model through the editor host, so they
 * survive tab switches and vanish when the model is disposed on close.
 * Row 82 G2: the same HEAD baseline also yields the change blocks with their HEAD
 * text (diffChangeBlocks), a click on a change bar opens the hunk peek
 * (renderer-ide-hunk-peek.js), and the buffer-to-HEAD line map feeds inline blame
 * (renderer-ide-inline-blame.js); both are built here so the controller adds no
 * wiring. */
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

  // The degraded op script: delete-all + insert-all, flagged so the change block it
  // yields can say it is coarse (cleanup wave G5).
  function coarseOps(n, m) {
    const ops = new Array(n).fill('delete').concat(new Array(m).fill('insert'));
    ops.coarse = true;
    return ops;
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
      return coarseOps(n, m);
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
        return coarseOps(n, m);
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

  // Row 82 G2: HEAD-vs-buffer change blocks in buffer coordinates (the arrays line up
  // with Monaco's lines, a trailing '' standing for the final newline), each with its
  // HEAD lines. anchorLine is the first changed buffer line, or for a pure deletion
  // the boundary line the gutter marks (as diffLineRegions clamps it). Either side may
  // be pre-split (or pre-keyed: the hunk peek's stage patch). A block from a degraded
  // diff carries coarse: true (Revert and Stage then act on the whole region).
  function diffChangeBlocks(oldText, newText) {
    const newLines = Array.isArray(newText) ? newText : splitLines(newText);
    const oldLines = Array.isArray(oldText) ? oldText : splitLines(oldText);
    const { lo, core } = diffOps(oldLines, newLines);
    const blocks = [];
    let oldIdx = lo;
    let newIdx = lo;
    let k = 0;
    while (k < core.length) {
      if (core[k] === 'equal') { oldIdx += 1; newIdx += 1; k += 1; continue; }
      const oldStart0 = oldIdx;
      const newStart0 = newIdx;
      while (k < core.length && core[k] !== 'equal') {
        if (core[k] === 'insert') newIdx += 1; else oldIdx += 1;
        k += 1;
      }
      const newCount = newIdx - newStart0;
      const oldCount = oldIdx - oldStart0;
      const anchorLine = newCount > 0 ? newStart0 + 1 : Math.min(newStart0, Math.max(0, newLines.length - 1)) + 1;
      blocks.push({
        type: newCount === 0 ? 'deleted' : (oldCount === 0 ? 'added' : 'modified'),
        oldStart0, oldCount, newStart0, newCount, anchorLine,
        endLine: newCount > 0 ? newStart0 + newCount : anchorLine,
        oldLines: oldLines.slice(oldStart0, oldIdx),
        newLines: newLines.slice(newStart0, newIdx),
        ...(core.coarse === true ? { coarse: true } : {}),
      });
    }
    return blocks;
  }

  // HEAD-vs-buffer line diff -> change regions in NEW-file coordinates (1-based):
  // the change blocks' gutter spans. A deleted block marks the boundary line now at the
  // deletion point; several deletion-only blocks can clamp to the same line (a file
  // edited down to one line, losing its final newline): one marker, never a double paint.
  function diffLineRegions(oldText, newText) {
    const marked = new Set();
    return diffChangeBlocks(oldText, newText)
      .filter((block) => block.type !== 'deleted' || (!marked.has(block.anchorLine) && marked.add(block.anchorLine)))
      .map((block) => ({ type: block.type, startLine: block.anchorLine, endLine: block.endLine }));
  }

  // A buffer line's number in HEAD, or null when the line was added or changed since
  // HEAD (or past HEAD's last real line: the trailing '' is not blameable).
  function headLineFor(blocks, line, headLines) {
    const line0 = Math.floor(Number(line)) - 1;
    if (!Number.isInteger(line0) || line0 < 0 || !Array.isArray(headLines)) return null;
    let delta = 0;
    for (const block of blocks || []) {
      if (line0 < block.newStart0) break;
      if (line0 < block.newStart0 + block.newCount) return null;
      delta += block.oldCount - block.newCount;
    }
    const head0 = line0 + delta;
    const usable = headLines.length && headLines[headLines.length - 1] === '' ? headLines.length - 1 : headLines.length;
    return head0 >= 0 && head0 < usable ? head0 + 1 : null;
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
    // is cached per path as its normalized split lines: undefined = not yet
    // fetched (cache miss), null = no git baseline (skip), [''] = new/untracked
    // file (all-added), otherwise the committed lines.
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
    let blocksMemo = null; // { path, head, value, blocks }: one diff per buffer state
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
      inlineBlame?.clear();
    }

    // Row 82 G2: the change blocks against the current buffer (null without a HEAD
    // baseline), memoized per buffer state so the peek, Next/Previous and blame share one diff.
    function getChangeBlocks(path) {
      const norm = String(path || '');
      const head = headCache.get(norm);
      if (!editorHost || !norm || !Array.isArray(head)) return null;
      const value = editorHost.getValue(norm);
      if (blocksMemo && blocksMemo.path === norm && blocksMemo.head === head && blocksMemo.value === value) return blocksMemo;
      blocksMemo = { path: norm, head, value, blocks: diffChangeBlocks(head, value) };
      return blocksMemo;
    }
    function headLineAt(path, line) {
      const memo = getChangeBlocks(path);
      return memo ? headLineFor(memo.blocks, line, memo.head) : null;
    }
    const cursorLine = () => Number(editorHost?.getCursorInfo?.()?.lineNumber) || 1;
    const resolveUtils = (globalName, requirePath) => options[globalName] || globalRef[globalName]
      || (typeof require === 'function' ? (() => { try { return require(requirePath); } catch (_error) { return null; } })() : null) || {};
    const inlineBlame = resolveUtils('rendererIdeInlineBlame', './renderer-ide-inline-blame').createIdeInlineBlame?.({
      editorHost, gitClient, getIde: options.getIde, headLineFor: headLineAt, headFor: (path) => headCache.get(String(path || '')), appendClientLog, setTimeoutFn, clearTimeoutFn,
    }) || null;
    // The baseline generation bumps on every git refresh, the root switch included (it
    // empties the status store), so the peek's stage re-check reads it as the root epoch.
    const hunkPeek = resolveUtils('rendererIdeHunkPeek', './renderer-ide-hunk-peek').createIdeHunkPeek?.({
      editorHost, gitClient, getDom: options.getDom, getChangeBlocks, appendClientLog,
      refreshGit: options.refreshGit, showToastMessage: options.showToastMessage, getRootEpoch: () => headCacheGate.current(),
    }) || null;

    // The primary editor is one Monaco instance reused across files: hook it once.
    // Clicking a change bar opens the peek; the caret feeds inline blame; an edit
    // drops the blame text at once (the debounced recompute re-asks after).
    const hookedEditors = new WeakSet();
    function hookEditor(path) {
      const editor = editorHost?.editorFor?.(path) || null;
      if (!editor || hookedEditors.has(editor)) return;
      hookedEditors.add(editor);
      const laneTarget = editorHost.getMonaco?.()?.editor?.MouseTargetType?.GUTTER_LINE_DECORATIONS;
      // The peek finds the block under the line itself (a line with none opens nothing).
      editor.onMouseDown?.((event) => {
        const target = event && event.target;
        const active = editorHost.getActivePath();
        if (!target || laneTarget === undefined || target.type !== laneTarget || !target.position || !active) return;
        hunkPeek?.openAt(active, target.position.lineNumber);
      });
      editor.onDidChangeCursorSelection?.((event) => {
        const active = editorHost.getActivePath();
        if (active && editorHost.editorFor?.(active) === editor) inlineBlame?.handleCursor(active, event?.selection?.positionLineNumber || cursorLine());
      });
      editor.onDidChangeModelContent?.(() => { inlineBlame?.clear(); hunkPeek?.close(); });
      editor.onDidScrollChange?.(() => hunkPeek?.close());
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
      if (editorHost.isLargeFile?.(norm) === true) {
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
        head = (res && res.ok === true) ? splitLines(res.found ? res.content : '') : null;
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
      hookEditor(norm);
      inlineBlame?.handleCursor(norm, cursorLine());
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
      blocksMemo = null;
      inlineBlame?.invalidate();
      schedule(editorHost ? editorHost.getActivePath() : '');
    }

    function handleActiveFileChanged(event) {
      const detailPath = event && event.detail && event.detail.path;
      hunkPeek?.close();
      inlineBlame?.clear();
      schedule(detailPath || (editorHost ? editorHost.getActivePath() : ''));
    }

    // Go to Next / Previous Change (wraps), from the cursor line of the active file.
    function goToChange(direction) {
      const active = editorHost?.getActivePath?.() || '';
      const memo = getChangeBlocks(active);
      if (!memo || !memo.blocks.length) return false;
      const line = cursorLine();
      const anchors = memo.blocks.map((block) => block.anchorLine);
      const target = direction < 0
        ? ([...anchors].reverse().find((anchor) => anchor < line) ?? anchors[anchors.length - 1])
        : (anchors.find((anchor) => anchor > line) ?? anchors[0]);
      editorHost.revealPosition?.(active, target, 1);
      return true;
    }

    if (windowRef && typeof windowRef.addEventListener === 'function') {
      windowRef.addEventListener('ide:active-file-changed', handleActiveFileChanged);
    }

    return {
      schedule,
      refreshActive,
      recompute,
      getChangeBlocks,
      headLineAt,
      goToChange,
      hunkPeek,
      inlineBlame,
      dispose() {
        headCacheGate.bump();
        fence.dispose();
        hunkPeek?.dispose();
        inlineBlame?.dispose();
        blocksMemo = null;
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
    diffChangeBlocks,
    headLineFor,
    computeGutterDecorations,
    splitLines,
    GUTTER_CLASS,
  };
});
