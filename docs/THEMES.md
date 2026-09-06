# Themes and Palettes

Installable version 2 themes are **color-only**: they must supply exactly the
eleven host-owned roles listed below. `font.*`, `motion.*`, spacing, radius,
arbitrary CSS, and every twelfth token are rejected. Typography or motion
changes require the built-in palette/source path and a rebuilt Jenny binary;
no typography contract or whole-shell third-party theme bundle ships today.

Choose by scope: use a plugin `theme` contribution for an installable package
of bounded chat-view tokens; contribute a built-in palette to restyle the
whole Electron shell and ship a new Jenny build. A plugin theme cannot load
arbitrary CSS, and a built-in palette is not installed as a plugin.

## Which path do I want?

| Path | Scope | Distribution | Validation | Repository access |
|---|---|---|---|---|
| Plugin `theme` contribution | The eleven host-owned chat theme roles described below | A distributable, installable plugin package | Manifest/content validation and contrast gates run during package intake | Not required to author or install the package |
| Built-in palette | The whole shell, including shared surfaces, widgets, effects, and editor chrome | Source change that must be shipped in a Jenny build | Palette-specific tests plus repository policy checks | Required |

## Path 1 — a plugin `theme` contribution

### Manifest entry and content file

The v6 plugin manifest schema permits `"theme"` as a contribution `kind`.
Each entry in `contributions` supplies metadata and points to a separate,
digest-bound content file. See
[`config/plugins/v6/plugin-manifest.schema.json`](../config/plugins/v6/plugin-manifest.schema.json).

The manifest entry has this shape:

```json
{
  "kind": "theme",
  "contribution_id": "night-chat",
  "name": "Night Chat",
  "content_path": "content/night-chat.json",
  "content_sha256": "<64 lowercase hexadecimal SHA-256 characters>"
}
```

Here is the complete minimal V6 manifest used by the validated example later
on this page. It has no dependencies or requested permissions:

```json
{
  "manifest_schema_version": 6,
  "publisher_id": "astra-labs",
  "plugin_id": "astra-dogfood",
  "name": "Astra Dogfood",
  "version": "1.0.0",
  "contract_versions": {
    "manifest": 6,
    "generation": 6,
    "runtime_snapshot": 6,
    "full_host_content": 6,
    "full_host_attestation": 6,
    "full_host_health": 6,
    "full_host_termination_receipt": 6,
    "native_mcp_binding": 6,
    "engine_adapter": 6,
    "hook_descriptor": 6,
    "secret_delivery_grant": 6,
    "containment_profile": 6,
    "runtime_attestation": 6
  },
  "contributions": [
    {
      "kind": "theme",
      "contribution_id": "astra_dogfood",
      "name": "Astra Dogfood",
      "content_path": "content/astra-dogfood.json",
      "content_sha256": "496fe07fa3b0de1f606532d547543581659cf00f32e9df5b05513663233fe423"
    }
  ],
  "dependencies": [],
  "requested_permissions": []
}
```

Its complete `content/astra-dogfood.json` is:

```json
{
  "content_schema_version": 2,
  "publisher_id": "astra-labs",
  "plugin_id": "astra-dogfood",
  "contribution_id": "astra_dogfood",
  "payload": {
    "kind": "theme",
    "tokens": [
      { "token": "surface.chat", "value": "#17120D" },
      { "token": "surface.message_user", "value": "#2A1C0E" },
      { "token": "surface.message_assistant", "value": "#1F1811" },
      { "token": "surface.tool", "value": "#21160D" },
      { "token": "text.primary", "value": "#F8E7C9" },
      { "token": "text.muted", "value": "#C7A978" },
      { "token": "text.link", "value": "#FFD27A" },
      { "token": "border.default", "value": "#C68A30" },
      { "token": "border.focus", "value": "#FFC04D" },
      { "token": "color.accent", "value": "#9B4D00" },
      { "token": "color.accent_text", "value": "#FFFFFF" }
    ]
  }
}
```

