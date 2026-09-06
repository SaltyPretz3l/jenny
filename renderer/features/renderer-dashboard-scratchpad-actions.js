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
    let pendingText = null;
    // The note a queued save targets, captured at keystroke time. Without this a
    // tab switch between queueSave and the debounce fire would write the pending
    // text into the newly-active note instead of the one being edited.
    let pendingNoteId = null;
    // The latest in-flight write promise. A fire-and-forget save (a textarea
    // focusout flush) leaves no queued text but its config echo is still settling;
    // flushSave() awaits this so a caller that serializes after it (the markdown
    // checklist toggle) reads the reconciled note, never a stale pre-echo snapshot.
    let inFlightWrite = null;

    // Resolve the current scratchpad object, tolerating a missing accessor or a
    // half-seeded state so a save never throws on a malformed snapshot.
    function readScratchpad() {
      const current = getScratchpad ? getScratchpad() : null;
      const source = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
      const notes = Array.isArray(source.notes) && source.notes.length
        ? source.notes.filter((note) => note && typeof note === 'object')
        : null;
      if (!notes || notes.length === 0) {
        return defaultScratchpad();
      }
      let activeNoteId = typeof source.activeNoteId === 'string' ? source.activeNoteId : '';
      if (!notes.some((note) => note.id === activeNoteId)) {
        activeNoteId = notes[0].id;
      }
      const settings = source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
        ? source.settings
        : undefined;
      // Pinned-note ids ride along so pin/unpin/delete can rewrite the set off
      // live state; cross-validation against surviving notes happens at each
      // call site (and again in the schema normalizer on read).
      const pins = Array.isArray(source.pins)
        ? source.pins.filter((id) => typeof id === 'string')
        : [];
      return { notes, activeNoteId, settings, pins };
    }

    function jsonValuesEqual(left, right) {
      if (left === right) return true;
      if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length
          && left.every((value, index) => jsonValuesEqual(value, right[index]));
      }
      if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
      const leftKeys = Object.keys(left);
      const rightKeys = Object.keys(right);
      return leftKeys.length === rightKeys.length
        && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
          && jsonValuesEqual(left[key], right[key]));
    }

    function scratchpadEchoMatches(requested, config, currentHome) {
      const echoed = config?.scratchpad;
      const completeHomeConfig = config
        && typeof config === 'object'
        && !Array.isArray(config)
        && Array.isArray(config.links)
        && config.weather && typeof config.weather === 'object' && !Array.isArray(config.weather)
        && config.widgets && typeof config.widgets === 'object' && !Array.isArray(config.widgets)
        && echoed && typeof echoed === 'object' && !Array.isArray(echoed)
        && Array.isArray(echoed.notes)
        && typeof echoed.activeNoteId === 'string'
        && echoed.settings && typeof echoed.settings === 'object' && !Array.isArray(echoed.settings)
        && Array.isArray(echoed.pins)
        && config.calendar && typeof config.calendar === 'object' && !Array.isArray(config.calendar)
        && typeof config.focusMode === 'boolean'
        && typeof config.showContextualTips === 'boolean';
      if (!completeHomeConfig) return false;
      if (currentHome && typeof currentHome === 'object' && !Array.isArray(currentHome)) {
        const expected = {
          ...currentHome,
          scratchpad: { ...(currentHome.scratchpad || {}), ...requested },
        };
        return jsonValuesEqual(config, expected);
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
          const currentHome = getHomeConfig?.() || null;
          const config = await shell.home.updateConfig({ scratchpad });
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
      const current = readScratchpad();
      const noteId = targetNoteId && current.notes.some((note) => note.id === targetNoteId)
        ? targetNoteId
        : current.activeNoteId;
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
    function queueSave(text, noteId) {
      pendingText = String(text);
      pendingNoteId = noteId || readScratchpad().activeNoteId;
      if (saveTimer) {
        clearTimeoutImpl(saveTimer);
      }
      saveTimer = setTimeoutImpl(() => {
        saveTimer = null;
        const toSave = pendingText;
        const target = pendingNoteId;
        pendingText = null;
        pendingNoteId = null;
        void persist(toSave, target);
      }, debounceMs);
    }

    async function flushSave() {
      if (saveTimer) {
        clearTimeoutImpl(saveTimer);
        saveTimer = null;
      }
      if (pendingText !== null) {
        const toSave = pendingText;
        const target = pendingNoteId;
        pendingText = null;
        pendingNoteId = null;
        await persist(toSave, target);
      } else if (inFlightWrite) {
        // No queued text, but a previous fire-and-forget write may still be
        // settling; await it so a caller serializing after flushSave reads the
        // reconciled config echo.
        await inFlightWrite;
      }
    }

    // Append a fresh empty note and make it active. Flushes first so the
    // outgoing note keeps its in-flight edits. Returns { ok, activeNoteId } or
    // { error }.
    async function addNote() {
      if (!shell?.home?.updateConfig) {
        return { error: 'Notes are unavailable.' };
      }
      await flushSave();
      const current = readScratchpad();
      if (current.notes.length >= MAX_NOTES) {
        return { error: `Up to ${MAX_NOTES} notes.` };
      }
      const { id, title } = nextNoteName(current.notes);
      const notes = [...current.notes, { id, title, text: '', updatedAt: '', appendLog: false }];
      const config = await writeScratchpad(withSettings({ notes, activeNoteId: id }, current));
      return config ? { ok: true, activeNoteId: id } : { error: 'Could not add a note.' };
    }

    // Change a note's title only (the id is preserved so per-note UI state and
    // the active pointer stay valid). Empty title is allowed — the schema slugs
    // its id from the existing id, and the tab strip shows a fallback label.
    async function renameNote(noteId, title) {
      if (!shell?.home?.updateConfig) {
        return { error: 'Notes are unavailable.' };
      }
      await flushSave();
      const current = readScratchpad();
      if (!current.notes.some((note) => note.id === noteId)) {
        return { error: 'Note not found.' };
      }
      const cleanTitle = String(title || '').replace(/[\r\n\0]/g, '').trim().slice(0, MAX_TITLE_CHARS);
      const notes = current.notes.map((note) => (
        note.id === noteId ? { ...note, title: cleanTitle } : note
      ));
      const config = await writeScratchpad(withSettings({ notes, activeNoteId: current.activeNoteId }, current));
      return config ? { ok: true } : { error: 'Could not rename the note.' };
    }

    // Remove a note (never the last one). If the active note is deleted, the
    // neighbor that slid into its slot becomes active (deterministic, no dangling
    // pointer). Returns the surviving active id so the widget can sync.
    async function deleteNote(noteId) {
      if (!shell?.home?.updateConfig) {
        return { error: 'Notes are unavailable.' };
      }
      await flushSave();
      const current = readScratchpad();
      if (current.notes.length <= 1) {
        return { error: 'Keep at least one note.' };
      }
      const index = current.notes.findIndex((note) => note.id === noteId);
      if (index === -1) {
        return { error: 'Note not found.' };
      }
      const notes = current.notes.filter((note) => note.id !== noteId);
      let activeNoteId = current.activeNoteId;
      if (activeNoteId === noteId) {
        activeNoteId = (notes[index] || notes[notes.length - 1]).id;
      }
      // Drop the deleted id from the pin set in the same write so the sticky
      // overlay never flashes a dangling chip (the schema would drop it on read
      // too, but stripping here keeps the in-flight echo clean).
      const survivingIds = new Set(notes.map((note) => note.id));
      const pins = (current.pins || []).filter((id) => survivingIds.has(id));
      const config = await writeScratchpad(withSettings({ notes, activeNoteId, pins }, current));
      return config ? { ok: true, activeNoteId } : { error: 'Could not delete the note.' };
    }

    // Switch the active note. Flushes any pending save FIRST so the outgoing
    // note keeps its edits, then persists a pointer-only patch (the section merge
    // keeps notes + settings).
    async function setActiveNote(noteId) {
      if (!shell?.home?.updateConfig) {
        return { error: 'Notes are unavailable.' };
      }
      await flushSave();
      const current = readScratchpad();
      if (!current.notes.some((note) => note.id === noteId)) {
        return { error: 'Note not found.' };
      }
      if (current.activeNoteId === noteId) {
        return { ok: true };
      }
      const config = await writeScratchpad({ activeNoteId: noteId });
      return config ? { ok: true } : { error: 'Could not switch notes.' };
    }

    // Pin / unpin a note onto the sticky-note overlay. Writes a pointer-only
    // { pins } patch (the section merge keeps notes + activeNoteId + settings),
    // exactly like setActiveNote's pointer patch. Flushes any pending pad save
    // first so a debounced text write can't land after this and the two writes
    // serialize cleanly. Returns { ok, pinned } or { error }; pinning an already-
    // pinned note (or unpinning an unpinned one) is an idempotent success.
    async function setPinned(noteId, shouldPin) {
      if (!shell?.home?.updateConfig) {
        return { error: 'Notes are unavailable.' };
      }
      await flushSave();
      const current = readScratchpad();
      if (!current.notes.some((note) => note.id === noteId)) {
        return { error: 'Note not found.' };
      }
      // Re-validate the live set against surviving notes before mutating it.
      const pins = (current.pins || []).filter((id) => current.notes.some((note) => note.id === id));
      const alreadyPinned = pins.includes(noteId);
      if (shouldPin === alreadyPinned) {
        return { ok: true, pinned: alreadyPinned };
      }
      let nextPins;
      if (shouldPin) {
        if (pins.length >= MAX_PINS) {
          return { error: `Up to ${MAX_PINS} pinned notes — unpin one first.` };
        }
        nextPins = [...pins, noteId];
      } else {
        nextPins = pins.filter((id) => id !== noteId);
      }
      const config = await writeScratchpad({ pins: nextPins });
      return config ? { ok: true, pinned: shouldPin } : { error: 'Could not update pins.' };
    }

    function pinNote(noteId) {
      return setPinned(noteId, true);
    }

    function unpinNote(noteId) {
      return setPinned(noteId, false);
    }

    // Toggle entry point for the tab "⋯" menu — flips the current pin state.
    function togglePin(noteId) {
      const pinned = (readScratchpad().pins || []).includes(noteId);
      return setPinned(noteId, !pinned);
    }

    // Scratchpad presentation is owned by the widget menu. Serialize it behind
    // any pending text write, preserve every note/pin, and return a structured
    // result so the menu can keep visible feedback on failure.
    async function updateSettings(patch = {}) {
      if (!shell?.home?.updateConfig) return { error: 'Scratchpad settings are unavailable.' };
      await flushSave();
      const current = readScratchpad();
      const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
      const settings = { ...(current.settings || {}) };
      if (source.font === 'prose' || source.font === 'mono') settings.font = source.font;
      if (Number.isFinite(Number(source.rows))) settings.rows = Math.max(3, Math.min(30, Math.trunc(Number(source.rows))));
      if (Object.prototype.hasOwnProperty.call(source, 'markdown')) settings.markdown = source.markdown === true;
      const config = await writeScratchpad({ settings });
      return config ? { ok: true, settings: config.scratchpad?.settings || settings }
        : { error: 'Could not save Scratchpad settings.' };
    }

    // Promotes the pad text into an active open loop (text stays in the pad —
    // promotion is non-destructive). Returns { ok } or { error }.
    async function promoteToLoop(text) {
      const fullText = String(text || '');
      const trimmed = fullText.trim();
      if (!trimmed) {
        return { error: 'Write something first.' };
      }
      if (!shell?.companion?.addFollowUp) {
        return { error: 'Open loops are unavailable.' };
      }
      await flushSave();
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
        return { error: String(error?.message || error || 'Could not create the open loop.') };
      }
    }

    // Prefill the chat composer with `text` and focus it (no auto-send). The
    // actual DOM/view work lives in the injected impl (it needs the shell's
    // setActiveView); here we just guard empty text and report reachability.
    function sendToChat(text) {
      const body = String(text || '');
      if (!body.trim()) {
        return { error: 'Write something first.' };
      }
      if (typeof sendToChatImpl !== 'function') {
        return { error: 'Chat is unavailable.' };
      }
      const ok = sendToChatImpl(body) !== false;
      if (ok) {
        appendClientLog('INFO', 'home.scratchpad_sent_to_chat', { length: body.length });
      }
      return ok ? { ok: true } : { error: 'Chat is unavailable.' };
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
        return { error: 'Write something first.' };
      }
      const fsApi = shell?.workspaceFs;
      if (!fsApi?.writeFile) {
        return { error: 'Saving to a file is unavailable.' };
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
          return { error: 'Open a workspace folder to save to a file.' };
        }
        return { error: message || 'Could not save the file.' };
      }
    }

    // Seed a calendar event from the note (line 1 -> title, rest -> notes),
    // all-day today; the user refines date/time in the calendar afterward.
    async function createCalendarEvent(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) {
        return { error: 'Write something first.' };
      }
      if (!shell?.calendar?.createEvent) {
        return { error: 'Calendar is unavailable.' };
      }
      const lines = trimmed.split(/\r?\n/);
      const title = lines[0].trim().slice(0, MAX_EVENT_TITLE_CHARS) || 'Scratchpad note';
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
        return { error: String(error?.message || error || 'Could not create the event.') };
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
        return { error: 'Write something first.' };
      }
      if (!shell?.home?.updateConfig) {
        return { error: 'Notes are unavailable.' };
      }
      // Flush any in-flight pad edit first so the capture appends onto the
      // latest text (and the pending debounced save can't clobber it).
      await flushSave();
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
        return { error: 'This note is full — switch to another note.' };
      }
      const stamp = nowProvider().toISOString();
      const nextNotes = current.notes.map((entry) => (
        entry.id === note.id ? { ...entry, text: nextText, updatedAt: stamp } : entry
      ));
      const config = await writeScratchpad(
        withSettings({ notes: nextNotes, activeNoteId: current.activeNoteId }, current),
      );
      if (!config) {
        return { error: 'Could not save the note.' };
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
      if (pendingText === null) {
        return undefined;
      }
      const toSave = pendingText;
      const target = pendingNoteId;
      pendingText = null;
      pendingNoteId = null;
      return persist(toSave, target);
    }

    return {
      queueSave,
      flushSave,
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

  return { createScratchpadActions };
});
