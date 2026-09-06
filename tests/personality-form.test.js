const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const personalityForm = require('../renderer/features/personality-form');

function mount(html) {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.getElementById('host');
  host.innerHTML = html;
  return { dom, host };
}

test('presets are the exact spec sentences and Custom is derived, never stored', () => {
  assert.deepEqual(Object.keys(personalityForm.PRESETS).sort(), ['balanced', 'concise', 'creative', 'mentor']);
  assert.equal(
    personalityForm.PRESETS.balanced,
    "Warm, clear, and direct. Adapt to the moment; don't perform familiarity."
  );
  assert.equal(
    personalityForm.PRESETS.concise,
    'Shortest complete answer. Keep required caveats, drop everything else.'
  );
  assert.equal(personalityForm.PRESETS.creative, 'Inventive when it helps; always concrete and accurate.');
  assert.equal(
    personalityForm.PRESETS.mentor,
    "Explain the key reasoning and tradeoffs; don't bloat simple answers."
  );

  assert.equal(personalityForm.deriveVoice(personalityForm.PRESETS.mentor), 'mentor');
  assert.equal(personalityForm.deriveVoice(`  ${personalityForm.PRESETS.creative}  `), 'creative');
  assert.equal(personalityForm.deriveVoice('Be a friend, not a help desk.'), 'custom');
  assert.equal(personalityForm.deriveVoice(''), 'custom');
  // A near-miss must NOT claim a preset: the runtime sends the note verbatim,
  // so "close enough" would mislabel text the owner actually wrote.
  assert.equal(personalityForm.deriveVoice(`${personalityForm.PRESETS.mentor} Also be brief.`), 'custom');
});

test('preset picks fill silently over empty or preset text and confirm over owner text', () => {
  assert.equal(personalityForm.shouldConfirmPresetReplace(''), false);
  assert.equal(personalityForm.shouldConfirmPresetReplace('   \n  '), false);
  assert.equal(personalityForm.shouldConfirmPresetReplace(personalityForm.PRESETS.balanced), false);
  assert.equal(personalityForm.shouldConfirmPresetReplace('You are a friend, not a help desk.'), true);
});

test('normalize clamps the name at 80 chars, defaults to Jenny, and reads the getState file shape', () => {
  const long = 'x'.repeat(120);
  assert.equal(personalityForm.normalize({ agentName: long }).agentName.length, 80);
  assert.equal(personalityForm.normalize({ agentName: '   ' }).agentName, 'Jenny');
  assert.equal(personalityForm.normalize(null).agentName, 'Jenny');

  const fromIpc = personalityForm.normalize({
    agentName: 'Echo',
    files: { personality: { body: 'note body' }, user: { body: 'about body' } },
  });
  assert.deepEqual(fromIpc, { agentName: 'Echo', personality: 'note body', user: 'about body' });
});

test('render/read round-trip is identical for the Settings and setup id prefixes', () => {
  const state = { agentName: 'Echo', personality: 'Be warm.', user: 'Brendan. CST.' };
  for (const idPrefix of ['settings-personality', 'setup-personality']) {
    const { dom, host } = mount(personalityForm.render(state, { idPrefix }));
    try {
      const nameEl = host.querySelector(`#${idPrefix}-name`);
      const noteEl = host.querySelector(`#${idPrefix}-note`);
      const userEl = host.querySelector(`#${idPrefix}-user`);
      assert.ok(nameEl && noteEl && userEl, `${idPrefix} renders all three fields`);
      assert.equal(nameEl.value, 'Echo');
      assert.equal(noteEl.value, 'Be warm.');
      assert.equal(userEl.value, 'Brendan. CST.');
      assert.deepEqual(personalityForm.read(host, { idPrefix }), state);
    } finally {
      dom.window.close();
    }
  }
});

test('read falls back to the supplied draft when a control is missing', () => {
  const { dom, host } = mount('<div></div>');
  try {
    assert.deepEqual(
      personalityForm.read(host, {
        idPrefix: 'settings-personality',
        fallback: { agentName: 'Echo', personality: 'kept', user: 'kept too' },
      }),
      { agentName: 'Echo', personality: 'kept', user: 'kept too' }
    );
  } finally {
    dom.window.close();
  }
});

