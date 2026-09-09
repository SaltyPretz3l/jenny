---
kind: docs-index
last_reviewed: 2026-09-09
---

# Jenny tutorials

Practical walkthroughs for common first-time tasks. Each tutorial assumes Jenny is installed (see the [README](../../README.md) for the Windows installer and the source setup) and walks through one end-to-end flow.

| Tutorial | Time | What you'll do |
|---|---|---|
| [01 — First chat with Jenny](01-first-chat.md) | ~10 min | Launch the app, work through the first-launch checklist, send your first message, understand what's happening. |
| [02 — Adding an MCP server](02-adding-mcp-server.md) | ~10 min | Add an MCP connection under Settings → Plugins & Extensions, review the tools it advertises, approve it, and use its tools in chat. |
| [03 — Personality customization](03-personality-customization.md) | ~5 min | Change Jenny's name, pick a voice template, write a personality note, and tell Jenny about yourself. |

For the 1.1 source candidate, the first-chat guide includes both model routes,
language/time preferences and supervision controls. Browser hosting has its own
[Docker quick start](../operations/HOSTED_QUICKSTART.md); desktop command
isolation has a separate [sandbox guide](../operations/DESKTOP_COMMAND_SANDBOX.md).
These experimental paths do not imply published packages.

If you need broader reference material, see:

- [README.md](../../README.md) — install, prerequisites, common commands.
- [docs/README.md](../README.md) — the documentation index.
- [docs/TOOLS.md](../TOOLS.md) — what each tool does and when Jenny will call it.
- [FAQ](../support/FAQ.md) and [Troubleshooting](../support/TROUBLESHOOTING.md).

Extending Jenny beyond these walkthroughs:

- [docs/SKILLS.md](../SKILLS.md) — author a skill and its `/command`; the personality file map.
- [docs/THEMES.md](../THEMES.md) — plugin theme contributions and built-in palettes.
- [docs/plugins/](../plugins/README.md) — plugin manifest, packaging, and developer install.
