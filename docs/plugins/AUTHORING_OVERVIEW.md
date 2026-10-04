# Authoring overview

## What a plugin is

A Jenny plugin is a zip archive (`.jenny-plugin`) containing a root `plugin.json`, `META-JENNY/signature-bundle.json`, and the files declared by the manifest. Trusted distribution packages are signed; the developer profile can accept an unsigned package whose bundle is structurally valid. Jenny validates every byte against frozen contracts, records the package in a per-user store as a *generation*, and only then publishes its contributions. Enable, disable, update, and uninstall are transactional; a half-applied generation never becomes active.

Contracts are versioned V1 through V6 and frozen. V4's restricted kinds and V6's privileged kinds are retired; the retained schemas also describe compatibility fields and lower-tier contributions. A plugin declares the contract versions it uses; unknown versions or fields fail closed. Schema validation, package intake and activation eligibility are separate checks.

## What you can build, and what each tier may do

| Tier | Contributions | Runs where | May never |
|---|---|---|---|
| Declarative (V1-V3 manifests) | `skill`, `prompt`, `theme`, `settings_schema` | Interpreted by Jenny | Execute code, touch the filesystem, open sockets |
| Sandboxed view (V5 manifest) | `panel` (HTML/JS/CSS) | Sandboxed renderer partition with deny-all permissions, CSP, no navigation | Receive credentials, local paths, or Node APIs; talks only to the view bridge |
| Retired (2026-10-02) | `mcp_descriptor`, `command`, `workflow`, `restricted_*`, `session_provider`, `native_mcp`, `engine_adapter`, `hook`, `provider_descriptor`, `setup_scene` | Nothing | Be declared by a new package |

Retired 2026-10-02 (plugin platform retirement stage 4): plugin-supplied remote MCP, `command` and `workflow`, the Wasm restricted host, provider descriptors and setup scenes, the privileged full host (including the `privileged_plugins` flag and high-consequence consent), catalogs, offline mirrors, rollback, and managed (enterprise) policy. The source of truth is `RETIRED_CONTRIBUTION_KINDS` in `services/plugins/runtime/declarative-compiler-constants.js`. A new package that declares any retired kind is refused at install, enabling a leftover installed package returns `POLICY_BLOCKED` with `contribution_kind_retired`, and leftover packages stay listed with the retired parts inert. The long-term direction (`NEXT_STEPS.md` row 27) is that user extensions become skill folders (`../SKILLS.md`) and MCP servers configured in core rather than plugins. The retirement notes live in `../PLUGIN_SECURITY.md`.

Activation is checked by `evaluateActivationEligibility` in `services/plugins/runtime/declarative-compiler.js`: V1/V2 packages require the current-key `jenny-official` publisher, no permissions and no dependencies. V1 may contain only `skill` and `prompt`; V2 additionally supports `theme` and `settings_schema`. V3 packages may contain only permissionless `skill` and `prompt` (the frozen allow-list also names the retired `mcp_descriptor`). V5 packages may contain only surviving view kinds (`panel`, `artifact_renderer`) with permissions limited to `ui.view`, `network.fetch`, and `secret.brokered_use` (`services/plugins/runtime/stage7-eligibility.js`). Those permission names do not restore the deleted network or credential broker. An unsigned V1 third-party package can pass intake and still be ineligible to enable.

For new extensions, prefer skill folders or standalone MCP as directed by the retirement roadmap. Use the surviving plugin shapes only within an explicitly scoped maintenance task.

Skills expose a `command` frontmatter key for `/command` invocation, documented in [Skills](../SKILLS.md); `always: true` is discouraged because it pastes the skill body into every turn.

## Permissions

The frozen V1 manifest schema's `requested_permissions` is an enum (max 16 entries): `chat.read`, `chat.write`, `fs.workspace.read`, `fs.workspace.write`, `network.fetch`, `mcp.stdio`, `ui.view`. The frozen schemas still list the retired permissions (`mcp.stdio`, `network.remote_mcp`, `network.restricted_runtime`, `runtime.full_host`, `runtime.native_mcp`, `runtime.engine_adapter`, `runtime.hook`, `secret.value_delivery`), but a package that needs them can only do so for a retired kind, and install refuses that package. Permissions are shown to the user at install. Managed policy no longer exists, so nothing fences them from the enterprise side.

