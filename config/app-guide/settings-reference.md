# Settings reference

Open Settings with the gear icon in the title bar or Ctrl+5. A search box at the top of the left rail finds a setting by name or keyword and flashes the row. In a narrow window the rail becomes a section picker above the page. The page remembers the section you last used.

Most settings save as you change them. A row that differs from its default shows a Modified tag and a Revert button. A failed save shows its reason in the row. Some rows are dependent: while the parent switch is off (for example File tools for Rich file reading) they are dimmed and keep their value.

## Sections in order

The rail has six groups.

### Model and tools

- Readiness: a status board with a count badge. It tells you whether chat has a model, whether first-run setup is complete, whether file tools have a folder, whether Force local inference is healthy, and whether the memory manager is ready, with buttons that jump to the page that fixes each.
- Models: the model library, GGUF folders, the image engine, the NInfer card, Troubleshooting for Ollama, Load model at startup, and Cloud models (Sign in with ChatGPT, Codex CLI, Show ChatGPT models in Composer). See setup-and-engines.
- Offline: Force local inference. It confines model requests to the selected local engine and shows whether the local model is ready. It does not block network tools, extensions, updates or downloads.
- Tools: the workspace folder line (with a Choose button), then the groups below.
  - Permissions: Safety mode (Normal, Strict, Paranoid), Default run mode, Pause Auto when you are away, Auto-approval limit.
  - Approval rules: what Always allow has saved, with Remove.
  - Files and documents: File tools, Rich file reading, Image and PDF page reads, PDF reading add-on.
  - Web: Web tools and the search provider.
  - Code and commands: Terminal commands, Run commands in a sandbox, Python execution, Code intelligence, Worktree tools, Delegated research.

### Work

- Projects: your projects, with New project from folder, Open as Workspace, Change folder, Rename, Reveal folder and Delete. See chats-and-projects.
- Usage: tokens, speed and outcomes for retained turns, kept on this device. It reads "no recorded turns" until you have chatted.

### Context and memory

- Context: What is sent: History scope, Personality and notes, Approved memories. Summaries: Automatic summarization and an optional Summary guidance box that steers what a summary emphasizes.
- Memory: the memory page and the four How Jenny remembers switches. See memory-and-personality.
- Personality: Name, Voice, Personality note, About you.

### App

- Appearance: Theme and palette (Theme bundle, Palette), Typography and text (Typography, Text size), Chat layout (Chat width, Transcript view, Open the artifact panel when an artifact arrives), Background (Effect), Language and a 24-hour clock, Check spelling as you type, Show performance in the session rail, GPU memory warnings, and further rows such as Overall app zoom, Startup animation, Holographic typing border and Show machine load in the title bar. Reset appearance restores the defaults.
- Editor: Font size, Default tab size, Render whitespace, Column rulers, Word wrap, Minimap, Line numbers, Format on save, Trim trailing whitespace on save, Insert final newline on save, Auto-save files.
- Home: Quick-capture mode (append a timestamped line or replace the note) and the Ctrl+Shift+Space quick-capture shortcut while Jenny is focused. The Jenny chat row can be shown or hidden here.
- Notifications: Desktop notifications, Only when Jenny is in the background, Play sound, Show the first line of the reply, and which events notify: a reply is ready, a run fails, Jenny needs permission, Jenny asks a question or a plan is ready, a reminder is due. Your own Stop never notifies.

### System

- Extensions: skill folders and MCP connections. See skills-and-mcp.
- Profile, data and updates: Local profile (an optional profile name stored on this device; Jenny runs without an account), Setup (Run setup again), Data and removal (create a verified archive, restore, Uninstall Jenny), About and Updates (version, Check for Updates, and on Windows the Command-line tool row with Add to PATH), and Remove Jenny.

### Developer

- Limits and budgets: how long and how much Jenny may do. Groups are One reply, Timeouts, Helpers, Running at once, and a closed "Rarely needed" fold. Each limit may have separate Local and Cloud values, a revert control and quick-pick values. "Reset this page" restores the defaults in two steps. Most people never need this page.

## The settings people ask about most

- Which model is running, or switch it: the model pill in the composer, or Use on a row of Settings > Models.
- How much Jenny asks before acting: Settings > Tools > Permissions, or the run-mode chip for one chat.
- Turn on terminal commands, web search or Python: Settings > Tools > Code and commands or Web.
- Why file tools do nothing: the workspace folder line at the top of Settings > Tools.
- Make memory more or less active: Settings > Memory > How Jenny remembers.
- Keep everything on this computer: Settings > Offline > Force local inference.
- Make the text larger: Settings > Appearance > Text size, or Ctrl + and Ctrl - to zoom the window.
- Run first-run setup again: Settings > Profile, data and updates > Setup > Run setup again.
- Back up or remove your data: Settings > Profile, data and updates > Data and removal.

## Language and time

Settings > Appearance offers many interface languages and an optional 24-hour clock. Language and direction changes need a restart; the 24-hour setting updates times at once. Translations are model-authored, so some wording may stay in English. Arabic mirrors the layout, while code and paths stay left to right.
