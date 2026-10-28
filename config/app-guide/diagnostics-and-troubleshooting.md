# Diagnostics and troubleshooting

## The health indicator

The small indicator next to the Jenny wordmark shows engine and model state: Ready, Starting, Loading model, Downloading model, Retrying, Offline, Model failed, Error, and similar. Click it for a popover with the current status, runtime facts, recent errors with their codes and times, and quick actions: Retry, Models, Logs, Diagnostics, Clear errors, and Restart llama-server or Restart NInfer when that engine is active. It can also show a GPU memory note when graphics memory runs low while a local engine generates; the note only observes and never changes anything for you, and Hide for 10 minutes silences it. Show load in title bar adds a small GPU and VRAM readout.

## The Diagnostics page

Diagnostics (Ctrl+4) has three tabs.

- Overview: Runtime and Performance facts on top (engine and memory, setup, tools, skills, memory and note taking, sandbox state, tokens), and a Needs attention list of issues below. Issues are grouped by area (Local engine, Models, Tools, Workspace, Memory, App) with a plain explanation and a Details view. The divider between facts and issues can be dragged or moved with the arrow keys. Issues from the previous launch are labeled as such.
- Activity: the records Jenny logged, oldest to newest, with time, level, source, event and message. Search and filters narrow them; Show records for an issue jumps here. Correlation ids (session, stream, turn, trace) tie a record to its chat.
- Runs: a board of current and recent work with the controls that apply. A chat that is waiting on you is also visible in Needs you in the chats panel.

Logs live under the logs folder in Jenny's data folder, and diagnostic dumps under diagnostics. Memory text never goes into logs, and jenny_status redacts paths and tokens. Review a dump before attaching it to a bug report.

## Asking Jenny for status

The jenny_status tool returns a read-only snapshot across backend, runtime, logs, cost, budgets and automations; ask Jenny "what is the system's health" and it can call it. It is not for questions about source code. The Jenny chat uses it too.

## Common problems

- Engine not loaded or model list empty: the engine is not running or the model is not pulled. Start Ollama (ollama list in a terminal shows what exists), or open Settings > Models and use Re-check. If you changed the engine host or port, use Settings > Profile, data and updates > Run setup again and validate your endpoint.
- Model failed in the title bar: it does not fit, or llama-server could not start it (an unsupported GGUF, or a missing projector for a vision model). Open Settings > Models, check the fit estimate, pick a smaller quantization, or press Restart llama-server in Tune after changing the context window.
- Model load race, "Model is starting": the first message after a cold start waits 10 to 60 seconds while weights load. Longer than a minute every time is a performance problem; check VRAM and the engine.
- Sidecar not ready, "Backend stopped": the Python sidecar is still starting or crashed. Wait about 10 seconds; if it persists, restart the app and attach a diagnostics dump to a report.
- Codex CLI sign-in: the row in Settings > Models > Cloud models says the codex command is not found or signed out. Run codex login in a terminal, then Check again. Jenny never reads that login.
- ChatGPT sign-in will not run: Force local inference may be on. Turn it off in Offline.
- Context too large: every turn errors on a long chat. Start a new chat for a new topic, raise the context window in the Tune drawer, or use a model with a larger window. The context meter shows how full the window is.
- Turn stopped on a budget: the reply ends with a Resume this turn button (or Enter from an empty composer). It is a safety stop, not an error.
- "Turn stopped: session locked": offline lockdown blocks a remote engine or a network tool for that session. Choose a verified local model.
- An approval card never appeared, or the turn hung after you answered: approvals wait about ten minutes. Press Cancel and resend.
- Auto stopped while you were away: Settings > Tools > Pause Auto when you are away pauses on inactivity. Turn it off for unattended work, then resume the stopped turn.
- A tool is blocked: usually no workspace folder (Settings > Tools folder line), or the tool is off in Settings or for this chat.
- PDF reading fails with "PDF reading add-on not installed": install the optional add-on from Settings > Tools > PDF reading add-on. The Workspace PDF viewer works without it.
- A sandbox command succeeded but its file is missing: command files are discarded. Ask Jenny to use file tools for lasting changes.
- The spinner never clears: switch to another chat and back; the turn rehydrates from disk.
- Update check fails: no network, or GitHub is unreachable. Updates are checked only when you ask (Settings > Profile, data and updates > About and Updates > Check for Updates). Download and restart are separate explicit actions.
- Some labels in English or layout not mirrored: choose a language in Settings > Appearance and restart.
- Crash on startup: look in the diagnostics folder for the latest dump. Corrupt JSON files are renamed with a .corrupt suffix and re-created.

## Error codes

Messages may carry a code of the form CMP-DOMAIN-NNNN (a domain name and a four-digit number). The ones you are most likely to see: CMP-DATA-0006 (wrong passphrase or archive authentication failed), CMP-DATA-0007 (archive corrupt or incomplete), CMP-DATA-0009 (the profile already has chats, so use the per-chat importer), CMP-DATA-0010 (uninstall cleanup incomplete), CMP-TOOL-0047 (PDF add-on missing), CMP-MODE-* (backend not ready) and CMP-APPROVAL-* (approval expired or lost).

## Where your data lives, archive and restore

Windows %APPDATA%\jenny, macOS ~/Library/Application Support/jenny, Linux ~/.config/jenny. Runtime data sits under ~/.companion.

Settings > Profile, data and updates > Data and removal creates a verified archive without removing anything. By default it is encrypted with a passphrase of 12 to 1024 characters that Jenny never stores; a readable plain archive requires an explicit choice. It includes chats, preferences, personality, memory, reminders and calendar data; it excludes secrets, logs, caches, shared models and ordinary project files. The default folder is Documents/Jenny Archives. A full restore is offered only into a fresh profile; for a profile that already has chats, import individual sessions instead. Jenny never removes live data unless it can read back and verify the archive first.

## Uninstall

Three choices in the uninstall assistant: Keep a recoverable archive (recommended), Remove app only, and Permanently remove everything, which requires typing REMOVE JENNY and removes only known Jenny-owned paths. Shared Ollama models, GGUF files, external knowledge folders and ordinary project files are never removed. On Windows removal also opens Installed apps; on Linux run sudo apt remove jenny for the deb or delete the AppImage. Dragging the macOS app to Trash is app-only.
