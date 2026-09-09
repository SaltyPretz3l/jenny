# Jenny i18n sampling audit

Sampled: 170; misses: 4; false positives: 2.
Estimated miss rate by sampled stratum: renderer/shared × config_copy 1/6 (16.7%); renderer/shell × config_copy 2/6 (33.3%); services × main_dialog 1/4 (25.0%).

Deterministic sample: seed 101, up to 3 pending and 3 excluded occurrences per domain × kind stratum.

## index.html × html_attr

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| index.html\|html_attr\|0862dc9d3dd7\|1 | Theme bundle selector | pending | ok | line 872 |
| index.html\|html_attr\|33c642171a35\|1 | Open command palette | pending | ok | line 71 |
| index.html\|html_attr\|5417db4f9c49\|1 | Collapse context panel | pending | ok | line 596 |

## index.html × html_text

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| index.html\|html_text\|45e5f3f72e96\|1 | Commands | pending | ok | line 1316 |
| index.html\|html_text\|a58d95e71aef\|1 | Add Open Loop | pending | ok | line 184 |
| index.html\|html_text\|b8044c267b35\|1 | Run a command or insert one that needs details. | pending | ok | line 1317 |
| index.html\|html_text\|58668e7669fd\|2 | J | excluded:no_letters | ok | line 315 |
| index.html\|html_text\|b6589fc6ab0d\|9 | 0 | excluded:no_letters | ok | line 1220 |
| plugin-consent.html\|html_text\|1b93795b9768\|1 | — | excluded:no_letters | ok | line 16 |

## renderer/app × config_copy

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/app/renderer-app-shell-bindings-controllers.js\|config_copy\|736873f2986e\|2 | Chats panel actions | pending | ok | line 94 |
| renderer/app/renderer-app-shell-bindings.js\|config_copy\|1c3834260371\|1 | Startup Error | pending | ok | line 588 |
| renderer/uninstall/renderer-uninstall-assistant.js\|config_copy\|385da645edcb\|1 | Type REMOVE JENNY to continue | pending | ok | line 153 |

## renderer/app × diagnostic

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/app/renderer-app-lifecycle-preferences.js\|diagnostic\|c2fd77bf7ec4\|1 | WARN | excluded:log | ok | line 696 |
| renderer/app/renderer-app-surface-layout.js\|diagnostic\|7f585ba8b765\|1 | surface layout observer registration failed | excluded:log | ok | line 130 |
| renderer/services/renderer-setup-service.js\|diagnostic\|c2fd77bf7ec4\|5 | WARN | excluded:log | ok | line 295 |

## renderer/app × dom_identity

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/app/renderer-app-lifecycle-composition.js\|dom_identity\|4b196e7d3a42\|1 | topRailActions | excluded:dom_identity | ok | line 803 |
| renderer/app/renderer-app-shell-bindings.js\|dom_identity\|15118a864ca3\|1 | #composerModeChipsAnnouncer | excluded:dom_identity | ok | line 37 |
| renderer/app/renderer-app-shell-bindings.js\|dom_identity\|db3d405b1067\|3 | on | excluded:dom_identity | ok | line 166 |

## renderer/app × dom_text

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/app.js\|dom_text\|1538301e23a4\|1 | Something went wrong while loading. Press Retry to reload. | pending | ok | line 917 |
| renderer/app.js\|dom_text\|a9b6626515a6\|1 | Startup failed | pending | ok | line 913 |

## renderer/app × structural

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/app/renderer-app-shell-bindings.js\|structural\|bf040e972ec1\|1 | composer-model | excluded:wire | ok | line 74 |
| renderer/app/renderer-app-surface-effects.js\|structural\|ecc2cbe67105\|1 | chat-left | excluded:wire | ok | line 285 |
| renderer/frames/html-artifact-frame-init.js\|structural\|11f9578d05e6\|1 | error | excluded:frames | ok | line 94 |

## renderer/app × toast

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/app/renderer-app-open-loop-actions.js\|toast\|446574286455\|1 | Saved to Open Loops. | pending | ok | line 99 |
| renderer/app/renderer-app-open-loop-actions.js\|toast\|7d246b1a36fa\|1 | Saved to deferred open loops. | pending | ok | line 99 |
| renderer/app/renderer-app-shell-bindings.js\|toast\|9175d447f054\|1 | Jenny hit a startup problem, but the shell is opening so you can recover. | pending | ok | line 587 |

