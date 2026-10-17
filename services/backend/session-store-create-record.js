'use strict';

const crypto = require('crypto');
const { GENERAL_PROJECT_ID } = require('../projects/project-schema');
const { normalizeSessionStartDate } = require('./session-normalizers');
const { buildSessionPreferencesPatch } = require('./session-preferences-patch');
const { normalizeSpawnedFrom } = require('./session-coordination-records');
const { normalizeSessionType, normalizePluginSession, createOfficialImagePluginSession } = require('./session-type');

function buildCreatedSession(sessionId, {
  title, preferences, sessionType, pluginSession, imageConfig, composerDraft, linkedTaskId, projectId,
  sessionIncarnation, spawnedFrom,
} = {}, { normalizeSession, clipTitle }) {
  if (sessionIncarnation !== undefined && (typeof sessionIncarnation !== 'string'
    || !/^inc_[0-9a-f]{32}$/.test(sessionIncarnation))) throw new TypeError('session_incarnation_invalid');
  const provenance = normalizeSpawnedFrom(spawnedFrom);
  if (spawnedFrom !== undefined && (!provenance || provenance.schema_version !== 1)) {
    throw new TypeError('spawned_from_invalid');
  }
  const createdAt = new Date().toISOString();
  const rawSessionType = String(sessionType || '').trim().toLowerCase();
  const normalizedType = normalizeSessionType(rawSessionType);
  const normalizedPluginSession = normalizedType === 'plugin'
    ? (normalizePluginSession(pluginSession)
      || (rawSessionType === 'image' ? createOfficialImagePluginSession(imageConfig) : null))
    : null;
  if (normalizedType === 'plugin' && !normalizedPluginSession) return null;
  const session = normalizeSession(sessionId, {
    title: clipTitle(title),
    project_id: projectId || GENERAL_PROJECT_ID,
    session_type: normalizedType,
    plugin_session: normalizedPluginSession,
    session_start_date: normalizeSessionStartDate(preferences && preferences.session_start_date, createdAt),
    ...buildSessionPreferencesPatch(preferences),
    created_at: createdAt,
    updated_at: createdAt,
    session_incarnation: sessionIncarnation ?? `inc_${crypto.randomUUID().replace(/-/g, '')}`,
    ...(provenance ? { spawned_from: provenance } : {}),
    ...(composerDraft ? { composer_draft: composerDraft } : {}),
    ...(linkedTaskId ? { linked_task_id: linkedTaskId } : {}),
    messages: [],
  });
  if (provenance) session.session_mail.reporting_enabled = true;
  return session;
}

module.exports = { buildCreatedSession };
