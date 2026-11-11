'use strict';

// Per-domain pins for services/main/ipc-registration/: each domain register
// function owns an exact, ordered channel list (registerMainIpcHandlers and
// registerAuxiliaryIpcHandlers call them in a fixed order, so these lists are
// slices of the full registration order), and every channel it registers sits
// behind the authorizer the caller passes in. The owners that compose services
// or other registration modules (workspace services, engines, chat surface, app
// shell) are covered end to end by tests/ipc-handler-registration*.test.js.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');
const sessionsIpc = require('../services/main/ipc-registration/sessions-ipc');
const enginesIpc = require('../services/main/ipc-registration/engines-ipc');
const systemIpc = require('../services/main/ipc-registration/system-ipc');
const personalityMemoryIpc = require('../services/main/ipc-registration/personality-memory-ipc');
const chatIpc = require('../services/main/ipc-registration/chat-ipc');
const workspaceIpc = require('../services/main/ipc-registration/workspace-ipc');
const guidanceIpc = require('../services/main/ipc-registration/guidance-ipc');
const setupIpc = require('../services/main/ipc-registration/setup-ipc');
const homeCompanionIpc = require('../services/main/ipc-registration/home-companion-ipc');
const appShellIpc = require('../services/main/ipc-registration/app-shell-ipc');
const tuningIpc = require('../services/main/ipc-registration/tuning-ipc');
const toolsIpc = require('../services/main/ipc-registration/tools-ipc');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ipc-domains-'));
test.after(() => fs.rmSync(USER_DATA, { recursive: true, force: true }));

// A method path, or a raw channel for a preload-internal descriptor.
const toChannel = (entry) => (entry.includes(':') ? entry : getBridgeChannel(entry, 'invoke'));

