---
kind: tutorial
last_reviewed: 2026-09-07
---

# 02 — Adding an MCP server

This walkthrough adds an MCP (Model Context Protocol) server to Jenny so her tool surface gains the server's tools. Estimated time: 10 minutes.

[MCP](https://modelcontextprotocol.io/) is an open protocol for tool servers. Jenny implements an MCP client; this tutorial registers an external server so its tools become Jenny's tools.

## Prerequisites

- Jenny installed and at least one chat completed (see [01 — First chat](01-first-chat.md)).
- An MCP server you want to use. Common choices are the [reference servers](https://github.com/modelcontextprotocol/servers) (filesystem, git, and others). Most of them run through `npx`, so Node.js must be on your `PATH`.

## 1. Open the MCP connections list

Open Settings (the gear icon) → **Plugins & Extensions**. Below the Plugins and Skills groups is **MCP connections**, one row per configured server with a status badge. On a fresh install the list is empty.

## 2. Add a connection

Press **Add connection**. The drawer asks for:

- **Connection name** — letters, digits, `_`, `.`, `-`, up to 64 characters. Tools from this server appear as `mcp__<name>__<tool>` in Jenny's tool list.
- **Transport** — **Local stdio** (Jenny launches the server as a subprocess) or **Remote SSE** (an HTTP endpoint).
- **Command** (stdio) or **HTTPS URL** (SSE).
- **Arguments (one per line)** for stdio servers.
- **Authentication** — None, Bearer token, or OAuth client credentials. For the last two, the secret is entered separately (step 4) and stored encrypted; it never goes into the config file.

For the reference filesystem server the entry looks like:

| Field | Value |
|---|---|
| Connection name | `filesystem` |
| Transport | Local stdio |
| Command | `npx` |
| Arguments | `-y` / `@modelcontextprotocol/server-filesystem` / `C:\path\to\allowed\dir` (one per line) |

Press **Create connection**. The new row shows **Review required**: nothing runs until you have looked at what the server offers.

## 3. Test and approve the connection

Press **Test connection**. Jenny shows the exact command or URL it is about to run and asks you to confirm, then performs a one-time inspection: it starts the server, asks it for its tool list, and shuts it down again. The result reports how many tools were found.

Press **Review** to see the advertised tools and their digests, then **Approve tools**. The badge changes to **Approved**, the connection is enabled, and Jenny's runtime picks it up without a restart.

Approval is tied to the configuration and to the advertised tool set. If you later edit the command, or the server starts advertising different tools, the row drops back to **Review required** and the server stays off until you approve it again.

## 4. (Optional) Add a credential

For a remote server that needs a token, choose **Bearer token** or **OAuth client credentials** when creating the connection, then press **Set credential** on the row and paste the secret. Credentials live in Jenny's encrypted secret store, keyed by a reference in the config; the config file itself never contains a plaintext token, and Jenny refuses a config that does.

Remote SSE connections are also gated by `mcp_sse_enabled` in the config file (see below); the connections list shows whether remote transports are currently allowed.

## 5. Use the new tools

The tools appear with the `mcp__<server>__<tool>` prefix so they cannot collide with built-in names. Ask Jenny to do something the server enables, for example:

> List the files in the folder the filesystem server exposes.

MCP tools go through the same approval pipeline as built-in tools: in **Ask** run mode, side-effecting calls stop at the approval card, and **Always allow** is scoped to the tool and its target.

You can also ask Jenny to run `jenny_status` and summarize the result; it reports which MCP servers are connected or failed.

## The config file

The connections list is a front end for `mcp-servers.json` in Jenny's data directory:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\jenny\mcp-servers.json` |
| macOS | `~/Library/Application Support/jenny/mcp-servers.json` |
| Linux | `~/.config/jenny/mcp-servers.json` |

You do not need to edit it by hand, but it is plain JSON if you want to:

```json
{
  "mcp_config_schema_version": 1,
  "mcp_sse_enabled": false,
  "mcp_servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\path\\to\\allowed\\dir"],
      "enabled": true,
      "trust": { "status": "pending" }
    }
  ]
}
```

Notes:

- Allowed server keys are `name`, `transport`, `command`, `args`, `url`, `init_timeout_seconds`, `auth`, `enabled`, and `trust`. Unknown keys, including an `env` block, make the entry invalid.
- A hand-added or edited server always starts disabled with trust `pending`; approve it from Settings.
- Remote servers need `"transport": "sse"`, a `url` (http or https, no embedded credentials), and `"mcp_sse_enabled": true` at the top level.
- The `trust` record is written by Jenny when you approve; leave it alone.
- If Jenny cannot parse the file it keeps it unchanged, shows the reason in the connections list, and treats the list as read-only until you fix the JSON.

## Containment

MCP subprocesses run under the same containment as Jenny's other side-effecting subprocesses: a Job Object on Windows (children die with Jenny), a process group plus resource limits on POSIX, and sanitized stderr. That contains a crash; it does not sandbox the server. An MCP server has the same filesystem and network access as any program you run, so only add servers you trust. [Plugin security & trust model](../PLUGIN_SECURITY.md) has the full MCP trust design.

## Troubleshooting

- **Test connection fails immediately.** The failure reason is shown on the row. The usual cause is a missing runtime for the server itself (`npx` not on `PATH`, a Python package missing). Run the same command in a terminal to see the raw error.
- **"URL points to a private or local address, which is blocked."** Remote SSE connections may not target loopback or private-network addresses. Run a local server over stdio instead.
- **Zero tools found.** The server started but did not answer the tool-list request. Check its own logs or run it by hand.
- **Row shows Failed or Cooling down.** The server crashed after approval. Jenny retries with a bounded cooldown; if it keeps failing, test the connection again to see the current error.
- **Tools disappeared after an update to the server.** Its advertised tool set changed, so the row went back to **Review required**. Approve it again.
- **Test connection is greyed out with "MCP inspection is unavailable until the local runtime is ready."** The backend is still starting. Wait for the titlebar health indicator, then retry.

## Next

- Tour the built-in tool families: [docs/TOOLS.md](../TOOLS.md).
- Package tools of your own as a plugin instead: [docs/plugins/README.md](../plugins/README.md).
