# Sketchy, vendored for Jenny

Jenny draws sketch blocks (a fenced `sketch` block in a chat reply becomes a hand-drawn, laid-out
diagram) with the drawing core of Sketchy. The npm package has no library API, so the core is
copied here unedited and Jenny builds its own bundles from it.

- Upstream: https://github.com/ddkbs/sketchy (MIT, Copyright (c) 2026 ddkbs; `LICENSE` is upstream's)
- Pinned commit: `c246cd47`, package version 0.2.0
- Plan: `docs/plans/PROJECT_BOARD_2026-11-13.md`, sections 3, 4, 5.8 and 16.2

## No vendored file is edited

Every file in this folder except this one is upstream's file, copied byte for byte. Upstream's
blobs use LF. A copy taken from a checkout made with `core.autocrlf=true` has CRLF in the working
tree; the repository's `.gitattributes` (`* text=auto eol=lf`) normalises it to upstream's LF when
it is staged, so the committed bytes are upstream's. Jenny's changes live outside this folder, in
`scripts/build/build-sketch.js` and `scripts/build/sketch/`. If a build ever needs an edit to a
file here, stop and decide that deliberately; do not patch in place.

## Files vendored (39 plus this one)

Upstream paths, unchanged:

```
LICENSE
THIRD_PARTY_NOTICES.md
src/figures/{chart,common,data,draw,expr,index,map,molecule,objects,plot,seq,templates,types}.ts
src/layout/{callouts,index,links,text}.ts
src/math/{inline,tex}.ts
src/scene/{builder,compact,fill,laid-out,patch,types}.ts
src/style/metrics.ts
viewer/src/{annotate,draw,excalidraw,export,figures,fonts,palette,render,scene-view,steps}.ts
viewer/src/styles.css
```

Left out on purpose: `src/parts/` (circuit parts), photos, storage, the MCP server and its tools,
HTTP, terminal, standalone, opener, export sinks, the skill, the Claude Code plugin, the website,
Simple Icons, and the viewer files that talk to a host page (`host`, `main`, `capture`, `preview`,
`raster`, `standalone`, `model-picker`).

Not bundled today although vendored: `src/figures/types.ts` and `src/scene/laid-out.ts` (types
only), `src/scene/patch.ts` (the follow-up edit helper, kept for the checking layer) and
`viewer/src/palette.ts` (replaced, below; kept for reference and for the re-sync diff).

## What replaces or shims upstream

The build (`scripts/build/sketch/esbuild-plugin.js`) resolves these instead of the upstream
module. Each is a Jenny file in `scripts/build/sketch/`:

| Upstream module | Jenny's version | Why |
|---|---|---|
| `src/icons.ts` (not vendored) | `replace/icons.ts` | Serves one bundled Lucide set (no Simple Icons, no file reads, no network). An unknown icon name is reported as unknown (`hasIcon` false, `resolveIcon` undefined), never thrown, so the checking layer can drop it before the strict builder sees it. Adds `hasIcon`. |
| `src/parts/metadata.ts` (not vendored) | `replace/metadata.ts` | Empty stub: circuits are not offered, so there is no part catalog. |
| `viewer/src/palette.ts` | `replace/palette.ts` | Drawings take the app theme's colours (plan 5.8). Exports the same names as live bindings plus `setPalette(colours)`: six-digit hex only, anything else falls back to upstream's cream value. It also sets CSS variables on the document for `theme-override.css`. |
| `node:module` | `replace/node-module.ts` | Upstream loads elkjs with `createRequire(import.meta.url)`; the shim returns the bundled elkjs 0.12.1 instead. |

Other build requirements, all in the plugin or `build-sketch.js`, none touching upstream files:

