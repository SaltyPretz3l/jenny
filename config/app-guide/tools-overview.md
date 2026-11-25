# What Jenny can do with tools

Jenny acts through tools. Each tool belongs to a family, has an approval posture, and is available only when its switch is on, its prerequisites are met (for example a workspace folder), and the current run mode and safety mode allow it. Read run-modes-and-approvals for how approval works.

## When a tool is available

A tool is offered to the model when all of these hold:

- Its feature switch is on (Settings > Tools, or the per-chat tools panel).
- It has what it needs. Most file, shell and Git tools need a workspace folder; without one they are blocked on purpose.
- The platform supports it (Python execution is Windows and Linux).
- The safety mode allows it (Strict removes web tools; Paranoid asks on everything).

If a tool is hidden from the model to save context, the model can ask for it with tool_search.

## Tool families

- Files and workspace: read_file, write_file, edit_file, propose_change, delete_file, move_file, glob_files, list_dir, grep_search. Mutations ask; reads do not. A file must be read before it is overwritten, so Jenny cannot clobber a file it never read. File tools require valid UTF-8 text.
- Git (read-only): git_status, git_log, git_diff, git_show. report_findings turns a code review into an inline list of findings with severity, file and line.
- Search: grep_search and glob_files search the workspace; knowledge_search searches your registered knowledge folders; conversations_search searches earlier chats in the same project; web_search searches the web (off by default).
- Commands: run_command, run_temp_script, background jobs (check_background_job, stop_background_job) and monitors. Off by default, approval required, with a fail-closed classifier that always asks about interpreters, package managers, compilers, fetchers and destructive commands.
- Python: python_execute runs Python with the same file access as Jenny. Off by default; every run asks except in Auto with a project folder; resource-bounded but not a filesystem or network sandbox.
- Seeing images: with a model that can see images, the first chart python_execute draws and an image read_file opens (with Image and PDF page reads on) are shown to the model in its next step, not only to you. PDF pages are not.
- Artifacts and visualizations: create_artifact makes scratch documents (Markdown, text, JSON, CSV, Mermaid) and HTML pages that preview in a network-isolated frame in the artifact panel. Inert documents need no approval; scripts do. A Mermaid diagram needs no tool: a fenced code block tagged mermaid in the reply is drawn as a chart in the chat.
- Preview and checks: workspace_present asks the IDE to show a preview, the File Map or a change. preview_test loads one HTML file in a hidden sandbox and reports render state and console errors. verify runs one of your own saved test configurations.
- Image generation: image_generate draws one PNG from a prompt using your local image engine and saved model set. It needs the image engine installed in Settings > Models. Nothing leaves the machine.
- Web: web_search and fetch_url. Off by default and read-only, with protections against private-network addresses. Settings > Tools > Web has the provider choice (DuckDuckGo needs no setup; Brave, Google Programmable Search, Serper, Tavily and a self-hosted SearXNG are options).
- Knowledge: knowledge_search, knowledge_view and knowledge_exec read documents in folders you register under Settings > Tools > Knowledge folders. Read-only. Optional Search by meaning uses a local embedding model you pick.
- Memory: the memory tool remembers, updates, forgets and recalls durable notes. See memory-and-personality. Earlier chats can be browsed with conversations_recent, conversation_open and conversations_search.
- Home and tasks: home reads and edits the calendar and reminders and reads the scratchpad; task_board adds, updates and completes tasks in the Home follow-ups list. Writes are automatic; deletes need a confirmation round-trip. Reminders fire only while Jenny is running.
- Project notes: project_notes reads and edits the one notes page per project, with an undo control.
- To-dos: todo_write and todo_read keep an in-session checklist for multi-step work.
- Helpers: delegate hands one to three tasks to helper tasks and returns their answers. It adds model cost and time. A task is read-only research unless it asks to write: on Auto, with a cloud model and a project folder, a writing helper edits files in its own Git worktree and branch, so your checkout is untouched until the main chat merges its change. A writing helper uses only file and Git tools, cannot run commands and never shows an approval card: a step that would need one is refused, and the main chat can run it. The helper's monitor shows its branch and how much changed; a helper that changed nothing has its worktree removed.
- Worktrees and code intelligence: worktree_list, worktree_create, worktree_select and worktree_delete manage isolated Git worktrees; lsp gives read-only diagnostics, symbols and definitions from language servers.
- Skills: load_skill reads a skill on demand. See skills-and-mcp.
- Computer: computer lets Jenny use the mouse and keyboard in Windows programs you allow, one chat at a time. Off until you switch it on. See The Computer row.
- Live tab: run_view_look and run_view_restart let Jenny look at your project's program and restart it. See The Live tab.
- Questions and plans: ask_user asks you structured questions; exit_plan_mode submits a plan for review.
- Next step: suggest_next_step ends a reply with a short recap and up to three reply buttons; a click sends that reply as your next message. It never waits.
- Proposals: propose_git_action, propose_command and propose_session hand a decision to you instead of acting. propose_session offers a new linked chat.
- Sessions and messaging: sessions_list, session_status, session_transcript, session_stop and session_message let a chat see other chats, check their status, read their transcripts, message them and stop them. In the Jenny chat, session_prioritize lets one chat's task finish first on the model; chat_organize and chat_configure also rename, pin or archive other chats, move them and set their model, effort and run mode, always with your approval and an Undo in Activity; projects_list and project_create find or create the project for a folder before Jenny offers a chat there; app_view opens a place in the app for you to see; session_export saves a copy of a chat to Downloads; terminal_read reads the IDE terminal (project chats too, for the project the IDE has open) and terminal_run runs one line there, always with a card. See linked-chats-and-messaging and jenny-chat.
- Diagnostics: jenny_status returns a read-only snapshot of backend, runtime, logs and budgets. connections_list reports configured connections. jenny_help searches this guide.
- MCP: tools from approved MCP servers appear as mcp__server__tool. See skills-and-mcp.

