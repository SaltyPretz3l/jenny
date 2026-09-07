---
kind: tutorial
last_reviewed: 2026-09-07
---

# 01 — First chat with Jenny

This walkthrough takes you from a fresh install to your first message exchanged with Jenny. Estimated time: 10 minutes, most of it waiting for the model download.

## Prerequisites

Either of these:

- **Windows installer.** You ran `Jenny-Setup-x64.exe` from the [releases page](https://github.com/SaltyPretz3l/jenny/releases/latest) and have the **Jenny** desktop shortcut. Setup installs Ollama for you if it is missing.
- **Source install.** You ran the guided setup (`npm run setup`, or `setup.command` / `setup.sh`) per the [README](../../README.md). It creates the `.venv`, checks Ollama, and downloads the default model.

Jenny needs [Ollama](https://ollama.com/) to run a local model. Verify with `ollama list` from a terminal if you are unsure whether it is installed.

## 1. Launch Jenny

Double-click the **Jenny** shortcut (Windows), or run `npm run dev` from the project folder (any platform; keeps logs in the terminal).

The Electron shell starts, boots the Python backend, and opens the main window. On first launch you land on the **Set up Jenny** checklist instead of an empty chat.

If Ollama is not installed or is too old, a **Local engine** scene appears first with **Install Ollama** (or **Upgrade Ollama**) and **Re-check** buttons. On Windows the installer is downloaded and its SHA-256 hash is checked before it runs. On macOS the button links to ollama.com; install it, then press **Re-check**.

## 2. Work through the checklist

The checklist has six steps. Each opens its own scene, and you can leave with **Finish later** and come back:

1. **Choose workspace root** — the folder Jenny's file, shell, and git tools may work in. Until you choose one, those tools stay blocked even when they are enabled. Any scratch folder is fine for a first run; you can change it later under **Settings → Tools → Workspace root**.
2. **Pull a local model** — the model library. The hardware scan recommends the strongest model that fits your GPU and RAM, with download and disk estimates. Pick one and press pull; progress streams in-app and resumes if it is interrupted. Anything already in your Ollama install is listed too.
3. **Validate your endpoint** (optional) — point Jenny at a local Ollama, vLLM, or OpenAI-compatible server instead of the managed default. Skip it unless you run your own server.
4. **Personality & name** — name the assistant, pick a voice template, and add a short personality note. See [03 — Personality customization](03-personality-customization.md).
5. **Review skills & MCP** — a glance at the skills and MCP connections Jenny will use. Nothing to do here on a fresh install.
6. **Choose tools & permissions** — toggles for local computation (Python runtime, image reading, to-do tracking), network access (web search, web browsing), and workspace changes. Network access and file changes stay off until you enable them.

Steps you skip stay marked **Skipped**. When you are done, the checklist closes and the chat composer takes over. You can reopen it any time from **Settings → Local Profile & Setup → Run setup again**; that never deletes your conversations.

## 3. Send your first message

Type something in the composer at the bottom of the chat:

> Hey Jenny, can you tell me a bit about yourself?

Press **Enter** to send. You will see:

- A **thinking** row while the model reasons (on models that expose their reasoning), then the reply streaming in token by token.
- The session in the sidebar on the left, where this conversation is now saved.
- The titlebar health indicator, which tells you whether the backend and engine are ready.

If the first reply is slow to start, the model is being loaded into memory. Later turns reuse the loaded weights and start much faster.

## 4. Pick how much Jenny may do

The **Run mode** control next to the composer has three settings:

- **Ask** — Jenny asks before acting. Every side-effecting tool call (writing a file, running a command) stops at an approval card that says exactly what will happen.
- **Auto** — tools run without asking. Destructive shell commands still stop for approval.
- **Plan** — read-only planning. Jenny reads and proposes; nothing is written until you approve the plan. Works best with larger models.

Start in **Ask**. When you approve a call you can choose **Always allow**, which is scoped to that tool *and* the path it named. Saved decisions are listed under **Settings → Tools → Approval rules**, each with a Remove action.

## What just happened

Behind the scenes:

1. The Electron shell (`main.js`) started, registered IPC handlers, and launched the managed Python backend (the *sidecar*) over stdio JSON-RPC.
2. The sidecar loaded the tool catalog from `services/tools/tool-manifest.json` and the Python builtins.
3. Your message went out as a `chat.send` request. Electron keeps the canonical conversation history; the sidecar is stateless per request.
4. The sidecar assembled the system prompt (personality, workspace instructions, tool contracts), checked the token budget, and called the model.
5. Tokens streamed back as notifications, rendered live, and were persisted with the turn when it completed.

If you're curious about the full flow, [docs/ARCHITECTURE.md](../ARCHITECTURE.md) describes how the shell, backend services, and sidecar fit together.

## Next

- Ask Jenny to read a file in your workspace. In **Ask** mode she requests approval the first time. See [docs/TOOLS.md](../TOOLS.md) for what every tool family can do.
- Add an MCP server to extend her with new tools — see [02 — Adding an MCP server](02-adding-mcp-server.md).
- Tune her voice — see [03 — Personality customization](03-personality-customization.md).
- Something off? Check the [FAQ](../support/FAQ.md) and [Troubleshooting](../support/TROUBLESHOOTING.md).
