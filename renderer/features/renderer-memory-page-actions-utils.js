(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(globalThis); return; }
  root.rendererMemoryPageActionsUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // Settings › Memory page actions added in row 58 W4: scope tabs, the ⋯ menu,
  // always-on, Forgotten (restore, erase, clear the list), History undo,
  // "Why did Jenny remember this?", Markdown export and the notes files.
  // Edit, Forget and the pending group stay in renderer-memory-actions-utils.js.
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const GENERAL_PROJECT_ID = 'project_general';
  const OPEN_SOURCE_ATTEMPTS = 12;
  const OPEN_SOURCE_RETRY_MS = 120;

  function createMemoryPageActions(deps) {
    const { state, getHubDom = () => ({}), helpers = {}, callbacks = {}, constants = {} } = deps || {};
    const { TOAST_SOURCE = {} } = constants;
    const {
      showToastMessage = () => '',
      showShellErrorToast = () => {},
      dismissToast = () => {},
      toErrorMessage = (error) => String(error?.message || error || ''),
      openSession = async () => {},
      scrollMessageIntoView = () => false,
      setTimeoutImpl = (fn, ms) => root.setTimeout(fn, ms),
    } = callbacks;
    const {
      getApprovedMemoryById = () => null,
      renderMemorySurfaces = () => {},
      refreshApprovedMemories = async () => ({}),
      refreshMemoryStatus = async () => ({}),
      startEditing = () => {},
      forgetMemory = () => {},
      revisionOptions = () => ({}),
    } = helpers;
    let disposed = false;
    const busyArchived = new Set();
    const busyOperations = new Set();
    let archivedGeneration = 0;
    let operationsGeneration = 0;

    const memoryApi = () => root.window?.jennyShell?.memory || root.jennyShell?.memory || null;
    const manager = () => state.memoryManager;
    const scope = () => manager().scopeTab || GENERAL_PROJECT_ID;
    const source = TOAST_SOURCE.memory;

    function toastError(error, fallback, key) {
      if (disposed) return;
      showShellErrorToast(toErrorMessage(error, fallback), { title: jt('memory.page.actionFailed', 'Memory Action Failed'), source, dedupeKey: `${source}:page:${key}` });
    }

    function toastOk(message, key) {
      if (disposed) return '';
      return showToastMessage(message, { tone: 'success', source, dedupeKey: `${source}:page:${key}` });
    }

    function confirmToast(message, title, confirmLabel, key, onConfirm) {
      let toastId = '';
      toastId = showToastMessage(message, {
        title, tone: 'warning', sticky: true, source, dedupeKey: `${source}:confirm:${key}`,
        actions: [
          { id: 'confirm', label: confirmLabel, kind: 'danger', onClick: () => { dismissToast(toastId); onConfirm(); } },
          { id: 'cancel', label: jt('common.cancel', 'Cancel'), kind: 'secondary', onClick: () => dismissToast(toastId) },
        ],
      });
    }

    async function loadArchived() {
      const api = memoryApi();
      if (disposed || typeof api?.listArchived !== 'function') return;
      const projectId = scope();
      const generation = ++archivedGeneration;
      manager().archivedLoading = true;
      try {
        const result = await api.listArchived({ projectId });
        if (disposed || generation !== archivedGeneration) return;
        const normalize = root.rendererMemorySharedUtils?.normalizeApprovedMemory || ((row) => row);
        manager().archivedByScope.set(projectId, (Array.isArray(result?.memories) ? result.memories : []).map(normalize).filter(Boolean));
      } catch (_error) {
        if (!disposed && generation === archivedGeneration) manager().archivedByScope.set(projectId, []);
      } finally {
        if (!disposed && generation === archivedGeneration) {
          manager().archivedLoading = false;
          renderMemorySurfaces();
        }
      }
    }

    async function loadOperations() {
      const api = memoryApi();
      if (disposed || typeof api?.listOperations !== 'function') return;
      const projectId = scope();
      const generation = ++operationsGeneration;
      manager().operationsLoading = true;
      try {
        const result = await api.listOperations({ projectId });
        if (disposed || generation !== operationsGeneration) return;
        manager().operationsByScope.set(projectId, Array.isArray(result?.operations) ? result.operations.slice(0, 50) : []);
      } catch (_error) {
        if (!disposed && generation === operationsGeneration) manager().operationsByScope.set(projectId, []);
      } finally {
        if (!disposed && generation === operationsGeneration) {
          manager().operationsLoading = false;
          renderMemorySurfaces();
        }
      }
    }

    // Folds that are open reload with the tab and after every change.
    function refreshFolds() {
      const work = [];
      if (manager().forgottenOpen) work.push(loadArchived());
      if (manager().historyOpen) work.push(loadOperations());
      return Promise.all(work);
    }

    async function afterChange() {
      await Promise.all([refreshApprovedMemories({ force: true }), refreshMemoryStatus({ force: true }), refreshFolds()]);
    }

    function selectScope(projectId) {
      const next = String(projectId || '').trim() || GENERAL_PROJECT_ID;
      manager().scopeTabChosen = true;
      if (next === scope()) return;
      manager().scopeTab = next;
      manager().editingMemoryId = null;
      manager().approvedVisibleLimit = 200;
      renderMemorySurfaces();
      refreshFolds();
      const tab = getHubDom().memorySection?.querySelector?.(`[data-memory-scope="${next}"]`);
      try { tab?.focus?.({ preventScroll: true }); } catch (_error) { tab?.focus?.(); }
    }

    function toggleFold(foldId, trigger) {
      const opening = trigger?.getAttribute?.('aria-expanded') !== 'true';
      if (foldId === 'memoryForgottenFold') {
        manager().forgottenOpen = opening;
        if (opening) loadArchived();
      } else if (foldId === 'memoryHistoryFold') {
        manager().historyOpen = opening;
        if (opening) loadOperations();
      }
    }

    async function setAlwaysOn(memoryId, checked) {
      const memory = getApprovedMemoryById(memoryId);
      const api = memoryApi();
      if (!memory || typeof api?.setAlwaysOn !== 'function') return;
      manager().pendingActionById.set(memory.id, 'always-on');
      renderMemorySurfaces();
      try {
        const result = await api.setAlwaysOn({ projectId: memory.project_id || GENERAL_PROJECT_ID, memoryId: memory.id, alwaysOn: checked, ...revisionOptions(memory) });
        if (disposed) return;
        if (result?.status === 'refused' && result.reason === 'always_on_full') {
          showToastMessage(jt('memory.page.alwaysOnFull', 'Always-on memories are full. Turn one off first, or shorten one.'), { title: jt('memory.page.alwaysOnFullTitle', 'No Room Left'), tone: 'warning', source, dedupeKey: `${source}:always-on-full` });
        } else if (result?.status === 'conflict') {
          showToastMessage(jt('memory.toasts.editConflict', 'This memory changed somewhere else, so your edit wasn\'t saved. Check the latest version and save again.'), { title: jt('memory.titles.changed', 'Memory Changed'), tone: 'warning', source, dedupeKey: `${source}:conflict:${memory.id}` });
        } else if (result?.status !== 'saved') {
          throw new Error(jt('memory.page.alwaysOnFailed', 'Could not change always-on for this memory.'));
        }
      } catch (error) {
        toastError(error, jt('memory.page.alwaysOnFailed', 'Could not change always-on for this memory.'), `always-on:${memory.id}`);
      } finally {
        if (!disposed) {
          manager().pendingActionById.delete(memory.id);
          await afterChange();
        }
      }
    }

    function eraseMemory(memoryId, archived) {
      const rows = archived ? (manager().archivedByScope.get(scope()) || []) : manager().memories;
      const memory = rows.find((row) => row.id === Number(memoryId));
      const api = memoryApi();
      if (!memory || typeof api?.erase !== 'function') return;
      confirmToast(
        jt('memory.page.eraseConfirm', 'Erase “{text}” for good? This can’t be undone.', { text: memory.lesson_text.slice(0, 80) }),
        jt('memory.page.eraseTitle', 'Erase Memory'),
        jt('memory.page.eraseNow', 'Erase now'),
        `erase:${memory.id}`,
        async () => {
          busyArchived.add(memory.id);
          renderMemorySurfaces();
          try {
            const result = await api.erase({ projectId: memory.project_id || GENERAL_PROJECT_ID, memoryId: memory.id });
            if (disposed) return;
            if (result?.status !== 'erased' && result?.status !== 'not_found') throw new Error(jt('memory.page.eraseFailed', 'Could not erase this memory.'));
            toastOk(jt('memory.page.erased', 'Memory erased.'), `erased:${memory.id}`);
          } catch (error) {
            toastError(error, jt('memory.page.eraseFailed', 'Could not erase this memory.'), `erase:${memory.id}`);
          } finally {
            busyArchived.delete(memory.id);
            if (!disposed) await afterChange();
          }
        });
    }

    const RESTORE_REFUSALS = Object.freeze({
      already_remembered: () => jt('memory.page.restoreDuplicate', 'Jenny already remembers this.'),
      always_on_full: () => jt('memory.page.restoreAlwaysOnFull', 'Always-on memories are full. Turn one off, then restore this.'),
      capacity: () => jt('memory.page.restoreCapacity', 'Memory is full. Forget or erase something, then restore this.'),
      project_archived: () => jt('memory.page.restoreProjectDeleted', 'Its project was deleted, so this can’t be restored. You can still erase it.'),
      session_purged: () => jt('memory.page.restoreChatDeleted', 'Its chat was deleted, so this can’t be restored. You can still erase it.'),
    });

    // `target` ({ id, name }): restore a deleted project's row into that project.
    async function restoreMemory(memoryId, target = null) {
      const memory = (manager().archivedByScope.get(scope()) || []).find((row) => row.id === Number(memoryId));
      const api = memoryApi();
      if (!memory || typeof api?.restore !== 'function') return;
      busyArchived.add(memory.id);
      renderMemorySurfaces();
      try {
        const request = { projectId: memory.project_id || GENERAL_PROJECT_ID, memoryId: memory.id };
        if (target) request.targetProjectId = target.id;
        const result = await api.restore(request);
        if (disposed) return;
        // The sidecar refuses a restore that would duplicate, overfill always-on,
        // exceed capacity, or land in a deleted project or chat; each reads as
        // its own plain sentence.
        const refusal = result?.status === 'refused' ? RESTORE_REFUSALS[result.reason] : null;
        if (result?.duplicate === true || refusal) {
          showToastMessage((refusal || RESTORE_REFUSALS.already_remembered)(), { tone: 'warning', source, dedupeKey: `${source}:restore-refused:${memory.id}` });
        } else if (result?.status !== 'saved') {
          throw new Error(jt('memory.errors.restore', 'Could not restore memory.'));
        } else if (target) {
          toastOk(jt('memory.toasts.restoredTo', 'Restored to {project}.', { project: target.name }), `restored:${memory.id}`);
        } else {
          toastOk(jt('memory.toasts.restored', 'Memory restored.'), `restored:${memory.id}`);
        }
      } catch (error) {
        toastError(error, jt('memory.errors.restore', 'Could not restore memory.'), `restore:${memory.id}`);
      } finally {
        busyArchived.delete(memory.id);
        if (!disposed) await afterChange();
      }
    }

    function clearForgotten() {
      const api = memoryApi();
      if (typeof api?.clearForgotten !== 'function') return;
      const projectId = scope();
      confirmToast(
        jt('memory.page.clearForgottenConfirm', 'Let Jenny save forgotten texts again if they come up? Forgotten memories stay here until you restore or erase them.'),
        jt('memory.page.clearForgotten', 'Clear forgotten list'),
        jt('memory.page.clearForgottenAction', 'Clear list'),
        `clear-forgotten:${projectId}`,
        async () => {
          try {
            const result = await api.clearForgotten({ projectId });
            if (disposed) return;
            if (result?.ok !== true) throw new Error(jt('memory.page.clearForgottenFailed', 'Could not clear the forgotten list.'));
            toastOk(jt('memory.page.clearedForgotten', 'Forgotten list cleared.'), `cleared:${projectId}`);
          } catch (error) {
            toastError(error, jt('memory.page.clearForgottenFailed', 'Could not clear the forgotten list.'), `clear:${projectId}`);
          }
        });
    }

    async function undoOperation(operationId) {
      const api = memoryApi();
      if (!operationId || typeof api?.undoChange !== 'function' || busyOperations.has(operationId)) return;
      busyOperations.add(operationId);
      renderMemorySurfaces();
      try {
        const result = await api.undoChange(operationId, scope());
        if (disposed) return;
        if (result?.status === 'conflict') {
          showToastMessage(jt('memory.page.undoConflict', 'This memory changed since then, so the change can’t be undone.'), { tone: 'warning', source, dedupeKey: `${source}:undo-conflict:${operationId}` });
        } else if (result?.status !== 'saved') {
          throw new Error(jt('memory.page.undoFailed', 'Could not undo this change.'));
        } else {
          toastOk(jt('memory.page.undone', 'Change undone.'), `undone:${operationId}`);
        }
      } catch (error) {
        toastError(error, jt('memory.page.undoFailed', 'Could not undo this change.'), `undo:${operationId}`);
      } finally {
        busyOperations.delete(operationId);
        if (!disposed) await afterChange();
      }
    }

    // Opens the chat a memory came from at its first source message.
    async function openSource(memoryId) {
      const memory = getApprovedMemoryById(memoryId);
      const sessionId = String(memory?.session_id || '').trim();
      if (!sessionId) return;
      const messageId = String(memory.source_message_ids?.[0] || '').trim();
      try {
        await openSession(sessionId);
      } catch (error) {
        toastError(error, jt('memory.page.sourceUnavailable', 'That chat can’t be opened.'), `why:${memoryId}`);
        return;
      }
      if (!messageId) return;
      const attempt = (count) => {
        if (disposed) return;
        if (scrollMessageIntoView(messageId, { block: 'center', followLatest: false })) return;
        if (count < OPEN_SOURCE_ATTEMPTS) setTimeoutImpl(() => attempt(count + 1), OPEN_SOURCE_RETRY_MS);
      };
      attempt(0);
    }

    function showMenu(memoryId, trigger) {
      const memory = getApprovedMemoryById(memoryId);
      const menu = root.inventoryContextMenu;
      if (!memory || typeof menu?.show !== 'function') return;
      trigger.setAttribute('aria-expanded', 'true');
      menu.show({
        rootEl: getHubDom().memorySection,
        anchorEl: trigger,
        restoreFocusTo: trigger,
        ariaLabel: jt('memory.page.moreActions', 'More actions for this memory'),
        onHide: () => { if (trigger.isConnected !== false) trigger.setAttribute('aria-expanded', 'false'); },
        items: [
          { label: jt('common.edit', 'Edit'), action: () => startEditing(memory.id) },
          { label: jt('memory.page.forget', 'Forget'), action: () => forgetMemory(memory.id) },
          { separator: true },
          { label: jt('memory.page.eraseMenu', 'Erase now…'), danger: true, action: () => eraseMemory(memory.id, false) },
        ],
      });
    }

    // General first, then every live project but the deleted one on screen.
    function restoreTargets() {
      const projects = Array.isArray(manager().projects) ? manager().projects : [];
      const others = projects.filter((project) => project.id && project.name && project.id !== GENERAL_PROJECT_ID && project.id !== scope());
      return [{ id: GENERAL_PROJECT_ID, name: jt('projects.switcher.generalName', 'General') }, ...others];
    }

    function showRestoreMenu(memoryId, trigger) {
      const menu = root.inventoryContextMenu;
      if (typeof menu?.show !== 'function') return;
      trigger.setAttribute('aria-expanded', 'true');
      menu.show({
        rootEl: getHubDom().memorySection,
        anchorEl: trigger,
        restoreFocusTo: trigger,
        ariaLabel: jt('memory.page.restoreToMenu', 'Restore to project'),
        onHide: () => { if (trigger.isConnected !== false) trigger.setAttribute('aria-expanded', 'false'); },
        items: restoreTargets().map((target) => ({ label: target.name, action: () => restoreMemory(memoryId, target) })),
      });
    }

    async function exportMarkdown() {
      const api = memoryApi();
      if (typeof api?.exportMarkdown !== 'function') return;
      try {
        const result = await api.exportMarkdown({ projectId: null, title: jt('memory.page.exportTitle', 'Export memories') });
        if (disposed) return;
        if (result?.ok !== true) throw new Error(jt('memory.page.exportFailed', 'Could not export memories.'));
        // A canceled save dialog is not an error and needs no toast.
        if (result.saved !== true) return;
        toastOk(jt('memory.page.exported', 'Memories exported.'), 'exported');
      } catch (error) {
        toastError(error, jt('memory.page.exportFailed', 'Could not export memories.'), 'export');
      }
    }

    async function openFile(name) {
      const api = memoryApi();
      if (typeof api?.openContextFile !== 'function') return;
      try {
        const result = await api.openContextFile({ name });
        if (!disposed && result?.ok !== true) throw new Error(jt('memory.page.openFileFailed', 'Could not open {file}.', { file: name }));
      } catch (error) {
        toastError(error, jt('memory.page.openFileFailed', 'Could not open {file}.', { file: name }), `open:${name}`);
      }
    }

    // Returns true when the click belonged to the page actions.
    function handleClick(event) {
      const tab = event.target.closest?.('[data-memory-scope]');
      if (tab) { selectScope(tab.dataset.memoryScope); return true; }
      const fold = event.target.closest?.('[data-memory-fold]');
      if (fold) { toggleFold(fold.dataset.memoryFold, fold); return true; }
      const toggle = event.target.closest?.('[data-inv-toggle^="memoryAlwaysOn-"]');
      if (toggle) {
        event.preventDefault();
        setAlwaysOn(Number(toggle.dataset.invToggle.slice('memoryAlwaysOn-'.length)), toggle.getAttribute('aria-checked') !== 'true');
        return true;
      }
      const control = event.target.closest?.('[data-memory-page-action]');
      if (!control) return false;
      const action = control.dataset.memoryPageAction;
      const memoryId = Number(control.dataset.memoryId);
      if (action === 'menu') showMenu(memoryId, control);
      else if (action === 'why') openSource(memoryId);
      else if (action === 'restore') restoreMemory(memoryId);
      else if (action === 'restore-to') showRestoreMenu(memoryId, control);
      else if (action === 'erase') eraseMemory(memoryId, true);
      else if (action === 'clear-forgotten') clearForgotten();
      else if (action === 'undo-operation') undoOperation(control.dataset.operationId);
      else if (action === 'export') exportMarkdown();
      else if (action === 'open-file') openFile(control.dataset.file);
      else return false;
      return true;
    }

    // Arrow keys move between scope tabs (roving tab stop).
    function handleKeydown(event) {
      const tab = event.target.closest?.('[data-memory-scope]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
      const tabs = [...(tab.parentElement?.querySelectorAll?.('[data-memory-scope]') || [])];
      const index = tabs.indexOf(tab);
      const rtl = root.document?.dir === 'rtl';
      const step = (event.key === 'ArrowRight') !== rtl ? 1 : -1;
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + step + tabs.length) % tabs.length];
      event.preventDefault();
      if (next) selectScope(next.dataset.memoryScope);
      return true;
    }

    function dispose() {
      disposed = true;
      archivedGeneration += 1;
      operationsGeneration += 1;
    }

    return { handleClick, handleKeydown, refreshFolds, isArchivedBusy: (id) => busyArchived.has(id), busyOperationIds: () => new Set(busyOperations), dispose };
  }

  return { createMemoryPageActions };
});
