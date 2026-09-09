---
kind: docs-index
last_reviewed: 2026-09-09
status: active
---

# Frequently asked questions

Answers to the questions that come up most often. For symptom-to-fix
mappings see [TROUBLESHOOTING.md](TROUBLESHOOTING.md); the developer-facing
error code registry lives at
[docs/operations/error-codes.md](../operations/error-codes.md).

## Installing and updating

### Why does Windows warn me when I run the installer?

The installer is not code-signed (a deliberate cost decision for a free
hobby project), so SmartScreen shows *"Windows protected your PC"* on first
run. Click **More info → Run anyway**. Integrity is still verifiable: each
release publishes SHA-256 hashes of its assets in `RELEASE_NOTES.md`, and
update downloads are validated against the release's SHA512 metadata over
HTTPS before you explicitly install them.

### How do updates work?

Jenny never checks for updates on its own. Open **Settings → About &
Updates → Check for Updates**. This contacts GitHub and requires internet access;
it checks published stable releases, not source commits or bare tags. Local
model inference can keep working offline. Force local inference does not block
update traffic. Checks send no chat history, credentials, or per-install staging
identifier; GitHub still receives ordinary connection information such as your IP.

Review the notes, choose **Download Update**, then explicitly choose **Restart
and Install** when ready. Ordinary quit does not install an update. Settings
reopens a download already running or ready to install. Errors offer the relevant
retry action. A check after relaunch can reuse the library's verified download
cache; offline cached installation is not promised.

