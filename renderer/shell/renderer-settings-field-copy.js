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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  var SETTINGS_FIELD_COPY = {
    // ── Tools ─────────────────────────────────────────────────────────
    safetyModeSelect: {
      label: jt('settings.safetyMode.label', 'Safety mode'),
      description: jt('settings.safetyMode.description', 'Extra guard rails on top of the run mode: remove network tools or make every tool call ask.'),
      sectionId: 'tools',
      keywords: ['safety', 'strict', 'paranoid', jt('settings.fieldCopy.safetyModeSelect.keywords.guardRails', 'guard rails'), jt('settings.fieldCopy.safetyModeSelect.keywords.webTools', 'web tools')],
    },
    defaultRunModeSelect: {
      label: jt('settings.fieldCopy.defaultRunModeSelect.label', 'Default run mode for new sessions'),
      description: jt('settings.fieldCopy.defaultRunModeSelect.description', 'Choose how Jenny handles tool approvals when a new chat starts.'),
      sectionId: 'tools',
      keywords: [jt('settings.fieldCopy.defaultRunModeSelect.keywords.runMode', 'run mode'), 'ask', 'auto', 'plan', jt('settings.fieldCopy.defaultRunModeSelect.keywords.newChat', 'new chat'), jt('settings.fieldCopy.defaultRunModeSelect.keywords.toolApproval', 'tool approval')],
    },
    unattendedGuardMinutesInput: {
      label: jt('settings.unattendedGuard.durationLabel', 'Pause after inactivity (minutes)'),
      description: jt('settings.unattendedGuard.optInDescription', 'Optional inactivity pause for Auto mode. Off keeps working while you are away; enable it and choose the idle duration.'),
      sectionId: 'tools',
      keywords: ['unattended', 'idle', 'away', jt('settings.fieldCopy.unattendedGuardMinutesInput.keywords.autoMode', 'auto mode'), 'pause'],
    },
    // ── Context ──────────────────────────────────────────────────────────
    contextHistoryScopeSelect: {
      label: jt('settings.fieldCopy.contextHistoryScopeSelect.label', 'History scope'),
      description: jt('settings.fieldCopy.contextHistoryScopeSelect.description', 'How much of this conversation rides along with your next message.'),
      sectionId: 'context',
      keywords: ['memory', jt('settings.fieldCopy.contextHistoryScopeSelect.keywords.conversationHistory', 'conversation history'), jt('settings.fieldCopy.contextHistoryScopeSelect.keywords.howMuchHistory', 'how much history'), jt('settings.fieldCopy.contextHistoryScopeSelect.keywords.contextWindow', 'context window')],
    },
    contextIncludePersonalityToggle: {
      label: jt('settings.fieldCopy.contextIncludePersonalityToggle.label', 'Personality and notes'),
      description: jt('settings.fieldCopy.contextIncludePersonalityToggle.description', 'Send your personality note, About you, and long-term notes with every message.'),
      sectionId: 'context',
      keywords: ['persona', 'voice', 'character', 'personality', jt('settings.fieldCopy.contextIncludePersonalityToggle.keywords.longTermNotes', 'long-term notes')],
    },
    contextIncludeMemoryToggle: {
      label: jt('settings.fieldCopy.contextIncludeMemoryToggle.label', 'Include approved memory context'),
      description: jt('settings.fieldCopy.contextIncludeMemoryToggle.description', "Allow recall from memories you've approved. This switch does not create, edit, or own durable memory."),
      sectionId: 'context',
      keywords: ['remember', 'recall', jt('settings.fieldCopy.contextIncludeMemoryToggle.keywords.savedMemories', 'saved memories'), jt('settings.fieldCopy.contextIncludeMemoryToggle.keywords.longTermMemory', 'long-term memory')],
    },
    contextTokenBudgetToggle: {
      label: jt('settings.fieldCopy.contextTokenBudgetToggle.label', 'Token budget controls'),
      description: jt('settings.fieldCopy.contextTokenBudgetToggle.description', "Expert diagnostic: enforce the model's measured request limit. Turning this off can make oversized requests fail at the provider."),
      sectionId: 'context',
      keywords: ['tokens', jt('settings.fieldCopy.contextTokenBudgetToggle.keywords.contextLimit', 'context limit'), 'trim', 'truncate', 'budget'],
    },
    contextCompactionToggle: {
      label: jt('settings.fieldCopy.contextCompactionToggle.label', 'Automatic summarization'),
      description: jt('settings.fieldCopy.contextCompactionToggle.description', 'Create a bounded, non-authoritative summary of older complete turns before the request is too large. Failures are reported and never saved as a summary.'),
      sectionId: 'context',
      keywords: ['summarize', 'compact', jt('settings.fieldCopy.contextCompactionToggle.keywords.shrinkHistory', 'shrink history'), 'digest'],
    },
    compactionPromptField: {
      label: jt('settings.fieldCopy.compactionPromptField.label', 'Custom summarization prompt'),
      description: jt('settings.fieldCopy.compactionPromptField.description', 'Adds non-authoritative guidance to Jenny’s required summary contract. It cannot remove required fields or change trust rules. Empty resets the guidance.'),
      sectionId: 'context',
      keywords: [jt('settings.fieldCopy.compactionPromptField.keywords.summaryPrompt', 'summary prompt'), jt('settings.fieldCopy.compactionPromptField.keywords.customSummarize', 'custom summarize'), jt('settings.fieldCopy.compactionPromptField.keywords.compactionPrompt', 'compaction prompt')],
    },
    // ── Skills (merged into Plugins) ─────────────────────────────────────
    skillsUserToggle: {
      label: jt('settings.fieldCopy.skillsUserToggle.label', 'Enable user skills'),
      description: jt('settings.fieldCopy.skillsUserToggle.description', 'Include skills you keep in your personal skills folder.'),
      sectionId: 'skills',
      keywords: [jt('settings.fieldCopy.skillsUserToggle.keywords.personalSkills', 'personal skills'), jt('settings.fieldCopy.skillsUserToggle.keywords.mySkills', 'my skills')],
    },
    skillsProjectToggle: {
      label: jt('settings.fieldCopy.skillsProjectToggle.label', 'Enable project skills'),
      description: jt('settings.fieldCopy.skillsProjectToggle.description', 'Include skills stored in the current workspace.'),
      sectionId: 'skills',
      keywords: [jt('settings.fieldCopy.skillsProjectToggle.keywords.workspaceSkills', 'workspace skills'), jt('settings.fieldCopy.skillsProjectToggle.keywords.projectSkills', 'project skills'), jt('settings.fieldCopy.skillsProjectToggle.keywords.repoSkills', 'repo skills')],
    },

    // ── Memory ──────────────────────────────────────────────────────────
    memoryManager: {
      label: jt('settings.fieldCopy.memoryManager.label', 'Memory manager'),
      description: jt('settings.fieldCopy.memoryManager.description', 'Review, edit, approve, dismiss, or delete memories Jenny can recall.'),
      sectionId: 'memories',
      keywords: ['memory', 'memories', 'remember', 'recall', 'approved', jt('settings.fieldCopy.memoryManager.keywords.pendingReview', 'pending review'), jt('settings.fieldCopy.memoryManager.keywords.longTermMemory', 'long-term memory')],
    },
    memoryCaptureSuggestions: {
      label: jt('settings.fieldCopy.memoryCaptureSuggestions.label', 'Offer local memory suggestions'),
      description: jt('settings.fieldCopy.memoryCaptureSuggestions.description', 'Offer one local suggestion after a completed turn; approval is always required.'),
      sectionId: 'memories',
      keywords: [jt('settings.fieldCopy.memoryCaptureSuggestions.keywords.captureSuggestions', 'capture suggestions'), jt('settings.fieldCopy.memoryCaptureSuggestions.keywords.rememberThis', 'remember this'), jt('settings.fieldCopy.memoryCaptureSuggestions.keywords.memorySuggestion', 'memory suggestion'), jt('settings.fieldCopy.memoryCaptureSuggestions.keywords.offerMemory', 'offer memory')],
    },

    // ── Personality ──────────────────────────────────────────────────────
    personalityResetButton: {
      label: jt('settings.fieldCopy.personalityResetButton.label', 'Reset to template'),
      description: jt('settings.fieldCopy.personalityResetButton.description', "Discard edits to the open personality file and restore it to the starting template."),
      sectionId: 'personality',
      keywords: [jt('settings.fieldCopy.personalityResetButton.keywords.resetPersonality', 'reset personality'), jt('settings.fieldCopy.personalityResetButton.keywords.restoreTemplate', 'restore template'), jt('settings.fieldCopy.personalityResetButton.keywords.undoEdits', 'undo edits'), jt('settings.fieldCopy.personalityResetButton.keywords.startOver', 'start over'), jt('settings.fieldCopy.personalityResetButton.keywords.discardChanges', 'discard changes')],
    },

    // ── Appearance ───────────────────────────────────────────────────────
    use24HourTimeSelect: {
      label: jt('settings.timeFormat.label', '24-hour time'),
      description: jt('settings.timeFormat.description', 'Use 00:00–23:59 throughout Jenny and in the time context given to the model.'),
      sectionId: 'appearance', keywords: ['clock', 'time', '24', 'AM', 'PM'],
    },
    uiLanguageSelect: {
      label: jt('settings.language.label', 'Language'),
      description: jt('settings.language.description', 'Choose the language Jenny uses for interface text after the next restart.'),
      sectionId: 'appearance',
      keywords: ['language', 'translation', 'locale', jt('settings.fieldCopy.uiLanguageSelect.keywords.interfaceLanguage', 'interface language')],
    },
    appearanceThemeBundleSelect: {
      label: jt('settings.fieldCopy.appearanceThemeBundleSelect.label', 'Theme bundle'),
      description: jt('settings.fieldCopy.appearanceThemeBundleSelect.description', 'A coordinated palette, typography, surface, and Composer-effect preset.'),
      sectionId: 'appearance',
      keywords: ['theme', 'look', 'preset', jt('settings.fieldCopy.appearanceThemeBundleSelect.keywords.styleBundle', 'style bundle')],
    },
    appearancePaletteSelect: {
      label: jt('settings.fieldCopy.appearancePaletteSelect.label', 'Palette'),
      description: jt('settings.fieldCopy.appearancePaletteSelect.description', 'The color scheme used across the app chrome, chat, and editor.'),
      sectionId: 'appearance',
      keywords: ['colors', 'theme', jt('settings.fieldCopy.appearancePaletteSelect.keywords.darkMode', 'dark mode'), jt('settings.fieldCopy.appearancePaletteSelect.keywords.lightMode', 'light mode'), jt('settings.fieldCopy.appearancePaletteSelect.keywords.colorScheme', 'color scheme')],
    },
    appearanceTypographySelect: {
      label: jt('settings.fieldCopy.appearanceTypographySelect.label', 'Typography'),
      description: jt('settings.fieldCopy.appearanceTypographySelect.description', 'The font family used for shell text and the chat transcript.'),
      sectionId: 'appearance',
      keywords: ['font', 'typeface', jt('settings.fieldCopy.appearanceTypographySelect.keywords.textFont', 'text font')],
    },
    appearanceFontScaleSelect: {
      label: jt('settings.fieldCopy.appearanceFontScaleSelect.label', 'Text size'),
      description: jt('settings.fieldCopy.appearanceFontScaleSelect.description', 'Scale shell text larger or smaller without changing your zoom level.'),
      sectionId: 'appearance',
      keywords: [jt('settings.fieldCopy.appearanceFontScaleSelect.keywords.textSize', 'text size'), jt('settings.fieldCopy.appearanceFontScaleSelect.keywords.biggerText', 'bigger text'), jt('settings.fieldCopy.appearanceFontScaleSelect.keywords.smallerText', 'smaller text'), jt('settings.fieldCopy.appearanceFontScaleSelect.keywords.fontSize', 'font size'), jt('settings.fieldCopy.appearanceFontScaleSelect.keywords.zoomText', 'zoom text')],
    },
    appearanceSpellcheckToggle: {
      label: jt('settings.fieldCopy.appearanceSpellcheckToggle.label', 'Check spelling as you type'),
      description: jt('settings.fieldCopy.appearanceSpellcheckToggle.description', 'Misspelled words are underlined in message and note fields, and right-clicking one offers corrections.'),
      sectionId: 'appearance',
      keywords: [jt('settings.fieldCopy.appearanceSpellcheckToggle.keywords.spellCheck', 'spell check'), 'spelling', 'spellcheck', 'dictionary', 'autocorrect', 'typos'],
    },
    appearanceChatWidthSelect: {
      label: jt('settings.fieldCopy.appearanceChatWidthSelect.label', 'Chat width'),
      description: jt('settings.fieldCopy.appearanceChatWidthSelect.description', 'Widen the chat transcript and composer for more text per line.'),
      sectionId: 'appearance',
      keywords: [jt('settings.fieldCopy.appearanceChatWidthSelect.keywords.chatWidth', 'chat width'), 'wide', jt('settings.fieldCopy.appearanceChatWidthSelect.keywords.wideMode', 'wide mode'), jt('settings.fieldCopy.appearanceChatWidthSelect.keywords.readingWidth', 'reading width'), jt('settings.fieldCopy.appearanceChatWidthSelect.keywords.lineLength', 'line length'), jt('settings.fieldCopy.appearanceChatWidthSelect.keywords.columnWidth', 'column width'), 'layout'],
    },
    appearanceSurfaceEffectSelect: {
      label: jt('settings.fieldCopy.appearanceSurfaceEffectSelect.label', 'Effect'),
      description: jt('settings.fieldCopy.appearanceSurfaceEffectSelect.description', 'The ambient layer painted behind Home and Chat.'),
      sectionId: 'appearance',
      keywords: ['background', 'ambient', jt('settings.fieldCopy.appearanceSurfaceEffectSelect.keywords.surfaceEffect', 'surface effect'), 'weave', 'grid', 'texture'],
    },
    appearanceComposerHoloToggle: {
      label: jt('settings.fieldCopy.appearanceComposerHoloToggle.label', 'Holographic typing border'),
      description: jt('settings.fieldCopy.appearanceComposerHoloToggle.description', 'Add a glowing animated border around the composer while you type.'),
      sectionId: 'appearance',
      keywords: ['glow', jt('settings.fieldCopy.appearanceComposerHoloToggle.keywords.typingBorder', 'typing border'), 'holographic', jt('settings.fieldCopy.appearanceComposerHoloToggle.keywords.composerEffect', 'composer effect')],
    },
    appearanceAppZoomSelect: {
      label: jt('settings.fieldCopy.appearanceAppZoomSelect.label', 'Overall app zoom'),
      description: jt('settings.fieldCopy.appearanceAppZoomSelect.description', 'Scale the entire app shell larger or smaller.'),
      sectionId: 'appearance',
      keywords: ['zoom', jt('settings.fieldCopy.appearanceAppZoomSelect.keywords.uiScale', 'ui scale'), jt('settings.fieldCopy.appearanceAppZoomSelect.keywords.appSize', 'app size'), 'magnify'],
    },
    appearanceResetButton: {
      label: jt('settings.fieldCopy.appearanceResetButton.label', 'Reset appearance'),
      description: jt('settings.fieldCopy.appearanceResetButton.description', 'Restore the coordinated appearance defaults.'),
      sectionId: 'appearance',
      keywords: [jt('settings.fieldCopy.appearanceResetButton.keywords.resetTheme', 'reset theme'), jt('settings.fieldCopy.appearanceResetButton.keywords.defaultLook', 'default look'), jt('settings.fieldCopy.appearanceResetButton.keywords.restoreAppearance', 'restore appearance'), jt('settings.fieldCopy.appearanceResetButton.keywords.undoCustomization', 'undo customization')],
    },

    // ── Editor ───────────────────────────────────────────────────────────
    // These fields render via editor-section's own inventory field system
    // (labels + values already inline there); entries here exist only to make
    // them searchable from the nav search index.
    editorFontSizeSelect: {
      label: jt('settings.fieldCopy.editorFontSizeSelect.label', 'Font size'),
      description: jt('settings.fieldCopy.editorFontSizeSelect.description', 'The editor text size, in pixels.'),
      sectionId: 'editor',
      keywords: [jt('settings.fieldCopy.editorFontSizeSelect.keywords.codeFont', 'code font'), jt('settings.fieldCopy.editorFontSizeSelect.keywords.editorTextSize', 'editor text size')],
    },
    editorTabSizeSelect: {
      label: jt('settings.fieldCopy.editorTabSizeSelect.label', 'Default tab size'),
      description: jt('settings.fieldCopy.editorTabSizeSelect.description', 'Default indentation for new files. The Workspace status-bar control can override the active document.'),
      sectionId: 'editor',
      keywords: ['indent', 'tabs', 'spaces', 'indentation'],
    },
    editorRenderWhitespaceSelect: {
      label: jt('settings.fieldCopy.editorRenderWhitespaceSelect.label', 'Render whitespace'),
      description: jt('settings.fieldCopy.editorRenderWhitespaceSelect.description', 'Show spaces and tabs as visible marks in the editor.'),
      sectionId: 'editor',
      keywords: ['whitespace', jt('settings.fieldCopy.editorRenderWhitespaceSelect.keywords.showSpaces', 'show spaces'), jt('settings.fieldCopy.editorRenderWhitespaceSelect.keywords.invisibleCharacters', 'invisible characters')],
    },
    editorRulersSelect: {
      label: jt('settings.fieldCopy.editorRulersSelect.label', 'Column rulers'),
      description: jt('settings.fieldCopy.editorRulersSelect.description', 'Draw vertical guide lines at chosen column widths.'),
      sectionId: 'editor',
      keywords: [jt('settings.fieldCopy.editorRulersSelect.keywords.guideLine', 'guide line'), jt('settings.fieldCopy.editorRulersSelect.keywords.columnRuler', 'column ruler'), jt('settings.fieldCopy.editorRulersSelect.keywords.marginLine', 'margin line'), '80 columns'],
    },
    editorWordWrapToggle: {
      label: jt('settings.fieldCopy.editorWordWrapToggle.label', 'Word wrap'),
      description: jt('settings.fieldCopy.editorWordWrapToggle.description', 'Wrap long lines instead of scrolling sideways.'),
      sectionId: 'editor',
      keywords: ['wrap', jt('settings.fieldCopy.editorWordWrapToggle.keywords.lineWrap', 'line wrap'), jt('settings.fieldCopy.editorWordWrapToggle.keywords.softWrap', 'soft wrap')],
    },
    editorMinimapToggle: {
      label: jt('settings.fieldCopy.editorMinimapToggle.label', 'Minimap'),
      description: jt('settings.fieldCopy.editorMinimapToggle.description', 'Show the code overview when the active file is small enough; large-file protection can override it.'),
      sectionId: 'editor',
      keywords: ['minimap', jt('settings.fieldCopy.editorMinimapToggle.keywords.codeOverview', 'code overview'), jt('settings.fieldCopy.editorMinimapToggle.keywords.scrollbarPreview', 'scrollbar preview')],
    },
    editorLineNumbersToggle: {
      label: jt('settings.fieldCopy.editorLineNumbersToggle.label', 'Line numbers'),
      description: jt('settings.fieldCopy.editorLineNumbersToggle.description', 'Show line numbers in the gutter.'),
      sectionId: 'editor',
      keywords: [jt('settings.fieldCopy.editorLineNumbersToggle.keywords.lineNumbers', 'line numbers'), 'gutter'],
    },
    editorFormatOnSaveToggle: {
      label: jt('settings.fieldCopy.editorFormatOnSaveToggle.label', 'Format on save'),
      description: jt('settings.fieldCopy.editorFormatOnSaveToggle.description', 'Auto-format the file each time you save.'),
      sectionId: 'editor',
      keywords: [jt('settings.fieldCopy.editorFormatOnSaveToggle.keywords.autoFormat', 'auto format'), 'prettier', jt('settings.fieldCopy.editorFormatOnSaveToggle.keywords.formatOnSave', 'format on save')],
    },
    editorTrimTrailingWhitespaceToggle: {
      label: jt('settings.fieldCopy.editorTrimTrailingWhitespaceToggle.label', 'Trim trailing whitespace on save'),
      description: jt('settings.fieldCopy.editorTrimTrailingWhitespaceToggle.description', 'Strip trailing spaces from each line when you save.'),
      sectionId: 'editor',
      keywords: [jt('settings.fieldCopy.editorTrimTrailingWhitespaceToggle.keywords.trimWhitespace', 'trim whitespace'), jt('settings.fieldCopy.editorTrimTrailingWhitespaceToggle.keywords.stripSpaces', 'strip spaces')],
    },
    editorInsertFinalNewlineToggle: {
      label: jt('settings.fieldCopy.editorInsertFinalNewlineToggle.label', 'Insert final newline on save'),
      description: jt('settings.fieldCopy.editorInsertFinalNewlineToggle.description', 'Make sure the file ends with a newline when you save.'),
      sectionId: 'editor',
      keywords: [jt('settings.fieldCopy.editorInsertFinalNewlineToggle.keywords.finalNewline', 'final newline'), jt('settings.fieldCopy.editorInsertFinalNewlineToggle.keywords.endOfFileNewline', 'end of file newline'), 'eof'],
    },
    editorAutoSaveToggle: {
      label: jt('settings.fieldCopy.editorAutoSaveToggle.label', 'Auto-save files'),
      description: jt('settings.fieldCopy.editorAutoSaveToggle.description', 'Write changes to disk automatically about a second after you stop typing.'),
      sectionId: 'editor',
      keywords: [jt('settings.fieldCopy.editorAutoSaveToggle.keywords.autoSave', 'auto save'), jt('settings.fieldCopy.editorAutoSaveToggle.keywords.saveAutomatically', 'save automatically')],
    },
    editorInlineSuggestToggle: {
      label: jt('settings.fieldCopy.editorInlineSuggestToggle.label', 'Inline suggestions'),
      description: jt('settings.fieldCopy.editorInlineSuggestToggle.description', 'Show inline code completions as you type.'),
      sectionId: 'editor',
      keywords: ['autocomplete', jt('settings.fieldCopy.editorInlineSuggestToggle.keywords.codeCompletionAssistant', 'code completion assistant'), jt('settings.fieldCopy.editorInlineSuggestToggle.keywords.inlineCompletion', 'inline completion'), jt('settings.fieldCopy.editorInlineSuggestToggle.keywords.ghostText', 'ghost text'), 'fim'],
    },
    editorInlineSuggestModelSelect: {
      label: jt('settings.fieldCopy.editorInlineSuggestModelSelect.label', 'Completion model'),
      description: jt('settings.fieldCopy.editorInlineSuggestModelSelect.description', 'The local model that generates inline code suggestions.'),
      sectionId: 'editor',
      keywords: [jt('settings.fieldCopy.editorInlineSuggestModelSelect.keywords.completionModel', 'completion model'), jt('settings.fieldCopy.editorInlineSuggestModelSelect.keywords.autocompleteModel', 'autocomplete model')],
    },
    // ── Home ─────────────────────────────────────────────────────────────
    homeScratchpadCaptureSelect: {
      label: jt('settings.fieldCopy.homeScratchpadCaptureSelect.label', 'Quick-capture mode'),
      description: jt('settings.fieldCopy.homeScratchpadCaptureSelect.description', 'Whether quick-capture appends a line or replaces the note.'),
      sectionId: 'home',
      keywords: [jt('settings.fieldCopy.homeScratchpadCaptureSelect.keywords.quickCapture', 'quick capture'), 'append', 'replace'],
    },
    homeScratchpadGlobalCaptureToggle: {
      label: jt('settings.fieldCopy.homeScratchpadGlobalCaptureToggle.label', 'Ctrl+Shift+Space quick capture (while Jenny is focused)'),
      description: jt('settings.fieldCopy.homeScratchpadGlobalCaptureToggle.description', 'Enable the app-wide shortcut while Jenny has keyboard focus.'),
      sectionId: 'home',
      keywords: [jt('settings.fieldCopy.homeScratchpadGlobalCaptureToggle.keywords.globalShortcut', 'global shortcut'), 'hotkey', jt('settings.fieldCopy.homeScratchpadGlobalCaptureToggle.keywords.quickCaptureShortcut', 'quick capture shortcut')],
    },
    homeContextualTipsToggle: {
      label: jt('settings.fieldCopy.homeContextualTipsToggle.label', 'Show contextual tips'),
      description: jt('settings.fieldCopy.homeContextualTipsToggle.description', 'Show short, situational guidance on Home when it is relevant.'),
      sectionId: 'home',
      keywords: ['tips', 'hints', jt('settings.fieldCopy.homeContextualTipsToggle.keywords.contextualGuidance', 'contextual guidance')],
    },

    // ── Offline ──────────────────────────────────────────────────────────
    offlineLocalOnlyToggle: {
      label: jt('settings.fieldCopy.offlineLocalOnlyToggle.label', 'Force local inference'),
      description: jt('settings.fieldCopy.offlineLocalOnlyToggle.description', 'Require local model inference without governing tools, extensions, authentication, updates, or other network-capable services.'),
      sectionId: 'offline',
      keywords: [jt('settings.fieldCopy.offlineLocalOnlyToggle.keywords.localInference', 'local inference'), jt('settings.fieldCopy.offlineLocalOnlyToggle.keywords.offlineInference', 'offline inference'), jt('settings.fieldCopy.offlineLocalOnlyToggle.keywords.noCloudInference', 'no cloud inference'), jt('settings.fieldCopy.offlineLocalOnlyToggle.keywords.onDeviceModel', 'on device model')],
    },

    // ── Local Profile, Setup, and Updates ─────────────────────────────────
    saveLocalProfileButton: {
      label: jt('settings.fieldCopy.saveLocalProfileButton.label', 'Save local profile'),
      description: jt('settings.fieldCopy.saveLocalProfileButton.description', 'Save the optional profile name on this device.'),
      sectionId: 'account',
      keywords: ['profile', jt('settings.fieldCopy.saveLocalProfileButton.keywords.localProfile', 'local profile'), jt('settings.fieldCopy.saveLocalProfileButton.keywords.displayName', 'display name'), 'name'],
    },
    checkUpdatesButton: {
      label: jt('settings.fieldCopy.checkUpdatesButton.label', 'Check for updates'),
      description: jt('updates.networkDisclosure', 'Checks GitHub when you ask. Requires internet access.'),
      sectionId: 'aboutUpdates',
      keywords: ['update', 'updates', jt('settings.fieldCopy.checkUpdatesButton.keywords.checkForUpdates', 'check for updates'), jt('settings.fieldCopy.checkUpdatesButton.keywords.newVersion', 'new version'), 'upgrade', 'release'],
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