## Invariants you inherit

- Plugin code is never imported into Electron main, the renderer, or the sidecar.
- Plugin network acquisition and the runtime network broker are retired. Views load only digest-bound packaged assets; they cannot fetch arbitrary remote hosts.
- Secrets live in `safeStorage`; plugin assets never see credential values.
- Every contribution is bound to a package digest; editing files on disk creates a new candidate that must be re-validated.
- Errors are `CMP-PLUGIN-*` codes (see `TESTING.md`), never free text.

## Official-package coverage

Jenny's official packages that exercised provider-descriptor, setup-panel and full-host session-provider shapes were archived or retired on 2026-10-02. ChatGPT and image generation are core features. No official package source tree or bundle remains in this checkout, and `config/plugins/bundled-plugins.json` is empty. The checked-in examples demonstrate schemas and intake; their manifest version and publisher determine whether they can activate.

## Empty folder to installed: a permissionless prompt fixture

This walkthrough is a minimal intake fixture: one V1 `prompt`, no
permissions, no executable, and no dependencies. The checked-in copies are
[`plugin.json`](examples/prompt-plugin/plugin.json),
[`warm-review-prompt.json`](examples/prompt-plugin/content/warm-review-prompt.json),
and
[`signature-bundle.json`](examples/prompt-plugin/META-JENNY/signature-bundle.json).
Create this exact tree in a working directory outside the Jenny repository:

```text
astra-dogfood-prompt/
|-- plugin.json
|-- content/
|   `-- warm-review-prompt.json
`-- META-JENNY/
    `-- signature-bundle.json
