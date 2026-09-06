const { EventEmitter } = require('events');
const { normalizeString } = require('../renderer/shared/string-utils');

const {
  DEFAULT_TIPS,
  normalizeTipsSettings,
} = require('./shell-config-service');
const { isWorkspaceRootChangeReason } = require('./workspace-root-change-reasons');

function buildTipRegistry() {
  return [
    {
      id: 'workspace-root',
      title: 'Point Jenny at a workspace',
      body: 'Set a workspace root to unlock project-scoped skills and workspace-aware guidance.',
      actionLabel: 'Open Tools Settings',
      settingsSection: 'tools',
      cooldownSessions: 2,
      isRelevant({ configState }) {
        return !normalizeString(configState?.toolsWorkspaceRoot);
      },
    },
    {
      id: 'skills-surface',
      title: 'Skills stay file-backed',
      body: 'Bundled, user, and project skills are managed from folders. Toggle scopes in Settings, then edit the files directly.',
      actionLabel: 'Open Skills Settings',
      settingsSection: 'skills',
      cooldownSessions: 2,
      isRelevant({ skillsState }) {
        return (skillsState?.counts?.total || 0) === 0;
      },
    },
    {
      id: 'offline-local',
      title: 'Offline mode fails closed',
      body: 'Force local inference stays blocked until the selected local model is ready.',
      actionLabel: 'Open Offline Settings',
      settingsSection: 'offline',
      cooldownSessions: 3,
      isRelevant({ offlineState }) {
        return String(offlineState?.mode || '').trim().toLowerCase() !== 'local_only';
      },
    },
    {
      id: 'followups-loop',
      title: 'Open loops live on Home',
      body: 'Use reminders and follow-ups to keep unfinished work visible without auto-sending new chat.',
      actionLabel: 'Open Home',
      settingsSection: 'home',
      cooldownSessions: 2,
      isRelevant({ configState }) {
        const followUps = Array.isArray(configState?.followUps) ? configState.followUps : [];
        return !followUps.some((entry) => {
          const status = normalizeString(entry?.status).toLowerCase();
          if (status) {
            return status !== 'resolved';
          }
          return entry?.resolved === true ? false : Boolean(entry);
        });
      },
    },
  ];
}

// Tip records leave the main process over tips:get-state and the tips.onChanged
// bridge event, where Electron's structured clone REJECTS functions. Registry
// entries carry an isRelevant() predicate, and _resolveRelevantTips returns those
// entries directly, so a spread would put the predicate on the wire and the
// handler would die with "An object could not be cloned". Pick the serializable
// fields explicitly: a rest-spread would silently readmit any future method.
function cloneTipRecord(tip) {
  if (!tip || typeof tip !== 'object' || Array.isArray(tip)) {
    return null;
  }
  return {
    id: tip.id,
    title: tip.title,
    body: tip.body,
    actionLabel: tip.actionLabel,
    settingsSection: tip.settingsSection,
    cooldownSessions: tip.cooldownSessions,
  };
}

function cloneTipsState(state = {}) {
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const settings = source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
    ? source.settings
    : {};
  return {
    featureEnabled: source.featureEnabled === true,
    settings: {
      ...settings,
      historyByTipId: {
        ...(settings.historyByTipId && typeof settings.historyByTipId === 'object' && !Array.isArray(settings.historyByTipId)
          ? settings.historyByTipId
          : {}),
      },
    },
    relevantTips: (Array.isArray(source.relevantTips) ? source.relevantTips : [])
      .map((tip) => cloneTipRecord(tip))
      .filter(Boolean),
    activeTip: cloneTipRecord(source.activeTip),
  };
}

class TipsService extends EventEmitter {
  constructor({
    configService,
    skillsService = null,
    offlineIntelligenceService = null,
    featureEnabled = true,
    logger = null,
  } = {}) {
    super();
    if (!configService) {
      throw new Error('configService is required for TipsService.');
    }
    this.configService = configService;
    this.skillsService = skillsService;
    this.offlineIntelligenceService = offlineIntelligenceService;
    // Kept in the returned compatibility projection for one release, but no
    // longer feature-flagged. The Home preference is the single user control.
    this.featureEnabled = true;
    this.logger = typeof logger === 'function' ? logger : null;
    this.registry = buildTipRegistry();
    this.lastState = this._buildState();
    this._handleConfigChanged = this._handleConfigChanged.bind(this);
    this._handleSkillsChanged = this._handleSkillsChanged.bind(this);
    if (typeof this.configService.on === 'function') {
      this.configService.on('changed', this._handleConfigChanged);
    }
    if (this.skillsService && typeof this.skillsService.on === 'function') {
      this.skillsService.on('changed', this._handleSkillsChanged);
    }
  }

  dispose() {
    if (typeof this.configService.off === 'function') {
      this.configService.off('changed', this._handleConfigChanged);
    } else if (typeof this.configService.removeListener === 'function') {
      this.configService.removeListener('changed', this._handleConfigChanged);
    }
    if (this.skillsService && typeof this.skillsService.off === 'function') {
      this.skillsService.off('changed', this._handleSkillsChanged);
    } else if (this.skillsService && typeof this.skillsService.removeListener === 'function') {
      this.skillsService.removeListener('changed', this._handleSkillsChanged);
    }
  }

