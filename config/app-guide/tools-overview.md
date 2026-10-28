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
- Python: python_execute runs Python with the same file access as Jenny. Off by default, every run asks, resource-bounded but not a filesystem or network sandbox.
- Artifacts and visualizations: create_artifact makes scratch documents (Markdown, text, JSON, CSV, Mermaid) and HTML pages that preview in a network-isolated frame in the artifact panel. Inert documents need no approval; scripts do. mermaid_generate draws a Mermaid diagram inline in the chat and saves a .mmd artifact.
- Preview and checks: workspace_present asks the IDE to show a preview, the File Map or a change. preview_test loads one HTML file in a hidden sandbox and reports render state and console errors. verify runs one of your own saved test configurations.
- Image generation: image_generate draws one PNG from a prompt using your local image engine and saved model set. It needs the image engine installed in Settings > Models. Nothing leaves the machine.
- Web: web_search and fetch_url. Off by default and read-only, with protections against private-network addresses. Settings > Tools > Web has the provider choice (DuckDuckGo needs no setup; Brave, Google Programmable Search, Serper, Tavily and a self-hosted SearXNG are options).
- Knowledge: knowledge_search, knowledge_view and knowledge_exec read documents in folders you register under Settings > Tools > Knowledge folders. Read-only. Optional Search by meaning uses a local embedding model you pick.
- Memory: the memory tool remembers, updates, forgets and recalls durable notes. See memory-and-personality. Earlier chats can be browsed with conversations_recent, conversation_open and conversations_search.
- Home and tasks: home reads and edits the calendar and reminders and reads the scratchpad; task_board adds, updates and completes tasks in the Home follow-ups list. Writes are automatic; deletes need a confirmation round-trip. Reminders fire only while Jenny is running.
- Project notes: project_notes reads and edits the one notes page per project, with an undo control.
- To-dos: todo_write and todo_read keep an in-session checklist for multi-step work.
- Helpers: delegate hands one to three read-only research tasks to helper tasks and returns their answers. It adds model cost and time.
- Worktrees and code intelligence: worktree_list, worktree_create, worktree_select and worktree_delete manage isolated Git worktrees; lsp gives read-only diagnostics, symbols and definitions from language servers.
- Skills: load_skill reads a skill on demand. See skills-and-mcp.
- Questions and plans: ask_user asks you structured questions; exit_plan_mode submits a plan for review.
- Proposals: propose_git_action, propose_command and propose_session hand a decision to you instead of acting. propose_session offers a new linked chat.
- Sessions and messaging: sessions_list, session_status, session_transcript, session_stop and session_message let a chat see other chats, check their status, read their transcripts, message them and stop them. See linked-chats-and-messaging and jenny-chat.
- Diagnostics: jenny_status returns a read-only snapshot of backend, runtime, logs and budgets. connections_list reports configured connections. jenny_help searches this guide.
- MCP: tools from approved MCP servers appear as mcp__server__tool. See skills-and-mcp.

## Per-chat tool switches

The tools chip in the composer opens "Tools for this chat". It shows the chat's tool families as switches (Files, Git, Terminal, Python, Web, Knowledge, Images, Artifacts and diagrams, Preview and checks, Home and tasks, Helpers, Code intelligence). A row can say Off in Settings (turn it on in Settings first), Needs a project, Offline for this chat, or Some actions ask first. Always on: questions, to-dos, plan, status and skills. Reset to defaults restores the settings values, All tools shows each tool, and Full settings opens Settings > Tools. Per-chat changes apply to your next message.

## Where the main switches are

Settings > Tools holds, in order: the workspace folder line, Permissions (safety mode, default run mode, Pause Auto when you are away, auto-approval limit), Approval rules, Files and documents (File tools, Rich file reading, Image and PDF page reads, the PDF reading add-on), Web (Web tools and search provider), and Code and commands (Terminal commands, Run commands in a sandbox, Python execution, Code intelligence, Worktree tools, Delegated research).

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
