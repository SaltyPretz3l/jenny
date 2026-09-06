'use strict';

const { buildFeatureFlags } = require('../feature-flags');

function createSpellcheckSessionController({
  sessionRef = null,
  getShellConfigService = () => null,
  env = process.env,
  log = () => {},
} = {}) {
  const safeLog = (level, event, details) => {
    try {
      log(level, event, details);
    } catch (_error) {
      /* logging must not turn a fail-soft path into a startup failure */
    }
  };

  let configService = null;
  try {
    configService = getShellConfigService();
  } catch (error) {
    safeLog('WARN', 'spellcheck.session_subscribe_failed', {
      message: String(error?.message || error).slice(0, 200),
    });
  }

  function apply() {
    try {
      const overrides = configService?.getState?.()?.featureOverrides;
      const enabled = buildFeatureFlags(env, overrides).text_spellcheck !== false;
      if (!sessionRef || typeof sessionRef.setSpellCheckerEnabled !== 'function') {
        safeLog('WARN', 'spellcheck.session_apply_failed', { reason: 'session_unavailable' });
        return;
      }
      if (sessionRef.isSpellCheckerEnabled?.() === enabled) return;
      sessionRef.setSpellCheckerEnabled(enabled);
      safeLog('INFO', 'spellcheck.session_enabled', { enabled });
    } catch (error) {
      safeLog('WARN', 'spellcheck.session_apply_failed', {
        message: String(error?.message || error).slice(0, 200),
      });
    }
  }

  const handleChanged = () => apply();
  let subscribed = false;
  if (typeof configService?.on !== 'function') {
    safeLog('WARN', 'spellcheck.session_subscribe_failed', { reason: 'config_service_unavailable' });
  } else {
    try {
      configService.on('changed', handleChanged);
      subscribed = true;
    } catch (error) {
      safeLog('WARN', 'spellcheck.session_subscribe_failed', {
        message: String(error?.message || error).slice(0, 200),
      });
    }
  }

  function dispose() {
    if (!subscribed) return;
    subscribed = false;
    try {
      configService.off('changed', handleChanged);
    } catch (_error) {
      /* disposal is best-effort during shutdown */
    }
  }

  return { apply, dispose };
}

module.exports = { createSpellcheckSessionController };