test('the form uses inventory primitives and labels every control', () => {
  const { dom, host } = mount(personalityForm.render(
    { agentName: 'Jenny', personality: personalityForm.PRESETS.concise, user: '' },
    { idPrefix: 'settings-personality' }
  ));
  try {
    assert.equal(host.querySelectorAll('.inv-text-field').length, 3);
    const group = host.querySelector('[role="radiogroup"].inv-segmented');
    assert.ok(group, 'voice renders as the segmented-control primitive');
    assert.equal(group.getAttribute('aria-label'), 'Voice preset (currently Concise)');
    assert.equal(group.getAttribute('aria-describedby'), 'settings-personality-voice-hint');
    const options = host.querySelectorAll('.inv-segmented-option');
    assert.equal(options.length, 4);
    const checked = Array.from(options).filter((option) => option.getAttribute('aria-checked') === 'true');
    assert.equal(checked.length, 1);
    assert.equal(checked[0].getAttribute('data-value'), 'concise');

    for (const suffix of ['name', 'note', 'user']) {
      const control = host.querySelector(`#settings-personality-${suffix}`);
      assert.ok(control.getAttribute('aria-label'), `${suffix} control has an accessible name`);
      assert.ok(
        host.querySelector(`label.personality-row-label[for="settings-personality-${suffix}"]`),
        `${suffix} has a visible associated label`
      );
    }
    assert.equal(host.querySelector('#settings-personality-name').getAttribute('maxlength'), '80');
  } finally {
    dom.window.close();
  }
});

test('compact mode drops the About-you counter but keeps the note counter', () => {
  const { dom, host } = mount(personalityForm.render(
    { agentName: 'Jenny' },
    { idPrefix: 'setup-personality', compact: true }
  ));
  try {
    assert.ok(host.querySelector('#setup-personality-note-counter'));
    assert.equal(host.querySelector('#setup-personality-user-counter'), null);
  } finally {
    dom.window.close();
  }
});

test('syncVoiceSelection clears every selection for a custom note without losing the tab stop', () => {
  const { dom, host } = mount(personalityForm.render(
    { agentName: 'Jenny', personality: personalityForm.PRESETS.mentor },
    { idPrefix: 'settings-personality' }
  ));
  try {
    const group = host.querySelector('.inv-segmented');
    personalityForm.syncVoiceSelection(group, 'custom');
    const options = Array.from(host.querySelectorAll('.inv-segmented-option'));
    assert.deepEqual(options.map((option) => option.getAttribute('aria-checked')), ['false', 'false', 'false', 'false']);
    assert.equal(
      options.filter((option) => option.getAttribute('tabindex') === '0').length,
      1,
      'the group stays reachable by Tab even with nothing selected'
    );

    personalityForm.syncVoiceSelection(group, 'creative');
    assert.equal(host.querySelector('[data-value="creative"]').getAttribute('aria-checked'), 'true');
    assert.equal(host.querySelector('[data-value="mentor"]').getAttribute('aria-checked'), 'false');
  } finally {
    dom.window.close();
  }
});

test('both textareas and the voice group carry aria-describedby, counters are live regions', () => {
  const { dom, host } = mount(personalityForm.render(
    { agentName: 'Jenny', personality: '', user: '' },
    { idPrefix: 'settings-personality' }
  ));
  try {
    assert.equal(
      host.querySelector('#settings-personality-note').getAttribute('aria-describedby'),
      'settings-personality-note-hint settings-personality-note-counter settings-personality-note-lint'
    );
    assert.equal(
      host.querySelector('#settings-personality-user').getAttribute('aria-describedby'),
      'settings-personality-user-hint settings-personality-user-counter settings-personality-user-lint'
    );
    // Every referenced id must actually resolve, or the description is silence.
    for (const attr of ['settings-personality-note', 'settings-personality-user']) {
      for (const id of host.querySelector(`#${attr}`).getAttribute('aria-describedby').split(' ')) {
        assert.ok(host.querySelector(`#${id}`), `${id} resolves`);
      }
    }
    for (const suffix of ['note', 'user']) {
      assert.equal(
        host.querySelector(`#settings-personality-${suffix}-counter`).getAttribute('aria-live'),
        'polite'
      );
    }
  } finally {
    dom.window.close();
  }
});

