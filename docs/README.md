# Jenny Documentation

Jenny is a local-first desktop AI assistant. Start with the repository [README](../README.md);
this folder holds the deeper documentation. The guides track current source;
[release notes](../RELEASE_NOTES.md) identify the published version and its limits.

## Getting started

- [Tutorials](tutorials/README.md) — your first chat, adding an MCP server, customizing the personality.
- [FAQ](support/FAQ.md)
- [Troubleshooting](support/TROUBLESHOOTING.md) — common problems, plus step-by-step runbooks for the tricky ones.
- [Error codes](operations/error-codes.md)

## Using and operating Jenny

- [Built-in tools reference](TOOLS.md) — what every tool family can do and the approval rules around it.
- [Uninstall & data recovery](operations/UNINSTALL_AND_DATA_RECOVERY.md)
- [Browser hosting quick start](operations/HOSTED_QUICKSTART.md) — experimental Docker setup, owner login and model endpoint.
- [Hosting and recovery](operations/HOSTED_JENNY.md) — profile ownership, private access and backup.
- [Hosted execution boundaries](operations/HOSTED_EXECUTION.md)
- [Desktop command sandbox](operations/DESKTOP_COMMAND_SANDBOX.md) — optional offline Docker commands with discarded file changes.
- [Image generation](TOOLS.md#image-generation) — native desktop image tool, setup and limits.
- [Versioning & migration](operations/versioning-and-migration.md) — how config and session data survive upgrades.
- [llama-server acceleration](operations/LLAMA_SERVER_ACCELERATION.md) — how the managed `llama-server` engine speeds up verified models, and its kill switch.
- [Running a hand-managed llama-server](operations/QWEN36_LOCAL_RUNTIME.md) — the older recipe for hosting a large GGUF yourself and pointing Jenny at it as an OpenAI-compatible endpoint.

## Extending Jenny

Extend Jenny with skill folders and standalone MCP servers, both managed in
Settings › Extensions. There is no plugin system.

- [Skills & personality](SKILLS.md) — author a `SKILL.md`, give it a `/command`,
  choose its scope, and shape Jenny's voice through the personality workspace.
- [Themes & palettes](THEMES.md) — adding a built-in palette to the shell.
- [Adding an MCP server](tutorials/02-adding-mcp-server.md) — connect an external
  MCP server and watch its tools appear.
- [Built-in tools reference](TOOLS.md) — the tool surface a skill can rely on.

## Building and trust

- [Building & distribution](BUILDING.md) — build from source, what a packaged release contains, provenance.
- [Security model](SECURITY_MODEL.md) — prompt-injection defense and the Python runtime threat model.
- [Security policy](../SECURITY.md) — reporting vulnerabilities.

## Design

- [Architecture](ARCHITECTURE.md) — how the Electron shell, backend services, and Python sidecar fit together.
- [Architecture decision records](adr/README.md) — the "why" behind the big design calls.