## renderer/chat × config_copy

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/chat/renderer-plan-usage-meter.js\|config_copy\|24d948e4bdbe\|1 | Limit | pending | ok | line 354 |
| renderer/chat/renderer-tool-shell-utils.js\|config_copy\|b5e8f19ac157\|1 | Python input preview | pending | ok | line 607 |
| renderer/chat/renderer-unsaved-reply-actions.js\|config_copy\|af74f7c5362a\|1 | Copy | pending | ok | line 53 |
| renderer/chat/renderer-composer-model-picker-utils.js\|config_copy\|495265260f5b\|1 | ChatGPT | excluded:proper_noun | ok | line 50 |
| renderer/chat/renderer-composer-model-picker-utils.js\|config_copy\|4d75d43c4b54\|1 | Ollama | excluded:proper_noun | ok | line 56 |
| renderer/chat/renderer-composer-v2-model.js\|config_copy\|6e3604888c4b\|1 | Python | excluded:proper_noun | ok | line 14 |

## renderer/chat × diagnostic

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/chat/renderer-chat-event-interactive-bindings.js\|diagnostic\|c2fd77bf7ec4\|6 | WARN | excluded:log | ok | line 377 |
| renderer/chat/renderer-chat-wayfinder-utils.js\|diagnostic\|c2fd77bf7ec4\|1 | WARN | excluded:log | ok | line 95 |
| renderer/chat/renderer-send-outbox-dispatch.js\|diagnostic\|7f2f6a15cf8d\|1 | Error | excluded:log | ok | line 119 |

## renderer/chat × dom_attr

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/chat/renderer-composer-model-picker.js\|dom_attr\|68c2cc7f0cea\|1 | Model | pending | ok | line 276 |
| renderer/chat/renderer-stream-dom-patch-utils.js\|dom_attr\|a804eafcb7d9\|1 | Show less code | pending | ok | line 101 |
| renderer/chat/renderer-user-questions-actions.js\|dom_attr\|b01dcdde9079\|1 | Questions no longer active | pending | ok | line 159 |

## renderer/chat × dom_identity

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/chat/renderer-chat-event-interactive-bindings.js\|dom_identity\|874ad8df4311\|1 | composer | excluded:dom_identity | ok | line 227 |
| renderer/chat/renderer-render-pipeline-message-renderer.js\|dom_identity\|db3d405b1067\|1 | on | excluded:dom_identity | ok | line 324 |
| renderer/chat/renderer-resume-turn-interaction.js\|dom_identity\|5098d574f4e9\|2 | [data-action="resume-turn"] | excluded:dom_identity | ok | line 117 |

## renderer/chat × dom_text

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/chat/renderer-composer-model-picker.js\|dom_text\|6f1bf22966d8\|1 | Applies to this chat. Defaults live in Settings. | pending | ok | line 280 |
| renderer/chat/renderer-render-pipeline-chrome.js\|dom_text\|e8bdff51d63f\|1 | Open the provider workspace to begin. | pending | ok | line 378 |
| renderer/chat/renderer-tool-detail-body.js\|dom_text\|2be88ca4242c\|1 | null | pending | ok | line 591 |
| renderer/chat/renderer-render-pipeline-chrome.js\|dom_text\|58668e7669fd\|1 | J | excluded:no_letters | ok | line 373 |
| renderer/chat/renderer-render-pipeline-chrome.js\|dom_text\|58668e7669fd\|2 | J | excluded:no_letters | ok | line 386 |
| renderer/chat/renderer-window-controls-utils.js\|dom_text\|12f139068e9d\|1 | □ | excluded:no_letters | ok | line 21 |

