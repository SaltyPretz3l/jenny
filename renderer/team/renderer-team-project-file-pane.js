/* A team project's files beside the conversation (row 175 round 2, items 1-2, owner decision D13; mockup team-files-view).
 *
 * `createPane` draws a project's files in an element, in one of two modes:
 * - 'column' (the Team preview column, renderer-team-preview.js): the tree (renderer-team-project-files.js) under the head
 *   "Files · {project} · {n} entries", or one file under Back to files. Under 720 px the column is a full screen, as the
 *   preview is.
 * - 'panel' (the workspace panel): the tree and the file side by side in the inventory drawer, wider than the column.
 *   "Open in workspace panel" in the column opens it with the pages and the file already read; Esc, the drawer's x and
 *   Close shut it, and the focus goes back to the button that opened it.
 * The file: `projectFileRead` (team.project.files.read). Head: the name, then "{folder} · {type} · {size}" (the folder
 * first, so two files named index.html differ); Rendered / Source for Markdown; Copy text; Close. Body: text as the rail
 * preview's numbered code list (first 2,000 lines, coloured a frame later), Markdown rendered through
 * `markdownUtils.renderMarkdown` with pictures left out (as member messages are), a picture (PNG, JPEG, GIF or WebP that
 * main checked) fitted to the width with its name as alt text. States: loading, not text, too large, gone (the host no
 * longer lists it), failed (Try again); past 256 KiB a note says the text is cut. Every name and text is host text:
 * escaped, `dir="auto"`, never markup; SVG and HTML are source text. A token drops an answer for a file no longer shown. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-files'), require('./renderer-team-project-files'),
      require('../features/renderer-artifact-file-preview-render'));
    return;
  }
  root.rendererTeamProjectFilePane = factory(root.rendererSettingsTeamStrings, root.rendererTeamFiles, root.rendererTeamProjectFiles, root.rendererArtifactFilePreviewRender);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, attachments, explorers, codeRender) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const MARKDOWN_OPTIONS = Object.freeze({ mermaid: 'plain', images: 'omit', inlinePaths: false }); // renderer-team-message-row.js
  const RENDER_MAX_CHARS = 153_600; // as renderer-team-preview.js: larger Markdown opens as source
  const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const PANEL_ID = 'teamFilesPanel';
  const KEPT_FILES = 8; // answers a pane keeps, so Back to files and a second look read nothing again
  const KEPT_MS = 30_000; // a kept answer is read again after this (Jenny may have changed the file)
  const KEPT_CHARS = 8 * 1024 * 1024; // text and base64 picture data kept together
  const GLYPH = {
    back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
    copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3 10.5V3.8C3 3.4 3.4 3 3.8 3h6.7"/></svg>',
    panel: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.5 3v10"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  };

  function inv() { return globalThis.inventory || {}; }
  function markdown() { return (globalThis.window && globalThis.window.markdownUtils) || globalThis.markdownUtils || null; }
  function highlighter() { return (globalThis.window && globalThis.window.rendererCodeHighlight) || globalThis.rendererCodeHighlight || null; }
  function drawers() { return globalThis.inventoryDrawer || (typeof require === 'function' ? require('../inventory/drawer') : null); }
  const isMarkdown = (path) => /\.(?:md|markdown)$/iu.test(path);
  const nameOf = explorers.nameOf;

  function stateHtml(heading, copy, extra = '', status = false) {
    return '<div class="team-preview__state"' + (status ? ' role="status"' : '') + '><b>' + escapeHtml(heading) + '</b>' + escapeHtml(copy) + extra + '</div>';
  }
  function iconBtn(action, label, glyph) {
    return inv().actionButton({ variant: 'ghost', size: 'sm', className: 'btn--icon', ariaLabel: label, title: label, dataset: { 'team-files-action': action }, trustedHtml: glyph });
  }
  function textBtn(action, label, { glyph = '', className = '', variant = 'ghost' } = {}) {
    return inv().actionButton({ variant, size: 'sm', className, title: label, label, dataset: { 'team-files-action': action }, trustedHtml: glyph + escapeHtml(label) });
  }

  function codeHtml(text, name) {
    const all = text.split(/\r\n|\r|\n/u);
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const cut = codeRender.sliceCodeWindow(all, null, codeRender.MAX_FILE_PREVIEW_LINES);
    const code = highlighter();
    const languageId = code && typeof code.getLanguageId === 'function' ? String(code.getLanguageId(name) || '') : '';
    return { html: codeRender.buildCodeListHtml({ lines: cut.lines, startLine: 1, languageId }, { escapeHtml }), linesCut: cut.truncated };
  }

  function refusalOf(answer) {
    const error = (answer && answer.error) || { reason: '' };
    if (error.reason === 'team_not_found' || error.reason === 'team_project_path_invalid') return { state: 'gone' };
    return { state: 'failed', error };
  }

  /** What a read answer shows: text, a picture, too large, not text, gone or failed. */
  const sizeOf = (answer) => (typeof answer.text === 'string' ? answer.text.length : 0)
    + (answer.image && typeof answer.image.data_base64 === 'string' ? answer.image.data_base64.length : 0);

  function stateOf(answer) {
    if (!answer || answer.ok !== true) return refusalOf(answer);
    if (answer.image && PICTURE_TYPES.has(answer.image.mime)) return { state: 'image', answer };
    if (answer.too_large) return { state: 'tooLarge', answer };
    if (answer.binary || typeof answer.text !== 'string') return { state: 'notText', answer };
    return { state: 'text', answer };
  }

  // `el`: the element the pane owns. `call(method, payload)`: the team store's call. `onClose()`: the column or panel asked
  // to close. `mode`: 'column' or 'panel'. `seed`: { explorer: snapshot, kept: [[path, answer]] } from another pane.
  function createPane({ el, teamId, projectId, projectName = '', call, mode = 'column', path = '', seed = null, onClose = () => {} }) {
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const segmentId = 'team-files-view-' + mode;
    // path -> { answer, at, size }; a seed from the other pane carries the same entries.
    const kept = new Map(seed && Array.isArray(seed.kept) ? seed.kept.filter((pair) => Array.isArray(pair) && pair[1] && pair[1].answer) : []);
    const live = { view: 'tree', file: null, token: 0, disposed: false };
    let panelOpen = false;
    const explorer = explorers.createExplorer({ teamId, projectId, projectName, call, seed: seed && seed.explorer,
      onOpen: (p) => { showFile(p); }, onChange: () => { if (live.view === 'tree' || mode === 'panel') drawTreeHead(); }, toastHost: () => el });

    const project = () => projectName || jt('team.projects.unnamed', 'A project');

    // ------------------------------------------------------------ heads

    function treeHeadHtml() {
      const c = explorer.counts();
      const meta = c.status === 'ready' ? jt('team.projectFiles.headMeta', '{project} · {count} entries', { project: project(), count: Number(c.total).toLocaleString() }) : project();
      const acts = mode === 'column' ? iconBtn('workspace', jt('team.projectFiles.workspace', 'Open in workspace panel'), GLYPH.panel)
        + iconBtn('close', jt('team.projectFiles.closeFiles', 'Close files'), GLYPH.close) : '';
      return '<div class="team-preview__title"><span class="team-preview__name">' + escapeHtml(jt('team.projectFiles.title', 'Files')) + '</span>'
        + '<span class="team-preview__meta" dir="auto">' + escapeHtml(meta) + '</span></div><div class="team-preview__acts">' + acts + '</div>';
    }

    function fileMeta(f) {
      const folder = explorers.parentOf(f.path) || project();
      if (f.state === 'gone' || !f.answer) return folder;
      const mime = f.answer.image ? f.answer.image.mime : '';
      return [folder, attachments.typeWord(mime, nameOf(f.path)), attachments.sizeText(f.answer.size)].join(' · ');
    }

    function fileHeadHtml() {
      const f = live.file;
      if (!f) return '<div class="team-preview__title"><span class="team-preview__name">' + escapeHtml(jt('team.projectFiles.preview', 'Preview')) + '</span></div>'
        + '<div class="team-preview__acts">' + (mode === 'panel' ? iconBtn('close', jt('team.projectFiles.closePanel', 'Close (Esc)'), GLYPH.close) : '') + '</div>';
      const back = mode === 'column' ? textBtn('back', jt('team.projectFiles.back', 'Back to files'), { glyph: GLYPH.back, className: 'team-preview__back' }) : '';
      const view = f.state === 'text' && isMarkdown(f.path) && inv().segmentedControl ? inv().segmentedControl({ id: segmentId, className: 'inv-segmented--compact', value: f.view,
        ariaLabel: jt('team.preview.viewLabel', 'View'),
        options: [{ value: 'rendered', label: jt('team.preview.rendered', 'Rendered') }, { value: 'source', label: jt('team.preview.source', 'Source') }] }) : '';
      const copy = f.state === 'text' ? iconBtn('copy', jt('team.preview.copy', 'Copy text'), GLYPH.copy) : '';
      const workspace = mode === 'column' ? iconBtn('workspace', jt('team.projectFiles.workspace', 'Open in workspace panel'), GLYPH.panel) : '';
      const close = iconBtn('close', mode === 'column' ? jt('team.preview.closeLabel', 'Close preview') : jt('team.projectFiles.closePanel', 'Close (Esc)'), GLYPH.close);
      return '<div class="team-preview__title">' + back + '<span class="team-preview__name" dir="auto">' + escapeHtml(nameOf(f.path)) + '</span>'
        + '<span class="team-preview__meta" dir="auto">' + escapeHtml(fileMeta(f)) + '</span></div><div class="team-preview__acts">' + view + copy + workspace + close + '</div>';
    }

    // ------------------------------------------------------------ bodies

    function cutNote(f, linesCut) {
      const size = attachments.sizeText(f.answer.size);
      if (f.answer.truncated) return jt('team.projectFiles.truncated', 'Showing the first 256 KB of {size}. Download a copy of the project for the whole file.', { size });
      return linesCut ? jt('team.projectFiles.truncatedLines', 'Showing the first 2,000 lines of {size}. Download a copy of the project for the whole file.', { size }) : '';
    }
    const rendered = (f) => isMarkdown(f.path) && f.view === 'rendered' && f.answer.text.length <= RENDER_MAX_CHARS && Boolean(markdown()) && typeof markdown().renderMarkdown === 'function';

    function textHtml(f) {
      const note = (text) => (text ? '<p class="team-preview__note">' + escapeHtml(text) + '</p>' : '');
      if (rendered(f)) return note(cutNote(f, false)) + '<div class="team-preview__md chat-bubble-markdown" dir="auto">' + String(markdown().renderMarkdown(f.answer.text, MARKDOWN_OPTIONS) || '') + '</div>';
      const code = codeHtml(f.answer.text, nameOf(f.path));
      const big = isMarkdown(f.path) && f.view === 'rendered' && f.answer.text.length > RENDER_MAX_CHARS
        ? jt('team.preview.tooBigToRender', 'This file is too long to show rendered, so it shows as source.') : '';
      return note([big, cutNote(f, code.linesCut)].filter(Boolean).join(' ')) + code.html;
    }

    function fileBodyHtml() {
      const f = live.file;
      if (!f) return stateHtml(jt('team.projectFiles.pick', 'Pick a file to preview it.'), '');
      switch (f.state) {
        case 'loading': return stateHtml(jt('team.preview.loading', 'Loading {name}…', { name: nameOf(f.path) }), '', '', true);
        case 'gone': return stateHtml(jt('team.projectFiles.gone', 'This file is not in the project.'), jt('team.projectFiles.goneMore', 'Jenny may have moved or deleted it since.'));
        case 'notText': return stateHtml(jt('team.projectFiles.notText', 'Jenny shows text, code and pictures here.'),
          jt('team.projectFiles.notTextMore', 'This one is not text, so it is not shown. Download a copy of the project from its page to open it in another app.'));
        case 'tooLarge': return stateHtml(jt('team.projectFiles.tooLarge', 'This picture is too large to show here.'),
          jt('team.projectFiles.tooLargeMore', 'Pictures up to 4 MB and 8,192 pixels a side show here. Download a copy of the project from its page to open it in another app.'));
        case 'failed': return stateHtml(words.errorText(f.error), '', '<br>' + textBtn('retry', jt('team.chat.tryAgain', 'Try again'), { variant: 'secondary' }));
        case 'image': return '<figure class="team-fimg"><img class="team-fimg__img" alt="' + escapeHtml(nameOf(f.path)) + '"></figure>';
        default: return textHtml(f);
      }
    }

    // ------------------------------------------------------------ drawing

    const part = (name) => el.querySelector('[data-team-files-part="' + name + '"]');

    // Column: the tree or the file. Panel: both, side by side.
    function build() {
      if (mode === 'panel') {
        el.innerHTML = '<div class="team-fpanel__tree" data-team-files-part="tree"></div><section class="team-fpanel__view" aria-label="'
          + escapeHtml(jt('team.projectFiles.preview', 'Preview')) + '"><div class="team-preview__head" data-team-files-part="head"></div>'
          + '<div class="team-preview__body" tabindex="0" data-team-files-part="body"></div></section>';
        explorer.mount(part('tree'));
        drawFile();
        return;
      }
      const tree = live.view === 'tree';
      const HEAD = '<div class="team-preview__head" data-team-files-part="head"></div>';
      el.innerHTML = HEAD + (tree ? '<div class="team-preview__body team-preview__body--tree" tabindex="-1" data-team-files-part="tree"></div>'
        : '<div class="team-preview__body" tabindex="0" data-team-files-part="body"></div>');
      if (tree) { explorer.unmount(); drawTreeHead(); explorer.mount(part('tree')); } else { explorer.unmount(); drawFile(); }
    }

    function drawTreeHead() {
      if (mode !== 'column' || live.view !== 'tree' || !part('head')) return;
      const head = part('head');
      const key = focusKey(head);
      head.innerHTML = treeHeadHtml();
      refocus(head, key);
    }

    const focusKey = (scope) => { const a = doc.activeElement; return a && scope.contains(a) && a.dataset ? a.dataset.teamFilesAction || 'segment' : ''; };
    function refocus(scope, key) {
      if (!key) return;
      // The Rendered / Source control is redrawn with the head: its chosen option takes the focus (not Close).
      const segment = key === 'segment' ? scope.querySelector('[data-inv-segmented="' + segmentId + '"] [role="radio"][aria-checked="true"]') : null;
      const next = segment || scope.querySelector('[data-team-files-action="' + key + '"]') || scope.querySelector('[data-team-files-action="close"]');
      if (next) next.focus({ preventScroll: true });
    }

    function drawFile() {
      const head = part('head');
      const body = part('body');
      if (!head || !body) return;
      const key = focusKey(head);
      const hadBody = body.contains(doc.activeElement);
      head.innerHTML = fileHeadHtml();
      body.innerHTML = fileBodyHtml();
      body.scrollTop = 0;
      refocus(head, key);
      if (hadBody && !body.contains(doc.activeElement)) body.focus({ preventScroll: true });
      paintExtras(body);
    }

    // A picture's bytes go in by property after the markup (never through innerHTML); code is coloured a frame later.
    function paintExtras(body) {
      const f = live.file;
      if (!f) return;
      if (f.state === 'image') {
        const img = body.querySelector('.team-fimg__img');
        if (img) img.src = 'data:' + f.answer.image.mime + ';base64,' + f.answer.image.data_base64;
        return;
      }
      if (f.state !== 'text' || rendered(f)) return;
      const mine = live.token;
      const later = win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(fn, 16);
      later(() => {
        if (live.disposed || mine !== live.token || live.file !== f || !el.contains(body)) return;
        const code = highlighter();
        if (code && typeof code.decorateCodeBlocks === 'function') code.decorateCodeBlocks(body);
      });
    }

    // ------------------------------------------------------------ the file

    // Row 175 review: only an answer that shows the file is kept (never gone or failed), for KEPT_MS, and the kept
    // answers stay within KEPT_CHARS of text and picture data together (a picture alone can be about 5.6 M).
    function keep(p, answer) {
      kept.delete(p);
      if (!answer || answer.ok !== true) return;
      kept.set(p, { answer, at: Date.now(), size: sizeOf(answer) });
      let total = 0;
      for (const entry of kept.values()) total += entry.size;
      while (kept.size > KEPT_FILES || (kept.size > 1 && total > KEPT_CHARS)) {
        const [oldest, entry] = kept.entries().next().value;
        total -= entry.size;
        kept.delete(oldest);
      }
    }

    function keptAnswer(p) {
      const entry = kept.get(p);
      if (!entry) return null;
      if (Date.now() - entry.at > KEPT_MS) { kept.delete(p); return null; }
      return entry.answer;
    }

    async function load(f) {
      const mine = ++live.token;
      const held = keptAnswer(f.path);
      if (held) { Object.assign(f, stateOf(held)); drawFile(); return; }
      f.state = 'loading';
      drawFile();
      let answer;
      try { answer = await call('projectFileRead', { team_id: teamId, project_id: projectId, path: f.path }); } catch (_error) { answer = null; }
      if (live.disposed || mine !== live.token || live.file !== f) return;
      Object.assign(f, stateOf(answer));
      if (f.state !== 'failed') keep(f.path, answer);
      drawFile();
    }

    function showFile(p) {
      if (live.disposed || !explorers.isPath(p)) return;
      live.file = { path: p, state: 'loading', view: 'rendered', answer: null, error: null };
      explorer.select(p);
      if (mode === 'column' && live.view !== 'file') { live.view = 'file'; build(); }
      void load(live.file);
      const back = part('head') && part('head').querySelector(mode === 'column' ? '[data-team-files-action="back"]' : '[data-team-files-action="close"]');
      if (mode === 'column' && back) back.focus({ preventScroll: true });
    }

    function backToFiles() {
      live.view = 'tree';
      live.token += 1;
      build();
      explorer.focusSelected();
    }

    // ------------------------------------------------------------ actions

    function openPanel(opener) {
      panelOpen = openWorkspace({ doc, teamId, projectId, projectName, call, opener, owner: api,
        seed: { explorer: explorer.snapshot(), kept: [...kept] }, path: live.file ? live.file.path : '' });
    }

    function copyFile() {
      if (live.file && live.file.state === 'text') void explorers.copyText(el, live.file.answer.text, jt('team.preview.copied', 'Copied'));
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-team-files-action]') : null;
      if (!target || target.disabled || !el.contains(target)) return;
      switch (target.dataset.teamFilesAction) {
        case 'close': onClose(); return;
        case 'back': backToFiles(); return;
        case 'workspace': openPanel(target); return;
        case 'copy': copyFile(); return;
        case 'retry': if (live.file) void load(live.file); return;
        default:
      }
    }
    function onView(event) {
      if (!live.file || !event.detail || event.detail.id !== segmentId) return;
      live.file.view = event.detail.value === 'source' ? 'source' : 'rendered';
      drawFile();
    }
    el.addEventListener('click', onClick);
    el.addEventListener('inv-segmented-change', onView);

    const api = {
      /** Shows `p` (a relative path), or the tree when `p` is empty. */
      show(p) { if (p) showFile(p); else if (mode === 'column' && live.view !== 'tree') backToFiles(); },
      isPanelOpen: () => panelOpen && current !== null && current.owner === api,
      dispose() {
        if (live.disposed) return;
        live.disposed = true;
        live.token += 1;
        explorer.dispose();
        el.removeEventListener('click', onClick);
        el.removeEventListener('inv-segmented-change', onView);
        if (current && current.owner === api) closeWorkspace();
        el.innerHTML = '';
      },
    };
    build();
    if (path) showFile(path);
    return api;
  }

  // ------------------------------------------------------------ the workspace panel

  const drawerOf = new WeakMap(); // document -> the inventory drawer the panel opens in (one per document)
  let current = null; // { owner, pane, drawer }

  function closeWorkspace() {
    if (current) current.drawer.close();
  }

  /** Opens the workspace panel on a project's files (closing one already open); false when the drawer is not there. */
  // The document's one drawer for the panel (made on first use), or null when the inventory drawer is not loaded.
  function drawerFor(doc) {
    const module = drawers();
    if (!doc || !module || typeof module.createDrawer !== 'function') return null;
    if (!drawerOf.has(doc)) {
      drawerOf.set(doc, module.createDrawer({ documentRef: doc, id: PANEL_ID, onClose: () => {
        const was = current;
        current = null;
        if (was && was.pane) was.pane.dispose();
      } }));
    }
    return drawerOf.get(doc);
  }

  // The drawer opened on the panel's frame: its `.team-fpanel` element, or null (the drawer closed again).
  function openedPanel(drawer, doc, projectName, opener) {
    const title = jt('team.projectFiles.panelTitle', 'Files in {project}', { project: projectName || jt('team.projects.unnamed', 'A project') });
    if (!drawer.open({ title, bodyHtml: '<div class="team-fpanel" data-team-files-panel="true"></div>', restoreFocusTo: opener || doc.activeElement })) return null;
    const host = doc.getElementById(PANEL_ID);
    const el = host ? host.querySelector('.team-fpanel') : null;
    if (!el) drawer.close();
    return el;
  }

  function openWorkspace(options) {
    const { doc, path, owner } = options;
    const drawer = drawerFor(doc);
    const el = drawer ? openedPanel(drawer, doc, options.projectName, options.opener) : null;
    if (!el) return false;
    const mine = { owner: owner || null, drawer, pane: null };
    current = mine;
    mine.pane = createPane({ el, teamId: options.teamId, projectId: options.projectId, projectName: options.projectName || '', call: options.call, mode: 'panel',
      path: path || '', seed: options.seed || null, onClose: () => { if (current === mine) drawer.close(); } });
    const start = path ? el.querySelector('[data-team-files-part="body"]') : el.querySelector('.team-ftree__row[tabindex="0"]');
    if (start) start.focus({ preventScroll: true });
    return true;
  }

  return { createPane, openWorkspace, closeWorkspace, stateOf, PANEL_ID };
});
