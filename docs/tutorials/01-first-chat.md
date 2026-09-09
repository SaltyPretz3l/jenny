---
kind: tutorial
last_reviewed: 2026-09-09
---

# 01 — First chat with Jenny

This guide follows Jenny 1.1.0. Older versions may have different labels;
see the [release notes](../../RELEASE_NOTES.md).
Setup time depends mainly on whether you need to download a model.

## Before you start

Install a published Windows build, or follow the
[README source setup](../../README.md). Linux and macOS remain experimental;
use only assets actually listed for your chosen release.

Choose one model route:

- **Use Ollama on this computer:** install or select a model through setup.
  Windows and Linux support verified managed installation; macOS uses external
  Ollama installation.
- **Connect an existing server:** use a reachable Ollama, vLLM or
  OpenAI-compatible endpoint with an installed model. Jenny does not need to
  install Ollama or download that model. For source setup use
  `npm run setup -- --existing-server`, then
  `npm run dev -- --existing-server` for later launches when needed.

For browser access instead of the desktop app, use the separate
[Docker quick start](../operations/HOSTED_QUICKSTART.md).

## 1. Launch and acknowledge how Jenny works

Open the Jenny shortcut or run `npm run dev` from a prepared source checkout.
The acknowledgement explains that Jenny is software and can use tools with
your permission. Read it, tick the acknowledgement and continue to setup.
Existing profiles see it once when upgrading from a version without it.

The first-run interface language follows your operating system. Settings >
Appearance > Language selects another language; restart to apply it and any
direction change. Translations may fall back to English for newer labels.

## 2. Complete the relevant setup tiles

- **Workspace:** choose the folder for file and command tools. Those tools
  remain blocked until a root is configured.
- **Model route:** use the local model library for the Ollama route, or connect,
  validate and save your existing endpoint. A reachable server still needs a
  usable model; validation errors must be resolved before chat can run.
- **Personality:** choose a name and tone, or keep the defaults. See
  [personality customization](03-personality-customization.md).
- **Skills and tools:** review capabilities and permissions. Save your choices;
  if a read or save fails, retry instead of assuming the setting was applied.

You can finish optional steps later and reopen setup from Settings. Reopening
setup does not delete conversations.

## 3. Send a message

Type a short request, such as:

> Explain what you can help me do in this workspace.

Press Enter. The reply streams into the conversation; models that expose
reasoning also show a thinking row. The titlebar health indicator reports
engine readiness. A first reply may wait while the model loads.

If a session pauses, its indicator distinguishes an approval, a plan review
or a question awaiting input. Open that conversation and respond there.

## 4. Choose how tools may act

Start with **Ask** and review each approval's target and consequences. Actual
approval behavior follows the tool's policy; read-only inspection does not
necessarily ask. Saved Always allow choices can be reviewed and removed under
Settings > Tools > Approval rules. A path-bearing decision can be scoped to its
path; a pathless tool decision can apply to the whole tool.

**Auto** confirms once per session and displays an Auto indicator. It is not
permission to leave the app unattended: the idle guard and safety modes still
apply, and some calls always require approval. Settings > Tools exposes these
controls.

**Plan** is for inspection and proposals. It does not authorize ordinary project
edits or commands; the existing narrow plan-document capability is separate.
Review the proposed plan before switching to execution.

The optional [Docker command sandbox](../operations/DESKTOP_COMMAND_SANDBOX.md)
changes the available execution capabilities. Command-created files are
discarded; use typed file tools for durable edits.

## 5. Organize and review

Use sidebar multiselect to archive or restore several conversations. Deletion
requires confirmation and offers Undo; busy conversations are protected.
Artifacts and calendar results can be opened from the conversation.
Settings > Appearance > 24-hour time changes time formatting independently
of the interface language.

## Next

- Ask Jenny to read a file in your selected workspace.
- Add an [MCP connection](02-adding-mcp-server.md) in a supported desktop mode.
- Try a [skill](../SKILLS.md), or tune [personality](03-personality-customization.md).
- For problems, see the [FAQ](../support/FAQ.md) and
  [Troubleshooting](../support/TROUBLESHOOTING.md).