## renderer/chat × format_locale

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/chat/renderer-tool-detail-body.js\|format_locale\|6cdad63dc2fa\|1 | hiddenChars.toLocaleString('en-US') | pending | ok | line 208 |
| renderer/chat/renderer-transcript-thinking.js\|format_locale\|91764e2f94dd\|1 | droppedBytes.toLocaleString() | pending | ok | line 169 |
| renderer/chat/renderer-transcript-thinking.js\|format_locale\|a0c75ea1a9f6\|1 | droppedMessages.toLocaleString() | pending | ok | line 168 |

## renderer/chat × structural

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/chat/renderer-chat-event-settings-bindings.js\|structural\|222b3e11200d\|1 | danger | excluded:wire | ok | line 261 |
| renderer/chat/renderer-stream-handler-session-helpers.js\|structural\|0bc56dbd4a02\|1 | buffer_degraded | excluded:wire | ok | line 297 |
| renderer/chat/renderer-subagent-monitor-view.js\|structural\|0159eb7a75c1\|1 | subagent-error-{expr} | excluded:wire | ok | line 189 |

## renderer/chat × toast

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/chat/renderer-chat-bulk-actions-utils.js\|toast\|bc5f1195aad5\|1 | from the earliest selection onward ( | pending | ok | line 426 |
| renderer/chat/renderer-chat-bulk-actions-utils.js\|toast\|be0913f088b2\|1 | Delete failed: | pending | ok | line 440 |
| renderer/chat/renderer-slash-note-command.js\|toast\|c10fc017baaa\|1 | Could not save the note. | pending | ok | line 49 |

## renderer/features/setup-scenes × config_copy

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/setup-scenes/scene-capabilities.js\|config_copy\|77dfd2135f4d\|1 | Cancel | pending | ok | line 118 |
| renderer/features/setup-scenes/scene-local-model.js\|config_copy\|e626635566b6\|1 | Setup Step | pending | ok | line 225 |
| renderer/features/setup-scenes/scene-setup-hub.js\|config_copy\|0ab9ea83bace\|1 | Set up Jenny | pending | ok | line 164 |

## renderer/features/setup-scenes × diagnostic

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/setup-scenes/scene-setup-hub.js\|diagnostic\|c2fd77bf7ec4\|3 | WARN | excluded:log | ok | line 292 |
| renderer/features/setup-scenes/scene-workspace-root.js\|diagnostic\|5832d2468741\|1 | setup.workspace_root_action_failed | excluded:log | ok | line 301 |
| renderer/features/setup-scenes/scene-workspace-root.js\|diagnostic\|c2fd77bf7ec4\|1 | WARN | excluded:log | ok | line 143 |

## renderer/features/setup-scenes × dom_identity

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/setup-scenes/ollama-engine-gate.js\|dom_identity\|69cce3c85a11\|1 | .setup-hw-progress-fill | excluded:dom_identity | ok | line 198 |
| renderer/features/setup-scenes/ollama-engine-gate.js\|dom_identity\|75a3d93b9d84\|1 | .setup-hw-progress-label | excluded:dom_identity | ok | line 204 |
| renderer/features/setup-scenes/scene-local-model.js\|dom_identity\|1ab5a1ef073f\|1 | #setup-local-model-name | excluded:dom_identity | ok | line 141 |

## renderer/features/setup-scenes × structural

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/setup-scenes/scene-local-model.js\|structural\|b24f6051eee4\|1 | startPull | excluded:wire | ok | line 52 |
| renderer/features/setup-scenes/scene-setup-hub.js\|structural\|4be13f89cf4c\|1 | finishSetup | excluded:wire | ok | line 169 |
| renderer/features/setup-scenes/scene-setup-hub.js\|structural\|7c5e83d7e706\|1 | upgrade | excluded:wire | ok | line 263 |

## renderer/features/setup-scenes × toast

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/setup-scenes/scene-capabilities.js\|toast\|bfe4616c766a\|1 | Could not save capabilities. | pending | ok | line 147 |
| renderer/features/setup-scenes/scene-local-model.js\|toast\|9dbfc5694888\|1 | Model pull complete. | pending | ok | line 211 |
| renderer/features/setup-scenes/scene-model-library.js\|toast\|9a197b37436e\|3 | Finish or cancel the model operation first. | pending | ok | line 295 |

## renderer/features × config_copy

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/renderer-dashboard-calendar-month.js\|config_copy\|1a680ccb255a\|1 | {expr} more event{expr} on {expr} | pending | ok | line 238 |
| renderer/features/renderer-ide-bottom-panel.js\|config_copy\|0893f2635641\|1 | Run output | pending | ok | line 36 |
| renderer/features/renderer-ide-test-runner-gate-utils.js\|config_copy\|a04ef2ee4494\|1 | {expr} is running | pending | ok | line 132 |
| renderer/features/renderer-dashboard-calendar-rail.js\|config_copy\|0dccf909173c\|1 | ‹ | excluded:no_letters | ok | line 168 |
| renderer/features/renderer-dashboard-calendar-toolbar.js\|config_copy\|0dccf909173c\|1 | ‹ | excluded:no_letters | ok | line 85 |
| renderer/features/renderer-dashboard-calendar-toolbar.js\|config_copy\|6d977aec387e\|1 | ⋯ | excluded:no_letters | ok | line 96 |

## renderer/features × diagnostic

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/renderer-artifacts-utils.js\|diagnostic\|c360c0ad76e0\|1 | artifacts.jump_to_chat | excluded:log | ok | line 373 |
| renderer/features/renderer-ide-file-lifecycle.js\|diagnostic\|9c9cf9998291\|1 | INFO | excluded:log | ok | line 410 |
| renderer/features/renderer-memory-utils.js\|diagnostic\|9c9cf9998291\|2 | INFO | excluded:log | ok | line 425 |

## renderer/features × dom_attr

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/renderer-html-artifact-frame-utils.js\|dom_attr\|bbc9bff35925\|1 | HTML artifact live preview | pending | ok | line 230 |
| renderer/features/renderer-ide-branch-switcher.js\|dom_attr\|ac69cba3d458\|2 | Switch branch… | pending | ok | line 649 |
| renderer/features/renderer-offline-utils.js\|dom_attr\|35c4bce97c1c\|1 | Session settings · {expr} | pending | ok | line 235 |

## renderer/features × dom_identity

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/renderer-dashboard-daybook.js\|dom_identity\|75536745a2dc\|3 | is-resizing | excluded:dom_identity | ok | line 469 |
| renderer/features/renderer-ide-run-scripts.js\|dom_identity\|2ee6270fcb33\|1 | ide-terminal-status--warn | excluded:dom_identity | ok | line 324 |
| renderer/features/renderer-task-rail.js\|dom_identity\|769922616b42\|1 | [data-task-id] | excluded:dom_identity | ok | line 180 |

## renderer/features × dom_text

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/renderer-artifacts-utils.js\|dom_text\|0191a087a789\|1 | {expr} artifact{expr} available beside chat. | pending | ok | line 487 |
| renderer/features/renderer-ide-fim-picker.js\|dom_text\|a7d5e1301a6f\|1 | Completion model | pending | ok | line 207 |
| renderer/features/renderer-memory-settings-utils.js\|dom_text\|c13d590bd87a\|1 | Loading approved memories… | pending | ok | line 342 |
| renderer/features/renderer-companion-utils.js\|dom_text\|b6589fc6ab0d\|1 | 0 | excluded:no_letters | ok | line 462 |
| renderer/features/renderer-mermaid-utils.js\|dom_text\|6a4e6e729f96\|1 | − | excluded:no_letters | ok | line 667 |
| renderer/features/renderer-mermaid-utils.js\|dom_text\|a5c15531742e\|1 | ↺ | excluded:no_letters | ok | line 688 |

## renderer/features × format_locale

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/renderer-artifacts-projection.js\|format_locale\|f1cdf448a587\|1 | parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) | pending | ok | line 205 |
| renderer/features/renderer-dashboard-calendar-agenda.js\|format_locale\|c70303b0638c\|1 | day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) | pending | ok | line 154 |
| renderer/features/renderer-ide-commit-history.js\|format_locale\|12f8f5f39074\|1 | new Date(then).toLocaleString() | pending | ok | line 111 |

