const { normalizeString } = require('./backend/path-utils');
const { COMPANION_ERROR_CODES } = require('./backend/error-codes');
const {
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
  normalizeFollowUp,
  normalizeFollowUpDeferPreset,
} = require('./shell-config-state');
const {
  buildFollowUpId,
  calculateDeferredUntilForPreset,
  followUpRecordsEqual,
  getFollowUpPresetLabel,
  readPatchedValue,
  readPatchedIsoString,
  readPatchedString,
  resolveRequestedFollowUpStatus,
} = require('./shell-config-followups');

function companionFollowUpError(message) {
  const error = new Error(message);
  error.code = COMPANION_ERROR_CODES.FOLLOW_UP_INVALID;
  error.errorCode = COMPANION_ERROR_CODES.FOLLOW_UP_INVALID;
  return error;
}

function assertAllowedFollowUpPayload(followUp = {}) {
  if (!followUp || typeof followUp !== 'object' || Array.isArray(followUp)) {
    throw companionFollowUpError('Follow-up payload must be an object.');
  }
  const label = readPatchedValue(followUp, 'label', null);
  const body = readPatchedValue(followUp, 'body', null);
  if (typeof label !== 'undefined' && normalizeString(label).length > MAX_FOLLOW_UP_LABEL_CHARS) {
    throw companionFollowUpError(
      `Follow-up label exceeds the ${MAX_FOLLOW_UP_LABEL_CHARS} character limit.`
    );
  }
  if (typeof body !== 'undefined' && normalizeString(body).length > MAX_FOLLOW_UP_BODY_CHARS) {
    throw companionFollowUpError(
      `Follow-up body exceeds the ${MAX_FOLLOW_UP_BODY_CHARS} character limit.`
    );
  }
}

