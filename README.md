# Jenny

A local-first desktop AI harness for coding, data visualization, and tool calls — with a light companion shell. Native Electron app, in-repo Python sidecar, your choice of local model (Ollama or vLLM). No API keys required, no cloud round-trip, your conversations stay on your machine.

---

## What Jenny is for

Jenny is a lean harness for single local models, not a chat tab. She has a workspace and tools she can run on your machine — file edit, grep, git, shell, diagram rendering — within an approval boundary you control. The focus is what small-to-mid local models (roughly 12B–35B) drive *reliably*: coding workflows, data-visualization artifacts (Monaco + Mermaid), and well-scoped tool calls. Around that core is a light companion shell — a persistent, customizable personality — kept deliberately thin.

She is local-first by default. Inference runs through [Ollama](https://ollama.com/) or [vLLM](https://docs.vllm.ai/). Electron owns conversation persistence, and your conversations stay on your machine.

## How Jenny compares to other AI tools

| | Jenny | ChatGPT / Codex CLI | Claude Code |
|---|---|---|---|
| Where inference runs | Local (Ollama / vLLM) | Cloud (OpenAI) | Cloud (Anthropic) |
| Where conversations live | Your machine, encrypted at rest | OpenAI servers | Anthropic servers |
| API key required | No | Yes | Yes |
| Surface | Native desktop app (Electron) | CLI in your terminal | CLI in your terminal |
| Identity | Persistent, customizable personality + name | Stateless per session | Stateless per session |
| Tool approval | Per-tool, fingerprinted, fail-closed | Varies by deployment | Per-action approval |
| Best for | Local coding, dataviz artifacts, and tool calls with privacy by default | Cloud-grade reasoning when latency and privacy don't matter | Coding sessions with Anthropic models |

Jenny is not the right pick if you need cloud-grade frontier model quality on every turn — local models are smaller. She is the right pick if you want a coding-and-tools assistant that lives on your machine and stays there.

---

## Install (Windows, one click)

Download **[Jenny-Setup-x64.exe](https://github.com/SaltyPretz3l/jenny/releases/latest/download/Jenny-Setup-x64.exe)** from the latest release and run it. The installer is one-click — no wizard pages — and creates a **Jenny** desktop shortcut when it finishes.

**Expect a SmartScreen warning.** The installer is not code-signed (a deliberate cost call for a free hobby project), so on first run Windows shows *"Windows protected your PC"*:

1. Click **More info**.
2. Click **Run anyway**.

That is the whole ceremony. Release integrity stays verifiable without a certificate: every release publishes SHA-256 hashes of its assets in [RELEASE_NOTES.md](RELEASE_NOTES.md), and auto-updates are checked against the release's SHA512 manifest over HTTPS before they install.

On first launch Jenny walks you through the rest: installing [Ollama](https://ollama.com/) (SHA-256-verified download), pulling a model recommended for your hardware, choosing a workspace folder, and naming your assistant. About a minute of clicking, plus the model download.

### macOS (best effort, untested)

Each release also publishes `Jenny-arm64.dmg` (Apple Silicon). Honest label: **it is built on CI and has never been run by the maintainer** — Windows is the supported platform.

- Gatekeeper blocks the unsigned app: right-click **Jenny.app** → **Open** → **Open**, or clear the quarantine flag with `xattr -dr com.apple.quarantine "/Applications/Jenny.app"`.
- **Auto-update is disabled on macOS** (it requires a signed and notarized build). Update by downloading the new dmg from the releases page.
- Install Ollama yourself from [ollama.com/download/mac](https://ollama.com/download/mac); the setup wizard links there and re-scans.

---

## Running from source

Prefer the installer above if you just want to use Jenny. The source path below is for developers and for anyone on Linux.

### What you need

- **Node.js 22.23.2+ (22.x) or 24.19.0+ (24.x)** and npm 10+
- **Python 3.11 or newer**
- **A local model runtime** — [Ollama](https://ollama.com/) is the easiest first install.
- Roughly **8–10 GB of free disk** for the default model download.

On **Windows** the setup script can install missing prerequisites for you (with your consent) via `winget`. On **macOS** it uses [Homebrew](https://brew.sh/) when it is installed. On **Linux** the script does not auto-install prerequisites — install Node 22.23.2+ (22.x) or 24.19.0+ (24.x), Python 3.11 or newer, and Ollama yourself first (commands in the **Linux** section below), then run the script.

**Heads-up (Windows):** as winget installs prerequisites you'll see several Windows admin (UAC) prompts, and — because the app is not code-signed yet — SmartScreen may warn *"Windows protected your PC"*; click **More info -> Run anyway**. Both are expected.

### One-shot setup (recommended)

The setup script verifies prerequisites, installs dependencies, creates the Python virtualenv, makes sure Ollama is installed and running, downloads the default model, and offers to launch Jenny. It is **idempotent** — re-run it any time; each step skips when it is already done.

**Windows** — in PowerShell, from the project folder:

```powershell
npm run setup
```

If Node is not installed yet, `setup.ps1` remains the prerequisite-installing
wrapper. The guided setup supports either the `py -3` launcher or `python`.

**macOS** — double-click **`setup.command`** in Finder. The first time, macOS may flag it as from an "unidentified developer": on macOS 13 (Ventura) and earlier, right-click → **Open**; on macOS 14 (Sonoma) and later, open **System Settings → Privacy & Security** and click **Open Anyway**, then retry. If double-clicking does nothing (e.g. you downloaded a ZIP rather than cloning), run `chmod +x setup.command` once, or just use a terminal:

```sh
bash ./setup.sh
```

**Linux** — the script does not auto-install prerequisites; install them first, then run it:

```sh
# Node 22.23.2+ (22.x) or 24.19.0+ (24.x) — nvm: https://github.com/nvm-sh/nvm
nvm install 22
# Python 3.11   — e.g. Debian/Ubuntu:
sudo apt install python3.11 python3.11-venv
# Ollama        — see https://ollama.com/download/linux
curl -fsSL https://ollama.com/install.sh | sh

bash ./setup.sh
```

Useful flags: `--skip-model` (skip the multi-GB download), `--no-launch` (set up but don't start), `--model <tag>` (pull a different model), `--yes` (non-interactive). Run `node scripts/setup/setup.js --help` for the full list.

The default local model is **Ornith 1.5 9B** — pulled as `hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M` (~5.6 GB) straight from the model publisher's official Hugging Face GGUF repository via Ollama's built-in `hf.co` support. It is a text-only agentic-coding model that runs comfortably on a 12 GB GPU (and on CPU, more slowly); nothing model-related ships in this repo. Ornith does not accept images — Gemma 4 E4B remains available in the model picker for image input.

### Starting Jenny later

**Windows** — after the first run a **Jenny** desktop shortcut is created automatically; use it to start the app with **no console window**. You can also double-click **`launch-jenny.cmd`** in the project folder.

**macOS / Linux** — start Jenny from a terminal:

```sh
npm run dev
```

Running `npm run dev` from a terminal works on any OS and keeps a live log window open beside the app — handy when diagnosing an issue. To re-run the whole guided setup, use `npm run setup`.

### Manual setup (advanced)

If you would rather run the steps yourself instead of the script, create the Python
virtualenv the app expects (`.venv` in the repo root) and install the sidecar into it —
otherwise the sidecar will not be found at launch (and on recent macOS/Linux a bare
`pip install` is refused with `error: externally-managed-environment`).

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

If the Windows `py` launcher is unavailable, use
`python -m venv .venv` instead.

`npm run dev` launches Electron through the dev launcher (`start.js`), which boots the
Python sidecar (from `.venv`) over stdio JSON-RPC. If you would rather not do this by hand,
`npm run setup` performs all of these steps for you.

### First launch

The first launch presents Companion Home with setup tiles: workspace root, local model pull, endpoint validation, personality and agent name, and skills review. The tiles disappear once setup is complete; you can re-run setup any time from **Settings → Account**.

- **Workspace root** — Jenny's tools (file edit, shell, web fetch, etc.) are **blocked until you explicitly choose a workspace root**. This is intentional fail-closed behavior, not a bug.
- **Model** — the setup script downloads the default model for you; the in-app model tile also streams `ollama pull` progress and recommends a model for your hardware. To use a different model, pick any locally-installed Ollama tag in the tile (or in Settings).
- **Personality** — four built-in profiles (balanced, concise, creative, mentor) plus an optional free-form personality field. The agent name defaults to "Jenny" but is fully customizable.

---

## Removing Jenny

Run `npm run uninstall` or the platform uninstall wrapper from this folder.
The guided flow can create and verify a recoverable archive, remove only the
app/clone while retaining data, or permanently remove known Jenny-owned data
after explicit confirmation. Clone dependency cleanup and clone deletion are
separate prompts. Shared models, external knowledge, global runtimes, and
ordinary project files are never removed.

---

## Verifying the source distribution

After setup completes, run the supported deterministic distribution gate:

```sh
npm run test:dist
```

It checks release metadata, session and memory migrations, protocol and capability
contracts, Electron session persistence, backend transport, and the tool loop. The
repository also carries the deterministic unit/integration suite and its required
fixtures. Owner-only GUI automation, real-Ollama tests, and load tests stay in the
canonical development repository and are intentionally not part of this distribution.

Setup installs the run-only Python package by default, so the first `npm run test:dist`
run may print a line about installing the `dev` test extra (`pip install -e .[dev]`)
into the sidecar virtualenv before the Python compatibility tests run — this is
expected and only happens once. If you are offline when that happens, the command
will fail with the exact `pip install` line to run yourself; re-run `npm run test:dist`
afterward.

## Under the hood

Two processes connected by JSON-RPC over stdio:

- **Electron** (`main.js`, `preload.js`, `services/`, `renderer/`) — desktop shell, IPC, persistence (sessions, secrets via `safeStorage`), the tool approval bridge, and the visual companion.
- **Python sidecar** (`sidecar/`) — engine routing, prompt assembly, tool execution, memory, and observability. Stateless per request; the cross-process contract lives in `sidecar/protocol.py`.

## Troubleshooting & support

- If a tool says it is blocked, make sure you have chosen a workspace root (see **First launch**).
- If the model won't load, confirm Ollama is running (`ollama list`) and that you have enough free disk / VRAM for the model tag.
- Common symptoms and fixes: [docs/support/TROUBLESHOOTING.md](docs/support/TROUBLESHOOTING.md) · frequent questions: [docs/support/FAQ.md](docs/support/FAQ.md) · step-by-step walkthroughs: [docs/tutorials/](docs/tutorials/).
- Found a bug? [Open an issue](https://github.com/SaltyPretz3l/jenny/issues) with your OS, model runtime, reproduction steps, and any diagnostic dump from `<userData>/diagnostics/`.
- Security findings — see [SECURITY.md](SECURITY.md) for the disclosure flow.

## Contributing

Small, focused PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the gates to run, and how changes land. One honest expectation up front: development happens in a private repository, so accepted changes are hand-ported upstream and your PR may be **closed as landed with credit** rather than merged directly. For anything large, open an issue first.

## Project status

Jenny is a solo-maintained hobby project, released as-is under MIT because it's good work worth sharing. In practice that means:

- Issues are read, and clear bug reports genuinely help — but there are **no response-time promises**.
- Reviews and releases happen as time permits.
- Security reports get priority through the [private advisory flow](SECURITY.md).

## What's new in 1.0.0

Jenny 1.0 — the first stable release.

- **One-click Windows installer** with a guided first run: hardware scan, SHA-256-verified Ollama install, hardware-aware model recommendation and pull, workspace and personality setup.
- **Ornith 1.5 9B default** — the newest release of the agentic-coding model family, pulled from the publisher's official Hugging Face GGUF repository.
- **Local-first and verifiable** — no accounts, no telemetry (crash reporting is opt-in and off by default), SHA-256 release manifests, and `npm run test:dist` verifies the exact source that ships.
- **Hardened coding and tool workflows** — workspace-root containment, approval-gated tools, live command output, durable terminal settlement, and safe local-model catalog handling.
- **Plugin platform in core, no bundled plugins** — the plugin host ships; first-party plugins are distributed separately once they clear their own release gates.
- **Best-effort macOS build** — an unsigned, untested arm64 dmg is published with each release.

Tuned for small-to-mid local models (~9B–35B). Full history and per-release SHA-256 asset hashes live in [RELEASE_NOTES.md](RELEASE_NOTES.md) — and if you hit something, [report it](https://github.com/SaltyPretz3l/jenny/issues).

## License

Jenny is released under the [MIT License](LICENSE). Third-party attributions for vendored code live in [NOTICE](NOTICE).
