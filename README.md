# Jenny

Jenny is a desktop AI assistant that runs on your computer. She can help you write code, edit files, run commands, and make charts and diagrams. You choose the model, the project folder, and the permissions for her tools. You can also change her name and personality.

With a local model, Jenny processes your prompts locally and saves conversations on your computer. You can use [Ollama](https://ollama.com/), [vLLM](https://docs.vllm.ai/), or an existing OpenAI-compatible server on this computer or your private network. Ollama is optional.

Jenny is built around smaller models, roughly 9B–35B parameters. How well she handles a task depends on the model you choose and the hardware you have. Expect mistakes, especially on complicated tasks, and review code and commands before relying on them.

## Jenny 1.1.0

**[Jenny 1.1.0 is available](https://github.com/SaltyPretz3l/jenny/releases/tag/v1.1.0)**
with 19 interface languages and Arabic RTL, an optional 24-hour clock, bulk chat
management, clearer waiting states, improved artifact/preview workflows and
explicit update controls. See the [release notes](RELEASE_NOTES.md).

Windows is the supported desktop platform. This release also provides
experimental Linux x64 AppImage/deb packages; macOS remains source-only pending
hardware qualification. Translations are model-authored and newer copy may fall
back to English.

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

You can check a download against the SHA-256 file hashes in [RELEASE_NOTES.md](RELEASE_NOTES.md). Updates are checked only when requested in Settings; downloads are validated against the release's SHA512 metadata over HTTPS before explicit installation.

### First launch

Choose a project folder and one model route: **Use Ollama on this computer** or **Connect an existing server**. The existing-server route needs no Ollama installation or model download. If you choose Ollama, Jenny checks its download against its SHA-256 hash and recommends a model based on your hardware; model downloads can be several gigabytes.

- **Project folder:** choose the folder Jenny will work in, called the *workspace root* in the app. Her tools stay blocked until you choose one.
- **Model:** select or download an Ollama model, or open **Connect an existing server**, select your provider, enter its URL, validate, and save. Local/private-network vLLM and OpenAI-compatible endpoints are supported; endpoint availability and model readiness still need to pass validation.
- **Personality:** choose balanced, concise, creative, or mentor, or write your own instructions. The default name is Jenny; you can change it.
- **Other setup steps:** check the connection to your model and review the available skills.

The setup tiles disappear when you're done. You can run setup again from **Settings → Account**.

### macOS: experimental; installer not yet available

The current public release has no macOS installer. The Apple Silicon build pipeline targets `Jenny-arm64.dmg` and `Jenny-arm64.zip`, but build repair does not establish download availability or real-hardware testing. Use source setup for now and check the [release assets](https://github.com/SaltyPretz3l/jenny/releases) for future availability. **Windows is the supported platform; macOS remains experimental and has not been tested by the maintainer on real hardware.**

- Future experimental installers may be unsigned; check the signing status in that release's notes and follow macOS's standard **Privacy & Security → Open Anyway** flow if you trust the download.
- **Automatic updates are disabled on macOS** because they require a signed and notarized build. Download the new dmg from the [releases page](https://github.com/SaltyPretz3l/jenny/releases) to update.
- For the Ollama route, install it from [ollama.com/download/mac](https://ollama.com/download/mac). Existing-server users do not need it.

### Linux (experimental)

Jenny 1.1.0 includes experimental **`Jenny-x86_64.AppImage`** and
**`Jenny-amd64.deb`** packages on the
[release page](https://github.com/SaltyPretz3l/jenny/releases/tag/v1.1.0).
Native CI verified the glibc floor and packaged-app startup. Installed-format,
upgrade and bare-metal qualification remain outstanding.
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

Linux build and WSL/container evidence does not qualify a new installer.
Installed-package and bare-metal acceptance remain release gates. Windows remains the
supported platform; please [report problems](https://github.com/SaltyPretz3l/jenny/issues).

## Docker localhost and browser hosting (experimental)

Use the [guided Docker quick start](docs/operations/HOSTED_QUICKSTART.md): run
`bash docker-setup.sh` or `.\docker-setup.ps1` from a source checkout. Docker
builds the runtime and a terminal wizard configures your existing model server
and owner login. Open `http://127.0.0.1:8080` on that computer; Tailscale is not
required. Optional private HTTPS connects other devices to the same durable host.

The browser host provides chat, typed file tools and one-off-approved commands
in a separate offline disposable sandbox. Command file changes are discarded.
Desktop IDE/terminal and plugin parity remain outside this MVP. See
[hosting operations](docs/operations/HOSTED_JENNY.md) for qualification and recovery.

### Optional desktop command sandbox

The desktop app can also use a Docker command sandbox without becoming a
browser host. It defaults off and requires a running Linux Docker engine.
Commands operate on disposable workspace copies and discard their file changes;
this mode does not provide terminal, MCP or executable-plugin parity. See
[desktop sandbox setup and qualification](docs/operations/DESKTOP_COMMAND_SANDBOX.md).

## Running from source

Use this optional section if you want to work on Jenny's code or run from source on any platform. Otherwise, use the Windows installer or an experimental Linux package above.

Download or clone this repository, then open a terminal in the project folder.

### What you need

- **Node.js 22.23.2+ (22.x) or 24.19.0+ (24.x)** and npm 10+
- **Python 3.11 or newer**
- **Ollama or an existing supported model server**
- Roughly **8–10 GB of free disk space** if downloading the default model

### Guided setup

The setup script checks what is installed, installs dependencies, creates a Python environment in `.venv`, checks that Ollama is running, downloads a model, and offers to launch Jenny. You can run it again later; completed steps are skipped.

**Already have a model server?** Run `npm run setup -- --existing-server`. With the platform wrappers, use `./setup.sh --existing-server` or `./setup.ps1 -ExistingServer`. This installs Jenny's application dependencies but skips all Ollama operations and model downloads. Configure the URL with **Connect an existing server** after launch. `--existing-server` cannot be combined with `--model`; `--skip-model` alone only skips the model download.

Setup forwards this choice when launching Jenny, suppressing automatic Ollama daemon startup for that app process. To launch later with the same behavior, run `npm run dev -- --existing-server`. This launch flag does not alter saved settings or bypass endpoint validation.

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

### Source version 1.1.0

This source tree includes guided setup, local coding tools with live command output, experimental platform and Docker workflows, and the plugin host. Downloadable installers are listed separately on the [releases page](https://github.com/SaltyPretz3l/jenny/releases); a source version does not establish that its installers have been published. No plugins are bundled. Crash reporting is optional and off by default.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for release details, earlier changes, and SHA-256 download hashes.

## License

Jenny is free to use under the [MIT License](LICENSE), without warranty. Third-party credits are in [NOTICE](NOTICE).

### Updates

Use Settings → About & Updates → Check for Updates. This contacts GitHub and
requires internet access; there is no startup polling. Only published stable
releases count. Download and Restart and Install are separate explicit actions.
Manual-install formats can discover versions and open GitHub Releases. Unsigned
installer integrity relies on SHA512 over HTTPS, not independent publisher signing.
