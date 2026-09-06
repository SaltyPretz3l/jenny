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
  root.addEventListener?.('beforeunload', () => root.__rendererPlanDocumentController?.dispose?.(), { once: true });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createPlanDocumentController({ windowRef, documentRef, actionButton, textField } = {}) {
    const win = windowRef || (typeof window !== 'undefined' ? window : null);
    const doc = documentRef || win?.document;
    const button = actionButton || win?.inventoryActionButton;
    const field = textField || win?.inventoryTextField;
    let disposed = false;
    const cleanups = new Map();
    const planStates = new Map();
    const focusedProposalRefs = new Set();
    let editSequence = 0;

    function escapeHtml(value) {
      if (typeof button?.escapeHtml === 'function') return button.escapeHtml(value);
      return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function planChanged(state) {
      return state.working.title !== state.original.title
        || state.working.steps.length !== state.original.steps.length
        || state.working.steps.some((step, index) => step !== state.original.steps[index]);
    }

    function syncEditedState(host, state) {
      state.edited = planChanged(state);
      const chip = host.querySelector('[data-plan-edited]');
      if (chip) chip.hidden = !state.edited;
    }

    function renderText(target, value) {
      if (target) target.innerHTML = escapeHtml(value);
    }

    function updateStepMeta(host, state) {
      const meta = host.querySelector('.plan-document__meta');
      if (!meta) return;
      const suffix = state.metaSuffix || '';
      meta.textContent = `${state.working.steps.length} steps${suffix}`;
    }

    function beginInputEdit(target, value, maxLength, onFinish) {
      if (!target || target.querySelector('input')) return;
      target.innerHTML = field({ id: `plan-edit-${++editSequence}`, label: '', value, maxLength,
        ariaLabel: maxLength === 120 ? 'Edit plan title' : 'Edit plan step',
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
        renderText(title, state.working.title);
        syncEditedState(host, state);
      });
    }

    function renderStepControls(container) {
      container.innerHTML = button({ label: '', trustedHtml: '&#10239;', ariaLabel: 'Reorder step', title: 'Drag to reorder step', plain: true,
        className: 'plan-document__step-control plan-document__drag-handle',
        dataset: { 'plan-drag-handle': '' } })
        + button({ label: '', trustedHtml: '&times;', ariaLabel: 'Remove step', title: 'Remove this step', plain: true,
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
        text.setAttribute('aria-label', `Edit step ${index + 1}`);
        renderText(text, step);
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
      if (addHost) addHost.innerHTML = button({ label: '+ Add step', variant: 'ghost', size: 'sm',
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
      host.addEventListener('click', onHostClick);
      host.addEventListener('keydown', onHostKeydown);
      list?.addEventListener('dragstart', onDragStart);
      list?.addEventListener('dragover', onDragOver);
      list?.addEventListener('drop', onDrop);
      list?.addEventListener('dragend', onDragEnd);
      return () => {
        host.removeEventListener('click', onHostClick);
        host.removeEventListener('keydown', onHostKeydown);
        list?.removeEventListener('dragstart', onDragStart);
        list?.removeEventListener('dragover', onDragOver);
        list?.removeEventListener('drop', onDrop);
        list?.removeEventListener('dragend', onDragEnd);
      };
    }

    function settle(host, decision, feedback = '') {
      const ref = String(host.dataset.approvalRef || '').trim();
      if (!ref || !win?.jennyShell?.tools?.approve) return Promise.resolve(false);
      host.querySelectorAll('.plan-document__edit-input').forEach((input) => input.blur());
      const state = planStates.get(host);
      const payload = { decision, feedback };
      if (state?.edited) payload.plan = { title: state.working.title, steps: [...state.working.steps] };
      host.dataset.planSubmitting = 'true';
      host.querySelectorAll('button, input, textarea').forEach((control) => { control.disabled = true; });
      return Promise.resolve(win.jennyShell.tools.approve(ref, payload))
        .then((accepted) => {
          if (!accepted) throw new Error('Plan decision was already resolved.');
          return true;
        })
        .catch((error) => {
          host.dataset.planSubmitting = 'false';
          host.querySelectorAll('button, input, textarea').forEach((control) => { control.disabled = false; });
          const status = host.querySelector('.plan-document__decision');
          if (status) status.dataset.error = String(error?.message || error || 'Plan decision failed').slice(0, 240);
          return false;
        });
    }

    function mount(host) {
      if (disposed || cleanups.has(host) || host.dataset.planState !== 'pending') return;
      const actions = host.querySelector('[data-plan-actions]');
      if (!actions || typeof button !== 'function' || typeof field !== 'function') return;
      const title = host.querySelector('[data-plan-title]')?.textContent?.trim() || 'Implementation plan';
      const steps = [...host.querySelectorAll('[data-plan-step-text]')]
        .map((step) => step.textContent.trim()).filter(Boolean);
      const metaText = host.querySelector('.plan-document__meta')?.textContent || '';
      const state = {
        original: { title, steps: [...steps] }, working: { title, steps: [...steps] },
        edited: false, metaSuffix: metaText.replace(/^\d+ steps/, ''),
      };
      planStates.set(host, state);
      const removeEditing = installPlanEditing(host, state);
      actions.innerHTML = button({ label: 'Keep planning', variant: 'ghost', size: 'sm', dataset: { 'plan-decision': 'feedback' } })
        + button({ label: 'Build it', variant: 'primary', size: 'sm', dataset: { 'plan-decision': 'approved' } })
        + button({ label: "Build it, don't ask again", variant: 'secondary', size: 'sm', dataset: { 'plan-decision': 'approved_auto' } });
      const onClick = (event) => {
        const target = event.target.closest('[data-plan-decision]');
        if (!target || !actions.contains(target) || host.dataset.planSubmitting === 'true') return;
        const decision = target.dataset.planDecision;
        if (decision === 'feedback') {
          actions.innerHTML = field({ id: `plan-feedback-${String(host.dataset.approvalRef || 'plan').replace(/[^A-Za-z0-9_-]/g, '-')}`,
            label: 'What should change?', placeholder: 'Optional feedback', maxLength: 800,
            dataset: { 'plan-feedback': '' } })
            + button({ label: 'Keep planning', variant: 'primary', size: 'sm', dataset: { 'plan-decision': 'rejected' } });
          actions.querySelector('[data-plan-feedback]')?.focus();
          return;
        }
        const feedback = actions.querySelector('[data-plan-feedback]')?.value || '';
        void settle(host, decision, feedback.trim() || '<no feedback given>');
      };
      actions.addEventListener('click', onClick);
      cleanups.set(host, () => {
        actions.removeEventListener('click', onClick);
        removeEditing();
        planStates.delete(host);
      });
      const proposalRef = String(host.dataset.approvalRef || '').trim();
      if (!focusedProposalRefs.has(proposalRef)) {
        actions.querySelector('[data-plan-decision="approved"]')?.focus({ preventScroll: true });
        if (proposalRef) focusedProposalRefs.add(proposalRef);
        while (focusedProposalRefs.size > 100) {
          focusedProposalRefs.delete(focusedProposalRefs.values().next().value);
        }
      }
    }

    function scan(rootNode) {
      if (disposed || !rootNode) return;
      if (rootNode.matches?.('[data-plan-document]')) mount(rootNode);
      rootNode.querySelectorAll?.('[data-plan-document]').forEach(mount);
    }

    function unmountTree(rootNode) {
      if (!rootNode) return;
      const hosts = [];
      if (rootNode.matches?.('[data-plan-document]')) hosts.push(rootNode);
      rootNode.querySelectorAll?.('[data-plan-document]').forEach((host) => hosts.push(host));
      hosts.forEach((host) => {
        cleanups.get(host)?.();
        cleanups.delete(host);
      });
    }

    const timeline = doc?.getElementById('chatTimeline');
    const observer = timeline && typeof win?.MutationObserver === 'function'
      ? new win.MutationObserver((records) => records.forEach((record) => {
          record.removedNodes.forEach(unmountTree);
          record.addedNodes.forEach(scan);
        }))
      : null;
    observer?.observe(timeline, { childList: true, subtree: true });
    scan(timeline);

    return {
      dispose() {
        disposed = true;
        observer?.disconnect();
        for (const cleanup of cleanups.values()) cleanup();
        cleanups.clear();
        planStates.clear();
        focusedProposalRefs.clear();
      },
    };
  }

  return { createPlanDocumentController };
});
