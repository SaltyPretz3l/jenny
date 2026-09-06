function createDefaultCompanionState() {
  return {
    mode: 'planner',
    modeMeta: {
      key: 'planner',
      label: 'Planner',
      description: 'Jenny leans toward structure, priorities, and gentle sequencing.',
      homePrompt: 'Help me turn today into a simple plan with the right next steps.',
    },
    briefing: {
      dateKey: '2026-03-19',
      dateLabel: 'Thursday, March 19',
      timeZone: 'America/Chicago',
      items: [
        {
          id: 'mode',
          label: 'Current Mode',
          value: 'Planner: Jenny leans toward structure, priorities, and gentle sequencing.',
        },
      ],
    },
    todayCards: [],
    followUps: [],
    reminders: [],
    openLoops: [],
    deferredLoops: [],
    openLoopsBoard: {
      active: [],
      deferred: [],
      recentResolved: [],
      archived: [],
      counts: {
        active: 0,
        deferred: 0,
        recentResolved: 0,
        archived: 0,
      },
    },
    openLoopSummary: {
      activeCount: 0,
      deferredCount: 0,
    },
    availableDeferPresets: [
      { preset: 'later_today', label: 'Later today', deferredUntil: '2026-03-19T17:00:00.000Z' },
      { preset: 'tomorrow', label: 'Tomorrow', deferredUntil: '2026-03-20T09:00:00.000Z' },
      { preset: 'next_week', label: 'Next week', deferredUntil: '2026-03-26T09:00:00.000Z' },
    ],
    suggestedActions: [
      {
        id: 'prefill:planner',
        type: 'prefill_chat',
        label: 'Start in Planner Mode',
        prompt: 'Help me turn today into a simple plan with the right next steps.',
      },
    ],
    workspaceSnapshot: {
      workspaceRoot: '',
      workspaceRootStatus: {
        state: 'missing',
        message: 'No workspace root is configured yet.',
      },
      activeSessionId: '',
      openSessionIds: [],
      sessionCount: 0,
    },
  };
}

function buildSourceLabel(followUp) {
  if (String(followUp.sessionId || '').trim()) {
    return 'Linked to Session';
  }
  if (String(followUp.sourceKind || '').trim() === 'agent_task') {
    return 'Tracked from an agent task';
  }
  if (String(followUp.sourceKind || '').trim() === 'assistant_reply') {
    return 'Saved from an assistant reply';
  }
  if (String(followUp.sourceKind || '').trim() === 'proactive_suggestion') {
    return 'Saved from a proactive suggestion';
  }
  if (String(followUp.sourceKind || '').trim() === 'reminder') {
    return 'Promoted from a reminder';
  }
  if (String(followUp.sourceKind || '').trim() === 'manual') {
    return 'Saved manually';
  }
  return '';
}

function buildSourceBadge(followUp) {
  if (String(followUp.sourceKind || '').trim() === 'agent_task') {
    return 'Agent task';
  }
  if (String(followUp.sourceKind || '').trim() === 'assistant_reply') {
    return 'Assistant reply';
  }
  if (String(followUp.sourceKind || '').trim() === 'proactive_suggestion') {
    return 'Proactive suggestion';
  }
  if (String(followUp.sourceKind || '').trim() === 'reminder') {
    return 'Reminder';
  }
  if (String(followUp.sourceKind || '').trim() === 'manual') {
    return 'Manual';
  }
  return '';
}

function resolveSessionMeta(followUp, companionState) {
  const sessionId = String(followUp.sessionId || '').trim();
  if (!sessionId) {
    return {
      sessionTitle: '',
      sessionBadge: '',
      contextLine: '',
    };
  }
  const workspaceSnapshot = companionState?.workspaceSnapshot && typeof companionState.workspaceSnapshot === 'object'
    ? companionState.workspaceSnapshot
    : {};
  const activeSessionId = String(workspaceSnapshot.activeSessionId || '').trim();
  const openSessionIds = new Set(
    Array.isArray(workspaceSnapshot.openSessionIds)
      ? workspaceSnapshot.openSessionIds.map((entry) => String(entry || '').trim()).filter(Boolean)
      : []
  );
  const sourceMeta = followUp?.sourceMeta && typeof followUp.sourceMeta === 'object'
    ? followUp.sourceMeta
    : {};
  const sessionTitle = String(sourceMeta.sessionTitle || sourceMeta.sessionLabel || '').trim();
  if (sessionId === activeSessionId) {
    return {
      sessionTitle,
      sessionBadge: 'Current session',
      contextLine: '',
    };
  }
  if (openSessionIds.has(sessionId)) {
    return {
      sessionTitle,
      sessionBadge: 'Open session',
      contextLine: sessionTitle,
    };
  }
  return {
    sessionTitle,
    sessionBadge: 'Saved from session',
    contextLine: sessionTitle,
  };
}

