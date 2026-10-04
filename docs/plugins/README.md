# Building plugins for Jenny

Maintenance and authoring guide for the surviving plugin shapes. This directory is the entry point; broader boundaries are in [Architecture](../ARCHITECTURE.md), [Security model](../SECURITY_MODEL.md) and [Plugin security](../PLUGIN_SECURITY.md).

**Reviewed 2026-10-03:** the platform is frozen for staged retirement (roadmap, row 27). Stages 2-4 removed official packages, provider/setup scenes, plugin MCP, commands/workflows, Wasm/native hosts, network acquisition, catalogs and managed policy. The survivors are declarative packages (`skill`, `prompt`, `theme`, `settings_schema`) and sandboxed `panel`/`artifact_renderer` views. New packages declaring retired kinds are refused; installed leftovers publish no authority for those parts. No official package is bundled. New extensions use [skill folders](../SKILLS.md) and core-configured MCP servers (`mcp-servers.json`; [trust model](../PLUGIN_SECURITY.md)).

## Read in this order

1. `AUTHORING_OVERVIEW.md`: what a plugin is, what is still buildable, permissions, and the retired tiers.
2. `MANIFEST_REFERENCE.md`: the manifest, the surviving contribution kinds, and complete examples.
3. `PANEL_VIEWS.md`: sandboxed panels and the view bridge.
4. `PACKAGING_AND_SIGNING.md`: the developer loop, retained fixed packager and current signing boundary; the generic offline signing kit is retired.
5. `TESTING.md`: contract parity, validator, budgets, and the owner-run smoke.
6. `AGENT_CHECKLIST.md`: a machine-oriented, end-to-end checklist for coding agents.

## Two facts to know before you start

- Plugin code is never imported into Electron main, the main renderer or Python sidecar. Declarative content is interpreted; view JavaScript runs in an isolated sandboxed renderer with a fixed bridge. Native and Wasm plugin execution are retired.
- The developer profile described in `PACKAGING_AND_SIGNING.md` accepts unsigned local packages and labels them `developer (unsigned)`. It is off by default since 2026-10-02; start Jenny with `JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=1` to turn that intake path on.
- Successful intake does not establish activation eligibility. The checked-in V1 third-party examples are schema/intake fixtures; V1/V2 activation requires the current-key first-party publisher. See `AUTHORING_OVERVIEW.md` for the version-specific rules.
