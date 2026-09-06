# Manifest reference

Authority: `config/plugins/v1/plugin-manifest.schema.json` (frozen). This page is a human rendering; when they disagree, the schema wins and this page has a bug.

## Top level

| Field | Meaning |
|---|---|
| `manifest_schema_version` | Integer 1-6. Selects which contribution kinds and fields are legal. |
| `publisher_id`, `plugin_id` | Stable identity. `plugin_id` is kebab-case. Identity drift between versions is rejected. |
| `name`, `version` | Display name (bounded, validated display string) and semver. |
| `contract_versions` | Map of contract name to version, for example `manifest`, `generation`, `runtime_snapshot`, and for V6 `full_host_content`, `full_host_attestation`, `full_host_health`, `full_host_termination_receipt`, `native_mcp_binding`, `engine_adapter`, `hook_descriptor`, `secret_delivery_grant`, `containment_profile`, `runtime_attestation`. |
| `contributions` | Array of contribution objects (below). |
| `dependencies` | Other plugins by identity and version range. Libraries are bundled inside your package, not declared here. |
| `requested_permissions` | See `AUTHORING_OVERVIEW.md`. |

## Contribution objects

Every contribution has `kind`, `contribution_id` (snake_case), `name`, `content_path`, and `content_sha256` (digest of the content file as packaged).

Kinds by tier:

- Declarative: `skill`, `prompt`, `theme`, `settings_schema`, `command`, `workflow`, `mcp_descriptor`.
- Restricted (V4): one of `restricted_transform`, `restricted_formatter`, `restricted_renderer`, `restricted_compute`.
- View (V5): `panel`.
- Full host (V6): `session_provider` with `executable_path`, `executable_sha256`, `executable_bytes`, `platform` (`win32`, `darwin`), `architecture` (`x64`, `arm64`), `containment_profile`, `resource_class`, `secret_delivery`; plus native MCP, `engine_adapter`, and `hook` descriptors.

## Complete V1 declarative examples

The frozen V1 declarative-content schema has exactly seven kinds. Each row
below links a complete manifest and complete content file; the digest in each
manifest is the SHA-256 of the linked content file's exact LF-terminated bytes.
The `command` and `workflow` examples also include the prompt contribution they
target, so their references are usable rather than illustrative placeholders.

| Kind | Complete manifest | Complete content | Required companion content |
|---|---|---|---|
| `skill` | [`plugin.json`](examples/declarative/skill/plugin.json) | [`skill.json`](examples/declarative/skill/content/skill.json) | None |
| `prompt` | [`plugin.json`](examples/prompt-plugin/plugin.json) | [`warm-review-prompt.json`](examples/prompt-plugin/content/warm-review-prompt.json) | The prompt walkthrough also includes its complete [`signature-bundle.json`](examples/prompt-plugin/META-JENNY/signature-bundle.json). |
| `theme` | [`plugin.json`](examples/declarative/theme/plugin.json) | [`theme.json`](examples/declarative/theme/content/theme.json) | This is the minimal V1 contract example. For a current eleven-role V2 installable theme, use [Themes and palettes](../THEMES.md). |
| `settings_schema` | [`plugin.json`](examples/declarative/settings-schema/plugin.json) | [`settings-schema.json`](examples/declarative/settings-schema/content/settings-schema.json) | None |
| `command` | [`plugin.json`](examples/declarative/command/plugin.json) | [`command.json`](examples/declarative/command/content/command.json) | [`target-prompt.json`](examples/declarative/command/content/target-prompt.json) |
| `workflow` | [`plugin.json`](examples/declarative/workflow/plugin.json) | [`workflow.json`](examples/declarative/workflow/content/workflow.json) | [`target-prompt.json`](examples/declarative/workflow/content/target-prompt.json) |
| `mcp_descriptor` | [`plugin.json`](examples/declarative/mcp-descriptor/plugin.json) | [`mcp-descriptor.json`](examples/declarative/mcp-descriptor/content/mcp-descriptor.json) | The example uses `remote_http` and requests `network.fetch`; it does not grant native stdio authority. |

Run the external-file command in `TESTING.md` once per content file. The
checked-in examples were also assembled in scratch with the exact structural
developer bundle and passed production developer-profile intake. Captured
output, one line per kind:

```text
{"kind":"skill","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
{"kind":"prompt","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
{"kind":"theme","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
{"kind":"settings_schema","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
{"kind":"command","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
{"kind":"workflow","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
{"kind":"mcp_descriptor","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
```

## Self-contained shape example: V5 panel plus V6 session provider

This illustrative manifest is not installable as written: the content files and executable must be supplied, and each digest placeholder must be replaced with the SHA-256 of the packaged bytes.

```json
{
  "manifest_schema_version": 6,
  "publisher_id": "jenny-official",
  "plugin_id": "local-image-generation",
  "name": "Local Image Generation",
  "version": "1.0.0",
  "contract_versions": {
    "manifest": 6, "generation": 6, "runtime_snapshot": 6,
    "full_host_content": 6, "full_host_attestation": 6, "full_host_health": 6,
    "full_host_termination_receipt": 6, "native_mcp_binding": 6,
    "engine_adapter": 6, "hook_descriptor": 6, "secret_delivery_grant": 6,
    "containment_profile": 6, "runtime_attestation": 6
  },
  "contributions": [
    { "kind": "panel", "contribution_id": "image_workspace", "name": "Image workspace",
      "content_path": "content/image-workspace.json", "content_sha256": "<filled by packager>" },
    { "kind": "session_provider", "contribution_id": "local_image_generation", "name": "Image",
      "content_path": "content/image-session-provider.json", "content_sha256": "<filled by packager>",
      "executable_path": "host/local-image-generation-host.exe", "executable_sha256": "<filled by packager>",
      "executable_bytes": 1, "platform": "win32", "architecture": "x64",
      "containment_profile": "windows_job_supervised_v1", "resource_class": "interactive", "secret_delivery": false }
  ],
  "dependencies": [],
  "requested_permissions": ["ui.view", "runtime.full_host"]
}
```

The example includes the complete V6 `contract_versions` map. The schema remains authoritative for required fields and accepted values.

The per-kind content rules and display-string limits remain authoritative in `config/plugins/v1/plugin-declarative-content.schema.json` and its shared schema references.
