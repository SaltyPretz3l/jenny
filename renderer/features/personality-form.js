/**
 * renderer/features/personality-form.js
 *
 * Shared personality form (UMD): assistant name, voice presets, Personality
 * note, and About you. Rendered identically by Settings > Personality and by
 * the setup wizard's personality step so the two surfaces cannot drift.
 *
 * Voice is DERIVED, never stored: a note that matches a preset sentence byte
 * for byte selects that preset, anything else is 'custom'. Presets are
 * templates -- picking one fills the note with a starting point the owner
 * edits; the runtime never sees the preset key.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/text-field'),
      require('../inventory/segmented-control'),
      require('../inventory/action-button')
    );
    return;
  }
  root.personalityForm = factory(
    root.inventoryTextField,
    root.inventorySegmentedControl,
    root.inventoryActionButton
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (textFieldModule, segmentedModule, actionButtonModule) {
  'use strict';

  var textField = typeof textFieldModule === 'function' ? textFieldModule : null;
  var segmentedControl = typeof segmentedModule === 'function'
    ? segmentedModule
    : (segmentedModule && segmentedModule.segmentedControl) || null;
  var actionButton = typeof actionButtonModule === 'function'
    ? actionButtonModule
    : (actionButtonModule && actionButtonModule.actionButton) || null;

  var AGENT_NAME_MAX_CHARS = 80;
  var DEFAULT_AGENT_NAME = 'Jenny';

  /* Section budgets in characters. Mirrors the Electron compile budgets in
     services/personality-workspace-service.js -- the UI must show the same
     numbers the compiler enforces. */
  var BUDGETS = {
    personality: 1500,
    user: 1000,
    memory: 1500,
  };

  /* Preset starting sentences (spec B). These are templates written into the
     note, not a runtime profile: the compiled block only ever carries the note
     body itself. */
  var PRESETS = {
    balanced: "Warm, clear, and direct. Adapt to the moment; don't perform familiarity.",
    concise: 'Shortest complete answer. Keep required caveats, drop everything else.',
    creative: 'Inventive when it helps; always concrete and accurate.',
    mentor: "Explain the key reasoning and tradeoffs; don't bloat simple answers.",
  };

  var PRESET_OPTIONS = [
    { value: 'balanced', label: 'Balanced' },
    { value: 'concise', label: 'Concise' },
    { value: 'creative', label: 'Creative' },
    { value: 'mentor', label: 'Mentor' },
  ];

  var CUSTOM_VOICE = 'custom';

  var COPY = {
    nameLabel: 'Name',
    voiceLabel: 'Voice',
    noteLabel: 'Personality note',
    userLabel: 'About you',
    voiceHint: 'Presets fill the note below with a starting point you can edit.',
    voiceCustomHint: 'Custom — your own words. Pick a preset to start from a template instead.',
    noteHint: 'Tone and behavior only. Tools, dates, and formatting are handled by the app.',
    userHint: 'Name, how to address you, what you do, how you like to work.',
    notePlaceholder: 'How the assistant should sound.',
    userPlaceholder: 'Anything the assistant should always know about you.',
    oversized: 'This file is larger than 64 KiB. Open the folder to edit it.',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function fieldId(prefix, suffix) {
    var safePrefix = String(prefix || 'settings-personality').replace(/[^A-Za-z0-9_-]/g, '');
    return (safePrefix || 'settings-personality') + '-' + suffix;
  }

  /**
   * Coerce any partial personality payload into the canonical draft shape.
   * Accepts both camelCase and the snake_case the IPC layer may echo back.
   */
  function normalize(value) {
    var source = value && typeof value === 'object' ? value : {};
    var files = source.files && typeof source.files === 'object' ? source.files : {};
    var personalityFile = files.personality && typeof files.personality === 'object' ? files.personality : {};
    var userFile = files.user && typeof files.user === 'object' ? files.user : {};
    var name = String(source.agentName || source.agent_name || '').trim().slice(0, AGENT_NAME_MAX_CHARS);
    var note = source.personality != null ? source.personality : personalityFile.body;
    var about = source.user != null ? source.user : userFile.body;
    return {
      agentName: name || DEFAULT_AGENT_NAME,
      personality: String(note == null ? '' : note),
      user: String(about == null ? '' : about),
    };
  }

  /**
   * 'balanced' | 'concise' | 'creative' | 'mentor' | 'custom'.
   * A note is a preset only when it equals the preset sentence exactly
   * (after trimming); everything else -- including an empty note -- is custom.
   */
  function deriveVoice(note) {
    var trimmed = String(note == null ? '' : note).trim();
    if (!trimmed) return CUSTOM_VOICE;
    for (var i = 0; i < PRESET_OPTIONS.length; i += 1) {
      var key = PRESET_OPTIONS[i].value;
      if (PRESETS[key] === trimmed) return key;
    }
    return CUSTOM_VOICE;
  }

  function presetLabel(key) {
    for (var i = 0; i < PRESET_OPTIONS.length; i += 1) {
      if (PRESET_OPTIONS[i].value === key) return PRESET_OPTIONS[i].label;
    }
    return '';
  }

  /**
   * Picking a preset over an empty note, or over another preset's sentence, is
   * a silent fill. Anything the owner actually wrote must be confirmed first.
   */
  function shouldConfirmPresetReplace(note) {
    var trimmed = String(note == null ? '' : note).trim();
    if (!trimmed) return false;
    return deriveVoice(trimmed) === CUSTOM_VOICE;
  }

  function labelCell(prefix, suffix, text, opts) {
    var options = opts || {};
    var id = fieldId(prefix, suffix);
    if (options.asSpan) {
      return '<span class="personality-row-label" id="' + escapeHtml(id + '-label') + '">'
        + escapeHtml(text) + '</span>';
    }
    return '<label class="personality-row-label" for="' + escapeHtml(id) + '">'
      + escapeHtml(text) + '</label>';
  }

  function metaRow(prefix, suffix, hintText, includeCounter, lintText) {
    var hintId = fieldId(prefix, suffix) + '-hint';
    var counterId = fieldId(prefix, suffix) + '-counter';
    var lintId = fieldId(prefix, suffix) + '-lint';
    var lint = String(lintText || '');
    return '<div class="personality-row-meta">'
      + '<span class="personality-hint" id="' + escapeHtml(hintId) + '">' + escapeHtml(hintText) + '</span>'
      // aria-live so crossing the budget is announced, not just recoloured.
      + (includeCounter
        ? '<span class="personality-counter" id="' + escapeHtml(counterId) + '" aria-live="polite"></span>'
        : '')
      + '</div>'
      + '<p class="personality-lint" id="' + escapeHtml(lintId) + '"'
      + (lint ? '' : ' hidden') + '>' + escapeHtml(lint) + '</p>';
  }

  /**
   * The description ids a field's control points at. The lint paragraph is
   * always listed even while hidden: an empty/hidden description contributes
   * nothing, and keeping the id list stable means the attribute never has to
   * be rewritten as the lint appears and disappears.
   */
  function describedBy(prefix, suffix, includeCounter) {
    var base = fieldId(prefix, suffix);
    var ids = [base + '-hint'];
    if (includeCounter) ids.push(base + '-counter');
    ids.push(base + '-lint');
    return ids.join(' ');
  }

  /**
   * Inject extra attributes into an inventory control's opening tag. The
   * primitives take no `aria-describedby`, and this module must not fork them;
   * the class token below is emitted exactly once per rendered field.
   */
  function withAttrs(html, anchor, attrs) {
    var extra = '';
    var keys = Object.keys(attrs || {});
    for (var i = 0; i < keys.length; i += 1) {
      var value = attrs[keys[i]];
      if (!value) continue;
      extra += ' ' + keys[i] + '="' + escapeHtml(value) + '"';
    }
    return extra ? String(html).replace(anchor, anchor + extra) : String(html);
  }

  var CONTROL_ANCHOR = 'class="inv-text-field-control"';
  var RADIOGROUP_ANCHOR = 'role="radiogroup"';

  /** Screen-reader name for the voice group, carrying the derived state. */
  function voiceAriaLabel(voice) {
    var key = String(voice || '');
    var label = key === CUSTOM_VOICE ? 'custom' : presetLabel(key);
    return COPY.voiceLabel + ' preset (currently ' + (label || 'custom') + ')';
  }

  /**
   * Render the whole form as an HTML string.
   * @param {Object} state - `{ agentName, personality, user }` (loosely shaped)
   * @param {Object} [options]
   * @param {string} [options.idPrefix='settings-personality']
   * @param {boolean} [options.includeSaveAction] - append a Save button (setup wizard)
   * @param {boolean} [options.compact] - drop the About-you counter (setup wizard)
   * @param {boolean} [options.disabled]
   * @returns {string}
   */
  function render(state, options) {
    if (!textField || !segmentedControl) return '';
    var opts = options || {};
    var value = normalize(state);
    var prefix = opts.idPrefix || 'settings-personality';
    var disabled = opts.disabled === true;
    var compact = opts.compact === true;
    var voice = deriveVoice(value.personality);

    var nameRow = '<div class="personality-row">'
      + labelCell(prefix, 'name', COPY.nameLabel)
      + '<div class="personality-row-content">'
      + textField({
        id: fieldId(prefix, 'name'),
        value: value.agentName,
        ariaLabel: COPY.nameLabel,
        placeholder: DEFAULT_AGENT_NAME,
        maxLength: AGENT_NAME_MAX_CHARS,
        disabled: disabled,
        className: 'personality-name-field',
      })
      + '</div></div>';

    var voiceRow = '<div class="personality-row">'
      + labelCell(prefix, 'voice', COPY.voiceLabel, { asSpan: true })
      + '<div class="personality-row-content">'
      + withAttrs(segmentedControl({
        id: fieldId(prefix, 'voice'),
        ariaLabel: voiceAriaLabel(voice),
        value: voice,
        options: PRESET_OPTIONS,
        disabled: disabled,
        className: 'personality-voice',
      }), RADIOGROUP_ANCHOR, { 'aria-describedby': fieldId(prefix, 'voice') + '-hint' })
      + '<div class="personality-row-meta">'
      + '<span class="personality-hint" id="' + escapeHtml(fieldId(prefix, 'voice') + '-hint') + '">'
      + escapeHtml(voice === CUSTOM_VOICE ? COPY.voiceCustomHint : COPY.voiceHint)
      + '</span></div>'
      + '<p class="personality-preset-confirm" id="' + escapeHtml(fieldId(prefix, 'voice') + '-confirm') + '" hidden></p>'
      + '</div></div>';

    // An on-disk file over 64 KiB is read-only here: the service refuses the
    // write, so offering an editable textarea would only lose the user's typing.
    var oversized = opts.oversized && typeof opts.oversized === 'object' ? opts.oversized : {};
    var noteOversized = oversized.personality === true;
    var userOversized = oversized.user === true;

    var noteRow = '<div class="personality-row">'
      + labelCell(prefix, 'note', COPY.noteLabel)
      + '<div class="personality-row-content">'
      + withAttrs(textField({
        id: fieldId(prefix, 'note'),
        value: value.personality,
        ariaLabel: COPY.noteLabel,
        placeholder: COPY.notePlaceholder,
        multiline: true,
        spellcheck: true,
        disabled: disabled || noteOversized,
        className: 'personality-note-field',
      }), CONTROL_ANCHOR, { 'aria-describedby': describedBy(prefix, 'note', true) })
      + metaRow(prefix, 'note', COPY.noteHint, true, noteOversized ? COPY.oversized : '')
      + '</div></div>';

    var userRow = '<div class="personality-row">'
      + labelCell(prefix, 'user', COPY.userLabel)
      + '<div class="personality-row-content">'
      + withAttrs(textField({
        id: fieldId(prefix, 'user'),
        value: value.user,
        ariaLabel: COPY.userLabel,
        placeholder: COPY.userPlaceholder,
        multiline: true,
        spellcheck: true,
        disabled: disabled || userOversized,
        className: 'personality-user-field',
      }), CONTROL_ANCHOR, { 'aria-describedby': describedBy(prefix, 'user', !compact) })
      + metaRow(prefix, 'user', COPY.userHint, !compact, userOversized ? COPY.oversized : '')
      + '</div></div>';

    var markup = nameRow + voiceRow + noteRow + userRow;
    if (opts.includeSaveAction && actionButton) {
      markup += '<div class="personality-row personality-row--actions">'
        + '<span class="personality-row-label" aria-hidden="true"></span>'
        + '<div class="personality-row-content">'
        + actionButton({
          id: 'save-personality',
          label: opts.saving ? 'Saving…' : 'Save',
          variant: 'primary',
          disabled: disabled || opts.saving === true,
          domId: fieldId(prefix, 'save'),
        })
        + '</div></div>';
    }
    return markup;
  }

  /**
   * Mirror the segmented-control primitive's selected-state DOM contract.
   * Written here rather than calling `select()` because the derived "custom"
   * voice is deliberately NOT an option: reverting to it must clear every
   * aria-checked without leaving the group unreachable by Tab.
   */
  function syncVoiceSelection(groupEl, voice) {
    if (!groupEl || typeof groupEl.querySelectorAll !== 'function') return;
    var buttons = Array.prototype.slice.call(groupEl.querySelectorAll('.inv-segmented-option'));
    var matched = false;
    var firstEnabled = null;
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      var isMatch = button.getAttribute('data-value') === voice;
      if (isMatch) matched = true;
      if (!firstEnabled && !button.disabled) firstEnabled = button;
      button.setAttribute('aria-checked', isMatch ? 'true' : 'false');
      button.setAttribute('tabindex', isMatch ? '0' : '-1');
      if (button.classList) button.classList.toggle('inv-segmented-option--on', isMatch);
    }
    if (!matched && firstEnabled) firstEnabled.setAttribute('tabindex', '0');
  }

  /**
   * Voice-preset interaction for a mounted form: fill the note on a pick, or
   * ask first when the note holds text the owner wrote.
   *
   * Lives here rather than in the section controller because every element it
   * touches -- the note textarea, the radiogroup, the confirm slot -- is markup
   * this module emitted; the controller only supplies state access.
   *
   * @param {Object} deps
   * @param {Function} deps.getNote - current note text
   * @param {Function} deps.setNote - commit a new note text to the draft
   * @param {Function} deps.fieldEl - (suffix) => element
   * @param {Function} deps.metaEl - (suffix, kind) => element
   * @param {Function} deps.voiceGroupEl - () => the radiogroup element
   * @param {Function} [deps.afterChange] - re-render hook
   * @param {Function} [deps.escapeHtml]
   * @param {Function} [deps.actionButton]
   */
  function createPresetController(deps) {
    var d = deps || {};
    var escape = typeof d.escapeHtml === 'function' ? d.escapeHtml : escapeHtml;
    var button = typeof d.actionButton === 'function' ? d.actionButton : actionButton;
    var afterChange = typeof d.afterChange === 'function' ? d.afterChange : function () {};
    var pending = '';

    function confirmHost() {
      return typeof d.metaEl === 'function' ? d.metaEl('voice', 'confirm') : null;
    }

    function clearPrompt() {
      pending = '';
      var host = confirmHost();
      if (!host) return;
      host.innerHTML = '';
      host.setAttribute('hidden', '');
    }

    function apply(presetKey) {
      var sentence = PRESETS[presetKey];
      if (!sentence) return;
      var noteEl = typeof d.fieldEl === 'function' ? d.fieldEl('note') : null;
      if (noteEl) noteEl.value = sentence;
      if (typeof d.setNote === 'function') d.setNote(sentence);
      clearPrompt();
      syncVoiceSelection(typeof d.voiceGroupEl === 'function' ? d.voiceGroupEl() : null, presetKey);
      afterChange();
    }

    function prompt(presetKey) {
      var host = confirmHost();
      if (!host || !button) {
        apply(presetKey);
        return;
      }
      pending = presetKey;
      host.innerHTML = '<span class="personality-preset-confirm-copy">'
        + escape('Replace your note with the ' + presetLabel(presetKey) + ' starting point?')
        + '</span>'
        + button({ id: 'personality-preset-replace', label: 'Replace', variant: 'ghost', size: 'sm' })
        + button({ id: 'personality-preset-keep', label: 'Keep', variant: 'ghost', size: 'sm' });
      host.removeAttribute('hidden');
    }

    return {
      clearPrompt: clearPrompt,
      handleVoiceChange: function handleVoiceChange(presetKey) {
        var key = String(presetKey || '');
        if (!PRESETS[key]) return;
        var note = typeof d.getNote === 'function' ? d.getNote() : '';
        if (shouldConfirmPresetReplace(note)) {
          prompt(key);
          return;
        }
        apply(key);
      },
      confirmReplace: function confirmReplace() {
        if (pending) apply(pending);
      },
      cancelReplace: function cancelReplace() {
        var note = typeof d.getNote === 'function' ? d.getNote() : '';
        clearPrompt();
        syncVoiceSelection(
          typeof d.voiceGroupEl === 'function' ? d.voiceGroupEl() : null,
          deriveVoice(note)
        );
        afterChange();
      },
    };
  }

  /**
   * Read the current control values back out of a rendered form.
   * Missing controls fall back to `options.fallback` so a partially-mounted
   * form can never silently blank a field on save.
   */
  function read(rootEl, options) {
    var opts = options || {};
    var prefix = opts.idPrefix || 'settings-personality';
    var fallback = normalize(opts.fallback);
    if (!rootEl || typeof rootEl.querySelector !== 'function') return fallback;
    var nameEl = rootEl.querySelector('#' + fieldId(prefix, 'name'));
    var noteEl = rootEl.querySelector('#' + fieldId(prefix, 'note'));
    var userEl = rootEl.querySelector('#' + fieldId(prefix, 'user'));
    return normalize({
      agentName: nameEl ? nameEl.value : fallback.agentName,
      personality: noteEl ? noteEl.value : fallback.personality,
      user: userEl ? userEl.value : fallback.user,
    });
  }

  return {
    AGENT_NAME_MAX_CHARS: AGENT_NAME_MAX_CHARS,
    BUDGETS: BUDGETS,
    COPY: COPY,
    CUSTOM_VOICE: CUSTOM_VOICE,
    DEFAULT_AGENT_NAME: DEFAULT_AGENT_NAME,
    PRESETS: PRESETS,
    PRESET_OPTIONS: PRESET_OPTIONS,
    deriveVoice: deriveVoice,
    fieldId: fieldId,
    normalize: normalize,
    presetLabel: presetLabel,
    createPresetController: createPresetController,
    read: read,
    render: render,
    syncVoiceSelection: syncVoiceSelection,
    voiceAriaLabel: voiceAriaLabel,
    shouldConfirmPresetReplace: shouldConfirmPresetReplace,
  };
});
