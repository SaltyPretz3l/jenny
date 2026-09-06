const { clipText, normalizeString } = require('./backend/path-utils');
const {
  createDailyBriefingCache,
} = require('./companion-briefing-cache');
const {
  buildHomeFocus,
} = require('./companion-home-focus');
const {
  DEFAULT_COMPANION,
  getAvailableFollowUpDeferPresets,
  normalizeCompanion,
} = require('./shell-config-service');
const {
  COMPANION_MODES,
  getCompanionModeMeta,
  normalizeCompanionMode,
} = require('./companion-mode');
const {
  compareIsoDesc,
  compareFollowUpRecencyDesc,
  compareDeferredTimingAsc,
  compareResolvedTimingDesc,
  compareSessionActivityDesc,
} = require('./companion-sort-utils');
const { buildFeatureFlagDefaults } = require('./feature-flags');

const MAX_ARCHIVED_BOARD_ITEMS = 50;

// Reminders are manual Home nudges: no executor ever fires them on a
// schedule, so the persisted scheduleType/dailyAt/intervalMinutes/lastFiredAt
// fields are ignored here and no scheduleLabel/firedToday is emitted
// (UIUX-017). Do not resurface schedule or fired state without wiring a
// real scheduler first.
function normalizeReminder(reminder) {
  return {
    id: normalizeString(reminder?.id),
    label: normalizeString(reminder?.label) || 'Reminder',
    prompt: normalizeString(reminder?.prompt),
    enabled: reminder?.enabled !== false,
  };
}

function normalizeFollowUp(record) {
  const rawStatus = normalizeString(record?.status).toLowerCase();
  const status = rawStatus || (record?.resolved === true ? 'resolved' : 'active');
  return {
    id: normalizeString(record?.id),
    label: normalizeString(record?.label) || 'Follow-up',
    body: normalizeString(record?.body),
    status,
    createdAt: normalizeString(record?.createdAt),
    updatedAt: normalizeString(record?.updatedAt),
    resolvedAt: normalizeString(record?.resolvedAt),
    deferredUntil: normalizeString(record?.deferredUntil),
    deferPreset: normalizeString(record?.deferPreset).toLowerCase(),
    archivedAt: normalizeString(record?.archivedAt),
    sessionId: normalizeString(record?.sessionId),
    sourceKind: normalizeString(record?.sourceKind).toLowerCase(),
    sourceId: normalizeString(record?.sourceId),
    sourceMeta:
      record?.sourceMeta && typeof record.sourceMeta === 'object' && !Array.isArray(record.sourceMeta)
        ? { ...record.sourceMeta }
        : {},
    history: Array.isArray(record?.history)
      ? record.history
        .map((entry) => ({
          kind: normalizeString(entry?.kind).toLowerCase(),
          at: normalizeString(entry?.at),
          detail: normalizeString(entry?.detail),
        }))
        .filter((entry) => entry.kind && entry.at)
        .slice(0, 12)
      : [],
  };
}

/* Board timing labels match the dashboard's short "Jun 10" date style; bare
 * toLocaleString() renders seconds-precision timestamps nobody needs. */
