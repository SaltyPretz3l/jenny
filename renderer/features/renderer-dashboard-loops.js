/* Companion-host dashboard widgets — thin hosts that ADOPT existing
 * companion-owned panels into dashboard cards. The panel subtrees are moved,
 * never rebuilt: the companion manager's element references stay live, its
 * #homeView-rooted event delegation still covers the panels (the dashboard
 * grid lives inside #homeView), and the Memory Hub Commitments mirror keeps
 * reading the same follow-up data. No IPC or schema changes.
 *   - open-loops: #homeOpenLoopsPanel (board + add/edit form)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardLoops = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TASK_SESSION_ACTION_PREFIX = 'start_task_session:';

  function findTaskLoop(state, actionId) {
    const board = state?.companion?.openLoopsBoard || {};
    for (const section of ['active', 'deferred', 'recentResolved', 'archived']) {
      const loop = (Array.isArray(board[section]) ? board[section] : []).find((entry) =>
        entry?.actions?.some?.((action) => action?.id === actionId)
      );
      if (loop) return loop;
    }
    return null;
  }

  function buildTaskBrief(loop, options) {
    const sharedBuildTaskBrief = globalThis.rendererTaskBriefUtils?.buildTaskBrief;
    if (typeof sharedBuildTaskBrief === 'function') return sharedBuildTaskBrief(loop, options);
    const title = String(loop?.title || '').trim();
    const notes = String(loop?.body || '').trim();
    return notes ? `${title}\n\n${notes}` : title;
  }

  function bindTaskSessionAction(panel, getState) {
    if (panel.dataset.taskSessionActionBound === 'true') return;
    panel.dataset.taskSessionActionBound = 'true';
    panel.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-companion-action-id]');
      const actionId = String(button?.dataset?.companionActionId || '');
      if (!actionId.startsWith(TASK_SESSION_ACTION_PREFIX)) return;
      const loop = findTaskLoop(getState(), actionId);
      const start = globalThis.rendererTaskSessionActions?.start;
      event.preventDefault();
      event.stopPropagation();
      if (!loop || typeof start !== 'function') {
        globalThis.console?.error?.('Task session unavailable.');
        return;
      }
      void Promise.resolve(start({
        title: loop.title,
        initialPrompt: buildTaskBrief(loop, { linkedTaskId: loop.followUpId }),
        ...(loop.followUpId ? { linkedTaskId: loop.followUpId } : {}),
      }))
        .catch(() => globalThis.console?.error?.('Task session creation failed.'));
    });
  }

  function createAdoptedPanelWidget({ id, panelId, unavailableCopy }) {
    let latestState = null;
    return {
      id,
      // No card title: the adopted panel brings its own header.
      title: '',
      render(body, ctx) {
        latestState = ctx?.state || latestState;
        if (!body) {
          return;
        }
        const documentRef = ctx?.documentRef || null;
        const panel = documentRef?.getElementById?.(panelId) || null;
        if (!panel) {
          body.innerHTML = `<div class="dashboard-empty-note">${unavailableCopy}</div>`;
          return;
        }
        if (panel.parentNode !== body) {
          body.textContent = '';
          body.append(panel);
          panel.hidden = false;
        }
        bindTaskSessionAction(panel, () => latestState);
      },
    };
  }

  function createOpenLoopsWidget() {
    return createAdoptedPanelWidget({
      id: 'open-loops',
      panelId: 'homeOpenLoopsPanel',
      unavailableCopy: 'Open Loops are unavailable.',
    });
  }

  return {
    buildTaskBrief,
    createOpenLoopsWidget,
  };
});
