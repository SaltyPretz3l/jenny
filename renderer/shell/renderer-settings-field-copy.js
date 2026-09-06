/**
 * renderer/shell/renderer-settings-field-copy.js
 *
 * Single source of user-facing copy for Settings fields: toggle id (or select
 * id) -> { label, description, tooltip, sectionId }. Two consumers:
 *   1. renderer-settings-support.js toggle-list builders — a field spec that
 *      omits label/description inherits it from here, so every switch ships a
 *      plain-English one-liner without each builder hand-carrying prose.
 *   2. the settings search index — sectionId routes a hit to its nav section
 *      (sections lazy-load, so search cannot read the live DOM).
 *
 * Copy voice: plain English, user benefit first, no runtime jargon unless the
 * setting is genuinely developer-facing. Dynamic descriptions (state-dependent
 * text like the harness cascade notes) stay at the call site and win over
 * these baselines.
 * Entries may carry an optional tooltip string that is longer than description
 * and renders hover-only as the toggle label's title.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsFieldCopy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SETTINGS_FIELD_COPY = {
    // ── Tools ─────────────────────────────────────────────────────────
    defaultRunModeSelect: {
      label: 'Default run mode for new sessions',
      description: 'Choose how Jenny handles tool approvals when a new chat starts.',
      sectionId: 'tools',
      keywords: ['run mode', 'ask', 'auto', 'plan', 'new chat', 'tool approval'],
    },
    // ── Context ──────────────────────────────────────────────────────────
    contextHistoryScopeSelect: {
      label: 'History scope',
      description: 'How much of this conversation rides along with your next message.',
      sectionId: 'context',
      keywords: ['memory', 'conversation history', 'how much history', 'context window'],
    },
    contextIncludePersonalityToggle: {
      label: 'Personality and notes',
      description: 'Send your personality note, About you, and long-term notes with every message.',
      sectionId: 'context',
      keywords: ['persona', 'voice', 'character', 'personality', 'long-term notes'],
    },
    contextIncludeMemoryToggle: {
      label: 'Include approved memory context',
      description: "Allow recall from memories you've approved. This switch does not create, edit, or own durable memory.",
      sectionId: 'context',
      keywords: ['remember', 'recall', 'saved memories', 'long-term memory'],
    },
    contextTokenBudgetToggle: {
      label: 'Token budget controls',
      description: "Expert diagnostic: enforce the model's measured request limit. Turning this off can make oversized requests fail at the provider.",
      sectionId: 'context',
      keywords: ['tokens', 'context limit', 'trim', 'truncate', 'budget'],
    },
    contextCompactionToggle: {
      label: 'Automatic summarization',
      description: 'Create a bounded, non-authoritative summary of older complete turns before the request is too large. Failures are reported and never saved as a summary.',
      sectionId: 'context',
      keywords: ['summarize', 'compact', 'shrink history', 'digest'],
    },
    compactionPromptField: {
      label: 'Custom summarization prompt',
      description: 'Adds non-authoritative guidance to Jenny’s required summary contract. It cannot remove required fields or change trust rules. Empty resets the guidance.',
      sectionId: 'context',
      keywords: ['summary prompt', 'custom summarize', 'compaction prompt'],
    },
    // ── Skills (merged into Plugins) ─────────────────────────────────────
    skillsUserToggle: {
      label: 'Enable user skills',
      description: 'Include skills you keep in your personal skills folder.',
      sectionId: 'skills',
      keywords: ['personal skills', 'my skills'],
    },
    skillsProjectToggle: {
      label: 'Enable project skills',
      description: 'Include skills stored in the current workspace.',
      sectionId: 'skills',
      keywords: ['workspace skills', 'project skills', 'repo skills'],
    },

    // ── Memory ──────────────────────────────────────────────────────────
    memoryManager: {
      label: 'Memory manager',
      description: 'Review, edit, approve, dismiss, or delete memories Jenny can recall.',
      sectionId: 'memories',
      keywords: ['memory', 'memories', 'remember', 'recall', 'approved', 'pending review', 'long-term memory'],
    },
    memoryCaptureSuggestions: {
      label: 'Offer local memory suggestions',
      description: 'Offer one local suggestion after a completed turn; approval is always required.',
      sectionId: 'memories',
      keywords: ['capture suggestions', 'remember this', 'memory suggestion', 'offer memory'],
    },

    // ── Personality ──────────────────────────────────────────────────────
    personalityResetButton: {
      label: 'Reset to template',
      description: "Discard edits to the open personality file and restore it to the starting template.",
      sectionId: 'personality',
      keywords: ['reset personality', 'restore template', 'undo edits', 'start over', 'discard changes'],
    },

    // ── Appearance ───────────────────────────────────────────────────────
    appearanceThemeBundleSelect: {
      label: 'Theme bundle',
      description: 'A coordinated palette, typography, surface, and Composer-effect preset.',
      sectionId: 'appearance',
      keywords: ['theme', 'look', 'preset', 'style bundle'],
    },
    appearancePaletteSelect: {
      label: 'Palette',
      description: 'The color scheme used across the app chrome, chat, and editor.',
      sectionId: 'appearance',
      keywords: ['colors', 'theme', 'dark mode', 'light mode', 'color scheme'],
    },
    appearanceTypographySelect: {
      label: 'Typography',
      description: 'The font family used for shell text and the chat transcript.',
      sectionId: 'appearance',
      keywords: ['font', 'typeface', 'text font'],
    },
    appearanceFontScaleSelect: {
      label: 'Text size',
      description: 'Scale shell text larger or smaller without changing your zoom level.',
      sectionId: 'appearance',
      keywords: ['text size', 'bigger text', 'smaller text', 'font size', 'zoom text'],
    },
    appearanceSpellcheckToggle: {
      label: 'Check spelling as you type',
      description: 'Misspelled words are underlined in message and note fields, and right-clicking one offers corrections.',
      sectionId: 'appearance',
      keywords: ['spell check', 'spelling', 'spellcheck', 'dictionary', 'autocorrect', 'typos'],
    },
    appearanceChatWidthSelect: {
      label: 'Chat width',
      description: 'Widen the chat transcript and composer for more text per line.',
      sectionId: 'appearance',
      keywords: ['chat width', 'wide', 'wide mode', 'reading width', 'line length', 'column width', 'layout'],
    },
    appearanceSurfaceEffectSelect: {
      label: 'Effect',
      description: 'The ambient layer painted behind Home and Chat.',
      sectionId: 'appearance',
      keywords: ['background', 'ambient', 'surface effect', 'weave', 'grid', 'texture'],
    },
    appearanceComposerHoloToggle: {
      label: 'Holographic typing border',
      description: 'Add a glowing animated border around the composer while you type.',
      sectionId: 'appearance',
      keywords: ['glow', 'typing border', 'holographic', 'composer effect'],
    },
    appearanceAppZoomSelect: {
      label: 'Overall app zoom',
      description: 'Scale the entire app shell larger or smaller.',
      sectionId: 'appearance',
      keywords: ['zoom', 'ui scale', 'app size', 'magnify'],
    },
    appearanceResetButton: {
      label: 'Reset appearance',
      description: 'Restore the coordinated appearance defaults.',
      sectionId: 'appearance',
      keywords: ['reset theme', 'default look', 'restore appearance', 'undo customization'],
    },

    // ── Editor ───────────────────────────────────────────────────────────
    // These fields render via editor-section's own inventory field system
    // (labels + values already inline there); entries here exist only to make
    // them searchable from the nav search index.
    editorFontSizeSelect: {
      label: 'Font size',
      description: 'The editor text size, in pixels.',
      sectionId: 'editor',
      keywords: ['code font', 'editor text size'],
    },
    editorTabSizeSelect: {
      label: 'Default tab size',
      description: 'Default indentation for new files. The Workspace status-bar control can override the active document.',
      sectionId: 'editor',
      keywords: ['indent', 'tabs', 'spaces', 'indentation'],
    },
    editorRenderWhitespaceSelect: {
      label: 'Render whitespace',
      description: 'Show spaces and tabs as visible marks in the editor.',
      sectionId: 'editor',
      keywords: ['whitespace', 'show spaces', 'invisible characters'],
    },
    editorRulersSelect: {
      label: 'Column rulers',
      description: 'Draw vertical guide lines at chosen column widths.',
      sectionId: 'editor',
      keywords: ['guide line', 'column ruler', 'margin line', '80 columns'],
    },
    editorWordWrapToggle: {
      label: 'Word wrap',
      description: 'Wrap long lines instead of scrolling sideways.',
      sectionId: 'editor',
      keywords: ['wrap', 'line wrap', 'soft wrap'],
    },
    editorMinimapToggle: {
      label: 'Minimap',
      description: 'Show the code overview when the active file is small enough; large-file protection can override it.',
      sectionId: 'editor',
      keywords: ['minimap', 'code overview', 'scrollbar preview'],
    },
    editorLineNumbersToggle: {
      label: 'Line numbers',
      description: 'Show line numbers in the gutter.',
      sectionId: 'editor',
      keywords: ['line numbers', 'gutter'],
    },
    editorFormatOnSaveToggle: {
      label: 'Format on save',
      description: 'Auto-format the file each time you save.',
      sectionId: 'editor',
      keywords: ['auto format', 'prettier', 'format on save'],
    },
    editorTrimTrailingWhitespaceToggle: {
      label: 'Trim trailing whitespace on save',
      description: 'Strip trailing spaces from each line when you save.',
      sectionId: 'editor',
      keywords: ['trim whitespace', 'strip spaces'],
    },
    editorInsertFinalNewlineToggle: {
      label: 'Insert final newline on save',
      description: 'Make sure the file ends with a newline when you save.',
      sectionId: 'editor',
      keywords: ['final newline', 'end of file newline', 'eof'],
    },
    editorAutoSaveToggle: {
      label: 'Auto-save files',
      description: 'Write changes to disk automatically about a second after you stop typing.',
      sectionId: 'editor',
      keywords: ['auto save', 'save automatically'],
    },
    editorInlineSuggestToggle: {
      label: 'Inline suggestions',
      description: 'Show inline code completions as you type.',
      sectionId: 'editor',
      keywords: ['autocomplete', 'code completion assistant', 'inline completion', 'ghost text', 'fim'],
    },
    editorInlineSuggestModelSelect: {
      label: 'Completion model',
      description: 'The local model that generates inline code suggestions.',
      sectionId: 'editor',
      keywords: ['completion model', 'autocomplete model'],
    },
    // ── Home ─────────────────────────────────────────────────────────────
    homeScratchpadCaptureSelect: {
      label: 'Quick-capture mode',
      description: 'Whether quick-capture appends a line or replaces the note.',
      sectionId: 'home',
      keywords: ['quick capture', 'append', 'replace'],
    },
    homeScratchpadGlobalCaptureToggle: {
      label: 'Ctrl+Shift+Space quick capture (while Jenny is focused)',
      description: 'Enable the app-wide shortcut while Jenny has keyboard focus.',
      sectionId: 'home',
      keywords: ['global shortcut', 'hotkey', 'quick capture shortcut'],
    },
    homeContextualTipsToggle: {
      label: 'Show contextual tips',
      description: 'Show short, situational guidance on Home when it is relevant.',
      sectionId: 'home',
      keywords: ['tips', 'hints', 'contextual guidance'],
    },

    // ── Offline ──────────────────────────────────────────────────────────
    offlineLocalOnlyToggle: {
      label: 'Force local inference',
      description: 'Require local model inference without governing tools, extensions, authentication, updates, or other network-capable services.',
      sectionId: 'offline',
      keywords: ['local inference', 'offline inference', 'no cloud inference', 'on device model'],
    },

    // ── Local Profile, Setup, and Updates ─────────────────────────────────
    saveLocalProfileButton: {
      label: 'Save local profile',
      description: 'Save the optional profile name on this device.',
      sectionId: 'account',
      keywords: ['profile', 'local profile', 'display name', 'name'],
    },
    checkUpdatesButton: {
      label: 'Check for updates',
      description: 'Look for a newer Jenny release. Checks run only when you ask — nothing phones home on startup.',
      sectionId: 'aboutUpdates',
      keywords: ['update', 'updates', 'check for updates', 'new version', 'upgrade', 'release'],
    },

  };

  function getSettingsFieldCopy(id) {
    var key = typeof id === 'string' ? id.trim() : '';
    if (!key || !Object.prototype.hasOwnProperty.call(SETTINGS_FIELD_COPY, key)) {
      return null;
    }
    return SETTINGS_FIELD_COPY[key];
  }

  function listSettingsFieldCopyEntries() {
    return Object.keys(SETTINGS_FIELD_COPY).map(function (id) {
      var entry = SETTINGS_FIELD_COPY[id];
      return {
        id: id,
        label: entry.label,
        description: entry.description,
        tooltip: entry.tooltip,
        sectionId: entry.sectionId,
        keywords: entry.keywords || [],
      };
    });
  }

  return {
    SETTINGS_FIELD_COPY: SETTINGS_FIELD_COPY,
    getSettingsFieldCopy: getSettingsFieldCopy,
    listSettingsFieldCopyEntries: listSettingsFieldCopyEntries,
  };
});
