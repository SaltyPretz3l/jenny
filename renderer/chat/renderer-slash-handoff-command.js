/* renderer/chat/renderer-slash-handoff-command.js -- /handoff (row 60 W4): Jenny drafts a handoff note
 * from this chat off-transcript (handoff.generateNote), the user edits it in a step-modal dialog, and
 * Start creates a new chat linked to this one (sessions.create with handoffFromSessionId) and sends the
 * note as its first message. Cancel, Escape and the backdrop resolve the command as handled (no failure
 * toast). The edited note is the user's work: a chat that cannot be created reopens the editor with it,
 * a send that does not start leaves it in the new chat's composer, and a shell torn down mid-flight
 * keeps it for the new chat rather than losing it. The note text is never logged.
 * Row 73: on the primary Jenny chat the dialog first names one project (preselected from the chat
 * Jenny looked at last); the note is drafted about that project only, other work it mentions is
 * flagged, and Start opens a chat in that project on its own (never linked under the primary). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSlashHandoffCommand = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function noop() {}

  const MODAL_ID = 'handoff-note';
  const NOTE_FIELD_ID = 'handoffNoteField';
  const PROJECT_FIELD_ID = 'handoffProjectField';
  // The flagged-mention line names at most this many before "…".
  const MAX_SHOWN_MENTIONS = 3;
  // Electron clips a composer draft at 4,200 characters; the sidecar caps its note at 4,000.
  const MAX_NOTE_CHARS = 4000;
  const MAX_TITLE_CHARS = 60;
  const GOAL_LINE_RE = /^[ \t>]*(?:#{1,6}[ \t]*)?(?:[-*+][ \t]+)?(?:\d{1,2}[.):][ \t]*)?(?:\*\*|__)?[ \t]*Goal[ \t]*(?::[ \t]*)?(?:\*\*|__)?[ \t]*:?[ \t]*(.*)$/im;

  const { isPrimarySession = () => false, escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } = (root && root.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null) || {};
  const WORD_CHAR = '[\\p{L}\\p{N}_]';

  function str(value) {
    return String(value == null ? '' : value).trim();
  }

  function resolveModule(explicit, globalName, relativePath) {
    if (explicit) return explicit;
    if (root && root[globalName]) return root[globalName];
    if (typeof require === 'function') {
      try { return require(relativePath); } catch (_error) { /* unavailable in this shell */ }
    }
    return null;
  }

  /** The new chat's title: the note's Goal line when it has one, else "{project} handoff" for a
   * primary-chat handoff, else "{source} (continued)". */
  function deriveChildTitle(note, sourceTitle, options = {}) {
    const match = GOAL_LINE_RE.exec(String(note || ''));
    const goal = str(match && match[1]).replace(/\s+/g, ' ');
    if (goal && goal !== '(none)') {
      return goal.length > MAX_TITLE_CHARS ? goal.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…' : goal;
    }
    const projectName = str(options && options.projectName);
    if (projectName) return jt('chat.handoff.projectTitle', '{project} handoff', { project: projectName });
    const source = str(sourceTitle) || jt('chat.sessionMessage.untitledChat', 'Untitled chat');
    return jt('chat.handoff.childTitle', '{title} (continued)', { title: source });
  }

  /** Whole-word, case-insensitive matchers for other-work names, compiled once per list. */
  function mentionMatchers(names) {
    return (Array.isArray(names) ? names : []).map(str).filter(Boolean).map((name) => ({
      name,
      pattern: new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(name)}(?!${WORD_CHAR})`, 'iu'),
    }));
  }

  /** The names whose matcher hits `note`, in list order. */
  function findMentions(note, matchers) {
    const text = String(note || '');
    return text && Array.isArray(matchers) ? matchers.filter((m) => m.pattern.test(text)).map((m) => m.name) : [];
  }

  function failureCopy(reason) {
    if (reason === 'project_invalid') {
      return jt('chat.handoff.projectGone', 'That project is no longer there. Choose another.');
    }
    if (reason === 'primary_protected') {
      return jt('chat.handoff.primaryProtected', 'Your Jenny chat cannot hand off to a new chat; it stays one chat.');
    }
    if (reason === 'no_history') {
      return jt('chat.handoff.summaryNoHistory', 'This chat has nothing to hand off yet. Write the note yourself.');
    }
    if (reason === 'session_busy') {
      return jt('chat.handoff.summaryBusy', 'Jenny is still replying. Wait for the turn to finish, then try again.');
    }
    if (reason === 'sidecar_unavailable' || reason === 'model_unavailable') {
      return jt('chat.handoff.summaryNoModel', 'No local model is ready to draft the note. Try again once one is loaded, or write it yourself.');
    }
    return jt('chat.handoff.summaryFailed', 'The model didn’t return a note. Try again, or write it yourself.');
  }

  function createHandoffCommandHandler(deps = {}) {
    const state = deps.state && typeof deps.state === 'object' ? deps.state : {};
    const documentRef = deps.documentRef || (typeof document !== 'undefined' ? document : null);
    const stepModal = resolveModule(deps.stepModal, 'inventoryStepModal', '../inventory/step-modal');
    const textFieldModule = resolveModule(deps.textField, 'inventoryTextField', '../inventory/text-field');
    const renderSelectField = resolveModule(deps.selectField, 'inventorySelectField', '../inventory/select-field');
    // The project order every surface uses (D18); the backend's name order when it is missing.
    const projectMenu = resolveModule(deps.projectMenu, 'rendererProjectMenu', '../features/renderer-project-menu');
    // The inventory text-field module exports its render function directly.
    const renderTextField = typeof textFieldModule === 'function' ? textFieldModule
      : typeof textFieldModule?.textField === 'function' ? textFieldModule.textField : null;
    const getStartPromptSend = typeof deps.getStartPromptSend === 'function' ? deps.getStartPromptSend : () => null;
    const createSession = typeof deps.createSession === 'function' ? deps.createSession : null;
    const getHandoffApi = typeof deps.getHandoffApi === 'function' ? deps.getHandoffApi
      : () => globalThis.window?.jennyShell?.handoff || null;
    const setNotice = typeof deps.setNotice === 'function' ? deps.setNotice : noop;
    const clearComposer = typeof deps.clearComposer === 'function' ? deps.clearComposer : noop;
    const setComposerDraft = typeof deps.setComposerDraft === 'function' ? deps.setComposerDraft : noop;
    // Without a pane context every chat counts as current (the owner always provides one).
    const isSessionCurrent = typeof deps.isSessionCurrent === 'function' ? deps.isSessionCurrent : () => true;
    const getComposerController = typeof deps.getComposerController === 'function' ? deps.getComposerController : () => null;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const getOverlayManager = typeof deps.getOverlayManager === 'function' ? deps.getOverlayManager
      : () => deps.overlayManager || root?.rendererOverlayManagerController || null;

    // scope (primary chat only): { projectId, projects: [{ id, name }], mentions, suggestionTried }
    let dialog = null; // { mountRoot, lifecycle, resolve, sessionId, phase, draftToken, draftedNote, scope }
    let disposed = false; // the owning shell is gone: nothing after an await may touch the pane
    let inFlight = false; // Start accepted: the new chat is being created or the note sent

    function sessionSummary(sessionId) {
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      return sessions.find((entry) => str(entry && entry.id) === sessionId) || null;
    }

    function removeDialog() {
      const current = dialog;
      dialog = null;
      if (!current) return;
      if (current.lifecycle) current.lifecycle.dispose();
      if (current.mountRoot && current.mountRoot.parentNode) current.mountRoot.parentNode.removeChild(current.mountRoot);
      if (current.onClick && documentRef) documentRef.removeEventListener('click', current.onClick, true);
    }

    function settle(outcome) {
      const current = dialog;
      removeDialog();
      if (current && typeof current.resolve === 'function') current.resolve(outcome);
    }

    function query(selector) {
      return dialog && dialog.mountRoot ? dialog.mountRoot.querySelector(selector) : null;
    }

    function noteField() {
      return query('#' + NOTE_FIELD_ID);
    }

    function projectName(scope) {
      const project = scope && scope.projects.find((entry) => entry.id === scope.projectId);
      return project ? project.name : '';
    }

    function projectOptions(scope) {
      const options = scope.projects.map((project) => ({ value: project.id, label: project.name }));
      return scope.projectId ? options
        : [{ value: '', label: jt('chat.handoff.projectPlaceholder', 'Choose a project'), disabled: true }, ...options];
    }

    function renderProjectOptions() {
      const select = query('#' + PROJECT_FIELD_ID);
      const scope = dialog && dialog.scope;
      if (!select || !scope || typeof renderSelectField?.optionsMarkup !== 'function') return;
      select.innerHTML = renderSelectField.optionsMarkup(projectOptions(scope), scope.projectId);
      select.value = scope.projectId;
    }

    // The line under the note naming other work it mentions (primary-chat handoffs only).
    function updateMentions() {
      const line = query('[data-handoff-mentions]');
      const scope = dialog && dialog.scope;
      if (!line || !scope) return;
      const found = dialog.phase === 'drafting' ? [] : findMentions(noteField() && noteField().value, scope.mentions);
      const shown = found.slice(0, MAX_SHOWN_MENTIONS).join(', ') + (found.length > MAX_SHOWN_MENTIONS ? ', …' : '');
      line.textContent = found.length
        ? jt('chat.handoff.mentionsOther', 'This note mentions other work: {names}. Cut it if it doesn’t belong.', { names: shown })
        : '';
      line.hidden = !found.length;
    }

    function setPhase(phase, options = {}) {
      if (!dialog) return;
      dialog.phase = phase;
      const status = query('.inv-step-modal-status');
      const summary = query('.inv-step-modal-summary');
      const field = noteField();
      const start = query('[data-step-modal-action="start"]');
      const retry = query('[data-step-modal-action="retry"]');
      let statusText = '';
      let summaryText;
      const scope = dialog.scope;
      if (phase === 'choosing') {
        summaryText = options.reason === 'project_invalid' ? failureCopy(options.reason)
          : jt('chat.handoff.summaryChooseProject', 'Choose the project this note is about. Jenny writes about that project only; read the note before you start.');
      } else if (phase === 'drafting') {
        statusText = jt('chat.handoff.statusDrafting', 'Drafting…');
        summaryText = scope
          ? jt('chat.handoff.summaryDraftingProject', 'Jenny is writing a note about {project} only: the goal, what is done, the files, what is open and the next step.', { project: projectName(scope) })
          : jt('chat.handoff.summaryDrafting', 'Jenny is writing a note from this chat: the goal, what is done, the files, what is open and the next step.');
      } else if (phase === 'ready') {
        summaryText = scope
          ? jt('chat.handoff.summaryReadyProject', 'Edit the note if you like. It becomes the first message of a new chat in {project}.', { project: projectName(scope) })
          : jt('chat.handoff.summaryReady', 'Edit the note if you like. It becomes the first message of a new chat linked to this one.');
        if (options.transcriptTruncated) {
          summaryText += ' ' + jt('chat.handoff.summaryTruncated', 'Only the most recent part of this chat fit the model, so the note may miss earlier work.');
        }
      } else {
        statusText = jt('chat.handoff.statusFailed', 'Couldn’t draft');
        summaryText = failureCopy(options.reason);
      }
      if (status) {
        status.textContent = statusText;
        status.hidden = !statusText;
      }
      if (summary) summary.textContent = summaryText;
      if (field) {
        field.disabled = phase === 'drafting' || phase === 'choosing';
        if (phase === 'ready') {
          field.value = String(options.note || '');
          dialog.draftedNote = str(field.value);
        }
        if (phase === 'drafting' || phase === 'choosing') field.value = '';
        field.placeholder = phase === 'failed' ? jt('chat.handoff.notePlaceholder', 'What should the new chat know to keep going?') : '';
      }
      if (retry) retry.hidden = phase !== 'failed';
      if (start) start.disabled = !canStart();
      const select = query('#' + PROJECT_FIELD_ID);
      if (select) select.disabled = phase === 'drafting';
      updateMentions();
      if (phase === 'choosing' && select && typeof select.focus === 'function') {
        try { select.focus({ preventScroll: true }); } catch (_error) { /* focus is best effort */ }
      } else if (phase !== 'drafting' && field && typeof field.focus === 'function') {
        try { field.focus({ preventScroll: true }); } catch (_error) { /* focus is best effort */ }
      }
    }

    function canStart() {
      if (!dialog || dialog.phase === 'drafting' || dialog.phase === 'choosing') return false;
      if (dialog.scope && !dialog.scope.projectId) return false;
      return Boolean(str(noteField() && noteField().value));
    }

    // A scope reply (no or an unknown project): take the list, try the suggestion once, else ask.
    function applyScopeReply(current, result) {
      const scope = current.scope;
      scope.projects = (Array.isArray(result.projects) ? result.projects : [])
        .filter((entry) => entry && str(entry.id) && str(entry.name))
        .map((entry) => ({ id: str(entry.id), name: str(entry.name) }));
      if (typeof projectMenu?.orderProjects === 'function') {
        scope.projects = projectMenu.orderProjects(scope.projects, { sessions: state.sessions });
      }
      const suggested = str(result.suggestedProjectId);
      const useSuggestion = result.reason === 'project_required' && !scope.suggestionTried
        && scope.projects.some((entry) => entry.id === suggested);
      scope.suggestionTried = true;
      scope.projectId = useSuggestion ? suggested : '';
      renderProjectOptions();
      if (useSuggestion) return true;
      setPhase('choosing', { reason: result.reason });
      return false;
    }

    async function draft() {
      if (!dialog) return;
      const current = dialog;
      const token = ++current.draftToken;
      setPhase(current.scope && !current.scope.projectId && current.scope.projects.length ? 'choosing' : 'drafting');
      if (current.phase === 'choosing') return;
      let result;
      try {
        const api = getHandoffApi();
        const options = current.scope ? { projectId: current.scope.projectId } : undefined;
        result = typeof api?.generateNote === 'function' ? await api.generateNote(current.sessionId, options) : { ok: false, reason: 'unavailable' };
      } catch (error) {
        result = { ok: false, reason: 'request_failed', detail: str(error && error.message).slice(0, 120) };
      }
      if (dialog !== current || token !== current.draftToken) return; // closed or re-drafted meanwhile
      if (current.scope && result && (result.reason === 'project_required' || result.reason === 'project_invalid')) {
        appendClientLog('INFO', 'slash.handoff_scope', { sessionId: current.sessionId, reason: result.reason, suggested: Boolean(result.suggestedProjectId) });
        if (applyScopeReply(current, result)) void draft();
        return;
      }
      if (current.scope && result && result.ok === true) {
        current.scope.mentions = mentionMatchers(result.otherNames);
      }
      if (result && result.ok === true && str(result.note)) {
        appendClientLog('INFO', 'slash.handoff_drafted', { sessionId: current.sessionId, noteChars: str(result.note).length, truncated: result.transcriptTruncated === true });
        setPhase('ready', { note: str(result.note).slice(0, MAX_NOTE_CHARS), transcriptTruncated: result.transcriptTruncated === true });
        return;
      }
      const reason = str(result && result.reason) || 'generate_failed';
      appendClientLog('WARN', 'slash.handoff_draft_failed', { sessionId: current.sessionId, reason: reason.slice(0, 64) });
      setPhase('failed', { reason });
    }

    function projectFieldHtml(scope) {
      return renderSelectField({
        id: PROJECT_FIELD_ID,
        label: jt('chat.handoff.projectLabel', 'Project'),
        value: scope.projectId,
        options: projectOptions(scope),
        disabled: true,
        className: 'handoff-project-field',
      });
    }

    function openDialog(sessionId, initialNote, scope = null) {
      if (!documentRef || !documentRef.body || !stepModal || typeof stepModal.renderStepModal !== 'function' || !renderTextField
        || (scope && typeof renderSelectField !== 'function')) {
        return null;
      }
      removeDialog();
      const html = stepModal.renderStepModal({
        id: MODAL_ID,
        tone: 'default',
        title: jt('chat.handoff.title', 'Continue in a new chat'),
        status: jt('chat.handoff.statusDrafting', 'Drafting…'),
        summary: jt('chat.handoff.summaryDrafting', 'Jenny is writing a note from this chat: the goal, what is done, the files, what is open and the next step.'),
        bodyHtml: (scope ? projectFieldHtml(scope) : '') + renderTextField({
          id: NOTE_FIELD_ID,
          multiline: true,
          rows: 12,
          spellcheck: true,
          disabled: true,
          maxLength: MAX_NOTE_CHARS,
          ariaLabel: jt('chat.handoff.noteLabel', 'Handoff note'),
          className: 'handoff-note-field',
        }) + (scope ? '<p class="inv-text-field-hint handoff-note-mentions" data-handoff-mentions role="status" hidden></p>' : ''),
        actions: [
          { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary' },
          { id: 'retry', label: jt('chat.handoff.retry', 'Try again'), variant: 'secondary' },
          { id: 'start', label: jt('chat.handoff.start', 'Start new chat'), variant: 'primary', disabled: true },
        ],
      });
      documentRef.body.insertAdjacentHTML('beforeend', html);
      const mountRoot = documentRef.querySelector('[data-step-modal="' + MODAL_ID + '"]');
      if (!mountRoot) return null;
      let resolve = null;
      const settled = new Promise((done) => { resolve = done; });
      const onClick = (event) => {
        const target = event && event.target;
        if (!target || typeof target.closest !== 'function' || !dialog || !dialog.mountRoot.contains(target)) return;
        const actionEl = target.closest('[data-step-modal-action]');
        if (actionEl) {
          const action = actionEl.getAttribute('data-step-modal-action');
          if (action === 'cancel') settle({ action: 'cancel' });
          else if (action === 'retry') void draft();
          else if (action === 'start' && canStart()) settle({ action: 'start', note: str(noteField() && noteField().value).slice(0, MAX_NOTE_CHARS) });
          return;
        }
        if (target === dialog.mountRoot) settle({ action: 'cancel' }); // backdrop
      };
      const onInput = () => {
        if (!dialog || dialog.phase === 'drafting') return;
        const start = query('[data-step-modal-action="start"]');
        if (start) start.disabled = !canStart();
        updateMentions();
      };
      const onProjectChange = (event) => {
        if (!dialog || !dialog.scope || dialog.phase === 'drafting') return;
        const value = str(event && event.target && event.target.value);
        if (!value || value === dialog.scope.projectId) return;
        // A note the person wrote or changed stays with its project: a switch would redraft over it.
        const note = str(noteField() && noteField().value);
        if (note && note !== dialog.draftedNote) {
          renderProjectOptions();
          const summary = query('.inv-step-modal-summary');
          if (summary) {
            summary.textContent = jt('chat.handoff.projectKeepsEdits', 'You changed this note, so it stays with {project}. Clear the note to choose another project.', { project: projectName(dialog.scope) });
          }
          return;
        }
        dialog.scope.projectId = value;
        dialog.scope.mentions = []; // the old project's list would flag the new one
        renderProjectOptions();
        void draft();
      };
      dialog = { mountRoot, lifecycle: null, resolve, sessionId, phase: 'drafting', draftToken: 0, draftedNote: '', onClick, scope };
      documentRef.addEventListener('click', onClick, true);
      const field = noteField();
      if (field) field.addEventListener('input', onInput);
      const projectSelect = query('#' + PROJECT_FIELD_ID);
      if (projectSelect) projectSelect.addEventListener('change', onProjectChange);
      if (typeof stepModal.createLifecycle === 'function') {
        dialog.lifecycle = stepModal.createLifecycle({
          documentRef,
          mountRoot,
          getOverlayManager,
          inertTargets: () => {
            const appShell = documentRef.getElementById('appShell');
            return appShell ? [appShell] : [];
          },
          appendClientLog,
        });
        dialog.lifecycle.open({ id: MODAL_ID, onRequestClose: () => settle({ action: 'cancel' }), initialFocusSelector: '[data-step-modal-action="cancel"]' });
      }
      const retry = query('[data-step-modal-action="retry"]');
      if (retry) retry.hidden = true;
      // Reopened after a failed Start: the user's edited note comes back instead of a fresh draft.
      if (str(initialNote)) {
        setPhase('ready', { note: str(initialNote).slice(0, MAX_NOTE_CHARS) });
        dialog.draftedNote = ''; // the person's own edits: a project switch must not redraft over them
      } else {
        void draft();
      }
      return settled;
    }

    // The note could not be sent: keep it where the new chat will show it. The visible input only
    // while the new chat holds the pane; otherwise that chat's own composer record, which restores
    // when it is shown, never the input of whichever chat is visible now. False when nothing can
    // hold it, so the notice says so instead of promising it.
    function keepNoteForChild(note, childId, reason) {
      let kept = false;
      if (isSessionCurrent(childId)) {
        kept = setComposerDraft(note, childId) !== false;
      } else {
        const composer = getComposerController();
        if (composer && typeof composer.capturePaneDraft === 'function') {
          composer.capturePaneDraft(childId, { value: note, selectionStart: note.length, selectionEnd: note.length });
          kept = true;
        }
      }
      appendClientLog('WARN', 'slash.handoff_send_not_started', { sessionId: childId, reason, kept });
      return kept;
    }

    async function startChat(sourceSessionId, note, scope = null) {
      const source = sessionSummary(sourceSessionId);
      const title = deriveChildTitle(note, source && source.title, scope ? { projectName: projectName(scope) } : {});
      // A primary-chat handoff opens in the chosen project on its own: no link to the primary.
      const projectId = scope ? scope.projectId : str(source && source.project_id);
      // The source composer still shows "/handoff"; the slash dispatch only clears it while the
      // source is current, and the new chat is about to be.
      clearComposer();
      let childId = '';
      try {
        childId = str(await createSession({
          title,
          ...(scope ? {} : { handoffFromSessionId: sourceSessionId }),
          ...(projectId ? { projectId } : {}),
        }));
      } catch (error) {
        appendClientLog('WARN', 'slash.handoff_create_failed', { sessionId: sourceSessionId, message: str(error && error.message).slice(0, 200) });
      }
      if (disposed) {
        // The shell went away while the chat was being created: no pane to notify, but a created
        // chat keeps the note in its own composer record.
        if (childId) keepNoteForChild(note, childId, 'disposed');
        appendClientLog('INFO', 'slash.handoff_abandoned', { sessionId: sourceSessionId, stage: 'create', created: Boolean(childId) });
        return { ok: false, handled: true, code: 'disposed' };
      }
      if (!childId) {
        setNotice(jt('chat.handoff.createFailed', 'The new chat could not be created.'), 'warning');
        return { ok: false, handled: true, code: 'create_failed' };
      }
      const startPromptSend = getStartPromptSend();
      let result = null;
      if (typeof startPromptSend === 'function') {
        try {
          result = await startPromptSend(note, { sessionIdOverride: childId, preserveComposerDraft: true });
        } catch (error) {
          appendClientLog('WARN', 'slash.handoff_send_threw', { sessionId: childId, message: str(error && error.message).slice(0, 200) });
          result = null;
        }
      }
      const started = Boolean(result) && result.rejected !== true && result.failed !== true;
      if (disposed) {
        if (!started) keepNoteForChild(note, childId, 'disposed');
        appendClientLog('INFO', 'slash.handoff_abandoned', { sessionId: sourceSessionId, stage: 'send', started });
        return { ok: false, handled: true, code: 'disposed' };
      }
      if (!started) {
        const kept = keepNoteForChild(note, childId, str(result && result.reason).slice(0, 64) || 'not_started');
        setNotice(kept
          ? jt('chat.handoff.sendFailed', 'The note could not be sent. It is in the composer of the new chat.')
          : jt('chat.handoff.sendFailedLost', 'The note could not be sent.'), 'warning');
        return { ok: false, handled: true, code: 'send_not_started' };
      }
      appendClientLog('INFO', 'slash.handoff_started', { sourceSessionId, sessionId: childId, noteChars: note.length, scoped: Boolean(scope) });
      return { ok: true, code: 'handoff_started' };
    }

    async function handleHandoffCommand(invocation) {
      const sessionId = str(invocation && invocation.sessionId);
      if (!sessionId || !createSession || typeof getHandoffApi()?.generateNote !== 'function') {
        setNotice(jt('chat.handoff.unavailable', 'Handoff is not available here.'), 'warning');
        return { ok: false, handled: true, code: 'handoff_unavailable' };
      }
      if (disposed) return { ok: false, handled: true, code: 'disposed' };
      if (dialog || inFlight) return { ok: false, handled: true, code: 'busy' };
      // The primary Jenny chat (row 69) hands off one project at a time (row 73).
      const scope = isPrimarySession(sessionSummary(sessionId))
        ? { projectId: '', projects: [], mentions: [], suggestionTried: false }
        : null;
      let initialNote = '';
      for (;;) {
        const settled = openDialog(sessionId, initialNote, scope);
        if (!settled) {
          setNotice(jt('chat.handoff.unavailable', 'Handoff is not available here.'), 'warning');
          return { ok: false, handled: true, code: 'dialog_unavailable' };
        }
        const outcome = await settled;
        if (!outcome || outcome.action !== 'start' || !str(outcome.note)) {
          appendClientLog('INFO', 'slash.handoff_cancelled', { sessionId });
          return { ok: false, handled: true, code: 'cancelled' };
        }
        const note = str(outcome.note);
        inFlight = true;
        let result;
        try {
          result = await startChat(sessionId, note, scope);
        } finally {
          inFlight = false;
        }
        // The chat could not be created: the editor comes back with the note so it is not lost.
        if (result.code === 'create_failed' && !disposed) {
          initialNote = note;
          continue;
        }
        return result;
      }
    }

    handleHandoffCommand.dispose = function dispose() {
      disposed = true;
      settle({ action: 'cancel' });
    };
    handleHandoffCommand.isOpen = function isOpen() {
      return Boolean(dialog);
    };
    return handleHandoffCommand;
  }

  return { MODAL_ID, NOTE_FIELD_ID, PROJECT_FIELD_ID, MAX_NOTE_CHARS, createHandoffCommandHandler, deriveChildTitle, findMentions, mentionMatchers };
});