The digest is over the exact final content bytes. Use the Windows and POSIX
commands in the
[empty-folder walkthrough](plugins/AUTHORING_OVERVIEW.md#empty-folder-to-enabled-a-permissionless-prompt-plugin)
and replace the manifest value after any byte changes.

`content_path` and `content_sha256` are required. The digest covers exact file
bytes; the placeholder is invalid. Manifest and content IDs must match.

Version 2 puts rows under `payload.tokens`. Its structural source is
[`config/plugins/v2/plugin-declarative-content.schema.json`](../config/plugins/v2/plugin-declarative-content.schema.json),
and the semantic checks are in
[`declarative-content-validator.js`](../services/plugins/data/declarative-content-validator.js).

### Host-owned token names

The validator's general safe token-name allowlist is exactly:

```regex
/^(?:color|surface|text|border|spacing|radius|font|motion)\.[a-z0-9_.-]{1,56}$/
```

The eight prefixes are host-owned namespaces:

| Prefix | Namespace |
|---|---|
| `color` | General color roles, including accents |
| `surface` | Background or container surface roles |
| `text` | Text foreground roles |
| `border` | Border and focus-outline roles |
| `spacing` | Spacing roles |
| `radius` | Corner-radius roles |
| `font` | Typography roles |
| `motion` | Motion roles |

Passing the pattern does not create a CSS variable. Version 2 narrows the set
to the exact eleven names below; `spacing`, `radius`, `font`, and `motion`
cannot be added.

The validator's general safe value pattern is exactly:

```regex
/^[-A-Za-z0-9#._% +]{1,200}$/
```

It permits ASCII letters, digits, hyphen, `#`, `.`, `_`, `%`, space, and `+`.
The schema sets `max_utf8_bytes` to `200`; because the set is ASCII, the ceiling
is 200 bytes. Parentheses, colons, semicolons, braces, quotes, and slashes fail,
so `url()` and `var()` are refused.

Version 2 is stricter than that general pattern: every value must match
`^#[0-9A-Fa-f]{6}$`, a six-digit opaque hexadecimal color.

### Version 2 token set and contrast

A version 2 theme must supply this exact `STAGE4B_THEME_TOKENS` set:

```text
surface.chat  surface.message_user  surface.message_assistant  surface.tool
text.primary  text.muted  text.link
border.default  border.focus
color.accent  color.accent_text
```

Supply every token once and no extras. The schema allows eleven unique rows;
an incomplete or extra set is refused as `theme_token_set_incomplete` at
`payload.tokens`.

The following foreground/background pairs must have a contrast ratio of at
least `4.5:1`:

```text
text.primary / surface.chat           text.primary / surface.message_user
text.primary / surface.message_assistant  text.primary / surface.tool
text.muted / surface.chat             text.link / surface.chat
color.accent_text / color.accent
```

If any pair is below `4.5:1`, package intake refuses the theme with
`theme_text_contrast_insufficient`.

The validator also has a non-text `3:1` gate for these exact pairs:

```text
border.default / surface.chat  border.default / surface.message_user
border.default / surface.tool  border.focus / surface.chat
color.accent   / surface.chat
```

If any of those pairs is below `3:1`, the refusal is
`theme_non_text_contrast_insufficient`.

### Complete valid example

This is a complete version 2 content file. Replace the authority identifiers
with the identifiers from your manifest, then compute the manifest entry's
`content_sha256` from the final file bytes.

```json
{
  "content_schema_version": 2,
  "publisher_id": "acme-labs",
  "plugin_id": "chat-themes",
  "contribution_id": "night-chat",
  "payload": {
    "kind": "theme",
    "tokens": [
      { "token": "surface.chat", "value": "#000000" },
      { "token": "surface.message_user", "value": "#000000" },
      { "token": "surface.message_assistant", "value": "#000000" },
      { "token": "surface.tool", "value": "#000000" },
      { "token": "text.primary", "value": "#FFFFFF" },
      { "token": "text.muted", "value": "#B3B3B3" },
      { "token": "text.link", "value": "#66CCFF" },
      { "token": "border.default", "value": "#777777" },
      { "token": "border.focus", "value": "#00FFFF" },
      { "token": "color.accent", "value": "#005FCC" },
      { "token": "color.accent_text", "value": "#FFFFFF" }
    ]
  }
}
```

Using the validator calculation, the lowest text-pair ratio is `5.984935:1`
for `color.accent_text` against
`color.accent`; the lowest non-text pair is `3.508810:1` for `color.accent`
against `surface.chat`.

### Scope limits

A plugin theme is data, not CSS. It cannot add selectors, fonts, images,
gradients, scripts, custom properties, or token names. Version 2 covers only
the listed chat roles; it cannot restyle navigation, Settings, Home, the
startup overlay, Monaco chrome, or other whole-shell surfaces.

The source carries enabled theme descriptors in the chat runtime snapshot but
exposes no general renderer stylesheet hook.

See [Plugin Security](PLUGIN_SECURITY.md) for package trust and lifecycle.

### Headless validation and unsigned install

Save the complete content example above, then validate its manifest, content
schema, theme semantics, digest, display strings, and budgets from the
repository root:

```powershell
npm run plugin:validate -- C:\path\to\theme-folder
```

This command validates authored plugin sources. Built-in source-registered
themes are outside its scope; use the built-in palette checks later in this
guide for those stylesheets.

For a cold-start developer install, follow
[Install and enable from a cold start](plugins/AUTHORING_OVERVIEW.md#install-and-enable-from-a-cold-start):
build the root-layout archive and structural signature bundle, open **Settings
-> Plugins & Extensions -> Install plugin**, select the `.jenny-plugin`, check
for **developer (unsigned)**, and enable it. Unsigned developer intake is
default-on; `JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=0` disables it.

## Path 2 — contributing a built-in palette

Jenny currently has eleven `styles/palette-*.css` files:

```text
palette-darkroom.css  palette-jenny-day.css  palette-jenny-night.css  palette-lexicon.css
palette-obsidian.css  palette-paper.css  palette-pewter.css  palette-rocko.css
palette-signal.css  palette-slate.css  palette-woolly.css
```

`midnight` is the twelfth registered palette; its baseline lives in
[`styles/foundation.css`](../styles/foundation.css), not `palette-midnight.css`.

1. **Create the palette stylesheet.**

   Create `styles/palette-<id>.css` and start it with:

   ```css
   :root[data-palette="<id>"] {
     color-scheme: dark;
     /* Retuned custom properties. */
   }
   ```

   Use `color-scheme: light` for a light palette. The safest template is
   [`styles/palette-jenny-night.css`](../styles/palette-jenny-night.css): copy
   it wholesale, change the selector, and retune every value. Jenny has no
   test that enforces token parity across palette files. If you drop a custom
   property, CSS silently inherits the foundation `:root` value. This commonly
   leaves Midnight's blue-violet values in an otherwise custom palette.

   Compare token names against the template before reviewing colors. From the
   repository root in PowerShell:

   ```powershell
   $template = Select-String styles/palette-jenny-night.css -Pattern '^\s*(--[a-z0-9-]+):' |
     ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique
   $candidate = Select-String styles/palette-<id>.css -Pattern '^\s*(--[a-z0-9-]+):' |
     ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique
   Compare-Object $template $candidate
   ```

   Empty output means the token-name sets match. Review selectors and
   reduced-motion/fallback blocks separately; this checks only declarations.

   Chat code, tool-output, and artifact code sizing uses `--tl-font-code`.
   Its built-in default is
   `calc(12px * var(--chat-zoom-factor, 1))`. A built-in palette that changes
   the base size must preserve that zoom-only form, for example
   `--tl-font-code: calc(14px * var(--chat-zoom-factor, 1));`, so chat zoom
   remains the only runtime multiplier. This custom property is not an
   installable V2 theme role; adding it to `payload.tokens` is rejected.

2. **Register the palette ID.**

   Add an entry to `PALETTE_PRESETS` in
   [`renderer/shared/appearance-utils.js`](../renderer/shared/appearance-utils.js).
   `normalizePresetId` accepts only keys present in that collection, so an
   unregistered ID normalizes to the fallback palette.

   The source has no `PALETTE_MOTION_DEFAULTS`; motion is applied as
   `data-motion="standard"`. Optionally add a `THEME_BUNDLES` entry to combine
   palette, typography, surface effect, and Composer holo choices.

3. **Load the stylesheet in production order.**

   Add this import to the palette group near the top of
   [`styles.css`](../styles.css):

   ```css
   @import url("./styles/palette-<id>.css");
   ```

   Keep palette overrides after the foundation layers. The exact order pinned
   by [`tests/foundation-widget-tokens.test.js`](../tests/foundation-widget-tokens.test.js)
   is only the first four imports:

   ```text
   ./styles/foundation.css
   ./styles/foundation-widget-tokens.css
   ./styles/motion.css
   ./styles/palette-paper.css
   ```

   Do not insert before `palette-paper.css` or disturb those positions. The
   test does not prescribe the order among later palette files.

4. **Verify startup-overlay behavior.**

   In the current source,
   [`styles/startup-overlay.css`](../styles/startup-overlay.css) has one generic
   `:root` block derived from `--bg-base`, `--accent`, `--accent-cyan`, and
   `--text-bright`. It has no per-palette blocks or hardcoded palette colors,
   so adding such a block is not part of the current palette contract.

   Check the overlay after retuning those tokens. Explicit palette startup
   overrides would be a new contract requiring separate tests.

5. **Optionally define syntax colors.**

   A palette may set these eight variables:

   ```text
   --syntax-keyword   --syntax-string    --syntax-comment  --syntax-number
   --syntax-function  --syntax-type      --syntax-variable --syntax-constant
   ```

   [`renderer-ide-theme-bridge.js`](../renderer/features/renderer-ide-theme-bridge.js)
   reads the active palette's computed custom properties, converts them into
   Monaco token rules, defines the global `jenny` theme, and reapplies it when
   `data-palette` changes. Missing or unparseable syntax slots are skipped.
   When no syntax variables resolve, Monaco inherits the built-in base theme:
   `vs` for a light resolved background or `vs-dark` for a dark one.

6. **Do not change Electron configuration for the palette.**

   Appearance preferences are renderer-local. The canonical key is
   `jenny.appearance.v2`; the renderer loads and saves it through
   `window.localStorage`, then writes `data-palette` on the document root.
   Adding a registered palette needs no IPC change and no `CONFIG_VERSION`
   bump.

## Gates your change must pass

Run focused tests from the repository root:

```powershell
node scripts/run-node-tests-safe.js tests/palette-muted-contrast.test.js
node scripts/run-node-tests-safe.js tests/appearance-utils.test.js
npm run check:policy
```

[`tests/palette-muted-contrast.test.js`](../tests/palette-muted-contrast.test.js)
discovers every `palette-*.css` file. It requires literal hexadecimal
`--text-muted` and `--text-decorative` values, then requires
`--text-muted` to reach at least `4.5:1` against every literal core background
the file defines: `--bg-base`, `--bg-surface`, `--bg-surface-2`, and
`--bg-panel`. It does not set a contrast floor for `--text-decorative`.

[`tests/appearance-utils.test.js`](../tests/appearance-utils.test.js) snapshots
the complete ordered palette ID list. Add your ID to that expected list as
well as to `PALETTE_PRESETS`. A second assertion derives light palettes by
filtering the registered IDs whose palette files contain
`color-scheme: light`; it expects exactly `paper`, `woolly`, and `jenny-day`
today. A new dark palette is excluded automatically by that filter and must
not be added to the light-palette expectation. A new light palette must be.

`npm run check:policy` runs the repository policy suite, including documentation
link and dangling-reference checks relevant to this guide.

Static gates do not prove visual completeness. Review the shell and overlay in
normal and reduced-motion states after they pass.

## Troubleshooting

### The palette renders with blue-violet remnants

One or more custom properties are absent from your palette block, so CSS falls
back to the Midnight values in `styles/foundation.css`. Diff the `--token`
names against `palette-jenny-night.css`, then retune the missing declarations.

### The splash screen has the wrong color

The current startup overlay derives its colors from the active palette's
`--bg-base`, `--accent`, `--accent-cyan`, and `--text-bright`. Check those
values and confirm the palette stylesheet loads before `startup-overlay.css`.
There is no current per-palette startup block to repair.

### A plugin theme is refused during package intake

Use the refusal reason to find the failed contract:

| Reason | Cause |
|---|---|
| `theme_token_not_host_owned` | A token name failed `SAFE_THEME_TOKEN` after structural validation |
| `theme_value_unsafe` | A value failed `SAFE_THEME_VALUE` after structural validation |
| `theme_token_set_incomplete` | A version 2 theme omitted a required token or supplied a token outside the eleven-token set |
| `theme_text_contrast_insufficient` | At least one required text pair is below `4.5:1` |
| `theme_non_text_contrast_insufficient` | At least one required non-text pair is below `3:1` |

The schema can reject bad names or values earlier with a `contract_*` reason
such as `contract_pattern_mismatch`; fix that structural violation first.

### Monaco does not match the palette

Define the eight optional `--syntax-*` variables in the active palette using
colors the bridge can parse. Without them, Monaco intentionally inherits its
base syntax theme even though editor backgrounds and chrome still follow the
resolved palette roles.
