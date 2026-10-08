/**
 * renderer/features/renderer-project-notes-rail-render.js
 *
 * Pure render model of the Project Notes rail (the `notes` mode of the artifact
 * review panel). The controller (renderer-project-notes-rail.js) owns state and
 * IPC; this module turns a model into an HTML string, holds the pure rules the
 * controller shares (the line diff, the change-strip rule, the recorded-lines
 * highlight) and the stateless DOM hand-over helpers at the bottom.
 *
 * Highlighting choice: the Scratchpad markdown renderer returns one flat
 * top-level element per source line, so the preview renders LINE BY LINE and
 * wraps each line in `.notes-rail__line[data-line]`. A highlighted line is the
 * wrapper with `--new`; no post-paint DOM patching is needed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory({
      actionButton: require('../inventory/action-button'),
      textField: require('../inventory/text-field'),
    });
    return;
  }
  root.rendererProjectNotesRailRender = factory({
    actionButton: root.inventoryActionButton,
    textField: root.inventoryTextField,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventory) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const MAX_NOTE_CHARS = 20000;
  // A change older than this is no longer news: the strip stops offering it.
  const STRIP_WINDOW_MS = 24 * 3600 * 1000;
  const ERROR_ACTIONS = {
    stale: ['save-mine', 'use-theirs'],
    save_failed: ['retry'],
    load_failed: ['retry'],
  };
  const TASKS_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.25 4h7M6.25 8h7M6.25 12h7"/><path d="m2.5 4 .75.75L4.75 3.25M2.5 8l.75.75L4.75 7.25M2.5 12l.75.75 1.5-1.5"/></svg>';
  const NOTES_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h9v11h-9z"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>';

  function relativeTime(iso, now) {
    const at = Date.parse(String(iso || ''));
    if (!Number.isFinite(at)) return '';
    const elapsed = Math.max(0, (Number.isFinite(Number(now)) ? Number(now) : Date.now()) - at);
    if (elapsed < 60000) return jt('projectNotes.strip.justNow', 'just now');
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 60) return jtn('projectNotes.strip.minutesAgo', minutes, { count: minutes }, '{count} min ago', '{count} min ago');
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return jtn('projectNotes.strip.hoursAgo', hours, { count: hours }, '{count} h ago', '{count} h ago');
    return new Date(at).toLocaleString(globalThis.jennyI18n?.tag?.(), { month: 'short', day: 'numeric', hour: 'numeric', ...globalThis.jennyI18n?.timeOptions?.(), minute: '2-digit' });
  }

  function splitLines(text) {
    const value = String(text == null ? '' : text).replace(/\n$/u, '');
    return value === '' ? [] : value.split('\n');
  }

  // Common-prefix/suffix trim: `start` is the first changed line index in the
  // NEW text, `added` the changed new lines, `removed` the changed old lines.
  function diffLines(before, after) {
    const a = splitLines(before);
    const b = splitLines(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
    let suffix = 0;
    while (suffix < a.length - start && suffix < b.length - start
      && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
    return { start, added: b.length - suffix - start, removed: a.length - suffix - start };
  }

  // The controller's view of one Jenny write: the strip diff plus the new-line highlight set.
  function measureChange(before, note) {
    const measured = diffLines(before, note.text);
    const entry = note.journal[note.journal.length - 1];
    return {
      diff: { entryId: entry ? entry.id : '', added: measured.added, removed: measured.removed },
      highlight: measured.added > 0
        ? new Set(Array.from({ length: measured.added }, (_, offset) => measured.start + offset)) : null,
    };
  }

  function stripVerb(diff) {
    if (!diff || (diff.added <= 0 && diff.removed <= 0)) return { verb: 'generic', lines: 0 };
    if (diff.removed <= 0) return { verb: 'added', lines: diff.added };
    if (diff.added <= 0) return { verb: 'removed', lines: diff.removed };
    return { verb: 'edited', lines: Math.max(diff.added, diff.removed) };
  }

  /**
   * The change strip rule. The strip describes the LATEST journal entry (the
   * journal only holds Jenny's tool writes; user saves add none) and is null when
   * there is no entry, it is hidden, it is older than a day, or it was undone
   * (the note was last written by Jenny but the entry is no longer undoable).
   * `diff` ({ entryId, added, removed }) is the controller's measured line diff
   * for that entry; without one (a cold open) the entry's own recorded `lines`
   * (the service's diff) stand in, and with neither the verb is `generic`. After a user
   * edit (`note.updatedBy === 'user'`, or `userEditedAfter` is at/after the entry)
   * the strip turns generic and loses Undo.
   */
  function buildChangeStrip(note, options) {
    const o = options || {};
    const journal = Array.isArray(note?.journal) ? note.journal : [];
    const entry = journal[journal.length - 1];
    if (!entry || String(entry.id || '') === String(o.hiddenEntryId || '')) return null;
    // An undone write is not news either (the undo itself is attributed to the user).
    if (entry.undone === true) return null;
    const at = Date.parse(String(entry.at || ''));
    const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
    if (!Number.isFinite(at) || now - at > STRIP_WINDOW_MS) return null;
    if (note.updatedBy === 'assistant' && entry.undoable !== true) return null;
    const editedAfter = typeof o.userEditedAfter === 'string' ? Date.parse(o.userEditedAfter) : Number(o.userEditedAfter);
    const userEdited = note.updatedBy === 'user' || (Number.isFinite(editedAfter) && editedAfter > 0 && at <= editedAfter);
    const source = o.diff && o.diff.entryId === entry.id ? o.diff : entry.lines;
    const measured = !userEdited ? stripVerb(source) : { verb: 'generic', lines: 0 };
    return { entryId: entry.id, verb: measured.verb, lines: measured.lines, at: entry.at, undoable: !userEdited && entry.undoable === true };
  }

  // The journal's recorded line range of the latest Jenny write, as the highlight
  // set, when the strip would show that write. null otherwise.
  function recordedHighlight(note, options) {
    const strip = buildChangeStrip(note, options);
    const lines = strip && strip.verb !== 'generic' ? note.journal[note.journal.length - 1]?.lines : null;
    if (!lines || !(lines.added > 0) || !Number.isInteger(lines.start)) return null;
    return new Set(Array.from({ length: lines.added }, (_, offset) => lines.start + offset));
  }

  function renderHeader(model, helpers) {
    const { escapeHtml, actionButton } = helpers;
    const tasksLabel = jt('artifactPanelV2Render.tasks', 'Tasks');
    const notesLabel = jt('projectNotes.title', 'Notes');
    return '<header class="notes-rail__header"><b>' + escapeHtml(model.projectName || '') + '</b>'
      + '<span class="notes-rail__mode">'
      + actionButton({ id: 'notes-rail-switch-tasks', plain: true, className: 'chat-timeline-utility-button notes-rail__mode-button', ariaLabel: tasksLabel, title: tasksLabel, trustedHtml: TASKS_ICON })
      + actionButton({ id: 'notes-rail-mode-notes', plain: true, className: 'chat-timeline-utility-button notes-rail__mode-button', ariaLabel: notesLabel, title: notesLabel, ariaPressed: true, trustedHtml: NOTES_ICON })
      + '</span></header>';
  }

  function renderStrip(strip, helpers) {
    if (!strip) return '';
    const { escapeHtml, actionButton } = helpers;
    const count = strip.lines;
    const copy = {
      added: () => jtn('projectNotes.strip.added', count, { count }, 'Jenny added {count} line', 'Jenny added {count} lines'),
      edited: () => jtn('projectNotes.strip.edited', count, { count }, 'Jenny edited {count} line', 'Jenny edited {count} lines'),
      removed: () => jtn('projectNotes.strip.removed', count, { count }, 'Jenny removed {count} line', 'Jenny removed {count} lines'),
    }[strip.verb];
    const text = copy ? copy() : jt('projectNotes.strip.editedByJenny', 'Jenny edited this note');
    const time = relativeTime(strip.at, helpers.now);
    return '<div class="notes-rail__strip"><span class="notes-rail__strip-text">' + escapeHtml(text + (time ? ' · ' + time : '')) + '</span>'
      + actionButton({ id: 'notes-rail-hide-changes', label: jt('projectNotes.strip.hide', 'Hide changes'), variant: 'ghost', size: 'sm' })
      + (strip.undoable ? actionButton({ id: 'notes-rail-undo', label: jt('projectNotes.strip.undo', 'Undo'), variant: 'ghost', size: 'sm', dataset: { 'entry-id': strip.entryId } }) : '')
      + '</div>';
  }

  function errorCopy(kind) {
    switch (kind) {
      case 'stale': return jt('projectNotes.error.stale', 'Jenny changed this note while you were editing.');
      case 'note_full': return jt('projectNotes.error.full', 'The note is at its 20,000-character limit.');
      case 'load_failed': return jt('projectNotes.error.loadFailed', 'Could not load this note.');
      case 'unavailable': return jt('projectNotes.error.unavailable', 'Notes are unavailable in this build.');
      default: return jt('projectNotes.error.saveFailed', 'Could not save. Your draft is kept here.');
    }
  }

  function errorButton(name, actionButton) {
    const labels = {
      'save-mine': jt('projectNotes.error.saveMine', 'Save mine'),
      'use-theirs': jt('projectNotes.error.useTheirs', "Use Jenny's"),
      retry: jt('projectNotes.error.retry', 'Retry'),
    };
    if (!labels[name]) return '';
    return actionButton({ id: `notes-rail-${name}`, label: labels[name], variant: 'ghost', size: 'sm' });
  }

  function renderError(error, helpers) {
    if (!error) return '';
    const actions = Array.isArray(error.actions) ? error.actions : ERROR_ACTIONS[error.kind] || [];
    return '<div class="notes-rail__error" role="alert"><span>' + helpers.escapeHtml(errorCopy(error.kind)) + '</span>'
      + actions.map((name) => errorButton(name, helpers.actionButton)).join('') + '</div>';
  }

  function renderPreviewLines(text, highlight, helpers) {
    return String(text).split('\n').map((line, index) => {
      const cls = 'notes-rail__line' + (highlight && highlight.has(index) ? ' notes-rail__line--new' : '');
      const body = line.trim() === '' ? '' : helpers.renderMarkdown(line);
      return '<div class="' + cls + '" data-line="' + index + '">' + body + '</div>';
    }).join('');
  }

  function renderPreview(model, helpers) {
    const { escapeHtml } = helpers;
    const text = String(model.note?.text || '');
    const body = text.trim() === ''
      ? '<div class="notes-rail__empty">' + escapeHtml(jt('projectNotes.empty', 'No notes for {project} yet. Jenny keeps status and decisions here as she works, and you can write here too.', { project: model.projectName || '' })) + '</div>'
      : renderPreviewLines(text, model.highlightLines, helpers);
    return '<div class="notes-rail__preview" role="button" tabindex="0" data-action="notes-rail-edit" aria-label="'
      + escapeHtml(jt('projectNotes.editHint', 'Click to edit')) + '">' + body + '</div>';
  }

  function renderEditor(model, helpers) {
    const textField = helpers.textField || inventory.textField;
    if (typeof textField !== 'function') return '';
    return textField({
      id: 'projectNotesEditor',
      className: 'notes-rail__editor-field',
      multiline: true,
      rows: 8,
      value: model.draft,
      maxLength: MAX_NOTE_CHARS,
      ariaLabel: jt('projectNotes.editorLabel', 'Project notes'),
      // Stamped with its project: the controller drops input that lands after a project switch.
      dataset: { 'notes-editor': '', 'notes-project': String(model.projectId || '') },
    });
  }

  function renderBody(model, helpers) {
    if (model.editing) return renderEditor(model, helpers);
    if (model.note) return renderPreview(model, helpers);
    if (model.error) return '';
    return '<div class="notes-rail__loading">' + helpers.escapeHtml(jt('projectNotes.loading', 'Loading notes…')) + '</div>';
  }

  function renderNotesRailSurface(model, helpers) {
    const m = model && typeof model === 'object' ? model : {};
    const h = {
      ...helpers,
      escapeHtml: typeof helpers?.escapeHtml === 'function' ? helpers.escapeHtml : fallbackEscapeHtml,
      actionButton: typeof helpers?.actionButton === 'function' ? helpers.actionButton : inventory.actionButton,
      renderMarkdown: typeof helpers?.renderMarkdown === 'function' ? helpers.renderMarkdown : (text) => fallbackEscapeHtml(text),
    };
    const footer = m.editing
      ? jt('projectNotes.footerEditing', 'Esc or click outside to finish · saved automatically · Markdown')
      : jt('projectNotes.footer', 'Click anywhere to edit · saved automatically · Markdown');
    return '<section class="notes-rail" aria-label="' + h.escapeHtml(jt('projectNotes.title', 'Notes')) + '">'
      + renderHeader(m, h) + renderStrip(m.changeStrip, h)
      + '<div class="notes-rail__body">' + renderBody(m, h) + '</div>'
      + renderError(m.error, h)
      + '<footer class="notes-rail__footer">' + h.escapeHtml(footer) + '</footer></section>';
  }

  // ---- DOM hand-over helpers (stateless; the controller owns every piece of state) ----

  // Same shared-chrome hand-over as the Tasks rail: hide the artifact detail, paint into the preview host.
  function prepareSurface(surface) {
    if (!surface) return null;
    surface.detailPanel?.classList?.remove('hidden');
    for (const hidden of [surface.detailEmpty, surface.metaPane, surface.saveButton, surface.revertButton, surface.revealButton,
      surface.openExternalButton, surface.deleteButton, surface.editorShell, surface.dirtyBadge]) hidden?.classList?.add('hidden');
    for (const field of [surface.detailKicker, surface.detailTitle, surface.detailPath,
      surface.detailStatus, surface.detailNote]) if (field) field.textContent = '';
    if (surface.detailMeta) surface.detailMeta.innerHTML = '';
    if (surface.provenanceTimeline) surface.provenanceTimeline.innerHTML = '';
    const host = surface.previewContent || surface;
    host?.classList?.remove?.('hidden');
    return host;
  }

  // Replaces the host's markup. A textarea that is still there keeps its caret,
  // scroll and focus; `focusEditor` focuses it with the caret at the end instead.
  function paintSurface(host, html, options) {
    const prior = host.querySelector('[data-notes-editor]');
    const keep = prior && {
      start: prior.selectionStart, end: prior.selectionEnd, top: prior.scrollTop, focused: host.ownerDocument?.activeElement === prior,
    };
    host.innerHTML = html;
    const editor = host.querySelector('[data-notes-editor]');
    if (!editor) return;
    const end = editor.value.length;
    if (options?.focusEditor) {
      editor.focus();
      editor.setSelectionRange(end, end);
    } else if (keep) {
      editor.scrollTop = keep.top;
      editor.setSelectionRange(Math.min(keep.start, end), Math.min(keep.end, end));
      if (keep.focused) editor.focus();
    }
  }

  // Replaces the rail part matching `selector` with `html`: inserted at `anchor`
  // (`position` as for insertAdjacentHTML) when absent, removed when `html` is empty.
  function swapPart(section, selector, html, anchor, position) {
    const current = section.querySelector(selector);
    if (current) { if (html) current.outerHTML = html; else current.remove(); }
    else if (html && anchor) anchor.insertAdjacentHTML(position, html);
  }

  // A click that ends a text selection inside the preview is not a request to edit.
  function previewClickIgnored(target, selection) {
    return Boolean(selection && !selection.isCollapsed && selection.toString() !== '' && target.contains?.(selection.anchorNode));
  }

  return {
    renderNotesRailSurface, renderStrip, renderError, buildChangeStrip, recordedHighlight, relativeTime, diffLines, measureChange,
    prepareSurface, paintSurface, swapPart, previewClickIgnored, MAX_NOTE_CHARS,
  };
});
