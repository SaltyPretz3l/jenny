# Skills and MCP servers

Jenny has no plugin system. You extend it with skill folders and standalone MCP servers, both managed in Settings > Extensions.

## Skills

A skill is a named block of instructions Jenny can attach to a turn or load on demand. Each skill is a folder with a SKILL.md file: optional frontmatter (name, description, command, whenToUse, allowedTools) followed by the instructions.

### Where skills come from

- Bundled: skills that ship with Jenny. They are on by default.
- User: skills in your personal folder, ~/.companion/skills (on Windows, %USERPROFILE%\.companion\skills). Off until you turn on Enable user skills.
- Project: skills in the chat's project, under .jenny/skills in its folder. Off until you turn on Enable project skills. A chat in General has no project skills. Switching the open Workspace does not change an existing chat's project skills.

Enabling a user or project scope exposes every skill in that folder to the model, not only one.

The bundled skills include:

- /review: review the uncommitted changes for bugs, security problems and data loss, shown as an inline findings list.
- /verify: adversarial verification with real commands and a PASS, FAIL or PARTIAL verdict.
- /research: plan and synthesize careful research.
- /delegate: write a bounded handoff prompt for an external coding session.
- /humanize: rewrite stiff text so it sounds natural.
- /meeting: turn messy meeting notes into decisions, action items and risks.
- /insight: give Jenny's developer feedback about working in the harness.
- /po-review: review a named feature and write a handoff specification. It does not authorize implementation.

### Using a skill

- Type / as the first thing in the composer. Autocomplete lists commands and skills, searching the command, name and description, up to eight rows. Choose one with Tab, Enter or the pointer.
- Choosing a skill attaches it as a removable chip. It applies to that one message only, then the chip clears. Anything you type after the command is your prompt, for example "/verify check the current diff".
- From the command palette (Ctrl+K), skills are in the Skills group with an Attach hint.
- The model can also load a skill itself with load_skill, which reads a skill body or one reference file beside it. A skill folder may hold a references folder of extra Markdown files that its SKILL.md points to.

### Settings for skills

Settings > Extensions > Skills has Enable user skills, Enable project skills, a switch per skill, and an automatic-index control. On local engines (Ollama, vLLM, OpenAI-compatible) the automatic skills overlay is hidden by default, so ask for a skill by command or by name.

### Writing a skill

Create a folder with a SKILL.md. The command is the folder name lowercased unless you set command: a letter followed by up to 31 lowercase letters, digits or hyphens. A SKILL.md can be at most 15 KB, and Jenny reads at most 128 skill files across scopes. A skill with allowedTools lists the tools it expects. Unknown keys are ignored, and frontmatter that uses YAML anchors or aliases is rejected.

## MCP servers

MCP (Model Context Protocol) is an open protocol for tool servers. Jenny is an MCP client: an approved server's tools become Jenny's tools, named mcp__SERVER__TOOL, with your server name and the tool name in place of SERVER and TOOL.

### Add a connection

1. Open Settings > Extensions. Below Skills is MCP connections, one row per server with a status badge.
2. Press Add connection. Give it a name (a letter or digit first, then letters, digits, underscore, dot or hyphen, up to 64 characters), choose a Transport (Local stdio, where Jenny launches the server, or Remote SSE, an HTTPS endpoint), then the Command or HTTPS URL, and Arguments one per line.
3. Choose Authentication: None, Bearer token, or OAuth client credentials. Secrets are entered with Set credential and stored encrypted, never in the config file.
4. Press Create connection. The row shows Review required and nothing runs yet.
5. Press Test connection. Jenny shows the exact command or URL and asks you to confirm, starts the server, asks for its tool list, and shuts it down. Then Review shows the advertised tools, and Approve tools makes the row Approved and enabled with no restart.

Approval is tied to the exact configuration and the advertised tool set. If you edit the command, or the server later advertises different tools, the row returns to Review required and stays off until you approve it again.

### Using and trusting MCP tools

MCP tools go through the same approval pipeline as built-in tools, including Always allow rules. A server runs with the same access as any program you run; Jenny contains crashes but does not sandbox the server, so add only servers you trust.

Servers can mark tools as read-only, but those claims are untrusted metadata. The review tags tools that claim read-only, and each connection has a switch, Read-only tools run without asking. It is off by default. When on, claimed read-only tools run without a per-call approval, are retried after a reconnect, and are allowed in Plan mode. Flipping the switch returns the row to review. An explicit rule or per-tool setting of Ask still asks.

### Limits and troubleshooting

- Remote SSE connections must use HTTPS, may not point to private or loopback addresses, and are gated by a mcp_sse_enabled setting in the config file.
- MCP tools are unavailable in hosted mode and when the Docker command sandbox is enabled.
- The connections list is a front end for mcp-servers.json in Jenny's data folder. If Jenny cannot parse it the list is read-only until you fix the JSON.
- Windows: if npx is not found, use the absolute shim as the command, for example C:\Program Files\nodejs\npx.cmd, because stdio servers start without a shell and with a trimmed PATH.
- Test connection fails: the reason shows on the row; run the same command in a terminal to see the raw error. Zero tools found usually means the server did not answer the tool-list request.
- A row shows Failed or Cooling down after approval: the server crashed. Test the connection again.
- Tools disappeared after a server update: its tool set changed, so approve it again.
- MCP prompts can appear as slash commands.
