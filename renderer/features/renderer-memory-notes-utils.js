/**
 * renderer/features/renderer-memory-notes-utils.js
 *
 * Settings ▸ Memory ▸ "Long-term notes" controller (MEMORY.md body).
 *
 * Owns MEMORY.md with a separate budget.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./personality-form'),
      require('./renderer-personality-counters'),
      require('../inventory/action-button'),
      require('../inventory/text-field'),
      require('../shared/async-fence')
    );
    return;
  }
  root.rendererMemoryNotesUtils = factory(
    root.personalityForm,
    root.rendererPersonalityCounters,
    root.inventoryActionButton,
    root.inventoryTextField,
    root.rendererAsyncFence
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  personalityForm,
  counters,
  actionButtonModule,
  textFieldModule,
  asyncFence
) {
  'use strict';

  var actionButton = typeof actionButtonModule === 'function'
    ? actionButtonModule
    : (actionButtonModule && actionButtonModule.actionButton) || null;
  var textField = typeof textFieldModule === 'function' ? textFieldModule : null;

  var MEMORY_NOTES_ID = 'memoryNotesInput';

  var NOTES_CLEAR_CONFIRM = {
    title: 'Clear long-term notes?',
    message: 'The notes go back to empty. Approved memories are not affected.',
    confirmLabel: 'Clear',
    cancelLabel: 'Cancel',
  };

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

  function createMemoryContextEditor(deps) {
    var d = deps || {};
    var notesState = d.state && d.state.memoryContextFiles ? d.state.memoryContextFiles : {};
    var dom = d.dom || {};
    var windowRef = d.windowRef || (typeof window !== 'undefined' ? window : null);
    var button = d.actionButton || actionButton;
    var nowFn = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    var disposalFence = asyncFence.createDisposalFence();
    var refreshGate = asyncFence.createGenerationGate();
    var mutationGate = asyncFence.createGenerationGate();
    var shellRendered = false;

    function api() {
      var shellApi = windowRef && windowRef.jennyShell ? windowRef.jennyShell : null;
      var memory = shellApi && shellApi.memory ? shellApi.memory : null;
      return memory && memory.contextFiles ? memory.contextFiles : null;
    }

    function budget() {
      return Number(notesState.budget) || personalityForm.BUDGETS.memory;
    }

    function inputEl() {
      var host = dom.memoryNotesFieldHost;
      return host && typeof host.querySelector === 'function'
        ? host.querySelector('#' + MEMORY_NOTES_ID)
        : null;
    }

    function markDirty() {
      notesState.dirty = String(notesState.body || '') !== String(notesState.savedBody || '');
    }

    /* Signature memo: renderMeta() runs on every keystroke, and rebuilding the
       buttons there would churn innerHTML per character typed. */
    var actionsSignature = '';

    function renderActions() {
      if (!dom.memoryNotesActions || !button) return;
      var busy = notesState.loading === true || notesState.saving === true;
      var saveDisabled = busy || notesState.dirty !== true || notesState.oversized === true;
      var signature = [busy ? '1' : '0', saveDisabled ? '1' : '0',
        notesState.saving === true ? '1' : '0'].join('|');
      if (signature === actionsSignature) return;
      actionsSignature = signature;
      dom.memoryNotesActions.innerHTML = ''
        + button({
          id: 'memory-notes-clear',
          label: 'Clear',
          variant: 'ghost',
          disabled: busy,
        })
        + button({
          id: 'memory-notes-save',
          label: notesState.saving === true ? 'Saving…' : 'Save',
          variant: 'secondary',
          disabled: saveDisabled,
        });
    }

    function renderShell() {
      if (!dom.memoryNotesFieldHost || !textField) return;
      dom.memoryNotesFieldHost.innerHTML = textField({
        id: MEMORY_NOTES_ID,
        value: String(notesState.body || ''),
        ariaLabel: 'Long-term notes',
        placeholder: 'Durable facts and preferences the assistant should always know.',
        multiline: true,
        spellcheck: true,
        // A MEMORY.md over 64 KiB is read-only here: the service refuses the
        // write, so an editable textarea would only lose the user's typing.
        disabled: notesState.loading === true || notesState.saving === true || notesState.oversized === true,
        className: 'personality-notes-field',
      });
      var control = inputEl();
      if (control) {
        control.setAttribute('aria-describedby', 'memoryNotesHint memoryNotesCounter memoryNotesLint');
      }
      shellRendered = true;
      actionsSignature = '';
    }

    function renderMeta() {
      var model = counters.buildCounterModel(notesState.body, budget());
      setText(dom.memoryNotesCounter, model.text);
      if (dom.memoryNotesCounter && dom.memoryNotesCounter.classList) {
        dom.memoryNotesCounter.classList.toggle('personality-counter--over', model.over);
      }
      // The oversized notice outranks the placeholder lint: it is the reason
      // the field is read-only, and renderMeta runs after every render.
      var lint = notesState.oversized === true
        ? counters.OVERSIZED_MESSAGE
        : counters.buildLintMessage(notesState.body);
      setText(dom.memoryNotesLint, lint);
      setHidden(dom.memoryNotesLint, !lint);
      setText(dom.memoryContextStatus, counters.buildPersonalityStatusLine({
        loading: notesState.loading === true,
        dirty: notesState.dirty === true,
        actionStatus: notesState.actionStatus,
        loadStatus: notesState.loadStatus,
        savedAt: notesState.savedAt,
        now: nowFn(),
      }));
      renderActions();
    }

    var inputHandler = null;

    function installHandlers() {
      if (inputHandler || !dom.memoryNotesFieldHost
        || typeof dom.memoryNotesFieldHost.addEventListener !== 'function') return;
      inputHandler = function () { captureDraft(); };
      dom.memoryNotesFieldHost.addEventListener('input', inputHandler);
    }

    function render() {
      if (!dom.memoryNotesFieldHost) return;
      if (!shellRendered) renderShell();
      installHandlers();
      renderMeta();
    }

    function setDraft(body) {
      notesState.body = String(body == null ? '' : body);
      notesState.actionStatus = '';
      markDirty();
      renderMeta();
    }

    function captureDraft() {
      var input = inputEl();
      if (!input) return;
      setDraft(input.value);
    }

    async function refresh() {
      if (disposalFence.isDisposed()) return;
      var contextFiles = api();
      if (!contextFiles || typeof contextFiles.getState !== 'function') {
        notesState.loadStatus = 'Long-term notes are unavailable.';
        render();
        return;
      }
      if (notesState.dirty === true) {
        render();
        return;
      }
      refreshGate.bump();
      var refreshToken = refreshGate.capture();
      var startingBody = String(notesState.body || '');
      notesState.loading = true;
      notesState.loadStatus = '';
      render();
      try {
        var snapshot = await contextFiles.getState();
        if (disposalFence.isDisposed() || !refreshGate.isCurrent(refreshToken)) return;
        if (notesState.dirty === true || String(notesState.body || '') !== startingBody) return;
        notesState.body = String((snapshot && snapshot.body) || '');
        notesState.savedBody = notesState.body;
        if (snapshot && Number(snapshot.budget) > 0) notesState.budget = Number(snapshot.budget);
        notesState.oversized = Boolean(snapshot && snapshot.oversized);
        notesState.dirty = false;
        notesState.loadStatus = '';
        shellRendered = false;
      } catch (error) {
        if (disposalFence.isDisposed() || !refreshGate.isCurrent(refreshToken)) return;
        notesState.loadStatus = 'Unable to load long-term notes: ' + toMessage(error, 'unknown error');
      } finally {
        if (!disposalFence.isDisposed() && refreshGate.isCurrent(refreshToken)) {
          notesState.loading = false;
          renderShell();
          renderMeta();
        }
      }
    }

    async function save() {
      if (disposalFence.isDisposed() || notesState.saving === true) return;
      var contextFiles = api();
      if (!contextFiles || typeof contextFiles.writeFile !== 'function') {
        notesState.actionStatus = 'Saving long-term notes is unavailable.';
        renderMeta();
        return;
      }
      captureDraft();
      var body = String(notesState.body || '');
      refreshGate.bump();
      mutationGate.bump();
      var mutationToken = mutationGate.capture();
      notesState.saving = true;
      notesState.actionStatus = 'Saving…';
      shellRendered = false;
      render();
      try {
        var result = await contextFiles.writeFile({ body: body });
        if (disposalFence.isDisposed() || !mutationGate.isCurrent(mutationToken)) return;
        if (!result || result.ok !== true) {
          notesState.actionStatus = counters.buildSaveFailureMessage(result, 'Save')
            + ' Your notes were kept.';
          return;
        }
        if (typeof result.oversized === 'boolean') notesState.oversized = result.oversized;
        notesState.savedBody = body;
        markDirty();
        notesState.savedAt = nowFn();
        notesState.actionStatus = '';
      } catch (error) {
        if (disposalFence.isDisposed() || !mutationGate.isCurrent(mutationToken)) return;
        notesState.actionStatus = 'Save failed. Your notes were kept.';
      } finally {
        if (!disposalFence.isDisposed() && mutationGate.isCurrent(mutationToken)) {
          notesState.saving = false;
          shellRendered = false;
          render();
        }
      }
    }

    async function reset() {
      if (disposalFence.isDisposed() || notesState.saving === true) return;
      var contextFiles = api();
      if (!contextFiles || typeof contextFiles.resetFile !== 'function') {
        notesState.actionStatus = 'Clearing long-term notes is unavailable.';
        renderMeta();
        return;
      }
      captureDraft();
      var body = String(notesState.body || '');
      refreshGate.bump();
      mutationGate.bump();
      var mutationToken = mutationGate.capture();
      notesState.saving = true;
      notesState.actionStatus = 'Clearing…';
      shellRendered = false;
      render();
      try {
        var result = await contextFiles.resetFile();
        if (disposalFence.isDisposed() || !mutationGate.isCurrent(mutationToken)) return;
        if (!result || result.ok !== true) {
          notesState.actionStatus = counters.buildSaveFailureMessage(result, 'Clear')
            + ' Your notes were kept.';
          return;
        }
        notesState.oversized = false;
        if (String(notesState.body || '') === body) notesState.body = '';
        notesState.savedBody = '';
        markDirty();
        notesState.savedAt = nowFn();
        notesState.actionStatus = '';
      } catch (error) {
        if (disposalFence.isDisposed() || !mutationGate.isCurrent(mutationToken)) return;
        notesState.actionStatus = 'Clear failed. Your notes were kept.';
      } finally {
        if (!disposalFence.isDisposed() && mutationGate.isCurrent(mutationToken)) {
          notesState.saving = false;
          shellRendered = false;
          render();
        }
      }
    }

    function hasUnsavedChanges() {
      return notesState.dirty === true;
    }

    function onBeforeUnload(event) {
      if (!hasUnsavedChanges()) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      event.returnValue = '';
    }
    if (windowRef && typeof windowRef.addEventListener === 'function') {
      windowRef.addEventListener('beforeunload', onBeforeUnload);
    }

    return {
      NOTES_CLEAR_CONFIRM: NOTES_CLEAR_CONFIRM,
      captureDraft: captureDraft,
      hasUnsavedChanges: hasUnsavedChanges,
      refresh: refresh,
      render: render,
      reset: reset,
      save: save,
      setDraft: setDraft,
      dispose: function dispose() {
        refreshGate.bump();
        mutationGate.bump();
        disposalFence.dispose();
        if (windowRef && typeof windowRef.removeEventListener === 'function') {
          windowRef.removeEventListener('beforeunload', onBeforeUnload);
        }
        if (inputHandler && dom.memoryNotesFieldHost
          && typeof dom.memoryNotesFieldHost.removeEventListener === 'function') {
          dom.memoryNotesFieldHost.removeEventListener('input', inputHandler);
        }
        inputHandler = null;
      },
    };
  }

  return {
    NOTES_CLEAR_CONFIRM: NOTES_CLEAR_CONFIRM,
    createMemoryContextEditor: createMemoryContextEditor,
  };
});
