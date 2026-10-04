/* renderer/features/renderer-open-loop-form.js - Home "Add / Edit open loop" form (UMD)
 *
 * Owns the form's state machine: open (add or edit), render, submit, close.
 * The user's draft lives in the DOM; fields are written from the opened loop
 * only on the open transition, never on a routine re-render. A submit
 * belongs to the form generation it started in, so a late response never
 * closes or wipes a form opened after it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererOpenLoopForm = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function deferPresetLabel(preset) {
    switch (preset?.preset) {
      case 'later_today': return jt('companion.defer.laterToday', 'Later today');
      case 'tomorrow': return jt('companion.defer.tomorrow', 'Tomorrow');
      case 'next_week': return jt('companion.defer.nextWeek', 'Next week');
      default: return String(preset?.label || '');
    }
  }

  const DEFAULT_DEFER_PRESETS = Object.freeze(
    ['later_today', 'tomorrow', 'next_week'].map((preset) => ({ preset, label: deferPresetLabel({ preset }), deferredUntil: '' }))
  );

  function getAvailableDeferPresets(companionState) {
    const presets = Array.isArray(companionState?.availableDeferPresets)
      ? companionState.availableDeferPresets
      : [];
    return presets.length ? presets : DEFAULT_DEFER_PRESETS.slice();
  }

  function blankFormState() {
    return { mode: 'add', followUpId: '', loopStatus: 'active', title: '', body: '', timing: '' };
  }

  function createOpenLoopFormController(deps = {}) {
    const {
      state = {},
      windowRef = globalThis,
      documentRef = globalThis.document || null,
      dom = {},
      getCompanionState = () => ({}),
      applyCompanionPayload = () => ({}),
      renderHomePanel = () => {},
      renderAll = () => {},
      loopToast = () => '',
      findOverflowTrigger = () => null,
    } = deps;
    const {
      homeOpenLoopAddButton = null,
      homeOpenLoopForm = null,
      homeOpenLoopFormHeading = null,
      homeOpenLoopFormNote = null,
      homeOpenLoopTitleInput = null,
      homeOpenLoopNotesInput = null,
      homeOpenLoopDeferSelect = null,
      homeOpenLoopSaveButton = null,
      homeOpenLoopCancelButton = null,
    } = dom;

    let formOpen = false;
    let formState = blankFormState();
    /* Fields are written from formState only when the form (re)opens. */
    let formFieldsStale = true;
    let formSubmitting = false;
    /* Bumped on every open and close; a submit only finishes the form it
     * started in. */
    let formGeneration = 0;

    const isResolvedOnly = () => formState.loopStatus === 'resolved' || formState.loopStatus === 'archived';

    function render(companionState) {
      if (!homeOpenLoopForm) {
        return;
      }
      homeOpenLoopForm.hidden = !formOpen;
      homeOpenLoopForm.setAttribute('aria-hidden', formOpen ? 'false' : 'true');
      if (homeOpenLoopAddButton) {
        homeOpenLoopAddButton.hidden = formOpen;
      }
      const isEditing = formState.mode === 'edit';
      const resolvedOnly = isResolvedOnly();
      const writeFields = formFieldsStale;
      formFieldsStale = false;
      if (homeOpenLoopFormHeading) {
        homeOpenLoopFormHeading.textContent = isEditing ? jt('companion.openLoops.editHeading', 'Edit Open Loop') : jt('companion.openLoops.addHeading', 'Add Open Loop');
      }
      if (homeOpenLoopFormNote) {
        homeOpenLoopFormNote.textContent = isEditing
          ? resolvedOnly
            ? jt('companion.openLoops.editResolvedDescription', 'Edit the title or notes. Archived and completed loops keep their current status.')
            : jt('companion.openLoops.editDescription', 'Adjust details or timing without leaving Home.')
          : jt('companion.openLoops.addDescription', 'Create an active loop now or defer it to a later preset.');
      }
      if (homeOpenLoopDeferSelect) {
        const previousValue = String((writeFields ? formState.timing : homeOpenLoopDeferSelect.value) || '').trim();
        homeOpenLoopDeferSelect.textContent = '';
        const nowOption = documentRef.createElement('option');
        nowOption.value = '';
        nowOption.textContent = jt('companion.openLoops.activeNow', 'Active now');
        homeOpenLoopDeferSelect.append(nowOption);
        getAvailableDeferPresets(companionState).forEach((preset) => {
          const option = documentRef.createElement('option');
          option.value = preset.preset;
          option.textContent = deferPresetLabel(preset);
          homeOpenLoopDeferSelect.append(option);
        });
        homeOpenLoopDeferSelect.value = [...homeOpenLoopDeferSelect.options].some((option) => option.value === previousValue)
          ? previousValue
          : '';
        homeOpenLoopDeferSelect.disabled = resolvedOnly;
      }
      if (writeFields && homeOpenLoopTitleInput) {
        homeOpenLoopTitleInput.value = String(formState.title || '');
      }
      if (writeFields && homeOpenLoopNotesInput) {
        homeOpenLoopNotesInput.value = String(formState.body || '');
      }
      if (homeOpenLoopSaveButton) {
        homeOpenLoopSaveButton.disabled = !companionState?.loaded || formSubmitting;
        homeOpenLoopSaveButton.textContent = isEditing ? jt('companion.openLoops.saveChanges', 'Save Changes') : jt('companion.openLoops.save', 'Save Open Loop');
      }
      if (homeOpenLoopCancelButton) {
        homeOpenLoopCancelButton.textContent = isEditing ? jt('companion.openLoops.cancelEdit', 'Cancel Edit') : jt('common.cancel', 'Cancel');
      }
    }

    function open(loop = null) {
      const resolvedLoop = loop && typeof loop === 'object' ? loop : null;
      formState = resolvedLoop
        ? {
            mode: 'edit',
            followUpId: String(resolvedLoop.followUpId || '').trim(),
            loopStatus: String(resolvedLoop.status || 'active').trim() || 'active',
            title: String(resolvedLoop.title || '').trim(),
            body: String(resolvedLoop.body || '').trim(),
            timing: resolvedLoop.status === 'deferred' ? String(resolvedLoop.deferPreset || '').trim() : '',
          }
        : blankFormState();
      formFieldsStale = true;
      formOpen = true;
      formGeneration += 1;
      renderHomePanel();
      homeOpenLoopTitleInput?.focus();
    }

    function close() {
      const returnFocusTo = formState.mode === 'edit' ? formState.followUpId : '';
      formOpen = false;
      formState = blankFormState();
      formFieldsStale = true;
      formGeneration += 1;
      renderHomePanel();
      /* Hand focus back to where the form was opened from. */
      (findOverflowTrigger(returnFocusTo) || homeOpenLoopAddButton)?.focus?.();
    }

    function editingFollowUpId() {
      return formOpen && formState.mode === 'edit' ? formState.followUpId : '';
    }

    function closeIfEditing(followUpId) {
      if (followUpId && editingFollowUpId() === String(followUpId)) {
        close();
      }
    }

    function setSubmitting(submitting) {
      formSubmitting = submitting;
      if (!homeOpenLoopSaveButton) {
        return;
      }
      if (submitting) {
        homeOpenLoopSaveButton.setAttribute('aria-busy', 'true');
        homeOpenLoopSaveButton.disabled = true;
      } else {
        homeOpenLoopSaveButton.removeAttribute('aria-busy');
        homeOpenLoopSaveButton.disabled = !getCompanionState().loaded;
      }
    }

    /* Edits send timing only when the user changed the timing select: an
     * untouched select must not reschedule a due loop or clear a custom
     * deferral. */
    function buildEditPatch(title, body, deferPreset) {
      const patch = { label: title, body };
      if (!isResolvedOnly() && deferPreset !== formState.timing) {
        patch.status = deferPreset ? 'deferred' : 'active';
        patch.deferPreset = deferPreset;
      }
      return patch;
    }

    async function submit() {
      if (formSubmitting) {
        return;
      }
      const title = String(homeOpenLoopTitleInput?.value || '').trim();
      const body = String(homeOpenLoopNotesInput?.value || '').trim();
      const deferPreset = String(homeOpenLoopDeferSelect?.value || '').trim();
      if (!title) {
        loopToast(jt('companion.toasts.titleRequired', 'Add a title before saving this open loop.'), {
          tone: 'warning',
          dedupeKey: 'shell.companion:add:title-required',
        });
        homeOpenLoopTitleInput?.focus();
        return;
      }
      const editingId = formState.mode === 'edit' ? formState.followUpId : '';
      const generation = formGeneration;
      setSubmitting(true);
      let payload;
      try {
        payload = editingId
          ? await windowRef.jennyShell.companion.updateFollowUp(editingId, buildEditPatch(title, body, deferPreset))
          : await windowRef.jennyShell.companion.addFollowUp({
              label: title,
              body,
              sessionId: String(state.currentSessionId || state.activeSessionId || '').trim(),
              status: deferPreset ? 'deferred' : 'active',
              deferPreset,
              sourceKind: 'manual',
            });
      } finally {
        setSubmitting(false);
      }
      applyCompanionPayload(payload);
      if (generation === formGeneration) {
        close();
      }
      loopToast(
        editingId
          ? jt('companion.toasts.changesSaved', 'Saved open loop changes.')
          : deferPreset
            ? jt('companion.toasts.savedDeferred', 'Saved to deferred open loops.')
            : jt('companion.toasts.saved', 'Saved to open loops.'),
        {
          dedupeKey: editingId
            ? `shell.companion:edit:${editingId}`
            : `shell.companion:add:${deferPreset || 'active'}`,
        }
      );
      renderAll();
    }

    return { render, open, close, submit, editingFollowUpId, closeIfEditing };
  }

  return {
    createOpenLoopFormController,
    deferPresetLabel,
    getAvailableDeferPresets,
  };
});
