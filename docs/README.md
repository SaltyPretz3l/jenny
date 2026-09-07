# Jenny Documentation

Jenny is a local-first desktop AI assistant. Start with the repository [README](../README.md);
this folder holds the deeper documentation.

## Getting started

- [Tutorials](tutorials/README.md) — your first chat, adding an MCP server, customizing the personality.
- [FAQ](support/FAQ.md)
- [Troubleshooting](support/TROUBLESHOOTING.md) — common problems, plus step-by-step runbooks for the tricky ones.
- [Error codes](operations/error-codes.md)

## Using and operating Jenny

- [Built-in tools reference](TOOLS.md) — what every tool family can do and the approval rules around it.
- [Uninstall & data recovery](operations/UNINSTALL_AND_DATA_RECOVERY.md)
- [Versioning & migration](operations/versioning-and-migration.md) — how config and session data survive upgrades.
- [llama-server acceleration](operations/LLAMA_SERVER_ACCELERATION.md) — how the managed `llama-server` engine speeds up verified models, and its kill switch.
- [Running a hand-managed llama-server](operations/QWEN36_LOCAL_RUNTIME.md) — the older recipe for hosting a large GGUF yourself and pointing Jenny at it as an OpenAI-compatible endpoint.

## Extending Jenny

Jenny is meant to be extended. These guides are written for a developer building
on top of a released Jenny, not for someone working on Jenny itself.

- [Skills & personality](SKILLS.md) — author a `SKILL.md`, give it a `/command`,
  choose its scope, and shape Jenny's voice through the personality workspace.
- [Themes & palettes](THEMES.md) — the two theming paths: a distributable plugin
  `theme` contribution, or a built-in palette contributed to the shell.
- [Plugin authoring](plugins/README.md) — the manifest, contribution kinds,
  packaging, and how to install a plugin you are still developing.
- [Plugin security & trust model](PLUGIN_SECURITY.md) — sandbox tiers, signing,
  and what a plugin is never allowed to do.
- [Adding an MCP server](tutorials/02-adding-mcp-server.md) — connect an external
  MCP server and watch its tools appear.
- [Built-in tools reference](TOOLS.md) — the tool surface a skill or plugin can rely on.

## Building and trust

- [Building & distribution](BUILDING.md) — build from source, what a packaged release contains, provenance.
- [Security model](SECURITY_MODEL.md) — prompt-injection defense and the Python runtime threat model.
- [Plugin security & trust model](PLUGIN_SECURITY.md) — sandbox tiers, catalogs, and MCP trust.
- [Security policy](../SECURITY.md) — reporting vulnerabilities.

## Design

- [Architecture](ARCHITECTURE.md) — how the Electron shell, backend services, and Python sidecar fit together.
- [Architecture decision records](adr/README.md) — the "why" behind the big design calls.
