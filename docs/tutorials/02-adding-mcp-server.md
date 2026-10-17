---
kind: tutorial
last_reviewed: 2026-10-14
---

# 02 — Adding an MCP server

This walkthrough adds an MCP (Model Context Protocol) server to Jenny so her tool surface gains the server's tools. Estimated time: 10 minutes.

[MCP](https://modelcontextprotocol.io/) is an open protocol for tool servers. Jenny implements an MCP client; this tutorial registers an external server so its tools become Jenny's tools.

## Prerequisites

This tutorial covers the ordinary desktop execution mode. Third-party MCP tools
remain unavailable in hosted mode and when the desktop Docker command sandbox
is enabled; adding a connection does not bypass that boundary. See the
[desktop sandbox guide](../operations/DESKTOP_COMMAND_SANDBOX.md).

- Jenny installed and at least one chat completed (see [01 — First chat](01-first-chat.md)).
- An MCP server you want to use. Common choices are the [reference servers](https://github.com/modelcontextprotocol/servers) (filesystem, git, and others). Most of them run through `npx`, so Node.js must be on your `PATH`.

## 1. Open the MCP connections list

Open Settings (the gear icon) → **Extensions**. Below the Skills group is **MCP connections**, one row per configured server with a status badge. On a fresh install the list is empty.

## 2. Add a connection

Press **Add connection**. The drawer asks for:

- **Connection name** — start with a letter or digit, then use letters, digits, `_`, `.`, `-`, up to 64 characters. `jenny_local_tools` is reserved. Tools from this server appear as `mcp__<name>__<tool>` in Jenny's tool list.
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

MCP tools go through the same approval pipeline as built-in tools. Review the
policy shown on each call; saved **Always allow** choices are scoped to the tool
and, where a target is present, that target.

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
  "mcp_config_schema_version": 2,
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

- Allowed server keys are `name`, `transport`, `command`, `args`, `url`, `init_timeout_seconds`, `auth`, `env`, `memory_limit_mb`, `max_processes`, `inspect_timeout_seconds`, `request_timeout_seconds`, `read_only_auto_allow`, `enabled`, and `trust`. Any other key makes the entry invalid.
- Optional per-server settings (schema version 2; leave a key out to keep Jenny's default):
  - `env` (stdio only): up to 16 environment variables added to the server's otherwise scrubbed environment, for example `{"REA_LOG_LEVEL": "debug"}`. Names are upper case (`A-Z`, `0-9`, `_`, 2 to 64 characters) and values are strings of at most 1,024 characters. They never replace a variable Jenny sets. `env` is for non-secret configuration only: secrets stay in Jenny's encrypted store (add a credential from Settings), and a name containing `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY` or `PRIVATE` is refused as a plaintext secret. Reserved names are refused too: any name containing `PATH`; the variables Jenny sets or passes through (`PYTHONIOENCODING`, `PYTHONUNBUFFERED`, `OPENBLAS_NUM_THREADS`, `PATHEXT`, `SYSTEMROOT`, `COMSPEC`, `TEMP`, `TMP`, `TMPDIR`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TESSDATA_PREFIX`, `JENNY_*`, `XDG_*`); and runtime option or loader controls: any name starting with `NODE_`, `NPM_`, `YARN_`, `PNPM_`, `COREPACK_`, `JAVA_`, `_JAVA_`, `JDK_`, `ELECTRON_`, `PERL`, `RUBY`, `DOTNET_`, `PYTHON`, `LD_` or `DYLD_`, any name containing `OPTIONS` or `OPTS`, plus `WINDIR` and `AUTHORIZATION` (npm, for example, turns `NPM_CONFIG_NODE_OPTIONS` into `NODE_OPTIONS` for the processes it starts). Jenny's sidecar re-checks the same rule when it builds the server's environment.
  - `memory_limit_mb` (stdio only, 256 to 8192, default 512) and `max_processes` (stdio only, 1 to 32, default 5) set the server's containment limits.
  - `request_timeout_seconds` (stdio only, 1 to 1800) lets that server's tool calls run longer than the global tool timeout; it never shortens it.
  - `inspect_timeout_seconds` (stdio and SSE, 1 to 180, default 15) is how long **Test connection** waits, for servers with a slow first start.
  - `init_timeout_seconds` applies to SSE connections only; stdio servers ignore it.
  - `read_only_auto_allow` (stdio and SSE, `true` or `false`, default off): when on, tools that the server marks read-only (`readOnlyHint`, and neither open-world nor destructive) run without the per-call approval, are retried automatically and are allowed in Plan mode. The server's claims are shown at review; with the switch on they are recorded in the approved tools digest, so a claim the server changes afterwards sends it back to review (with the switch off a claim is display-only and an earlier approval stands). Turn it on only for a server you trust to label its tools honestly; changing the switch itself sends the server back to review. In Settings the switch is **Read-only tools run without asking** in the connection's details drawer, available before and after approval, and the review tags each tool that carries a read-only claim.
- A file from an older Jenny (schema version 1) keeps working with its approvals and is saved as version 2 on the next change. A file from a newer Jenny opens read-only.
- A hand-added or edited server always starts disabled with trust `pending`; approve it from Settings.
- Remote servers need `"transport": "sse"`, a `url` (http or https, no embedded credentials), and `"mcp_sse_enabled": true` at the top level.
- The `trust` record is written by Jenny when you approve; leave it alone.
- If Jenny cannot parse the file it keeps it unchanged, shows the reason in the connections list, and treats the list as read-only until you fix the JSON.

## Containment

MCP subprocesses run under the same containment as Jenny's other side-effecting subprocesses: a Job Object on Windows (children die with Jenny), a process group plus resource limits on POSIX, and sanitized stderr. That contains a crash; it does not sandbox the server. An MCP server has the same filesystem and network access as any program you run, so only add servers you trust. [MCP servers in the tools reference](../TOOLS.md#mcp-servers) describes the approval and trust model.

## Using the rea preset (Windows)

On Windows, Settings → **Extensions** → **Add connection** shows **Start from a preset: Reverse engineering (rea)** above the form. The preset fills the name `rea`, the command `C:\Program Files\nodejs\npx.cmd` and the arguments `-y rea-agents@6.4.0 mcp`, and sets `memory_limit_mb` 2048, `max_processes` 16, `inspect_timeout_seconds` 120 and `request_timeout_seconds` 300 on the new row. The form has no fields for those limits; change them in `mcp-servers.json` ([The config file](#the-config-file)). The preset requires a Node.js version supported by rea in that folder (see the managed-install requirements below). A row created from it still needs **Test connection** and **Approve tools** like any other.

### Installing rea into Jenny (Windows)

The Installation section in the connection's Details is planned for the next renderer
slice; the managed-install backend is available now. Create the `rea` connection first
and turn it off before installing or uninstalling.

The managed install requires Node.js in `C:\Program Files\nodejs`: version 22.19.0 or
later in the 22 series, 24.11.0 or later in the 24 series, or 26.0.0 and later.
Jenny checks that Node before downloading anything. After explicit confirmation it
downloads the pinned `rea-agents@6.4.0` tarball from `registry.npmjs.org`
(1,825,761 bytes), checks its SHA-256 fingerprint and exact size, then uses that Node
to run npm with lifecycle scripts disabled. npm downloads the package's dependencies;
the installed files use approximately 102 MB (107,000,000 bytes).

Jenny installs and runs the existing `rea mcp doctor --json` readiness check in staging
before publishing to `rea\current` inside Jenny's profile. A download, fingerprint,
npm or readiness failure removes staging and preserves an existing install. Publishing
moves the previous install aside and puts it back if the new one cannot take its place;
a run interrupted between those two steps is repaired at the next start. Once published, Jenny changes the connection to the trusted Node plus the
installed `scripts\rea.mjs`, keeping its environment and limits. The row returns to
**Review required**, disabled: run **Test connection**, review and approve its tools
again before using it. If the row rewrite fails, the install stays on disk.

The packaged `reverse-engineer-anything` skill is copied to
`%USERPROFILE%\.companion\skills\reverse-engineer-anything`, replacing that skill
folder with `SKILL.md` and regular Markdown files in `references\`; links are skipped.
A skill-copy failure is reported separately and leaves the rea install usable.
User skills remain an explicit choice: turn on **Enable user skills** to expose the
copied skill. Uninstall removes Jenny's managed rea folder, restores the `npx` preset
command only when the row still points at the managed install, and keeps the skill copy.
Version status compares against Jenny's committed pin without querying the registry;
a later Jenny release can change that pin. The manual alternative is the
[rea package page](https://www.npmjs.com/package/rea-agents) and the steps below.

## Installing a server's skill by hand (rea)

Some MCP servers ship a [skill](../SKILLS.md) that teaches the model how to use their tools. rea (`rea-agents`) ships `reverse-engineer-anything`: a `SKILL.md` plus a `references/` folder of six Markdown files. The Installation section in the connection's Details (next renderer slice) will copy it as part of the managed install. Until then, or as a fallback, copy it by hand:

1. Get the packaged copy. Run `npm install --prefix <folder> rea-agents@6.4.0` yourself (the same install the Troubleshooting entry below uses for a faster start) and find `<folder>\node_modules\rea-agents\skills\reverse-engineer-anything\`. If you run rea through `npx`, the same folder is inside the npx cache, if you can find it. Use the packaged copy, not the one in rea's repository: `rea doctor` checks for the skill version that ships with the package.
2. Copy the whole folder, `SKILL.md` and `references\` together, to `%USERPROFILE%\.companion\skills\reverse-engineer-anything\`. On Linux and macOS it is the same folder under the home directory.
3. Turn on user skills: Settings → **Extensions** → Skills → **Enable user skills**. User-scope skills are off by default, and enabling the scope exposes every skill in that folder to the model, not only this one.
4. Verify. Ask Jenny to call `load_skill(name="reverse-engineer-anything", scope="user")`; it returns the `SKILL.md` body. A reference file that the body names loads with `load_skill(name="reverse-engineer-anything", scope="user", reference="references/native-and-artifacts.md")`.

On `ollama`, `vllm` and `openai-compatible` engines the automatic skill index is hidden by default ([Automatic indexing](../SKILLS.md#automatic-indexing)), so ask for the `load_skill` call directly there.

## Troubleshooting

- **Windows: `npx` (or another `.cmd` shim) is not found.** Jenny starts stdio servers without a shell and with a scrubbed `PATH` (the command's own folder plus `System32`), so a bare `npx` cannot be resolved. Use the absolute shim as the command, for example `C:\Program Files\nodejs\npx.cmd` with args `-y rea-agents@6.4.0 mcp` (measured 2026-10-12: the first start with a primed npm cache takes about 23 s, so give the row an `inspect_timeout_seconds` of 60 or more). Faster and shim-free: run `npm install --prefix <folder> rea-agents@6.4.0` yourself once, then use `C:\Program Files\nodejs\node.exe` with args `<folder>\node_modules\rea-agents\scripts\rea.mjs mcp` (about 3 s). `cmd.exe /c npx ...` does not work under the scrubbed `PATH` either. Only Windows launch forms have been verified; on Linux and macOS use an absolute path to the server's entry script.
- **Test connection fails immediately.** The failure reason is shown on the row. The usual cause is a missing runtime for the server itself (`npx` not on `PATH`, a Python package missing). Run the same command in a terminal to see the raw error. If a tool breaks Jenny's review limits (for example a description over 2,048 characters or a schema nested more than 32 levels deep), the inspection result and the sidecar log name that tool, the limit and the measured value instead of a bare `ValueError`.
- **"URL points to a private or local address, which is blocked."** Remote SSE connections may not target loopback or private-network addresses. Run a local server over stdio instead.
- **Zero tools found.** The server started but did not answer the tool-list request. Check its own logs or run it by hand.
- **Row shows Failed or Cooling down.** The server crashed after approval. Jenny retries with a bounded cooldown; if it keeps failing, test the connection again to see the current error.
- **Tools disappeared after an update to the server.** Its advertised tool set changed, so the row went back to **Review required**. Approve it again.
- **A read-only tool still asks for approval.** `read_only_auto_allow` is off for that row, or the server does not claim `readOnlyHint` for the tool, or it also claims `openWorldHint` or `destructiveHint`; a rule or per-tool setting of **Ask** still asks either way.
- **Test connection is greyed out with "MCP inspection is unavailable until the local runtime is ready."** The backend is still starting. Wait for the titlebar health indicator, then retry.

## Next

- Tour the built-in tool families: [docs/TOOLS.md](../TOOLS.md).
- Pair the connection with a reusable [skill folder](../SKILLS.md).
