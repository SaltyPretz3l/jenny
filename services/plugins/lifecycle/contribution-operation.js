'use strict';

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { deriveContributionStates, runActivationOperation } = require('./activation-operation');

async function runContributionOperation(facade, baseDir, options = {}) {
  const {
    operation, contributionId, enabled, settingsRef, expectedGenerationId,
    dependencyMap = new Map(),
  } = options;
  if (!['set_contribution', 'update_settings'].includes(operation)) {
    return { ok: false, code: PLUGIN_ERROR_CODES.POLICY_BLOCKED, reason: 'contribution_operation_invalid' };
  }
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(String(contributionId || ''))) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'contribution_id_invalid' };
  }
  return runActivationOperation(facade, baseDir, {
    ...options,
    requireConsent: options.requireConsent || (async () => ({ ok: true })),
    candidatePluginsFactory: async (snapshot) => {
      if (snapshot.generation?.generation_schema_version !== 2
        || snapshot.generation.generation_id !== expectedGenerationId) return null;
      return snapshot.plugins.map((entry) => {
        if (entry.publisher_id !== options.publisherId || entry.plugin_id !== options.pluginId) return entry;
        const contributions = entry.contributions.map((item) => {
          if (item.contribution_id !== contributionId) return { ...item };
          if (operation === 'set_contribution') {
            if (item.kind === 'mcp_descriptor' && enabled === true) return { ...item };
            return { ...item, desired_enabled: enabled === true };
          }
          return { ...item, settings_ref: settingsRef };
        });
        return { ...entry, contributions: deriveContributionStates({ ...entry, contributions }, dependencyMap) };
      });
    },
  });
}

module.exports = { deriveContributionStates, runContributionOperation };
