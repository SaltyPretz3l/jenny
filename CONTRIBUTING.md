# Contributing to Jenny

Thanks for your interest in Jenny. This page covers how to get a dev environment running, which gates to run before opening a PR, and — importantly — how changes actually land in this project.

## How changes land here (read this first)

Development happens in a **private repository**; this public repo is a curated export of it, refreshed with each release. That has one practical consequence for contributors: the maintainer hand-ports accepted changes upstream, so your PR may be **closed as landed with credit** rather than merged directly. That's the normal path, not a rejection — your change ships in the next release and the PR is referenced.

Jenny is also a solo-maintained hobby project. Issues and PRs are read, and good ones genuinely help, but there are no response-time promises. For anything bigger than a focused fix, **open an issue before writing code** so effort isn't wasted on something out of scope.

## Scope: what fits

Jenny is deliberately a **local-first** harness for small-to-mid local models — coding workflows, data-viz artifacts, and well-bounded tool calls, plus a light companion shell. Good fits: reliability fixes, tool-call robustness, local-model compatibility, accessibility, docs. Out of scope: anything requiring cloud services, accounts, or telemetry; previously removed surfaces (cloud companions, speech, computer-use) stay removed.

## Development environment

Prerequisites: **Node.js 22.23.2+ (22.x) or 24.19.0+ (24.x)**, npm 10+, **Python 3.11+**. A local model runtime ([Ollama](https://ollama.com/)) is needed to *use* the app; the test gates below run without one.

```sh
npm install
py -3 -m venv .venv            # macOS/Linux: python3 -m venv .venv
./.venv/Scripts/python -m pip install -e ".[dev]"   # macOS/Linux: ./.venv/bin/python
npm run dev                    # launches the app via the dev launcher (start.js)
```

## Gates before you open a PR

Run these locally; CI runs the same set on every PR.

```sh
npm run lint                     # eslint
npm run test:dist                # the supported distribution gate (release metadata,
                                 # migrations, protocol contracts, tool loop)
npm test                         # full deterministic Node suite — for non-trivial changes
python -m pytest tests/sidecar   # sidecar (Python) suite — when you touch sidecar/
```

If a gate fails for a reason that looks unrelated to your change, say so in the PR rather than papering over it.

## Architecture boundary (hard rules)

- `sidecar/ai/` must not import from the Electron side (`main.js`, `services/`) or `renderer/`.
- Electron and Python communicate **only** through JSON-RPC over stdio; the schema lives in [`sidecar/protocol.py`](sidecar/protocol.py).
- The sidecar is stateless per request; Electron owns conversation persistence.
- Secrets live in Electron `safeStorage` only — never in environment variables, plaintext config, or the renderer.
- Local-first engine posture: no new cloud engine paths.

## Conventions that catch new contributors

- JSON wire keys and persisted payloads are `snake_case`; JS runtime identifiers are `camelCase`; Python is `snake_case`. Boundary crossings normalize at ingest.
- Notification names are dotted-snake (`tool.executing`); persisted turn-event kinds are bare snake (`tool_executing`).
- A model-invocable capability is a `tool` — don't introduce `action` or `capability` as synonyms.
- Error codes use `CMP-<DOMAIN>-<NNNN>`.
- Branch prefixes: `feat/`, `fix/`, `docs/`, `chore/`.
- Bug fixes come with a focused regression test that fails before the fix and passes after.

## Commits and pull requests

- One logical change per commit; fix and unrelated cleanup are separate commits.
- Short imperative subject (under 70 chars), body paragraph when the diff isn't self-explanatory.
- In the PR description: what changed, why, and which gates you ran (the PR template asks).

## Where to file what

- **Bug / feature** — a GitHub issue (the templates ask for the right details).
- **Security finding** — the private flow in [SECURITY.md](SECURITY.md); never a public issue.
- **Questions** — the FAQ ([docs/support/FAQ.md](docs/support/FAQ.md)) and troubleshooting guide ([docs/support/TROUBLESHOOTING.md](docs/support/TROUBLESHOOTING.md)) cover the common ones; otherwise open an issue.
- **Deeper context** — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the two-process design, [docs/adr/](docs/adr/) for the decision record, [docs/TOOLS.md](docs/TOOLS.md) for per-tool behavior.

Please also read the [code of conduct](CODE_OF_CONDUCT.md) — participation in the project's spaces assumes it.

## Adding a built-in tool

A built-in tool is a Jenny-owned sidecar handler exposed through the
`jenny_local_tools` stdio MCP subprocess. Adding one changes a public tool
contract and requires a repository change and a new Jenny build. Follow the
existing `connections_list` path for a compact end-to-end example:
`services/tools/tool-manifest.json` →
`sidecar/ai/tools/builtins/connections.py` →
`sidecar/ai/tools/registry.py` →
`sidecar/ai/container_mcp_servers.py` →
`sidecar/ai/mcp/builtin_server.py`.

1. **Declare the tool in `services/tools/tool-manifest.json`.** Add the
   canonical `name`, description, owner, family, safety fields, surfaces,
   availability, and JSON Schema parameters. The manifest is the descriptor
   and input-schema source for both Electron policy and the sidecar catalog;
   do not duplicate the schema in the handler module. For a sidecar built-in,
   use `owner: "sidecar"`, `source_kind: "builtin"`, and include the surfaces
   on which the implementation is actually exposed. Set
   `availability.workspace_required` deliberately rather than relying on a
   default.

2. **Implement the handler under `sidecar/ai/tools/builtins/`.** Use a small,
   cohesive module (or package for an established family), follow the existing
   `(arguments, workspace)` handler signature, validate untrusted inputs, keep
   outputs bounded and redacted, and return the established string or
   `ToolHandlerResult` shape. Add focused handler tests beside the relevant
   sidecar tool tests. New leaf modules are subject to the six-internal-import
   cap; do not add an exemption merely to make the check green.

3. **Bind the exact manifest name in `sidecar/ai/tools/registry.py`.** Add the
   handler (prefer the existing lazy `(module, handler)` pattern where it
   applies) and insert it into the dictionary returned by
   `build_tool_bindings`. The binding key must exactly equal the manifest
   `name`. This mismatch fails silently: `build_tool_catalog` skips a binding
   whose key is absent from the manifest catalog, and registry construction
   skips a manifest descriptor that has no registered handler. The tool simply
   disappears instead of producing a startup error.

4. **Add and consume the availability flag.** Follow the `tools_*_enabled`
   pattern in `sidecar/ai/config.py`, add the corresponding `RuntimeConfig`
   field in `sidecar/ai/config_models.py`, use the same key in the manifest's
   `availability.config_flag`, and gate the binding in `build_tool_bindings`.
   Keep all defaults consistent. Add flag-on and flag-off tests so omitted,
   malformed, and explicit values have the intended behavior.

5. **Carry the flag across the built-in MCP subprocess boundary.** Live chat
   does not execute these bindings in the parent sidecar process. Add the
   resolved flag to `_default_mcp_servers` in
   `sidecar/ai/container_mcp_servers.py` (re-exported from
   `sidecar/ai/container.py`), add and parse the matching argument in
   `sidecar/ai/mcp/builtin_server.py`, and pass the parsed value into the config
   used to build that server's bindings. Without both sides, an in-process
   registry test can pass while the tool is absent from the live chat path.
   Do not put secrets on this argv boundary.

6. **Document the public behavior in [`docs/TOOLS.md`](docs/TOOLS.md).** Add the
   tool to the appropriate family summary and document its approval posture,
   workspace requirement, flag/default, parameters, bounds, failure behavior,
   and source. This checkout has no `docs/tools/` family-guide directory or
   README; `docs/TOOLS.md` is the current tool guide enforced by the checks.

7. **Update the internal audit row.** Add exactly one row for the new manifest
   name to `docs/reports/TOOL_AUDIT_MATRIX.md`. That report is private-repo
   process evidence and is excluded from the public export, so public docs must
   not link to it. The Node parity test nevertheless requires its tool-name
   rows to match the canonical manifest exactly.

8. **Refresh both owning workspace manifests.** A manifest edit matches
   `services/` in `docs/manifests/electron-wiring.md` and `services/tools/` in
   `docs/manifests/sidecar-runtime.md`. The workspace-manifest freshness check
   evaluates every matching domain, so update both with the new entrypoint,
   tests, or extension rule as appropriate. These manifests are also excluded
   from the public export; name them as repository paths, not public links.

### Gates you will trip

| Check or test | What it demands | How to satisfy it |
|---|---|---|
| `scripts/checks/check_doc_as_code.py` | A changed built-in module must be paired with either `docs/TOOLS.md` or `services/tools/tool-manifest.json`; a changed tool manifest must be paired with either `docs/TOOLS.md` or the Electron wiring manifest. It does not require a `docs/tools/*.md` file. | Change the canonical manifest and update `docs/TOOLS.md`; the required workspace-manifest edits also satisfy the manifest-side alternative. |
| `scripts/checks/check_workspace_manifest.py` | Every non-exempt domain whose `paths:` match a changed file must have its manifest changed. `services/tools/tool-manifest.json` matches both `electron-wiring` and `sidecar-runtime`. | Update both `docs/manifests/electron-wiring.md` and `docs/manifests/sidecar-runtime.md`. |
| `scripts/checks/check_import_fanout.py` | A non-exempt leaf under `sidecar/ai/` may import at most six sibling/internal modules. New built-in modules are not automatically exempt. | Keep the handler cohesive and within the cap; split real responsibilities instead of extending `EXEMPT`. |
| `scripts/checks/check_sidecar_reachability.py` | Every sidecar module must be reachable from startup, a known dynamic edge, or an explicitly justified deferred status. Lazy registry imports are dynamic edges, not deferred modules. | Add a lazily imported handler module to `KNOWN_DYNAMIC_ENTRYPOINT_IMPORTS` for `sidecar.ai.tools.registry`; do not put a live tool in `DEFERRED_MODULE_STATUS`. |
| `tests/sidecar/ai/tools/test_lazy_tool_bindings.py` | Every lazy `(module, handler)` target must resolve before release. | Register the exact import path and callable name and include it in the test's binding coverage. |
| `tests/sidecar/ai/test_container.py` and `tests/sidecar/ai/mcp/test_builtin_server_feature_flags.py` | Tool flags must survive argv construction, parsing, and built-in server catalog assembly. | Assert both enabled and disabled subprocess configurations, not only `build_tool_bindings` in process. |
| `tests/sidecar/runtime/test_request_dispatch_dispatch.py` | Workspace-root requirements are derived from the live canonical catalog and must still respect request allow/deny filters. The test does not maintain a hardcoded list of every workspace-required tool. | Set `availability.workspace_required` correctly and keep the catalog/filter tests green; do not add the tool to a nonexistent per-tool list. |
| `tests/tool-manifest-electron-parity.test.js` | Manifest metadata must remain valid, and the internal audit matrix's tool rows must exactly equal the manifest names. This is a Node-lane failure, not a Python policy-hook check. | Add the audit row and run this test explicitly before relying on the pre-commit policy suite. |

### Verify

Run the policy suite, the focused sidecar catalog/registry/subprocess tests, and
the Node parity lane that checks the internal audit matrix:

```sh
npm run check:policy
python -m pytest tests/sidecar/ai/tools/test_catalog.py tests/sidecar/ai/tools/test_registry.py tests/sidecar/ai/tools/test_lazy_tool_bindings.py tests/sidecar/ai/test_container.py tests/sidecar/ai/mcp/test_builtin_server_feature_flags.py
node scripts/run-node-tests-safe.js tests/tool-manifest-electron-parity.test.js --timeout-ms=600000
```

Also run the focused tests for the handler itself. Before opening a PR, finish
with the broader sidecar and Node gates listed above under “Gates before you
open a PR.”