## renderer/features × structural

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/renderer-ide-secondary-sidebar.js\|structural\|49a04ba44696\|1 | changes | excluded:wire | ok | line 39 |
| renderer/features/renderer-monaco-editor-utils.js\|structural\|5d288ad264ad\|1 | fallback | excluded:wire | ok | line 429 |
| renderer/features/renderer-personality-utils.js\|structural\|c4745785181d\|1 | ghost | excluded:wire | ok | line 192 |

## renderer/features × toast

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/features/renderer-companion-action-utils.js\|toast\|ce2b0c1368cd\|1 | Choose when this should resurface. | pending | ok | line 410 |
| renderer/features/renderer-ide-chip-picker.js\|toast\|767234465c48\|1 | Could not switch chat sessions. The current session remains open. | pending | ok | line 430 |
| renderer/features/renderer-ide-explorer-wiring.js\|toast\|9632309d2b59\|1 | Restored 1 item | pending | ok | line 168 |

## renderer/inventory × diagnostic

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/inventory/step-modal.js\|diagnostic\|66a549212768\|1 | step_modal.overlay_manager_unavailable | excluded:log | ok | line 287 |
| renderer/inventory/step-modal.js\|diagnostic\|c2fd77bf7ec4\|1 | WARN | excluded:log | ok | line 287 |

