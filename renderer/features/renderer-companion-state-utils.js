(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCompanionStateUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function toPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function normalizeAction(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const type = String(value.type || '').trim();
    const label = String(value.label || '').trim();
    if (!type || !label) {
      return null;
    }
    const followUpId = String(value.followUpId || '').trim();
    return {
      id: String(value.id || `${type}:${followUpId || label}`).trim(),
      type,
      label,
      prompt: String(value.prompt || '').trim(),
      section: String(value.section || '').trim(),
      viewId: String(value.viewId || '').trim(),
      sessionId: String(value.sessionId || '').trim(),
      followUpId,
      reminderId: String(value.reminderId || '').trim(),
    };
  }

  function normalizeWorkspaceSnapshot(value) {
    const source = toPlainObject(value);
    const status =
      source.workspaceRootStatus
      && typeof source.workspaceRootStatus === 'object'
      && !Array.isArray(source.workspaceRootStatus)
        ? {
            state: String(source.workspaceRootStatus.state || 'missing').trim() || 'missing',
            message: String(source.workspaceRootStatus.message || '').trim(),
          }
        : {
            state: 'missing',
            message: 'No workspace root is configured yet.',
          };
    return {
      workspaceRoot: String(source.workspaceRoot || '').trim(),
      workspaceRootStatus: status,
      activeSessionId: String(source.activeSessionId || '').trim(),
      openSessionIds: Array.isArray(source.openSessionIds)
        ? source.openSessionIds.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
      sessionCount: Math.max(0, Number(source.sessionCount || 0) || 0),
    };
  }

  function normalizeItem(value) {
    const source = toPlainObject(value);
    return {
      id: String(source.id || '').trim(),
      label: String(source.label || '').trim(),
      value: String(source.value || '').trim(),
    };
  }

  function normalizeReminder(value) {
    const source = toPlainObject(value);
    return {
      id: String(source.id || '').trim(),
      label: String(source.label || '').trim() || 'Reminder',
      prompt: String(source.prompt || '').trim(),
      action: normalizeAction(source.action),
    };
  }

  function normalizeLoop(value) {
    const source = toPlainObject(value);
    const hasExplicitContextLine = Object.prototype.hasOwnProperty.call(source, 'contextLine');
    const explicitActions = Array.isArray(source.actions)
      ? source.actions.map((entry) => normalizeAction(entry)).filter(Boolean)
      : [];
    const primaryAction = normalizeAction(source.action);
    const actions = explicitActions.length
      ? explicitActions
      : primaryAction
        ? [primaryAction]
        : [];
    return {
      id: String(source.id || '').trim(),
      kind: String(source.kind || '').trim() || 'note',
      status: String(source.status || '').trim() || 'active',
      title: String(source.title || '').trim() || 'Open loop',
      body: String(source.body || '').trim(),
      followUpId: String(source.followUpId || '').trim(),
      sessionId: String(source.sessionId || '').trim(),
      sessionTitle: String(source.sessionTitle || '').trim(),
      sessionBadge: String(source.sessionBadge || '').trim(),
      sourceBadge: String(source.sourceBadge || '').trim(),
      contextLine: hasExplicitContextLine
        ? String(source.contextLine || '').trim()
        : String(source.sourceLabel || '').trim(),
      sourceLabel: String(source.sourceLabel || '').trim(),
      deferredUntil: String(source.deferredUntil || '').trim(),
      deferPreset: String(source.deferPreset || '').trim(),
      archivedAt: String(source.archivedAt || '').trim(),
      timingLabel: String(source.timingLabel || '').trim(),
      isDue: source.isDue === true,
      action: actions[0] || null,
      actions,
      history: Array.isArray(source.history)
        ? source.history
          .map((entry) => {
            const item = toPlainObject(entry);
            const kind = String(item.kind || '').trim();
            const at = String(item.at || '').trim();
            if (!kind || !at) {
              return null;
            }
            return {
              kind,
              at,
              detail: String(item.detail || '').trim(),
            };
          })
          .filter(Boolean)
        : [],
    };
  }

  function normalizeLoopCount(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue >= 0
      ? Math.floor(numericValue)
      : 0;
  }

  function normalizeOpenLoopsBoard(value, fallback) {
    const source = toPlainObject(value);
    const fallbackSource = toPlainObject(fallback);
    const active = Array.isArray(source.active)
      ? source.active.map((entry) => normalizeLoop(entry))
      : Array.isArray(fallbackSource.openLoops)
        ? fallbackSource.openLoops.map((entry) => normalizeLoop(entry))
        : [];
    const deferred = Array.isArray(source.deferred)
      ? source.deferred.map((entry) => normalizeLoop(entry))
      : Array.isArray(fallbackSource.deferredLoops)
        ? fallbackSource.deferredLoops.map((entry) => normalizeLoop(entry))
        : [];
    const recentResolved = Array.isArray(source.recentResolved)
      ? source.recentResolved.map((entry) => normalizeLoop(entry))
      : [];
    const archived = Array.isArray(source.archived)
      ? source.archived.map((entry) => normalizeLoop(entry))
      : [];
    const countsSource = toPlainObject(source.counts);
    const fallbackSummary = toPlainObject(fallbackSource.openLoopSummary);
    return {
      active,
      deferred,
      recentResolved,
      archived,
      counts: {
        active: normalizeLoopCount(countsSource.active ?? fallbackSummary.activeCount ?? active.length),
        deferred: normalizeLoopCount(countsSource.deferred ?? fallbackSummary.deferredCount ?? deferred.length),
        recentResolved: normalizeLoopCount(countsSource.recentResolved ?? recentResolved.length),
        archived: normalizeLoopCount(countsSource.archived ?? archived.length),
      },
    };
  }

  function normalizeTodayCardItem(value) {
    const source = toPlainObject(value);
    return {
      label: String(source.label || '').trim(),
      detail: String(source.detail || '').trim(),
      action: normalizeAction(source.action),
    };
  }

  function normalizeTodayCard(value) {
    const source = toPlainObject(value);
    return {
      id: String(source.id || '').trim(),
      title: String(source.title || '').trim() || 'Today',
      items: Array.isArray(source.items)
        ? source.items
          .map((entry) => normalizeTodayCardItem(entry))
          .filter((entry) => entry.label)
        : [],
    };
  }

  function normalizeDeferPreset(value) {
    const source = toPlainObject(value);
    const preset = String(source.preset || '').trim();
    const label = String(source.label || '').trim();
    if (!preset || !label) {
      return null;
    }
    return {
      preset,
      label,
      deferredUntil: String(source.deferredUntil || '').trim(),
    };
  }

  function normalizeHomeFocus(value) {
    const source = toPlainObject(value);
    const kind = String(source.kind || '').trim();
    const title = String(source.title || '').trim();
    if (!kind || !title) {
      return null;
    }
    const primaryAction = normalizeAction(source.primaryAction);
    return {
      id: String(source.id || `focus:${kind}:${title}`).trim(),
      kind,
      label: String(source.label || '').trim(),
      title,
      meta: String(source.meta || '').trim(),
      state: String(source.state || kind).trim(),
      primaryAction,
      secondaryActions: Array.isArray(source.secondaryActions)
        ? source.secondaryActions.map((entry) => normalizeAction(entry)).filter(Boolean)
        : [],
    };
  }

  function normalizeWorkspaceGit(value) {
    const source = toPlainObject(value);
    return {
      available: source.available === true,
      branch: String(source.branch || '').trim(),
      recentCommits: Array.isArray(source.recentCommits)
        ? source.recentCommits.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 5)
        : [],
      summary: String(source.summary || '').trim(),
    };
  }

  function normalizeCompanionState(payload) {
    const source = toPlainObject(payload);
    const modeMeta = toPlainObject(source.modeMeta);
    const briefing = toPlainObject(source.briefing);
    const openLoopSummary = toPlainObject(source.openLoopSummary);
    const openLoopsBoard = normalizeOpenLoopsBoard(source.openLoopsBoard, source);
    return {
      loaded: source.loaded !== false,
      mode: String(source.mode || 'planner').trim() || 'planner',
      modeMeta: {
        key: String(modeMeta.key || source.mode || 'planner').trim() || 'planner',
        label: String(modeMeta.label || 'Planner').trim() || 'Planner',
        description: String(modeMeta.description || '').trim(),
        homePrompt: String(modeMeta.homePrompt || '').trim(),
        secondaryPrompts: Array.isArray(modeMeta.secondaryPrompts)
          ? modeMeta.secondaryPrompts.map((entry) => String(entry || '').trim()).filter(Boolean)
          : [],
      },
      briefing: {
        dateKey: String(briefing.dateKey || '').trim(),
        dateLabel: String(briefing.dateLabel || '').trim(),
        timeZone: String(briefing.timeZone || '').trim(),
        items: Array.isArray(briefing.items) ? briefing.items.map((entry) => normalizeItem(entry)) : [],
      },
      todayCards: Array.isArray(source.todayCards)
        ? source.todayCards.map((entry) => normalizeTodayCard(entry)).filter((entry) => entry.items.length)
        : [],
      reminders: Array.isArray(source.reminders) ? source.reminders.map((entry) => normalizeReminder(entry)) : [],
      homeFocus: normalizeHomeFocus(source.homeFocus),
      openLoopsBoard,
      openLoops: openLoopsBoard.active.slice(),
      deferredLoops: openLoopsBoard.deferred.slice(),
      openLoopSummary: {
        activeCount: normalizeLoopCount(openLoopSummary.activeCount ?? openLoopsBoard.counts.active),
        deferredCount: normalizeLoopCount(openLoopSummary.deferredCount ?? openLoopsBoard.counts.deferred),
      },
      availableDeferPresets: Array.isArray(source.availableDeferPresets)
        ? source.availableDeferPresets.map((entry) => normalizeDeferPreset(entry)).filter(Boolean)
        : [],
      suggestedActions: Array.isArray(source.suggestedActions)
        ? source.suggestedActions.map((entry) => normalizeAction(entry)).filter(Boolean)
        : [],
      workspaceSnapshot: normalizeWorkspaceSnapshot(source.workspaceSnapshot),
      workspaceGit: normalizeWorkspaceGit(source.workspaceGit),
    };
  }

  return {
    normalizeCompanionState,
  };
});
