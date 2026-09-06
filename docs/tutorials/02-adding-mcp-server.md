---
kind: tutorial
last_reviewed: 2026-05-09
---

# 02 — Adding an MCP server

This walkthrough adds an MCP (Model Context Protocol) server to Jenny so her tool surface gains the server's tools. Estimated time: 10 minutes.

[MCP](https://modelcontextprotocol.io/) is the Anthropic-defined open protocol for tool servers. Jenny implements an MCP client and a built-in MCP server that exposes Electron-owned tools to external MCP clients. This tutorial covers the client side — registering an external MCP server so its tools become Jenny's tools.

## Prerequisites

- Jenny installed and at least one chat completed (see [01 — First chat](01-first-chat.md)).
- An MCP server you want to use. For this tutorial we'll use a hypothetical local stdio server. Common choices: the [official Anthropic MCP servers](https://github.com/modelcontextprotocol/servers) (filesystem, git, GitHub, Slack, etc.).

## 1. Find the config file

Jenny reads MCP server configuration from `mcp-servers.json` in the Electron user-data directory:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\jenny\mcp-servers.json` |
| macOS | `~/Library/Application Support/jenny/mcp-servers.json` |
| Linux | `~/.config/jenny/mcp-servers.json` |

The file may not exist on a fresh install. The fastest way to open it is from the app:

- Open Settings (gear icon) → **Skills**.
- Click **Open MCP config**.
- Jenny opens the file in your default text editor and creates it if missing.

If the app isn't running, just create the file at the path above.

## 2. Add a server entry

The config file is JSON. Here's a minimal stdio server example:

```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
      "enabled": true
    }
  ]
}
```

Key fields:

- `name` — unique identifier for this server within Jenny. Tools from this server will appear as `mcp__filesystem__<tool>` in Jenny's tool list.
- `transport` — `stdio` (subprocess over stdin/stdout) or `sse` (server-sent events over HTTP).
- `command` and `args` — for stdio transport, the executable and arguments. Jenny launches this as a subprocess.
- `url` — for sse transport, the SSE endpoint URL.
- `env` (optional) — extra environment variables passed to the subprocess. Avoid secrets here; Jenny's [SecureStore](../operations/versioning-and-migration.md) is the right place for credentials.
- `enabled` — set to `false` to keep the entry but skip the server on startup.

Save the file.

## 3. Restart Jenny

MCP servers are loaded at sidecar startup. After editing `mcp-servers.json`, restart the app:

- Close the Jenny window.
- Run `npm run dev` again.

(There is no live-reload of MCP config today. The Settings → Skills card has a **Refresh** button that re-reads the config file but a full restart is needed to actually launch the new server.)

## 4. Verify the server is running

Open Settings → **Skills**. You'll see one row per configured server:

- A name and transport type.
- Status: `configured`, `running`, `cooldown`, or `failed`.
- Tool count derived from the server's `tools/list` response.

If the server failed to start, the status row includes the failure reason. Common causes: command not on PATH, missing required arguments, the server's own startup error.

You can also ask Jenny:

> Run `jenny_status` and summarize the current runtime and tool status.

She'll call `jenny_status` and report the current bounded status snapshot.

## 5. Use the new tools

The new tools become available immediately to Jenny. They appear with the `mcp__<server>__<tool>` namespace prefix to avoid collisions with built-in tool names. (Unique non-conflicting bare names also resolve through a one-major-version compat layer with a deprecation warning.)

Tools imported from MCP servers go through the same approval pipeline as built-in tools: side-effecting calls require explicit approval, and the approval-plan fingerprint covers the full tool contract and arguments.

## Containment and security

Jenny applies the same sandbox model to MCP server subprocesses as to other side-effecting tools:

- **Windows:** Job Object isolation with memory and process-tree caps; child processes terminate when Jenny exits.
- **POSIX:** `setsid()` for process-group isolation; `RLIMIT_AS`, `RLIMIT_NOFILE`, `RLIMIT_CORE = 0`.
- Stderr tails and JSON-RPC error messages from MCP servers are sanitized before surfacing.
- CPU is a soft limit: sustained 100% over 30 seconds emits a warning event but does not kill the server (long-lived MCP servers legitimately spike during tool calls).

Treat MCP servers the same as any other subprocess you run on your machine. They have the host's filesystem and network permissions; they are not isolated from the rest of your system. Pick servers you trust.

## Troubleshooting

- **Server starts then immediately exits.** Check the failure reason in Settings → Skills. The most common cause is a missing dependency for the server's own runtime (e.g., `npx` not found, Python package missing).
- **Tools don't appear.** The server may have started but failed to respond to `tools/list`. Check Settings → Skills for the tool count; zero tools usually means the server crashed during initialization.
- **Tool calls fail mid-execution.** Jenny applies bounded reconnect/retry to MCP transports — see the MCP retry policy at [`sidecar/ai/mcp/retry_policy.py`](../../sidecar/ai/mcp/retry_policy.py). If the server crashes during a non-side-effecting tool call, Jenny will reconnect and retry once. Side-effecting tools schedule a reconnect for future calls but are not auto-replayed.

## Next

- Tour the built-in tool families: [docs/TOOLS.md](../TOOLS.md).
- Read the MCP design notes: docs/operations/SUB_AGENT_DESIGN.md covers the broader tool-orchestration model.
