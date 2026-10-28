# What Jenny is

Jenny is a lean, local-first harness for a single local model. It is built for coding, data visualizations and bounded tool calls, with a light companion shell around that core: a persistent, customizable personality that is kept deliberately thin. Jenny shows every step it takes, asks before it acts, and puts a real editor beside the chat so you stay the one who understands the work.

Jenny is software, not a living being. A custom name or voice never overrides that, or any permission and safety rule.

## What it is good at

- Coding workflows: reading, searching, editing and testing files in a workspace folder you choose.
- Visualizations: diagrams, charts and HTML pages that open in an artifact panel next to the chat.
- Bounded tool calls: file tools, Git views, web search, commands and more, each inside an approval boundary you control.
- A light companion layer: a name, a voice, notes about you, and memory that carries across chats.

## The main areas

The title bar has four tabs, plus a Settings gear on the right. Ctrl+1 to Ctrl+5 jump between them in this order.

- Home (Ctrl+1): the landing page. It holds a calendar, reminders, a scratchpad and a list of open follow-ups, and a line for asking Jenny something quickly. Setup tiles for first-run steps appear here until setup is complete.
- Chat (Ctrl+2): conversations. A chats panel on the left lists your chats, the timeline and composer sit in the middle, and an optional session summary sits on the right.
- Workspace (Ctrl+3): the built-in IDE with a file explorer, an editor, terminals, Git views, a PDF and Word viewer, and Jenny docked beside the editor.
- Diagnostics (Ctrl+4): Overview, Activity and Runs tabs for engine health, logs and background work.
- Settings (Ctrl+5, the gear icon): every preference, grouped into sections. Memory has no top-level tab; it lives in Settings, in the Context and memory group.

Next to the Jenny wordmark, a small health indicator shows whether the engine and model are ready. Click it for details and quick actions.

## What runs locally

With a local model, inference and your conversation history stay on your computer. Jenny supports Ollama, a managed llama-server, vLLM, and any OpenAI-compatible server you point it at. A local model needs no cloud account and no API key.

- Conversations are stored as local JSON files in Jenny's data folder. Credentials use the operating system's protected storage (Electron safeStorage); the conversation files themselves are not encrypted by it, so protect the profile with your operating system and use the encrypted archive option when you export.
- There is no telemetry or analytics. Crash reporting is opt-in and off by default.

## What can leave the machine

Only things you turn on or start yourself:

- A remote model route: Settings > Models > Cloud models offers Sign in with ChatGPT and a Codex CLI route. Request content then goes to that provider.
- Tools you enable and approve that use the network: web search, fetching pages, and remote MCP servers.
- Model downloads you start, and an update check you trigger from Settings. Jenny also does a throttled refresh of its bundled model-recommendation catalog, which is a plain file download with no user data attached.

Settings > Offline has Force local inference. When it is on, model requests are confined to the selected local engine, so the ChatGPT and Codex CLI routes do not run. It governs inference only: network tools, extensions, authentication, updates and downloads are separate.

## Where your data lives

- Windows: %APPDATA%\jenny
- macOS: ~/Library/Application Support/jenny
- Linux: ~/.config/jenny

Inside are the session store (your chats), the memory database, the personality files, MCP configuration, logs and diagnostic dumps. Settings > Profile, data and updates > Data and removal can create a verified archive.

## Platforms

Windows is the supported desktop platform. Experimental Linux x64 AppImage and deb packages exist, and an experimental Apple Silicon build that has not been tested on real hardware. Translations are model-authored, and newer wording can fall back to English.

## Related guide pages

- setup-and-engines: first run, models and engines.
- chats-and-projects: chats, projects and the session summary.
- run-modes-and-approvals: how much Jenny asks before acting.
- jenny-chat: the pinned Jenny chat that can answer questions about the app.
