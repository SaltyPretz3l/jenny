const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const counters = require('../renderer/features/renderer-personality-counters');
const personalityForm = require('../renderer/features/personality-form');
const { createPersonalityEditor } = require('../renderer/features/renderer-personality-utils');

const SECTION_HTML = `
  <section data-settings-section="personality">
    <span id="personalityStatus"></span>
    <div id="personalityFormHost"></div>
    <span id="personalityTokenLine"></span>
    <div id="personalityExactHost"></div>
    <div id="personalityExactPanelHost"></div>
    <div id="personalityActions"></div>
  </section>`;

function createHarness(t, overrides = {}) {
  const dom = new JSDOM(SECTION_HTML);
  const { document } = dom.window;
  const calls = { save: [], clear: 0, openFolder: 0 };
  dom.window.jennyShell = {
    personality: {
      async getState() {
        return {
          agentName: 'Jenny',
          files: { personality: { body: '' }, user: { body: '' } },
          budgets: { personality: 1500, user: 1000, memory: 1500 },
          compiled: { text: '', chars: 0, tokensEstimate: 0, sections: [] },
          schemaVersion: 3,
        };
      },
      async save(payload) {
        calls.save.push(payload);
        return { ok: true, agentName: payload.agentName, compiled: { text: '', tokensEstimate: 0 } };
      },
      async clear() {
        calls.clear += 1;
        return { ok: true, compiled: { text: '', tokensEstimate: 0 } };
      },
      async openWorkspaceFolder() {
        calls.openFolder += 1;
        return { ok: true };
      },
      ...overrides,
    },
  };
  const state = {
    personality: {
      agentName: 'Jenny', personality: '', user: '',
      saved: { agentName: 'Jenny', personality: '', user: '' },
      notesBody: '', dirty: false, loading: false, saving: false, savedAt: 0,
      actionStatus: '', loadStatus: '', schemaVersion: 0,
      budgets: { personality: 1500, user: 1000, memory: 1500 },
      compiled: { text: '', chars: 0, tokensEstimate: 0, sections: [] },
    },
  };
  const el = (id) => document.getElementById(id);
  const controller = createPersonalityEditor({
    state,
    windowRef: dom.window,
    now: () => 1700000000000,
    dom: {
      personalityStatus: el('personalityStatus'),
      personalityFormHost: el('personalityFormHost'),
      personalityTokenLine: el('personalityTokenLine'),
      personalityExactHost: el('personalityExactHost'),
      personalityExactPanelHost: el('personalityExactPanelHost'),
      personalityActions: el('personalityActions'),
    },
    callbacks: { escapeHtml: (value) => String(value == null ? '' : value) },
  });
  t.after(() => {
    controller.dispose();
    dom.window.close();
  });
  return { calls, controller, document, dom, el, state };
}

