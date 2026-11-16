"""Check generated renderer catalogs and validate translations.

The per-commit run checks that the catalog scripts are fresh and that every
translation present is well-formed; a key a language does not have yet falls
back to English and is only counted. `--strict` is the public-release gate:
every language covers every English key and English has not moved since the
last translation pass (`scripts/i18n/translation-pass.js`).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCALES = ROOT / "locales"
# Validator warnings the translation pass repays; summarized, not listed.
_PENDING_SUFFIXES = (": missing English key", ": unknown key", ": stale translation")
MARKER = ROOT / "scripts" / "i18n" / "translation-sync.json"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", *args],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )


def _base_english(directory: Path) -> Path | None:
    """The English catalog of the last translation pass, or None when git cannot supply it.

    With it the validator can tell a translation that English has since moved
    away from (the pass's work) from one that is wrong; without it both fail.
    """
    try:
        commit = json.loads(MARKER.read_text(encoding="utf-8"))["englishCommit"]
    except (OSError, ValueError, KeyError):
        return None
    blob = subprocess.run(
        ["git", "show", f"{commit}:locales/en.json"], cwd=ROOT, check=False, capture_output=True
    )
    if blob.returncode != 0:
        return None
    target = directory / "base-en.json"
    target.write_bytes(blob.stdout)
    return target


def _print_validation(validation: subprocess.CompletedProcess[str]) -> None:
    pending = 0
    languages: set[str] = set()
    if validation.stdout:
        print(validation.stdout, end="")
    for line in validation.stderr.splitlines():
        if line.startswith("WARN: ") and line.endswith(_PENDING_SUFFIXES):
            pending += 1
            languages.add(line[len("WARN: "):].split(":", 1)[0])
        else:
            print(line)
    if pending:
        print(
            f"NOTE: {pending} key(s) across {len(languages)} language(s) await the translation "
            "pass (English is shown until then); see docs/i18n/README.md"
        )


def _script_drift(generated_dir: Path) -> list[str]:
    rebuild = "run `node scripts/i18n/build-catalogs.js`"
    expected = {item.name: item for item in generated_dir.glob("*.catalog.js")}
    actual = {item.name: item for item in LOCALES.glob("*.catalog.js")}
    missing = sorted(expected.keys() - actual.keys())
    orphaned = sorted(actual.keys() - expected.keys())
    drift = [f"locales/{name} is missing; {rebuild}" for name in missing]
    drift += [f"locales/{name} is orphaned; {rebuild}" for name in orphaned]
    drift += [
        f"locales/{name} differs from regeneration"
        for name in sorted(expected.keys() & actual.keys())
        if expected[name].read_bytes() != actual[name].read_bytes()
    ]
    return drift


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Public-release gate: fail on any untranslated, stale or leftover key.",
    )
    args = parser.parse_args(argv)

    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="jenny-i18n-catalogs-") as temporary:
        generated_dir = Path(temporary) / "locales"
        generated_dir.mkdir()
        for source in LOCALES.glob("*.json"):
            shutil.copyfile(source, generated_dir / source.name)
        build = _run(
            "scripts/i18n/build-catalogs.js",
            "--locales-dir",
            str(generated_dir),
        )
        if build.returncode != 0:
            print(build.stdout, end="")
            print(build.stderr, end="")
            return build.returncode

        failures.extend(_script_drift(generated_dir))

        if args.strict:
            mode = ["--strict"]
        else:
            base = _base_english(Path(temporary))
            mode = ["--base-english", str(base)] if base else []
        validation = _run("scripts/i18n/validate-catalogs.js", *mode)
        _print_validation(validation)
        if validation.returncode != 0:
            failures.append("catalog validation failed")

    if args.strict:
        sync = _run("scripts/i18n/translation-pass.js", "check")
        print(sync.stdout, end="")
        print(sync.stderr, end="")
        if sync.returncode != 0:
            failures.append("English changed since the last translation pass")

    if failures:
        print("FAIL: i18n catalogs")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("PASS: i18n catalog scripts are fresh and valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
