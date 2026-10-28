/* renderer/features/renderer-ide-editorconfig.js - .editorconfig support for the
 * Workspace IDE (row 82 P2 E2, plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md 5.4).
 *
 * createEditorconfigResolver: pure resolver. Walks a file's folders up to the
 * workspace root (<= 16 levels, stops after `root = true`), parses each
 * .editorconfig once per resolver (per-directory cache) and merges the matching
 * sections, closer files overriding farther ones and later sections earlier ones.
 * Only workspace-relative '/' paths are accepted; '..' or absolute paths resolve
 * to null so nothing outside the root is ever read.
 *
 * createEditorconfigApplier: binds the resolver to the editor host. It applies
 * indent settings per document, EOL only to a document with no line break yet
 * (so opening never dirties a file), and exposes hygieneFor() so save hygiene can
 * trim / append a final newline / convert EOL. It never writes a preference.
 * A watcher change drops only the changed directory's cache and re-applies the
 * paths under it once per 200 ms burst; when a section stops setting an indent,
 * the document's own indent comes back unless the user picked one. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorconfig = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const CONFIG_NAME = '.editorconfig';
  const MAX_LEVELS = 16;
  const MAX_SECTIONS = 512;
  const MAX_INDENT = 64;
  const MAX_TRACKED_PATHS = 512;
  const REAPPLY_DEBOUNCE_MS = 200;
  const READ_MAX_BYTES = 65536;
  const KNOWN_KEYS = new Set([
    'root', 'indent_style', 'indent_size', 'tab_width', 'end_of_line',
    'trim_trailing_whitespace', 'insert_final_newline',
  ]);

  function resolveGlobMatch() {
    if (globalRef.jennyGlobMatch) return globalRef.jennyGlobMatch;
    if (typeof require === 'function') {
      try { return require('../shared/glob-match'); } catch (_error) { /* unavailable */ }
    }
    return null;
  }

  const globCache = new Map();
  function compileGlob(pattern) {
    if (globCache.has(pattern)) return globCache.get(pattern);
    const glob = resolveGlobMatch();
    // A '/' in the section glob anchors it to the .editorconfig's own directory.
    const source = pattern.includes('/') && !pattern.startsWith('/') ? `/${pattern}` : pattern;
    const matcher = glob ? glob.compile(source) : { test: () => false };
    if (globCache.size >= 256) globCache.delete(globCache.keys().next().value);
    globCache.set(pattern, matcher);
    return matcher;
  }

  // Value -> normalized value, `undefined` (invalid, ignored) or null (unset).
  function parseValue(key, raw) {
    const value = raw.toLowerCase();
    if (value === 'unset') return null;
    switch (key) {
      case 'root': case 'trim_trailing_whitespace': case 'insert_final_newline':
        return value === 'true' ? true : value === 'false' ? false : undefined;
      case 'indent_style':
        return value === 'space' || value === 'tab' ? value : undefined;
      case 'end_of_line':
        return value === 'lf' || value === 'crlf' ? value : undefined;
      case 'indent_size': case 'tab_width': {
        if (key === 'indent_size' && value === 'tab') return 'tab';
        if (!/^[1-9]\d{0,3}$/.test(value)) return undefined;
        const n = Number(value);
        return n <= MAX_INDENT ? n : undefined;
      }
      default: return undefined;
    }
  }

  function parseEditorconfig(text) {
    const parsed = { root: false, sections: [] };
    let section = null;
    let inPreamble = true;
    let source = String(text || '');
    if (source.charCodeAt(0) === 0xFEFF) source = source.slice(1);
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line[0] === '#' || line[0] === ';') continue;
      if (line[0] === '[' && line.endsWith(']')) {
        inPreamble = false;
        section = parsed.sections.length < MAX_SECTIONS
          ? { matcher: compileGlob(line.slice(1, -1).trim()), props: {} } : null;
        if (section) parsed.sections.push(section);
        continue;
      }
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim().toLowerCase();
      if (!KNOWN_KEYS.has(key)) continue;
      const value = parseValue(key, line.slice(eq + 1).trim());
      if (value === undefined) continue;
      if (inPreamble) {
        if (key === 'root') parsed.root = value === true;
      } else if (section && key !== 'root') {
        section.props[key] = value;
      }
    }
    return parsed;
  }

  // Normalizes to a workspace-relative '/' path; null for absolute / '..' / empty.
  function normalizeRelPath(path) {
    const text = String(path == null ? '' : path).replace(/\\/g, '/');
    if (!text || text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return null;
    const parts = [];
    for (const part of text.split('/')) {
      if (part === '..') return null;
      if (part && part !== '.') parts.push(part);
    }
    return parts.length ? parts.join('/') : null;
  }

  function mergeProps(into, props) {
    for (const key of Object.keys(props)) {
      if (props[key] === null) delete into[key];
      else into[key] = props[key];
    }
  }

  // Merged raw props -> the public subset with the indent_size / tab_width mapping.
  function finalizeProps(merged) {
    const out = {};
    const size = merged.indent_size;
    const tabWidth = merged.tab_width;
    if (merged.indent_style) out.indent_style = merged.indent_style;
    const indentSize = size === 'tab' ? tabWidth : size;
    const width = tabWidth === undefined && typeof size === 'number' ? size : tabWidth;
    if (indentSize !== undefined) out.indent_size = indentSize;
    if (width !== undefined) out.tab_width = width;
    for (const key of ['end_of_line', 'trim_trailing_whitespace', 'insert_final_newline']) {
      if (merged[key] !== undefined) out[key] = merged[key];
    }
    return Object.keys(out).length ? out : null;
  }

  function createEditorconfigResolver({ readText, listDirectory = null, rootPath = '', onInvalidate = null } = {}) {
    const rootPrefix = normalizeRelPath(rootPath) || '';
    let cache = new Map(); // dir -> Promise<parsed|null>
    let generation = 0;
    let disposed = false;

    async function loadDir(dir) {
      const rel = rootPrefix ? `${rootPrefix}/${dir ? `${dir}/` : ''}${CONFIG_NAME}` : `${dir ? `${dir}/` : ''}${CONFIG_NAME}`;
      try {
        if (typeof listDirectory === 'function') {
          const names = await listDirectory(rootPrefix ? `${rootPrefix}${dir ? `/${dir}` : ''}` : dir);
          if (Array.isArray(names) && !names.includes(CONFIG_NAME)) return null;
        }
        const text = await readText(rel);
        return typeof text === 'string' ? parseEditorconfig(text) : null;
      } catch (_error) {
        return null;
      }
    }

    function parsedFor(dir) {
      if (!cache.has(dir)) cache.set(dir, loadDir(dir));
      return cache.get(dir);
    }

    async function resolveOnce(rel) {
      const segments = rel.split('/');
      const dirs = [];
      for (let n = segments.length - 1; n >= 0 && dirs.length < MAX_LEVELS; n -= 1) {
        dirs.push(segments.slice(0, n).join('/'));
      }
      // Every ancestor read starts at once; the chain still stops at the nearest root=true.
      const pending = dirs.map(parsedFor);
      const chain = []; // nearest first
      for (let i = 0; i < dirs.length; i += 1) {
        const parsed = await pending[i];
        if (!parsed) continue;
        chain.push({ dir: dirs[i], parsed });
        if (parsed.root) break;
      }
      const merged = {};
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const { dir, parsed } = chain[i];
        const local = dir ? rel.slice(dir.length + 1) : rel;
        for (const section of parsed.sections) {
          if (section.matcher.test(local)) mergeProps(merged, section.props);
        }
      }
      return finalizeProps(merged);
    }

    async function resolve(relPath) {
      const rel = normalizeRelPath(relPath);
      if (!rel || disposed || typeof readText !== 'function') return null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const startedAt = generation;
        const props = await resolveOnce(rel);
        if (startedAt === generation) return props;
      }
      return null;
    }

    // invalidate(dir) drops the one directory whose .editorconfig changed (its subtree is
    // what can resolve differently); invalidate() with no directory drops everything.
    function invalidate(dir) {
      generation += 1;
      const key = typeof dir === 'string' ? normalizeRelPath(dir) || '' : null;
      if (key === null) cache = new Map();
      else cache.delete(key);
      if (typeof onInvalidate === 'function') onInvalidate(key);
    }

    function dispose() {
      disposed = true;
      generation += 1;
      cache = new Map();
    }

    return { resolve, invalidate, dispose };
  }

  function toSettings(props) {
    if (!props) return null;
    const settings = {};
    // Monaco's tabSize is the display width of a tab when indenting with tabs, the indent width otherwise.
    const [first, second] = props.indent_style === 'tab' ? ['tab_width', 'indent_size'] : ['indent_size', 'tab_width'];
    const tabSize = props[first] !== undefined ? props[first] : props[second];
    if (props.indent_style !== undefined || tabSize !== undefined) {
      settings.indent = { source: 'editorconfig' };
      if (props.indent_style !== undefined) settings.indent.insertSpaces = props.indent_style !== 'tab';
      if (tabSize !== undefined) settings.indent.tabSize = tabSize;
    }
    if (props.end_of_line !== undefined) settings.endOfLine = props.end_of_line;
    if (props.trim_trailing_whitespace !== undefined) settings.trimTrailingWhitespace = props.trim_trailing_whitespace;
    if (props.insert_final_newline !== undefined) settings.insertFinalNewline = props.insert_final_newline;
    return Object.keys(settings).length ? settings : null;
  }

  function adaptApi(api) {
    return {
      readText: async (relPath) => {
        try {
          const result = await api.readText({ path: relPath, intent: 'preview', maxBytes: READ_MAX_BYTES });
          return result && result.ok !== false && typeof result.content === 'string' ? result.content : null;
        } catch (_error) {
          return null;
        }
      },
    };
  }

  // The directories whose .editorconfig a watcher batch names; null when unknown (truncated).
  function editorconfigDirs(payload) {
    if (payload && payload.truncated === true) return null;
    const dirs = new Set();
    for (const change of Array.isArray(payload && payload.changes) ? payload.changes : []) {
      for (const p of [change && change.relPath, change && change.oldRelPath]) {
        if (typeof p !== 'string') continue;
        const parts = p.replace(/\\/g, '/').split('/');
        if (parts.pop().toLowerCase() === CONFIG_NAME) dirs.add(normalizeRelPath(parts.join('/')) || '');
      }
    }
    return [...dirs];
  }

  const isUnder = (path, dir) => dir === '' || path === dir || path.startsWith(`${dir}/`);

  function createEditorconfigApplier({ getWorkspaceFsApi = () => null, editorHost = null, getRootKey = null, timers = globalRef } = {}) {
    let epoch = 0;
    let resolver = null;
    let unsubscribe = null;
    let rootKey = null;
    let disposed = false;
    // Tracked paths (with {} when no .editorconfig applies, so a later edit can still reach them).
    const settingsByPath = new Map();
    const eolHandled = new Set();
    // The indent a document had before .editorconfig first set one (E2 restores it).
    const baseIndentByPath = new Map();
    let refreshTimer = null;
    let refreshDirs = new Set();

    function currentResolver() {
      if (disposed) return null;
      if (typeof getRootKey === 'function') {
        const key = getRootKey();
        if (rootKey !== null && key !== rootKey) reset();
        rootKey = key;
      }
      if (resolver) return resolver;
      const api = getWorkspaceFsApi();
      if (!api || typeof api.readText !== 'function') return null;
      const adapted = adaptApi(api);
      resolver = createEditorconfigResolver({ readText: adapted.readText, rootPath: '', onInvalidate: scheduleRefresh });
      const owner = resolver;
      if (typeof api.onChange === 'function') {
        try {
          unsubscribe = api.onChange((payload) => {
            if (resolver !== owner) return;
            const dirs = editorconfigDirs(payload);
            if (dirs === null) owner.invalidate();
            else for (const dir of dirs) owner.invalidate(dir);
          }) || null;
        } catch (_error) { unsubscribe = null; }
      }
      return resolver;
    }

    async function resolveSettings(path) {
      const active = currentResolver();
      if (!active) return { stale: false, settings: null };
      const startedEpoch = epoch;
      const settings = await active.resolve(path).then(toSettings, () => null);
      return { stale: startedEpoch !== epoch, settings };
    }

    function track(path, settings) {
      settingsByPath.delete(path);
      settingsByPath.set(path, settings || {});
      if (settingsByPath.size > MAX_TRACKED_PATHS) {
        const oldest = settingsByPath.keys().next().value;
        settingsByPath.delete(oldest);
        baseIndentByPath.delete(oldest);
      }
    }

    async function prepare(path) {
      const { stale, settings } = await resolveSettings(path);
      if (stale) return null;
      track(path, settings);
      return settings;
    }

    function hasNoLineBreak(path) {
      const model = typeof editorHost.getModel === 'function' ? editorHost.getModel(path) : null;
      if (model && typeof model.getLineCount === 'function') return model.getLineCount() <= 1;
      // Textarea fallback: judge from the buffer, never from a missing model.
      const value = typeof editorHost.getValue === 'function' ? editorHost.getValue(path) : null;
      return typeof value === 'string' && !/[\r\n]/.test(value);
    }

    function setIndent(path, indent) {
      if (typeof editorHost.setIndent === 'function') {
        editorHost.setIndent(path, { ...indent });
        return;
      }
      const options = {};
      if (indent.insertSpaces !== undefined) options.insertSpaces = indent.insertSpaces;
      if (indent.tabSize !== undefined) options.tabSize = indent.tabSize;
      const model = typeof editorHost.getModel === 'function' ? editorHost.getModel(path) : null;
      if (model && typeof model.updateOptions === 'function') model.updateOptions(options);
    }

    // A status-bar pick (source 'file') outranks the file's .editorconfig for the session.
    // The first .editorconfig indent remembers the document's own; when the section later
    // goes away, that indent comes back (E2).
    function applyIndent(path, indent) {
      const info = typeof editorHost.getIndentInfo === 'function' ? editorHost.getIndentInfo(path) : null;
      if (info && info.source === 'file') return;
      if (indent) {
        if (info && info.source !== 'editorconfig' && !baseIndentByPath.has(path)) {
          baseIndentByPath.set(path, { insertSpaces: info.insertSpaces, tabSize: info.tabSize });
        }
        setIndent(path, indent);
        return;
      }
      const base = baseIndentByPath.get(path);
      if (base && info && info.source === 'editorconfig') {
        baseIndentByPath.delete(path);
        setIndent(path, { ...base, source: 'default' });
      }
    }

    function applyInternal(path, { eol }) {
      const settings = settingsByPath.get(path);
      if (!settings || !editorHost) return;
      try {
        applyIndent(path, settings.indent || null);
        if (eol && settings.endOfLine && !eolHandled.has(path)
          && typeof editorHost.getEol === 'function' && typeof editorHost.setEol === 'function') {
          eolHandled.add(path);
          if (editorHost.getEol(path) !== settings.endOfLine && hasNoLineBreak(path)) {
            editorHost.setEol(path, settings.endOfLine);
          }
        }
      } catch (_error) { /* editor options are best-effort */ }
    }

    function apply(path) {
      applyInternal(path, { eol: true });
    }

    // Watcher batches arrive in bursts; one re-apply runs REAPPLY_DEBOUNCE_MS after the last.
    function scheduleRefresh(dir) {
      refreshDirs.add(dir === null ? '' : dir);
      if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
      refreshTimer = timers.setTimeout(() => {
        refreshTimer = null;
        const dirs = [...refreshDirs];
        refreshDirs = new Set();
        refreshUnder(dirs);
      }, REAPPLY_DEBOUNCE_MS);
    }

    function refreshUnder(dirs) {
      const startedEpoch = epoch;
      for (const path of [...settingsByPath.keys()]) {
        if (!dirs.some((dir) => isUnder(path, dir))) continue;
        resolveSettings(path).then(({ stale, settings }) => {
          if (stale || startedEpoch !== epoch || !settingsByPath.has(path)) return;
          settingsByPath.set(path, settings || {});
          applyInternal(path, { eol: false });
        }).catch(() => {});
      }
    }

    function hygieneFor(path) {
      const settings = settingsByPath.get(path);
      if (!settings) return null;
      const out = {};
      if (settings.trimTrailingWhitespace !== undefined) out.trimTrailingWhitespace = settings.trimTrailingWhitespace;
      if (settings.insertFinalNewline !== undefined) out.insertFinalNewline = settings.insertFinalNewline;
      if (settings.endOfLine !== undefined) out.endOfLine = settings.endOfLine;
      return Object.keys(out).length ? out : null;
    }

    function forget(path) {
      settingsByPath.delete(path);
      eolHandled.delete(path);
      baseIndentByPath.delete(path);
    }

    function reset() {
      epoch += 1;
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* already gone */ }
      }
      unsubscribe = null;
      if (resolver) resolver.dispose();
      resolver = null;
      if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
      refreshTimer = null;
      refreshDirs = new Set();
      settingsByPath.clear();
      eolHandled.clear();
      baseIndentByPath.clear();
    }

    function dispose() {
      reset();
      disposed = true;
    }

    return { prepare, apply, hygieneFor, forget, reset, dispose };
  }

  return {
    createEditorconfigResolver,
    createEditorconfigApplier,
    parseEditorconfig,
    normalizeRelPath,
  };
});
