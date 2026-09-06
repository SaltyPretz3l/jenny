/**
 * renderer/features/renderer-personality-utils.js
 *
 * Settings ▸ Personality and Settings ▸ Memory ▸ Long-term notes controllers.
 *
 * One draft object, one Save action, and one personality.getState() IPC round
 * trip per refresh.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./personality-form'),
      require('./renderer-personality-counters'),
      require('../inventory/action-button'),
      require('../inventory/collapsible'),
      require('./renderer-memory-notes-utils'),
      require('../shared/async-fence')
    );
    return;
  }
  root.rendererPersonalityUtils = factory(
    root.personalityForm,
    root.rendererPersonalityCounters,
    root.inventoryActionButton,
    root.inventoryCollapsible,
    root.rendererMemoryNotesUtils,
    root.rendererAsyncFence
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  personalityForm,
  counters,
  actionButtonModule,
  collapsibleModule,
  memoryNotes,
  asyncFence
) {
  'use strict';

  var actionButton = typeof actionButtonModule === 'function'
    ? actionButtonModule
    : (actionButtonModule && actionButtonModule.actionButton) || null;
  var collapsible = collapsibleModule || null;

  var SETTINGS_PREFIX = 'settings-personality';
  var EXACT_PANEL_ID = 'personalityExactText';

  function toMessage(error, fallback) {
    var text = error && error.message ? String(error.message) : String(error || '');
    return text.trim() || String(fallback || 'Something went wrong.');
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  /* Fallback escaper. This module writes preset labels into innerHTML, so the
     fallback has to actually escape -- an identity function here would be a
     silent injection hole whenever the host forgets to pass escapeHtml. */
  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function createPersonalityEditor(deps) {
    var d = deps || {};
    var state = d.state;
    var dom = d.dom || {};
    var callbacks = d.callbacks || {};
    var windowRef = d.windowRef || (typeof window !== 'undefined' ? window : null);
    var escapeHtml = typeof callbacks.escapeHtml === 'function'
      ? callbacks.escapeHtml
      : defaultEscapeHtml;
    var nowFn = typeof d.now === 'function' ? d.now : function () { return Date.now(); };

    var personalityState = state && state.personality ? state.personality : {};
    var formRendered = false;
    var disposalFence = asyncFence.createDisposalFence();
    var draftGate = asyncFence.createGenerationGate();

    function shell() {
      var api = windowRef && windowRef.jennyShell ? windowRef.jennyShell : null;
      return api && api.personality ? api.personality : null;
    }

    function budgets() {
      var configured = personalityState.budgets && typeof personalityState.budgets === 'object'
        ? personalityState.budgets
        : {};
      return {
        personality: Number(configured.personality) || personalityForm.BUDGETS.personality,
        user: Number(configured.user) || personalityForm.BUDGETS.user,
        memory: Number(configured.memory) || personalityForm.BUDGETS.memory,
      };
    }

    function draft() {
      return personalityForm.normalize({
        agentName: personalityState.agentName,
        personality: personalityState.personality,
        user: personalityState.user,
      });
    }

    function markDirty() {
      var saved = personalityState.saved || {};
      var current = draft();
      personalityState.dirty = current.agentName !== String(saved.agentName || '')
        || current.personality !== String(saved.personality || '')
        || current.user !== String(saved.user || '');
      draftGate.bump();
    }

    function draftsMatch(left, right) {
      return left.agentName === right.agentName
        && left.personality === right.personality
        && left.user === right.user;
    }

    function fieldEl(suffix) {
      var host = dom.personalityFormHost;
      if (!host || typeof host.querySelector !== 'function') return null;
      return host.querySelector('#' + personalityForm.fieldId(SETTINGS_PREFIX, suffix));
    }

    /* The segmented control carries its id as data-inv-segmented, not as a DOM
       id, so it is not reachable through fieldEl(). */
    function voiceGroupEl() {
      var host = dom.personalityFormHost;
      if (!host || typeof host.querySelector !== 'function') return null;
      return host.querySelector('[data-inv-segmented="'
        + personalityForm.fieldId(SETTINGS_PREFIX, 'voice') + '"]');
    }

    function metaEl(suffix, kind) {
      var host = dom.personalityFormHost;
      if (!host || typeof host.querySelector !== 'function') return null;
      return host.querySelector('#' + personalityForm.fieldId(SETTINGS_PREFIX, suffix) + '-' + kind);
    }

    /** Which files the service reports as too large to write from here. */
    function oversizedFiles() {
      var files = personalityState.files && typeof personalityState.files === 'object'
        ? personalityState.files
        : {};
      return {
        personality: Boolean(files.personality && files.personality.oversized),
        user: Boolean(files.user && files.user.oversized),
      };
    }

    function hasOversizedFile() {
      var flags = oversizedFiles();
      return flags.personality || flags.user;
    }

    /* ── Render ─────────────────────────────────────────────────────────── */

    /*
     * Signature memo: renderActions() runs on every keystroke through
     * renderMeta(), and an innerHTML rebuild there would discard focus and
     * churn three buttons per character typed. Only rebuild when something a
     * button actually shows has changed.
     */
    var actionsSignature = '';

    function renderActions() {
      if (!dom.personalityActions || !actionButton) return;
      var busy = personalityState.saving === true || personalityState.loading === true;
      var saveDisabled = busy || personalityState.dirty !== true || hasOversizedFile();
      var signature = [
        personalityState.loading === true ? '1' : '0',
        busy ? '1' : '0',
        saveDisabled ? '1' : '0',
        personalityState.saving === true ? '1' : '0',
      ].join('|');
      if (signature === actionsSignature) return;
      actionsSignature = signature;
      dom.personalityActions.innerHTML = ''
        + actionButton({
          id: 'personality-open-folder',
          label: 'Open folder',
          variant: 'ghost',
          disabled: personalityState.loading === true,
        })
        + actionButton({
          id: 'personality-clear',
          label: 'Clear',
          variant: 'secondary',
          disabled: busy,
        })
        + actionButton({
          id: 'personality-save',
          label: personalityState.saving === true ? 'Saving…' : 'Save',
          variant: 'primary',
          disabled: saveDisabled,
        });
    }

    function renderExactText() {
      if (!collapsible || !dom.personalityExactHost || !dom.personalityExactPanelHost) return;
      dom.personalityExactHost.innerHTML = collapsible.trigger({
        id: EXACT_PANEL_ID,
        open: false,
        className: 'personality-exact-trigger',
        children: '<span>Show exact text</span>',
      });
      dom.personalityExactPanelHost.innerHTML = collapsible.content({
        id: EXACT_PANEL_ID,
        open: false,
        className: 'personality-exact-panel',
        children: '<pre class="personality-exact" id="personalityExactPre"></pre>',
      });
    }

    function renderForm() {
      if (!dom.personalityFormHost || !personalityForm) return;
      dom.personalityFormHost.innerHTML = personalityForm.render(draft(), {
        idPrefix: SETTINGS_PREFIX,
        disabled: personalityState.loading === true,
        oversized: oversizedFiles(),
      });
      formRendered = true;
      actionsSignature = '';
      renderExactText();
    }

    function compiledPreview() {
      var current = draft();
      return counters.resolveCompiledPreview({
        compiled: personalityState.compiled,
        dirty: personalityState.dirty,
        budgets: budgets(),
        bodies: {
          agentName: current.agentName,
          personality: current.personality,
          user: current.user,
          memory: personalityState.notesBody || '',
        },
      });
    }

    function renderCounter(suffix, value, budget) {
      var node = metaEl(suffix, 'counter');
      if (!node) return;
      var model = counters.buildCounterModel(value, budget);
      setText(node, model.text);
      if (node.classList) node.classList.toggle('personality-counter--over', model.over);
    }

    function renderLint(suffix, value, oversized) {
      var node = metaEl(suffix, 'lint');
      if (!node) return;
      // The oversized notice outranks the placeholder lint: it is the reason
      // the field is read-only, and renderMeta runs after every render.
      var message = oversized ? counters.OVERSIZED_MESSAGE : counters.buildLintMessage(value);
      setText(node, message);
      setHidden(node, !message);
    }

    function renderMeta() {
      var caps = budgets();
      var current = draft();
      renderCounter('note', current.personality, caps.personality);
      renderCounter('user', current.user, caps.user);
      var oversized = oversizedFiles();
      renderLint('note', current.personality, oversized.personality);
      renderLint('user', current.user, oversized.user);

      var voice = personalityForm.deriveVoice(current.personality);
      var voiceHint = metaEl('voice', 'hint');
      setText(voiceHint, voice === personalityForm.CUSTOM_VOICE
        ? personalityForm.COPY.voiceCustomHint
        : personalityForm.COPY.voiceHint);
      // The derived voice is part of the group's name, so a screen reader hears
      // "currently custom" instead of a radiogroup with nothing checked.
      var voiceGroup = voiceGroupEl();
      if (voiceGroup) voiceGroup.setAttribute('aria-label', personalityForm.voiceAriaLabel(voice));

      var compiled = compiledPreview();
      setText(dom.personalityTokenLine, counters.buildTokenLine(compiled.tokens));
      var exactPre = dom.personalityExactPanelHost
        && typeof dom.personalityExactPanelHost.querySelector === 'function'
        ? dom.personalityExactPanelHost.querySelector('#personalityExactPre')
        : null;
      setText(exactPre, compiled.text);

      setText(dom.personalityStatus, counters.buildPersonalityStatusLine({
        loading: personalityState.loading === true,
        dirty: personalityState.dirty === true,
        actionStatus: personalityState.actionStatus,
        loadStatus: personalityState.loadStatus,
        savedAt: personalityState.savedAt,
        now: nowFn(),
      }));
      renderActions();
    }

    /* ── Self-installed handlers ────────────────────────────────────────── */

    /*
     * The controller owns its hosts, so it binds the field-level events itself
     * rather than threading four more callbacks through the shell registry.
     * Delegated on the stable hosts, which survive the innerHTML swaps.
     */
    var handlersInstalled = false;
    var boundHandlers = [];

    function on(node, type, handler) {
      if (!node || typeof node.addEventListener !== 'function') return;
      node.addEventListener(type, handler);
      boundHandlers.push([node, type, handler]);
    }

    function toggleExactPanel(nextOpen) {
      var trigger = dom.personalityExactHost
        && typeof dom.personalityExactHost.querySelector === 'function'
        ? dom.personalityExactHost.querySelector('[data-inv-collapsible]')
        : null;
      var panel = dom.personalityExactPanelHost
        && typeof dom.personalityExactPanelHost.querySelector === 'function'
        ? dom.personalityExactPanelHost.querySelector('#' + EXACT_PANEL_ID)
        : null;
      if (!trigger || !panel) return;
      var open = typeof nextOpen === 'boolean'
        ? nextOpen
        : trigger.getAttribute('aria-expanded') !== 'true';
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.setAttribute('data-state', open ? 'open' : 'closed');
      if (panel.classList) panel.classList.toggle('expanded', open);
      setHidden(panel, !open);
    }

    function installHandlers() {
      if (handlersInstalled) return;
      handlersInstalled = true;
      on(dom.personalityFormHost, 'input', function () { captureDraft(); });
      on(dom.personalityFormHost, 'inv-segmented-change', function (event) {
        var detail = (event && event.detail) || {};
        handleVoiceChange(detail.value);
      });
      on(dom.personalityFormHost, 'click', function (event) {
        var target = event && event.target;
        if (!target || typeof target.closest !== 'function') return;
        if (target.closest('[data-action="personality-preset-replace"]')) {
          confirmPresetReplace();
          return;
        }
        if (target.closest('[data-action="personality-preset-keep"]')) cancelPresetReplace();
      });
      on(dom.personalityExactHost, 'click', function (event) {
        var target = event && event.target;
        if (target && typeof target.closest === 'function' && target.closest('[data-inv-collapsible]')) {
          toggleExactPanel();
        }
      });
      on(dom.personalityExactHost, 'keydown', function (event) {
        if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;
        var target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        if (!target.closest('[data-inv-collapsible]')) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        toggleExactPanel();
      });
    }

    function renderPersonalityEditor() {
      if (!dom.personalityFormHost) return;
      if (!formRendered) renderForm();
      installHandlers();
      renderMeta();
    }

    /* ── Draft capture ──────────────────────────────────────────────────── */

    function captureDraft() {
      if (!dom.personalityFormHost) return;
      var next = personalityForm.read(dom.personalityFormHost, {
        idPrefix: SETTINGS_PREFIX,
        fallback: draft(),
      });
      personalityState.agentName = next.agentName;
      personalityState.personality = next.personality;
      personalityState.user = next.user;
      personalityState.actionStatus = '';
      markDirty();
      renderMeta();
    }

    /*
     * Voice preset interaction lives with the form that owns the DOM it edits.
     * A preset pick fills the note; only text the owner actually wrote (a
     * derived-custom note) is worth an inline Replace/Keep confirm.
     */
    var presets = personalityForm.createPresetController({
      actionButton: actionButton,
      escapeHtml: escapeHtml,
      fieldEl: fieldEl,
      metaEl: metaEl,
      voiceGroupEl: voiceGroupEl,
      getNote: function () { return draft().personality; },
      setNote: function (sentence) {
        personalityState.personality = sentence;
        personalityState.actionStatus = '';
        markDirty();
      },
      afterChange: function () { renderMeta(); },
    });
    var clearPresetPrompt = presets.clearPrompt;
    var handleVoiceChange = presets.handleVoiceChange;
    var confirmPresetReplace = presets.confirmReplace;
    var cancelPresetReplace = presets.cancelReplace;

    /* ── IPC ────────────────────────────────────────────────────────────── */

    function adoptState(snapshot) {
      var payload = snapshot && typeof snapshot === 'object' ? snapshot : {};
      var normalized = personalityForm.normalize(payload);
      personalityState.agentName = normalized.agentName;
      personalityState.personality = normalized.personality;
      personalityState.user = normalized.user;
      personalityState.saved = {
        agentName: normalized.agentName,
        personality: normalized.personality,
        user: normalized.user,
      };
      if (payload.budgets && typeof payload.budgets === 'object') {
        personalityState.budgets = payload.budgets;
      }
      personalityState.files = payload.files && typeof payload.files === 'object' ? payload.files : {};
      var compiled = payload.compiled && typeof payload.compiled === 'object' ? payload.compiled : {};
      personalityState.compiled = compiled;
      // The Notes body lives under Memory, not here; recover it from the
      // compiled block so the live preview stays exact while the Personality
      // drafts change, without a second IPC call.
      personalityState.notesBody = counters.splitNotesBody(compiled.text);
      personalityState.schemaVersion = Number(payload.schemaVersion || 0);
      personalityState.dirty = false;
      draftGate.bump();
    }

    async function refreshPersonalityWorkspace() {
      if (disposalFence.isDisposed()) return;
      var api = shell();
      if (!api || typeof api.getState !== 'function') {
        personalityState.loadStatus = 'Personality settings are unavailable.';
        renderPersonalityEditor();
        return;
      }
      if (personalityState.dirty === true) {
        // Never clobber unsaved edits with a background refresh.
        renderPersonalityEditor();
        return;
      }
      personalityState.loading = true;
      personalityState.loadStatus = '';
      renderPersonalityEditor();
      var refreshToken = draftGate.capture();
      var refreshDraft = draft();
      try {
        var snapshot = await api.getState();
        if (disposalFence.isDisposed()
          || !draftGate.isCurrent(refreshToken)
          || !draftsMatch(draft(), refreshDraft)) return;
        adoptState(snapshot);
        personalityState.loadStatus = '';
        formRendered = false;
      } catch (error) {
        if (disposalFence.isDisposed()) return;
        personalityState.loadStatus = 'Unable to load personality: ' + toMessage(error, 'unknown error');
      } finally {
        if (!disposalFence.isDisposed()) {
          personalityState.loading = false;
          renderForm();
          renderMeta();
        }
      }
    }

    async function handlePersonalitySave() {
      if (disposalFence.isDisposed()) return;
      var api = shell();
      if (!api || typeof api.save !== 'function') {
        personalityState.actionStatus = 'Saving personality is unavailable.';
        renderMeta();
        return;
      }
      captureDraft();
      var payload = draft();
      personalityState.saving = true;
      personalityState.actionStatus = 'Saving…';
      renderMeta();
      try {
        var result = await api.save(payload);
        if (disposalFence.isDisposed()) return;
        if (result && result.compiled && typeof result.compiled === 'object') {
          personalityState.compiled = result.compiled;
          personalityState.notesBody = counters.splitNotesBody(result.compiled.text);
        }
        if (!result || result.ok !== true) {
          var failed = Array.isArray(result && result.failed) ? result.failed : [];
          // A name-only failure still wrote both files: keep them saved, put the
          // stored name back in the field, and say which half did not land.
          if (failed.length === 1 && failed[0] === 'agentName') {
            var storedName = String((result && result.agentName) || payload.agentName);
            personalityState.saved = {
              agentName: storedName,
              personality: payload.personality,
              user: payload.user,
            };
            if (personalityState.agentName === payload.agentName) personalityState.agentName = storedName;
            markDirty();
            personalityState.savedAt = nowFn();
            personalityState.actionStatus = 'Name could not be saved; note saved.';
            renderForm();
            return;
          }
          personalityState.actionStatus = counters.buildSaveFailureMessage(result, 'Save');
          return;
        }
        personalityState.saved = {
          agentName: String(result.agentName || payload.agentName),
          personality: payload.personality,
          user: payload.user,
        };
        if (personalityState.agentName === payload.agentName) {
          personalityState.agentName = personalityState.saved.agentName;
        }
        markDirty();
        personalityState.savedAt = nowFn();
        personalityState.actionStatus = '';
        if (typeof d.renderSettings === 'function') d.renderSettings();
      } catch (error) {
        if (disposalFence.isDisposed()) return;
        personalityState.actionStatus = 'Save failed: ' + toMessage(error, 'unknown error');
      } finally {
        if (!disposalFence.isDisposed()) {
          personalityState.saving = false;
          renderMeta();
        }
      }
    }

    /** Clear = replace both personality files with their placeholders. */
    async function handlePersonalityReset() {
      var api = shell();
      if (!api || typeof api.clear !== 'function') {
        personalityState.actionStatus = 'Clearing personality is unavailable.';
        renderMeta();
        return;
      }
      personalityState.saving = true;
      personalityState.actionStatus = 'Clearing…';
      renderMeta();
      try {
        var result = await api.clear({ agentName: personalityState.agentName });
        if (!result || result.ok !== true) {
          personalityState.actionStatus = counters.buildSaveFailureMessage(result, 'Clear');
          return;
        }
        personalityState.personality = '';
        personalityState.user = '';
        personalityState.saved = {
          agentName: personalityState.agentName,
          personality: '',
          user: '',
        };
        if (result.compiled && typeof result.compiled === 'object') {
          personalityState.compiled = result.compiled;
          personalityState.notesBody = counters.splitNotesBody(result.compiled.text);
        }
        personalityState.dirty = false;
        personalityState.savedAt = nowFn();
        personalityState.actionStatus = '';
        clearPresetPrompt();
        renderForm();
      } catch (error) {
        personalityState.actionStatus = 'Clear failed: ' + toMessage(error, 'unknown error');
      } finally {
        personalityState.saving = false;
        renderMeta();
      }
    }

    async function handlePersonalityOpenFolder() {
      var api = shell();
      if (!api || typeof api.openWorkspaceFolder !== 'function') {
        personalityState.actionStatus = 'Opening the personality folder is unavailable.';
        renderMeta();
        return;
      }
      try {
        var result = await api.openWorkspaceFolder();
        personalityState.actionStatus = result && result.ok === true
          ? ''
          : 'Could not open the personality folder.';
      } catch (error) {
        personalityState.actionStatus = 'Could not open the personality folder.';
      }
      renderMeta();
    }

    function hasPersonalityUnsavedChanges() {
      return personalityState.dirty === true;
    }

    function onBeforeUnload(event) {
      if (!hasPersonalityUnsavedChanges()) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      event.returnValue = '';
    }
    if (windowRef && typeof windowRef.addEventListener === 'function') {
      windowRef.addEventListener('beforeunload', onBeforeUnload);
    }

    return {
      cancelPresetReplace: cancelPresetReplace,
      captureDraft: captureDraft,
      confirmPresetReplace: confirmPresetReplace,
      getCompiledPreviewText: function () { return compiledPreview().text; },
      getDraft: draft,
      handlePersonalityOpenFolder: handlePersonalityOpenFolder,
      handlePersonalityReset: handlePersonalityReset,
      handlePersonalitySave: handlePersonalitySave,
      handleVoiceChange: handleVoiceChange,
      hasPersonalityUnsavedChanges: hasPersonalityUnsavedChanges,
      refreshPersonalityWorkspace: refreshPersonalityWorkspace,
      renderPersonalityEditor: renderPersonalityEditor,
      toggleExactPanel: toggleExactPanel,
      dispose: function dispose() {
        if (!disposalFence.dispose()) return;
        if (windowRef && typeof windowRef.removeEventListener === 'function') {
          windowRef.removeEventListener('beforeunload', onBeforeUnload);
        }
        for (var i = 0; i < boundHandlers.length; i += 1) {
          var entry = boundHandlers[i];
          if (entry[0] && typeof entry[0].removeEventListener === 'function') {
            entry[0].removeEventListener(entry[1], entry[2]);
          }
        }
        boundHandlers = [];
        handlersInstalled = false;
      },
    };
  }

  return {
    NOTES_CLEAR_CONFIRM: memoryNotes && memoryNotes.NOTES_CLEAR_CONFIRM,
    // Re-exported so the shell registry keeps resolving both editors through
    // `personalityEditorUtils`; the notes controller itself lives next door.
    createMemoryContextEditor: memoryNotes && memoryNotes.createMemoryContextEditor,
    createPersonalityEditor: createPersonalityEditor,
  };
});