function typeInto(harness, suffix, value) {
  const field = harness.document.getElementById(`settings-personality-${suffix}`);
  field.value = value;
  field.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

test('body normalization drops frontmatter, comments and one H1 before counting', () => {
  assert.equal(counters.normalizeBody('# About you\n\n<!-- template -->\n\nBrendan.'), 'Brendan.');
  assert.equal(counters.normalizeBody('---\ntimezone: CST\n---\nBrendan.'), 'Brendan.');
  assert.equal(counters.normalizeBody('<!-- only a comment -->\n'), '');
  // A second H1 is body text, not chrome: only the leading one is stripped.
  assert.equal(counters.normalizeBody('# Title\n\nline\n\n# Second'), 'line\n\n# Second');
  assert.equal(counters.countChars('# Personality note\n\nBe warm.'), 'Be warm.'.length);
});

test('over-budget counters name the exact characters that will not be sent', () => {
  const under = counters.buildCounterModel('a'.repeat(1200), 1500);
  assert.equal(under.text, '1,200 / 1,500');
  assert.equal(under.over, false);

  const over = counters.buildCounterModel('a'.repeat(1507), 1500);
  assert.equal(over.over, true);
  assert.equal(over.overflow, 7);
  assert.match(over.text, /^1,507 \/ 1,500 — the last 7 characters won’t be sent$/);
});

test('per-section clipping marks the section instead of truncating the joined block', () => {
  const clipped = counters.clipToBudget('a'.repeat(60), 20);
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.text.length, 20);
  assert.ok(clipped.text.endsWith(' […]'));

  const compiled = counters.buildCompiledText(
    { agentName: 'Jenny', personality: 'a'.repeat(60), user: 'about', memory: 'notes' },
    { personality: 20, user: 1000, memory: 1500 }
  );
  assert.match(compiled, /### Voice\n\na+ \[…\]\n\n### About the user\n\nabout\n\n### Notes\n\nnotes$/);
  assert.equal(compiled.startsWith('## Personality\nYour name is Jenny. '), true);
});

test('an empty workspace compiles to the name line alone, well under 80 tokens', () => {
  const compiled = counters.buildCompiledText({ agentName: 'Jenny' }, personalityForm.BUDGETS);
  assert.equal(compiled.includes('### '), false);
  assert.ok(counters.estimateTokens(compiled) <= 80, `empty compile was ${counters.estimateTokens(compiled)} tokens`);
});

test('the lint hint fires only on an unexpanded placeholder', () => {
  assert.equal(counters.buildLintMessage('Today is {{current_date}}.'), counters.LINT_MESSAGE);
  assert.equal(counters.buildLintMessage('Today is fine.'), '');
});

test('status line precedence is action > load > dirty > saved', () => {
  const base = { actionStatus: 'Save failed: disk', loadStatus: 'Loading…', dirty: true, savedAt: 5 };
  assert.equal(counters.buildPersonalityStatusLine(base), 'Save failed: disk');
  assert.equal(counters.buildPersonalityStatusLine({ ...base, actionStatus: '' }), 'Loading…');
  assert.equal(counters.buildPersonalityStatusLine({ ...base, actionStatus: '', loadStatus: '' }), 'Unsaved changes');
  assert.equal(
    counters.buildPersonalityStatusLine({ dirty: false, savedAt: 1000, now: 1000 + 120000 }),
    'Saved · 2 min ago'
  );
  assert.equal(counters.buildPersonalityStatusLine({}), 'Ready');
});

test('typing marks the section dirty, enables the single Save, and updates counters live', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refreshPersonalityWorkspace();

  const saveButton = harness.document.querySelector('[data-action="personality-save"]');
  assert.equal(saveButton.disabled, true, 'Save is disabled while clean');
  assert.equal(harness.document.querySelectorAll('[data-action="personality-save"]').length, 1);
  assert.equal(harness.el('personalityStatus').textContent, 'Ready');

  typeInto(harness, 'note', 'a'.repeat(1600));

  assert.equal(harness.state.personality.dirty, true);
  assert.equal(harness.el('personalityStatus').textContent, 'Unsaved changes');
  assert.equal(harness.document.querySelector('[data-action="personality-save"]').disabled, false);

  const counter = harness.document.getElementById('settings-personality-note-counter');
  assert.match(counter.textContent, /1,600 \/ 1,500 — the last 100 characters won’t be sent/);
  assert.equal(counter.classList.contains('personality-counter--over'), true);
});

test('the lint hint appears under the field that contains the placeholder', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refreshPersonalityWorkspace();

  const lint = harness.document.getElementById('settings-personality-note-lint');
  assert.equal(lint.hasAttribute('hidden'), true);

  typeInto(harness, 'note', 'Today is {{current_date}}.');
  assert.equal(lint.hasAttribute('hidden'), false);
  assert.match(lint.textContent, /placeholders aren’t expanded/);
  assert.equal(
    harness.document.getElementById('settings-personality-user-lint').hasAttribute('hidden'),
    true,
    'the About-you lint must not fire for the note field'
  );
});

test('one save sends name, note and About you together and clears the dirty flag', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refreshPersonalityWorkspace();

  typeInto(harness, 'name', 'Echo');
  typeInto(harness, 'note', 'Be warm.');
  typeInto(harness, 'user', 'Brendan. CST.');
  await harness.controller.handlePersonalitySave();

  assert.deepEqual(harness.calls.save, [{ agentName: 'Echo', personality: 'Be warm.', user: 'Brendan. CST.' }]);
  assert.equal(harness.state.personality.dirty, false);
  assert.equal(harness.document.querySelector('[data-action="personality-save"]').disabled, true);
  assert.equal(harness.el('personalityStatus').textContent, 'Saved · just now');
});

test('a rejected save keeps the draft and reports the failure on the status line', async (t) => {
  const harness = createHarness(t, {
    async save() { return { ok: false, code: 'CMP-PERS-0001', failed: ['user'] }; },
  });
  await harness.controller.refreshPersonalityWorkspace();

  typeInto(harness, 'note', 'Be warm.');
  await harness.controller.handlePersonalitySave();

  assert.equal(harness.state.personality.personality, 'Be warm.');
  assert.equal(harness.state.personality.dirty, true);
  assert.match(
    harness.el('personalityStatus').textContent,
    /^Save failed \(CMP-PERS-0001\): could not write user\.$/
  );
});

