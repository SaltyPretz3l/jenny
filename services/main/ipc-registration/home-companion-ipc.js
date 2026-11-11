const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { createEmptyCalendarSnapshot } = require('../../calendar-service');
const { resolveTimeZone } = require('../../proactive/briefing');
const { assertProactiveReminderIpcPayload } = require('../../ipc-validation-helpers');
const { prepareReminderUpsert, reminderDeleteEvent } = require('../proactive-reminder-upsert');

// Home, companion and proactive domain IPC: the Home dashboard reads (scheduler,
// config, the assistant journal, project notes, link status, calendar), the
// companion follow-ups with suggestions and commit-message generation, and the
// proactive workspace-root and reminder writes.

function registerHomeIpcHandlers(ipcMainLike, {
  schedulerService,
  shellConfigService,
  homeAssistantService,
  projectNotesService,
  linkStatusService,
  calendarService,
  ipcAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'scheduler.getState': () =>
      schedulerService && typeof schedulerService.getStateSnapshot === 'function'
        ? schedulerService.getStateSnapshot()
        : { upcoming: [], running: [], generatedAt: '', relevant: false, lifecycle: { phase: 'unavailable', relevant: false, qualifyingTaskCount: 0, reason: 'service_unavailable', error: '', updatedAt: '' } },
    'home.getConfig': () => shellConfigService.getHomeConfig(),
    'home.updateConfig': (_, patch) => shellConfigService.updateHomeConfig(patch),
    // Attribution/undo journal for assistant-made Home changes. All decision
    // logic (supersede, ring cap, the three undo refusals) lives in
    // HomeAssistantService; these two handlers only marshal.
    'home.getAiJournal': () =>
      homeAssistantService && typeof homeAssistantService.listJournal === 'function'
        ? homeAssistantService.listJournal()
        : { entries: [] },
    'home.undoAiEntry': (_, entryId) =>
      homeAssistantService && typeof homeAssistantService.undo === 'function'
        ? homeAssistantService.undo(entryId)
        : { ok: false, reason: 'unavailable' },
    // Per-project note. All decision logic (revision check, lease, cap, undo
    // refusals) lives in ProjectNotesService; these handlers only marshal.
    'projectNotes.get': (_, projectId) =>
      projectNotesService && typeof projectNotesService.get === 'function'
        ? projectNotesService.get(projectId)
        : { ok: false, reason: 'unavailable' },
    'projectNotes.save': (_, projectId, text, baseRevision) =>
      projectNotesService && typeof projectNotesService.save === 'function'
        ? projectNotesService.save(projectId, text, baseRevision)
        : { ok: false, reason: 'unavailable' },
    'projectNotes.undo': (_, projectId, entryId) =>
      projectNotesService && typeof projectNotesService.undo === 'function'
        ? projectNotesService.undo(projectId, entryId)
        : { ok: false, reason: 'unavailable' },
    'projectNotes.lease': (_, projectId, held) =>
      projectNotesService && typeof projectNotesService.lease === 'function'
        ? projectNotesService.lease(projectId, held)
        : { ok: false, reason: 'unavailable' },
    'linkStatus.getState': () =>
      linkStatusService && typeof linkStatusService.getState === 'function'
        ? linkStatusService.getState()
        : { byTileId: {} },
    'calendar.getState': () =>
      calendarService && typeof calendarService.getState === 'function'
        ? calendarService.getState()
        : createEmptyCalendarSnapshot(),
    'calendar.createEvent': (_, payload) =>
      calendarService && typeof calendarService.createEvent === 'function'
        ? calendarService.createEvent(payload)
        : createEmptyCalendarSnapshot(),
    'calendar.updateEvent': (_, id, patch) =>
      calendarService && typeof calendarService.updateEvent === 'function'
        ? calendarService.updateEvent(id, patch)
        : createEmptyCalendarSnapshot(),
    'calendar.deleteEvent': (_, id) =>
      calendarService && typeof calendarService.deleteEvent === 'function'
        ? calendarService.deleteEvent(id)
        : createEmptyCalendarSnapshot(),
  }, ipcAuthorization);
}

async function companionFollowUpOptions(personalityWorkspace) {
  return {
    timeZone: await resolveTimeZone(personalityWorkspace),
  };
}

const RENDERER_FOLLOW_UP_PATCH_FIELDS = [
  'label', 'body', 'status', 'deferPreset', 'defer_preset', 'deferredUntil', 'deferred_until',
];
const RENDERER_FOLLOW_UP_PATCH_STATUSES = new Set(['active', 'deferred']);

/* The renderer edits text and timing only. History, provenance, timestamps and
 * the session link stay service-owned, and resolving goes through
 * resolveFollowUp so the history entry is written. The task-board tool calls
 * the service directly and is not filtered here. */
function pickRendererFollowUpPatch(patch) {
  const picked = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return picked;
  }
  for (const field of RENDERER_FOLLOW_UP_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      picked[field] = patch[field];
    }
  }
  if (Object.prototype.hasOwnProperty.call(picked, 'status')
    && !RENDERER_FOLLOW_UP_PATCH_STATUSES.has(picked.status)) {
    delete picked.status;
  }
  return picked;
}