function buildContinueAction(followUp, label = 'Resume this thread') {
  if (!String(followUp.sessionId || '').trim()) {
    return [];
  }
  return [{
    id: `continue_follow_up:${followUp.id}`,
    type: 'continue_session',
    label,
    sessionId: followUp.sessionId,
    followUpId: followUp.id,
  }];
}

function toComparableTimestamp(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.valueOf();
}

function firstComparableTimestamp(values) {
  const source = Array.isArray(values) ? values : [values];
  for (const value of source) {
    const timestamp = toComparableTimestamp(value);
    if (timestamp != null) {
      return timestamp;
    }
  }
  return null;
}

function firstRawTimeValue(values) {
  const source = Array.isArray(values) ? values : [values];
  for (const value of source) {
    const normalized = String(value || '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function compareIsoDesc(leftValue, rightValue) {
  const leftTimestamp = firstComparableTimestamp(leftValue);
  const rightTimestamp = firstComparableTimestamp(rightValue);
  if (leftTimestamp != null && rightTimestamp != null && leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }
  if (leftTimestamp != null && rightTimestamp == null) {
    return -1;
  }
  if (leftTimestamp == null && rightTimestamp != null) {
    return 1;
  }
  return firstRawTimeValue(rightValue).localeCompare(firstRawTimeValue(leftValue));
}

function compareFollowUpRecencyDesc(left, right) {
  return compareIsoDesc(
    [left?.updatedAt, left?.createdAt],
    [right?.updatedAt, right?.createdAt]
  );
}

function compareDeferredTimingAsc(left, right) {
  const leftTimestamp = firstComparableTimestamp(left?.deferredUntil);
  const rightTimestamp = firstComparableTimestamp(right?.deferredUntil);
  if (leftTimestamp != null && rightTimestamp != null && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  if (leftTimestamp != null && rightTimestamp == null) {
    return -1;
  }
  if (leftTimestamp == null && rightTimestamp != null) {
    return 1;
  }
  return firstRawTimeValue(left?.deferredUntil).localeCompare(firstRawTimeValue(right?.deferredUntil));
}

function normalizeFollowUp(followUp) {
  const source = followUp && typeof followUp === 'object' ? followUp : {};
  const status = String(source.status || '').trim().toLowerCase() || (source.resolved === true ? 'resolved' : 'active');
  const deferredUntil = String(source.deferredUntil || '').trim();
  const normalizedStatus = status === 'deferred' && !deferredUntil ? 'active' : status;
  return {
    id: String(source.id || '').trim(),
    label: String(source.label || 'Follow-up').trim() || 'Follow-up',
    body: String(source.body || '').trim(),
    status: normalizedStatus,
    createdAt: String(source.createdAt || new Date('2026-03-19T12:00:00.000Z').toISOString()).trim(),
    updatedAt: String(source.updatedAt || source.createdAt || new Date('2026-03-19T12:00:00.000Z').toISOString()).trim(),
    resolvedAt: String(source.resolvedAt || '').trim(),
    deferredUntil: normalizedStatus === 'deferred' ? deferredUntil : '',
    deferPreset: normalizedStatus === 'deferred' ? String(source.deferPreset || '').trim() : '',
    archivedAt: normalizedStatus === 'resolved' ? String(source.archivedAt || '').trim() : '',
    sessionId: String(source.sessionId || '').trim(),
    sourceKind: String(source.sourceKind || '').trim(),
    sourceId: String(source.sourceId || '').trim(),
    sourceMeta:
      source.sourceMeta && typeof source.sourceMeta === 'object' && !Array.isArray(source.sourceMeta)
        ? { ...source.sourceMeta }
        : {},
    history: Array.isArray(source.history)
      ? source.history
        .map((entry) => ({
          kind: String(entry?.kind || '').trim(),
          at: String(entry?.at || '').trim(),
          detail: String(entry?.detail || '').trim(),
        }))
        .filter((entry) => entry.kind && entry.at)
        .slice(0, 12)
      : [],
  };
}

function toActiveFollowUpLoop(followUp, companionState) {
  const sessionMeta = resolveSessionMeta(followUp, companionState);
  return {
    id: `followup:${followUp.id}`,
    kind: 'follow_up',
    status: 'active',
    title: followUp.label,
    body: followUp.body,
    followUpId: followUp.id,
    sessionId: followUp.sessionId,
    sessionTitle: sessionMeta.sessionTitle,
    sessionBadge: sessionMeta.sessionBadge,
    sourceBadge: buildSourceBadge(followUp),
    contextLine: sessionMeta.contextLine,
    sourceLabel: buildSourceLabel(followUp),
    isDue: followUp.status === 'deferred',
    timingLabel: followUp.status === 'deferred' ? 'Due now' : '',
    history: Array.isArray(followUp.history) ? followUp.history.slice(0, 12) : [],
    actions: [
      {
        id: `edit_follow_up:${followUp.id}`,
        type: 'edit_follow_up',
        label: 'Edit',
        followUpId: followUp.id,
      },
      ...buildContinueAction(followUp),
      {
        id: `resolve_follow_up:${followUp.id}`,
        type: 'resolve_follow_up',
        label: 'Done',
        followUpId: followUp.id,
      },
      {
        id: `defer_follow_up:${followUp.id}`,
        type: 'defer_follow_up',
        label: 'Later',
        followUpId: followUp.id,
      },
      {
        id: `delete_follow_up:${followUp.id}`,
        type: 'delete_follow_up',
        label: 'Delete',
        followUpId: followUp.id,
      },
    ],
  };
}

function toDeferredFollowUpLoop(followUp, companionState) {
  const sessionMeta = resolveSessionMeta(followUp, companionState);
  return {
    id: `followup:${followUp.id}`,
    kind: 'follow_up',
    status: 'deferred',
    title: followUp.label,
    body: followUp.body,
    followUpId: followUp.id,
    sessionId: followUp.sessionId,
    sessionTitle: sessionMeta.sessionTitle,
    sessionBadge: sessionMeta.sessionBadge,
    sourceBadge: buildSourceBadge(followUp),
    contextLine: sessionMeta.contextLine,
    sourceLabel: buildSourceLabel(followUp),
    deferredUntil: followUp.deferredUntil,
    deferPreset: followUp.deferPreset,
    timingLabel: followUp.deferredUntil ? `Deferred until ${new Date(followUp.deferredUntil).toLocaleString()}` : '',
    history: Array.isArray(followUp.history) ? followUp.history.slice(0, 12) : [],
    actions: [
      {
        id: `edit_follow_up:${followUp.id}`,
        type: 'edit_follow_up',
        label: 'Edit',
        followUpId: followUp.id,
      },
      {
        id: `activate_follow_up:${followUp.id}`,
        type: 'activate_follow_up',
        label: 'Make Active',
        followUpId: followUp.id,
      },
      ...buildContinueAction(followUp),
      {
        id: `delete_follow_up:${followUp.id}`,
        type: 'delete_follow_up',
        label: 'Delete',
        followUpId: followUp.id,
      },
    ],
  };
}

function toResolvedFollowUpLoop(followUp, companionState) {
  const sessionMeta = resolveSessionMeta(followUp, companionState);
  return {
    id: `followup:${followUp.id}`,
    kind: 'follow_up',
    status: 'resolved',
    title: followUp.label,
    body: followUp.body,
    followUpId: followUp.id,
    sessionId: followUp.sessionId,
    sessionTitle: sessionMeta.sessionTitle,
    sessionBadge: sessionMeta.sessionBadge,
    sourceBadge: buildSourceBadge(followUp),
    contextLine: sessionMeta.contextLine,
    sourceLabel: buildSourceLabel(followUp),
    timingLabel: followUp.resolvedAt ? `Completed ${new Date(followUp.resolvedAt).toLocaleString()}` : '',
    archivedAt: followUp.archivedAt,
    history: Array.isArray(followUp.history) ? followUp.history.slice(0, 12) : [],
    actions: [
      {
        id: `edit_follow_up:${followUp.id}`,
        type: 'edit_follow_up',
        label: 'Edit',
        followUpId: followUp.id,
      },
      {
        id: `activate_follow_up:${followUp.id}`,
        type: 'activate_follow_up',
        label: 'Reopen',
        followUpId: followUp.id,
      },
      {
        id: `archive_follow_up:${followUp.id}`,
        type: 'archive_follow_up',
        label: 'Archive',
        followUpId: followUp.id,
      },
      ...buildContinueAction(followUp),
      {
        id: `delete_follow_up:${followUp.id}`,
        type: 'delete_follow_up',
        label: 'Delete',
        followUpId: followUp.id,
      },
    ],
  };
}

function toArchivedFollowUpLoop(followUp, companionState) {
  const sessionMeta = resolveSessionMeta(followUp, companionState);
  const archivedAt = String(followUp.archivedAt || '').trim();
  return {
    id: `followup:${followUp.id}`,
    kind: 'follow_up',
    status: 'archived',
    title: followUp.label,
    body: followUp.body,
    followUpId: followUp.id,
    sessionId: followUp.sessionId,
    sessionTitle: sessionMeta.sessionTitle,
    sessionBadge: sessionMeta.sessionBadge,
    sourceBadge: buildSourceBadge(followUp),
    contextLine: sessionMeta.contextLine,
    sourceLabel: buildSourceLabel(followUp),
    timingLabel: archivedAt ? `Archived ${new Date(archivedAt).toLocaleString()}` : 'Archived',
    archivedAt,
    history: Array.isArray(followUp.history) ? followUp.history.slice(0, 12) : [],
    actions: [
      {
        id: `unarchive_follow_up:${followUp.id}`,
        type: 'unarchive_follow_up',
        label: 'Restore',
        followUpId: followUp.id,
      },
      ...buildContinueAction(followUp),
      {
        id: `delete_follow_up:${followUp.id}`,
        type: 'delete_follow_up',
        label: 'Delete',
        followUpId: followUp.id,
      },
    ],
  };
}

function syncFollowUpOpenLoops(companionState) {
  const source = companionState && typeof companionState === 'object'
    ? companionState
    : createDefaultCompanionState();
  const hasFollowUpList = Array.isArray(source.followUps);
  const followUps = hasFollowUpList ? source.followUps.map((entry) => normalizeFollowUp(entry)) : [];
  const now = new Date('2026-03-19T12:00:00.000Z');
  const activeFollowUpLoops = followUps
    .filter((followUp) => {
      if (!followUp.id || followUp.archivedAt || followUp.status === 'resolved') {
        return false;
      }
      if (followUp.status === 'deferred' && followUp.deferredUntil) {
        const deferredUntil = new Date(followUp.deferredUntil);
        return Number.isNaN(deferredUntil.valueOf()) || deferredUntil.valueOf() <= now.valueOf();
      }
      return followUp.status === 'active' || followUp.status === 'deferred';
    })
    .sort((left, right) => {
      const leftDue = left.status === 'deferred';
      const rightDue = right.status === 'deferred';
      if (leftDue !== rightDue) {
        return leftDue ? -1 : 1;
      }
      if (leftDue && rightDue) {
        const deferredCompare = compareDeferredTimingAsc(left, right);
        if (deferredCompare !== 0) {
          return deferredCompare;
        }
      }
      return compareFollowUpRecencyDesc(left, right);
    })
    .map((followUp) => toActiveFollowUpLoop(followUp, source));
  const deferredFollowUpLoops = followUps
    .filter((followUp) => {
      if (!followUp.id || followUp.archivedAt || followUp.status !== 'deferred' || !followUp.deferredUntil) {
        return false;
      }
      const deferredUntil = new Date(followUp.deferredUntil);
      return !Number.isNaN(deferredUntil.valueOf()) && deferredUntil.valueOf() > now.valueOf();
    })
    .sort(compareDeferredTimingAsc)
    .map((followUp) => toDeferredFollowUpLoop(followUp, source));
  const resolvedFollowUpLoops = followUps
    .filter((followUp) => followUp.id && followUp.status === 'resolved' && !followUp.archivedAt)
    .sort((left, right) => compareIsoDesc(
      [left?.resolvedAt, left?.updatedAt, left?.createdAt],
      [right?.resolvedAt, right?.updatedAt, right?.createdAt]
    ))
    .slice(0, 5)
    .map((followUp) => toResolvedFollowUpLoop(followUp, source));
  const archivedFollowUpLoops = followUps
    .filter((followUp) => followUp.id && followUp.status === 'resolved' && followUp.archivedAt)
    .sort((left, right) => compareIsoDesc(
      [left?.archivedAt, left?.updatedAt, left?.resolvedAt, left?.createdAt],
      [right?.archivedAt, right?.updatedAt, right?.resolvedAt, right?.createdAt]
    ))
    .map((followUp) => toArchivedFollowUpLoop(followUp, source));
  const existingBoard = source.openLoopsBoard && typeof source.openLoopsBoard === 'object'
    ? source.openLoopsBoard
    : {};
  const activeLoops = hasFollowUpList
    ? activeFollowUpLoops
    : Array.isArray(existingBoard.active)
      ? existingBoard.active.slice()
      : (Array.isArray(source.openLoops) ? source.openLoops.slice() : []);
  const deferredLoops = hasFollowUpList
    ? deferredFollowUpLoops
    : Array.isArray(existingBoard.deferred)
      ? existingBoard.deferred.slice()
      : (Array.isArray(source.deferredLoops) ? source.deferredLoops.slice() : []);
  const recentResolved = hasFollowUpList
    ? resolvedFollowUpLoops
    : (Array.isArray(existingBoard.recentResolved) ? existingBoard.recentResolved.slice() : []);
  const archived = hasFollowUpList
    ? archivedFollowUpLoops
    : (Array.isArray(existingBoard.archived) ? existingBoard.archived.slice() : []);
  return {
    ...source,
    followUps,
    openLoopsBoard: {
      active: activeLoops,
      deferred: deferredLoops,
      recentResolved,
      archived,
      counts: {
        active: activeLoops.length,
        deferred: deferredLoops.length,
        recentResolved: recentResolved.length,
        archived: archived.length,
      },
    },
    // Compatibility mirrors stay derived from the canonical board in the renderer harness too.
    openLoops: activeLoops,
    deferredLoops,
    openLoopSummary: {
      activeCount: activeLoops.length,
      deferredCount: deferredLoops.length,
    },
  };
}

function createCompanionStub(options, state) {
  return {
    async getState() {
      if (typeof options.companion?.getState === 'function') {
        const payload = await options.companion.getState({ state });
        if (payload && typeof payload === 'object') {
          state.companionState = payload;
        }
      }
      return state.companionState;
    },
    async setMode(mode) {
      if (typeof options.companion?.setMode === 'function') {
        const payload = await options.companion.setMode(mode, { state });
        if (payload && typeof payload === 'object') {
          state.companionState = payload;
        }
        return state.companionState;
      }
      state.companionState = {
        ...state.companionState,
        mode: String(mode || '').trim() || 'planner',
        modeMeta: {
          ...state.companionState.modeMeta,
          key: String(mode || '').trim() || 'planner',
          label: String(mode || '').trim() || 'planner',
        },
      };
      return state.companionState;
    },
    async addFollowUp(payload) {
      state.companionCalls.addFollowUp.push(payload);
      if (typeof options.companion?.addFollowUp === 'function') {
        const nextPayload = await options.companion.addFollowUp(payload, { state });
        if (nextPayload && typeof nextPayload === 'object') {
          state.companionState = nextPayload;
        }
        return state.companionState;
      }
      const nextFollowUp = normalizeFollowUp({
        id: String(payload?.id || `followup-${state.companionCalls.addFollowUp.length}`).trim(),
        label: String(payload?.label || 'Follow-up').trim() || 'Follow-up',
        body: String(payload?.body || '').trim(),
        status: String(payload?.status || '').trim() || (payload?.deferPreset ? 'deferred' : 'active'),
        createdAt: String(payload?.createdAt || new Date('2026-03-19T12:00:00.000Z').toISOString()).trim(),
        updatedAt: new Date('2026-03-19T12:05:00.000Z').toISOString(),
        sessionId: String(payload?.sessionId || '').trim(),
        deferredUntil:
          payload?.deferPreset === 'tomorrow'
            ? '2026-03-20T09:00:00.000Z'
            : payload?.deferPreset === 'next_week'
              ? '2026-03-26T09:00:00.000Z'
              : payload?.deferPreset === 'later_today'
                ? '2026-03-19T17:00:00.000Z'
                : String(payload?.deferredUntil || '').trim(),
        deferPreset: String(payload?.deferPreset || '').trim(),
        sourceKind: String(payload?.sourceKind || '').trim(),
        sourceId: String(payload?.sourceId || '').trim(),
        sourceMeta:
          payload?.sourceMeta && typeof payload.sourceMeta === 'object' && !Array.isArray(payload.sourceMeta)
            ? payload.sourceMeta
            : {},
      });
      state.companionState = syncFollowUpOpenLoops({
        ...state.companionState,
        followUps: [
          ...(Array.isArray(state.companionState.followUps)
            ? state.companionState.followUps.filter((followUp) => String(followUp?.id || '').trim() !== nextFollowUp.id)
            : []),
          nextFollowUp,
        ],
      });
      return state.companionState;
    },
    async updateFollowUp(id, patch) {
      state.companionCalls.updateFollowUp.push({ id, patch });
      if (typeof options.companion?.updateFollowUp === 'function') {
        const nextPayload = await options.companion.updateFollowUp(id, patch, { state });
        if (nextPayload && typeof nextPayload === 'object') {
          state.companionState = nextPayload;
        }
        return state.companionState;
      }
      const normalizedId = String(id || '').trim();
      state.companionState = syncFollowUpOpenLoops({
        ...state.companionState,
        followUps: (Array.isArray(state.companionState.followUps) ? state.companionState.followUps : []).map((followUp) => {
          if (String(followUp?.id || '').trim() !== normalizedId) {
            return followUp;
          }
          const existing = normalizeFollowUp(followUp);
          const nextPatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
          const nextStatus = existing.archivedAt || existing.status === 'resolved'
            ? existing.status
            : String(nextPatch.status || existing.status || 'active').trim();
          const nextDeferPreset = existing.archivedAt || existing.status === 'resolved'
            ? existing.deferPreset
            : String(nextPatch.deferPreset || '').trim();
          const nextDeferredUntil =
            nextStatus === 'deferred'
              ? (
                nextDeferPreset === 'tomorrow'
                  ? '2026-03-20T09:00:00.000Z'
                  : nextDeferPreset === 'next_week'
                    ? '2026-03-26T09:00:00.000Z'
                    : nextDeferPreset === 'later_today'
                      ? '2026-03-19T17:00:00.000Z'
                      : String(nextPatch.deferredUntil || existing.deferredUntil || '').trim()
              )
              : '';
          return normalizeFollowUp({
            ...existing,
            label: Object.prototype.hasOwnProperty.call(nextPatch, 'label') ? nextPatch.label : existing.label,
            body: Object.prototype.hasOwnProperty.call(nextPatch, 'body') ? nextPatch.body : existing.body,
            status: nextStatus,
            deferPreset: nextStatus === 'deferred' ? nextDeferPreset : '',
            deferredUntil: nextDeferredUntil,
            updatedAt: '2026-03-19T12:06:00.000Z',
          });
        }),
      });
      return state.companionState;
    },
    async deferFollowUp(id, preset) {
      state.companionCalls.deferFollowUp.push({ id, preset });
      if (typeof options.companion?.deferFollowUp === 'function') {
        const nextPayload = await options.companion.deferFollowUp(id, preset, { state });
        if (nextPayload && typeof nextPayload === 'object') {
          state.companionState = nextPayload;
        }
        return state.companionState;
      }
      const deferredUntil =
        preset === 'tomorrow'
          ? '2026-03-20T09:00:00.000Z'
          : preset === 'next_week'
            ? '2026-03-26T09:00:00.000Z'
            : '2026-03-19T17:00:00.000Z';
      state.companionState = syncFollowUpOpenLoops({
        ...state.companionState,
        followUps: (Array.isArray(state.companionState.followUps) ? state.companionState.followUps : []).map((followUp) =>
          String(followUp?.id || '').trim() === String(id || '').trim()
            ? normalizeFollowUp({
                ...followUp,
                status: 'deferred',
                deferredUntil,
                deferPreset: preset,
                updatedAt: '2026-03-19T12:10:00.000Z',
              })
            : followUp
        ),
      });
      return state.companionState;
    },
    async activateFollowUp(id) {
      state.companionCalls.activateFollowUp.push(id);
      if (typeof options.companion?.activateFollowUp === 'function') {
        const nextPayload = await options.companion.activateFollowUp(id, { state });
        if (nextPayload && typeof nextPayload === 'object') {
          state.companionState = nextPayload;
        }
        return state.companionState;
      }
      state.companionState = syncFollowUpOpenLoops({
        ...state.companionState,
        followUps: (Array.isArray(state.companionState.followUps) ? state.companionState.followUps : []).map((followUp) =>
          String(followUp?.id || '').trim() === String(id || '').trim()
            ? normalizeFollowUp({
                ...followUp,
                status: 'active',
                resolvedAt: '',
                deferredUntil: '',
                deferPreset: '',
                updatedAt: '2026-03-19T12:15:00.000Z',
              })
            : followUp
        ),
      });
      return state.companionState;
    },
    async resolveFollowUp(id) {
      state.companionCalls.resolveFollowUp.push(id);
      if (typeof options.companion?.resolveFollowUp === 'function') {
        const nextPayload = await options.companion.resolveFollowUp(id, { state });
        if (nextPayload && typeof nextPayload === 'object') {
          state.companionState = nextPayload;
        }
        return state.companionState;
      }
      state.companionState = syncFollowUpOpenLoops({
        ...state.companionState,
        followUps: (Array.isArray(state.companionState.followUps) ? state.companionState.followUps : []).map((followUp) =>
          String(followUp?.id || '').trim() === String(id || '').trim()
            ? normalizeFollowUp({
                ...followUp,
                status: 'resolved',
                resolvedAt: '2026-03-19T12:20:00.000Z',
                updatedAt: '2026-03-19T12:20:00.000Z',
              })
            : followUp
        ),
      });
      return state.companionState;
    },
    async archiveFollowUp(id) {
      state.companionCalls.archiveFollowUp.push(id);
      if (typeof options.companion?.archiveFollowUp === 'function') {
        const nextPayload = await options.companion.archiveFollowUp(id, { state });
        if (nextPayload && typeof nextPayload === 'object') {
          state.companionState = nextPayload;
        }
        return state.companionState;
      }
      state.companionState = syncFollowUpOpenLoops({
        ...state.companionState,
        followUps: (Array.isArray(state.companionState.followUps) ? state.companionState.followUps : []).map((followUp) =>
          String(followUp?.id || '').trim() === String(id || '').trim()
            ? normalizeFollowUp({
                ...followUp,
                status: 'resolved',
                archivedAt: '2026-03-19T12:25:00.000Z',
                updatedAt: '2026-03-19T12:25:00.000Z',
              })
            : followUp
        ),
      });
      return state.companionState;
    },
    async unarchiveFollowUp(id) {
      state.companionCalls.unarchiveFollowUp.push(id);
      if (typeof options.companion?.unarchiveFollowUp === 'function') {
        const nextPayload = await options.companion.unarchiveFollowUp(id, { state });
        if (nextPayload && typeof nextPayload === 'object') {
          state.companionState = nextPayload;
        }
        return state.companionState;
      }
      state.companionState = syncFollowUpOpenLoops({
        ...state.companionState,
        followUps: (Array.isArray(state.companionState.followUps) ? state.companionState.followUps : []).map((followUp) =>
          String(followUp?.id || '').trim() === String(id || '').trim()
            ? normalizeFollowUp({
                ...followUp,
                status: 'resolved',
                archivedAt: '',
                updatedAt: '2026-03-19T12:30:00.000Z',
              })
            : followUp
        ),
      });
      return state.companionState;
    },
    async deleteFollowUp(id) {
      state.companionCalls.deleteFollowUp.push(id);
      if (typeof options.companion?.deleteFollowUp === 'function') {
        const nextPayload = await options.companion.deleteFollowUp(id, { state });
        if (nextPayload && typeof nextPayload === 'object') {
          state.companionState = nextPayload;
        }
        return state.companionState;
      }
      state.companionState = syncFollowUpOpenLoops({
        ...state.companionState,
        followUps: (Array.isArray(state.companionState.followUps) ? state.companionState.followUps : []).filter(
          (followUp) => String(followUp?.id || '').trim() !== String(id || '').trim()
        ),
      });
      return state.companionState;
    },
  };
}

module.exports = {
  createCompanionStub,
  createDefaultCompanionState,
  syncFollowUpOpenLoops,
};