test('picking a preset over owner text asks before replacing and Keep restores the selection', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refreshPersonalityWorkspace();
  typeInto(harness, 'note', 'You are a friend, not a help desk.');

  harness.controller.handleVoiceChange('concise');
  const confirmHost = harness.document.getElementById('settings-personality-voice-confirm');
  assert.equal(confirmHost.hasAttribute('hidden'), false);
  assert.match(confirmHost.textContent, /Replace your note with the Concise starting point\?/);
  assert.equal(harness.document.getElementById('settings-personality-note').value, 'You are a friend, not a help desk.');

  harness.controller.cancelPresetReplace();
  assert.equal(confirmHost.hasAttribute('hidden'), true);
  assert.equal(harness.document.getElementById('settings-personality-note').value, 'You are a friend, not a help desk.');
  assert.equal(
    harness.document.querySelectorAll('.inv-segmented-option[aria-checked="true"]').length,
    0,
    'a custom note leaves no preset selected'
  );

  harness.controller.handleVoiceChange('concise');
  harness.controller.confirmPresetReplace();
  assert.equal(
    harness.document.getElementById('settings-personality-note').value,
    personalityForm.PRESETS.concise
  );
  assert.equal(harness.document.querySelector('[data-value="concise"]').getAttribute('aria-checked'), 'true');
  assert.equal(harness.state.personality.dirty, true);
});

test('picking a preset over an empty note fills silently', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refreshPersonalityWorkspace();

  harness.controller.handleVoiceChange('mentor');

  assert.equal(
    harness.document.getElementById('settings-personality-voice-confirm').hasAttribute('hidden'),
    true
  );
  assert.equal(
    harness.document.getElementById('settings-personality-note').value,
    personalityForm.PRESETS.mentor
  );
});

