# Themes and Palettes

Jenny themes the shell through built-in palettes: a `styles/palette-<id>.css`
file registered in the renderer and shipped in a Jenny build. A palette
restyles the whole shell, including shared surfaces, widgets, effects, and
editor chrome. Typography and motion are not palette concerns; they come from
the shared foundation tokens. There is no installable theme package.

## Contributing a built-in palette

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

   Palettes never set font sizes. Every text size resolves through the role
   tokens in `styles/foundation.css` (`--font-size-caption` 12px,
   `--font-size-footnote` 13px, `--font-size-code` 13px, `--font-size-body`
   14px, `--font-size-prose` 16px, `--font-size-heading` 16px,
   `--font-size-title` 20px at `--font-scale` 1; the Default preset is 1.2,
   Small 1.1, Large 1.3), each `calc(Npx * var(--font-scale, 1))` so the
   single Text size preference is the only runtime multiplier. Chat
   code, tool-output, and artifact code sizing uses `--tl-font-code`, an alias
   of `--font-size-code`. A palette must not redefine any `--font-size-*` or
   `--tl-font-*` token.

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

### Monaco does not match the palette

Define the eight optional `--syntax-*` variables in the active palette using
colors the bridge can parse. Without them, Monaco intentionally inherits its
base syntax theme even though editor backgrounds and chrome still follow the
resolved palette roles.
