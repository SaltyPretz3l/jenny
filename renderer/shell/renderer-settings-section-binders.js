/* renderer/shell/renderer-settings-section-binders.js - Deferred Settings section event binders. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-field-binding'));
    return;
  }
  root.rendererSettingsSectionBinders = factory(root.rendererSettingsFieldBinding);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fieldBinding) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
      handleWorkspaceRootChoose,
      clearWorkspaceRoot,
      renderSessions,
      getProjectSwitcher,
      setSidebarCollapsed,
    } = callbacks;
    const {
      TOAST_SOURCE = {},
    } = constants;

    // One adapter per persisted object; both are after-ack because the owning
    // controllers (skills, offline) apply the echoed state and repaint.
    const confirmError = () => new Error(jt('settings.chatUi.confirmError', 'The saved setting could not be confirmed.'));
    const fieldRegistry = fieldBinding.createSettingsAdapterRegistry({
      log: (message) => callbacks.appendClientLog?.('WARN', 'settings.field_adapter', { message }),
    });
    fieldRegistry.register({
      id: 'skills',
      mode: 'patch',
      optimistic: false,
      read: () => state.skills?.settings || {},
      normalize: (settings) => ({
        userEnabled: settings.userEnabled === true,
        projectEnabled: settings.projectEnabled === true,
        autoIndex: ['auto', 'on', 'off'].includes(settings.autoIndex) ? settings.autoIndex : 'auto',
      }),
      // The skills controller toasts its own failure and resolves nothing then.
      // The acknowledgement is the payload's own settings, before the
      // controller's normalizer fills a missing key with its default.
      write: (patch) => Promise.resolve(updateSkillsSettings(patch)).then((payload) => (payload ? payload.settings || {} : undefined)),
      ack: (echo, patch) => {
        Object.keys(patch).forEach((key) => { if (echo[key] !== patch[key]) throw confirmError(); });
        return echo;
      },
      apply: (next, keys) => {
        if (!state.skills?.settings) return;
        const settings = { ...state.skills.settings };
        keys.forEach((key) => { settings[key] = next[key]; });
        state.skills.settings = settings;
        renderSettings?.();
      },
    });
    fieldRegistry.register({
      id: 'offline',
      mode: 'patch',
      optimistic: false,
      read: () => ({ localOnly: state.offline?.mode === 'local_only' }),
      normalize: (value) => ({ localOnly: value.localOnly === true }),
      write: (patch) => handleOfflineModeChange(patch.localOnly),
      ack: (echo, patch) => {
        if ((echo?.mode === 'local_only') !== patch.localOnly) throw confirmError();
        return { localOnly: patch.localOnly };
      },
      // The offline controller owns state.offline and repaints on both paths.
      apply: () => {},
    });

    function bindSkills(registerSectionListener, finalizeSectionBindings) {
      const skillsDom = getLazySectionDom('skills');
      const section = skillsDom.skillsSettingsSection;
      fieldBinding.bindSettingFields({
        container: section,
        ids: ['skillsUserToggle', 'skillsProjectToggle', 'skillsAutoIndexToggle'],
        registry: fieldRegistry,
        registerListener: registerSectionListener,
      });
      // A per-skill switch writes the whole disabled list, so each write waits
      // for the previous acknowledgement and builds on the state it left.
      let skillWrite = null;
      function writeSkillEnabled(skillId, enabled) {
        const run = () => {
          const current = Array.isArray(state.skills?.settings?.disabledSkillIds)
            ? state.skills.settings.disabledSkillIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [];
          const next = new Set(current);
          if (enabled) next.delete(skillId);
          else next.add(skillId);
          // The skills controller toasts its own failure and resolves nothing
          // then; the repaint returns the switch to the saved state.
          return Promise.resolve(updateSkillsSettings({ disabledSkillIds: Array.from(next) }))
            .then((payload) => { if (!payload) renderSettings?.(); }, () => { renderSettings?.(); });
        };
        const queued = skillWrite ? skillWrite.then(run) : run();
        skillWrite = queued;
        queued.then(() => { if (skillWrite === queued) skillWrite = null; });
      }
      registerSectionListener(section, 'inv-toggle-change', (event) => {
        const detail = (event && event.detail) || {};
        const toggleId = String(detail.id || '');
        if (toggleId.startsWith('skillToggle:')) {
          const skillId = toggleId.slice('skillToggle:'.length);
          if (skillId) writeSkillEnabled(skillId, detail.checked === true);
        }
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
      fieldBinding.bindSettingFields({
        container: offlineDom.offlineLocalOnlyList,
        ids: ['offlineLocalOnlyToggle'],
        registry: fieldRegistry,
        registerListener: registerSectionListener,
        onError: (_descriptor, error, shown) => {
          if (!shown?.inline) showSessionActionError(error, jt('settings.offline.updateFailed', 'Offline Update Failed'));
        },
      });
      registerSectionListener(offlineDom.offlineModelActions, 'click', (event) => {
        if (!event.target?.closest?.('[data-action="openOfflineModelLibrary"]')) return;
        openSettingsSection('models', { source: 'offline_model_remediation' });
      });
      return finalizeSectionBindings();
    }

    let sessionRuntimeController = null;
    function bindRuntime(_registerSectionListener, finalizeSectionBindings, context = {}) {
      const windowRef = deps.windowRef || globalThis;
      const runtimeDom = getLazySectionDom('runtime');
      sessionRuntimeController = sessionRuntimeController
        || windowRef.rendererSettingsSessionRuntime?.createSessionRuntimeSettingsController?.({
          state,
          windowRef,
          documentRef: windowRef.document,
          host: runtimeDom.sessionRuntimeSettingsMount,
          openSession: callbacks.openSession,
          setActiveView: callbacks.setActiveView,
          showError: showSessionActionError,
          chooseWorkspaceRoot: handleWorkspaceRootChoose,
          clearWorkspaceRoot,
          renderSessions,
          getProjectSwitcher,
          setSidebarCollapsed,
        })
        || null;
      sessionRuntimeController?.bind?.();
      context.addCleanup?.(() => sessionRuntimeController?.dispose?.());
      context.markSectionBound?.();
      return finalizeSectionBindings();
    }

    // Diagnostics › Runs and Settings › Developer › Runtime limits share ONE
    // controller, so one poller serves both. Its three scripts load on first
    // attach (never at startup); a failed load leaves a retry button in the
    // Runs mount. A release during load drops the late arrival, and the last
    // view to go disposes the controller.
    const RUNTIME_CONSOLE_SCRIPTS = Object.freeze([
      ['rendererRunsView', 'renderer/shell/renderer-runs-view.js'],
      ['rendererRuntimeLimitsView', 'renderer/shell/renderer-runtime-limits-view.js'],
      ['rendererOrchestrationController', 'renderer/shell/renderer-orchestration-controller.js'],
    ]);
    let runtimeConsole = null;
    let runtimeConsoleLoading = null;
    const runtimeConsoleSections = new Set();
    function loadRuntimeConsole(windowRef) {
      if (runtimeConsole) return Promise.resolve(runtimeConsole);
      if (runtimeConsoleLoading) return runtimeConsoleLoading;
      runtimeConsoleLoading = (async () => {
        for (const [name, src] of RUNTIME_CONSOLE_SCRIPTS) {
          const loaded = windowRef[name] || await windowRef.scriptLoaderUtils?.ensureScript?.({ src, isReady: () => Boolean(windowRef[name]) });
          if (!loaded || !windowRef[name]) throw new Error('runtime_view_unavailable');
        }
        if (!runtimeConsoleSections.size) return null;
        runtimeConsole = windowRef.rendererOrchestrationController.createController({
          state, windowRef, openSession: callbacks.openSession, setActiveView: callbacks.setActiveView,
          listProjects: () => windowRef.jennyShell?.projects?.list?.(),
        });
        runtimeConsole.bind();
        return runtimeConsole;
      })().finally(() => { runtimeConsoleLoading = null; });
      return runtimeConsoleLoading;
    }
    // Attaches one view ('runs' or 'limits') to the shared console; returns its release.
    function attachRuntimeConsole(kind, host) {
      const windowRef = deps.windowRef || globalThis;
      const token = {};
      let disposed = false;
      const button = (config) => (typeof windowRef.inventoryActionButton === 'function' ? windowRef.inventoryActionButton(config) : '');
      async function load() {
        if (disposed || !host) return;
        try {
          const controller = await loadRuntimeConsole(windowRef);
          if (disposed || !controller) return;
          if (kind === 'limits') getAdvancedTuningSection(windowRef)?.render(getLazySectionDom('advanced'));
          controller.attach(kind, host);
        } catch (_error) {
          const status = kind === 'limits' && host.closest('.settings-card')?.querySelector('[data-limits-status]');
          if (!disposed && status) {
            status.textContent = jt('runtime.limits.loadFailed', 'Limits could not be loaded. Restart Jenny to try again.');
            status.hidden = false;
          }
          if (!disposed && kind !== 'limits') host.innerHTML = button({ id: 'runtime-load-retry',
            label: jt('runtime.runs.loadRetry', 'Try loading again'), ariaLabel: jt('runtime.runs.loadRetry', 'Try loading again') });
        }
      }
      const retry = (event) => { if (event?.target?.closest?.('[data-action="runtime-load-retry"]')) void load(); };
      if (host) runtimeConsoleSections.add(token);
      host?.addEventListener?.('click', retry);
      void load();
      return function releaseRuntimeConsole() {
        if (disposed) return;
        disposed = true;
        runtimeConsoleSections.delete(token);
        host?.removeEventListener?.('click', retry);
        runtimeConsole?.detach?.(kind);
        if (!runtimeConsoleSections.size) { runtimeConsole?.dispose?.(); runtimeConsole = null; }
      };
    }
    // Resume polling when the settings shell shows the section again.
    function runtimeConsoleShown() {
      runtimeConsole?.resume?.();
    }
    function bindRuntimeLimits(_registerSectionListener, finalizeSectionBindings, context = {}) {
      const windowRef = deps.windowRef || globalThis;
      const host = getLazySectionDom('advanced').advancedTuningFields || windowRef.document?.getElementById?.('advancedTuningFields') || null;
      context.addCleanup?.(attachRuntimeConsole('limits', host));
      context.markSectionBound?.();
      return finalizeSectionBindings();
    }

    // Diagnostics › Runs (owner, 2026-10-03; moved from Settings) reaches the
    // console through a window seam: Diagnostics has no settings binder and no
    // openSession/setActiveView of its own. Its Runs tab calls showRuns on each
    // paint: the first call attaches the board, later ones wake the poll (a
    // stopped poll reads now, a running one repaints). The controller's own
    // visibility rule stops the poll when Diagnostics or the tab goes away.
    // A newer binder set (a settings rebind) releases the older one's board.
    const diagnosticsRuns = { host: null, release: null };
    function releaseDiagnosticsRuns() {
      diagnosticsRuns.release?.();
      diagnosticsRuns.host = null;
      diagnosticsRuns.release = null;
    }
    function showDiagnosticsRuns(host) {
      if (!host) return;
      if (diagnosticsRuns.host === host) { runtimeConsole?.wake?.(); return; }
      releaseDiagnosticsRuns();
      diagnosticsRuns.host = host;
      diagnosticsRuns.release = attachRuntimeConsole('runs', host);
    }
    const consoleWindow = deps.windowRef || globalThis;
    consoleWindow.rendererRuntimeConsole?.dispose?.();
    const runtimeConsoleSeam = Object.freeze({ showRuns: showDiagnosticsRuns, dispose: releaseDiagnosticsRuns });
    consoleWindow.rendererRuntimeConsole = runtimeConsoleSeam;
    // Renderer teardown: the board stops polling and the seam goes with it
    // (unless a newer binder set already replaced it).
    function dispose() {
      releaseDiagnosticsRuns();
      if (consoleWindow.rendererRuntimeConsole === runtimeConsoleSeam) consoleWindow.rendererRuntimeConsole = null;
    }

    // Advanced engine tuning. Built lazily on first bind so a harness that never
    // opens the section never reaches for window.jennyShell or the inventory.
    let advancedTuningSection = null;
    let advancedBoundDom = null;
    function getAdvancedTuningSection(windowRef) {
      const factory = windowRef.rendererSettingsAdvancedSection?.createAdvancedTuningSection;
      if (typeof factory !== 'function') return null;
      if (!advancedTuningSection) {
        advancedTuningSection = factory({
          inventory: windowRef.inventory,
          getBridge: () => windowRef.jennyShell?.engineTuning || null,
          getEngineType: () => String(state.status?.engine || state.status?.engine_type || state.modelList?.engine_type || '').toLowerCase(),
          // Without the limits console the limits half cannot be reset, and the page must say so.
          resetLimitsToDefaults: () => (runtimeConsole ? runtimeConsole.resetLimitsToDefaults() : Promise.resolve(false)),
        });
      }
      return advancedTuningSection;
    }
    function bindAdvanced(registerSectionListener, finalizeSectionBindings, context = {}) {
      const windowRef = deps.windowRef || globalThis;
      const section = getAdvancedTuningSection(windowRef);
      const advancedDom = getLazySectionDom('advanced');
      let disposed = false;
      if (section) context.markSectionBound?.();
      context.addCleanup?.(() => { disposed = true; section?.dispose?.(); });
      // Load the existing line renderer before building the shared skeleton.
      const ready = windowRef.rendererRuntimeLimitsView || windowRef.scriptLoaderUtils?.ensureScript?.({
        src: 'renderer/shell/renderer-runtime-limits-view.js', isReady: () => Boolean(windowRef.rendererRuntimeLimitsView),
      });
      void Promise.resolve(ready).then(() => {
        if (disposed || !section) return;
        section.bind(advancedDom, registerSectionListener);
        advancedBoundDom = advancedDom;
        context.addCleanup?.(() => { advancedBoundDom = null; });
        return section.refresh(advancedDom);
      }).catch(() => {
        const status = advancedDom.advancedTuningFields?.closest('.settings-card')?.querySelector('[data-limits-status]');
        if (!disposed && status) {
          status.textContent = jt('runtime.limits.loadFailed', 'Limits could not be loaded. Restart Jenny to try again.');
          status.hidden = false;
        }
      });
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
            state.personality.actionStatus = jt('settings.personality.saveFailed', 'Save failed: {error}', { error: toErrorMessage(error, 'unknown error') });
            renderPersonalityEditor();
          });
          return;
        }
        if (target.closest('[data-action="personality-open-folder"]')) {
          handlePersonalityOpenFolder().catch((error) => {
            state.personality.actionStatus = jt('settings.personality.openFolderFailed', 'Open folder failed: {error}', { error: toErrorMessage(error, 'unknown error') });
            renderPersonalityEditor();
          });
          return;
        }
        if (!target.closest('[data-action="personality-clear"]')) return;
        if (!confirmDialog?.confirm) {
          // Never destroy both files without a confirm: say so instead of
          // silently doing nothing when the dialog could not be built.
          state.personality.actionStatus = jt('settings.personality.clearUnavailable', 'Clear is unavailable.');
          renderPersonalityEditor();
          return;
        }
        Promise.resolve(confirmDialog.confirm({
          title: jt('settings.shell.clearPersonalityTitle', 'Clear personality?'),
          message: jt('settings.shell.clearPersonalityMessage', 'The note and About you go back to empty. Long-term notes and approved memories are not affected.'),
          confirmLabel: jt('common.clear', 'Clear'),
          cancelLabel: jt('common.cancel', 'Cancel'),
          variant: 'danger',
        })).then((confirmed) => {
          if (!confirmed) return undefined;
          return handlePersonalityReset();
        }).catch((error) => {
          state.personality.actionStatus = jt('settings.personality.clearFailed', 'Clear failed: {error}', { error: toErrorMessage(error, 'unknown error') });
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
          state.personality.actionStatus = jt('settings.personality.saveFailed', 'Save failed: {error}', { error: toErrorMessage(error, 'unknown error') });
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
          state.memoryContextFiles.actionStatus = jt('settings.memories.clearUnavailable', 'Clear is unavailable.');
          renderMemoryContextFiles();
          return;
        }
        Promise.resolve(confirmDialog.confirm({
          title: jt('settings.shell.clearLongTermNotesTitle', 'Clear long-term notes?'),
          message: jt('settings.shell.clearLongTermNotesMessage', 'The notes go back to empty. Approved memories are not affected.'),
          confirmLabel: jt('common.clear', 'Clear'),
          cancelLabel: jt('common.cancel', 'Cancel'),
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
      runtime: bindRuntime,
      runtimeLimits: bindRuntimeLimits,
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

    // The section binds once; showing it again re-reads the engine state, so a
    // lock taken during a reply does not outlive it (SW1-2 / F14).
    function advancedShown() {
      if (advancedBoundDom) void advancedTuningSection?.refresh?.(advancedBoundDom);
    }
    const sectionShownHandlers = Object.freeze({
      runtimeLimits: runtimeConsoleShown, advanced: advancedShown,
    });
    function sectionShown(sectionId) {
      sectionShownHandlers[String(sectionId || '').trim()]?.();
    }

    return {
      bindSection,
      sectionShown,
      dispose,
    };
  }

  return {
    createSettingsSectionBinders,
  };
});