test('the voice group name carries the derived state so "custom" is announced', () => {
  assert.equal(personalityForm.voiceAriaLabel('custom'), 'Voice preset (currently custom)');
  assert.equal(personalityForm.voiceAriaLabel('mentor'), 'Voice preset (currently Mentor)');
  assert.equal(personalityForm.voiceAriaLabel(''), 'Voice preset (currently custom)');

  const { dom, host } = mount(personalityForm.render(
    { agentName: 'Jenny', personality: 'My own words.' },
    { idPrefix: 'settings-personality' }
  ));
  try {
    assert.equal(
      host.querySelector('.inv-segmented').getAttribute('aria-label'),
      'Voice preset (currently custom)'
    );
  } finally {
    dom.window.close();
  }
});

test('an oversized file renders its textarea disabled with the open-folder message', () => {
  const { dom, host } = mount(personalityForm.render(
    { agentName: 'Jenny', personality: '', user: '' },
    { idPrefix: 'settings-personality', oversized: { personality: true, user: false } }
  ));
  try {
    assert.equal(host.querySelector('#settings-personality-note').disabled, true);
    assert.equal(host.querySelector('#settings-personality-user').disabled, false);
    const lint = host.querySelector('#settings-personality-note-lint');
    assert.equal(lint.hasAttribute('hidden'), false);
    assert.equal(lint.textContent, 'This file is larger than 64 KiB. Open the folder to edit it.');
    assert.equal(host.querySelector('#settings-personality-user-lint').hasAttribute('hidden'), true);
  } finally {
    dom.window.close();
  }
});

test('the preset controller fills silently, confirms over owner text, and restores on Keep', () => {
  const { dom, host } = mount(personalityForm.render(
    { agentName: 'Jenny', personality: '' },
    { idPrefix: 'settings-personality' }
  ));
  try {
    let note = '';
    let renders = 0;
    const presets = personalityForm.createPresetController({
      getNote: () => note,
      setNote: (value) => { note = value; },
      fieldEl: (suffix) => host.querySelector(`#settings-personality-${suffix}`),
      metaEl: (suffix, kind) => host.querySelector(`#settings-personality-${suffix}-${kind}`),
      voiceGroupEl: () => host.querySelector('[data-inv-segmented="settings-personality-voice"]'),
      afterChange: () => { renders += 1; },
    });
    const confirmHost = host.querySelector('#settings-personality-voice-confirm');

    presets.handleVoiceChange('creative');
    assert.equal(note, personalityForm.PRESETS.creative);
    assert.equal(confirmHost.hasAttribute('hidden'), true);
    assert.equal(renders, 1);

    // Another preset's sentence is still template text -> silent replace.
    presets.handleVoiceChange('mentor');
    assert.equal(note, personalityForm.PRESETS.mentor);
    assert.equal(confirmHost.hasAttribute('hidden'), true);

    note = 'Words I wrote myself.';
    presets.handleVoiceChange('concise');
    assert.equal(confirmHost.hasAttribute('hidden'), false);
    assert.equal(note, 'Words I wrote myself.', 'owner text survives until Replace is chosen');
    assert.ok(confirmHost.querySelector('[data-action="personality-preset-replace"]'));

    presets.cancelReplace();
    assert.equal(note, 'Words I wrote myself.');
    assert.equal(confirmHost.hasAttribute('hidden'), true);
    presets.confirmReplace();
    assert.equal(note, 'Words I wrote myself.', 'Keep clears the pending pick, so a later confirm is a no-op');

    presets.handleVoiceChange('balanced');
    presets.confirmReplace();
    assert.equal(note, personalityForm.PRESETS.balanced);
  } finally {
    dom.window.close();
  }
});

test('an unknown preset key is a no-op, not a blanked note', () => {
  const { dom, host } = mount(personalityForm.render({ agentName: 'Jenny' }, { idPrefix: 'settings-personality' }));
  try {
    let note = 'kept';
    const presets = personalityForm.createPresetController({
      getNote: () => note,
      setNote: (value) => { note = value; },
      fieldEl: (suffix) => host.querySelector(`#settings-personality-${suffix}`),
      metaEl: (suffix, kind) => host.querySelector(`#settings-personality-${suffix}-${kind}`),
      voiceGroupEl: () => host.querySelector('.inv-segmented'),
    });
    presets.handleVoiceChange('nonsense');
    presets.handleVoiceChange('');
    assert.equal(note, 'kept');
  } finally {
    dom.window.close();
  }
});
