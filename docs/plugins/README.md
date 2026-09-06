# Building plugins for Jenny

Public authoring guide for people and agents who want to extend Jenny. This directory is the entry point; the broader application architecture and security boundaries are documented in `../ARCHITECTURE.md`, `../SECURITY_MODEL.md`, and `../PLUGIN_SECURITY.md`.

**Status (2026-09-02):** these pages cover trust tiers, manifest shape, sandbox and full-host boundaries, developer installation, signing-pipeline shape, and testing. They are still thin on a complete third-party packaging walkthrough, per-kind content examples, and exact consent-screen examples.

## Read in this order

1. `AUTHORING_OVERVIEW.md`: what a plugin is, the four trust tiers, permissions, and what each tier may never do.
2. `MANIFEST_REFERENCE.md`: the manifest, contribution kinds, and a self-contained V5/V6 shape example.
3. `PANEL_VIEWS.md`: sandboxed panels and the view bridge.
4. `FULL_HOST_PROVIDERS.md`: native host processes, the host protocol, leases, and cleanup proofs.
5. `PACKAGING_AND_SIGNING.md`: the developer loop, the offline signing kit, and what public distribution requires today.
6. `TESTING.md`: contract parity, conformance kits, budgets, and the owner-run smoke.
7. `AGENT_CHECKLIST.md`: a machine-oriented, end-to-end checklist for coding agents.

## Two facts to know before you start

- Plugin code never runs inside Jenny's Electron main process, renderer, or Python sidecar. Declarative content is interpreted, restricted components run in a no-WASI helper, panels run in a sandboxed renderer that only sees a bridge, and native hosts run as supervised child processes. Design for that from the first line.
- The default-on developer profile described in `PACKAGING_AND_SIGNING.md` accepts unsigned local packages, labels them `developer (unsigned)`, and refuses privileged contribution kinds. Set `JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=0` to disable that intake path.