- a loader for Vite's `?inline` suffix (`.woff2` as a data URL, `.css` as text), registered before the `@sketchy/` path mapper;
- a define for `import.meta.url` (it only feeds the `createRequire` call above);
- a `tsconfigRaw` override, so upstream's tsconfig (not vendored) can never be picked up;
- `scripts/build/sketch/theme-override.css`, appended after `styles.css`, which repeats the selectors that hold a literal colour and reads the palette variables (the fallbacks are upstream's cream values);
- no watermark (owner, 2026-11-16): `entry-frame.ts` removes upstream's `.watermark` text from each drawing after
  `mountScene` (the SVG and PNG exports clone that SVG) and filters the `sketchy-watermark` element out of
  `toExcalidraw`; Sketchy is credited in Settings > About and `NOTICE` instead. A re-sync that renames the class or
  the element id fails `tests/sketch-frame-contract.test.js`;
- a refusal: the build fails with a clear message if `src/parts/index.ts` is ever imported for a value (today it is imported for types only, which esbuild drops).

## Bundles

`node scripts/build/build-sketch.js` (`npm run build:sketch`, `--force` or `build:sketch:force` to rebuild) writes two gitignored files at the repository root and skips the work when a content stamp over their inputs (`.sketch-build-stamp.json`) is unchanged:

- `sketch-frame.bundle.js`: browser IIFE, minified, no `eval`, no `new Function`, no network address, at most 3,000,000 bytes (the build fails above that). Ships in the app.
- `sketch-core.bundle.cjs`: Node CommonJS, parse, build and layout with no DOM. Tests only; never ships.

### `jennySketch` surface (frame bundle global)

| Name | What it is |
|---|---|
| `render(container, source, options)` | Runs `prepare`, then injects the styles once, builds, lays out and draws into `container`. Never rejects for a model's mistake. Resolves with `{kind: 'drawn', problems, counts, laidOut}`, `{kind: 'mermaid', source}` (nothing drawn; the caller hands the block to the Mermaid renderer) or `{kind: 'refused', reason, problems, message?}` (nothing drawn; `reason: 'error'` is a builder or layout fault the checking layer does not cover, with upstream's message). `options.previous` seeds a follow-up; `options.host` supplies the viewer's callbacks (`openLink` defaults to a no-op). |
| `prepare(source)` | The checking layer (below). Pure, never throws. Returns `{kind: 'scene', input, problems, counts}`, `{kind: 'mermaid', source}` or `{kind: 'refused', reason, problems, message?}`; `reason` is `empty`, `too_long`, `too_many_lines`, `too_many_nodes`, `too_many_problems` or `error`. |
| `SKETCH_BOUNDS` | `{chars: 16384, lines: 400, nodes: 120}`, plan 5.2. |
| `parse(source)` | Upstream `parseCompact`, as is. Permissive. |
| `buildScene(parsed)` | Async. Upstream `SceneBuilder` plus `fillScene`; returns the scene. Strict and all-or-nothing: hand it `prepare(source).input`, not raw `parse` output. |
| `layout(scene, previous?)` | Async. Upstream `layoutScene` (elkjs layered, orthogonal routing). |
| `previousLayout(laidOut)` | Positions to pass as `previous` for a follow-up. |
| `setPalette(colours)` | Theme colours, keys `paper ink inkSoft muted card groupFill marker annotation highlight line`. |
| `hasIcon(name)` | True for a bundled Lucide icon name. |
| `SceneError` | Upstream's error class. |
| `version` | The pinned commit, `c246cd47`. |

The frame bundle also exports `prepare` and `SKETCH_BOUNDS`. The core bundle exports `prepare`, `SKETCH_BOUNDS`, `parse`, `buildScene`, `layout`, `previousLayout`, `hasIcon`, `SceneError` and `version`.
Upstream's own functions are exposed as they are; the checking layer wraps them and never edits them.
Both bundles also export `pickPrevious(source, earlier)` from `scripts/build/sketch/follow-up.ts` (plan 5.5): it picks the earlier drawing a follow-up starts from and never rejects.

### The checking layer (`scripts/build/sketch/check.ts`, `check-source.ts`, `check-scene.ts`)

