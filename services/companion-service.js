const { clipText, normalizeString } = require('./backend/path-utils');
const { t } = require('./i18n-main');
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
const { normalizeProjectId } = require('./projects/project-schema');

const MAX_ARCHIVED_BOARD_ITEMS = 50;

// The first `limit` entries of each project (input already sorted newest first;
// unstamped loops share one bucket).
function takeNewestPerProject(followUps, limit) {
  const taken = new Map();
  return followUps.filter((followUp) => {
    const key = String(followUp?.projectId || '');
    const count = taken.get(key) || 0;
    taken.set(key, count + 1);
    return count < limit;
  });
}
const RESUMABLE_SESSION_STATES = new Set(['current', 'open', 'saved']);

// Reminders fire automatically while Jenny is running. Delivery and persisted
// schedule/fire state belong to the reminder notifier; this Home projection
// carries the reminder's content and actions.
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
    projectId: normalizeProjectId(record?.projectId),
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

function parseBoardTimestamp(value) {
  const raw = normalizeString(value);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

/* English fallback only: the renderer localizes from the raw timestamps, but
 * Home focus (companion-home-focus.js) still reads timingLabel. Every branch
 * is NaN-guarded so a malformed timestamp never renders "Invalid Date". */
function buildBoardTimingLabel(status, followUp) {
  if (status === 'active') {
    return followUp?.dueNow ? 'Due now' : '';
  }
  if (status === 'deferred') {
    const parsed = parseBoardTimestamp(followUp?.deferredUntil);
    return parsed ? `Deferred until ${formatBoardTimingDateTime(parsed)}` : '';
  }
  if (status === 'resolved') {
    const parsed = parseBoardTimestamp(followUp?.resolvedAt);
    return parsed ? `Completed ${formatBoardTimingDate(parsed)}` : '';
  }
  if (status === 'archived') {
    const parsed = parseBoardTimestamp(followUp?.archivedAt);
    return parsed ? `Archived ${formatBoardTimingDate(parsed)}` : 'Archived';
  }
  return '';
}

const SOURCE_KIND_BADGES = Object.freeze({
  agent_task: 'Agent task',
  assistant_reply: 'Assistant reply',
  proactive_suggestion: 'Proactive suggestion',
  reminder: 'Reminder',
  manual: 'Manual',
});

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
      : () => null;
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

  /* The provider returns null while no session store is attached; an array,
   * even an empty one, is authoritative. `known` travels with the list (never
   * on the instance) so overlapping getState calls cannot trade flags. */
  _readSessionList() {
    const sessions = this.listSessionSummaries();
    const known = Array.isArray(sessions);
    return { sessions: known ? sessions.slice() : [], known };
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

  /* sessionState is the machine-readable twin of sessionBadge (the English
   * fallback): '' | 'current' | 'open' | 'missing' | 'saved'. 'missing' only
   * applies when the session list is known (an attached store's list, even an
   * empty one, lacks the id); an unknown list (null) never marks missing. */
  _buildFollowUpSessionMeta(followUp, sessionById, sessionContext) {
    const sessionId = normalizeString(followUp.sessionId);
    if (!sessionId) {
      return { sessionState: '', sessionTitle: '', sessionBadge: '', contextLine: '' };
    }
    const sessionTitle = this._resolveFollowUpSessionTitle(followUp, sessionById);
    if (sessionId === sessionContext.activeSessionId) {
      return { sessionState: 'current', sessionTitle, sessionBadge: 'Current session', contextLine: '' };
    }
    if (sessionContext.openSessionIds.has(sessionId)) {
      return { sessionState: 'open', sessionTitle, sessionBadge: 'Open session', contextLine: sessionTitle };
    }
    if (sessionContext.sessionsLoaded && !sessionById.has(sessionId)) {
      return { sessionState: 'missing', sessionTitle, sessionBadge: '', contextLine: '' };
    }
    return { sessionState: 'saved', sessionTitle, sessionBadge: 'Saved from session', contextLine: sessionTitle };
  }

  /* One slot-per-status builder. Array order is display order: primary, then
   * inline, then overflow; each action type appears at most once per loop. */
  _buildFollowUpActions(followUp, status, { canResume = false, canStartTask = false } = {}) {
    const followUpId = normalizeString(followUp.id);
    const action = (type, slot, label, labelKey, idPrefix = type) => ({
      id: `${idPrefix}:${followUpId}`,
      type,
      label,
      labelKey,
      slot,
      followUpId,
    });
    const resume = (slot) => ({
      ...action('continue_session', slot, 'Resume thread', 'companion.actions.resumeThread', 'continue_follow_up'),
      sessionId: normalizeString(followUp.sessionId),
    });
    const startTask = (slot) => (slot === 'primary'
      ? action('start_task_session', slot, 'Start a session', 'companion.actions.startSession')
      : action('start_task_session', slot, 'Start a new session', 'companion.actions.startNewSession'));
    const done = (slot) => action('resolve_follow_up', slot, 'Done', 'companion.actions.done');

    const actions = [];
    let primaryType = '';
    if (status === 'active') {
      const primary = canResume ? resume('primary') : canStartTask ? startTask('primary') : done('primary');
      primaryType = primary.type;
      actions.push(primary);
      if (primaryType !== 'resolve_follow_up') {
        actions.push(done('inline'));
      }
      actions.push(action('defer_follow_up', 'inline', 'Later', 'companion.actions.later'));
    } else if (status === 'deferred') {
      actions.push(action('activate_follow_up', 'primary', 'Make active', 'companion.actions.makeActive'));
    } else if (status === 'resolved') {
      actions.push(action('activate_follow_up', 'inline', 'Reopen', 'companion.actions.reopen'));
    } else if (status === 'archived') {
      actions.push(action('unarchive_follow_up', 'inline', 'Restore', 'companion.actions.restore'));
    }
    if (canResume && status !== 'active') {
      actions.push(resume('inline'));
    }
    if (canStartTask && status !== 'archived' && primaryType !== 'start_task_session') {
      actions.push(startTask('overflow'));
    }
    actions.push(action('edit_follow_up', 'overflow', 'Edit', 'companion.actions.edit'));
    if (status === 'resolved') {
      actions.push(action('archive_follow_up', 'overflow', 'Archive', 'companion.actions.archive'));
    }
    actions.push(action('delete_follow_up', 'overflow', 'Delete', 'companion.actions.delete'));
    return actions;
  }

  _buildFollowUpBoard(configState, sessions, workspaceState, sessionsLoaded = Array.isArray(sessions)) {
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

    // Built once per board, not per follow-up. Without a session list (no
    // store attached, provider returned null) nothing is marked missing and
    // Resume stays available; an empty list from a store is authoritative.
    const sessionContext = {
      activeSessionId: normalizeString(workspaceState?.activeSessionId),
      openSessionIds: new Set(
        Array.isArray(workspaceState?.openSessionIds)
          ? workspaceState.openSessionIds.map((entry) => normalizeString(entry)).filter(Boolean)
          : []
      ),
      sessionsLoaded: Boolean(sessionsLoaded),
    };
    const taskBoardEnabled = this._isTaskBoardEnabled();

    // normalizeFollowUp already trimmed every string field, defaulted the
    // label and bounded history, so the item reads them directly.
    const toBoardItem = (followUp, status) => {
      const {
        sessionState,
        sessionTitle,
        sessionBadge,
        contextLine,
      } = this._buildFollowUpSessionMeta(followUp, sessionById, sessionContext);
      // Resume follows the badge, so the two can never disagree.
      const canResume = RESUMABLE_SESSION_STATES.has(sessionState);
      return {
        id: `followup:${followUp.id}`,
        kind: 'follow_up',
        status,
        title: followUp.label,
        body: followUp.body,
        followUpId: followUp.id,
        sessionId: followUp.sessionId,
        projectId: followUp.projectId,
        sessionTitle,
        sessionState,
        sessionBadge,
        sourceBadge: SOURCE_KIND_BADGES[followUp.sourceKind] || '',
        contextLine,
        sourceKind: followUp.sourceKind,
        sourceId: followUp.sourceId,
        resolvedAt: followUp.resolvedAt,
        deferredUntil: followUp.deferredUntil,
        deferPreset: followUp.deferPreset,
        archivedAt: followUp.archivedAt,
        isDue: followUp.dueNow === true,
        timingLabel: buildBoardTimingLabel(status, followUp),
        actions: this._buildFollowUpActions(followUp, status, {
          canResume,
          canStartTask: followUp.sourceKind === 'agent_task' && taskBoardEnabled,
        }),
        history: followUp.history.slice(),
      };
    };

    const active = activeFollowUps.map((followUp) => toBoardItem(followUp, 'active'));
    const deferred = deferredFollowUps.map((followUp) => toBoardItem(followUp, 'deferred'));
    // Every resolved loop, bounded per project like the archive (agent tasks are
    // project-scoped: one busy project must not push another's completed tasks
    // out of the rail's Done filter); the renderer shows the newest few and offers "Show all".
    const recentResolved = takeNewestPerProject(resolvedFollowUps, MAX_ARCHIVED_BOARD_ITEMS)
      .map((followUp) => toBoardItem(followUp, 'resolved'));
    const archived = archivedFollowUps
      .slice(0, MAX_ARCHIVED_BOARD_ITEMS)
      .map((followUp) => toBoardItem(followUp, 'archived'));

    return {
      active,
      deferred,
      recentResolved,
      archived,
      counts: {
        active: active.length,
        deferred: deferred.length,
        recentResolved: resolvedFollowUps.length,
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
      // A loop whose session was deleted has nothing to resume.
      .filter((loop) => loop.sessionState !== 'missing')
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
      title: t('main.companion.readyToResume', 'Ready to Resume'),
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
    const sessionList = this._readSessionList();
    const sessions = sessionList.sessions.sort(compareSessionActivityDesc);
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
    const openLoopsBoard = this._buildFollowUpBoard(configState, sessions, workspaceState, sessionList.known);
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
