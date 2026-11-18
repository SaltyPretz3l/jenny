/* The file preview column (row 167, slice P): one text or code attachment shown read-only beside the shown channel,
 * `aside.team-preview`, in the thread column's grid slot. The Team tab opens it when renderer-team-files.js dispatches
 * `team:file-preview` (a file name or a peek was activated) and closes it; the column is built once per frame and
 * kept (hidden) between files.
 *
 * - Head: Back to thread (only when a thread was open; it covers that thread, `hidden`, never closes it), the name,
 *   "{type} · {size} · shared by {name}, {when}"; a Rendered / Source switch for Markdown; Copy text, Download, Close.
 * - Body: the text from main (`chatAttachmentText`: at most 512,000 bytes, checked UTF-8), as the rail preview's numbered
 *   code list (first 2,000 lines) coloured by rendererCodeHighlight. Markdown Rendered goes through
 *   `markdownUtils.renderMarkdown`, the path member messages use (renderer-team-message-row.js); SVG, HTML and every
 *   other type are source only: no iframe, nothing drawn. Names and text are untrusted: escaped, never raw markup.
 * - States, each words and (where one helps) a button: loading, not text (Download), offline, gone, failed (Try again).
 * - A token drops an answer for a file that is no longer the one shown. Fetched text is cached for the last team shown
 *   only (least recently viewed dropped first past 8,388,608 characters) until `forgetTeam` / `disposeAll`. Markdown
 *   over 150 KB opens as source; colouring runs a frame after the plain rows are drawn, so the column paints first.
 * - Esc nothing inside took (not an IME's) closes it; the focus goes to Close on open and back to the control that
 *   opened it on close. Every listener is removed by `dispose`.
 * - Row 175 round 2 (D13): a `team:file-preview` whose detail is `{ kind: 'project-files', teamId, projectId, path?,
 *   projectName? }` (renderer-team-project-files.js `open`) shows that project's files in the column instead: the tree,
 *   a file with Back to files, and Open in workspace panel (renderer-team-project-file-pane.js owns all of it). Another
 *   ask for the same project shows the path asked for in the same column. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-files'), require('./renderer-team-chat-writes'),
      require('../features/renderer-artifact-file-preview-render'));
    return;
  }
  root.rendererTeamPreview = factory(root.rendererSettingsTeamStrings, root.rendererTeamFiles, root.rendererTeamChatWrites, root.rendererArtifactFilePreviewRender);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, filesModule, chatWrites, codeRender) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const ATT_ID = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;
  const CACHE_CHARS = 8_388_608;
  const COPIED_MS = 1800;
  const MARKDOWN_OPTIONS = Object.freeze({ mermaid: 'plain', images: 'omit', inlinePaths: false }); // renderer-team-message-row.js
  const SEGMENT_ID = 'team-preview-view';
  const RENDER_MAX_CHARS = 153_600; // Markdown larger than this opens as source: rendering it would hold the page
  const GLYPH = {
    back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
    copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3 10.5V3.8C3 3.4 3.4 3 3.8 3h6.7"/></svg>',
    download: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.8 7.4 8 10.6l3.2-3.2M3 13.5h10"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  };

  // ------------------------------------------------------------- the text cache

  const caches = new Map(); // team id -> Map(attachment id -> { text, truncated, total_bytes }), oldest view first

  function recall(teamId, id) {
    const held = caches.get(teamId);
    const entry = held && held.get(id);
    if (!entry) return null;
    held.delete(id);
    held.set(id, entry);
    return entry;
  }

  // One team's texts at a time: another team's go when this one stores.
  function remember(teamId, id, entry) {
    for (const key of [...caches.keys()]) if (key !== teamId) caches.delete(key);
    if (!caches.has(teamId)) caches.set(teamId, new Map());
    const held = caches.get(teamId);
    held.delete(id);
    held.set(id, entry);
    let total = 0;
    for (const e of held.values()) total += e.text.length;
    for (const key of held.keys()) {
      if (total <= CACHE_CHARS || held.size <= 1) break;
      total -= held.get(key).text.length;
      held.delete(key);
    }
  }

  function forgetTeam(teamId) { caches.delete(teamId); }
  function disposeAll() { caches.clear(); }

  // ------------------------------------------------------------------- words

  function inv() { return globalThis.inventory || {}; }
  function panes() { return globalThis.rendererTeamProjectFilePane || (typeof require === 'function' ? require('./renderer-team-project-file-pane') : null); }
  const PROJECT_ID = /^project_[A-Za-z0-9_-]{1,128}$/;
  function markdown() { return (globalThis.window && globalThis.window.markdownUtils) || globalThis.markdownUtils || null; }
  function highlighter() { return (globalThis.window && globalThis.window.rendererCodeHighlight) || globalThis.rendererCodeHighlight || null; }
  const isMarkdown = (a) => /\.(?:md|markdown)$/iu.test(a.name) || String(a.mime).toLowerCase() === 'text/markdown';

  function stateHtml(heading, copy, extra = '', status = false) {
    return '<div class="team-preview__state"' + (status ? ' role="status"' : '') + '><b>' + escapeHtml(heading) + '</b>' + escapeHtml(copy) + extra + '</div>';
  }
  function actionBtn(action, label, glyph = '') {
    return inv().actionButton({ variant: 'ghost', size: 'sm', title: label, dataset: { 'team-preview-action': action }, trustedHtml: glyph + escapeHtml(label), label });
  }
  function iconBtn(action, label, glyph) {
    return inv().actionButton({ variant: 'ghost', size: 'sm', className: 'btn--icon', ariaLabel: label, title: label, dataset: { 'team-preview-action': action }, trustedHtml: glyph });
  }

  // `lines` cut to the first 2,000 and drawn as the rail preview's numbered code list.
  function codeHtml(text, name) {
    const all = text.split(/\r\n|\r|\n/u);
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const cut = codeRender.sliceCodeWindow(all, null, codeRender.MAX_FILE_PREVIEW_LINES);
    const code = highlighter();
    const languageId = code && typeof code.getLanguageId === 'function' ? String(code.getLanguageId(name) || '') : '';
    return { html: codeRender.buildCodeListHtml({ lines: cut.lines, startLine: 1, languageId }, { escapeHtml }), linesCut: cut.truncated };
  }

  // `{ onClose, call, ... }`: see createPreview. `ctx()` is the frame's context (`online`, `author`).
  // `call(method, payload)`: the shared team store's call. `thread()`: the open thread's aside element, or null.
  function createPreview({ shell, teamId, ctx, call, thread = () => null, onClose = null }) {
    const doc = shell.ownerDocument;
    const win = doc.defaultView;
    let el = null;
    let disposed = false;
    let token = 0;
    let shown = null; // { detail, opener, state, view, entry }
    let covered = null; // the thread aside this column hides
    let copiedTimer = 0;
    let copiedEl = null;

    function build() {
      el = doc.createElement('aside');
      el.className = 'team-preview';
      el.dataset.teamRegion = 'preview';
      el.hidden = true;
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', onKeydown);
      el.addEventListener('inv-segmented-change', onView);
      shell.appendChild(el);
    }

    const requestClose = () => { if (onClose) onClose(); else api.close(); };

    // ------------------------------------------------------------- drawing

    function headHtml() {
      const { detail } = shown;
      const a = detail.attachment;
      const name = filesModule.shownName(a.name);
      const when = words.formatTime(Date.parse(detail.createdAt));
      const shared = detail.own ? jt('team.preview.sharedByYou', 'shared by you, {when}', { when })
        : jt('team.preview.sharedBy', 'shared by {name}, {when}', { name: detail.authorName, when });
      const meta = [filesModule.typeWord(a.mime, a.name), filesModule.sizeText(a.size_bytes), shared].join(' · ');
      const back = shown.withBack ? inv().actionButton({ variant: 'ghost', size: 'sm', className: 'team-preview__back', title: jt('team.preview.back', 'Back to thread'), dataset: { 'team-preview-action': 'back' },
        trustedHtml: GLYPH.back + escapeHtml(jt('team.preview.back', 'Back to thread')), label: jt('team.preview.back', 'Back to thread') }) : '';
      const view = isMarkdown(a) && inv().segmentedControl ? inv().segmentedControl({ id: SEGMENT_ID, className: 'inv-segmented--compact', value: shown.view,
        ariaLabel: jt('team.preview.viewLabel', 'View'),
        options: [{ value: 'rendered', label: jt('team.preview.rendered', 'Rendered') }, { value: 'source', label: jt('team.preview.source', 'Source') }] }) : '';
      const copy = jt('team.preview.copy', 'Copy text');
      const download = jt('team.preview.download', 'Download');
      const close = jt('team.preview.close', 'Close (Esc)');
      return '<div class="team-preview__head"><div class="team-preview__title">' + back + '<span class="team-preview__name" dir="auto">' + escapeHtml(name) + '</span>'
        + '<span class="team-preview__meta">' + escapeHtml(meta) + '</span></div><div class="team-preview__acts">' + view
        + iconBtn('copy', copy, GLYPH.copy) + iconBtn('download', download, GLYPH.download)
        + inv().actionButton({ variant: 'ghost', size: 'sm', className: 'btn--icon', ariaLabel: jt('team.preview.closeLabel', 'Close preview'), title: close,
          dataset: { 'team-preview-action': 'close' }, trustedHtml: GLYPH.close })
        + '</div></div><div class="team-preview__body" tabindex="0"></div>';
    }

    function bodyHtml() {
      const { state, detail } = shown;
      const a = detail.attachment;
      const name = filesModule.shownName(a.name);
      const download = actionBtn('download', jt('team.preview.download', 'Download'), GLYPH.download);
      switch (state) {
        case 'loading': return stateHtml(jt('team.preview.loading', 'Loading {name}…', { name }), '', '', true);
        case 'offline': return stateHtml(jt('team.preview.offline', 'This file needs the team online.'), jt('team.preview.offlineRetry', 'Try again when the team is back.'),
          '<br>' + actionBtn('retry', jt('team.chat.tryAgain', 'Try again')));
        case 'gone': return stateHtml(jt('team.preview.gone', 'No longer on the team server.'), jt('team.preview.goneMore', 'Whoever shared it may have deleted the message.'));
        case 'notText': return stateHtml(jt('team.preview.notText', 'Jenny can show text and code files here.'),
          jt('team.preview.notTextMore', 'This one is not text. Download it to open it in another app.'), '<br>' + download);
        case 'failed': return stateHtml(words.errorText(shown.error), '', '<br>' + actionBtn('retry', jt('team.chat.tryAgain', 'Try again')));
        default:
      }
      const entry = shown.entry;
      if (rendered()) {
        const html = String(markdown().renderMarkdown(entry.text, MARKDOWN_OPTIONS) || '');
        return (entry.truncated ? '<p class="team-preview__note">' + escapeHtml(cutNote(entry, false)) + '</p>' : '') + '<div class="team-preview__md chat-bubble-markdown">' + html + '</div>';
      }
      const code = codeHtml(entry.text, name);
      const big = isMarkdown(a) && shown.view === 'rendered' && entry.text.length > RENDER_MAX_CHARS
        ? jt('team.preview.tooBigToRender', 'This file is too long to show rendered, so it shows as source.') : '';
      const note = [big, code.linesCut || entry.truncated ? cutNote(entry, code.linesCut) : ''].filter(Boolean).join(' ');
      return (note ? '<p class="team-preview__note">' + escapeHtml(note) + '</p>' : '') + code.html;
    }

    // Markdown shown rendered: asked for, small enough, and the renderer is there.
    function rendered() {
      return Boolean(shown && shown.entry) && isMarkdown(shown.detail.attachment) && shown.view === 'rendered' && shown.entry.text.length <= RENDER_MAX_CHARS
        && Boolean(markdown()) && typeof markdown().renderMarkdown === 'function';
    }

    function cutNote(entry, linesCut) {
      const size = filesModule.sizeText(entry.total_bytes || shown.detail.attachment.size_bytes);
      if (linesCut && entry.truncated) return jt('team.preview.truncated', 'Showing the first 2,000 lines (512 KB) of {size}. Download it for the whole file.', { size });
      if (linesCut) return jt('team.preview.truncatedLines', 'Showing the first 2,000 lines of {size}. Download it for the whole file.', { size });
      return jt('team.preview.truncatedBytes', 'Showing the first 512 KB of {size}. Download it for the whole file.', { size });
    }

    function drawBody() {
      const bodyEl = el.querySelector('.team-preview__body');
      const had = bodyEl.contains(doc.activeElement);
      bodyEl.innerHTML = bodyHtml();
      bodyEl.scrollTop = 0;
      // The plain rows paint first; the colouring follows a frame later, for the same file and view only.
      if (shown.state === 'text' && !rendered()) {
        const mine = token;
        const view = shown.view;
        const later = win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(fn, 16);
        later(() => {
          if (disposed || !shown || mine !== token || shown.view !== view || !el.contains(bodyEl)) return;
          const code = highlighter();
          if (code && typeof code.decorateCodeBlocks === 'function') code.decorateCodeBlocks(bodyEl);
        });
      }
      if (had && !bodyEl.contains(doc.activeElement)) bodyEl.focus({ preventScroll: true });
    }

    // ------------------------------------------------------------- loading

    function refuse(error) {
      const reason = error && typeof error.reason === 'string' ? error.reason : '';
      if (reason === 'team_attachment_not_text') return { state: 'notText' };
      if (reason === 'team_chat_not_found') return { state: 'gone' };
      if (!ctx().online) return { state: 'offline' };
      return { state: 'failed', error };
    }

    async function load() {
      const mine = ++token;
      const a = shown.detail.attachment;
      const held = recall(teamId, a.id);
      if (held) { shown.entry = held; shown.state = 'text'; drawBody(); return; }
      if (!ctx().online) { shown.state = 'offline'; drawBody(); return; }
      shown.state = 'loading';
      drawBody();
      let answer;
      try { answer = await call('chatAttachmentText', { team_id: teamId, channel_id: shown.detail.channelId, attachment_id: a.id, name: a.name }); } catch (_error) { answer = null; }
      if (disposed || mine !== token) return;
      if (answer && answer.ok === true && typeof answer.text === 'string') {
        shown.entry = { text: answer.text, truncated: answer.truncated === true, total_bytes: Number(answer.total_bytes) || 0 };
        remember(teamId, a.id, shown.entry);
        shown.state = 'text';
      } else Object.assign(shown, refuse(answer && answer.error ? answer.error : { code: '', reason: '' }));
      drawBody();
    }

    // ------------------------------------------------------------- actions

    function say(text) {
      if (copiedTimer) clearTimeout(copiedTimer);
      if (copiedEl) copiedEl.remove();
      copiedEl = doc.createElement('div');
      copiedEl.className = 'team-copied';
      copiedEl.innerHTML = '<div class="inv-toast" role="status" aria-live="polite"><div class="inv-toast__body"><div class="inv-toast__message">'
        + escapeHtml(text) + '</div></div></div>';
      el.appendChild(copiedEl);
      copiedTimer = setTimeout(() => { if (copiedEl) copiedEl.remove(); copiedEl = null; copiedTimer = 0; }, COPIED_MS);
    }

    async function copy() {
      if (!shown || shown.state !== 'text') return;
      const clipboard = win && win.jennyShell && win.jennyShell.clipboard;
      let ok;
      try { ok = Boolean(clipboard && typeof clipboard.writeText === 'function') && (await clipboard.writeText(shown.entry.text), true); } catch (_error) { ok = false; }
      if (!disposed) say(ok ? jt('team.preview.copied', 'Copied') : jt('team.preview.copyFailed', 'Could not copy'));
    }

    // A cancelled dialog answers `saved: false` and says nothing; a refusal is shown in words.
    let saving = false;
    async function download() {
      if (!shown || saving) return;
      const a = shown.detail.attachment;
      const mine = shown;
      saving = true;
      let answer;
      try { answer = await call('chatAttachmentSave', { team_id: teamId, channel_id: mine.detail.channelId, attachment_id: a.id, name: a.name }); } finally { saving = false; }
      if (disposed || shown !== mine || !answer || answer.ok || !answer.error) return;
      if (answer.error.reason === 'team_chat_not_found') { token += 1; shown.state = 'gone'; drawBody(); } else say(words.errorText(answer.error));
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-team-preview-action]') : null;
      if (!target || target.disabled || !el.contains(target) || !shown) return;
      switch (target.dataset.teamPreviewAction) {
        case 'close':
        case 'back': requestClose(); return;
        case 'copy': void copy(); return;
        case 'download': void download(); return;
        case 'retry': void load(); return;
        default:
      }
    }

    function onView(event) {
      if (!shown || !event.detail || event.detail.id !== SEGMENT_ID) return;
      shown.view = event.detail.value === 'source' ? 'source' : 'rendered';
      drawBody();
    }

    function onKeydown(event) {
      if (chatWrites.isCloseKey(event)) { event.preventDefault(); requestClose(); }
    }

    // ------------------------------------------------------------- a project's files (row 175 round 2)

    // The thread this column covers: the open one, hidden (never closed) while the column shows.
    function cover() {
      const covers = thread();
      if (covered && covered !== covers) covered.hidden = false;
      covered = covers || null;
      if (covered) covered.hidden = true;
    }

    function dropProject() {
      if (shown && shown.project) shown.project.pane.dispose();
    }

    // True when `detail` names a project of this column's team and the pane module is there.
    const projectAsk = (detail) => !disposed && Boolean(panes()) && detail.teamId === teamId && PROJECT_ID.test(String(detail.projectId));
    const sameProject = (detail) => Boolean(shown && shown.project && shown.project.projectId === detail.projectId);

    function openProject(detail, opener) {
      if (!projectAsk(detail)) return false;
      const path = typeof detail.path === 'string' ? detail.path : '';
      if (sameProject(detail)) { shown.project.pane.show(path); return true; }
      const files = panes();
      dropProject();
      if (!el) build();
      cover();
      const projectName = String(detail.projectName || '').slice(0, 200);
      token += 1;
      shown = { project: { projectId: detail.projectId, pane: null }, opener, withBack: Boolean(covered) };
      el.hidden = false;
      shell.dataset.preview = 'side';
      el.setAttribute('aria-label', jt('team.projectFiles.label', 'Files in {project}', { project: projectName || jt('team.projects.unnamed', 'A project') }));
      el.innerHTML = '';
      copiedEl = null;
      shown.project.pane = files.createPane({ el, teamId, projectId: detail.projectId, projectName, call, mode: 'column', path, onClose: requestClose });
      if (!path) { const close = el.querySelector('[data-team-files-action="close"]'); if (close) close.focus({ preventScroll: true }); }
      return true;
    }

    // The row may have been drawn again since: then its file's name button in the same log (an attachment) or the page's
    // button with the same action (a project's files) takes the focus.
    function backTarget(opener) {
      if (!opener || opener.isConnected || !opener.dataset) return opener;
      if (opener.dataset.teamAtt) return shell.querySelector('.team-file__open[data-team-att="' + opener.dataset.teamAtt + '"]');
      return opener.dataset.projectAction ? shell.querySelector('[data-project-action="' + opener.dataset.projectAction + '"]') : opener;
    }

    // ----------------------------------------------------------------- api

    const api = {
      get el() { return el; },
      isOpen: () => Boolean(shown),
      // `detail`: the `team:file-preview` event's; `opener`: the control it came from (focused again on close).
      open(detail, opener = null) {
        if (detail && detail.kind === 'project-files') return openProject(detail, opener);
        const a = detail && detail.attachment;
        if (disposed || !a || !ATT_ID.test(String(a.id)) || (detail.teamId && detail.teamId !== teamId)) return false;
        dropProject();
        if (!el) build();
        cover();
        shown = { detail: { ...detail, attachment: { id: a.id, name: String(a.name || ''), mime: String(a.mime || ''), size_bytes: Number(a.size_bytes) || 0 } },
          opener, state: 'loading', view: 'rendered', entry: null, error: null, withBack: Boolean(covered) };
        el.hidden = false;
        shell.dataset.preview = 'side';
        el.setAttribute('aria-label', jt('team.preview.label', 'Preview of {name}', { name: filesModule.shownName(a.name) }));
        el.innerHTML = headHtml();
        copiedEl = null;
        void load();
        const close = el.querySelector('[data-team-preview-action="close"]');
        if (close) close.focus({ preventScroll: true });
        return true;
      },
      // `restore: false` when the column goes with its frame. Closing un-hides the thread it covered, unchanged.
      close({ restore = true } = {}) {
        if (!shown) return;
        const { opener } = shown;
        dropProject();
        shown = null;
        token += 1;
        if (copiedTimer) clearTimeout(copiedTimer);
        copiedTimer = 0;
        copiedEl = null;
        if (el) { el.hidden = true; el.innerHTML = ''; }
        delete shell.dataset.preview;
        if (covered) covered.hidden = false;
        covered = null;
        // The row may have been drawn again since: then its file's name button in the same log takes the focus.
        const back = backTarget(opener);
        if (restore && back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
      },
      dispose() {
        if (disposed) return;
        api.close({ restore: false });
        disposed = true;
        if (el) {
          el.removeEventListener('click', onClick);
          el.removeEventListener('keydown', onKeydown);
          el.removeEventListener('inv-segmented-change', onView);
          el.remove();
          el = null;
        }
      },
    };
    return api;
  }

  return { createPreview, forgetTeam, disposeAll };
});