const followUpActionMethods = {
  _buildFollowUpRecord(payload, existing = null, now = this._getNow(), scheduleOptions = {}) {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const nowIso = now.toISOString();
    const id = normalizeString(existing?.id)
      || readPatchedString(source, 'id', null, '')
      || buildFollowUpId(now);
    if (!id) {
      return null;
    }
    const createdAt = readPatchedIsoString(source, 'createdAt', 'created_at', '')
      || normalizeString(existing?.createdAt)
      || nowIso;
    const status = resolveRequestedFollowUpStatus(source, existing);
    const existingSourceMeta =
      existing?.sourceMeta && typeof existing.sourceMeta === 'object' && !Array.isArray(existing.sourceMeta)
        ? existing.sourceMeta
        : {};
    const nextFollowUp = {
      id,
      label: readPatchedString(source, 'label', null, normalizeString(existing?.label) || 'Follow-up') || 'Follow-up',
      body: readPatchedString(source, 'body', null, normalizeString(existing?.body)),
      status,
      createdAt,
      updatedAt: readPatchedIsoString(source, 'updatedAt', 'updated_at', '') || nowIso,
      resolvedAt: '',
      deferredUntil: '',
      deferPreset: '',
      archivedAt:
        readPatchedIsoString(source, 'archivedAt', 'archived_at', '')
        || normalizeString(existing?.archivedAt),
      sessionId: readPatchedString(source, 'sessionId', 'session_id', normalizeString(existing?.sessionId)),
      sourceKind: readPatchedString(source, 'sourceKind', 'source_kind', normalizeString(existing?.sourceKind)),
      sourceId: readPatchedString(source, 'sourceId', 'source_id', normalizeString(existing?.sourceId)),
      sourceMeta:
        typeof readPatchedValue(source, 'sourceMeta', 'source_meta') !== 'undefined'
          ? readPatchedValue(source, 'sourceMeta', 'source_meta')
          : existingSourceMeta,
      history: Array.isArray(source.history)
        ? source.history
        : Array.isArray(existing?.history)
          ? existing.history
          : [],
    };

    if (status === 'resolved') {
      nextFollowUp.resolvedAt =
        readPatchedIsoString(source, 'resolvedAt', 'resolved_at', '')
        || normalizeString(existing?.resolvedAt)
        || nowIso;
    }

    if (status === 'deferred') {
      const patchedPreset = normalizeFollowUpDeferPreset(
        readPatchedString(source, 'deferPreset', 'defer_preset', '')
      );
      const patchedDeferredUntil = readPatchedIsoString(source, 'deferredUntil', 'deferred_until', '');
      const existingDeferredUntil = normalizeString(existing?.deferredUntil);
      const existingPreset = normalizeFollowUpDeferPreset(existing?.deferPreset);
      nextFollowUp.deferPreset = patchedPreset || existingPreset;
      nextFollowUp.deferredUntil =
        patchedDeferredUntil
        || existingDeferredUntil
        || (patchedPreset
          ? calculateDeferredUntilForPreset(nextFollowUp.deferPreset, now, scheduleOptions)
          : '');
      if (!nextFollowUp.deferredUntil) {
        throw new Error('Deferred follow-ups require a valid preset or deferredUntil timestamp.');
      }
    }

    return normalizeFollowUp(nextFollowUp);
  },

  _appendFollowUpHistory(followUp, kind, detail, at = this._getNow().toISOString()) {
    return normalizeFollowUp({
      ...followUp,
      history: [
        {
          kind,
          at,
          detail: normalizeString(detail),
        },
        ...(Array.isArray(followUp?.history) ? followUp.history : []),
      ].slice(0, 12),
    });
  },

  _withFollowUpUpdate(followUpId, buildNextFollowUp, reason, details = {}) {
    const normalizedId = normalizeString(followUpId);
    if (!normalizedId) {
      return this.getState();
    }
    const existing = this.state.followUps.find((followUp) => followUp.id === normalizedId) || null;
    if (!existing) {
      return this.getState();
    }
    const nextFollowUp = buildNextFollowUp(existing, this._getNow());
    if (!nextFollowUp || followUpRecordsEqual(existing, nextFollowUp)) {
      return this.getState();
    }
    return this._writeState(
      {
        ...this.state,
        followUps: this.state.followUps.map((followUp) =>
          followUp.id === normalizedId ? nextFollowUp : followUp
        ),
      },
      reason,
      { followUpId: normalizedId, ...details }
    );
  },

  upsertFollowUp(payload, scheduleOptions = {}) {
    assertAllowedFollowUpPayload(payload);
    const normalizedId = normalizeString(payload?.id);
    const existing = normalizedId
      ? this.state.followUps.find((entry) => entry.id === normalizedId) || null
      : null;
    const followUp = this._buildFollowUpRecord(payload, existing, this._getNow(), scheduleOptions);
    if (!followUp.id) {
      return this.getState();
    }
    const existingIndex = this.state.followUps.findIndex((entry) => entry.id === followUp.id);
    if (existingIndex >= 0 && followUpRecordsEqual(this.state.followUps[existingIndex], followUp)) {
      return this.getState();
    }
    const historyKind = existingIndex >= 0 ? 'edited' : 'created';
    const historyDetail = existingIndex >= 0
      ? 'Updated open loop details.'
      : followUp.status === 'deferred'
        ? `Created and deferred until ${getFollowUpPresetLabel(followUp.deferPreset || 'tomorrow')}.`
        : 'Created open loop.';
    const trackedFollowUp = this._appendFollowUpHistory(
      followUp,
      historyKind,
      historyDetail,
      followUp.updatedAt || followUp.createdAt || this._getNow().toISOString()
    );
    const nextFollowUps = [...this.state.followUps];
    if (existingIndex >= 0) {
      nextFollowUps[existingIndex] = trackedFollowUp;
    } else {
      nextFollowUps.push(trackedFollowUp);
    }
    return this._writeState(
      {
        ...this.state,
        followUps: nextFollowUps,
      },
      'follow_up_upserted',
      { followUpId: followUp.id }
    );
  },

  resolveFollowUp(id) {
    return this._withFollowUpUpdate(
      id,
      (existing, now) => {
        if (existing.status === 'resolved' && !existing.archivedAt) {
          return existing;
        }
        const nowIso = now.toISOString();
        return this._appendFollowUpHistory(
          {
            ...existing,
            status: 'resolved',
            updatedAt: nowIso,
            resolvedAt: nowIso,
            deferredUntil: '',
            deferPreset: '',
            archivedAt: '',
          },
          'resolved',
          'Marked complete.',
          nowIso
        );
      },
      'follow_up_resolved'
    );
  },

  deferFollowUp(id, preset, scheduleOptions = {}) {
    const normalizedId = normalizeString(id);
    const normalizedPreset = normalizeFollowUpDeferPreset(preset);
    if (!normalizedId || !normalizedPreset) {
      throw new Error(`Invalid defer preset: ${preset}`);
    }
    const existing = this.state.followUps.find((followUp) => followUp.id === normalizedId) || null;
    if (!existing) {
      return this.getState();
    }
    const now = this._getNow();
    const nowIso = now.toISOString();
    const deferredUntil = calculateDeferredUntilForPreset(normalizedPreset, now, scheduleOptions);
    if (
      existing.status === 'deferred'
      && existing.deferPreset === normalizedPreset
      && existing.deferredUntil === deferredUntil
    ) {
      return this.getState();
    }
    return this._withFollowUpUpdate(
      normalizedId,
      (existing) => {
        if (
          existing.status === 'deferred'
          && existing.deferPreset === normalizedPreset
          && existing.deferredUntil === deferredUntil
        ) {
          return existing;
        }
        return this._appendFollowUpHistory(
          {
            ...existing,
            status: 'deferred',
            updatedAt: nowIso,
            resolvedAt: '',
            deferredUntil,
            deferPreset: normalizedPreset,
            archivedAt: '',
          },
          'deferred',
          `Deferred until ${getFollowUpPresetLabel(normalizedPreset)}.`,
          nowIso
        );
      },
      'follow_up_deferred',
      { preset: normalizedPreset }
    );
  },

  activateFollowUp(id) {
    return this._withFollowUpUpdate(
      id,
      (existing, now) => {
        if (existing.status === 'active' && !existing.deferredUntil && !existing.deferPreset) {
          return existing;
        }
        const nowIso = now.toISOString();
        return this._appendFollowUpHistory(
          {
            ...existing,
            status: 'active',
            updatedAt: nowIso,
            resolvedAt: '',
            deferredUntil: '',
            deferPreset: '',
            archivedAt: '',
          },
          'activated',
          existing.status === 'resolved' ? 'Reopened open loop.' : 'Moved back to active.',
          nowIso
        );
      },
      'follow_up_activated'
    );
  },

  updateFollowUp(id, patch = {}, scheduleOptions = {}) {
    const normalizedId = normalizeString(id);
    if (!normalizedId || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return this.getState();
    }
    assertAllowedFollowUpPayload(patch);
    return this._withFollowUpUpdate(
      normalizedId,
      (existing, now) => {
        const safePatch = { ...patch };
        if (existing.archivedAt || existing.status === 'resolved') {
          delete safePatch.status;
          delete safePatch.resolved;
          delete safePatch.deferPreset;
          delete safePatch.defer_preset;
          delete safePatch.deferredUntil;
          delete safePatch.deferred_until;
        }
        const nextFollowUp = this._buildFollowUpRecord(
          {
            ...existing,
            ...safePatch,
            id: normalizedId,
            updatedAt: now.toISOString(),
          },
          existing,
          now,
          scheduleOptions
        );
        if (followUpRecordsEqual(existing, nextFollowUp)) {
          return existing;
        }
        const detailsChanged =
          nextFollowUp.label !== existing.label
          || nextFollowUp.body !== existing.body;
        const timingChanged =
          nextFollowUp.status !== existing.status
          || nextFollowUp.deferPreset !== existing.deferPreset
          || nextFollowUp.deferredUntil !== existing.deferredUntil;
        const detail = detailsChanged && timingChanged
          ? 'Updated details and timing.'
          : timingChanged
            ? 'Updated timing.'
            : 'Updated details.';
        return this._appendFollowUpHistory(nextFollowUp, 'edited', detail, now.toISOString());
      },
      'follow_up_updated'
    );
  },

  archiveFollowUp(id) {
    const normalizedId = normalizeString(id);
    if (!normalizedId) {
      return this.getState();
    }
    const existing = this.state.followUps.find((followUp) => followUp.id === normalizedId) || null;
    if (!existing) {
      return this.getState();
    }
    if (existing.status !== 'resolved') {
      throw new Error('Only resolved open loops can be archived.');
    }
    return this._withFollowUpUpdate(
      normalizedId,
      (existing, now) => {
        if (existing.archivedAt) {
          return existing;
        }
        const nowIso = now.toISOString();
        return this._appendFollowUpHistory(
          {
            ...existing,
            updatedAt: nowIso,
            archivedAt: nowIso,
          },
          'archived',
          'Archived from Home.',
          nowIso
        );
      },
      'follow_up_archived'
    );
  },

  unarchiveFollowUp(id) {
    return this._withFollowUpUpdate(
      id,
      (existing, now) => {
        if (!existing.archivedAt) {
          return existing;
        }
        const nowIso = now.toISOString();
        return this._appendFollowUpHistory(
          {
            ...existing,
            status: 'resolved',
            updatedAt: nowIso,
            archivedAt: '',
          },
          'unarchived',
          'Restored to recently completed.',
          nowIso
        );
      },
      'follow_up_unarchived'
    );
  },

  deleteFollowUp(id) {
    const normalizedId = normalizeString(id);
    if (!normalizedId) {
      return this.getState();
    }
    return this._writeState(
      {
        ...this.state,
        followUps: this.state.followUps.filter((followUp) => followUp.id !== normalizedId),
      },
      'follow_up_deleted',
      { followUpId: normalizedId }
    );
  },
};

module.exports = { followUpActionMethods };
