# Authoring overview

## What a plugin is

A Jenny plugin is a zip archive (`.jenny-plugin`) containing a root `plugin.json`, `META-JENNY/signature-bundle.json`, and the files declared by the manifest. Trusted distribution packages are signed; the developer profile can accept an unsigned package whose bundle is structurally valid. Jenny validates every byte against frozen contracts, records the package in a per-user store as a *generation*, and only then publishes its contributions. Enable, disable, update, and uninstall are transactional; a half-applied generation never becomes active.

Contracts are versioned V1 through V6 and frozen. A plugin declares the contract versions it uses; unknown versions or fields fail closed.

## Trust tiers and what each may do

| Tier | Contributions | Runs where | May never |
|---|---|---|---|
| Declarative (V1-V3) | `skill`, `prompt`, `theme`, `settings_schema`, `command`, `workflow`, `mcp_descriptor` (remote HTTP MCP) | Interpreted by Jenny | Execute code, touch the filesystem, open sockets |
| Restricted (V4) | One `restricted_transform`, `restricted_formatter`, `restricted_renderer`, or `restricted_compute` component | Digest-verified no-WASI Wasmtime helper, one invocation per host | Reach network, secrets, tools, or lifecycle directly; Jenny brokers everything |
| Sandboxed view (V5) | `panel` (HTML/JS/CSS) and provider descriptors | Sandboxed renderer partition with deny-all permissions, CSP, no navigation | Receive credentials, local paths, or Node APIs; talks only to the view bridge |
| Full host (V6) | `session_provider` (native executable), native MCP, `engine_adapter`, `hook` | Supervised child process under a Job Object (Windows) with leases and tree-termination proof | Load into Jenny's processes; requires `runtime.full_host`, the `privileged_plugins` gate, and high-consequence consent |

Pick the lowest tier that can do the job. Each step up adds consent, review, and packaging burden for your users.

Bundled skills expose a `command` frontmatter key for `/command` invocation; `always: true` is discouraged because it pastes the skill body into every turn.

## Permissions

`requested_permissions` is an enum (max 16 entries): `chat.read`, `chat.write`, `fs.workspace.read`, `fs.workspace.write`, `network.fetch`, `mcp.stdio`, `ui.view`. Full-host packages additionally request `runtime.full_host`. Permissions are shown to the user at install and can be fenced by managed policy.

## Invariants you inherit

- Plugin code is never imported into Electron main, the renderer, or the sidecar.
- Network is explicit: any non-local traffic needs user consent and a separately provisioned system network ceiling.
- Secrets live in `safeStorage`; plugin assets never see credential values.
- Every contribution is bound to a package digest; editing files on disk creates a new candidate that must be re-validated.
- Errors are `CMP-PLUGIN-*` codes (see `TESTING.md`), never free text.

## Official-package coverage

Jenny's official packages exercise a V5 setup panel with a declarative provider descriptor, and a V5 panel paired with a V6 full-host session provider. Those source packages are not included in the public repository, so the pages in this directory describe the relevant shapes inline.

## Empty folder to enabled: a permissionless prompt plugin

This walkthrough is the smallest installable plugin: one V1 `prompt`, no
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

### Install and enable from a cold start

Unsigned developer intake is default-on. If Jenny was started with
`JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=0`, stop: the kill switch disables this
path. Otherwise open **Settings -> Plugins & Extensions**, choose **Install
plugin**, select the archive, and wait for the exact status text **Plugin
installed — inactive.** The Installed row must show **developer (unsigned)**.
Open **Details**, then choose **Enable**.

There is no consent screen for this permissionless declarative tier: local
install and enable are classified as ordinary operations, and the manifest
requests no permissions. The exact install-surface copy is: **Drop a
.jenny-plugin file here or use Install plugin. Unsigned plugins are labelled
and run in the developer profile.** A separate trusted Jenny consent window is
reserved for high-consequence operations such as full-host enablement and
secret-value delivery; do not expect or bypass one here.

Still thin in this public guide: exact consent-screen transcripts for the
restricted, panel, and full-host tiers.