```

The content file is complete:

```json
{
  "content_schema_version": 1,
  "publisher_id": "astra-labs",
  "plugin_id": "astra-dogfood-prompt",
  "contribution_id": "warm_review_prompt",
  "payload": {
    "kind": "prompt",
    "template": "Review the supplied text. Return one concise strength, one concrete risk, and one actionable next step."
  }
}
```

The complete minimal V1 manifest is:

```json
{
  "manifest_schema_version": 1,
  "publisher_id": "astra-labs",
  "plugin_id": "astra-dogfood-prompt",
  "name": "Astra Warm Review Prompt",
  "version": "1.0.0",
  "contract_versions": {
    "manifest": 1,
    "declarative_content": 1,
    "operation_receipt": 1,
    "cleanup_state": 1
  },
  "contributions": [
    {
      "kind": "prompt",
      "contribution_id": "warm_review_prompt",
      "name": "Warm Review",
      "content_path": "content/warm-review-prompt.json",
      "content_sha256": "68202203d15b68861a0194a51cca810ce023bc82442b9de96fbdac5f6be891a8"
    }
  ],
  "requested_permissions": []
}
```

Digests bind exact bytes, including line endings. Compute them only after the
file is final. From the plugin directory, Windows PowerShell is:

```powershell
(Get-FileHash -Algorithm SHA256 .\content\warm-review-prompt.json).Hash.ToLowerInvariant()
(Get-FileHash -Algorithm SHA256 .\plugin.json).Hash.ToLowerInvariant()
```

A POSIX shell with `sha256sum` is:

```bash
sha256sum content/warm-review-prompt.json | awk '{print $1}'
sha256sum plugin.json | awk '{print $1}'
```

For the checked-in LF-terminated files, the results are respectively
`68202203d15b68861a0194a51cca810ce023bc82442b9de96fbdac5f6be891a8`
and
`5d56df92a203608893d6b43baa7e35d88b67d7a16105324770fd1c595f19964f`.
Put the content digest in `plugin.json`, then recompute the manifest digest.

Developer intake still requires the exact three-key bundle and four-key
signature entry enforced by `local-package-intake.js`. The 88-character value
below is 64 zero bytes in canonical base64. It is a structural placeholder,
not a signature: developer intake skips publisher trust and Ed25519 checking,
but still validates this shape and every `signed_payload` path and digest.

```json
{
  "signature_bundle_version": 1,
  "signed_payload": {
    "canonicalization_version": 1,
    "publisher_id": "astra-labs",
    "plugin_id": "astra-dogfood-prompt",
    "package_version": "1.0.0",
    "contract_versions": {
      "package_semver": "1.0.0",
      "manifest_schema_version": 1,
      "contribution_contract_version": 1,
      "capability_abi_version": 1,
      "data_schema_version": 1
    },
    "entries": [
      {
        "path": "content/warm-review-prompt.json",
        "sha256": "68202203d15b68861a0194a51cca810ce023bc82442b9de96fbdac5f6be891a8"
      },
      {
        "path": "plugin.json",
        "sha256": "5d56df92a203608893d6b43baa7e35d88b67d7a16105324770fd1c595f19964f"
      }
    ]
  },
  "signatures": [
    {
      "algorithm": "ed25519",
      "canonicalization_version": 1,
      "key_id": "developer-placeholder",
      "signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    }
  ]
}
```

The archive must contain those three files at the paths shown above, with no
wrapping `astra-dogfood-prompt/` directory. From the Jenny repository root,
this one-off recipe uses the repository's deterministic zip fixture assembler
and a fixed entry order:

```powershell
node -e "const fs=require('node:fs'),path=require('node:path');const {assembleCompressedZip}=require('./tests/helpers/plugins/zip-fixture-builder');const root=path.resolve(process.argv[1]),out=path.resolve(process.argv[2]),names=['plugin.json','content/warm-review-prompt.json','META-JENNY/signature-bundle.json'];const entries=names.map(name=>({name,data:fs.readFileSync(path.join(root,...name.split('/')))}));fs.writeFileSync(out,assembleCompressedZip(entries).bytes);" "C:\path\to\astra-dogfood-prompt" "C:\path\to\astra-dogfood-prompt.jenny-plugin"
```

Running that command twice over unchanged bytes produces the same archive.
No generic third-party packager ships today; this repository-local recipe is
the verified bridge, and [Packaging and signing](PACKAGING_AND_SIGNING.md)
explains the boundary.

Before packaging, validate the complete folder with the supported authoring
command:

```powershell
npm run plugin:validate -- C:\path\to\astra-dogfood-prompt
```

Then validate the built archive. The same command runs production
developer-profile intake for archive targets:

```powershell
npm run plugin:validate -- C:\path\to\astra-dogfood-prompt.jenny-plugin
```

The verified example produced:

```text
{"manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true}}
{"walkthrough_package":{"deterministic":true,"archive_sha256":"5561afb7b8bb721c04ff50ccae24b72c3eae75220c49e906fa1ece19e08f1d55","intake":{"ok":true}}}
{"ok":true,"publisher_id":"astra-labs","plugin_id":"astra-dogfood-prompt","version":"1.0.0","contributions":["prompt"]}
```

### Install from a cold start and check eligibility

Unsigned developer intake is off by default. Start Jenny with
`JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=1`; without it, stop: an unsigned package
is refused. Then open **Settings -> Plugins & Extensions**, choose **Install
plugin**, select the archive, and wait for the exact status text **Plugin
installed — inactive.** The Installed row must show **developer (unsigned)**.
Open **Details** and inspect activation eligibility. This V1 `astra-labs`
fixture is not eligible: V1 activation requires the current-key
`jenny-official` publisher and reports `not_first_party` for this identity.
Successful validation and installation do not change that rule. Do not expect
its prompt to load into a chat.

There is no consent screen for this permissionless declarative tier: local
install and enable are classified as ordinary operations, and the manifest
requests no permissions. The exact install-surface copy is: **Drop a
.jenny-plugin file here or use Install plugin. Unsigned plugins are labelled
and run in the developer profile.** The trusted high-consequence consent window (full-host enablement and
secret-value delivery) was retired with the privileged tier on 2026-10-02;
there is no consent window to expect or bypass here.

The captured validation/intake output above is fixture evidence; it is not an
in-app qualification record. V3 permissionless skill/prompt packages have a
different activation rule, but this walkthrough deliberately preserves its
V1 schema and exact-byte digests.
