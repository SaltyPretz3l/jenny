(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('../shared/task-brief-utils'),
      require('../inventory/chip'),
      require('../inventory/action-button')
    );
    return;
  }
  root.rendererTaskSpawnChip = factory(
    root.stringUtils || {},
    root.rendererTaskBriefUtils || {},
    root.inventoryChip,
    root.inventoryActionButton
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, taskBriefUtils, inventoryChip, inventoryActionButton) {
  'use strict';

  const normalizeId = typeof stringUtils.normalizeId === 'function'
    ? stringUtils.normalizeId
    : function fallbackNormalizeId(value) { return String(value || '').trim(); };
  const fallbackEscapeHtml = typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : function escapeFallback(value) { return String(value == null ? '' : value); };
  const bindings = new WeakMap();
  let linkedSessionResolver = null;

  function logUnavailable() {
    globalThis.console?.error?.('Task action unavailable.');
  }

  function getLinkedSessionId(taskId) {
    if (typeof linkedSessionResolver !== 'function') return '';
    try {
      return normalizeId(linkedSessionResolver(taskId));
    } catch (_error) {
      return '';
    }
  }

  function renderTaskSpawnChipStrip(viewModel, options) {
    const metadata = viewModel?.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || metadata.result_kind !== 'task_board'
      || metadata.action !== 'add'
      || metadata.status !== 'ok') {
      return '';
    }
    const taskId = normalizeId(metadata.task_id);
    if (!taskId || typeof inventoryChip !== 'function' || typeof inventoryActionButton !== 'function') {
      return '';
    }
    const escapeHtml = typeof options?.escapeHtml === 'function' ? options.escapeHtml : fallbackEscapeHtml;
    const taskTitle = normalizeId(metadata.task_title) || 'Task';
    const resolveLinkedSession = typeof options?.getLinkedSessionId === 'function'
      ? options.getLinkedSessionId
      : null;
    const linkedSessionId = (() => {
      try {
        return normalizeId(resolveLinkedSession?.(taskId));
      } catch (_error) {
        return '';
      }
    })();
    const titleChip = inventoryChip({
      label: taskTitle,
      className: 'jenny-task-spawn-title',
    });
    const action = (label, kind, dataset) => inventoryActionButton({
      plain: true,
      className: 'jenny-task-spawn-action',
      label,
      dataset: { 'jenny-task-spawn': kind, 'task-id': taskId, ...dataset },
    });
    if (linkedSessionId) {
      return `<div class="jenny-task-spawn-strip jenny-task-spawn-strip--used" data-task-id="${escapeHtml(taskId)}">`
        + titleChip
        + '<span class="jenny-task-spawn-state">Session drafted</span>'
        + action('Open session', 'open', { 'session-id': linkedSessionId })
        + action('Mark done', 'done')
        + '</div>';
    }
    const showAction = typeof globalThis.rendererTaskRailActions?.open === 'function'
      ? action('Show in Tasks', 'show')
      : '';
    return `<div class="jenny-task-spawn-strip" data-task-id="${escapeHtml(taskId)}">`
      + titleChip
      + action('Start a session', 'start', { 'task-title': taskTitle })
      + showAction
      + '</div>';
  }

  function bindTaskSpawnChip(container, deps) {
    if (!container || typeof container.addEventListener !== 'function') return;
    const nextDeps = deps || {};
    bindings.set(container, nextDeps);
    linkedSessionResolver = typeof nextDeps.getLinkedSessionId === 'function'
      ? nextDeps.getLinkedSessionId
      : null;
    if (container.dataset.taskSpawnChipBound === 'true') return;
    container.dataset.taskSpawnChipBound = 'true';
    container.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-jenny-task-spawn]');
      if (!button || !container.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      const strip = button.closest?.('.jenny-task-spawn-strip');
      if (strip?.dataset?.taskSpawnBusy === 'true') return;
      const currentDeps = bindings.get(container) || {};
      const kind = normalizeId(button.dataset?.jennyTaskSpawn);
      const taskId = normalizeId(button.dataset?.taskId);
      const taskTitle = normalizeId(button.dataset?.taskTitle) || 'Task';
      let operation;
      try {
        if (kind === 'start') {
          const taskSessionActions = globalThis.rendererTaskSessionActions;
          const buildTaskBrief = taskBriefUtils?.buildTaskBrief;
          if (typeof taskSessionActions?.start !== 'function' || typeof buildTaskBrief !== 'function') {
            throw new Error('unavailable');
          }
          if (strip) strip.dataset.taskSpawnBusy = 'true';
          operation = taskSessionActions.start({
            title: taskTitle,
            initialPrompt: buildTaskBrief({ title: taskTitle, body: currentDeps.getTaskNotes?.(taskId) || '' }, { linkedTaskId: taskId }),
            linkedTaskId: taskId,
          });
        } else if (kind === 'show') {
          const taskRailActions = globalThis.rendererTaskRailActions;
          if (typeof taskRailActions?.open !== 'function') throw new Error('unavailable');
          operation = taskRailActions.open(taskId);
        } else if (kind === 'open') {
          if (typeof currentDeps.activateWorkspaceSession !== 'function') throw new Error('unavailable');
          operation = currentDeps.activateWorkspaceSession(normalizeId(button.dataset?.sessionId));
        } else if (kind === 'done') {
          const companion = globalThis.window?.jennyShell?.companion;
          if (typeof companion?.resolveFollowUp !== 'function') throw new Error('unavailable');
          operation = Promise.resolve(companion.resolveFollowUp(taskId)).then(() => {
            globalThis.rendererTaskBoard?.notifyMutation?.();
          });
        } else {
          throw new Error('unavailable');
        }
      } catch (_error) {
        if (strip) delete strip.dataset.taskSpawnBusy;
        logUnavailable();
        return;
      }
      void Promise.resolve(operation)
        .catch(logUnavailable)
        .finally(() => {
          if (strip) delete strip.dataset.taskSpawnBusy;
        });
    });
  }

  return {
    renderTaskSpawnChipStrip,
    bindTaskSpawnChip,
    getLinkedSessionId,
  };
});
