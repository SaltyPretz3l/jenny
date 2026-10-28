# Keyboard shortcuts and a tour of the interface

## The title bar

Left to right: the Jenny wordmark with the health indicator beside it, the tabs Home, Chat, Workspace and Diagnostics, and the Settings gear. The tabs also respond to Ctrl+1 through Ctrl+5 (Home, Chat, Workspace, Diagnostics, Settings). Ctrl+K opens the command palette, where actions and skills are searchable.

## The Chat view

- Chats panel (left): search, project filter, the chat groups, the Needs you inbox, and the pinned Jenny chat. Ctrl+B collapses it to a strip; Ctrl+N starts a new chat. See chats-and-projects.
- Timeline (middle): the conversation. Each turn shows Jenny's thinking, then tool rows, then the answer.
- Composer (bottom): where you type.
- Session summary and artifacts (right, optional): the Session rail and the artifact panel. Artifact review replaces the context column and can be maximized.
- Chat tabs: open chats appear as tabs above the conversation.

### The timeline

Thinking appears as a Thinking row ("Thought for 4s" when finished) that opens while streaming and folds when done. Tool calls are one-line rows: a status dot, the tool name, a short summary and a duration, expanding to arguments, output and diffs. Rows waiting for approval, errored or denied rows expand by themselves. A diff card shows a file change. Hovering a message reveals actions such as copy, edit, delete, regenerate and branch (Ctrl+Shift+B branches from the focused message). Jump buttons take you to the top, your last prompt or the bottom; a pinned strip shows your prompt when you scroll away from it.

A small sprite on the left edge shows what Jenny is doing: working, waiting for approval, done or stopped.

### Transcript views

Choose how much of the machinery shows: Answers (replies only; thinking and tool details are tucked away), Thinking (thinking opens while it streams and folds when done), or Everything (thinking and tool details open by default). Settings > Appearance > Transcript view sets the default for chats you have not set individually, and the command palette action Cycle transcript view changes the current chat.

### The composer

- Type your message. Enter sends and Shift+Enter inserts a new line. While Jenny replies, Send becomes Queue, and a queued message runs under the mode shown. Stop ends the reply.
- The + menu: Attach files, Capture screen, Add active file (when one is available), Commands (/) and Skills. Typing / opens the same list.
- The tools chip: Tools for this chat, with per-chat tool switches and the project pill. See tools-overview.
- The run-mode chip: Ask, Auto, Plan or Propose. Shift+Tab cycles; Alt+P toggles Plan. See run-modes-and-approvals.
- The model pill: choose the model and the reasoning effort for this chat.
- The context ring: shows how close the chat is to automatic summarization. 100 percent is the auto-compact point, after which Jenny summarizes older messages. Its popover shows the breakdown and a Compact now action.
- Attachments appear as a tray above the composer; a model that cannot see images says so before you send.
- The composer can show a failed-send notice, a queue, background jobs and a turn timer.

### Split view

Ctrl+Shift+\ opens or closes a second pane so you can see two chats side by side. Each pane has its own timeline, composer and session summary.

## Keyboard shortcuts

Press ? outside a text field to open the shortcuts overlay for the Chat view.

- Navigation: Alt+Down and Alt+Up move between messages. Home and End jump to the first and last message. Ctrl+Shift+U jumps to the first unread message.
- Search: Ctrl+F searches the conversation. Enter and Shift+Enter move between matches.
- Editing: Enter on a focused user message edits it. Ctrl+Enter saves and resends. Esc cancels.
- Selection: Shift+Click enters selection mode. Ctrl+A selects all in selection mode. Delete removes the selected messages and everything after. Esc cancels.
- Composer: Enter sends, Shift+Enter inserts a new line, Shift+Tab cycles the run mode, Alt+P toggles Plan mode.
- Dictation: hold Ctrl+Space anywhere in Jenny (outside other text fields) and speak; release to insert the words at the cursor. A quick press starts hands-free listening: Enter inserts, Esc discards. The mic beside Send works the same way. Dictation never sends; the speech model (673 MB, runs on the CPU, European languages) downloads from Settings > Dictation or the mic on first use, and audio never leaves the computer.
- Zoom: Ctrl+ plus and Ctrl+ minus zoom; Ctrl+0 resets. Text size in Settings is a separate, persistent scale.
- App: Ctrl+1 to Ctrl+5 switch views, Ctrl+N new chat, Ctrl+B chats panel, Ctrl+K command palette, Ctrl+Shift+\ split view, Ctrl+Shift+Space quick-capture a note on Home while Jenny has focus.
- Workspace: Ctrl+G go to line, Ctrl+` toggle the bottom panel, Ctrl+F4 close the tab, Alt+Z word wrap, Ctrl+Alt+K bookmark, F3 and Shift+F3 next and previous find match in a PDF, F4 PDF sidebar, Alt+Enter accept a suggested change.

In the chats panel, Up and Down, Home and End move between rows, Enter or Space opens one, Escape clears the search, and ContextMenu or Shift+F10 opens the focused row's menu.

## Themes and appearance

Settings > Appearance controls the look.

- Palette: Midnight (the dark default), Paper (light), Jenny XJ-9 Daytime and Night Patrol, Darkroom, Lexicon, Obsidian, Pewter, Retro Teal, Signal, Slate and Woolly World. A Theme bundle combines a palette, typography, a background effect and the composer effect in one choice.
- Typography and Text size scale all text in Jenny. Overall app zoom scales the whole shell, and Ctrl+ plus and Ctrl+ minus zoom the window.
- Chat width: Narrow or Standard. Open the artifact panel when an artifact arrives controls whether the side panel opens on its own.
- Background effect behind Home and Chat: None, Reactive Grid, Atomic Burst, Circuit Trace, Context Weave or Playlist Scroll. Slate has no effect on purpose.
- Holographic typing border: a glowing animated border around the composer while you type.
- Startup animation: a short starfield while Jenny opens, or a plain curtain; it follows your system's reduced-motion setting.
- Language and a 24-hour clock are in the same section.

## Notifications

Settings > Notifications controls desktop notifications: master switch, only when Jenny is in the background, sound, and whether the reply text appears. Categories are a reply is ready, a run fails, Jenny needs permission, Jenny asks a question or a plan is ready, and a reminder is due. Your own Stop never notifies. The chats panel and the Needs you inbox show the same waiting items inside the app.