## Per-chat tool switches

The tools chip in the composer opens "Tools for this chat". It shows the chat's tool families as switches (Files, Git, Terminal, Python, Web, Knowledge, Images, Artifacts and diagrams, Preview and checks, Home and tasks, Helpers, Code intelligence). A row can say Off in Settings (turn it on in Settings first), Needs a project, Offline for this chat, or Some actions ask first. Always on: questions, to-dos, plan, status and skills. Reset to defaults restores the settings values, All tools shows each tool, and Full settings opens Settings > Tools. Per-chat changes apply to your next message.

## The Browser row

Browser is a row in "Tools for this chat" and is off in every chat until you switch it on. When it is on, Jenny can open and use real web pages. A page opens in the panel beside the chat, and a Browser chip next to Tools shows or hides it. Jenny asks before it opens a site it has not been to in this chat, and before a click or form send that could buy, send, delete or sign in. Allowing a site lasts for the chat; allowing a risky action covers that one action. Jenny never types into password or payment fields, and a chat has no saved sign-ins. Click or type in the page to take over; Jenny waits until you choose Hand back to Jenny. Stop in the composer leaves the page open. Jenny stops at a CAPTCHA and hands it to you. Strict safety mode makes Browser unavailable, and PDFs and downloads are not supported yet. JENNY_ENABLE_TOOLS_BROWSER_USE=0 removes the row.

## The Computer row

Computer is a row in "Tools for this chat" and is off in every chat until you switch it on. When it is on, Jenny can use the real mouse and keyboard in Windows programs you allow. It needs Windows, a model that runs on this computer and can see images, Safety mode set to Normal, and the command sandbox off. When it cannot work, the row is greyed out and says why, with a link to the setting when there is one. Settings > Tools > Computer has the main switch, "Let chats use the computer", on by default.

Jenny asks before it uses a program. The question names the program and lasts for the chat. It asks again before it starts a program, and the first time a program shows an Open or Save window, because from there it can reach any file that program can. You answer every one of these, even in Full auto. "Allowed in this chat" lists the programs under the Computer row, each with Revoke; Jenny asks again the next time it needs one. Some programs are never allowed, such as Jenny itself, password managers and most Windows system tools. Web browsers and terminals are view only: Jenny can see them but cannot click or type.

You stay in charge. While Jenny has the mouse, a thin frame goes round your screen and a small pill shows what it is doing. You can drag the pill, and it remembers its place on each screen. Neither shows up in what Jenny sees. Touch the mouse or keyboard and Jenny pauses at once. It waits for you, up to 30 minutes, until you choose Resume on the pill or in the chat; it then takes a fresh look before it acts. Stop on the pill or in the chat, or the keys Ctrl+Alt+Shift+F12 pressed anywhere, ends the turn.

In the chat, a step that did not work shows a warning dot and a short reason, and a line under the answer says how many steps did not work. Check the result in the program before you rely on it.

Settings > Tools > Computer also holds Your programs: programs with no Start menu entry, such as your own builds. Add program picks the file, and you can rename or Remove an entry. Jenny can start only these and Start menu programs, and still asks first.