Development installs, unsigned macOS and Linux .deb installs can check versions
and open the fixed [releases page](https://github.com/SaltyPretz3l/jenny/releases)
for manual installation. The UI names releases that have no package for your
platform. AppImage self-updates require a writable file location. For a fully
disconnected machine, transfer an installer obtained on another machine.

### Can I run Jenny on macOS or Linux?

Windows is the supported desktop platform. The published 1.0.0 release contains
Windows assets only. Experimental Linux x64 AppImage/deb and Apple Silicon
dmg/zip builds are candidates for 1.1.0; check the actual
[release assets](https://github.com/SaltyPretz3l/jenny/releases) before downloading.

Linux targets glibc 2.35 or newer (Ubuntu 22.04+, with compatible distributions
as candidates). Installed-format, upgrade and bare-metal checks remain separate
from CI/WSL evidence. The managed Python tool and one-click Ollama install have
Windows/Linux implementations; managed Python is unavailable on macOS.
Mac signing and hardware qualification remain outstanding; use source setup
until a release supplies a qualified artifact.

### What is new in the 1.1 interface?

Settings > Appearance selects one of 19 interface languages and an optional
24-hour clock. Restart for language/direction changes; the 24-hour preference
refreshes displayed times. Arabic mirrors the shell while code and paths remain
left-to-right. The translations are model-authored; missing/new copy falls back
to English. Report wording problems with the language and screen name.

The chat sidebar supports multiselect, bulk archive/restore, and confirmed
deletion with Undo. Waiting indicators distinguish approvals, plan review and
questions that need your input. See the [unreleased changelog](../../RELEASE_NOTES.md).

### Does Auto run mean Jenny can work unsupervised?

No. Auto asks for confirmation once per session and displays an Auto indicator.
The unattended guard defaults to 10 minutes of system inactivity before the next
side-effecting call needs approval; user-pre-granted calls remain an exception.
An unanswered approval ends the turn after the existing 10-minute timeout.
Settings > Tools controls the guard (0 disables it) and safety mode. Review
results and supervise tool use.

### Which Docker workflow should I choose?

Use the [browser quick start](../operations/HOSTED_QUICKSTART.md) for a
persistent browser host, or the
[desktop command sandbox](../operations/DESKTOP_COMMAND_SANDBOX.md) to keep
Electron and isolate foreground commands. Docker is optional for ordinary
desktop chat. In either sandbox, command-written files are discarded; typed
file tools make durable edits. Capabilities and qualification differ by mode.

### Can I use Remote Control from this public checkout?

The core is integrated, but the current export excludes its signed plugin and
relay/portal distribution. Do not run private signing instructions or assume
that the Settings entry means it is installed. See
[Remote Control availability](../operations/REMOTE_CONTROL.md).

### How do I uninstall Jenny without losing my chats?

Open **Settings → Data & Privacy** and choose **Uninstall Jenny**, then
**Remove app only**. Jenny drains the running app and keeps the profile for
automatic reuse after reinstall. The silent Windows uninstall and dragging
the macOS app to Trash also preserve data. On Linux, run
`sudo apt remove jenny` for the `.deb` or delete the AppImage file; Jenny
keeps `~/.config/jenny`, `~/.companion`, and
`~/.local/share/jenny/ollama`. Source installs use `npm run uninstall` from
the project folder.

For an independent copy, choose **Keep a recoverable archive** instead.
Jenny does not remove live data unless it can read back and verify the
completed archive. A full archive restore is offered only into a fresh
profile; individual chats can still be brought in with the session importer.

### Does permanent removal delete Ollama models or project files?

No. Shared Ollama models, GGUF files in folders you nominated, system-wide
runtimes, external knowledge folders, unknown `.companion` children, and
ordinary files outside a workspace `.jenny` directory are retained.
Workspace `.jenny` removal is a separate option and is off by default. See
[Uninstall and Data Recovery](../operations/UNINSTALL_AND_DATA_RECOVERY.md).

## Privacy and data

### Is my data sent anywhere?

With a local model, inference and desktop conversation storage stay on your
computer. A configured remote model or approved network tool sends the data
needed for that request to its endpoint. Browser hosting keeps canonical data
on the host you configure. There is no telemetry or analytics; crash reporting
is **opt-in and off by default**. Other network activity includes: model downloads
you start, tools you enable and approve (web search, web browsing, remote
MCP servers), an update check you trigger from Settings, and a throttled
refresh of the bundled model-recommendation catalog (a plain file download
with no user data attached).

### Does Jenny work offline?

Yes, once a model is pulled. The local engines run without a network. Tools
that need the network (web search, web browsing, remote MCP) fail when it is
unavailable, and the core chat loop is unaffected. **Settings → Offline**
can force local inference so a cloud engine, if you ever configure one, is
never used.

### Where does Jenny store my data?

Per-OS data directory:

- **Windows:** `%APPDATA%\jenny\`
- **macOS:** `~/Library/Application Support/jenny/`
- **Linux:** `~/.config/jenny/`

Inside it: the session store (your conversations), the memory database, the
personality workspace under `personality/default-workspace/`, MCP
configuration in `mcp-servers.json`, process logs under `logs/`, and
diagnostic dumps under `diagnostics/`. Back the whole folder up if you care
about transcript history, or use **Settings → Data & Privacy** to create a
verified archive.

### What is the difference between memory and long-term notes?

**Long-term notes** (Settings → Memory) is a single text you write: durable
facts and preferences sent with every message. **Approved memories** are
records Jenny proposes after a turn; nothing becomes durable until you
choose Remember or Approve, and you can edit or delete each one in the same
section.

## Models and engines

### Why doesn't Jenny ask for an API key?

Jenny is local-first. The engines that ship are [Ollama](https://ollama.com/),
a managed `llama-server`, and any OpenAI-compatible local server you point
her at (vLLM, LM Studio, a hand-run llama.cpp). None needs a hosted key.
Cloud engines are not configured out of the box; the ChatGPT subscription
connector requires a separately supplied signed plugin; availability must be confirmed in the release notes.

### Which model should I use?

The setup checklist scans your hardware and recommends the strongest model
that fits your GPU and RAM, with download and disk estimates. The default is
**Ornith 1.5 9B** (`hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M`, about
5.6 GB): a text-only coding model that runs comfortably in 8 GB of VRAM.
With more VRAM the library offers the Q8_0 build or the Gemma 4 tiers;
Gemma 4 E4B is the pick when you need image input. Switch any time from the
model picker next to the composer, or with **Use** on a row of **Settings →
Model library**. Jenny's voice is model-bound: if the persona suddenly feels different, check which
model is active before editing personality files.

### Can I use a GGUF file I already have?

Yes. **Settings → Model library** lists what Ollama has pulled and the GGUF
files in folders you add (**Add folder…**). Models found that way run on the
managed `llama-server`. Jenny estimates fit from the file's real size and
parameter count and tells you what will fit in your VRAM before loading.

### What is the difference between Ollama and llama-server?

Both run models locally. Ollama is the default and handles pulling models.
The managed `llama-server` is Jenny's own llama.cpp process; it can run
GGUF files directly, lets you edit the context window per model (with a
restart confirmation), and speeds up verified models with speculative
decoding. Choose the engine per model in the library's tune drawer. Details
in [llama-server acceleration](../operations/LLAMA_SERVER_ACCELERATION.md).

### Can Jenny see images?

Yes, with a vision model. Attach or paste an image in the composer and Jenny
sends it as a real vision turn on Ollama and on the managed `llama-server`.
If the active model cannot see, the composer says so before you send:
remove the image or switch to a vision model such as Gemma 4 E4B.

### Why is the first message slow?

The model is loaded into memory on the first turn after the engine starts.
Later turns reuse the loaded weights and start much faster. If every turn
is slow, see [TROUBLESHOOTING.md ` First visible token is slow](TROUBLESHOOTING.md#first-visible-token-is-slow).

## Using Jenny

### What do Ask, Auto, and Plan mean?

The **Run mode** control next to the composer. **Ask**: Jenny asks before
every side-effecting tool call. **Auto**: tools run without asking, except
destructive shell commands, which always stop for approval. **Plan**:
read-only planning; Jenny proposes a plan you approve before anything is
written. Plan mode works best with larger models.

### What does "Always allow" cover?

It saves a rule for that tool **and** the path or target the call named,
not for the tool in general. Every saved rule is listed under **Settings →
Tools → Approval rules** with a Remove action.

### Why is a tool blocked?

Most often because no workspace root is set. File, shell, and git tools
stay off until you choose a folder under **Settings → Tools → Workspace
root** (or the first-run checklist). Network tools and file changes are also
off until you enable them under **Settings → Tools → Optional capabilities**.

### How do I customize Jenny's personality?

**Settings → Personality** has the name, a voice template, a personality
note, and an "About you" box; one Save covers all of them. The walkthrough
is [docs/tutorials/03-personality-customization.md](../tutorials/03-personality-customization.md).
The files behind it (`PERSONALITY.md`, `USER.md`, `MEMORY.md`) live in the
personality workspace and can be edited directly with **Open folder**.

### How do I add a new MCP server?

**Settings → Plugins & Extensions → MCP connections → Add connection**, then
test and approve it. The walkthrough is
[docs/tutorials/02-adding-mcp-server.md](../tutorials/02-adding-mcp-server.md).

### What are skills, and how do I run one?

A skill is a `SKILL.md` file: a named block of instructions Jenny can attach
to a turn. Type `/` in the composer to pick one; it attaches as a chip on
that message. Each skill can be disabled under **Settings → Plugins &
Extensions → Skills**. Authoring is covered in [docs/SKILLS.md](../SKILLS.md).

### Are there plugins?

The plugin host ships in 1.0, but no plugins are bundled. Install a
`.jenny-plugin` package from **Settings → Plugins & Extensions → Install
plugin** (or drop the file there). Unsigned plugins are labelled and run in
the developer profile; privileged plugin kinds are refused without a
signature. First-party plugins are released separately.

### Where is the IDE?

The **Workspace** view: a file explorer, a Monaco editor with a git gutter,
a terminal, and Jenny docked beside the editor. It works on the workspace
root you chose.

### How do I run setup again?

**Settings → Local Profile & Setup → Run setup again**. It reopens the
first-run checklist without deleting conversations or private data.

## Reporting problems

### How do I report a bug or request a feature?

Open an issue at [github.com/SaltyPretz3l/jenny](https://github.com/SaltyPretz3l/jenny).
Include your OS, whether you used the installer or a source install, the
engine and model (Ollama version or `llama-server`), and reproduction
steps. Diagnostic dumps under `<userData>/diagnostics/` help; review them
before attaching. Security findings follow the disclosure flow in
[SECURITY.md](../../SECURITY.md).
