/* Scratchpad persistence + routing logic for the Home dashboard widget, kept
 * out of the widget so it is unit-testable with injected timers and a stub
 * shell. Saves are debounced (typing must not hammer shell config writes) and
 * always rewrite the WHOLE notes object — the shell-config section merge
 * replaces (not deep-merges) the scratchpad's own keys, so a partial single-
 * note delta would drop the other notes. Every mutation that could race a
 * pending save (note switch / add / rename / delete, and every routing action)
 * flushes the debounce first so the pad never loses the last keystrokes, and
 * each queued save remembers WHICH note it targets so a tab switch mid-debounce
 * can't land text in the wrong note.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardScratchpadActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const DEFAULT_SAVE_DEBOUNCE_MS = 600;
  const MAX_LOOP_LABEL_CHARS = 120;
  // Mirrors services/home-config-schema.js (MAX_HOME_SCRATCHPAD_NOTES /
  // _TITLE_CHARS). The schema normalizer is the real enforcer; these only give
  // the UI early feedback so a write that the schema would have capped never
  // leaves the renderer.
  const MAX_NOTES = 8;
  const MAX_TITLE_CHARS = 60;
  // Mirrors MAX_HOME_SCRATCHPAD_CHARS — the schema truncates the TAIL at this
  // length, which for a capture (appended at the end) would silently swallow the
  // new line, so capture pre-checks against it and refuses instead.
  const MAX_NOTE_CHARS = 4000;
  // Mirrors MAX_HOME_SCRATCHPAD_PINS — the schema normalizer is the real enforcer;
  // this only lets pinNote refuse early so a write the schema would have capped
  // never leaves the renderer.
  const MAX_PINS = 4;
  const MAX_EVENT_TITLE_CHARS = 200;
  // Workspace-relative, gitignored quick-export target. The workspace-fs path
  // normalizer (_normalizeRelPath) blocks traversal/absolute/NUL, so a
  // slugified filename can never escape this directory.
  const NOTES_DIR = '.jenny/notes';

  function noop() {}

  // Mirrors home-config-schema's slugifyHomeId so a saved file name matches the
  // note id rules ([a-z0-9-], <=48). Empty input collapses to '' (caller falls
  // back to 'note').
  function slugifyTitle(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  // Smallest free `note-N` id (+ matching "Note N" title) so new notes get a
  // stable, deterministic id the schema normalizer preserves across reads.
  function nextNoteName(notes) {
    const used = new Set((notes || []).map((note) => note && note.id));
    let n = 1;
    while (used.has(`note-${n}`)) {
      n += 1;
    }
    return { id: `note-${n}`, title: `Note ${n}` };
  }

  function localYmd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Local HH:MM for the capture line stamp ([HH:MM] <text>).
  function hhmm(date) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  // Build a default single-note scratchpad object. Mirrors the schema default
  // (services/home-config-schema.js) so the renderer can always write a valid
  // shape even before the first config payload lands.
  function defaultScratchpad() {
    return {
      notes: [{ id: 'note-1', title: 'Note 1', text: '', updatedAt: '', appendLog: false }],
      activeNoteId: 'note-1',
      settings: { rows: 6, font: 'prose', captureMode: 'append', markdown: false, globalCapture: true },
      // Match the shape readScratchpad() always produces (pins set on every path)
      // so a pin/delete write off this fallback can never key off an undefined set.
      pins: [],
    };
  }

  function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function jsonValuesEqual(left, right) {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length
        && left.every((value, index) => jsonValuesEqual(value, right[index]));
    }
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
        && jsonValuesEqual(left[key], right[key]));
  }
  function isCompleteHomeConfig(config) {
    return isRecord(config)
      && Array.isArray(config.links)
      && isRecord(config.widgets)
      && isRecord(config.scratchpad)
      && Array.isArray(config.scratchpad.notes)
      && typeof config.scratchpad.activeNoteId === 'string'
      && isRecord(config.scratchpad.settings)
      && Array.isArray(config.scratchpad.pins)
      && isRecord(config.calendar)
      && typeof config.focusMode === 'boolean'
      && typeof config.showContextualTips === 'boolean';
  }
  function createScratchpadActions(deps = {}) {
    const shell = deps.shell || null;
    const onHomeConfig = typeof deps.onHomeConfig === 'function' ? deps.onHomeConfig : noop;
    // Reads the current normalized scratchpad ({ notes, activeNoteId, settings })
    // from app state so a save can rewrite the WHOLE object.
    const getScratchpad = typeof deps.getScratchpad === 'function' ? deps.getScratchpad : null;
    const getHomeConfig = typeof deps.getHomeConfig === 'function' ? deps.getHomeConfig : null;
    const applyCompanionPayload = typeof deps.applyCompanionPayload === 'function'
      ? deps.applyCompanionPayload
      : noop;
    const onCalendarSnapshot = typeof deps.onCalendarSnapshot === 'function'
      ? deps.onCalendarSnapshot
      : noop;
    // Prefills + focuses the chat composer (manager-supplied; depends on the
    // shell's setActiveView). Returns false when the composer is unreachable.
    const sendToChatImpl = typeof deps.sendToChat === 'function' ? deps.sendToChat : null;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const nowProvider = typeof deps.nowProvider === 'function' ? deps.nowProvider : () => new Date();
    const debounceMs = Number.isFinite(Number(deps.debounceMs))
      ? Math.max(0, Number(deps.debounceMs))
      : DEFAULT_SAVE_DEBOUNCE_MS;
    const setTimeoutImpl = deps.setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms));
    const clearTimeoutImpl = deps.clearTimeoutImpl || ((timer) => clearTimeout(timer));

    let saveTimer = null;
    // The queued draft: { text, noteId }. noteId is captured at keystroke time so
    // a tab switch between queueSave and the debounce fire can't write the text
    // into the newly-active note. Each queueSave makes a NEW object, so identity
    // tells a flush whether a newer draft arrived while it was writing.
    let pending = null;
    // The latest in-flight write promise. A fire-and-forget save (a textarea
    // focusout flush) leaves no queued text but its config echo is still settling;
    // flushSave() awaits this so a caller that serializes after it (the markdown
    // checklist toggle) reads the reconciled note, never a stale pre-echo snapshot.
    let inFlightWrite = null;
    let inFlightSave = null;

    const hasNote = (notes, noteId) => notes.some((note) => note.id === noteId);
    const noteNotFound = () => ({ error: jt('dashboard.scratchpad.actions.noteNotFound', 'Note not found.') });
    const saveNoteFailed = () => ({ error: jt('dashboard.scratchpad.actions.saveNoteFailed', 'Could not save the note.') });
    const notesUnavailable = () => ({ error: jt('dashboard.scratchpad.actions.notesUnavailable', 'Notes are unavailable.') });

    // Resolve the current scratchpad object, tolerating a missing accessor or a
    // half-seeded state so a save never throws on a malformed snapshot.
    function readScratchpad() {
      const current = getScratchpad ? getScratchpad() : null;
      const source = isRecord(current) ? current : {};
      const notes = Array.isArray(source.notes) ? source.notes.filter(isRecord) : [];
      if (notes.length === 0) {
        return defaultScratchpad();
      }
      let activeNoteId = typeof source.activeNoteId === 'string' ? source.activeNoteId : '';
      if (!hasNote(notes, activeNoteId)) {
        activeNoteId = notes[0].id;
      }
      const settings = isRecord(source.settings) ? source.settings : undefined;
      // Pinned-note ids ride along so pin/unpin/delete can rewrite the set off
      // live state; cross-validation against surviving notes happens at each
      // call site (and again in the schema normalizer on read).
      const pins = Array.isArray(source.pins)
        ? source.pins.filter((id) => typeof id === 'string')
        : [];
      return { notes, activeNoteId, settings, pins };
    }

    // The capture / pin instances can run before Home primes app state, when
    // readScratchpad() would fall back to the empty default (or read the Home
    // manager's placeholder, which is deliberately not a complete config);
    // writing that would replace every persisted note and setting. Load the
    // real pad first and refuse the write when it cannot be read.
    function hasLoadedNotes() {
      if (getHomeConfig && !isCompleteHomeConfig(getHomeConfig())) return false;
      const current = getScratchpad ? getScratchpad() : null;
      return Array.isArray(current?.notes) && current.notes.length > 0;
    }

    async function ensureLoaded() {
      if (hasLoadedNotes()) return true;
      try {
        const config = await shell?.home?.getConfig?.();
        if (isCompleteHomeConfig(config)) onHomeConfig(config);
      } catch (error) {
        appendClientLog('WARN', 'home.scratchpad_load_failed', {
          message: String(error?.message || error || ''),
        });
      }
      return hasLoadedNotes();
    }

    function scratchpadEchoMatches(requested, config, currentHome) {
      const echoed = config?.scratchpad;
      if (!isCompleteHomeConfig(config)) return false;
      // The whole scratchpad section must match, so a pointer-only echo that lost
      // sibling notes is refused; other home sections may legitimately have moved
      // under a concurrent write (rail width, calendar, Settings) and are adopted.
      if (isRecord(currentHome)) {
        return jsonValuesEqual(echoed, { ...(currentHome.scratchpad || {}), ...requested });
      }
      return Object.keys(requested).every((key) => (
        jsonValuesEqual(echoed[key], requested[key])
      ));
    }

    // The single writer: rewrites the whole scratchpad object (or a pointer-only
    // patch for switches, since the section merge keeps untouched keys) and
    // adopts only an echo that acknowledges every requested field.
    async function writeScratchpad(scratchpad) {
      if (!shell?.home?.updateConfig) {
        return null;
      }
      const op = (async () => {
        try {
          const config = await shell.home.updateConfig({ scratchpad });
          // Read the baseline AFTER the await: a sibling actions instance (pin
          // editor, capture) may have landed and been adopted meanwhile, and its
          // change is legitimately part of this echo.
          const currentHome = getHomeConfig?.() || null;
          if (!scratchpadEchoMatches(scratchpad, config, currentHome)) {
            throw new Error('Scratchpad persistence acknowledgement did not match the requested change.');
          }
          onHomeConfig(config);
          return config;
        } catch (error) {
          appendClientLog('WARN', 'home.scratchpad_save_failed', {
            message: String(error?.message || error || ''),
          });
          return null;
        }
      })();
      inFlightWrite = op;
      try {
        return await op;
      } finally {
        if (inFlightWrite === op) {
          inFlightWrite = null;
        }
      }
    }

    function withSettings(scratchpad, current) {
      if (current.settings) {
        scratchpad.settings = current.settings;
      }
      return scratchpad;
    }

    // Persists `text` as the content of `targetNoteId` (the note that was active
    // when the keystroke was queued), rewriting the whole notes array. The
    // active-note pointer and settings are preserved; the stamp is applied here,
    // at write time, not on every keystroke.
    async function persist(text, targetNoteId) {
      if (!hasLoadedNotes() && !await ensureLoaded()) return null;
      const current = readScratchpad();
      // A draft whose note was deleted elsewhere mid-debounce is dropped, never
      // written over whichever note is active now.
      if (targetNoteId && !hasNote(current.notes, targetNoteId)) {
        return true;
      }
      const noteId = targetNoteId || current.activeNoteId;
      const stamp = nowProvider().toISOString();
      const nextNotes = current.notes.map((note) => (
        note.id === noteId
          ? { ...note, text: String(text), updatedAt: stamp }
          : note
      ));
      return writeScratchpad(withSettings({ notes: nextNotes, activeNoteId: current.activeNoteId }, current));
    }

    // `noteId` (optional) pins the save to the note the caller is editing, so an
    // active-note switch before the debounce fires can't misroute the text.
    // `onSettled` (optional) hears the debounced write's result, so a failure
    // can be shown instead of leaving "Saving…" up.
    function queueSave(text, noteId, onSettled) {
      pending = { text: String(text), noteId: noteId || readScratchpad().activeNoteId };
      if (saveTimer) {
        clearTimeoutImpl(saveTimer);
      }
      saveTimer = setTimeoutImpl(() => {
        saveTimer = null;
        void flushSave().then((saved) => {
          if (typeof onSettled === 'function') onSettled(saved);
        });
      }, debounceMs);
    }

    async function flushSave() {
      if (saveTimer) {
        clearTimeoutImpl(saveTimer);
        saveTimer = null;
      }
      if (inFlightSave) {
        return (await inFlightSave) && (!pending || await flushSave());
      } else if (inFlightWrite && !await inFlightWrite && pending) {
        // A failed sibling write (pin, settings) only blocks a real draft; with
        // nothing queued there is nothing of the note's left to lose.
        return false;
      }
      if (!pending) return true;
      const draft = pending;
      const op = (async () => {
        const config = await persist(draft.text, draft.noteId);
        if (!config) return false;
        if (pending === draft) pending = null;
        return true;
      })();
      inFlightSave = op;
      let saved;
      try {
        saved = await op;
      } finally {
        if (inFlightSave === op) inFlightSave = null;
      }
      return saved && (!pending || await flushSave());
    }

    // The unsaved draft text for `noteId` while it is queued or left behind by a
    // failed write (null once a write is carrying it). Lets the widget keep that
    // draft on screen instead of repainting the older persisted text over it.
    function pendingDraftFor(noteId) {
      return pending && !inFlightSave && pending.noteId === noteId ? pending.text : null;
    }

    // Shared prelude of every scratchpad write: fail when persistence is missing,
    // else flush the pending text first and make sure the real pad is loaded.
    // `unavailable` builds the caller's own "unavailable" result. Returns a
    // result object to hand back, or null to proceed.
    async function noteWriteBlocked(unavailable = notesUnavailable) {
      if (!shell?.home?.updateConfig) return unavailable();
      if (!await flushSave()) return saveNoteFailed();
      if (!await ensureLoaded()) return unavailable();
      return null;
    }

    // Append a fresh empty note and make it active. Flushes first so the
    // outgoing note keeps its in-flight edits. Returns { ok, activeNoteId } or
    // { error }.
    async function addNote() {
      const blocked = await noteWriteBlocked();
      if (blocked) return blocked;
      const current = readScratchpad();
      if (current.notes.length >= MAX_NOTES) {
        return { error: jt('dashboard.scratchpad.actions.notesLimit', 'Up to {count} notes.', { count: MAX_NOTES }) };
      }
      const { id, title } = nextNoteName(current.notes);
      const notes = [...current.notes, { id, title, text: '', updatedAt: '', appendLog: false }];
      const config = await writeScratchpad(withSettings({ notes, activeNoteId: id }, current));
      return config ? { ok: true, activeNoteId: id } : { error: jt('dashboard.scratchpad.actions.addNoteFailed', 'Could not add a note.') };
    }

    // Change a note's title only (the id is preserved so per-note UI state and
    // the active pointer stay valid). Empty title is allowed — the schema slugs
    // its id from the existing id, and the tab strip shows a fallback label.
    async function renameNote(noteId, title) {
      const blocked = await noteWriteBlocked();
      if (blocked) return blocked;
      const current = readScratchpad();
      if (!hasNote(current.notes, noteId)) return noteNotFound();
      const cleanTitle = String(title || '').replace(/[\r\n\0]/g, '').trim().slice(0, MAX_TITLE_CHARS);
      const notes = current.notes.map((note) => (
        note.id === noteId ? { ...note, title: cleanTitle } : note
      ));
      const config = await writeScratchpad(withSettings({ notes, activeNoteId: current.activeNoteId }, current));
      return config ? { ok: true } : { error: jt('dashboard.scratchpad.actions.renameNoteFailed', 'Could not rename the note.') };
    }

    // Remove a note (never the last one). If the active note is deleted, the
    // neighbor that slid into its slot becomes active (deterministic, no dangling
    // pointer). Returns the surviving active id so the widget can sync.
    async function deleteNote(noteId) {
      const blocked = await noteWriteBlocked();
      if (blocked) return blocked;
      const current = readScratchpad();
      if (current.notes.length <= 1) {
        return { error: jt('dashboard.scratchpad.actions.keepOneNote', 'Keep at least one note.') };
      }
      const index = current.notes.findIndex((note) => note.id === noteId);
      if (index === -1) return noteNotFound();
      const notes = current.notes.filter((note) => note.id !== noteId);
      let activeNoteId = current.activeNoteId;
      if (activeNoteId === noteId) {
        activeNoteId = (notes[index] || notes[notes.length - 1]).id;
      }
      // Drop the deleted id from the pin set in the same write so the sticky
      // overlay never flashes a dangling chip (the schema would drop it on read
      // too, but stripping here keeps the in-flight echo clean).
      const survivingIds = new Set(notes.map((note) => note.id));
      const pins = current.pins.filter((id) => survivingIds.has(id));
      const config = await writeScratchpad(withSettings({ notes, activeNoteId, pins }, current));
      return config ? { ok: true, activeNoteId } : { error: jt('dashboard.scratchpad.actions.deleteNoteFailed', 'Could not delete the note.') };
    }

    // Switch the active note. Flushes any pending save FIRST so the outgoing
    // note keeps its edits, then persists a pointer-only patch (the section merge
    // keeps notes + settings).
    async function setActiveNote(noteId) {
      const blocked = await noteWriteBlocked();
      if (blocked) return blocked;
      const current = readScratchpad();
      if (!hasNote(current.notes, noteId)) return noteNotFound();
      if (current.activeNoteId === noteId) {
        return { ok: true };
      }
      const config = await writeScratchpad({ activeNoteId: noteId });
      return config ? { ok: true } : { error: jt('dashboard.scratchpad.actions.switchNotesFailed', 'Could not switch notes.') };
    }

    // Pin / unpin a note onto the sticky-note overlay. Writes a pointer-only
    // { pins } patch (the section merge keeps notes + activeNoteId + settings),
    // exactly like setActiveNote's pointer patch. Flushes any pending pad save
    // first so a debounced text write can't land after this and the two writes
    // serialize cleanly. Returns { ok, pinned } or { error }; pinning an already-
    // pinned note (or unpinning an unpinned one) is an idempotent success.
    async function setPinned(noteId, shouldPin) {
      const blocked = await noteWriteBlocked();
      if (blocked) return blocked;
      const current = readScratchpad();
      if (!hasNote(current.notes, noteId)) return noteNotFound();
      // Re-validate the live set against surviving notes before mutating it.
      const pins = current.pins.filter((id) => hasNote(current.notes, id));
      const alreadyPinned = pins.includes(noteId);
      if (shouldPin === alreadyPinned) {
        return { ok: true, pinned: alreadyPinned };
      }
      let nextPins;
      if (shouldPin) {
        if (pins.length >= MAX_PINS) {
          return { error: jt('dashboard.scratchpad.actions.pinLimit', 'Up to {count} pinned notes — unpin one first.', { count: MAX_PINS }) };
        }
        nextPins = [...pins, noteId];
      } else {
        nextPins = pins.filter((id) => id !== noteId);
      }
      const config = await writeScratchpad({ pins: nextPins });
      return config ? { ok: true, pinned: shouldPin } : { error: jt('dashboard.scratchpad.actions.updatePinsFailed', 'Could not update pins.') };
    }

    function pinNote(noteId) {
      return setPinned(noteId, true);
    }

    function unpinNote(noteId) {
      return setPinned(noteId, false);
    }

    // Toggle entry point for the tab "⋯" menu — flips the current pin state.
    function togglePin(noteId) {
      const pinned = readScratchpad().pins.includes(noteId);
      return setPinned(noteId, !pinned);
    }

    // Scratchpad presentation is owned by the widget menu. Serialize it behind
    // any pending text write, preserve every note/pin, and return a structured
    // result so the menu can keep visible feedback on failure.
    async function updateSettings(patch = {}) {
      const blocked = await noteWriteBlocked(() => ({ error: jt('dashboard.scratchpad.actions.settingsUnavailable', 'Scratchpad settings are unavailable.') }));
      if (blocked) return blocked;
      const current = readScratchpad();
      const source = isRecord(patch) ? patch : {};
      const settings = { ...(current.settings || {}) };
      if (source.font === 'prose' || source.font === 'mono') settings.font = source.font;
      if (Number.isFinite(Number(source.rows))) settings.rows = Math.max(3, Math.min(30, Math.trunc(Number(source.rows))));
      if (Object.prototype.hasOwnProperty.call(source, 'markdown')) settings.markdown = source.markdown === true;
      const config = await writeScratchpad({ settings });
      return config ? { ok: true, settings: config.scratchpad?.settings || settings }
        : { error: jt('dashboard.scratchpad.actions.saveSettingsFailed', 'Could not save Scratchpad settings.') };
    }

    // Promotes the pad text into an active open loop (text stays in the pad —
    // promotion is non-destructive). Returns { ok } or { error }.
    async function promoteToLoop(text) {
      const fullText = String(text || '');
      const trimmed = fullText.trim();
      if (!trimmed) {
        return { error: jt('dashboard.scratchpad.actions.writeSomethingFirst', 'Write something first.') };
      }
      if (!shell?.companion?.addFollowUp) {
        return { error: jt('dashboard.scratchpad.actions.openLoopsUnavailable', 'Open loops are unavailable.') };
      }
      if (!await flushSave()) {
        return { error: jt('dashboard.scratchpad.actions.saveNoteFailed', 'Could not save the note.') };
      }
      const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
      const label = firstLine.length > MAX_LOOP_LABEL_CHARS
        ? `${firstLine.slice(0, MAX_LOOP_LABEL_CHARS - 3).trimEnd()}...`
        : firstLine;
      try {
        const payload = await shell.companion.addFollowUp({
          label,
          body: trimmed,
          sessionId: '',
          status: 'active',
          deferPreset: '',
          sourceKind: 'manual',
          sourceId: `scratchpad-${nowProvider().getTime()}`,
          sourceMeta: {},
        });
        applyCompanionPayload(payload);
        appendClientLog('INFO', 'home.scratchpad_promoted_to_loop', {
          labelLength: label.length,
          bodyLength: trimmed.length,
        });
        return { ok: true };
      } catch (error) {
        return { error: String(error?.message || error || jt('dashboard.scratchpad.actions.createOpenLoopFailed', 'Could not create the open loop.')) };
      }
    }

    // Prefill the chat composer with `text` and focus it (no auto-send). The
    // actual DOM/view work lives in the injected impl (it needs the shell's
    // setActiveView); here we just guard empty text and report reachability.
    function sendToChat(text) {
      const body = String(text || '');
      if (!body.trim()) {
        return { error: jt('dashboard.scratchpad.actions.writeSomethingFirst', 'Write something first.') };
      }
      if (typeof sendToChatImpl !== 'function') {
        return { error: jt('dashboard.scratchpad.actions.chatUnavailable', 'Chat is unavailable.') };
      }
      const ok = sendToChatImpl(body) !== false;
      if (ok) {
        appendClientLog('INFO', 'home.scratchpad_sent_to_chat', { length: body.length });
      }
      return ok ? { ok: true } : { error: jt('dashboard.scratchpad.actions.chatUnavailable', 'Chat is unavailable.') };
    }

    // True only when a workspace folder is open (so the menu can disable the
    // file-save item with a hint instead of failing after the click).
    async function canSaveFile() {
      const fsApi = shell?.workspaceFs;
      if (!fsApi?.getRootState || !fsApi?.writeFile) {
        return false;
      }
      try {
        const state = await fsApi.getRootState();
        return Boolean(state && String(state.workspaceRoot || '').trim());
      } catch (_error) {
        return false;
      }
    }

    // One-shot export of a note to `.jenny/notes/<slug>.md` (last-write-wins).
    async function saveToFile(title, text) {
      const content = String(text || '');
      if (!content.trim()) {
        return { error: jt('dashboard.scratchpad.actions.writeSomethingFirst', 'Write something first.') };
      }
      const fsApi = shell?.workspaceFs;
      if (!fsApi?.writeFile) {
        return { error: jt('dashboard.scratchpad.actions.fileSaveUnavailable', 'Saving to a file is unavailable.') };
      }
      const relPath = `${NOTES_DIR}/${slugifyTitle(title) || 'note'}.md`;
      try {
        await fsApi.writeFile({ path: relPath, content });
        appendClientLog('INFO', 'home.scratchpad_saved_to_file', { path: relPath });
        return { ok: true, path: relPath };
      } catch (error) {
        const code = String(error?.code || '');
        const message = String(error?.message || error || '');
        if (/ROOT_MISSING/i.test(code) || /workspace (folder|root)/i.test(message)) {
          return { error: jt('dashboard.scratchpad.actions.openWorkspaceToSave', 'Open a workspace folder to save to a file.') };
        }
        return { error: message || jt('dashboard.scratchpad.actions.saveFileFailed', 'Could not save the file.') };
      }
    }

    // Seed a calendar event from the note (line 1 -> title, rest -> notes),
    // all-day today; the user refines date/time in the calendar afterward.
    async function createCalendarEvent(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) {
        return { error: jt('dashboard.scratchpad.actions.writeSomethingFirst', 'Write something first.') };
      }
      if (!shell?.calendar?.createEvent) {
        return { error: jt('dashboard.scratchpad.actions.calendarUnavailable', 'Calendar is unavailable.') };
      }
      const lines = trimmed.split(/\r?\n/);
      const title = lines[0].trim().slice(0, MAX_EVENT_TITLE_CHARS) || jt('dashboard.scratchpad.actions.scratchpadNote', 'Scratchpad note');
      const notes = lines.slice(1).join('\n').trim();
      const ymd = localYmd(nowProvider());
      try {
        const snapshot = await shell.calendar.createEvent({
          title,
          start: `${ymd}T00:00`,
          end: `${ymd}T00:00`,
          allDay: true,
          categoryId: 'default',
          recurrence: 'none',
          notes,
        });
        if (snapshot) {
          onCalendarSnapshot(snapshot);
        }
        appendClientLog('INFO', 'home.scratchpad_to_calendar', { titleLength: title.length });
        return { ok: true };
      } catch (error) {
        return { error: String(error?.message || error || jt('dashboard.scratchpad.actions.createEventFailed', 'Could not create the event.')) };
      }
    }

    // Append a timestamped line ([HH:MM] <text>) to the active note and persist
    // it immediately (no debounce) — the shared entry point for the `/note`
    // slash command and the global capture hotkey, so a passing thought can be
    // saved without opening Home. The mode is options.mode (forced by a caller)
    // else the persisted settings.captureMode ('append' keeps a running log,
    // 'overwrite' replaces the note) else a safe 'append' fallback so a capture
    // never silently wipes a note. Returns { ok, noteTitle } or { error }.
    async function captureToScratchpad(text, options = {}) {
      const body = String(text || '').trim();
      if (!body) {
        return { error: jt('dashboard.scratchpad.actions.writeSomethingFirst', 'Write something first.') };
      }
      // Flush any in-flight pad edit first so the capture appends onto the
      // latest text (and the pending debounced save can't clobber it).
      const blocked = await noteWriteBlocked(() => ({ code: 'scratchpad_unavailable', ...notesUnavailable() }));
      if (blocked) return blocked;
      const current = readScratchpad();
      const note = current.notes.find((entry) => entry.id === current.activeNoteId) || current.notes[0];
      const stampLine = `[${hhmm(nowProvider())}] ${body}`;
      const existing = String(note.text || '');
      const mode = options.mode || (current.settings && current.settings.captureMode) || 'append';
      const overwrite = mode === 'overwrite';
      const nextText = overwrite || !existing.trim()
        ? stampLine
        : `${existing.replace(/\s+$/, '')}\n${stampLine}`;
      if (nextText.length > MAX_NOTE_CHARS) {
        // The schema would truncate the tail (the just-captured line); refuse
        // instead of reporting a false success while dropping the new text.
        return { code: 'note_full', error: jt('dashboard.scratchpad.actions.noteFull', 'This note is full — switch to another note.') };
      }
      const config = await persist(nextText, note.id);
      if (!config) {
        return { error: jt('dashboard.scratchpad.actions.saveNoteFailed', 'Could not save the note.') };
      }
      appendClientLog('INFO', 'home.scratchpad_capture', {
        mode: overwrite ? 'overwrite' : 'append',
        length: body.length,
      });
      return { ok: true, noteTitle: String(note.title || note.id) };
    }

    // Returns the pending flush's promise (or undefined when nothing was
    // pending) so a caller that can wait — the dashboard manager's dispose —
    // may await the last write instead of racing teardown against it.
    function dispose() {
      // Clear the timer FIRST (so it can never re-fire), then flush any pending
      // text: a renderer rebootstrap disposes programmatically WITHOUT a
      // beforeunload/visibility event, so the manager's lifecycle-flush
      // listeners don't cover it — only this flush keeps the last <600ms of
      // typing from being dropped on teardown.
      if (saveTimer) {
        clearTimeoutImpl(saveTimer);
        saveTimer = null;
      }
      if (!pending && !inFlightWrite && !inFlightSave) {
        return undefined;
      }
      return flushSave();
    }

    return {
      queueSave,
      flushSave,
      pendingDraftFor,
      addNote,
      renameNote,
      deleteNote,
      setActiveNote,
      pinNote,
      unpinNote,
      togglePin,
      updateSettings,
      promoteToLoop,
      sendToChat,
      saveToFile,
      canSaveFile,
      createCalendarEvent,
      captureToScratchpad,
      dispose,
    };
  }

  return { createScratchpadActions, isCompleteHomeConfig, jsonValuesEqual };
});