Limits: Windows only. A program that runs as administrator is refused. The Stop key cannot be changed. A program with no pause keeps running while the model thinks. Password fields are always refused. A turn has at most 60 computer steps. JENNY_ENABLE_TOOLS_COMPUTER_USE=0 removes the row.

## The Live tab

The Live tab is in the chat's right-hand panel, beside Browser, and runs your project's own program and shows its window. It needs Windows and a chat in a project. The first time, you tell Jenny how to start the program: an optional build step, the program, its arguments, a working folder and any environment values. Choose Review and confirm, then Confirm. Jenny runs only the command you confirmed, and asks you to confirm again if the project folder moves.

The bar has Run or Stop, Restart and Show window, then Wide to widen the panel and a More menu with Send behind Jenny and Edit run command. The panel is for watching: clicking the picture brings the real window forward, and nothing you do in the panel reaches the program. A line under the picture says what state it is in. If a build fails, you see the end of its output and Send the error to Jenny, which puts the error in your message box. Nothing is sent until you send it. If Jenny's screen helper is missing, the tab says so and says to reinstall Jenny.

"Restart after Jenny's changes" is on by default. It restarts the program when Jenny changes your code, which ends a game in progress. With a model that can see images, Jenny can also take a picture of the program's window (run_view_look) and restart it itself (run_view_restart) with the command you confirmed, without asking again. JENNY_ENABLE_LIVE_RUN_VIEW=0 removes the tab.

## Where the main switches are

Settings > Tools holds, in order: the workspace folder line, Permissions (safety mode, default run mode, Pause Auto when you are away, auto-approval limit), Approval rules, Files and documents (File tools, Rich file reading, Image and PDF page reads, the PDF reading add-on), Web (Web tools and search provider), Computer (Let chats use the computer, the Stop key and Your programs), and Code and commands (Terminal commands, Run commands in a sandbox, Python execution, Code intelligence, Worktree tools, Delegated research).

### The PDF reading add-on

Reading text, tables and scanned pages of a PDF needs the optional PDF reading add-on (PyMuPDF, licensed AGPL-3.0, not bundled). Settings > Tools > PDF reading add-on > Set up lets you read the licence note and choose Accept and install; it downloads a pinned file from pypi.org and checks its fingerprint. Viewing and editing PDFs in the Workspace works without it.

## Kill switches

Many features can be turned off for a launch with an environment variable of the form JENNY_ENABLE_KEY=0 (KEY is the feature name). Examples: JENNY_ENABLE_MEMORY_V2=0 removes the memory tool, JENNY_ENABLE_TOOLS_HOME=0 removes the home tool, JENNY_ENABLE_TOOLS_IMAGE_GENERATE=0 removes image generation, JENNY_ENABLE_TOOLS_PREVIEW_TEST=0 and JENNY_ENABLE_TOOLS_WORKSPACE_PRESENT=0 remove the preview tools, JENNY_ENABLE_TOOLS_TASK_BOARD_ENABLED=0 and JENNY_ENABLE_TOOLS_PROJECT_NOTES_ENABLED=0 remove the task board and project notes. Set the variable before starting Jenny. Desktop secrets and API keys are never read from environment variables.

## The Docker command sandbox

Settings > Tools > Run commands in a sandbox runs foreground commands in a disposable Linux Docker worker with no network. It needs Docker running with a Linux engine; Jenny never installs or changes Docker.

- Files a command creates or edits are discarded after each run. Use Jenny's file tools for lasting changes.
- Commands are Linux /bin/sh commands, up to 120 seconds, with combined output capped at 256 KiB. The workspace copy is limited (64 MiB, 2,048 entries).
- Not available in the sandbox: temporary scripts, Python execution, background jobs, Git subprocess tools, test runners, code intelligence, third-party MCP tools and delegation.
- States include Ready, Busy, Unavailable (start Docker, then Retry) and Recovery required (cleanup could not be proven; new commands stay blocked until Retry succeeds). A command never falls back to running on your computer.

## On a team host

A turn in a team project runs on the team's host, which offers far fewer tools than your own Jenny: reading, searching, writing and editing files inside that project's team files (when the host has turned project files on), and jenny_help. Writes and edits ask a member who is viewing the conversation, unless a project admin set a rule. Everything else on this page is not offered there, by design: no artifacts, review findings, test summaries or suggested changes, no commands, terminal, Git, Python, web, memory, helpers or MCP tools. See team.
