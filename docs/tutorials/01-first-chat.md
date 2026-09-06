---
kind: tutorial
last_reviewed: 2026-05-09
---

# 01 — First chat with Jenny

This walkthrough takes you from a fresh install to your first message exchanged with Jenny. Estimated time: 10 minutes including the model pull (model pull dominates the wall clock).

## Prerequisites

You should have:

- Cloned the repo and run `npm install` and `python -m pip install -e ".[dev]"` per the [README](../../README.md).
- [Ollama](https://ollama.com/) installed and running. Verify with `ollama list` from a terminal.

## 1. Launch Jenny

```sh
npm run dev
```

The custom dev launcher (`start.js`) starts the Electron shell, which boots the Python sidecar over stdio JSON-RPC. The app window opens to **Companion Home**.

On first launch you'll see four setup tiles instead of an empty chat:

1. **Set workspace root** — the directory Jenny's tools can read and write under.
2. **Pull a local model** — fetches a model through Ollama if you don't already have one.
3. **Validate endpoint** (optional) — for vLLM or OpenAI-compatible local endpoints.
4. **Personality and name** — pick a profile and optionally rename Jenny.

The tiles are persistent. You can come back to them, dismiss them, or re-open them from Settings → Account → "Run setup again."

## 2. Set a workspace root

Click **Choose workspace root** on the first tile and pick a directory. This is where Jenny's filesystem, shell, and git tools will operate. The workspace root is fail-closed — until you set one, those tools are blocked even if their config flags are on.

A reasonable choice for the first run: `C:\Users\<you>\projects\jenny-test` or any scratch directory. You can change it later.

## 3. Pull a local model

Click **Pull model** on the second tile. Type a model name and click Pull. Reasonable starting points:

- `qwen3:8b` — fast, runs on most hardware with 16 GB RAM.
- `qwen3:32b` — better quality, needs ~32 GB RAM and a recent GPU for usable latency.
- `gemma:2b` — tiny, runs on almost anything but produces shorter / less nuanced replies.

The pull tile streams `ollama pull` progress in-app. Pulling a model the first time downloads gigabytes; expect 5–20 minutes depending on your connection and the model size. You can navigate away and come back; progress is preserved.

When the pull completes, Jenny picks the model automatically. If you have multiple models, switch from the model picker in Settings.

## 4. (Optional) Pick a personality

The fourth tile lets you pick from four built-in profiles:

- **Balanced** (default) — friendly, helpful, dials tone to context.
- **Concise** — terse responses, minimum padding.
- **Creative** — more exploratory, longer divergent thinking.
- **Mentor** — explanatory, walks through reasoning.

You can also rename Jenny here (the agent name defaults to "Jenny" but is fully customizable) and add a free-form personality note. See [03 — Personality customization](03-personality-customization.md) for details on what each setting actually does.

## 5. Send your first message

When `setup_complete` is true the tiles disappear and the empty chat composer takes over. Type something:

> Hey Jenny, can you tell me a bit about yourself?

Press Enter to send. You'll see:

- Jenny's response stream in token-by-token.
- A persistent companion comet animation that responds to her thinking / responding state.
- The session sidebar on the left, where this conversation is now persisted.

If she's slow to start, the first turn warms the model into memory. Subsequent turns are faster.

## What just happened

Behind the scenes:

1. Electron's `main.js` started, registered IPC handlers, and launched the managed Python sidecar.
2. The sidecar registered tool descriptors from `services/tools/tool-manifest.json` and the local Python catalog.
3. Your message was sent through `chat.send` JSON-RPC. Electron carries the canonical conversation history; the sidecar is stateless per request.
4. The sidecar built a system prompt, ran token budget checks, and called Ollama with your model.
5. Streaming tokens came back over `chat.token` notifications, rendered live in the chat, and were persisted into `turn_events[]` on completion.

If you're curious about the full flow, docs/operations/PROMPT_BUILDER_SYSTEM.md describes how the system prompt gets built and docs/operations/CONCURRENCY_MODEL.md covers the request boundary and cancellation contract.

## Next

- Try asking Jenny to read a file in your workspace. She'll request approval for the `read_file` tool the first time. See [docs/TOOLS.md#filesystem](../TOOLS.md#filesystem).
- Add an MCP server to extend her with new tools — see [02 — Adding an MCP server](02-adding-mcp-server.md).
- Tune her voice — see [03 — Personality customization](03-personality-customization.md).
