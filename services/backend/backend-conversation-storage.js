'use strict';

const path = require('node:path');

const { recoverTurnEventJournal } = require('../session-recovery-service');
const { TerminalCoordinator } = require('./chat-stream-terminal-coordinator');
const { ElectronSessionStore } = require('./electron-session-store');
const { ensureSessionTurnActorRegistry } = require('./session-turn-actor');
const { SessionShadowStore } = require('./session-shadow-store');
const { TerminalRepairStore } = require('./terminal-repair-store');
const { TurnEventJournal } = require('./turn-event-journal');

function initializeConversationStorage(service, options) {
  const logger = (level, event, details) => service._emitServiceLog(level, event, details);
  const writeDebounceMs = 500;
  service.sessionStore = new ElectronSessionStore(
    path.join(options.userDataPath, 'sessions.json'),
    {
      shellConfigService: service.configService,
      logger,
      writeDebounceMs,
    }
  );
  if (typeof service.configService?.setWorkspaceSessionIdProvider === 'function') {
    service.configService.setWorkspaceSessionIdProvider(
      () => service.sessionStore.getSessionIds()
    );
  }
  service.shadowStore = new SessionShadowStore(
    path.join(options.userDataPath, 'session-shadow.json'),
    { logger, writeDebounceMs }
  );
  service.turnEventJournal = new TurnEventJournal(
    path.join(options.userDataPath, 'turn-event-journal.json'),
    { logger }
  );
  service.terminalRepairStore = new TerminalRepairStore(
    path.join(options.userDataPath, 'terminal-repairs.json'),
    { logger }
  );
  service.sessionTurnActors = ensureSessionTurnActorRegistry(service);
  service.sessionConversationStore = service.sessionStore.conversationStore;
  service.shadowConversationStore = service.shadowStore.conversationStore;
  service.conversationStore = service.sessionConversationStore;
  service.terminalCoordinator = new TerminalCoordinator({
    actorRegistry: service.sessionTurnActors,
    journal: service.turnEventJournal,
    repairStore: service.terminalRepairStore,
    emitTerminal(payload) {
      service.emit('chat-stream', payload);
      return true;
    },
    emitDurabilityUpdate(payload) {
      const messageId = Array.isArray(payload.persistedMessageIds)
        ? payload.persistedMessageIds.at(-1)
        : '';
      if (!messageId) return false;
      service.emit('chat-stream', {
        type: 'message_updated',
        sessionId: payload.sessionId,
        streamId: payload.streamId,
        messageId,
        patch: { durability: payload.durability },
      });
      return true;
    },
    logger,
  });
  service._pendingSessionMigrationScheduled = false;
  service._pendingSessionMigrationImmediate = null;
  recoverTurnEventJournal({
    sessionStore: service.sessionStore,
    journal: service.turnEventJournal,
    logger,
  });
}

module.exports = {
  initializeConversationStorage,
};
