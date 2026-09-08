# Jenny

Jenny is a desktop AI assistant that runs on your computer. She can help you write code, edit files, run commands, and make charts and diagrams. You choose the model, the project folder, and the permissions for her tools. You can also change her name and personality.

With a local model, Jenny processes your prompts on your computer and saves conversations there. You don't need an account or API key for local chat. [Ollama](https://ollama.com/) runs the model; [vLLM](https://docs.vllm.ai/) is another supported option.

Jenny is built around smaller models, roughly 9B–35B parameters. How well she handles a task depends on the model you choose and the hardware you have. Expect mistakes, especially on complicated tasks, and review code and commands before relying on them.

## Demo

![Jenny streaming a reply with real tool calls](docs/media/demo-streaming-tools.gif)

*Streaming with tool calls: the thinking row, a streamed reply, `list_dir` and `read_file` running for real, then the summary.*

![A code change that waits for approval, then shows its diff](docs/media/demo-assistant-edit.gif)

*Changes wait for you: `edit_file` stops at the approval block, then the diff card shows exactly what changed.*

![Calendar and reminders from chat, ending on the Home agenda](docs/media/demo-calendar-week.gif)

*Home from chat: add an event and a reminder, get the week summarized, and see it on the Home agenda.*

![The built-in Workspace IDE with the terminal and chat dock](docs/media/demo-ide-tour.gif)

*The Workspace IDE: explorer, Monaco with the git gutter, the terminal running the project's tests, and Jenny docked beside the editor.*

![Palettes and background effects switched live](docs/media/demo-palette-reel.gif)

*Built-in palettes and animated background effects, switched live.*

The clips are recorded from the real app driving a scripted replay engine (no live model); the history, calendar, and titlebar figures in frame are seeded for the recording. MP4 versions sit next to the GIFs in `docs/media/`; see `docs/media/README.md` for how they are made.

## Install on Windows