## renderer/inventory × dom_attr

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/inventory/codeblock.js\|dom_attr\|a804eafcb7d9\|1 | Show less code | pending | ok | line 272 |
| renderer/inventory/drawer.js\|dom_attr\|433da6d15dd1\|1 | Close details | pending | ok | line 96 |
| renderer/inventory/favicon-badge.js\|dom_attr\|ff827c24b143\|2 | Show fewer sources | pending | ok | line 146 |

## renderer/inventory × dom_identity

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/inventory/anchored-listbox.js\|dom_identity\|6325f8c63097\|1 | span | excluded:dom_identity | ok | line 100 |
| renderer/inventory/codeblock.js\|dom_identity\|f620b451d3b3\|1 | .inv-codeblock-wrap-toggle | excluded:dom_identity | ok | line 252 |
| renderer/inventory/collapsible.js\|dom_identity\|86c34f615f3e\|2 | expanded | excluded:dom_identity | ok | line 273 |

## renderer/inventory × dom_text

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/inventory/favicon-badge.js\|dom_text\|4c852b26d1b7\|1 | Show less | pending | ok | line 144 |
| renderer/inventory/favicon-badge.js\|dom_text\|e7c95b4c2824\|1 | more | pending | ok | line 144 |
| renderer/inventory/selection-action-bar.js\|dom_text\|dbd388ae9a47\|1 | 1 selected | pending | ok | line 248 |

## renderer/shared × config_copy

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shared/appearance-utils.js\|config_copy\|26d7b218c9b5\|2 | Slate | pending | ok | line 419 |
| renderer/shared/appearance-utils.js\|config_copy\|4f4060d85d85\|1 | Standard 760px reading measure. | pending | ok | line 152 |
| renderer/shared/appearance-utils.js\|config_copy\|6bf195cd6f4a\|1 | Sparse Y2K twinkles that breathe and flare under the pointer — XJ-9 sparkle field. | pending | ok | line 216 |
| renderer/shared/appearance-utils.js\|config_copy\|e0049a66519c\|1 | On | excluded:no_letters | miss | line 303; visible localized state label |
| renderer/shared/engine-tuning-schema.js\|config_copy\|1971b5043d8f\|1 | 60% | excluded:no_letters | ok | line 327 |
| renderer/shared/engine-tuning-schema.js\|config_copy\|22983907403c\|1 | 70% | excluded:no_letters | ok | line 318 |

## renderer/shared × diagnostic

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shared/markdown-utils.js\|diagnostic\|40708bf2ed50\|1 | [markdown-utils] marked library not loaded; markdown will render as plain text. | excluded:log | ok | line 122 |
| renderer/shared/renderer-katex-runtime-loader.js\|diagnostic\|0e67b5d40fa5\|1 | [katex-runtime] suppressing KaTeX runtime load retries {expr} | excluded:log | ok | line 115 |
| renderer/shared/script-loader-utils.js\|diagnostic\|fb64926f3391\|1 | renderer.script_load_failed | excluded:log | ok | line 132 |

