(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  const api = factory();
  const mount = function () {
    if (root.__rendererPlanDocumentController) return;
    root.__rendererPlanDocumentController = api.createPlanDocumentController({ windowRef: root });
  };
  if (root.document?.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  root.addEventListener?.('pagehide', () => root.__rendererPlanDocumentController?.dispose?.(), { once: true });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  function createPlanDocumentController({ windowRef, documentRef, actionButton, textField } = {}) {
    const win = windowRef || (typeof window !== 'undefined' ? window : null);
    const doc = documentRef || win?.document;
    const button = actionButton || win?.inventoryActionButton;
    const field = textField || win?.inventoryTextField;
    let disposed = false;
    const cleanups = new Map();
    const planStates = new Map();
    const focusedProposalRefs = new Map();
    // Keyed by approval ref; a row re-render rebuilds the DOM from the plan document.
    const sectionFolds = new Map();
    const drafts = new Map();
    let editSequence = 0;

    function remember(map, key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > 100) map.delete(map.keys().next().value);
    }

    const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
      || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
    const planDocument = globalThis.rendererPlanDocument
      || (typeof require === 'function' ? require('../features/renderer-plan-document') : null);

    function planChanged(state) {
      return state.working.title !== state.original.title
        || state.working.steps.length !== state.original.steps.length
        || state.working.steps.some((step, index) => step !== state.original.steps[index]);
    }

    function syncEditedState(host, state) {
      state.edited = planChanged(state);
      if (state.edited) remember(drafts, state.ref, { original: state.original, working: state.working });
      else drafts.delete(state.ref);
      const chip = host.querySelector('[data-plan-edited]');
      if (chip) chip.hidden = !state.edited;
    }

    function updateStepMeta(host, state) {
      const meta = host.querySelector('.plan-document__meta');
      if (!meta) return;
      const suffix = state.filesReadCount ? ` · ${jt('artifacts.plan.filesRead', '{count} files read', { count: state.filesReadCount })}` : '';
      meta.textContent = jtn('chat.planDocument.stepCount', state.working.steps.length, { count: state.working.steps.length, suffix }, '{count} steps{suffix}', '{count} steps{suffix}');
    }

    function beginInputEdit(target, value, maxLength, onFinish) {
      if (!target || target.querySelector('input')) return;
      target.innerHTML = field({ id: `plan-edit-${++editSequence}`, label: '', value, maxLength,
        ariaLabel: maxLength === 120 ? jt('chat.planDocument.editTitle', 'Edit plan title') : jt('chat.planDocument.editStep', 'Edit plan step'),
        className: 'plan-document__inline-field', dataset: { 'plan-edit-input': '' } });
      const input = target.querySelector('[data-plan-edit-input]');
      if (!input) return;
      input.classList.add('plan-document__edit-input');
      let finished = false;
      const finish = (cancelled) => {
        if (finished) return;
        finished = true;
        onFinish(cancelled ? null : input.value);
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(true);
        }
      });
      input.addEventListener('blur', () => finish(false), { once: true });
      input.focus();
      input.select();
    }

    function editTitle(host, state) {
      const title = host.querySelector('[data-plan-title]');
      const previous = state.working.title;
      beginInputEdit(title, previous, 120, (rawValue) => {
        const next = rawValue == null ? previous : String(rawValue).trim().slice(0, 120);
        state.working.title = next || previous;
        title.textContent = state.working.title;
        syncEditedState(host, state);
      });
    }

    function renderStepControls(container) {
      container.innerHTML = button({ label: '', trustedHtml: '&#10239;', ariaLabel: jt('chat.planDocument.reorderStep', 'Reorder step'), title: jt('chat.planDocument.dragToReorderStep', 'Drag to reorder step'), plain: true,
        className: 'plan-document__step-control plan-document__drag-handle',
        dataset: { 'plan-drag-handle': '' } })
        + button({ label: '', trustedHtml: '&times;', ariaLabel: jt('chat.planDocument.removeStep', 'Remove step'), title: jt('chat.planDocument.removeThisStep', 'Remove this step'), plain: true,
          className: 'plan-document__step-control plan-document__remove-step',
          dataset: { 'plan-remove-step': '' } });
    }

    function editStep(host, state, index) {
      const text = host.querySelector(`[data-plan-step-index="${index}"] [data-plan-step-text]`);
      const previous = state.working.steps[index] || '';
      beginInputEdit(text, previous, 300, (rawValue) => {
        const next = rawValue == null ? previous : String(rawValue).trim().slice(0, 300);
        if (!next && state.working.steps.length > 1) state.working.steps.splice(index, 1);
        else state.working.steps[index] = next || previous;
        renderSteps(host, state);
      });
    }

    function renderSteps(host, state, editIndex = -1) {
      const list = host.querySelector('.plan-document__steps');
      if (!list) return;
      list.innerHTML = '';
      state.working.steps.forEach((step, index) => {
        const item = doc.createElement('li');
        item.draggable = true;
        item.dataset.planStepIndex = String(index);
        const text = doc.createElement('span');
        text.className = 'plan-document__step-text';
        text.dataset.planStepText = '';
        text.tabIndex = 0;
        text.setAttribute('role', 'button');
        text.setAttribute('aria-label', jt('chat.planDocument.editStepNumber', 'Edit step {number}', { number: index + 1 }));
        text.dataset.planStepRaw = step;
        text.innerHTML = planDocument.planStepInnerMarkup(step, escapeHtml);
        const controls = doc.createElement('span');
        controls.className = 'plan-document__step-controls';
        controls.dataset.planStepControls = '';
        renderStepControls(controls);
        item.append(text, controls);
        list.append(item);
      });
      updateStepMeta(host, state);
      syncEditedState(host, state);
      const addButton = host.querySelector('[data-plan-add-step-button]');
      if (addButton) addButton.disabled = state.working.steps.length >= 20;
      if (editIndex >= 0) editStep(host, state, editIndex);
    }

    function addStep(host, state) {
      if (state.working.steps.length >= 20) return;
      state.working.steps.push('');
      renderSteps(host, state, state.working.steps.length - 1);
    }

    function removeStep(host, state, index) {
      if (state.working.steps.length <= 1) return;
      state.working.steps.splice(index, 1);
      renderSteps(host, state);
    }

    function installPlanEditing(host, state) {
      const addHost = host.querySelector('[data-plan-add-step]');
      if (addHost) addHost.innerHTML = button({ label: jt('chat.planDocument.addStep', '+ Add step'), variant: 'ghost', size: 'sm',
        className: 'plan-document__add-step-button', dataset: { 'plan-add-step-button': '' } });
      renderSteps(host, state);
      let dragIndex = -1;
      const list = host.querySelector('.plan-document__steps');
      const onHostClick = (event) => {
        if (host.dataset.planSubmitting === 'true') return;
        const remove = event.target.closest('[data-plan-remove-step]');
        if (remove) {
          removeStep(host, state, Number(remove.closest('li')?.dataset.planStepIndex));
          return;
        }
        if (event.target.closest('[data-plan-add-step-button]')) {
          addStep(host, state);
          return;
        }
        const title = event.target.closest('[data-plan-title]');
        if (title) {
          editTitle(host, state);
          return;
        }
        const step = event.target.closest('[data-plan-step-text]');
        if (step) editStep(host, state, Number(step.closest('li')?.dataset.planStepIndex));
      };
      const onHostKeydown = (event) => {
        if (!['Enter', ' '].includes(event.key) || event.target.matches('input, button')) return;
        const editable = event.target.closest('[data-plan-title], [data-plan-step-text]');
        if (!editable) return;
        event.preventDefault();
        editable.click();
      };
      const onDragStart = (event) => {
        const item = event.target.closest('li[data-plan-step-index]');
        if (!item || !list.contains(item)) return;
        dragIndex = Number(item.dataset.planStepIndex);
        item.classList.add('plan-document__step--dragging');
        event.dataTransfer?.setData('text/plain', String(dragIndex));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      };
      const onDragOver = (event) => {
        if (dragIndex < 0 || !event.target.closest('li[data-plan-step-index]')) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      };
      const onDrop = (event) => {
        const target = event.target.closest('li[data-plan-step-index]');
        if (dragIndex < 0 || !target || !list.contains(target)) return;
        event.preventDefault();
        const targetIndex = Number(target.dataset.planStepIndex);
        if (targetIndex !== dragIndex) {
          const [step] = state.working.steps.splice(dragIndex, 1);
          state.working.steps.splice(targetIndex, 0, step);
          renderSteps(host, state);
        }
        dragIndex = -1;
      };
      const onDragEnd = () => {
        dragIndex = -1;
        list.querySelectorAll('.plan-document__step--dragging')
          .forEach((item) => item.classList.remove('plan-document__step--dragging'));
      };
      const listeners = [[host, 'click', onHostClick], [host, 'keydown', onHostKeydown], [list, 'dragstart', onDragStart],
        [list, 'dragover', onDragOver], [list, 'drop', onDrop], [list, 'dragend', onDragEnd]];
      listeners.forEach(([node, name, fn]) => node?.addEventListener(name, fn));
      return () => listeners.forEach(([node, name, fn]) => node?.removeEventListener(name, fn));
    }

    function settle(host, decision, feedback = '') {
      const ref = String(host.dataset.approvalRef || '').trim();
      if (!ref || !win?.jennyShell?.tools?.approve) return Promise.resolve(false);
      host.querySelectorAll('.plan-document__edit-input').forEach((input) => input.blur());
      const state = planStates.get(host);
      const payload = { decision, feedback };
      if (state?.edited) payload.plan = { title: state.working.title, steps: [...state.working.steps] };
      const setDisabled = (disabled) => host.querySelectorAll('button, input, textarea').forEach((control) => { control.disabled = disabled; });
      host.dataset.planSubmitting = 'true';
      setDisabled(true);
      return Promise.resolve(win.jennyShell.tools.approve(ref, payload))
        .then((accepted) => {
          if (!accepted) throw new Error('Plan decision was already resolved.');
          drafts.delete(ref);
          return true;
        })
        .catch((error) => {
          host.dataset.planSubmitting = 'false';
          setDisabled(false);
          const status = host.querySelector('.plan-document__decision');
          if (status) status.dataset.error = String(error?.message || error || 'Plan decision failed').slice(0, 240);
          return false;
        });
    }

    function mount(host) {
      if (disposed || cleanups.has(host) || host.dataset.planState !== 'pending') return;
      const actions = host.querySelector('[data-plan-actions]');
      if (!actions || typeof button !== 'function' || typeof field !== 'function') return;
      const ref = String(host.dataset.approvalRef || '').trim();
      const titleEl = host.querySelector('[data-plan-title]');
      const title = titleEl?.textContent?.trim() || jt('chat.planDocument.defaultTitle', 'Implementation plan');
      const steps = [...host.querySelectorAll('[data-plan-step-text]')]
        .map((step) => (step.dataset.planStepRaw ?? step.textContent).trim()).filter(Boolean);
      const filesReadCount = Number(host.querySelector('.plan-document__meta')?.dataset.planFilesReadCount);
      const state = {
        ref, original: { title, steps: [...steps] }, working: { title, steps: [...steps] },
        edited: false, filesReadCount: Number.isInteger(filesReadCount) && filesReadCount > 0 ? filesReadCount : 0,
      };
      // Models can reuse tool call ids, so a draft applies only to the plan it was made from.
      const draft = drafts.get(ref);
      if (draft && JSON.stringify(draft.original) === JSON.stringify(state.original)) {
        state.working = { title: draft.working.title, steps: [...draft.working.steps] };
        if (titleEl) titleEl.textContent = state.working.title;
      }
      planStates.set(host, state);
      const removeEditing = installPlanEditing(host, state);
      actions.innerHTML = '<span class="plan-document__actions-group">'
        + button({ label: jt('chat.planDocument.keepPlanning', 'Keep planning'), variant: 'ghost', size: 'sm', dataset: { 'plan-decision': 'feedback' } })
        + button({ label: jt('chat.planDocument.looksGoodNotYet', 'Looks good, not yet'), variant: 'ghost', size: 'sm', dataset: { 'plan-decision': 'accepted' } })
        + '</span><span class="plan-document__actions-group">'
        + button({ label: jt('chat.planDocument.buildWithoutAsking', 'Build it, auto mode'), variant: 'secondary', size: 'sm', dataset: { 'plan-decision': 'approved_auto' } })
        + button({ label: jt('chat.planDocument.buildIt', 'Build it'), variant: 'primary', size: 'sm', dataset: { 'plan-decision': 'approved' } })
        + '</span>';
      const onClick = (event) => {
        const target = event.target.closest('[data-plan-decision]');
        if (!target || !actions.contains(target) || host.dataset.planSubmitting === 'true') return;
        const decision = target.dataset.planDecision;
        if (decision === 'feedback') {
          actions.innerHTML = field({ id: `plan-feedback-${String(host.dataset.approvalRef || 'plan').replace(/[^A-Za-z0-9_-]/g, '-')}`,
            label: jt('chat.planDocument.feedbackLabel', 'What should change?'), placeholder: jt('chat.planDocument.feedbackPlaceholder', 'Optional feedback'), maxLength: 800,
            dataset: { 'plan-feedback': '' } })
            + button({ label: jt('chat.planDocument.keepPlanning', 'Keep planning'), variant: 'primary', size: 'sm', dataset: { 'plan-decision': 'rejected' } });
          actions.querySelector('[data-plan-feedback]')?.focus();
          return;
        }
        const feedback = actions.querySelector('[data-plan-feedback]')?.value || '';
        // Only a revision carries the placeholder.
        void settle(host, decision, feedback.trim() || (decision === 'rejected' ? '<no feedback given>' : ''));
      };
      actions.addEventListener('click', onClick);
      const saved = ref ? sectionFolds.get(ref) : null;
      if (saved) {
        host.querySelectorAll('details[data-plan-section]').forEach((details) => {
          details.open = saved[details.dataset.planSection] ?? details.open;
        });
      }
      // `toggle` does not bubble.
      const onSectionToggle = (event) => {
        const details = event.target.closest('details[data-plan-section]');
        if (!ref || !details) return;
        remember(sectionFolds, ref, { ...(sectionFolds.get(ref) || {}), [details.dataset.planSection]: details.open });
      };
      host.addEventListener('toggle', onSectionToggle, true);
      cleanups.set(host, () => {
        // A removed input never blurs: commit an open edit.
        host.querySelectorAll('.plan-document__edit-input').forEach((input) => input.dispatchEvent(new win.Event('blur')));
        actions.removeEventListener('click', onClick);
        host.removeEventListener('toggle', onSectionToggle, true);
        removeEditing();
        planStates.delete(host);
      });
      if (!focusedProposalRefs.has(ref)) {
        actions.querySelector('[data-plan-decision="approved"]')?.focus({ preventScroll: true });
        if (ref) remember(focusedProposalRefs, ref, true);
      }
    }

    // Only the latest plan offers "Build it" on its accepted receipt.
    function syncBuildAcceptedSlots() {
      const documents = timeline ? [...timeline.querySelectorAll('[data-plan-document]')] : [];
      const latest = documents[documents.length - 1] || null;
      documents.forEach((host) => {
        const slot = host.querySelector('[data-plan-build-accepted]');
        if (!slot || typeof button !== 'function') return;
        const live = host === latest && host.dataset.planState === 'accepted';
        if (!live) { slot.innerHTML = ''; return; }
        if (slot.querySelector('[data-action="plan-build-accepted"]')) return;
        slot.innerHTML = button({ id: 'plan-build-accepted', label: jt('artifacts.plan.buildAccepted', 'Build it'),
          variant: 'ghost', size: 'sm', className: 'plan-document-receipt__build',
          dataset: { 'plan-id': slot.dataset.planId || '' } });
      });
    }

    function scan(rootNode) {
      if (disposed || !rootNode) return false;
      const hosts = [...(rootNode.matches?.('[data-plan-document]') ? [rootNode] : []),
        ...(rootNode.querySelectorAll?.('[data-plan-document]') || [])];
      hosts.forEach(mount);
      return hosts.length > 0;
    }

    function unmountTree(rootNode) {
      if (!rootNode) return false;
      const hosts = [];
      if (rootNode.matches?.('[data-plan-document]')) hosts.push(rootNode);
      rootNode.querySelectorAll?.('[data-plan-document]').forEach((host) => hosts.push(host));
      hosts.forEach((host) => {
        cleanups.get(host)?.();
        cleanups.delete(host);
      });
      return hosts.length > 0;
    }

    const timeline = doc?.getElementById('chatTimeline');
    const observer = timeline && typeof win?.MutationObserver === 'function'
      ? new win.MutationObserver((records) => {
          let touched = false;
          records.forEach((record) => {
            record.removedNodes.forEach((node) => { touched = unmountTree(node) || touched; });
            record.addedNodes.forEach((node) => { touched = scan(node) || touched; });
          });
          if (touched && !disposed) syncBuildAcceptedSlots();
        })
      : null;
    observer?.observe(timeline, { childList: true, subtree: true });
    scan(timeline);
    syncBuildAcceptedSlots();

    return {
      dispose() {
        disposed = true;
        observer?.disconnect();
        for (const cleanup of cleanups.values()) cleanup();
        cleanups.clear();
        planStates.clear();
        focusedProposalRefs.clear();
        sectionFolds.clear();
        drafts.clear();
      },
    };
  }

  return { createPlanDocumentController };
});
