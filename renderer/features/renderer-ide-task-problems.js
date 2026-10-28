/* renderer/features/renderer-ide-task-problems.js - problem matchers for the Workspace
 * IDE's Run output (row 82 slice R2, plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md
 * section 7.5).
 *
 * The run-scripts line stream (ANSI already stripped) is parsed for tsc, eslint
 * stylish, pytest, Python tracebacks and node stacks. The file:line part always comes
 * from renderer/shared/file-link-detect.js, so a reference only counts when it resolves
 * inside the workspace root. Results become Monaco markers with owner `task` on open
 * models (the editor host's getMarkers, the Problems panel and the tree badges see them
 * like any other marker) plus a side list for closed files that the Problems panel
 * reads through getMarkers(). A run of the same script replaces that script's problems;
 * a root switch clears them all.
 *
 * Every matcher is anchored and works on one capped line, so a 4000-character line
 * costs one linear pass (pinned in tests/renderer-ide-task-problems.test.js). Output
 * text is untrusted: it only ever becomes marker text, never markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/file-link-detect.js'));
    return;
  }
  root.rendererIdeTaskProblems = factory(root.jennyFileLinkDetect);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fileLinkDetect) {
  'use strict';

  const OWNER = 'task';
  const MAX_LINE_CHARS = 4096;
  const MAX_CARRY_CHARS = 64 * 1024;
  const MAX_PROBLEMS = 1000;
  const MESSAGE_MAX = 2000;
  const APPLY_DELAY_MS = 120;
  const MAYBE_LINK = /[:(]|line \d/;
  const TSC_TAIL = /^(?::|\s+-)\s+(error|warning)\s+(TS\d{1,6})\s*:\s*(.*)$/;
  const ESLINT_DETAIL = /^\s+(\d{1,9}):(\d{1,9})\s+(error|warning)\s+(.*)$/;
  const ESLINT_RULE = /^@?[\w-]+(?:\/[\w-]+)*$/;
  const PYTEST_TAIL = /^:\s+(\S.*)$/;
  const PYTEST_E = /^E\s+(\S.*)$/;
  const TRACEBACK_START = /^\s*Traceback \(most recent call last\):\s*$/;
  const TRACEBACK_CHAIN = /^(?:During handling of the above exception|The above exception was the direct cause)/;
  const NODE_FRAME = /^\s+at\s/;
  const NODE_MESSAGE = /^\s*(?:Uncaught\s+)?((?:[A-Z][\w$]*)?(?:Error|Exception)\b.*)$/;
  const VENDORED = /(?:^|\/)(?:node_modules|site-packages|dist-packages)\//;
  // eslint stylish file headers: an absolute path may hold spaces; a relative one is one token
  // with a folder separator or a file extension (findLinks' own path rule).
  const HEADER_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)[^"<>|*?:\r\n]*\.[A-Za-z][A-Za-z0-9_+-]{0,15}$/;
  const HEADER_TOKEN = /^[^\s"'<>|*?:;,()[\]{}]+$/;
  const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9_+-]{0,15}$/;

  function noop() {}

  function clip(text) {
    return String(text || '').trim().slice(0, MESSAGE_MAX);
  }

  function problem(link, severity, message, source, code) {
    return {
      path: link.path,
      line: link.line,
      column: link.col || 1,
      severity,
      message: clip(message) || source,
      source,
      code: code || '',
    };
  }

  // One run's stateful line parser: eslint's file header, an open Python traceback and a
  // node error waiting for its first in-root frame carry across lines.
  function createLineParser(options) {
    const rootPath = String(options && options.rootPath || '');
    let eslintFile = '';
    let trace = null; // { frame } while inside a Python traceback
    let nodeMessage = '';
    let pytestDetail = '';

    function linksOf(text) {
      if (!fileLinkDetect || typeof fileLinkDetect.findLinks !== 'function' || !MAYBE_LINK.test(text)) return [];
      return fileLinkDetect.findLinks(text, { rootPath }) || [];
    }

    // The link that opens the line (after its indentation), if any.
    function leadingLink(text) {
      const indent = text.length - text.trimStart().length;
      const link = linksOf(text)[0];
      return link && link.start === indent ? link : null;
    }

    function pythonLine(text) {
      if (/^\s+File "/.test(text)) {
        const link = linksOf(text)[0];
        if (link && !VENDORED.test(link.path)) trace.frame = link;
        return [];
      }
      if (!text.trim() || /^\s/.test(text)) return [];
      if (TRACEBACK_CHAIN.test(text)) {
        trace = null;
        return [];
      }
      const frame = trace.frame;
      trace = null;
      return frame ? [problem(frame, 'error', text, 'python')] : [];
    }

    function nodeFrame(text) {
      const message = nodeMessage;
      if (!message) return [];
      for (const link of linksOf(text)) {
        // `node:internal/...` frames and vendored code are not the user's problem.
        if (/node:$/.test(text.slice(Math.max(0, link.start - 5), link.start)) || VENDORED.test(link.path)) continue;
        nodeMessage = '';
        return [problem(link, 'error', message, 'node')];
      }
      return [];
    }

    function eslintDetail(text) {
      const m = ESLINT_DETAIL.exec(text);
      if (!m) return null;
      const rest = m[4];
      const split = rest.lastIndexOf('  ');
      const rule = split > 0 ? rest.slice(split).trim() : '';
      const hasRule = rule && ESLINT_RULE.test(rule);
      const link = { path: eslintFile, line: Number(m[1]) || 1, col: Number(m[2]) || 1 };
      return [problem(link, m[3], hasRule ? rest.slice(0, split) : rest, 'eslint', hasRule ? rule : '')];
    }

    // tsc (`a.ts(12,5): error TS1: ...` or `a.ts:12:5 - error TS1: ...`) and pytest
    // (`tests/t.py:12: AssertionError`) both open the line with the link.
    function linkLine(text) {
      const link = leadingLink(text);
      if (!link) return null;
      const tail = text.slice(link.end);
      const tsc = TSC_TAIL.exec(tail);
      if (tsc) return [problem(link, tsc[1], tsc[3], 'tsc', tsc[2])];
      const pytest = /\.py$/.test(link.path) && link.start === 0 ? PYTEST_TAIL.exec(tail) : null;
      if (pytest) {
        const detail = pytestDetail;
        pytestDetail = '';
        return [problem(link, 'error', detail ? pytest[1] + ': ' + detail : pytest[1], 'pytest')];
      }
      return null;
    }

    // A non-indented line that is nothing but an in-root path: eslint stylish's file header.
    // The whole line is the path candidate (`C:\ws\src\my file.ts` keeps its space), resolved
    // by findLinks' containment rule; no second findLinks pass over the line (cleanup T8, T13).
    function eslintHeader(text) {
      if (/^\s/.test(text) || !text.trim() || typeof fileLinkDetect?.resolvePathInRoot !== 'function') return false;
      const trimmed = text.trim();
      const token = HEADER_TOKEN.test(trimmed) && (/[\\/]/.test(trimmed) || FILE_EXTENSION.test(trimmed));
      if (!token && !HEADER_ABSOLUTE.test(trimmed)) return false;
      const path = fileLinkDetect.resolvePathInRoot(trimmed, { rootPath });
      if (!path) return false;
      eslintFile = path;
      return true;
    }

    function line(raw) {
      const text = String(raw == null ? '' : raw).replace(/\r$/, '');
      if (text.length > MAX_LINE_CHARS) return [];
      if (trace) return pythonLine(text);
      if (TRACEBACK_START.test(text)) {
        trace = { frame: null };
        return [];
      }
      if (NODE_FRAME.test(text)) return nodeFrame(text);
      const nodeHead = NODE_MESSAGE.exec(text);
      nodeMessage = nodeHead ? nodeHead[1] : '';
      const e = PYTEST_E.exec(text);
      if (e && !pytestDetail) pytestDetail = e[1];
      if (eslintFile) {
        const found = eslintDetail(text);
        if (found) return found;
      }
      const linked = linkLine(text);
      if (linked) return linked;
      if (eslintHeader(text)) return [];
      if (!text.trim() || /^\s*[✖x] \d+ problems?/.test(text)) eslintFile = '';
      return [];
    }

    return { line };
  }

  // Every problem in `lines` (an array or a newline-joined string), for tests and tools.
  function parseLines(lines, options) {
    const parser = createLineParser(options);
    const list = Array.isArray(lines) ? lines : String(lines || '').split('\n');
    const out = [];
    for (const text of list) out.push(...parser.line(text));
    return out;
  }

  function keyOf(p) {
    return p.path + '\u0001' + p.line + '\u0001' + p.column + '\u0001' + p.message;
  }

  /**
   * @param {object} deps
   * @param {object} deps.editorHost getModel(path) and getMonaco() (setModelMarkers)
   * @param {(fn: Function) => any} [deps.schedule] coalesces marker application (tests: synchronous)
   * @param {Function} [deps.appendClientLog]
   */
  function createIdeTaskProblems(deps) {
    const d = deps || {};
    const editorHost = d.editorHost || {};
    const schedule = typeof d.schedule === 'function' ? d.schedule : (fn) => setTimeout(fn, APPLY_DELAY_MS);
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const runs = new Map(); // script key -> problems[]
    const marked = new Map(); // path -> { model, sig } of the task markers set on an open model
    const listeners = new Set();
    let current = null; // { key, parser, carry, problems, seen }
    let pending = false;
    // Bumped whenever the problem set changes; apply() notifies listeners only on a bump
    // or a file moving between Monaco markers and the side list (a tab open/close with no
    // task problems must not refresh the Problems panel).
    let revision = 0;
    let notifiedRevision = 0;
    let modelEvents = null;
    let disposed = false;

    function getModel(path) {
      try { return typeof editorHost.getModel === 'function' ? editorHost.getModel(path) || null : null; } catch (_error) { return null; }
    }

    function getMonaco() {
      try { return typeof editorHost.getMonaco === 'function' ? editorHost.getMonaco() || null : null; } catch (_error) { return null; }
    }

    function notify() {
      for (const cb of [...listeners]) {
        try { cb(); } catch (error) { appendClientLog('DEBUG', 'ide.task_problems_listener', { message: String(error?.message || error) }); }
      }
    }

    function byPath() {
      const map = new Map();
      for (const list of runs.values()) {
        for (const p of list) {
          if (!map.has(p.path)) map.set(p.path, []);
          map.get(p.path).push(p);
        }
      }
      return map;
    }

    function toMonaco(monaco, model, p) {
      const severities = monaco.MarkerSeverity || {};
      let line = p.line;
      let endColumn = p.column + 1;
      try {
        const count = typeof model.getLineCount === 'function' ? model.getLineCount() : line;
        line = Math.min(line, Math.max(1, count));
        if (typeof model.getLineMaxColumn === 'function') endColumn = Math.max(endColumn, model.getLineMaxColumn(line));
      } catch (_error) { /* a stale model keeps the one-character range */ }
      return {
        severity: p.severity === 'warning' ? (severities.Warning || 4) : (severities.Error || 8),
        message: p.message,
        source: p.source,
        code: p.code || undefined,
        startLineNumber: line,
        startColumn: p.column,
        endLineNumber: line,
        endColumn,
      };
    }

    // Model open/close moves a file between Monaco markers and the side list.
    function hasProblems() {
      if (marked.size) return true;
      for (const list of runs.values()) if (list.length) return true;
      return false;
    }

    function onModelEvent() {
      if (hasProblems()) scheduleApply();
    }

    // Monaco keeps a disposed model's markers (by URI): clear ours while the model is
    // alive, or the file shows twice once its problems return to the side list.
    function onModelDispose(monaco, model) {
      for (const [path, rec] of marked) {
        if (rec.model !== model) continue;
        monaco.editor.setModelMarkers?.(model, OWNER, []);
        marked.delete(path);
        revision += 1;
        break; // one path per model
      }
      onModelEvent();
    }

    function watchModels(monaco) {
      if (modelEvents || !monaco?.editor) return;
      const subs = [monaco.editor.onDidCreateModel?.(onModelEvent), monaco.editor.onWillDisposeModel?.((model) => onModelDispose(monaco, model))];
      modelEvents = subs.filter((sub) => sub && typeof sub.dispose === 'function');
    }

    function apply() {
      pending = false;
      if (disposed) return;
      const monaco = getMonaco();
      const setMarkers = monaco?.editor?.setModelMarkers;
      watchModels(monaco);
      const grouped = byPath();
      let moved = false;
      for (const [path, rec] of [...marked]) {
        if (grouped.has(path) && getModel(path) === rec.model) continue;
        if (typeof setMarkers === 'function' && rec.model?.isDisposed?.() !== true) monaco.editor.setModelMarkers(rec.model, OWNER, []);
        marked.delete(path);
        moved = true;
      }
      if (typeof setMarkers === 'function') {
        for (const [path, list] of grouped) {
          const model = getModel(path);
          if (!model) continue;
          const sig = list.map(keyOf).join('\u0002');
          const rec = marked.get(path);
          if (rec && rec.model === model && rec.sig === sig) continue;
          monaco.editor.setModelMarkers(model, OWNER, list.map((p) => toMonaco(monaco, model, p)));
          marked.set(path, { model, sig });
          moved = true;
        }
      }
      if (moved || revision !== notifiedRevision) {
        notifiedRevision = revision;
        notify();
      }
    }

    function scheduleApply() {
      if (pending || disposed) return;
      pending = true;
      schedule(apply);
    }

    function addProblems(found) {
      const before = current.problems.length;
      for (const p of found) {
        if (current.problems.length >= MAX_PROBLEMS) break;
        const key = keyOf(p);
        if (current.seen.has(key)) continue;
        current.seen.add(key);
        current.problems.push(p);
      }
      if (current.problems.length !== before) {
        revision += 1;
        scheduleApply();
      }
    }

    // A run of `key` starts: that script's earlier problems go now.
    function beginRun(key, options) {
      if (disposed) return;
      const name = String(key || '');
      if (runs.get(name)?.length) revision += 1;
      current = { key: name, parser: createLineParser(options), carry: '', problems: [], seen: new Set() };
      runs.set(name, current.problems);
      scheduleApply();
    }

    function push(text) {
      if (!current || disposed) return;
      // At the cap nothing more can be added: skip the parse entirely.
      if (current.problems.length >= MAX_PROBLEMS) return;
      const lines = (current.carry + String(text == null ? '' : text)).split('\n');
      current.carry = lines.pop();
      if (current.carry.length > MAX_CARRY_CHARS) current.carry = '';
      for (const line of lines) addProblems(current.parser.line(line));
    }

    function endRun() {
      if (!current || disposed) return;
      if (current.carry && current.problems.length < MAX_PROBLEMS) addProblems(current.parser.line(current.carry));
      current = null;
      apply();
    }

    function clearAll() {
      current = null;
      if (hasProblems()) revision += 1;
      runs.clear();
      apply();
    }

    // Problems for files without a task-marked open model (closed files, or no Monaco).
    function getMarkers() {
      const out = [];
      for (const [path, list] of byPath()) {
        const rec = marked.get(path);
        if (rec && getModel(path) === rec.model) continue;
        for (const p of list) out.push({ ...p });
      }
      return out;
    }

    function onChange(cb) {
      if (typeof cb === 'function') listeners.add(cb);
      return { dispose() { listeners.delete(cb); } };
    }

    function dispose() {
      if (disposed) return;
      clearAll();
      disposed = true;
      for (const sub of modelEvents || []) {
        try { sub.dispose(); } catch (_error) { /* already gone */ }
      }
      modelEvents = null;
      listeners.clear();
    }

    return { beginRun, push, endRun, clearAll, getMarkers, onChange, dispose };
  }

  return { createIdeTaskProblems, createLineParser, parseLines, OWNER, MAX_LINE_CHARS };
});
