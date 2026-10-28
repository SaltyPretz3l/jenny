# The Workspace

The Workspace (Ctrl+3) is Jenny's built-in IDE. It works on the Workspace folder you chose, which is also a project: choosing a folder makes it a project, file tools work inside it, and new chats start there. If no folder is open, the Workspace offers Choose a folder, Switch project, and a list of Your projects.

## Layout

- Explorer: the file tree. You can rename, move, create and delete files (deletes go to the recycle bin with an Undo), use Find in Folder, and Open in Terminal on a folder.
- Editor: a Monaco editor with a Git gutter, tabs (pin, close others, compare with saved, reopen the last closed tab), a Problems list for open TypeScript, JavaScript, JSON and CSS files, bookmarks, Quick Open by file name, go to line or symbol, and find and replace across the workspace with an undo.
- Editor groups: you can split the editor into several groups. A group can be bound to a chat: files Jenny opens from that chat land in the bound group, and runs started there use the bound chats.
- Bottom panel: Terminal and Problems. Ctrl+` toggles it.
- Status bar: line and column, indentation, line ending, the Git branch (click to switch branch), and problem counts.
- Jenny dock: Jenny sits beside the editor. It is the same session as the Chat view, so the conversation carries over. A switch lets the dock show Chat or Changes.

Editor preferences (font size, tab size, rulers, word wrap, minimap, line numbers, format on save, trim trailing whitespace, final newline, auto-save) are in Settings > Editor.

## Terminals

The Terminal panel runs real shell sessions in the workspace. You can start a session, restart it, clear it, and send an interrupt (Ctrl+C) to the running command. The terminal can be unavailable in some modes.

## File Map

File Map (in the rail beside Preview) draws a dependency map of the workspace. Press Generate to build it. It has layers: Activity (a warm glow on files Jenny touched in the current turn, with a "touched and edited" count), Deps (the selected file's imports) and Health (size-cap and cycle hints). You can search files, hide tests, and ask a question about the project from the overview. Very large workspaces produce a partial map, and the map says which scan limit was reached. While Jenny works, map updates are held until the turn finishes.

## Preview

Open Preview from a file's right-click menu, or open one in the editor and switch to the Preview surface. It renders Markdown, Mermaid and self-contained HTML. HTML previews are sandboxed: external stylesheets, scripts, images and network requests are not loaded. A very large or binary file cannot be previewed.

## PDF and Word documents

- PDFs open in a viewer with Fit width and Fit page, zoom, an Outline and thumbnails sidebar (F4), and find with Match case, Whole words and Match accents (F3 for next match). You can Select, Text, Highlight and Draw. Annotations and form fields are saved into the PDF; existing text and layout cannot be edited. A password-protected PDF asks for its password, which Jenny keeps only while the tab is open. Select text and use Ask Jenny to ask about it.
- Word (.docx) files open for editing with bold, italic, underline, bullets, numbering, headers and footers, and image insertion. Some content is preserved but not editable here (comments, tracked changes, fields, footnotes, math, text boxes, nested tables, content controls) and the viewer lists what it kept. In a document that tracks changes, edits made in Jenny are not recorded as revisions.
- Viewing and editing PDFs works without the optional PDF reading add-on. That add-on is only needed when Jenny itself reads PDF text, tables or scanned pages (see tools-overview).

## Git: Source Control, branches and Changes

- Source Control lists changed files in a Changed group; a file Jenny changed carries a Jenny marker that opens the change in Changes. Stage, Unstage or Stage All, type a commit message (or press Write message to have your configured model draft one from the staged changes, as a one-shot request kept out of the chat), and Commit. Discard restores the last committed version and cannot be undone, so it asks first. A folder that is not a Git repository says so.
- Branches: switch or create a branch from the status bar or the command palette. If you have uncommitted work, Jenny offers to shelve changes first and later Restore shelved changes. Undo last commit keeps your changes in the working files.
- History shows recent commits; selecting one shows its changes.
- Changes: the chat dock's Changes view collects Jenny's suggested changes (in Propose mode) and a History of changes already made, with Undo and Redo. See run-modes-and-approvals. The Working tree is the live Git state and may include edits Jenny did not make.
- Worktrees: Jenny can create and switch isolated Git worktrees when Settings > Tools > Worktree tools is on. The session summary names the worktree a chat is in.

## Run and test

- Run this file and Run npm script start a task in the workspace. Output appears in a task footer with the exit code and duration, a Run again button, and Ask Jenny to fix when the task failed.
- Test configurations: you can save test configurations in the Test Runner. Jenny's verify tool can run only the configurations you saved, and each run is labeled "by you" or "by Jenny". Test running can be turned off.
- Only one task runs at a time. Stop kills the process tree.

## Asking Jenny from the Workspace

With a file open, the composer shows that Jenny can see the active file. Selecting code and using Jenny's actions sends that selection, and Jenny can open files, previews, the File Map and a change for you with workspace_present. When Jenny asks the Workspace to show something, the request may be held while you are typing; it never steals focus.

## Keyboard

Ctrl+K opens the command palette. Ctrl+G goes to a line. Ctrl+F4 closes the active tab. Alt+Z toggles word wrap. Ctrl+Alt+K toggles a bookmark. The Workspace has its own shortcuts overlay under Keyboard shortcuts on the welcome screen.
