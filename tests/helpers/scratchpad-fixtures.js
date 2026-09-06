// Shared fixtures for the Home scratchpad widget/actions tests. Mirrors the
// schema default in services/home-config-schema.js — keep these in sync if the
// scratchpad shape changes. Imported by both renderer-dashboard-scratchpad-*
// test files so the fixtures live in exactly one place.

// A minimal notes-model scratchpad with one active note.
function scratch(text = '') {
  return {
    notes: [{ id: 'note-1', title: 'Note 1', text, updatedAt: '', appendLog: false }],
    activeNoteId: 'note-1',
    settings: { rows: 6, font: 'prose', captureMode: 'append', markdown: false, globalCapture: true },
  };
}

// Two named notes; pass the id (or a dangling id) to choose the active one.
function twoNotesActive(activeNoteId) {
  return {
    notes: [
      { id: 'note-1', title: 'Alpha', text: 'A', updatedAt: '', appendLog: false },
      { id: 'note-2', title: 'Beta', text: 'B', updatedAt: '', appendLog: false },
    ],
    activeNoteId,
    settings: { rows: 6, font: 'prose', captureMode: 'overwrite' },
  };
}

// Wrap a scratchpad in the render ctx with the scratchpad_v2 flag on.
function flagOnCtx(scratchpad) {
  return { state: { features: { featureFlags: { scratchpad_v2: true } }, homeConfig: { scratchpad } } };
}

module.exports = { scratch, twoNotesActive, flagOnCtx };
