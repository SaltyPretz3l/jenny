"""Check generated renderer catalogs and validate translations."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCALES = ROOT / "locales"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", *args],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )


def main() -> int:
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

        expected = {item.name: item for item in generated_dir.glob("*.catalog.js")}
        actual = {item.name: item for item in LOCALES.glob("*.catalog.js")}
        for name in sorted(expected.keys() - actual.keys()):
            failures.append(f"locales/{name} is missing; run `node scripts/i18n/build-catalogs.js`")
        for name in sorted(actual.keys() - expected.keys()):
            failures.append(f"locales/{name} is orphaned; run `node scripts/i18n/build-catalogs.js`")
        for name in sorted(expected.keys() & actual.keys()):
            if expected[name].read_bytes() != actual[name].read_bytes():
                failures.append(f"locales/{name} differs from regeneration")

    validation = _run("scripts/i18n/validate-catalogs.js", "--strict")
    if validation.stdout:
        print(validation.stdout, end="")
    if validation.stderr:
        print(validation.stderr, end="")
    if validation.returncode != 0:
        failures.append("catalog validation failed")

    if failures:
        print("FAIL: i18n catalogs")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("PASS: i18n catalog scripts are fresh and valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
