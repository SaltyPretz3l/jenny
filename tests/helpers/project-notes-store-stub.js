'use strict';

// A stubbed jennyShell.projectNotes over an in-memory store with the service's
// revision, stale and journal behaviour. Shared by the Notes rail tests.

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function makeNote(overrides = {}) {
  return {
    projectId: 'project_alpha',
    text: 'line one\nline two',
    revision: 1,
    updatedAt: '2026-10-06T10:00:00.000Z',
    updatedBy: 'user',
    journal: [],
    ...overrides,
  };
}

// A stubbed jennyShell.projectNotes over an in-memory store with the service's
// revision, stale and journal behaviour.
function makeStore(initial = {}) {
  const notes = new Map(Object.entries(initial));
  const calls = [];
  let listener = null;
  const api = {
    get: async (projectId) => {
      calls.push(['get', projectId]);
      if (!notes.has(projectId)) notes.set(projectId, makeNote({ projectId, text: '', revision: 0 }));
      return { ok: true, note: structuredClone(notes.get(projectId)) };
    },
    save: async (projectId, text, baseRevision) => {
      calls.push(['save', projectId, text, baseRevision]);
      const current = notes.get(projectId);
      if (baseRevision !== current.revision) return { ok: false, reason: 'stale', current: structuredClone(current) };
      const next = { ...current, text, revision: current.revision + 1, updatedBy: 'user' };
      notes.set(projectId, next);
      return { ok: true, note: structuredClone(next) };
    },
    undo: async (projectId, entryId) => {
      calls.push(['undo', projectId, entryId]);
      return { ok: false, reason: 'changed_since' };
    },
    lease: async (projectId, held) => {
      calls.push(['lease', projectId, held]);
      return { ok: true, held, expiresAt: '' };
    },
    onChanged: (cb) => { listener = cb; return () => { listener = null; }; },
  };
  return {
    api,
    calls,
    notes,
    emit: (payload) => listener?.(payload),
    hasListener: () => listener !== null,
    // Jenny's tool write: appends text and journals it.
    jennyAppends(projectId, extra) {
      const current = notes.get(projectId);
      const entry = { id: `e${current.revision + 1}`, at: '2026-10-06T12:00:00.000Z', op: 'append', summary: 'x', undoable: true };
      const next = {
        ...current, text: `${current.text}\n${extra}`, revision: current.revision + 1, updatedBy: 'assistant', journal: [...current.journal, entry],
      };
      notes.set(projectId, next);
      return next;
    },
  };
}

module.exports = { flush, makeNote, makeStore };