function formatBoardTimingDate(parsed) {
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatBoardTimingDateTime(parsed) {
  const time = parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${formatBoardTimingDate(parsed)}, ${time}`;
}

function buildFollowUpTimingLabel(followUp) {
  const deferredUntil = normalizeString(followUp?.deferredUntil);
  if (!deferredUntil) {
    return '';
  }
  const parsed = new Date(deferredUntil);
  if (Number.isNaN(parsed.valueOf())) {
    return '';
  }
  return `Deferred until ${formatBoardTimingDateTime(parsed)}`;
}

function buildResolvedFollowUpTimingLabel(followUp) {
  const resolvedAt = normalizeString(followUp?.resolvedAt);
  if (!resolvedAt) {
    return '';
  }
  const parsed = new Date(resolvedAt);
  if (Number.isNaN(parsed.valueOf())) {
    return '';
  }
  return `Completed ${formatBoardTimingDate(parsed)}`;
}

function firstBoardAction(loop, type) {
  return (Array.isArray(loop?.actions) ? loop.actions : []).find((action) =>
    action && typeof action === 'object' && normalizeString(action.type) === type
  ) || null;
}

function firstReadyToResumeAction(loop) {
  return firstBoardAction(loop, 'continue_session')
    || firstBoardAction(loop, 'activate_follow_up')
    || firstBoardAction(loop, 'resolve_follow_up')
    || null;
}

function trimSuggestedActions(actions, workspaceRecoveryRequired) {
  if (actions.length <= 6) {
    return actions;
  }

  const protectedIds = new Set();
  if (workspaceRecoveryRequired) {
    protectedIds.add('settings:tools');
  }
  const optionalIds = workspaceRecoveryRequired
    ? ['settings:proactive']
    : ['settings:tools', 'settings:proactive'];
  const prunable = [
    ...optionalIds,
    'memory',
    'new-session',
  ];

  const working = actions.slice();
  for (const id of prunable) {
    if (working.length <= 6) break;
    const dropIndex = working.findIndex((action) => action.id === id && !protectedIds.has(action.id));
    if (dropIndex >= 0) {
      working.splice(dropIndex, 1);
    }
  }

  while (working.length > 6) {
    const dropIndex = working
      .map((action, index) => ({ action, index }))
      .reverse()
      .find(({ action }) => !protectedIds.has(action.id) && /^prefill:.*:secondary:/.test(action.id))
      ?.index;
    if (dropIndex === undefined) break;
    working.splice(dropIndex, 1);
  }

  for (let i = working.length - 1; i >= 0 && working.length > 6; i -= 1) {
    if (!protectedIds.has(working[i].id)) {
      working.splice(i, 1);
    }
  }

  return working.slice(0, 6);
}

class CompanionService {
  constructor({
    configService,
    personalityWorkspace,
    listSessionSummaries,
    listSessionRecords,
    getWorkspaceState,
    execFileImpl,
    nowProvider,
    formatDateKey,
    taskLifecycleEnabled,
    taskBoardEnabled,
  } = {}) {
    if (!configService) {
      throw new Error('configService is required for CompanionService.');
    }
    if (typeof formatDateKey !== 'function') {
      throw new Error('formatDateKey is required for CompanionService.');
    }
    this.configService = configService;
    this.personalityWorkspace = personalityWorkspace || null;
    this.listSessionSummaries = typeof listSessionSummaries === 'function'
      ? listSessionSummaries
      : () => [];
    this.listSessionRecords = typeof listSessionRecords === 'function'
      ? listSessionRecords
      : () => [];
    this.getWorkspaceState = typeof getWorkspaceState === 'function'
      ? getWorkspaceState
      : () => this.configService.getWorkspaceState();
    this.execFileImpl = execFileImpl;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.formatDateKey = formatDateKey;
    this.briefingCache = createDailyBriefingCache({ formatDateKey });
    this.taskLifecycleEnabled = typeof taskLifecycleEnabled === 'function'
      ? taskLifecycleEnabled
      : () => false;
    this.taskBoardEnabled = typeof taskBoardEnabled === 'function'
      ? taskBoardEnabled
      : () => buildFeatureFlagDefaults().tools_task_board_enabled === true;
  }

  _getModeMeta(mode) {
    return getCompanionModeMeta(mode) || COMPANION_MODES[DEFAULT_COMPANION.mode];
  }

  _getCompanionSettings() {
    const state = this.configService.getState();
    return normalizeCompanion(state.companion);
  }

  _listSessions() {
    const sessions = this.listSessionSummaries();
    return Array.isArray(sessions) ? sessions.slice() : [];
  }

  _listSessionRecords() {
    const sessions = this.listSessionRecords();
    return Array.isArray(sessions) ? sessions.slice() : [];
  }

  _isTaskLifecycleEnabled() {
    return this.taskLifecycleEnabled() === true;
  }

  _isTaskBoardEnabled() {
    return this.taskBoardEnabled() === true;
  }

  _buildReminders(configState) {
    const reminders = Array.isArray(configState?.proactive?.reminders)
      ? configState.proactive.reminders.map((reminder) => normalizeReminder(reminder))
      : [];
    return reminders
      .filter((reminder) => reminder.enabled)
      .map((reminder) => ({
        id: reminder.id,
        label: reminder.label,
        prompt: reminder.prompt,
        action: {
          id: `promote_reminder:${reminder.id}`,
          type: 'promote_reminder',
          label: 'Promote to Open Loop',
          reminderId: reminder.id,
        },
      }));
  }

  _buildRecentSessionOpenLoop(sessions, workspaceState) {
    const preferredIds = new Set([
      normalizeString(workspaceState?.activeSessionId),
      ...(Array.isArray(workspaceState?.openSessionIds) ? workspaceState.openSessionIds : []).map(
        (entry) => normalizeString(entry)
      ),
    ].filter(Boolean));
    const preferredSession = sessions.find((session) =>
      preferredIds.has(normalizeString(session?.id))
      && normalizeString(session?.last_message_preview)
    );
    const recentSession = preferredSession || sessions.find((session) =>
      normalizeString(session?.last_message_preview)
    ) || null;
    if (!recentSession) {
      return null;
    }
    return {
      id: `recent:${normalizeString(recentSession.id)}`,
      kind: 'recent_session',
      title: normalizeString(recentSession.title) || 'Continue session',
      body: clipText(recentSession.last_message_preview, 160),
      action: {
        type: 'continue_session',
        label: `Continue ${normalizeString(recentSession.title) || 'Session'}`,
        sessionId: normalizeString(recentSession.id),
      },
    };
  }

  _buildFollowUpSourceLabel(followUp, sessionTitle) {
    if (sessionTitle) {
      return `Linked to ${sessionTitle}`;
    }
    if (followUp.sourceKind === 'agent_task') {
      return 'Tracked from an agent task';
    }
    if (followUp.sourceKind === 'assistant_reply') {
      return 'Saved from an assistant reply';
    }
    if (followUp.sourceKind === 'proactive_suggestion') {
      return 'Saved from a proactive suggestion';
    }
    if (followUp.sourceKind === 'reminder') {
      return 'Promoted from a reminder';
    }
    if (followUp.sourceKind === 'manual') {
      return 'Saved manually';
    }
    return '';
  }

  _buildFollowUpSourceBadge(followUp) {
    if (followUp.sourceKind === 'agent_task') {
      return 'Agent task';
    }
    if (followUp.sourceKind === 'assistant_reply') {
      return 'Assistant reply';
    }
    if (followUp.sourceKind === 'proactive_suggestion') {
      return 'Proactive suggestion';
    }
    if (followUp.sourceKind === 'reminder') {
      return 'Reminder';
    }
    if (followUp.sourceKind === 'manual') {
      return 'Manual';
    }
    return '';
  }

  _resolveFollowUpSessionTitle(followUp, sessionById) {
    const session = sessionById.get(normalizeString(followUp.sessionId)) || null;
    const sourceMeta = followUp?.sourceMeta && typeof followUp.sourceMeta === 'object'
      ? followUp.sourceMeta
      : {};
    return normalizeString(session?.title)
      || normalizeString(sourceMeta.sessionTitle)
      || normalizeString(sourceMeta.sessionLabel)
      || '';
  }

  _buildFollowUpSessionMeta(followUp, sessionById, workspaceState) {
    const sessionId = normalizeString(followUp.sessionId);
    if (!sessionId) {
      return {
        sessionTitle: '',
        sessionBadge: '',
        contextLine: '',
      };
    }
    const activeSessionId = normalizeString(workspaceState?.activeSessionId);
    const openSessionIds = new Set(
      Array.isArray(workspaceState?.openSessionIds)
        ? workspaceState.openSessionIds.map((entry) => normalizeString(entry)).filter(Boolean)
        : []
    );
    const sessionTitle = this._resolveFollowUpSessionTitle(followUp, sessionById);
    if (sessionId && sessionId === activeSessionId) {
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

  _buildFollowUpActions(followUp, {
    primaryAction,
    afterPrimaryActions = [],
    includeEdit = false,
    includeDefer = false,
    includeContinue = false,
    includeArchive = false,
    includeUnarchive = false,
    includeDelete = true,
    continueLabel = '',
  } = {}) {
    const actions = [];
    if (includeEdit) {
      actions.push({
        id: `edit_follow_up:${followUp.id}`,
        type: 'edit_follow_up',
        label: 'Edit',
        followUpId: normalizeString(followUp.id),
      });
    }
    if (followUp.sourceKind === 'agent_task' && this._isTaskBoardEnabled()) {
      actions.push({
        id: `start_task_session:${followUp.id}`,
        type: 'start_task_session',
        label: 'Start a session',
        followUpId: normalizeString(followUp.id),
      });
    }
    if (primaryAction) {
      actions.push(primaryAction);
    }
    if (Array.isArray(afterPrimaryActions)) {
      for (const action of afterPrimaryActions) {
        if (action && typeof action === 'object') {
          actions.push(action);
        }
      }
    }
    if (includeDefer) {
      actions.push({
        id: `defer_follow_up:${followUp.id}`,
        type: 'defer_follow_up',
        label: 'Later',
        followUpId: normalizeString(followUp.id),
      });
    }
    const hasContinueAction = actions.some((action) => action?.type === 'continue_session');
    if (includeContinue && normalizeString(followUp.sessionId) && !hasContinueAction) {
      actions.push({
        id: `continue_follow_up:${followUp.id}`,
        type: 'continue_session',
        label: continueLabel || `Continue ${normalizeString(followUp.sessionId) || 'Session'}`,
        sessionId: normalizeString(followUp.sessionId),
        followUpId: normalizeString(followUp.id),
      });
    }
    if (includeArchive) {
      actions.push({
        id: `archive_follow_up:${followUp.id}`,
        type: 'archive_follow_up',
        label: 'Archive',
        followUpId: normalizeString(followUp.id),
      });
    }
    if (includeUnarchive) {
      actions.push({
        id: `unarchive_follow_up:${followUp.id}`,
        type: 'unarchive_follow_up',
        label: 'Restore',
        followUpId: normalizeString(followUp.id),
      });
    }
    if (includeDelete) {
      actions.push({
        id: `delete_follow_up:${followUp.id}`,
        type: 'delete_follow_up',
        label: 'Delete',
        followUpId: normalizeString(followUp.id),
      });
    }
    return actions;
  }

  _buildFollowUpBoard(configState, sessions, workspaceState) {
    const now = this.nowProvider();
    const normalizedNow = now instanceof Date && !Number.isNaN(now.valueOf()) ? now : new Date();
    const sessionById = new Map(
      (Array.isArray(sessions) ? sessions : []).map((session) => [
        normalizeString(session?.id),
        session,
      ]).filter(([id]) => id)
    );
    const followUps = Array.isArray(configState?.followUps)
      ? configState.followUps
        .map((followUp) => normalizeFollowUp(followUp))
        .filter((followUp) => followUp.id)
      : [];
    const activeFollowUps = [];
    const deferredFollowUps = [];
    const resolvedFollowUps = [];
    const archivedFollowUps = [];
    for (const followUp of followUps) {
      if (followUp.archivedAt) {
        archivedFollowUps.push({
          ...followUp,
          dueNow: false,
        });
        continue;
      }
      if (followUp.status === 'resolved') {
        resolvedFollowUps.push({
          ...followUp,
          dueNow: false,
        });
        continue;
      }
      if (followUp.status === 'deferred') {
        const deferredUntil = new Date(followUp.deferredUntil);
        if (!followUp.deferredUntil || Number.isNaN(deferredUntil.valueOf()) || deferredUntil.valueOf() <= normalizedNow.valueOf()) {
          activeFollowUps.push({
            ...followUp,
            dueNow: true,
          });
        } else {
          deferredFollowUps.push({
            ...followUp,
            dueNow: false,
          });
        }
        continue;
      }
      activeFollowUps.push({
        ...followUp,
        dueNow: false,
      });
    }
    activeFollowUps.sort((left, right) => {
      if (left.dueNow !== right.dueNow) {
        return left.dueNow ? -1 : 1;
      }
      if (left.dueNow && right.dueNow) {
        const deferredCompare = compareDeferredTimingAsc(left, right);
        if (deferredCompare !== 0) {
          return deferredCompare;
        }
      }
      return compareFollowUpRecencyDesc(left, right);
    });
    deferredFollowUps.sort(compareDeferredTimingAsc);
    resolvedFollowUps.sort(compareResolvedTimingDesc);
    archivedFollowUps.sort((left, right) =>
      compareIsoDesc(
        [left?.archivedAt, left?.updatedAt, left?.resolvedAt, left?.createdAt],
        [right?.archivedAt, right?.updatedAt, right?.resolvedAt, right?.createdAt]
      )
    );

    const toBoardItem = (
      followUp,
      { status, timingLabel = '', primaryAction, afterPrimaryActions = [], includeDefer = false } = {}
    ) => {
      const {
        sessionTitle,
        sessionBadge,
        contextLine,
      } = this._buildFollowUpSessionMeta(followUp, sessionById, workspaceState);
      const sourceBadge = this._buildFollowUpSourceBadge(followUp);
      const sessionLabel = sessionTitle || 'Session';
      return {
        id: `followup:${followUp.id}`,
        kind: 'follow_up',
        status,
        title: normalizeString(followUp.label) || 'Follow-up',
        body: normalizeString(followUp.body),
        followUpId: normalizeString(followUp.id),
        sessionId: normalizeString(followUp.sessionId),
        sessionTitle,
        sessionBadge,
        sourceBadge,
        contextLine,
        sourceKind: normalizeString(followUp.sourceKind),
        sourceId: normalizeString(followUp.sourceId),
        sourceLabel: this._buildFollowUpSourceLabel(followUp, sessionTitle || (normalizeString(followUp.sessionId) ? sessionLabel : '')),
        deferredUntil: normalizeString(followUp.deferredUntil),
        deferPreset: normalizeString(followUp.deferPreset),
        archivedAt: normalizeString(followUp.archivedAt),
        isDue: followUp.dueNow === true,
        timingLabel,
        actions: this._buildFollowUpActions(followUp, {
          includeEdit: true,
          primaryAction,
          afterPrimaryActions,
          includeDefer,
          includeContinue: Boolean(normalizeString(followUp.sessionId)),
          continueLabel: normalizeString(followUp.sessionId) ? 'Resume this thread' : '',
          includeArchive: status === 'resolved',
          includeUnarchive: status === 'archived',
          includeDelete: true,
        }),
        history: Array.isArray(followUp.history) ? followUp.history.slice(0, 12) : [],
      };
    };

    const active = activeFollowUps.map((followUp) => {
      const followUpId = normalizeString(followUp.id);
      const sessionId = normalizeString(followUp.sessionId);
      const resolveAction = {
        id: `resolve_follow_up:${followUp.id}`,
        type: 'resolve_follow_up',
        label: 'Done',
        followUpId,
      };
      return toBoardItem(followUp, {
        status: 'active',
        timingLabel: followUp.dueNow ? 'Due now' : '',
        includeDefer: true,
        primaryAction: sessionId
          ? {
              id: `continue_follow_up:${followUp.id}`,
              type: 'continue_session',
              label: 'Resume this thread',
              sessionId,
              followUpId,
            }
          : resolveAction,
        afterPrimaryActions: sessionId ? [resolveAction] : [],
      });
    });
    const deferred = deferredFollowUps.map((followUp) => toBoardItem(followUp, {
      status: 'deferred',
      timingLabel: buildFollowUpTimingLabel(followUp),
      primaryAction: {
        id: `activate_follow_up:${followUp.id}`,
        type: 'activate_follow_up',
        label: 'Make Active',
        followUpId: normalizeString(followUp.id),
      },
    }));
    const recentResolved = resolvedFollowUps.slice(0, 5).map((followUp) => toBoardItem(followUp, {
      status: 'resolved',
      timingLabel: buildResolvedFollowUpTimingLabel(followUp),
      primaryAction: {
        id: `activate_follow_up:${followUp.id}`,
        type: 'activate_follow_up',
        label: 'Reopen',
        followUpId: normalizeString(followUp.id),
      },
    }));
    const archived = archivedFollowUps.slice(0, MAX_ARCHIVED_BOARD_ITEMS).map((followUp) => toBoardItem(followUp, {
      status: 'archived',
      timingLabel: normalizeString(followUp.archivedAt)
        ? `Archived ${formatBoardTimingDate(new Date(followUp.archivedAt))}`
        : 'Archived',
      primaryAction: {
        id: `unarchive_follow_up:${followUp.id}`,
        type: 'unarchive_follow_up',
        label: 'Restore',
        followUpId: normalizeString(followUp.id),
      },
    }));

    return {
      active,
      deferred,
      recentResolved,
      archived,
      counts: {
        active: active.length,
        deferred: deferred.length,
        recentResolved: recentResolved.length,
        archived: archivedFollowUps.length,
      },
    };
  }

  _buildActiveTurnResumeItems(sessionRecords, workspaceState) {
    if (!this._isTaskLifecycleEnabled()) {
      return [];
    }
    const activeSessionId = normalizeString(workspaceState?.activeSessionId);
    const openSessionIds = new Set(
      Array.isArray(workspaceState?.openSessionIds)
        ? workspaceState.openSessionIds.map((entry) => normalizeString(entry)).filter(Boolean)
        : []
    );
    return (Array.isArray(sessionRecords) ? sessionRecords : [])
      .map((session) => {
        const activeTurn =
          session?.active_turn && typeof session.active_turn === 'object' && !Array.isArray(session.active_turn)
            ? session.active_turn
            : null;
        if (!activeTurn) {
          return null;
        }
        const sessionId = normalizeString(session?.id);
        if (!sessionId) {
          return null;
        }
        const sessionTitle = normalizeString(session?.title) || 'Current work';
        const detail = normalizeString(activeTurn.agent_summary)
          || normalizeString(session?.last_message_preview)
          || (sessionId === activeSessionId
            ? 'Resume the current session.'
            : openSessionIds.has(sessionId)
              ? 'Resume this open session.'
              : 'Resume interrupted work.');
        return {
          sessionId,
          label: sessionTitle,
          detail,
          action: {
            id: `resume_active_turn:${sessionId}`,
            type: 'continue_session',
            label: 'Resume this thread',
            sessionId,
          },
          sortKey: [
            normalizeString(activeTurn.last_event_at),
            normalizeString(session?.updated_at),
            normalizeString(session?.created_at),
          ],
        };
      })
      .filter(Boolean)
      .sort((left, right) => compareIsoDesc(left.sortKey, right.sortKey));
  }

  _buildReadyToResumeCard(openLoopsBoard, sessionRecords, workspaceState) {
    const activeLoops = Array.isArray(openLoopsBoard?.active) ? openLoopsBoard.active : [];
    const activeTurnItems = this._buildActiveTurnResumeItems(sessionRecords, workspaceState);
    const sessionIdsWithActiveTurns = new Set(
      activeTurnItems.map((item) => normalizeString(item.sessionId)).filter(Boolean)
    );
    const loopItems = activeLoops
      .filter((loop) => loop.isDue || normalizeString(loop.sessionId))
      .filter((loop) => {
        const sessionId = normalizeString(loop.sessionId);
        return !sessionId || !sessionIdsWithActiveTurns.has(sessionId);
      })
      .map((loop) => ({
        label: normalizeString(loop.title) || 'Open loop',
        detail: loop.isDue
          ? (normalizeString(loop.contextLine) || 'Due now')
          : (normalizeString(loop.contextLine) || normalizeString(loop.sessionTitle) || 'Linked to a session'),
        action: firstReadyToResumeAction(loop),
      }));
    const candidates = [
      ...activeTurnItems.map((item) => ({
        label: item.label,
        detail: item.detail,
        action: item.action,
      })),
      ...loopItems,
    ].slice(0, 3);
    if (!candidates.length) {
      return null;
    }
    return {
      id: 'ready-to-resume',
      title: 'Ready to Resume',
      items: candidates,
    };
  }

  _buildTodayCards({ sessions, sessionRecords, workspaceState, openLoopsBoard }) {
    const cards = [];
    const readyToResumeCard = this._buildReadyToResumeCard(openLoopsBoard, sessionRecords, workspaceState);
    if (readyToResumeCard) {
      cards.push(readyToResumeCard);
    }

    const recentSessions = sessions.slice(0, 3).filter((session) => normalizeString(session?.title));
    if (recentSessions.length > 0) {
      cards.push({
        id: 'recent-commitments',
        title: 'Recent Activity',
        items: recentSessions.map((session) => ({
          label: normalizeString(session.title) || 'Untitled session',
          detail: clipText(session.last_message_preview || '', 80),
        })),
      });
    }

    const openIds = new Set(
      Array.isArray(workspaceState?.openSessionIds)
        ? workspaceState.openSessionIds.map((entry) => normalizeString(entry)).filter(Boolean)
        : []
    );
    if (openIds.size > 0) {
      const openSessions = sessions.filter((session) => openIds.has(normalizeString(session?.id)));
      if (openSessions.length > 0) {
        cards.push({
          id: 'active-sessions',
          title: 'Open Sessions',
          items: openSessions.slice(0, 5).map((session) => ({
            label: normalizeString(session.title) || 'Untitled session',
            detail: '',
          })),
        });
      }
    }

    return cards;
  }

  _buildSuggestedActions({
    mode,
    modeMeta,
    workspaceStatus,
    reminders,
    recentSessionLoop,
  }) {
    const actions = [{
      id: `prefill:${mode}`,
      type: 'prefill_chat',
      label: `Start in ${modeMeta.label} Mode`,
      prompt: modeMeta.homePrompt,
    }];

    const secondaryPrompts = Array.isArray(modeMeta.secondaryPrompts)
      ? modeMeta.secondaryPrompts
      : [];
    for (const [index, prompt] of secondaryPrompts.slice(0, 2).entries()) {
      actions.push({
        id: `prefill:${mode}:secondary:${index + 1}`,
        type: 'prefill_chat',
        label: clipText(prompt, 50),
        prompt,
      });
    }

    if (workspaceStatus.state !== 'ready') {
      actions.push({
        id: 'settings:tools',
        type: 'open_settings',
        label: 'Open Tools Settings',
        section: 'tools',
      });
    } else if (reminders.length === 0) {
      actions.push({
        id: 'settings:proactive',
        type: 'open_settings',
        label: 'Open Proactive Settings',
        section: 'proactive',
      });
    }

    if (recentSessionLoop?.action?.sessionId) {
      actions.push({
        id: `continue:${recentSessionLoop.action.sessionId}`,
        type: 'continue_session',
        label: recentSessionLoop.action.label,
        sessionId: recentSessionLoop.action.sessionId,
      });
    }

    actions.push({
      id: 'memory',
      type: 'open_view',
      label: 'Review Memories',
      viewId: 'memory',
    });
    actions.push({
      id: 'new-session',
      type: 'new_session',
      label: 'Start Fresh Session',
    });

    return trimSuggestedActions(actions, workspaceStatus.state !== 'ready');
  }

  async getState() {
    const now = this.nowProvider();
    const configState = this.configService.getState();
    const companion = this._getCompanionSettings();
    const mode = normalizeCompanionMode(companion.mode);
    const modeMeta = this._getModeMeta(mode);
    const workspaceStatus = this.configService.getWorkspaceRootStatus();
    const workspaceState = this.getWorkspaceState();
    const sessions = this._listSessions()
      .sort(compareSessionActivityDesc);
    const sessionRecords = this._listSessionRecords()
      .sort(compareSessionActivityDesc);
    const briefingSnapshot = await this.briefingCache.getSnapshot({
      now,
      workspaceRoot: configState.toolsWorkspaceRoot,
      workspaceRootStatus: workspaceStatus,
      personalityWorkspace: this.personalityWorkspace,
      execFileImpl: this.execFileImpl,
    });
    const reminders = this._buildReminders(configState);
    const openLoopsBoard = this._buildFollowUpBoard(configState, sessions, workspaceState);
    const recentSessionLoop = this._buildRecentSessionOpenLoop(sessions, workspaceState);
    const todayCards = this._buildTodayCards({
      sessions,
      sessionRecords,
      workspaceState,
      openLoopsBoard,
    });
    const suggestedActions = this._buildSuggestedActions({
      mode,
      modeMeta,
      workspaceStatus,
      reminders,
      recentSessionLoop,
    });
    const homeFocus = buildHomeFocus({
      openLoopsBoard,
      todayCards,
      reminders,
      suggestedActions,
    });
    const availableDeferPresets = getAvailableFollowUpDeferPresets(now, {
      timeZone: briefingSnapshot.timeZone,
    });

    return {
      mode,
      modeMeta: {
        key: mode,
        label: modeMeta.label,
        description: modeMeta.description,
        homePrompt: modeMeta.homePrompt,
        secondaryPrompts: Array.isArray(modeMeta.secondaryPrompts)
          ? modeMeta.secondaryPrompts.slice(0, 2)
          : [],
      },
      briefing: {
        dateKey: briefingSnapshot.dateKey,
        dateLabel: briefingSnapshot.dateLabel,
        timeZone: briefingSnapshot.timeZone,
        items: [
          {
            id: 'mode',
            label: 'Current Mode',
            value: `${modeMeta.label}: ${modeMeta.description}`,
          },
          {
            id: 'workspace',
            label: 'Workspace',
            value: workspaceStatus.message,
          },
          {
            id: 'git',
            label: 'Git Snapshot',
            value: briefingSnapshot.workspace.git.summary,
          },
          ...(briefingSnapshot.workspace.git.recentCommits.length
            ? [{
                id: 'recent-commits',
                label: 'Recent Commits',
                value: briefingSnapshot.workspace.git.recentCommits.join(' | '),
              }]
            : []),
          {
            id: 'reminders',
            label: 'Reminders',
            value: reminders.length
              ? `${reminders.length} enabled reminder${reminders.length === 1 ? '' : 's'}.`
              : 'No enabled reminders yet.',
          },
          {
            id: 'notes',
            label: 'Long-term Notes',
            value: briefingSnapshot.memory.notesSnippet,
          },
        ],
      },
      todayCards,
      reminders,
      homeFocus,
      openLoopsBoard,
      availableDeferPresets,
      suggestedActions,
      // Structured twin of the flattened 'git'/'recent-commits' briefing
      // items: the Home git widget needs fields, not display strings.
      workspaceGit: {
        available: briefingSnapshot.workspace.git.available === true,
        branch: normalizeString(briefingSnapshot.workspace.git.branch),
        recentCommits: Array.isArray(briefingSnapshot.workspace.git.recentCommits)
          ? briefingSnapshot.workspace.git.recentCommits.map((entry) => normalizeString(entry)).filter(Boolean)
          : [],
        summary: normalizeString(briefingSnapshot.workspace.git.summary),
      },
      workspaceSnapshot: {
        workspaceRoot: normalizeString(configState.toolsWorkspaceRoot),
        workspaceRootStatus: workspaceStatus,
        activeSessionId: normalizeString(workspaceState?.activeSessionId),
        openSessionIds: Array.isArray(workspaceState?.openSessionIds)
          ? workspaceState.openSessionIds.map((entry) => normalizeString(entry)).filter(Boolean)
          : [],
        sessionCount: sessions.length,
      },
    };
  }

  async setMode(mode) {
    this.configService.setCompanionMode(mode);
    return this.getState();
  }
}

module.exports = {
  CompanionService,
  trimSuggestedActions,
};