## renderer/shared × dom_attr

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shared/markdown-utils.js\|dom_attr\|0c6e47356142\|1 | Collapse Mermaid diagram | pending | ok | line 780 |
| renderer/shared/markdown-utils.js\|dom_attr\|5a34274af85e\|1 | Expand Mermaid diagram | pending | ok | line 780 |
| renderer/shared/markdown-utils.js\|dom_attr\|99a0753f05ae\|1 | Show Mermaid source | pending | ok | line 770 |

## renderer/shared × dom_identity

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shared/markdown-utils.js\|dom_identity\|2a242490d881\|1 | contains-task-list | excluded:dom_identity | ok | line 228 |
| renderer/shared/markdown-utils.js\|dom_identity\|6325f8c63097\|1 | span | excluded:dom_identity | ok | line 273 |
| renderer/shared/markdown-utils.js\|dom_identity\|fae6ea7a30c9\|1 | md-mermaid- | excluded:dom_identity | ok | line 258 |

## renderer/shared × dom_text

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shared/markdown-utils.js\|dom_text\|25911d48e023\|1 | Show more | pending | ok | line 370 |
| renderer/shared/markdown-utils.js\|dom_text\|ca1b5e688f3a\|1 | Mermaid diagram | pending | ok | line 276 |
| renderer/shared/markdown-utils.js\|dom_text\|fed046c87762\|1 | Mermaid code | pending | ok | line 299 |

## renderer/shared × structural

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shared/appearance-utils.js\|structural\|7a75914bd08e\|1 | darkroom | excluded:wire | ok | line 51 |
| renderer/shared/engine-tuning-schema.js\|structural\|13a1af675fd9\|1 | toolsGitTimeoutSeconds | excluded:wire | ok | line 299 |
| renderer/shared/toast-utils.js\|structural\|e059fc6904f0\|1 | secondary | excluded:wire | ok | line 63 |

## renderer/shell × config_copy

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shell/renderer-runtime-health-utils.js\|config_copy\|99613c74ce01\|1 | Blocked | pending | ok | line 109 |
| renderer/shell/renderer-session-actions.js\|config_copy\|3c1a5c629b0f\|1 | Rename chat | pending | ok | line 291 |
| renderer/shell/renderer-settings-utils.js\|config_copy\|451d58deb4ca\|1 | {expr} enabled capabilities ready - {expr}. | pending | ok | line 470 |
| renderer/shell/renderer-fallback-registry.js\|config_copy\|e0049a66519c\|1 | On | excluded:no_letters | miss | line 1; visible fallback state label |
| renderer/shell/renderer-fallback-registry.js\|config_copy\|e0049a66519c\|2 | On | excluded:no_letters | miss | line 1; visible fallback state label |
| renderer/shell/renderer-settings-model-library-section.js\|config_copy\|178f1f4007d3\|1 | ↻ | excluded:no_letters | ok | line 238 |

## renderer/shell × diagnostic

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shell/renderer-knowledge-folders.js\|diagnostic\|c2fd77bf7ec4\|1 | WARN | excluded:log | ok | line 336 |
| renderer/shell/renderer-lifecycle-error-utils.js\|diagnostic\|0b99cebe5658\|1 | ERROR | excluded:log | ok | line 102 |
| renderer/shell/renderer-settings-compaction-section.js\|diagnostic\|9c9cf9998291\|2 | INFO | excluded:log | ok | line 121 |

## renderer/shell × dom_attr

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shell/renderer-sidebar-utils.js\|dom_attr\|b764a0d17ed8\|1 | Remove all attachments | pending | ok | line 147 |
| renderer/shell/renderer-workspace-chrome-utils.js\|dom_attr\|7cb5d44c885c\|2 | Cannot close a busy session. | pending | ok | line 294 |
| renderer/shell/renderer-workspace-chrome-utils.js\|dom_attr\|e65017017f21\|1 | Close session | pending | ok | line 273 |