test('Show exact text reveals the full compiled message including the Notes section', async (t) => {
  const harness = createHarness(t, {
    async getState() {
      return {
        agentName: 'Jenny',
        files: { personality: { body: 'Be warm.' }, user: { body: '' } },
        budgets: { personality: 1500, user: 1000, memory: 1500 },
        compiled: {
          text: '## Personality\nYour name is Jenny. x\n\n### Voice\n\nBe warm.\n\n### Notes\n\nBrendan drinks tea.',
          tokensEstimate: 20,
          sections: [{ id: 'personality', chars: 8 }, { id: 'memory', chars: 19 }],
        },
        schemaVersion: 3,
      };
    },
  });
  await harness.controller.refreshPersonalityWorkspace();

  const trigger = harness.document.querySelector('[data-inv-collapsible]');
  const panel = harness.document.getElementById('personalityExactText');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(panel.hasAttribute('hidden'), true);

  trigger.dispatchEvent(new harness.dom.window.Event('click', { bubbles: true }));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.hasAttribute('hidden'), false);

  const exact = harness.document.getElementById('personalityExactPre').textContent;
  assert.match(exact, /^## Personality\n/);
  assert.match(exact, /### Voice\n\nBe warm\./);
  assert.match(exact, /### Notes\n\nBrendan drinks tea\.$/);

  // The preview must track the draft, not the last compile: that mismatch is
  // exactly what made the v2 "exact request contribution" a lie.
  typeInto(harness, 'note', 'Be brisk.');
  const updated = harness.document.getElementById('personalityExactPre').textContent;
  assert.match(updated, /### Voice\n\nBe brisk\./);
  assert.match(updated, /### Notes\n\nBrendan drinks tea\.$/);
  assert.match(harness.el('personalityTokenLine').textContent, /^Sent with every message · about \d+ tokens$/);
});

test('a background refresh never clobbers an unsaved draft', async (t) => {
  let getStateCalls = 0;
  const harness = createHarness(t, {
    async getState() {
      getStateCalls += 1;
      return {
        agentName: 'Jenny',
        files: { personality: { body: 'from disk' }, user: { body: '' } },
        budgets: { personality: 1500, user: 1000, memory: 1500 },
        compiled: { text: '', tokensEstimate: 0, sections: [] },
        schemaVersion: 3,
      };
    },
  });
  await harness.controller.refreshPersonalityWorkspace();
  assert.equal(getStateCalls, 1, 'one IPC round trip per refresh');
  assert.equal(harness.state.personality.personality, 'from disk');

  typeInto(harness, 'note', 'unsaved local edit');
  await harness.controller.refreshPersonalityWorkspace();

  assert.equal(getStateCalls, 1, 'a dirty draft short-circuits the refresh');
  assert.equal(harness.state.personality.personality, 'unsaved local edit');
});

test('clear wipes both fields and warns before unload while dirty', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refreshPersonalityWorkspace();

  typeInto(harness, 'note', 'Be warm.');
  assert.equal(harness.controller.hasPersonalityUnsavedChanges(), true);
  const unloadEvent = new harness.dom.window.Event('beforeunload', { cancelable: true });
  harness.dom.window.dispatchEvent(unloadEvent);
  assert.equal(unloadEvent.defaultPrevented, true);

  await harness.controller.handlePersonalityReset();
  assert.equal(harness.calls.clear, 1);
  assert.equal(harness.state.personality.personality, '');
  assert.equal(harness.state.personality.user, '');
  assert.equal(harness.document.getElementById('settings-personality-note').value, '');
  assert.equal(harness.controller.hasPersonalityUnsavedChanges(), false);
});

/* ── Electron parity (services/personality-workspace-compile.js is the oracle) ── */

test('normalizeBody follows the Electron step order, including both frontmatter positions', () => {
  // Legacy USER.md put the H1 before the frontmatter; both layouts must reduce
  // to the same body or the counter and the wire disagree.
  assert.equal(counters.normalizeBody('# About you\n---\ntz: X\n---\nBody'), 'Body');
  assert.equal(counters.normalizeBody('---\ntz: X\n---\n# About you\n\nBody'), 'Body');
  assert.equal(counters.normalizeBody('\n\n---\ntz: X\n---\nBody'), 'Body');
  assert.equal(counters.normalizeBody('﻿# About you\r\n\r\nBrendan.\r\n'), 'Brendan.');
  assert.equal(counters.normalizeBody('<!-- template -->\n'), '');
  // An unterminated comment runs to end of text: a half-written aside must not
  // leak into the prompt just because the closer is missing.
  assert.equal(counters.normalizeBody('Body.\n<!-- still typing this'), 'Body.');
  assert.equal(counters.normalizeBody('a<!--x-->b<!--y'), 'ab');
  assert.equal(counters.normalizeBody('#NotAHeading\n\nbody'), '#NotAHeading\n\nbody');
  assert.equal(counters.normalizeBody('# Title\n\nline\n\n# Second'), 'line\n\n# Second');
});

test('clipToBudget slices UTF-16 code units and never leaves half a surrogate pair', () => {
  const emoji = '\u{1F600}'; // one code point, two code units
  const clipped = counters.clipToBudget(emoji.repeat(10), 9);
  assert.equal(clipped.clipped, true);
  assert.ok(clipped.text.endsWith(' […]'));
  const kept = clipped.text.slice(0, -' […]'.length);
  // 9 - 4 = 5 code units would split the third emoji; the dangling high
  // surrogate is dropped, leaving 4.
  assert.equal(kept.length, 4);
  assert.equal(kept, emoji.repeat(2));
  assert.doesNotMatch(kept, /[\uD800-\uDBFF]$/);
  assert.equal(counters.clipToBudget('abc', 3).clipped, false);
});

test('the joined preview is held under the 4 KiB UTF-8 backstop without dropping a section', () => {
  const cjk = '中';
  const compiled = counters.buildCompiledText({
    agentName: 'Jenny',
    personality: cjk.repeat(1400),
    user: cjk.repeat(900),
    memory: cjk.repeat(1400),
  }, personalityForm.BUDGETS);

  const sections = compiled.slice(compiled.indexOf('### Voice'));
  assert.ok(
    counters.utf8Length(sections) <= counters.ADVANCED_CONTEXT_MAX_BYTES,
    `sections were ${counters.utf8Length(sections)} bytes`
  );
  // Every heading survives: the backstop reserves them before distributing.
  assert.match(compiled, /### Voice/);
  assert.match(compiled, /### About the user/);
  assert.match(compiled, /### Notes/);
  assert.match(compiled, /\[…\]/);

  const under = counters.buildCompiledText(
    { agentName: 'Jenny', personality: 'short', user: 'short', memory: 'short' },
    personalityForm.BUDGETS
  );
  assert.doesNotMatch(under, /\[…\]/);
});

test('counters count the normalized body while the textarea holds the raw file text', async (t) => {
  const raw = '# Personality note\n\n<!-- keep this comment on disk -->\n\nBe warm.';
  const harness = createHarness(t, {
    async getState() {
      return {
        agentName: 'Jenny',
        files: { personality: { body: raw, chars: 8, oversized: false }, user: { body: '', chars: 0 } },
        budgets: { personality: 1500, user: 1000, memory: 1500 },
        compiled: { text: '', tokensEstimate: 0, sections: [] },
        schemaVersion: 3,
      };
    },
  });
  await harness.controller.refreshPersonalityWorkspace();

  // The editor round-trips the raw text so the comment survives a save...
  assert.equal(harness.document.getElementById('settings-personality-note').value, raw);
  // ...but the counter reports what is actually sent.
  assert.equal(
    harness.document.getElementById('settings-personality-note-counter').textContent,
    '8 / 1,500'
  );
});

/* ── Adversarial-review fixes ── */

test('an oversized file disables its textarea and Save, and names the code on failure', async (t) => {
  const harness = createHarness(t, {
    async getState() {
      return {
        agentName: 'Jenny',
        files: {
          personality: { body: '', chars: 0, oversized: true },
          user: { body: 'ok', chars: 2, oversized: false },
        },
        budgets: { personality: 1500, user: 1000, memory: 1500 },
        compiled: { text: '', tokensEstimate: 0, sections: [] },
        schemaVersion: 3,
      };
    },
    async save() { return { ok: false, code: 'CMP-PERS-0002', failed: ['personality'] }; },
  });
  await harness.controller.refreshPersonalityWorkspace();

  assert.equal(harness.document.getElementById('settings-personality-note').disabled, true);
  assert.equal(harness.document.getElementById('settings-personality-user').disabled, false);
  assert.equal(harness.document.querySelector('[data-action="personality-save"]').disabled, true);

  typeInto(harness, 'user', 'changed');
  assert.equal(
    harness.document.querySelector('[data-action="personality-save"]').disabled,
    true,
    'Save stays disabled while a file on disk is too large to write'
  );

  await harness.controller.handlePersonalitySave();
  assert.equal(
    harness.el('personalityStatus').textContent,
    'Save failed (CMP-PERS-0002): This file is larger than 64 KiB. Open the folder to edit it.'
  );
});

test('a name-only save failure keeps the files saved and restores the stored name', async (t) => {
  const harness = createHarness(t, {
    async save() {
      return {
        ok: false,
        failed: ['agentName'],
        agentName: 'Jenny',
        compiled: { text: '', tokensEstimate: 0 },
      };
    },
  });
  await harness.controller.refreshPersonalityWorkspace();

  typeInto(harness, 'name', 'Echo');
  typeInto(harness, 'note', 'Be warm.');
  await harness.controller.handlePersonalitySave();

  assert.equal(harness.el('personalityStatus').textContent, 'Name could not be saved; note saved.');
  assert.equal(harness.state.personality.agentName, 'Jenny');
  assert.equal(harness.document.getElementById('settings-personality-name').value, 'Jenny');
  assert.equal(harness.state.personality.personality, 'Be warm.', 'the note stays saved');
  assert.equal(harness.state.personality.dirty, false);
});

test('a failed clear surfaces its code and leaves the drafts alone', async (t) => {
  const harness = createHarness(t, {
    async clear() { return { ok: false, code: 'CMP-PERS-0001', failed: ['user'] }; },
  });
  await harness.controller.refreshPersonalityWorkspace();
  typeInto(harness, 'note', 'Be warm.');

  await harness.controller.handlePersonalityReset();

  assert.equal(
    harness.el('personalityStatus').textContent,
    'Clear failed (CMP-PERS-0001): could not write user.'
  );
  assert.equal(harness.state.personality.personality, 'Be warm.');
});

test('clear passes the current name through so the compile does not fall back to Jenny', async (t) => {
  const seen = [];
  const harness = createHarness(t, {
    async clear(payload) {
      seen.push(payload);
      return { ok: true, compiled: { text: '', tokensEstimate: 0 } };
    },
  });
  await harness.controller.refreshPersonalityWorkspace();
  typeInto(harness, 'name', 'Echo');

  await harness.controller.handlePersonalityReset();
  assert.deepEqual(seen, [{ agentName: 'Echo' }]);
});

test('the footer buttons are not rebuilt on every keystroke', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refreshPersonalityWorkspace();

  const before = harness.document.querySelector('[data-action="personality-save"]');
  typeInto(harness, 'note', 'a');
  const afterFirst = harness.document.querySelector('[data-action="personality-save"]');
  assert.notEqual(before, afterFirst, 'the clean -> dirty transition does rebuild');

  typeInto(harness, 'note', 'ab');
  typeInto(harness, 'note', 'abc');
  assert.equal(
    harness.document.querySelector('[data-action="personality-save"]'),
    afterFirst,
    'further keystrokes must not churn the action buttons'
  );
});