  _handleConfigChanged(_state, context = {}) {
    const reason = normalizeString(context.reason);
    const relevantReasons = new Set([
      'tips_settings_updated',
      'skills_settings_updated',
      'follow_up_upserted',
      'follow_up_deferred',
      'follow_up_activated',
      'follow_up_resolved',
      'follow_up_deleted',
      'offline_intelligence_updated',
      'home_config_updated',
    ]);
    if (isWorkspaceRootChangeReason(reason) || relevantReasons.has(reason)) {
      this.refreshState({
        emit: true,
        reason: reason || 'tips_state_refreshed',
      });
    }
  }

  _handleSkillsChanged() {
    this.refreshState({
      emit: true,
      reason: 'skills_state_refreshed',
    });
  }

  _getSettings() {
    const state = this.configService.getState() || {};
    return {
      ...normalizeTipsSettings(state.tips || DEFAULT_TIPS),
      enabled: state.home?.showContextualTips === true,
    };
  }

  _log(level, event, details = {}) {
    if (!this.logger) {
      return;
    }
    this.logger(level, event, details);
  }

  _getSessionsSinceShown(tipId, settings) {
    const history = settings.historyByTipId || {};
    const sessionCount = Number(settings.sessionCount || 0);
    const lastShownAt = Number(history[tipId]);
    return Number.isFinite(lastShownAt)
      ? Math.max(sessionCount - lastShownAt, 0)
      : Number.POSITIVE_INFINITY;
  }

  _getEvaluationContext(settings = this._getSettings()) {
    const configState = this.configService.getState();
    const skillsState = this.skillsService && typeof this.skillsService.getState === 'function'
      ? this.skillsService.getState()
      : null;
    const offlineState = this.offlineIntelligenceService && typeof this.offlineIntelligenceService.getState === 'function'
      ? this.offlineIntelligenceService.getState()
      : null;
    return {
      settings,
      configState,
      skillsState,
      offlineState,
    };
  }

  _resolveRelevantTips(settings = this._getSettings()) {
    if (settings.enabled !== true) {
      return [];
    }
    const context = this._getEvaluationContext(settings);
    const relevantTips = this.registry.filter((tip) => {
      try {
        return tip.isRelevant(context) === true;
      } catch (_error) {
        return false;
      }
    });
    return relevantTips.filter((tip) => {
      const cooldownSessions = Math.max(Number(tip.cooldownSessions || 0), 0);
      const sessionsSinceShown = this._getSessionsSinceShown(tip.id, settings);
      const allowed = sessionsSinceShown >= cooldownSessions;
      if (!allowed) {
        this._log('INFO', 'tips.cooldown_filtered', {
          tipId: tip.id,
          cooldownSessions,
          sessionsSinceShown,
        });
      }
      return allowed;
    });
  }

  _pickActiveTip(tips, settings) {
    if (!Array.isArray(tips) || !tips.length || settings.enabled !== true) {
      return null;
    }
    const history = settings.historyByTipId || {};
    const sorted = tips
      .map((tip) => {
        const lastShownAt = Number(history[tip.id]);
        const sessionsSinceShown = this._getSessionsSinceShown(tip.id, settings);
        return {
          tip,
          sessionsSinceShown,
          lastShownAt: Number.isFinite(lastShownAt) ? lastShownAt : -1,
        };
      })
      .sort((left, right) => {
        if (left.sessionsSinceShown !== right.sessionsSinceShown) {
          return right.sessionsSinceShown - left.sessionsSinceShown;
        }
        return left.lastShownAt - right.lastShownAt;
      });
    return sorted[0]?.tip || null;
  }

  _buildState() {
    const settings = this._getSettings();
    const relevantTips = this._resolveRelevantTips(settings);
    const activeTip = this._pickActiveTip(relevantTips, settings);
    return {
      featureEnabled: this.featureEnabled,
      settings,
      relevantTips,
      activeTip,
    };
  }

  refreshState({ emit = false, reason = 'tips_state_refreshed' } = {}) {
    this.lastState = this._buildState();
    const snapshot = cloneTipsState(this.lastState);
    if (emit) {
      this.emit('changed', snapshot, { reason });
    }
    return snapshot;
  }

  initializeSession() {
    this.configService.incrementTipsSessionCount();
    const settings = this._getSettings();
    const relevantTips = this._resolveRelevantTips(settings);
    const activeTip = this._pickActiveTip(relevantTips, settings);
    if (activeTip) {
      this.configService.recordTipShown(activeTip.id, settings.sessionCount);
    }
    const recordedSettings = this._getSettings();
    this.lastState = {
      featureEnabled: this.featureEnabled,
      settings: recordedSettings,
      relevantTips,
      activeTip,
    };
    const snapshot = cloneTipsState(this.lastState);
    this.emit('changed', snapshot, { reason: 'tips_session_initialized' });
    return snapshot;
  }

  getState() {
    return this.refreshState();
  }

  setFeatureEnabled(enabled) {
    void enabled;
    return this.getState();
  }

  updateSettings(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    this.configService.updateTipsSettings(source);
    return this.getState();
  }
}

module.exports = {
  TipsService,
  buildTipRegistry,
  cloneTipsState,
};
