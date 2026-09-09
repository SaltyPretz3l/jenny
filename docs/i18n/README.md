---
kind: process-doc
last_reviewed: 2026-09-07
---

# Jenny i18n string ledger

The string ledger is the migration boundary for Jenny's English user-interface copy. It records each literal at each display sink as a separate occurrence, so migrating or deleting one site removes exactly one baseline allowance. The Python policy wrapper runs the Node scanner and is registered in the repository policy sequence.

The scanner covers static root HTML, renderer JavaScript, and the native-dialog and renderer-bound message shapes in Electron services, while model-facing results under `services/tools/` are recorded as `excluded:model`. Python sidecar text is intentionally outside this migration. JavaScript is parsed with Espree rather than regular expressions, allowing template literals, conditionals, concatenations, arrays, and one-hop identifier resolution to retain their source roles.

## Commands

Run these from the repository root:

```text
node scripts/i18n/ledger.js scan
node scripts/i18n/ledger.js check
node scripts/i18n/ledger.js sample --seed 101 --per-stratum 3
node scripts/i18n/build-catalogs.js
node scripts/i18n/validate-catalogs.js
python scripts/checks/check_i18n_ledger.py
python scripts/checks/check_i18n_catalogs.py
```

`scan` regenerates `STRING_LEDGER.json`, `STRING_LEDGER.md`, `locales/en.json`, and `locales/qps-ploc.json`. It does not change the shrink-only baseline. `scan --write-baseline` rewrites `string_ledger_baseline.json` and is reserved for intentional baseline creation or removal after review. `sample` regenerates `SAMPLING_AUDIT.md`; reviewer verdicts are then filled manually and are not checked by the scanner.

`check` compares every generated artifact byte-for-byte, rejects pending occurrence IDs absent from the baseline, rejects stale baseline IDs, and rejects scanner errors. A normal copy migration therefore shrinks the baseline; new untranslated copy cannot silently replace it.

## Catalog files

The JSON files in `locales/` are the translation source catalogs. Run `build-catalogs.js` after a ledger scan or translation edit to deterministically write the browser-ready `<tag>.catalog.js` files; the generated scripts register through `jennyI18n.load(...)`, and the builder removes scripts that no longer have matching JSON. `validate-catalogs.js` checks non-English catalogs for English-key parity, locale plural categories, placeholders, markup, carriage returns, and excessive expansion. The policy wrapper verifies committed scripts against a temporary regeneration before validating them.

## Migrating a string

For JavaScript UI copy, replace the literal at its display site with `jt('dotted.key', 'English default', params)`. Use `jtn('dotted.key', count, params, 'one form', 'other form')` for plural copy. The scanner recognizes `jennyI18n.t` and `jennyI18n.tn` equivalents as well. Keep parameter tokens in `{name}` form so English and pseudolocale catalogs preserve them.

For static HTML, add `data-i18n="dotted.key"` to cover a leaf element's direct text. A text marker must not have child elements because applying it would replace the entire subtree; the runtime defensively skips such text replacements. Attribute copy uses the matching attribute marker, such as `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-placeholder`, or `data-i18n-alt`, and those attribute markers remain valid on non-leaf elements.

After migration:

1. Run `node scripts/i18n/ledger.js scan`.
2. Remove the stale migrated occurrence ID reported by `check` from `string_ledger_baseline.json`; do not regenerate the whole baseline merely to hide unexplained growth.
3. Run `node scripts/i18n/ledger.js check` and the focused tests.

The English catalog is derived from defaults at translation calls and current English content at marked HTML sites. Conflicting defaults for the same key are scanner errors. The pseudolocale accents text, adds expansion padding, and leaves `{param}` tokens unchanged.

## Scanner errors

- Translation keys must be plain string literals. Defaults must be plain string literals, expression-free template literals, or static concatenations containing only plain string literals; dynamic keys, identifiers, and templates containing `${}` expressions are errors.
- A `data-i18n` text marker on an element with any child element is a `non-leaf data-i18n` error. Use markers on the leaf text nodes instead; `data-i18n-*` attribute markers are unaffected.

## Dispositions

