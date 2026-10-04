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

// Wrap a scratchpad in the render ctx.
function flagOnCtx(scratchpad) {
  return { state: { features: { featureFlags: {} }, homeConfig: { scratchpad } } };
}

function createTimerStub() {
  const timers = [];
  return {
    timers,
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    },
    async fire() {
      for (const timer of timers.splice(0)) {
        if (!timer.cleared) {
          timer.fn();
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

// Pass `getScratchpad` to echo the MERGED config: scratchpadEchoMatches() rejects
// an acknowledgement missing notes/activeNoteId/settings/pins, so a bare pointer
// echo reads as a FAILED write. See hyg-W7 / W7e-18-F01.
function createShellStub(getScratchpad) {
  const calls = { updates: [], followUps: [] };
  return {
    calls,
    shell: {
      home: {
        updateConfig: async (patch) => {
          calls.updates.push(patch);
          const base = (getScratchpad && getScratchpad()) || {};
          return {
            links: [], widgets: {}, calendar: {}, focusMode: false, showContextualTips: true,
            scratchpad: { ...base, ...patch.scratchpad, pins: patch.scratchpad?.pins || base.pins || [] },
          };
        },
      },
      companion: {
        addFollowUp: async (payload) => {
          calls.followUps.push(payload);
          return { openLoopsBoard: { counts: { active: 1 } } };
        },
      },
    },
  };
}

module.exports = { scratch, twoNotesActive, flagOnCtx, createTimerStub, createShellStub };
