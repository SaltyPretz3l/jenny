# Manifest reference

Schema authority: `config/plugins/v1/` through `v6/` (frozen). These schemas describe package shapes, including retired kinds retained for stored-package compatibility. Install admission and activation are owned by `services/plugins/runtime/declarative-compiler-constants.js` and `declarative-compiler.js`; schema acceptance alone does not make a package usable.

## Top level

| Field | Meaning |
|---|---|
| `manifest_schema_version` | Integer 1-6. Selects legal package shapes. Prefer V3 for third-party permissionless skills/prompts and V5 for views. V1/V2 activation is first-party/current-key only. V4 restricted kinds and V6 privileged kinds are retired. |
| `publisher_id`, `plugin_id` | Stable identity. `plugin_id` is kebab-case. Identity drift between versions is rejected. |
| `name`, `version` | Display name (bounded, validated display string) and semver. |
| `contract_versions` | Map of contract name to version, for example `manifest`, `declarative_content`, `operation_receipt`, `cleanup_state` for V1 and `manifest`, `view_content`, `provider_descriptor`, `generation`, `runtime_snapshot`, `view_call`, `view_result`, `view_event` for V5 (see `config/plugins/v5/plugin-manifest.schema.json`). |
| `contributions` | Array of contribution objects (below). |
| `dependencies` | Other plugins by identity and version range. Libraries are bundled inside your package, not declared here. |
| `requested_permissions` | See `AUTHORING_OVERVIEW.md`. |

## Contribution objects

Every contribution has `kind`, `contribution_id` (snake_case), `name`, `content_path`, and `content_sha256` (digest of the content file as packaged).

Kinds by tier:

- Declarative: `skill`, `prompt`, `theme`, `settings_schema`.
- View (V5): `panel`.
- Retired 2026-10-02 (plugin platform retirement stage 4), refused at install for a new package, inert in a leftover one: `mcp_descriptor`, `command`, `workflow`, `restricted_transform`, `restricted_formatter`, `restricted_renderer`, `restricted_compute`, `setup_scene`, `provider_descriptor`, `native_mcp`, `session_provider`, `engine_adapter`, `hook`. The frozen manifest schemas still list them (frozen contracts are never edited); the list that install enforces is `RETIRED_CONTRIBUTION_KINDS` in `services/plugins/runtime/declarative-compiler-constants.js`. `artifact_renderer` is a view kind that the frozen V5 schema lists; it is not covered by this guide. User extensions are heading toward skill folders and core-configured MCP servers (`NEXT_STEPS.md` row 27).

## Complete V1 declarative examples

The frozen V1 declarative-content schema still lists seven kinds; three of them
(`command`, `workflow`, `mcp_descriptor`) were retired on 2026-10-02 and their
examples were deleted. Each row below links a complete manifest and complete
content file for a surviving contribution family; the digest in each manifest is
the SHA-256 of the linked content file's exact LF-terminated bytes.

| Kind | Complete manifest | Complete content | Required companion content |
|---|---|---|---|
| `skill` | [`plugin.json`](examples/declarative/skill/plugin.json) | [`skill.json`](examples/declarative/skill/content/skill.json) | None |
| `prompt` | [`plugin.json`](examples/prompt-plugin/plugin.json) | [`warm-review-prompt.json`](examples/prompt-plugin/content/warm-review-prompt.json) | The prompt walkthrough also includes its complete [`signature-bundle.json`](examples/prompt-plugin/META-JENNY/signature-bundle.json). |
| `theme` | [`plugin.json`](examples/declarative/theme/plugin.json) | [`theme.json`](examples/declarative/theme/content/theme.json) | This is the minimal V1 contract example. For a current eleven-role V2 installable theme, use [Themes and palettes](../THEMES.md). |
| `settings_schema` | [`plugin.json`](examples/declarative/settings-schema/plugin.json) | [`settings-schema.json`](examples/declarative/settings-schema/content/settings-schema.json) | None |

Run the external-file command in `TESTING.md` once per content file. The
checked-in examples were also assembled in scratch with the exact structural
developer bundle and passed production developer-profile intake. Captured
output, one line per kind:

```text
{"kind":"skill","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
{"kind":"prompt","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
{"kind":"theme","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
{"kind":"settings_schema","manifest":{"ok":true},"content_schema":{"ok":true},"content_semantics":{"ok":true},"digest":{"ok":true},"intake":{"ok":true}}
```

These V1 examples are schema/intake fixtures, not enabled-plugin examples.
Their third-party publisher identities fail V1 activation with `not_first_party`;
V1 activation also supports only skills/prompts. Themes and settings need a supported manifest: manifest V2 requires a
current-key first-party package, while manifest V6 can carry V2 declarative
content after package verification. Content schema V2 is not a first-party
restriction by itself. Preserve the fixtures' exact bytes
when reproducing the captured digest checks.

## Self-contained shape example: V5 panel

This illustrative manifest is not installable as written: the content file and view assets must be supplied, and each digest placeholder must be replaced with the SHA-256 of the packaged bytes. A V5 package may contain only view kinds, and its permissions are limited to `ui.view`, `network.fetch`, and `secret.brokered_use` (`services/plugins/runtime/stage7-eligibility.js`).

```json
{
  "manifest_schema_version": 5,
  "publisher_id": "example-publisher",
  "plugin_id": "example-panel",
  "name": "Example Panel",
  "version": "1.0.0",
  "contract_versions": {
    "manifest": 5, "view_content": 5, "provider_descriptor": 5, "generation": 5,
    "runtime_snapshot": 5, "view_call": 5, "view_result": 5, "view_event": 5
  },
  "contributions": [
    { "kind": "panel", "contribution_id": "tool_workspace", "name": "Tool workspace",
      "content_path": "content/tool-workspace.json", "content_sha256": "<filled by packager>" }
  ],
  "dependencies": [],
  "requested_permissions": ["ui.view"]
}
```

The `provider_descriptor` contract-version entry is required by the frozen V5 schema even though provider descriptors are retired. The panel content file satisfies `config/plugins/v5/plugin-view-content.schema.json` (`view_kind: "panel"`, `entry_path`, `entry_sha256`, `assets`, `allowed_bridge_operations`, `allowed_event_topics`, `artifact_kinds: []`, `provider_ref: ""`). Content that names a provider bridge operation, the `provider_auth_changed` topic, or a `provider_ref` is rejected. The schema remains authoritative for required fields and accepted values.

The per-kind content rules and display-string limits remain authoritative in `config/plugins/v1/plugin-declarative-content.schema.json` and its shared schema references.
