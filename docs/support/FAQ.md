---
kind: docs-index
last_reviewed: 2026-08-19
status: active
---

# Frequently asked questions

Answers to the questions that come up most often. For symptom-to-fix
mappings see [TROUBLESHOOTING.md](TROUBLESHOOTING.md); the developer-facing
error code registry lives at
[docs/operations/error-codes.md](../operations/error-codes.md).

## Why does Windows warn me when I run the installer?

The installer is not code-signed (a deliberate cost decision for a free
hobby project), so SmartScreen shows *"Windows protected your PC"* on first
run. Click **More info → Run anyway**. Integrity is still verifiable: each
release publishes SHA-256 hashes of its assets in `RELEASE_NOTES.md`, and
auto-updates are validated against the release's SHA512 manifest over HTTPS
before they install.

## Is my data sent anywhere?

No. There is no telemetry or analytics; crash reporting is **opt-in and off
by default**. Conversations, memory, and settings stay on your machine. The
only background network calls are the ones you'd expect: model downloads you
initiate, tools you approve (web search/fetch), an update check you trigger
from Settings, and a throttled anonymous refresh of the bundled
model-recommendation catalog (a plain file download, no user data attached).

## Why doesn't Jenny ask for an API key?

Jenny is local-first. The default engine path is [Ollama](https://ollama.com/)
or another OpenAI-compatible local runtime, neither of which requires a
hosted API key. Cloud engines are not configured out of the box; restoring
one is a deliberate integration step, not a Settings toggle.

## Does Jenny work offline?

The local engine path is fully offline once the model is pulled. Tools that
make network calls (web search, fetch) require connectivity when those tools
are invoked, but the core chat loop works without a network.

## Which model should I use?

The setup wizard scans your hardware and recommends the strongest model that
fits your GPU/RAM, with download and disk estimates. The default is
**Ornith 1.5 9B** (`hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M`, ~5.6 GB) — a
text-only agentic-coding model that fits comfortably in 8 GB of VRAM. With
more VRAM the wizard offers the Q8_0 build or Gemma 4 tiers; Gemma 4 E4B
remains the pick when you need image input. You can switch any time in
Settings → Engines, or paste any tag your Ollama install can pull. One note:
Jenny's voice is model-bound — if the persona suddenly feels different,
check which model is active before editing personality files.

## Where does Jenny store my data?

Per-OS userData paths:

- **Windows:** `%APPDATA%\jenny\`
- **macOS:** `~/Library/Application Support/jenny/` *(when packaged for
  macOS — currently Windows-first)*
- **Linux:** `~/.config/jenny/` *(when packaged for Linux — currently
  Windows-first)*

The personality workspace (your `IDENTITY.md` + `SOUL.md`) lives under
`<userData>/personality/<workspace-name>/`. Diagnostics dumps land under
`<userData>/diagnostics/`. The session store is a JSON file under the same
tree; back it up if you care about transcript history.

## How do I uninstall Jenny without losing my chats?

Choose **Uninstall Jenny** under Settings -> Account & Setup -> Data & removal,
then choose **Remove app only**. Jenny drains the running app but preserves the
profile for automatic reuse after reinstall. Silent Windows uninstall and
dragging the macOS app to Trash also preserve data.

For an independent copy, choose **Keep a recoverable archive** instead. Jenny
does not remove live data unless it can read back and verify the completed
archive. Full archive restore is offered only into a fresh profile; individual
chats can still use the existing session importer.

## Does permanent removal delete Ollama models or project files?

No. Shared Ollama models, the local-image plugin's retained runtime, global runtimes, external
knowledge folders, unknown `.companion` children, and ordinary files outside a
workspace `.jenny` directory are retained. Workspace `.jenny` removal is a
separate option and is off by default. See
[Uninstall and Data Recovery](../operations/UNINSTALL_AND_DATA_RECOVERY.md).

The image plugin can remove its own downloaded runtime from its workspace after
showing the measured size and asking for confirmation. Uninstalling the plugin
alone preserves that runtime so reinstall can adopt it without downloading the
model weights again.

## Can I run Jenny on macOS or Linux?

Windows is the supported platform. Each release also publishes a
**best-effort macOS build** (`Jenny-arm64.dmg`, Apple Silicon) — unsigned,
built on CI, and never run by the maintainer: Gatekeeper requires
right-click → **Open** the first time, and auto-update is disabled there
(download new versions manually). Linux is source-only: clone the repo and
run the setup script per the README.

## How do I add a new MCP server?

Settings → MCP exposes discovered servers and lets you register new ones.
The first-time walkthrough is at
[docs/tutorials/02-adding-mcp-server.md](../tutorials/02-adding-mcp-server.md).

## Why is the first message slow?

Local model load happens on the first turn after the engine cold-starts.
Subsequent turns reuse the loaded weights and respond faster. The
diagnostic walkthrough for unusual slowness is at
[TROUBLESHOOTING.md § First visible token is slow](TROUBLESHOOTING.md#first-visible-token-is-slow).

## How do I customize Jenny's personality?

Settings → Personality exposes the name, profile, and free-form description.
The walkthrough is at
[docs/tutorials/03-personality-customization.md](../tutorials/03-personality-customization.md).
The persona is steered by the `IDENTITY.md` / `SOUL.md` pair under the
personality workspace; advanced edits live there.

## How do I report a bug or request a feature?

Open an issue at [github.com/SaltyPretz3l/jenny](https://github.com/SaltyPretz3l/jenny).
Include your OS, the Node and Python versions, the model runtime
(Ollama version, vLLM version), and reproduction steps. Security findings
follow the disclosure flow in [SECURITY.md](../../SECURITY.md).