Plan section 5.4. Upstream's parser turns any line it does not recognise into a node and its builder fails the whole
drawing on one bad reference, so `prepare` checks and repairs on both sides of the parser, on plain data only: the
source lines, then the parsed input object. Order: the bounds (characters, lines); rules by line (`part`, `wire`
and `image` lines removed, a Mermaid header handed back, `a -> b` inside a step made `a->b`, copied grammar brackets
taken off); upstream's parse, repeated until it succeeds, rewriting four refusals instead of dropping the line
(a node with no label takes its id, `group flow` takes its id, `dir right|down` takes the first and Mermaid's
`dir LR`, `TD` and `TB` become `right` and `down`, Mermaid node shapes
become plain nodes) and removing any other refused line, or a failed figure header with its body; rules on the parsed
object (an `in X` with no group `X` goes back into the label, a reference to a missing id is dropped or re-pointed to
its one near match, a duplicate id keeps the first, an unknown icon goes, prose-like labels are flagged); the node
bound (nodes, groups and figures with their parts, at most 120); then the quarter rule (more than a quarter of the
elements dropped or flagged is refused, with the problems). Each problem is `{code, line, id?, to?, text?}`; the chat
words them. The Mermaid header pattern is a copy of `START_RE` in `renderer/shared/markdown-mermaid-text.js` and a
test keeps the two equal; the one difference is that `timeline t: Plan` and `mindmap m: Plan` (with an id) are
Sketchy figure headers, not Mermaid. The layer only reads upstream's messages for the four rewrites: a re-sync that
rewords them fails `tests/sketch-check.test.js`, which is the point.

## Dependencies (dev dependencies of Jenny, exact versions)

| Package | Version | Use |
|---|---|---|
| elkjs | 0.12.1 | Layout. Not 0.9.3, which Mermaid brings in: it ignores the root-relative coordinate options (`elk.json.shapeCoords`, `elk.json.edgeCoords`) and draws grouped nodes outside their group. npm nests Mermaid's copy; the golden test guards this. |
| rough.js (`roughjs`) | 4.6.6 | Hand-drawn strokes (already installed). |
| @fontsource/kalam | 5.3.0 | Handwriting font, embedded as data URLs. |
| @iconify-json/lucide | 1.2.154 | Icon set. |
| d3-geo | 3.1.2 | Map projections. |
| topojson-client | 3.1.0 | Reading map outlines. |
| world-atlas | 2.0.2 | 110m country outlines. |
| esbuild | installed version | The build. |

Licences are in `NOTICE` (Sketchy MIT, elkjs EPL-2.0 shipped unmodified, rough.js MIT, Kalam OFL 1.1, Lucide ISC, d3-geo, topojson-client and world-atlas ISC).

## Re-sync recipe

Upstream moves fast (eight releases in fourteen days, one breaking format change), so a re-sync is a deliberate task, never an incidental one.

1. Check out the new upstream commit somewhere outside the repository.
2. Copy exactly the file list above from it over this folder, byte for byte (copy files, do not let an editor or `git` rewrite line endings). Do not add files outside the list without recording them here.
3. Compare each upstream module Jenny replaces (`src/icons.ts`, `src/parts/metadata.ts`, `viewer/src/palette.ts`, and how `src/layout/index.ts` loads elkjs) with `scripts/build/sketch/replace/`: new exports must be mirrored, and the elkjs version upstream is written against must match `package.json`.
4. Update the commit in `scripts/build/sketch/pipeline.ts` (`version`), in this file and in `NOTICE`.
5. Run `node scripts/build/build-sketch.js --force`, then `node scripts/run-node-tests-safe.js tests/sketch-core.test.js`.
6. A failing golden scene is the point of the test: read the diff of the scene objects in `tests/fixtures/sketch/*.scene.json` (`UPDATE_SKETCH_GOLDEN=1` rewrites them), decide whether each change is wanted, and only then keep the new files. Also read the grammar and builder changes upstream made, because Jenny's prompt text and checking layer track them.
