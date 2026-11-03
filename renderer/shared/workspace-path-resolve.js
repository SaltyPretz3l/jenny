/* renderer/shared/workspace-path-resolve.js - the one rule that maps a path a model (or a
 * tool) printed to the workspace: row 95 phase 3 (docs/plans/DATA_HYGIENE_2026-11-01.md).
 * Two parts in one eagerly loaded file (index.html's script budget is pinned, so the chat
 * path controller's DOM helpers live beside the rule they serve):
 *   1. The path rule: pure and best effort. The main process (WorkspaceIdeService._resolveInsideRoot,
 *      realpath containment) stays the authority for what actually opens. Nothing reads the disk.
 *   2. DOM helpers for renderer-chat-path-open.js: paneOf, createPaneScope, ensureMoreButton,
 *      isEditableTarget, hasTextSelection, createPathChip (no state, no rule of their own).
 *
 * resolveWorkspacePath(raw, { workspaceRoot, platform? }) ->
 *   { kind: 'relative', relPath, line, column, isDir }  inside the root ('' = the root itself)
 *   { kind: 'outside', display, line, column, isDir }   absolute, outside the root (copy only)
 *   null                                                junk, UNC / device paths, NTFS streams, escapes
 * - accepts Windows drive paths (either slash direction, drive and segments compared
 *   case-insensitively), POSIX absolute paths, `file:///` URLs (percent escapes decoded),
 *   relative paths, and a trailing `:line[:col]` or `(line[,col])`;
 * - relativeInRoot(path, rootPath, cwdRel?) is the bare containment rule (no suffix parsing):
 *   file-link-detect.js uses it for terminal and run output links.
 * parseAbsolutePathText / linkableAbsoluteSpans feed the inline-code chips and the prose pass;
 * setContextProvider / getContext let the chat path controller tell them the flag, the root and the
 * registered project folders (a file in another project opens as a read-only preview);
 * onContextChange(fn) tells the prose pass when that context first becomes usable. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyWorkspacePathResolve = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PATH_MAX = 1024;
  const LINE_MAX = 100000000;
  const DRIVE_RE = /^[A-Za-z]:\//;
  const INVALID_NAME_RE = /[<>"|?*]/;
  const SUFFIX_RE = /(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))$/;
  const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;
  const SUFFIX_TAIL_RE = /:\d+(?::\d+)?$/;

  const CHIP_WIN_RE = /^[A-Za-z]:[\\/](?:[^\\/:*?"<>|]+[\\/])*[^\\/:*?"<>|]*$/;
  const CHIP_POSIX_RE = /^\/(?:[\w.@+~-]+\/)+[\w.@+~-]*$/;
  const PROSE_WIN = '[A-Za-z]:[\\\\/][^\\s"\'<>|*?:;,()\\[\\]{}`]+';
  const PROSE_POSIX = '\\/(?:[\\w.@+~-]+\\/)+[\\w.@+~-]+\\/?';
  const PROSE_LINE = '(?::(\\d+)(?::(\\d+))?)?';
  const PROSE_RE_SOURCE = '(?<![\\w/\\\\:.@~+-])(?:' + PROSE_WIN + '|' + PROSE_POSIX + ')' + PROSE_LINE;

  function hasControl(text) {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
  }

  function toInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= LINE_MAX ? n : null;
  }

  // Folds '.' and '..' segments; null when '..' climbs above the start (or nothing is left).
  function foldSegments(rel) {
    const out = [];
    for (const segment of String(rel).split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (out.length === 0) return null;
        out.pop();
        continue;
      }
      out.push(segment);
    }
    return out.length ? out.join('/') : null;
  }

  function normalizeRoot(rootPath) {
    return String(rootPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  }

  function isAbsolutePath(slashed) {
    return DRIVE_RE.test(slashed) || slashed.charAt(0) === '/';
  }

  // The containment test on a slash-normalized absolute path: the root-relative remainder
  // ('' for the root itself), or null when the path is not under the root.
  function underRoot(slashed, root, platform) {
    if (!root) return null;
    const winRoot = DRIVE_RE.test(root + '/');
    if (DRIVE_RE.test(slashed) !== winRoot && (winRoot || root.charAt(0) === '/')) return null;
    const insensitive = winRoot || platform === 'win32';
    const norm = (value) => (insensitive ? value.toLowerCase() : value);
    if (norm(slashed) === norm(root)) return '';
    const prefix = root + '/';
    return norm(slashed.slice(0, prefix.length)) === norm(prefix) ? slashed.slice(prefix.length) : null;
  }

  // A detected path -> its root-relative form ('/' separators), or null when it is outside
  // the root. cwdRel: the root-relative folder a relative path is printed from ('' = root).
  function relativeInRoot(rawPath, rootPath, cwdRel) {
    const p = String(rawPath || '').replace(/\\/g, '/');
    if (!p || p.length > PATH_MAX) return null;
    if (!isAbsolutePath(p)) return foldSegments(cwdRel ? cwdRel + '/' + p : p);
    const rest = underRoot(p, normalizeRoot(rootPath), '');
    return rest === null ? null : foldSegments(rest);
  }

  // `file:///G:/a%20b.js` -> `G:/a b.js`; null for a remote host, a bad escape or another scheme.
  function stripFileUrl(text) {
    if (!SCHEME_RE.test(text)) return text;
    if (!/^file:\/\//i.test(text)) return null;
    let rest = text.slice(7);
    if (rest.charAt(0) !== '/') {
      const slash = rest.indexOf('/');
      if (slash < 0 || rest.slice(0, slash).toLowerCase() !== 'localhost') return null;
      rest = rest.slice(slash);
    }
    try {
      rest = decodeURIComponent(rest);
    } catch (_error) {
      return null;
    }
    return /^\/[A-Za-z]:\//.test(rest) ? rest.slice(1) : rest;
  }

  function resolveWorkspacePath(raw, options) {
    try {
      let text = String(raw == null ? '' : raw).trim();
      if (!text || text.length > PATH_MAX) return null;
      text = stripFileUrl(text);
      if (!text || hasControl(text) || text.length > PATH_MAX) return null;
      if (/^[\\/]{2}/.test(text)) return null; // UNC, \\?\ and \\.\ device paths
      let line = null;
      let column = null;
      const suffix = SUFFIX_RE.exec(text);
      if (suffix) {
        line = toInt(suffix[1] || suffix[3]);
        column = toInt(suffix[2] || suffix[4]);
        text = text.slice(0, suffix.index);
      }
      const body = text.replace(/\\/g, '/');
      const absolute = isAbsolutePath(body);
      const head = DRIVE_RE.test(body) ? 2 : 0;
      // A ':' past the drive letter is an NTFS stream (`a.js:evil`) or junk.
      if (!body || body.indexOf(':', head) >= 0 || INVALID_NAME_RE.test(body)) return null;
      const isDir = /[^/]\/$/.test(body);
      const base = { line, column, isDir };
      if (!absolute) {
        const rel = foldSegments(body);
        return rel ? Object.assign({ kind: 'relative', relPath: rel }, base) : null;
      }
      const rootPath = normalizeRoot(options && options.workspaceRoot);
      const rest = underRoot(body, rootPath, options && options.platform);
      if (rest === null) {
        const display = DRIVE_RE.test(body) ? body.replace(/\//g, '\\') : body;
        return Object.assign({ kind: 'outside', display }, base);
      }
      const rel = foldSegments(rest);
      if (rest && !rel) return null; // `..` climbs out of the root
      return Object.assign({ kind: 'relative', relPath: rel || '' }, base);
    } catch (_error) {
      return null;
    }
  }

  // A whole inline-code text that is an absolute path: { path ('/' separators), line, column,
  // isDir } or null. POSIX needs two segments so slash commands (`/clear`) and URL routes
  // with one segment never read as paths.
  function parseAbsolutePathText(rawText) {
    const text = String(rawText || '').trim();
    if (!text || text.length > 512 || hasControl(text)) return null;
    if (/^file:\/\//i.test(text)) {
      const url = resolveWorkspacePath(text, {});
      return url && url.kind === 'outside'
        ? { path: url.display.replace(/\\/g, '/'), line: url.line, column: url.column, isDir: url.isDir }
        : null;
    }
    const suffix = /:(\d+)(?::(\d+))?$/.exec(text);
    const body = suffix ? text.slice(0, suffix.index) : text;
    const slashed = body.replace(/\\/g, '/');
    const posix = !DRIVE_RE.test(slashed);
    if (posix ? !CHIP_POSIX_RE.test(slashed) || slashed.split('/').filter(Boolean).length < 2 : !CHIP_WIN_RE.test(body)) return null;
    if (slashed.split('/').some((segment) => segment === '..') || !/[^/]/.test(slashed.slice(posix ? 0 : 3))) return null;
    return {
      path: slashed,
      line: suffix ? toInt(suffix[1]) : null,
      column: suffix ? toInt(suffix[2]) : null,
      isDir: /[^/]\/$/.test(slashed),
    };
  }

  // Project links: an absolute path outside the workspace root but inside a registered project's
  // folder. roots: [{ id, rootPath }]; the longest matching root wins. A file only (a folder or the
  // project root itself has nothing to preview), as { projectId, path (POSIX relative), line,
  // column } or null.
  function resolveProjectPath(raw, roots) {
    let best = null;
    let bestLength = -1;
    // A case-folded, slash-normalized prefix test skips the full resolve for every non-matching root.
    const probe = String(raw || '').replace(/\\/g, '/').toLowerCase();
    const isUrl = /^file:/.test(probe);
    for (const entry of Array.isArray(roots) ? roots : []) {
      const rootPath = entry && typeof entry.id === 'string' && entry.id ? normalizeRoot(entry.rootPath) : '';
      if (!rootPath || rootPath.length <= bestLength) continue;
      if (!isUrl && !probe.startsWith(rootPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/')) continue;
      const hit = resolveWorkspacePath(raw, { workspaceRoot: rootPath });
      if (hit && hit.kind === 'relative' && hit.relPath && !hit.isDir) {
        best = { projectId: entry.id, path: hit.relPath, line: hit.line, column: hit.column };
        bestLength = rootPath.length;
      }
    }
    return best;
  }

  // Prose: absolute paths in a text node that sit inside the workspace root, as
  // [{ index, length, relPath, line, column, isDir }]. Anything outside the root, with
  // an escape or a stream name is left as plain text. projectRoots also chips a file inside a
  // registered project (no workspace root needed): its relPath is then the path's own absolute
  // text, which the click classifies again (classifyChipTarget).
  function linkableAbsoluteSpans(text, workspaceRoot, projectRoots) {
    const value = String(text == null ? '' : text);
    const rootPath = normalizeRoot(workspaceRoot);
    const roots = Array.isArray(projectRoots) ? projectRoots : [];
    if ((!rootPath && !roots.length) || value.length > 64 * 1024) return [];
    const re = new RegExp(PROSE_RE_SOURCE, 'g');
    const spans = [];
    let m;
    while ((m = re.exec(value)) && spans.length < 200) {
      let length = m[0].length;
      let candidate = m[0];
      if (!m[1]) {
        const trimmed = candidate.replace(/[.!]+$/, '');
        length -= candidate.length - trimmed.length;
        candidate = trimmed;
      }
      const hit = resolveWorkspacePath(candidate, { workspaceRoot: rootPath });
      if (hit && hit.kind === 'relative' && hit.relPath) {
        spans.push({ index: m.index, length, relPath: hit.relPath, line: hit.line, column: hit.column, isDir: hit.isDir });
      } else if (hit && hit.kind === 'outside' && roots.length && resolveProjectPath(candidate, roots)) {
        spans.push({ index: m.index, length, relPath: candidate.replace(SUFFIX_TAIL_RE, ''), line: hit.line, column: hit.column, isDir: false });
      }
    }
    return spans;
  }

  // What a chip / inline path / menu target means, for the chat path controller:
  // { mode: 'open' | 'dir', path, line, column } (workspace-relative), { mode: 'project', projectId,
  // path, line, column, display } for a file in a registered project that is not the workspace (a
  // read-only preview), { mode: 'copy', display } for any other absolute path (Copy only: never an
  // open or a reveal), or null when it is not ours.
  // ctx: { enabled, workspaceRoot, projectRoots, isOpenable, normalize }.
  // With ctx.enabled false only the legacy relative shape is accepted and a "dir" hint is ignored.
  function classifyChipTarget(raw, line, column, kind, ctx) {
    const text = ctx.normalize(raw);
    if (ctx.isOpenable(text) && !(ctx.enabled && SCHEME_RE.test(text))) {
      const dir = ctx.enabled && (kind === 'dir' || /[^/]\/$/.test(text));
      return { mode: dir ? 'dir' : 'open', path: dir ? text.replace(/\/+$/, '') : text, line, column };
    }
    const hit = ctx.enabled ? resolveWorkspacePath(raw, { workspaceRoot: ctx.workspaceRoot }) : null;
    if (!hit) return null;
    if (hit.kind === 'outside') {
      const project = kind === 'dir' ? null : resolveProjectPath(raw, ctx.projectRoots);
      return project && ctx.isOpenable(project.path)
        ? Object.assign(project, { mode: 'project', line: line || project.line, column: column || project.column, display: hit.display })
        : { mode: 'copy', display: hit.display };
    }
    if (!hit.relPath || !ctx.isOpenable(hit.relPath)) return null;
    return { mode: kind === 'dir' || hit.isDir ? 'dir' : 'open', path: hit.relPath, line: line || hit.line, column: column || hit.column };
  }

  // Cite spans and absolute-path spans from one text node, in order, first one wins an overlap.
  function mergeSpans(cites, spans) {
    let end = 0;
    return cites.concat(spans).sort((a, b) => a.index - b.index).filter((span) => {
      const keep = span.index >= end;
      end = keep ? span.index + span.length : end;
      return keep;
    });
  }

  // A prose path as a chip the chat path controller drives (click, Enter, context menu).
  function createPathChip(doc, text, span) {
    const chip = doc.createElement('span');
    chip.className = 'chat-inline-path';
    chip.setAttribute('role', 'link');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('data-chat-path-open', span.relPath);
    chip.setAttribute('data-chat-path', span.relPath);
    if (span.line) chip.setAttribute('data-chat-path-line', String(span.line));
    if (span.column) chip.setAttribute('data-chat-path-column', String(span.column));
    if (span.isDir) chip.setAttribute('data-chat-path-kind', 'dir');
    chip.textContent = text;
    return chip;
  }

  // ---- Chat path helpers (renderer-chat-path-open.js): the relative-path shape rule, the
  // split-view pane scope and the hover "more" button, kept here so the controller stays small.

  function normalizeRelPath(value) {
    return String(value || '').trim().replace(/\\/g, '/');
  }

  // Parity clone of renderer-chat-codebase-cite-utils.js::isSafeRelPath (that module keeps it
  // private). Keep the two in lockstep: same alphabet, same absolute/drive/parent-escape rejections.
  function isOpenableRelPath(value) {
    const p = String(value || '');
    if (!p || p.length > 512) return false;
    for (let i = 0; i < p.length; i += 1) {
      const code = p.charCodeAt(i);
      if (code <= 0x20 || code === 0x7f) return false;
    }
    if (p.charAt(0) === '/' || /^[a-zA-Z]:/.test(p)) return false;
    return !p.split('/').includes('..');
  }

  function clampLine(value, max) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 1 ? Math.min(n, max > 0 ? max : n) : null;
  }

  // Workspace-relative path shape for inline code spans: word-ish segments, at least one
  // separator, optional trailing :line[:column]. Backslashes are normalized to slashes first;
  // absolute/drive paths fail the segment alphabet (':') and isOpenableRelPath, staying inert.
  const INLINE_CODE_PATH_RE = /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)+(?::(\d+)(?::(\d+))?)?$/;
  function parseInlineCodeRelPath(rawText) {
    const text = normalizeRelPath(rawText);
    const match = INLINE_CODE_PATH_RE.exec(text);
    const path = match ? text.replace(/:\d+(?::\d+)?$/, '') : '';
    if (!match || !isOpenableRelPath(path)) return null;
    return { path, line: match[1] ? clampLine(match[1]) : null, column: match[2] ? clampLine(match[2]) : null };
  }

  // Project links (chat path controller): a file in another registered project. A click opens the
  // read-only preview; only an explicit Open in IDE switches the Workspace to that project (never a
  // plain click). A decline or a throw is deps.fail(display, error). deps:
  // preview(target), ide(target) (either may be null), canPreview(), fail(display, error).
  // claim(detail) is the preview panel's own Open in IDE re-entering the open-file event with a
  // projectId: true when it was taken.
  function createProjectLinks(deps) {
    function open(link, useIde) {
      const target = { projectId: link.projectId, path: link.path, line: link.line || null, column: link.column || null };
      if (!useIde && link.display) target.display = link.display; // the panel's Ask Jenny / Copy path name the full path
      const run = useIde ? deps.ide : (deps.canPreview() ? deps.preview : null);
      return Promise.resolve().then(() => (run ? run(target) : false)).then((opened) => {
        if (opened !== true) deps.fail(link.display, null);
        return opened === true;
      }, (error) => { deps.fail(link.display, error); return false; });
    }
    function claim(detail) {
      const path = normalizeRelPath(detail.path);
      if (typeof detail.projectId !== 'string' || !detail.projectId || !deps.ide || !isOpenableRelPath(path)) return false;
      open({ projectId: detail.projectId, path, line: clampLine(detail.line), column: clampLine(detail.column), display: path }, true);
      return true;
    }
    // The path menu for a project target: Open Preview (when the rail can take it), Open in IDE (when
    // wired), then the caller's Copy Path item.
    function menuItems(link, jt, copyItem) {
      const items = [];
      if (deps.preview && deps.canPreview()) items.push({ label: jt('chat.pathOpen.openPreview', 'Open Preview'), action: () => open(link, false) });
      if (deps.ide) items.push({ label: jt('chat.pathOpen.openInIde', 'Open in IDE'), action: () => open(link, true) });
      return items.concat([copyItem]);
    }
    return { open, claim, menuItems };
  }

  // The shell's side of project links (renderer-app-controller-composition.js builds it once):
  // getProjectRoots() is the cheap cached list of registered project folders [{ id, rootPath }]
  // (General and missing folders excluded; the project switcher loads lazily, so the first call
  // warms it and getContext() re-announces when the folders arrive), and openProjectFileInIde(
  // { projectId, path, line, column }) switches the Workspace to that project, then opens the file
  // in the IDE: true only when both happened. deps: getProjectSwitcher, openIdeFileAtLine, setActiveView.
  function createProjectLinkHooks(deps) {
    let roots = [];
    let warmed = false;
    function warm() {
      warmed = true;
      Promise.resolve().then(() => deps.getProjectSwitcher()).then((switcher) => {
        if (!switcher || typeof switcher.getProjects !== 'function') return null;
        const sync = () => {
          roots = switcher.getProjects()
            .filter((project) => project && project.id && project.rootPath && !project.folderMissing)
            .map((project) => ({ id: project.id, rootPath: project.rootPath }));
          getContext();
        };
        if (typeof switcher.onProjectsChanged === 'function') switcher.onProjectsChanged(sync);
        sync();
        return typeof switcher.refresh === 'function' ? switcher.refresh().then(sync) : null;
      }).catch(() => { /* no switcher (hosted): no project links */ });
    }
    async function openProjectFileInIde(target) {
      const switcher = await deps.getProjectSwitcher();
      if (!switcher || typeof switcher.openProjectAsWorkspace !== 'function') return false;
      const outcome = await switcher.openProjectAsWorkspace(target.projectId);
      if (!outcome || (outcome.committed !== true && outcome.noop !== true)) return false;
      deps.setActiveView('ide');
      return (await deps.openIdeFileAtLine(target.path, target.line, target.column)) === true;
    }
    return { getProjectRoots() { if (!warmed) warm(); return roots; }, openProjectFileInIde };
  }

  // Context menus skip editable fields and live text selections (the native menu stays).
  function isEditableTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return typeof target.closest === 'function' && Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'));
  }

  function hasTextSelection(win) {
    try {
      const selection = win && win.getSelection ? win.getSelection() : null;
      return Boolean(selection && !selection.isCollapsed && String(selection.toString() || '').trim());
    } catch (_error) {
      return false;
    }
  }

  // The split-view pane a chat element sits in (0 outside any pane root): a Workspace chat bound
  // to an editor group opens files there (row 40 W7c).
  function paneOf(node) {
    const pane = node && typeof node.closest === 'function' ? node.closest('.chat-pane[data-pane-id]') : null;
    return pane && pane.getAttribute('data-pane-id') === '1' ? 1 : 0;
  }

  // Split view: a second pane mounts after boot, so its transcript and inspector are found at
  // event time under `paneHost` (the document); pane 0's own roots keep their direct listeners.
  function createPaneScope(scope) {
    const { paneHost, chatTimeline, pathRoots } = scope;
    function otherPaneRoot(node) {
      const pane = paneHost && node && typeof node.closest === 'function' ? node.closest('.chat-pane[data-pane-id]') : null;
      if (!pane || pane.getAttribute('data-pane-id') === '0' || !paneHost.contains(pane)) return null;
      const rootEl = node.closest('[data-chat-node="chatTimeline"], [data-chat-node="subagentInspector"]');
      return rootEl && pane.contains(rootEl) ? rootEl : null;
    }
    return {
      otherPaneRoot,
      insideTimeline(node) {
        const paneRoot = otherPaneRoot(node);
        if (paneRoot) return paneRoot.getAttribute('data-chat-node') === 'chatTimeline';
        return !chatTimeline || typeof chatTimeline.contains !== 'function' || chatTimeline.contains(node);
      },
      insidePathRoot(node) {
        return pathRoots.length === 0 || Boolean(otherPaneRoot(node))
          || pathRoots.some((rootEl) => typeof rootEl.contains !== 'function' || rootEl.contains(node));
      },
      // The pane host's listeners act only for another pane's roots, so a pane 0 event is never handled twice.
      forOtherPane(handler) {
        return (event) => { if (otherPaneRoot(event && event.target)) handler(event); };
      },
    };
  }

  // The hover "more" button (row 95 P1): inserted lazily after a path chip, so the render path
  // and cached HTML never carry it. It opens the chip's own context menu.
  const MORE_CLASS = 'chat-path-more';
  const CHIP_SELECTOR = '.tool-path-chip[data-chat-path-open], .chat-inline-path[data-chat-path-open]';
  function ensureMoreButton(chip, label) {
    const next = chip.nextElementSibling;
    if (next && next.classList.contains(MORE_CLASS)) return next;
    const actionButton = globalThis.inventoryActionButton
      || (typeof require === 'function' ? require('../inventory/action-button') : null);
    if (typeof actionButton !== 'function') return null;
    chip.insertAdjacentHTML('afterend', actionButton({
      plain: true,
      className: MORE_CLASS,
      ariaLabel: label,
      title: label,
      ariaHaspopup: 'menu',
      ariaExpanded: false,
      trustedHtml: '⋯',
    }));
    return chip.nextElementSibling;
  }

  // The chat path controller publishes whether absolute-path links are on and which root (and which
  // registered project folders) they resolve against; the markdown chips and the prose pass read it
  // at use time.
  let contextProvider = null;
  let usableKey = ''; // the roots the listeners were last told about ('' = no usable context)
  let contextGeneration = 0; // bumps with each new usable context: the prose pass stamps bubbles with it
  const contextListeners = new Set();
  function announceContext() {
    Promise.resolve().then(() => contextListeners.forEach((listener) => { try { listener(); } catch (_error) { /* isolated */ } }));
  }
  function setContextProvider(provider) {
    contextProvider = typeof provider === 'function' ? provider : null;
    usableKey = '';
    if (contextProvider) getContext();
  }
  function getContext() {
    let context = { enabled: false, workspaceRoot: '' };
    try {
      const ctx = contextProvider ? contextProvider() : null;
      if (ctx && ctx.enabled === true) {
        const projectRoots = (Array.isArray(ctx.projectRoots) ? ctx.projectRoots : [])
          .filter((entry) => entry && typeof entry.id === 'string' && entry.id && typeof entry.rootPath === 'string' && entry.rootPath)
          .slice(0, 200).map((entry) => ({ id: entry.id, rootPath: entry.rootPath }));
        context = { enabled: true, workspaceRoot: String(ctx.workspaceRoot || '') };
        if (projectRoots.length) context.projectRoots = projectRoots; // absent when there are none
      }
    } catch (_error) { /* provider gone: links stay off */ }
    // Links need the flag and a root or a project folder; the first time (or a new set) both are
    // there, let the prose pass catch up.
    const folders = context.projectRoots || [];
    const key = context.enabled && (context.workspaceRoot || folders.length)
      ? [context.workspaceRoot].concat(folders.map((entry) => entry.rootPath)).join('|') : '';
    if (key !== usableKey) {
      usableKey = key;
      if (key) {
        contextGeneration += 1;
        announceContext();
      }
    }
    return context;
  }
  // The published workspace root whether or not absolute links are on (the rail's job menu checks a job's root against it).
  function getWorkspaceRoot() {
    try {
      const ctx = contextProvider ? contextProvider() : null;
      return ctx ? String(ctx.workspaceRoot || '') : '';
    } catch (_error) {
      return '';
    }
  }
  // fn() runs (async, once per becoming-usable) when the flag and a workspace root are both available; returns the unsubscribe.
  function onContextChange(listener) {
    if (typeof listener !== 'function') return () => {};
    contextListeners.add(listener);
    return () => { contextListeners.delete(listener); };
  }

  return Object.freeze({
    resolveWorkspacePath,
    relativeInRoot,
    parseAbsolutePathText,
    linkableAbsoluteSpans,
    classifyChipTarget,
    resolveProjectPath,
    mergeSpans,
    createPathChip,
    createProjectLinks,
    createProjectLinkHooks,
    getContextGeneration: () => contextGeneration,
    normalizeRelPath,
    isOpenableRelPath,
    clampLine,
    isEditableTarget,
    hasTextSelection,
    parseInlineCodeRelPath,
    paneOf,
    createPaneScope,
    ensureMoreButton,
    MORE_CLASS,
    CHIP_SELECTOR,
    setContextProvider,
    getContext,
    getWorkspaceRoot,
    onContextChange,
  });
});