Download **[Jenny-Setup-x64.exe](https://github.com/SaltyPretz3l/jenny/releases/latest/download/Jenny-Setup-x64.exe)** and run it. There are no wizard pages to work through. The installer creates a **Jenny** desktop shortcut.

**Windows may show a SmartScreen warning.** Jenny's installer isn't code-signed. If you see *"Windows protected your PC"*:

1. Click **More info**.
2. Click **Run anyway**.

You can check a download against the SHA-256 file hashes in [RELEASE_NOTES.md](RELEASE_NOTES.md). Automatic updates are checked against the release's SHA512 manifest, downloaded over HTTPS, before installation.

### First launch

Jenny's setup walks you through installing Ollama, downloading a model, choosing a project folder, and setting up your assistant. It checks the Ollama download against its SHA-256 hash and recommends a model based on your hardware. Allow time for the model download: it can be several gigabytes.

- **Project folder:** choose the folder Jenny will work in, called the *workspace root* in the app. Her tools stay blocked until you choose one.
- **Model:** setup downloads a model for you and shows its progress. You can choose another model already installed in Ollama from the setup tile or Settings.
- **Personality:** choose balanced, concise, creative, or mentor, or write your own instructions. The default name is Jenny; you can change it.
- **Other setup steps:** check the connection to your model and review the available skills.

The setup tiles disappear when you're done. You can run setup again from **Settings → Account**.

### macOS: available, but untested

Releases also include `Jenny-arm64.dmg` for Apple Silicon Macs. **The macOS build is produced automatically and has never been run by the maintainer. Windows is the supported platform.**

- The app is unsigned, so Gatekeeper blocks it at first. Right-click **Jenny.app** → **Open** → **Open**, or clear the quarantine flag with `xattr -dr com.apple.quarantine "/Applications/Jenny.app"`.
- **Automatic updates are disabled on macOS** because they require a signed and notarized build. Download the new dmg from the [releases page](https://github.com/SaltyPretz3l/jenny/releases) to update.
- Install Ollama from [ollama.com/download/mac](https://ollama.com/download/mac). Jenny's setup links there and checks again after you install it.

### Linux (experimental)

Linux packages start with the next 1.0.x release; 1.0.0 has no Linux
package, so run from source until then (see **Running from source**
below). When available, download **`Jenny-x86_64.AppImage`** or
**`Jenny-amd64.deb`** from the
[releases page](https://github.com/SaltyPretz3l/jenny/releases) (they are
listed only for releases whose Linux build succeeded).
These x64 packages target Ubuntu 22.04+, Debian 12+, and compatible
distributions with glibc 2.35 or newer.

For the AppImage:

```sh
chmod +x Jenny-x86_64.AppImage
./Jenny-x86_64.AppImage
```

Keep the AppImage in a folder you can write to so Jenny can replace it during
an update.

For the `.deb`:

```sh
sudo apt install ./Jenny-amd64.deb
jenny
```

You can also launch the `.deb` install from the app menu. On Ubuntu 24.04, the
AppImage runs without the Chromium sandbox and shows a one-time notice; prefer
the `.deb` there to keep the sandbox on. Saved secrets require an installed and
unlocked Secret Service keyring such as gnome-keyring or KWallet. Local chat
still works with the automatic local profile when no protected keyring is
available.

The Linux packages are built automatically and have been verified by the
maintainer under WSLg only, not on a bare-metal desktop. Windows remains the
supported platform; please [report problems](https://github.com/SaltyPretz3l/jenny/issues).

## Running from source

Use this optional section if you want to work on Jenny's code or run from source on any platform. Otherwise, use the Windows installer or an experimental Linux package above.

Download or clone this repository, then open a terminal in the project folder.

### What you need

- **Node.js 22.23.2+ (22.x) or 24.19.0+ (24.x)** and npm 10+
- **Python 3.11 or newer**
- **Ollama** to run a local model
- Roughly **8–10 GB of free disk space** for the default model download

### Guided setup

The setup script checks what is installed, installs dependencies, creates a Python environment in `.venv`, checks that Ollama is running, downloads a model, and offers to launch Jenny. You can run it again later; completed steps are skipped.

**Windows:** run this in PowerShell:

```powershell
npm run setup
```

If Node isn't installed yet, start with `setup.ps1`. It can install missing prerequisites through `winget` with your consent. Expect Windows administrator (UAC) prompts during those installs. If SmartScreen blocks Jenny, use the steps under **Install on Windows** above. Setup supports either the `py -3` launcher or `python`.

**macOS:** double-click **`setup.command`** in Finder. Setup uses [Homebrew](https://brew.sh/) to install missing prerequisites if Homebrew is available.

If macOS flags the script as coming from an unidentified developer, use right-click → **Open** on macOS 13 (Ventura) and earlier. On macOS 14 (Sonoma) and later, open **System Settings → Privacy & Security**, click **Open Anyway**, and retry. If double-clicking does nothing after downloading a ZIP, run `chmod +x setup.command` once. You can also start setup from a terminal:

```sh
bash ./setup.sh
```

**Linux:** install the prerequisites yourself, then run setup. The script won't install them for you.

```sh
# Node 22.23.2+ (22.x) or 24.19.0+ (24.x) — nvm: https://github.com/nvm-sh/nvm
nvm install 22
# Python 3.11   — e.g. Debian/Ubuntu:
sudo apt install python3.11 python3.11-venv
# Ollama        — see https://ollama.com/download/linux
curl -fsSL https://ollama.com/install.sh | sh

bash ./setup.sh
```

Setup options:

- `--skip-model`: skip the model download.
- `--no-launch`: finish setup without starting Jenny.
- `--model <tag>`: download a different model.
- `--yes`: run without interactive prompts.

Run `node scripts/setup/setup.js --help` for the full list.

### The default model

Source setup downloads **Ornith 1.5 9B**, using the model name `hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M`. Ollama downloads it from the publisher's Hugging Face repository. The download is about **5.6 GB**; model files aren't included in this repository.

Ornith is a coding model that works with text. It runs comfortably on a **12 GB GPU**, or more slowly on a CPU. For image input, **Gemma 4 E4B** is also available in the model picker.

### Starting Jenny later

On **Windows**, use the **Jenny** desktop shortcut created during setup, or double-click **`launch-jenny.cmd`** in the project folder. The shortcut starts Jenny without a console window.

On **macOS or Linux**, run:

```sh
npm run dev
```

That command also works on Windows. It keeps logs visible in a terminal, which can help when troubleshooting. Use `npm run setup` to repeat guided setup.

### Manual setup

If you prefer to install the dependencies yourself, create a Python environment called `.venv` in the project folder. Jenny needs it to find and start its Python backend. Installing there also avoids the `error: externally-managed-environment` message that a bare `pip install` can produce on recent macOS and Linux systems.

**macOS / Linux**

```sh
npm install
python3 -m venv .venv
./.venv/bin/python -m pip install -e .
npm run dev
```

**Windows (PowerShell)**

```powershell
npm install
py -3 -m venv .venv
.\.venv\Scripts\python -m pip install -e .
npm run dev
```

If the Windows `py` launcher is unavailable, use `python -m venv .venv` instead.

## Removing Jenny

For a source install, run `npm run uninstall` or the platform's uninstall wrapper from the project folder.

The uninstaller can back up your data and check the backup, remove the app while keeping your data, or permanently remove Jenny's data after you confirm. Removing downloaded dependencies and deleting the project copy are separate choices. It leaves shared models, external knowledge files, system-wide runtimes, and your ordinary project files alone.

## Running the tests

After source setup, run:

```sh
npm run test:dist
```

This checks the release information, upgrades to saved conversation and memory data, communication between the app and its Python backend, conversation storage, and tool execution. The public repository includes the unit and integration tests needed for these checks. GUI automation, tests using a real Ollama model, and load tests are kept in the development repository.

The first run may install Python test dependencies into `.venv` using `pip install -e .[dev]`. This is expected and only happens once. If you're offline, the check will stop and show the install command. Run that command when you're back online, then retry `npm run test:dist`.

## How it's built

Jenny has two parts:

- **Electron** provides the desktop interface, saves conversations, stores secrets through `safeStorage`, and handles tool approvals. Its code is in `main.js`, `preload.js`, `services/`, and `renderer/`.
- **Python** connects to models, prepares prompts, runs tools, manages memory, and records diagnostic information. Its code is in `sidecar/`.

The two processes exchange JSON-RPC messages over standard input and output. The message definitions are in `sidecar/protocol.py`.

## Help and bug reports

- **A tool is blocked:** check that you've chosen a workspace root. See **First launch** above.
- **A model won't load:** check that Ollama is running with `ollama list`, and that you have enough disk space and graphics memory for the model.
- **More help:** [troubleshooting](docs/support/TROUBLESHOOTING.md), [frequently asked questions](docs/support/FAQ.md), and [tutorials](docs/tutorials/).
- **Found a bug?** [Open an issue](https://github.com/SaltyPretz3l/jenny/issues) with your operating system, model runtime, and steps to reproduce it. Relevant diagnostics are stored in `<userData>/diagnostics/`; review them before attaching them.
- **Security issue:** follow the private reporting instructions in [SECURITY.md](SECURITY.md).

## Contributing

Small, focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the checks to run. Open an issue before starting a large change.

Development happens in a private repository. Accepted changes are copied there by hand, so your pull request may be closed with credit once the change is included, rather than merged directly.

## Project status

Jenny is a hobby project maintained by one person. Bug reports are read, but replies, reviews, and releases happen as time allows. Security reports take priority through the [private advisory process](SECURITY.md).

### Release 1.0.0

This release includes the Windows installer, experimental Linux packages from the releases page, guided setup, local coding tools with live command output, and support for plugins. No plugins are bundled; first-party plugins will be released separately when ready. Crash reporting is optional and off by default.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for release details, earlier changes, and SHA-256 download hashes.

## License

Jenny is free to use under the [MIT License](LICENSE), without warranty. Third-party credits are in [NOTICE](NOTICE).