## renderer/shell × dom_identity

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shell/renderer-knowledge-folders.js\|dom_identity\|261f70955c1a\|4 | [data-step-modal=" | excluded:dom_identity | ok | line 547 |
| renderer/shell/renderer-mcp-servers.js\|dom_identity\|f74b343745f5\|1 | mcpServerTarget | excluded:dom_identity | ok | line 305 |
| renderer/shell/renderer-turn-status-pill.js\|dom_identity\|49d90a31d3ca\|2 | titlebar-status--shutdown | excluded:dom_identity | ok | line 185 |

## renderer/shell × dom_text

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shell/renderer-command-palette-render.js\|dom_text\|cdf7e925f574\|1 | results | pending | ok | line 234 |
| renderer/shell/renderer-phase-percentiles-utils.js\|dom_text\|d6a757333c31\|1 | Phase latency unavailable | pending | ok | line 293 |
| renderer/shell/renderer-settings-core-renderers.js\|dom_text\|b2cecf5e79b7\|1 | No saved approval rules yet. | pending | ok | line 131 |
| renderer/shell/renderer-toast-utils.js\|dom_text\|67fba2f357af\|1 | × | excluded:no_letters | ok | line 151 |

## renderer/shell × format_locale

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shell/renderer-model-tuning-drawer.js\|format_locale\|9a39170b3e3a\|1 | Number(bounds.min).toLocaleString('en-US') | pending | ok | line 229 |
| renderer/shell/renderer-slash-command-context.js\|format_locale\|4ee9c17b6b84\|1 | Math.floor(normalized).toLocaleString() | pending | ok | line 24 |
| renderer/shell/renderer-usage-markup-utils.js\|format_locale\|e3428fd4bc9e\|1 | date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) | pending | ok | line 63 |

## renderer/shell × native_dialog

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shell/renderer-settings-shell-controller.js\|native_dialog\|0c3d3d4b0189\|1 | You have unsaved context-file changes. Leave this section without saving? | pending | ok | line 445 |
| renderer/shell/renderer-usage-controller.js\|native_dialog\|4ee866bbf236\|1 | Clear usage history? This permanently removes all retained local usage rows and totals. | pending | ok | line 371 |

## renderer/shell × structural

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shell/renderer-plugin-manager-details.js\|structural\|c4745785181d\|1 | ghost | excluded:wire | ok | line 117 |
| renderer/shell/renderer-settings-section-binders.js\|structural\|222b3e11200d\|1 | danger | excluded:wire | ok | line 177 |
| renderer/shell/renderer-shell-runtime-utils.js\|structural\|59bd0a3ff43b\|4 | info | excluded:wire | ok | line 884 |

## renderer/shell × toast

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| renderer/shell/renderer-mcp-servers.js\|toast\|6621f78c4d96\|1 | tool(s). | pending | ok | line 383 |
| renderer/shell/renderer-session-actions.js\|toast\|0d3fddbf0c06\|1 | No empty chats to sweep. | pending | ok | line 387 |
| renderer/shell/renderer-shell-runtime-utils.js\|toast\|985425d702b4\|1 | No pending tool approval found to skip. | pending | ok | line 853 |

## services × ipc_message

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| services/backend/backend-runtime.js\|ipc_message\|6c7250cfdb4b\|1 | Managed sidecar is not ready yet. | pending | ok | line 274 |
| services/plugins/lifecycle/operation-result.js\|ipc_message\|b9823c921b4b\|1 | guidance_contains_path | pending | false-positive | line 120; internal reason code |
| services/workspace-git-service.js\|ipc_message\|88144d8e8875\|1 | no_prior_commit | pending | false-positive | line 892; internal reason code |

## services × main_dialog

| id | text | scanner disposition | reviewer verdict | note |
|---|---|---|---|---|
| services/auxiliary-ipc-handlers.js\|main_dialog\|a55e96c0f897\|1 | Select attachments | pending | ok | line 734 |
| services/main/data-lifecycle-ipc-registration.js\|main_dialog\|0e945e9917ec\|1 | Choose a Jenny archive | pending | ok | line 143 |
| services/main/plugins-ipc-registration.js\|main_dialog\|c18fc8b02ffc\|1 | Trust offline plugin mirror? | pending | ok | line 711 |
| services/sidecar-crash-dialog.js\|main_dialog\|9ce3bd4224c8\|1 | OK | excluded:no_letters | miss | line 96; visible dialog button label |