const CASES = [
  [sessionsIpc.registerSessionIpcHandlers, 'workspaceAuthorization', {},
    'backend.getStatus backend.retryStart auth.getState auth.updateLocalProfile sessions.list sessions.create'
    + ' sessions.rename sessions.delete sessions.getMessages sessions.setPreferences sessions.setMeta'
    + ' sessions.sweepEmpty sessions.editAndTruncate sessions.exportSession sessions.forkSession templates.list'
    + ' templates.save templates.delete templates.apply'],
  [sessionsIpc.registerArtifactIpcHandlers, 'ipcAuthorization', {},
    'artifacts.read artifacts.save artifacts.saveAs artifacts.copyImage artifacts.capabilities artifacts.openWith'
    + ' artifacts.reveal artifacts.openExternal artifacts.delete artifacts.deleteSession chatImages.copyImage'
    + ' chatImages.saveAs chatImages.reveal'],
  [enginesIpc.registerModelIpcHandlers, 'workspaceAuthorization', {},
    'models.list models.listOllamaTags models.load models.unload models.delete'],
  [enginesIpc.registerEngineSettingsIpcHandlers, 'ipcAuthorization', {},
    'offline.getState engines.getSettings engines.updateSettings offline.getDiagnostics offline.updateSettings'],
  [systemIpc.registerSystemIpcHandlers, 'workspaceAuthorization', {
    createStartupAuditMarkHandler: () => () => null,
    createStartupAuditMarksBatchHandler: () => () => null,
  },
  'status.get system.getStats system.refreshStats system.setStatsWatch diagnostics.logs.getSnapshot'
    + ' diagnostics.reportRendererError diagnostics.reportClientStreamMetrics diagnostics.getStartupAuditConfig'
    + ' diagnostics.reportStartupMark diagnostics.reportStartupMarksBatch updates.getState updates.check'
    + ' updates.download updates.install updates.skip'],
  [systemIpc.registerRuntimeDiagnosticsIpcHandlers, 'ipcAuthorization', {},
    'harness.inspect diagnostics.getJennyStatus diagnostics.phasePercentiles.get'
    + ' diagnostics.phasePercentiles.reset codexCli.getState codexCli.refresh'],
  [systemIpc.registerUsageIpcHandlers, 'ipcAuthorization', {}, 'usage.getSnapshot usage.clearHistory'],
  [personalityMemoryIpc.registerPersonalityIpcHandlers, 'workspaceAuthorization', {},
    'personality.getState personality.save personality.clear personality.openWorkspaceFolder'
    + ' memory.contextFiles.getState memory.contextFiles.writeFile memory.contextFiles.resetFile'],
  [personalityMemoryIpc.registerMemoryIpcHandlers, 'ipcAuthorization', {},
    'memory.status memory.save memory.listApproved memory.listPending memory.update memory.delete'
    + ' memory.acceptPending memory.undoChange memory.deletePending memory.undo memory.listArchived memory.restore'
    + ' memory.erase memory.clearForgotten memory.listOperations memory.setAlwaysOn memory.exportMarkdown'
    + ' memory.openContextFile'],
  [chatIpc.registerChatUserQuestionIpcHandlers, 'workspaceAuthorization', {},
    'chat.hasPendingUserQuestions chat.answerUserQuestions chat.declineUserQuestions'],
  [chatIpc.registerChatStreamIpcHandlers, 'ipcAuthorization', {},
    'chat.startStream chat.editAndRegenerate chat.retryUnsavedReply chat.discardUnsavedReply'
    + ' chat.getActiveTurnState chat.cancelStream chat.compactNow handoff.generateNote attachments.pick'
    + ' attachments:prepare-dropped-paths attachments.prepare attachments.saveImageAsset attachments.releaseAssets'],
  [workspaceIpc.registerWorkspaceStateIpcHandlers, 'workspaceAuthorization', {
    app: { getPath: () => USER_DATA }, backendService: {}, shellConfigService: {},
  },
  'reminders.snooze workspace.getState workspace.updateState workspaceIde.getState workspaceIde.updateSettings'
    + ' workspaceIde.updateState workspaceBackup.write workspaceBackup.remove workspaceBackup.list'
    + ' workspaceBackup.read backgroundJobs.getState backgroundJobs.kill backgroundJobs.readOutput'],
  // knowledge_layer / semantic_catalog off: only the skills channels register.
  [guidanceIpc.registerGuidanceKnowledgeIpcHandlers, 'workspaceAuthorization', { backendService: {} },
    'skills.getState skills.updateSettings skills.openScopeFolder'],
  [setupIpc.registerSetupIpcHandlers, 'ipcAuthorization', {},
    'setup.getState setup.updateState setup.complete setup.reset setup.factoryReset setup.validateEndpoint'
    + ' setup.saveEndpoint setup.startOllamaPull setup.cancelOllamaPull setup.detectOllama'
    + ' setup.getOllamaInstallPlan setup.installOllama setup.cancelOllamaInstall'],
  [setupIpc.registerMcpIpcHandlers, 'ipcAuthorization', {},
    'mcpDiscovery.getState mcpDiscovery.refresh mcpDiscovery.createServer mcpDiscovery.updateServer'
    + ' mcpDiscovery.removeServer mcpDiscovery.testServer mcpDiscovery.checkReadiness mcpDiscovery.getPrompt'
    + ' mcpDiscovery.getReaInstallPlan mcpDiscovery.installRea mcpDiscovery.uninstallRea'
    + ' mcpDiscovery.approveServer mcpDiscovery.setServerEnabled mcpAuth.getStatus mcpAuth.set mcpAuth.delete'],
  [homeCompanionIpc.registerHomeIpcHandlers, 'ipcAuthorization', {},
    'scheduler.getState home.getConfig home.updateConfig home.getAiJournal home.undoAiEntry projectNotes.get'
    + ' projectNotes.save projectNotes.undo projectNotes.lease linkStatus.getState calendar.getState'
    + ' calendar.createEvent calendar.updateEvent calendar.deleteEvent'],
  [homeCompanionIpc.registerCompanionIpcHandlers, 'ipcAuthorization', {},
    'proactive.getState companion.getState companion.setMode companion.addFollowUp companion.updateFollowUp'
    + ' companion.deferFollowUp companion.activateFollowUp companion.resolveFollowUp companion.archiveFollowUp'
    + ' companion.unarchiveFollowUp companion.deleteFollowUp suggestions.generate commit.generateMessage'],
  [homeCompanionIpc.registerProactiveIpcHandlers, 'ipcAuthorization', {},
    'proactive.chooseWorkspaceRoot proactive.clearWorkspaceRoot proactive.upsertReminder proactive.deleteReminder'],
  [appShellIpc.registerUiSettingsIpcHandlers, 'ipcAuthorization', {},
    'chatUi.getState chatUi.updateSettings windowUi.getState windowUi.updateSettings'],
  [appShellIpc.registerWindowIpcHandlers, 'ipcAuthorization', {},
    'clipboard.writeText window.getState appearance.respondRelay window.respondExitPreflight windowControl'],
  [tuningIpc.registerTuningIpcHandlers, 'ipcAuthorization', {},
    'modelTuning.getState modelTuning.update engineTuning.getState engineTuning.update engineTuning.reset'
    + ' compaction.getTuning compaction.setTuning chat.getNextTurnContextSummary'],
  [toolsIpc.registerToolIpcHandlers, 'ipcAuthorization', {},
    'tools.list tools.approve tools.buildAcceptedPlan tools.deny tools.getPermissions tools.clearPermission'
    + ' tools.removePermissionRule'],
];

describe('ipc-registration domain modules', () => {
  for (const [register, authorizationKey, deps, expected] of CASES) {
    test(`${register.name} registers its exact channel list, each behind the caller's authorizer`, async () => {
      const handlers = new Map();
      const order = [];
      const ipc = {
        handle(channel, handler) { order.push(channel); handlers.set(channel, handler); },
        on(channel) { order.push(`on:${channel}`); },
      };
      const seen = [];
      const refusal = { ok: false, authorized: false, code: 'ipc_sender_unauthorized' };
      const authorization = {
        authorize: (_event, { channel }) => { seen.push(channel); return false; },
        unauthorizedResult: () => refusal,
      };
      register(ipc, { ...deps, [authorizationKey]: authorization });

      assert.deepEqual(order, expected.split(' ').map(toChannel));
      for (const [channel, handler] of handlers) {
        assert.deepEqual(await handler({ sender: { id: 99 } }), refusal, channel);
      }
      assert.deepEqual(seen, order, 'every channel consulted the authorizer exactly once');
    });
  }

  test('the original entry point re-exports the moved helpers', () => {
    const main = require('../services/main/ipc-handler-registration');
    assert.equal(main.registerGuidanceIpcHandlers, guidanceIpc.registerGuidanceIpcHandlers);
    assert.equal(main.registerFeatureIpcHandlers, appShellIpc.registerFeatureIpcHandlers);
    assert.equal(main.registerOllamaTrayRemediationIpcHandlers, enginesIpc.registerOllamaTrayRemediationIpcHandlers);
  });
});