function registerCompanionIpcHandlers(ipcMainLike, {
  backendService,
  shellConfigService,
  companionService,
  personalityWorkspace,
  getProactiveStatePayload,
  suggestionCache,
  getCachedOrGenerateSuggestions,
  generateCommitMessage,
  ipcAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'proactive.getState': () => getProactiveStatePayload(),
    'companion.getState': () => companionService.getState(),
    'companion.setMode': (_, mode) => companionService.setMode(mode),
    'companion.addFollowUp': async (_, payload) => {
      shellConfigService.upsertFollowUp(payload, await companionFollowUpOptions(personalityWorkspace));
      return companionService.getState();
    },
    // Home mutations surface a stale id as CMP-COMPANION-0002 (the service
    // mutators stay silent for the task-board tool); delete stays idempotent.
    // The existence check sits after the await so no delete can slip between
    // it and the synchronous mutation.
    'companion.updateFollowUp': async (_, id, patch) => {
      const options = await companionFollowUpOptions(personalityWorkspace);
      shellConfigService.assertFollowUpExists(id);
      shellConfigService.updateFollowUp(id, pickRendererFollowUpPatch(patch), options);
      return companionService.getState();
    },
    'companion.deferFollowUp': async (_, id, preset) => {
      const options = await companionFollowUpOptions(personalityWorkspace);
      shellConfigService.assertFollowUpExists(id);
      shellConfigService.deferFollowUp(id, preset, options);
      return companionService.getState();
    },
    'companion.activateFollowUp': (_, id) => {
      shellConfigService.assertFollowUpExists(id);
      shellConfigService.activateFollowUp(id);
      return companionService.getState();
    },
    'companion.resolveFollowUp': (_, id) => {
      shellConfigService.assertFollowUpExists(id);
      shellConfigService.resolveFollowUp(id);
      return companionService.getState();
    },
    'companion.archiveFollowUp': (_, id) => {
      shellConfigService.assertFollowUpExists(id);
      shellConfigService.archiveFollowUp(id);
      return companionService.getState();
    },
    'companion.unarchiveFollowUp': (_, id) => {
      shellConfigService.assertFollowUpExists(id);
      shellConfigService.unarchiveFollowUp(id);
      return companionService.getState();
    },
    'companion.deleteFollowUp': (_, id) => {
      shellConfigService.deleteFollowUp(id);
      return companionService.getState();
    },
    'suggestions.generate': async () => {
      try {
        const companionState = await companionService.getState();
        return getCachedOrGenerateSuggestions(backendService, companionState, suggestionCache);
      } catch (_error) {
        return { suggestions: [] };
      }
    },
    // One-shot, off-transcript local-model commit-message generation from the
    // staged diff (Source Control panel "Write message"). The diff stays on the
    // machine and never enters the chat transcript; failures degrade to a
    // structured { ok:false } shape rather than throwing.
    'commit.generateMessage': async (_, payload) => {
      try {
        return await generateCommitMessage(backendService, payload || {});
      } catch (_error) {
        return { ok: false, reason: 'generate_failed' };
      }
    },
  }, ipcAuthorization);
}

function registerProactiveIpcHandlers(ipcMainLike, {
  backendService,
  shellConfigService,
  getProactiveStatePayload,
  workspaceRootCoordinator,
  ipcAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'proactive.chooseWorkspaceRoot': async () => {
      const prepared = typeof workspaceRootCoordinator?.prepareChoose === 'function'
        ? await workspaceRootCoordinator.prepareChoose()
        : {
            prepared: false,
            changed: false,
            canceled: false,
            blocked: true,
            code: 'workspace_root_coordinator_unavailable',
          };
      return { ...getProactiveStatePayload(), ...prepared };
    },
    'proactive.clearWorkspaceRoot': async () => {
      const prepared = typeof workspaceRootCoordinator?.prepareClear === 'function'
        ? await workspaceRootCoordinator.prepareClear()
        : {
            prepared: false,
            changed: false,
            canceled: false,
            blocked: true,
            code: 'workspace_root_coordinator_unavailable',
          };
      return { ...getProactiveStatePayload(), ...prepared };
    },
    'proactive.upsertReminder': (_, reminder) => {
      const { reminder: merged, event } = prepareReminderUpsert(shellConfigService, reminder);
      assertProactiveReminderIpcPayload(shellConfigService, merged);
      shellConfigService.upsertReminder(merged);
      if (event) {
        try { backendService?.primaryChatControls?.recordScheduleEvent?.(event); } catch (_error) { /* the log never blocks the write */ }
      }
      return getProactiveStatePayload();
    },
    'proactive.deleteReminder': (_, reminderId) => {
      const event = reminderDeleteEvent(shellConfigService, reminderId);
      shellConfigService.deleteReminder(reminderId);
      try { if (event) backendService?.primaryChatControls?.recordScheduleEvent?.(event); } catch (_error) { /* never blocks the delete */ }
      return getProactiveStatePayload();
    },
  }, ipcAuthorization);
}

module.exports = {
  registerCompanionIpcHandlers,
  registerHomeIpcHandlers,
  registerProactiveIpcHandlers,
};