- `pending`: user-facing copy that still needs a translation key. In `renderer/**`, the `prose` catch-all keeps the two-word threshold for plain literals. An interpolated template instead requires a free-standing static word: for each whitespace-delimited token, strip at most one allowed leading wrapper and trailing punctuation character, then strip one expression marker glued at the start or end (not both and never in the middle); the result must contain only Unicode letters and apostrophes, with at least three letters (or two when the stripped trailing character was `?` or `:`). It covers returned, array-pushed, concatenated, templated, property, and argument copy, and splits quoted HTML into text nodes and display-attribute values instead of recording the whole fragment.
- `migrated`: a fallback owned by `jt` or `jtn`, or HTML text/attributes covered by a matching `data-i18n*` marker.
- `excluded:<reason>`: a role-based non-UI occurrence such as diagnostic logging, single-token structural wire vocabulary, DOM identity, model-facing instructions, fixed error codes, proper nouns, or strings without an alphabetic word. The prose catch-all also skips translation and log-helper arguments, CSS and selector strings, URLs and paths, DOM identity/dataset values, regular-expression sources, wire values, comments, and expression-only templates. Keyboard chords such as `Ctrl+Shift+O` are recorded as `excluded:chord`. A string with whitespace under a wire-named property such as `status`, `state`, or `mode` remains pending `config_copy`; in `services/**`, whitespace-free `ipc_message` values remain `excluded:wire` unless they start with an uppercase letter and end in `.`, `!`, or `?`, in which case they remain pending sentences. Role evidence from DOM identity, datasets, selectors, and similar sinks still takes precedence. Lowercase words are never excluded merely because of spelling.
- String operands in equality or relational comparisons, switch cases, and identity-helper calls such as `includes`, `startsWith`, and `indexOf`, plus string values under ALL-CAPS constants ending in `_HINTS`, `_VOCABULARY`, `_KEYWORDS`, `_MATCHERS`, or `_ALIASES`, are recorded as `excluded:comparison`.
- Partial markup literals are split into display-attribute copy and stripped text, while tag and non-display-attribute scaffolding is excluded and a stripped fragment with no alphabetic word of at least two letters emits no row.
- String-valued properties in the params object of renderer `jt`/`jtn` and service `t` calls are scanned through the prose rules, including literals, templates, conditionals, and `||` fallbacks, while wire and identity properties remain excluded.
- Translation calls are registered before subtree suppression, so nested `jt`, `jtn`, and service `t` defaults still populate the catalogs inside params, logs, invariants, and comparisons.
- Invariants are limited to `throw` arguments, constructed `*Error` values, and `assert*` or `invariant*` calls; the presentation callees `showError`, `renderError`, `displayError`, `notifyError`, `toastError`, `reportError`, `presentError`, `setError`, `pushError`, and `announceError` keep their first argument pending as display copy.
- CSS exclusion requires declaration, selector-only, or `var(--x)`/`rgba(`/`calc(` syntax, so a semicolon between prose clauses remains pending.
- Lowercase whitespace-separated class lists are excluded only in DOM class, class-list, markup, or selector contexts, while the same shape elsewhere remains prose.
- Translation-param prose accepts two alphabetic words of any length or one alphabetic word of at least three letters, so short fallbacks such as `a file` remain visible to migration.
- `remainder:<name>`: a named, reviewed migration remainder.

## Known limits

Prose detection is heuristic: the two-word threshold intentionally leaves plain single-word labels in unrecognised constructions to the sampling audit.

Comparison-vocabulary tables use the narrow ALL-CAPS suffix convention above rather than whole-file reference analysis.

## Generated records and review

`STRING_LEDGER.json` is the machine-readable occurrence record. IDs are based on file, kind, normalized text, and same-triple source ordinal; line numbers are diagnostic only and do not affect identity. `STRING_LEDGER.md` provides domain and kind rollups. `SAMPLING_AUDIT.md` draws deterministic pending and excluded samples from every populated domain-by-kind stratum for source review.

Parse failures and scanner errors are retained in the ledger's `errors` array while scanning continues, then fail both `scan` and `check`. Generated artifacts use one shared code-unit ordinal comparator for sorted paths, keys, errors, and occurrences, making the bytes independent of the host locale; formatting remains two-space JSON with LF endings and no timestamps.

## Named remainders

Named remainders live in `scripts/i18n/remainders.json` and match occurrences by exact `file` plus `text`; each entry requires a stable name and rationale, and `check` rejects entries that no longer match anything. They are narrow reviewed exceptions, not a general allowlist.

## Translations

The shipped languages are the tags listed in `services/shell-config-normalizers.js` (`en` plus 18 others); the first-run default comes from the operating-system locale mapped onto that set in `renderer/shared/i18n-utils.js`, and Settings > Appearance > Language overrides it. The bootstrap sets `<html lang dir>` once at boot (`ar` is right-to-left), and Settings only saves the choice, so a language change takes effect after a restart.

The non-English catalogs in `locales/` are machine-drafted for 1.0.1: each language was authored in one Codex session from `locales/en.json`, sentence by sentence, with a residual-English audit and the mechanical validator as the floor. They have not been reviewed by native speakers. Treat wording reports as ordinary bugs: fix the value in `locales/<tag>.json`, run `node scripts/i18n/build-catalogs.js`, and commit both files. A dictionary or word-substitution generator is not an acceptable way to produce or repair a catalog; the first 1.0.1 drafts made that way were discarded.

`validate-catalogs.js` fails on unknown keys, placeholder or plural mismatches, markup, carriage returns, and excessive expansion. The policy wrapper `check_i18n_catalogs.py` always uses `--strict`: every shipped language must cover every English key family in the same change. Use `node scripts/i18n/validate-catalogs.js --strict --only <tag>` while drafting a language. The standalone validator's non-strict mode still supports incomplete drafts with warnings and a 90% floor; it is not the shipping gate. The ledger rejects CSP values in translation calls; security policies remain code constants.

The hosted browser also loads the shared runtime and catalogs. It uses the saved
`jenny.ui.language` preference, otherwise the browser language, before the first
render. Catalog failure falls back to English. Hosted catalogs are immutable build
assets served at fixed `/locales/<tag>.json` routes, including before login.

Manual gates for the languages (first paint, pseudolocale walkthrough, live switch, CJK glyphs, RTL, secondary windows) are recorded in `docs/operations/MANUAL_TEST_MATRIX.md`.
