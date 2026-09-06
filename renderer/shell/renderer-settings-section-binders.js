/* renderer/shell/renderer-settings-section-binders.js - Deferred Settings section event binders. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsSectionBinders = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createSettingsSectionBinders(deps) {
    const state = deps.state;
    const callbacks = deps.callbacks || {};
    const constants = deps.constants || {};
    const getLazySectionDom = deps.getLazySectionDom || function noopGetLazySectionDom() { return {}; };
    // Tier C JSON advanced editor (JENNY_UIUX_OVERHAUL_PLAN.md item 8): the
    // offline section's slice, built lazily on first bind so a test harness
    // that never calls bindSection('offline') never touches window.jennyShell.
    const {
      renderAll,
      renderSettings,
      renderPersonalityEditor,
      renderMemoryContextFiles,
      handlePersonalitySave,
      handlePersonalityReset,
      handlePersonalityOpenFolder,
      saveMemoryContextFile,
      resetMemoryContextFile,
      showShellErrorToast,
      toErrorMessage,
      showSessionActionError,
      openSettingsSection,
      updateSkillsSettings,
      handleOfflineModeChange,
    } = callbacks;
    const {
      TOAST_SOURCE = {},
    } = constants;

    function bindSkills(registerSectionListener, finalizeSectionBindings) {
      const skillsDom = getLazySectionDom('skills');
      const section = skillsDom.skillsSettingsSection;
      const skillsScopePatchKeys = {
        skillsUserToggle: 'userEnabled',
        skillsProjectToggle: 'projectEnabled',
      };
      registerSectionListener(section, 'inv-toggle-change', (event) => {
        const detail = (event && event.detail) || {};
        const toggleId = String(detail.id || '');
        if (toggleId.startsWith('skillToggle:')) {
          const skillId = toggleId.slice('skillToggle:'.length);
          if (!skillId) return;
          const current = Array.isArray(state.skills?.settings?.disabledSkillIds)
            ? state.skills.settings.disabledSkillIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [];
          const next = new Set(current);
          if (detail.checked === true) next.delete(skillId);
          else next.add(skillId);
          updateSkillsSettings({ disabledSkillIds: Array.from(next) });
          return;
        }
        if (toggleId === 'skillsAutoIndexToggle') {
          updateSkillsSettings({ autoIndex: detail.checked === true ? 'on' : 'off' });
          return;
        }
        const patchKey = skillsScopePatchKeys[toggleId];
        if (!patchKey) {
          return;
        }
        updateSkillsSettings({ [patchKey]: detail.checked === true });
      });
      registerSectionListener(section, 'click', (event) => {
        const target = event.target?.closest?.('[data-skills-action]');
        if (!target || !section?.contains?.(target)) return;
        const action = target.dataset.skillsAction;
        if (action === 'toggle-folders') {
          const disclosure = section.querySelector('[data-skills-folders-region]');
          if (!disclosure) return;
          const expanded = disclosure.hidden;
          disclosure.hidden = !expanded;
          target.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
        // open-folder is dispatched by the settings-view click listener in
        // renderer-settings-event-utils.js; handling it here too would double-call.
      });
      return finalizeSectionBindings();
    }

    function bindOffline(registerSectionListener, finalizeSectionBindings) {
      const offlineDom = getLazySectionDom('offline');
      registerSectionListener(offlineDom.offlineLocalOnlyList, 'inv-toggle-change', (event) => {
        const detail = (event && event.detail) || {};
        if (detail.id !== 'offlineLocalOnlyToggle') {
          return;
        }
        handleOfflineModeChange(detail.checked === true).catch((error) => {
          showSessionActionError(error, 'Offline Update Failed');
        });
      });
      registerSectionListener(offlineDom.offlineModelActions, 'click', (event) => {
        if (!event.target?.closest?.('[data-action="openOfflineModelLibrary"]')) return;
        openSettingsSection('models', { source: 'offline_model_remediation' });
      });
      return finalizeSectionBindings();
    }

    // Advanced engine tuning. Built lazily on first bind so a harness that never
    // opens the section never reaches for window.jennyShell or the inventory.
    let advancedTuningSection = null;
    function bindAdvanced(registerSectionListener, finalizeSectionBindings, context = {}) {
      const windowRef = deps.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
      const factory = windowRef.rendererSettingsAdvancedSection?.createAdvancedTuningSection;
      if (typeof factory !== 'function') return finalizeSectionBindings();
      const advancedDom = getLazySectionDom('advanced');
      if (!advancedTuningSection) {
        advancedTuningSection = factory({
          inventory: windowRef.inventory,
          getBridge: () => windowRef.jennyShell?.engineTuning || null,
        });
      }
      advancedTuningSection.bind(advancedDom, registerSectionListener);
      context.addCleanup?.(() => advancedTuningSection?.dispose?.());
      // The section is lazy, so first bind is also its first paint.
      void advancedTuningSection.refresh(advancedDom);
      return finalizeSectionBindings();
    }

    function createConfirmDialog(hostId) {
      const windowRef = deps.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
      const factory = windowRef.rendererIdeConfirmDialog?.createIdeConfirmDialog;
      const helpOverlayFactory = windowRef.inventoryHelpOverlay?.createHelpOverlay;
      if (typeof factory !== 'function' || typeof helpOverlayFactory !== 'function') return null;
      return factory({
        document: windowRef.document,
        actionButton: windowRef.inventoryActionButton,
        helpOverlayFactory,
        hostId,
      });
    }

    function bindPersonality(registerSectionListener, finalizeSectionBindings, context = {}) {
      const personalityDom = getLazySectionDom('personality');
      const confirmDialog = createConfirmDialog('personalityClearConfirmOverlay');
      // Field-level events (typing, voice presets, the exact-text disclosure)
      // are owned by the personality controller, which owns those hosts. The
      // binder keeps the two shell-dependent affordances: the Clear confirm
      // dialog and the section-scoped Ctrl+S save.
      registerSectionListener(personalityDom.personalityActions, 'click', (event) => {
        const target = event.target;
        if (!target?.closest) return;
        if (target.closest('[data-action="personality-save"]')) {
          handlePersonalitySave().catch((error) => {
            state.personality.actionStatus = `Save failed: ${toErrorMessage(error, 'unknown error')}`;
            renderPersonalityEditor();
          });
          return;
        }
        if (target.closest('[data-action="personality-open-folder"]')) {
          handlePersonalityOpenFolder().catch((error) => {
            state.personality.actionStatus = `Open folder failed: ${toErrorMessage(error, 'unknown error')}`;
            renderPersonalityEditor();
          });
          return;
        }
        if (!target.closest('[data-action="personality-clear"]')) return;
        if (!confirmDialog?.confirm) {
          // Never destroy both files without a confirm: say so instead of
          // silently doing nothing when the dialog could not be built.
          state.personality.actionStatus = 'Clear is unavailable.';
          renderPersonalityEditor();
          return;
        }
        Promise.resolve(confirmDialog.confirm({
          title: 'Clear personality?',
          message: 'The note and About you go back to empty. '
            + 'Long-term notes and approved memories are not affected.',
          confirmLabel: 'Clear',
          cancelLabel: 'Cancel',
          variant: 'danger',
        })).then((confirmed) => {
          if (!confirmed) return undefined;
          return handlePersonalityReset();
        }).catch((error) => {
          state.personality.actionStatus = `Clear failed: ${toErrorMessage(error, 'unknown error')}`;
          renderPersonalityEditor();
        });
      });
      const formHost = personalityDom.personalityFormHost;
      const personalitySection = (formHost && typeof formHost.closest === 'function'
        ? formHost.closest('[data-settings-section="personality"]')
        : null) || formHost;
      registerSectionListener(personalitySection, 'keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey) || String(event.key || '').toLowerCase() !== 's') return;
        // Always swallow Ctrl+S inside the section, even when there is nothing
        // to save -- otherwise it falls through to the browser's Save Page.
        event.preventDefault();
        // `dirty` stays true for the whole in-flight save, so guarding on it
        // alone lets a second Ctrl+S start a concurrent write.
        if (state.personality?.saving === true || state.personality?.dirty !== true) return;
        handlePersonalitySave().catch((error) => {
          state.personality.actionStatus = `Save failed: ${toErrorMessage(error, 'unknown error')}`;
          renderPersonalityEditor();
        });
      });
      context.addCleanup?.(() => confirmDialog?.dispose?.());
      return finalizeSectionBindings();
    }

    function bindMemories(registerSectionListener, finalizeSectionBindings, context = {}) {
      const memoryDom = getLazySectionDom('memories');
      const confirmDialog = createConfirmDialog('memoryNotesClearConfirmOverlay');
      registerSectionListener(memoryDom.memoryNotesActions, 'click', (event) => {
        const target = event.target;
        if (!target?.closest) return;
        if (target.closest('[data-action="memory-notes-save"]')) {
          saveMemoryContextFile().catch(() => {});
          return;
        }
        if (!target.closest('[data-action="memory-notes-clear"]')) return;
        if (!confirmDialog?.confirm) {
          state.memoryContextFiles.actionStatus = 'Clear is unavailable.';
          renderMemoryContextFiles();
          return;
        }
        Promise.resolve(confirmDialog.confirm({
          title: 'Clear long-term notes?',
          message: 'The notes go back to empty. Approved memories are not affected.',
          confirmLabel: 'Clear',
          cancelLabel: 'Cancel',
          variant: 'danger',
        })).then((confirmed) => (confirmed ? resetMemoryContextFile() : undefined)).catch(() => {});
      });
      context.addCleanup?.(() => confirmDialog?.dispose?.());
      return finalizeSectionBindings();
    }

    const sectionBindersById = Object.freeze({
      skills: bindSkills,
      advanced: bindAdvanced,
      offline: bindOffline,
      personality: bindPersonality,
      memories: bindMemories,
    });

    function bindSection(sectionId, context) {
      const normalizedSectionId = String(sectionId || '').trim();
      const registerSectionListener = context.registerSectionListener;
      const finalizeSectionBindings = context.finalizeSectionBindings;
      const binder = sectionBindersById[normalizedSectionId];
      if (binder) {
        return binder(registerSectionListener, finalizeSectionBindings, context);
      }
      return finalizeSectionBindings();
    }

    return {
      bindSection,
    };
  }

  return {
    createSettingsSectionBinders,
  };
});
