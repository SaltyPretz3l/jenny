"""Fail if the team transport escapes the shape the team program settled on.

The transport is the Rust binary `jenny-team-bridge`, built from
native/jenny-team-bridge/. This check fails when:

1. a Cargo.toml other than that crate's names an `iroh` crate (`iroh` or
   `iroh-*`) in any dependency table;
2. any JavaScript source names the retired Node binding `@number0/iroh`;
3. any JavaScript source outside server/team/transport/ and
   services/team/transport/ names `jenny-team-bridge` (only those two
   directories may locate or spawn the binary);
4. a JavaScript file inside those two directories imports from sidecar/.
"""
from __future__ import annotations

import argparse
import os
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALLOWED_DIRS = (("server", "team", "transport"), ("services", "team", "transport"))
BRIDGE_CRATE_DIR = ("native", "jenny-team-bridge")
BRIDGE_CARGO = "/".join(BRIDGE_CRATE_DIR)
# Never entered, at any depth (dot directories are skipped as well). `target` is cargo's
# build output: gigabytes of files and never source.
SKIP_DIRS = {"node_modules", "venv", "__pycache__", "target"}
# Cargo build output; skipped at any depth when looking for manifests.
CARGO_SKIP_DIRS = {"target"}
# Skipped at the top of the tree only: the test tree and build outputs. A
# directory of the same name further down (scripts/build, scripts/tests) is source.
ROOT_SKIP_DIRS = {
    "tests", "dist", "build", "out", "coverage", "release", "release-unpacked", "dist-electron",
}
SUFFIXES = {".js", ".cjs", ".mjs", ".ts"}
RETIRED_BINDING = "@number0/iroh"
BRIDGE_BINARY = "jenny-team-bridge"
DEPENDENCY_TABLES = ("dependencies", "dev-dependencies", "build-dependencies")

MODULE_REF = re.compile(
    r"""(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+|\bexport\s+[^;\n]*?\bfrom\s+)
        (?P<quote>["'`])(?P<spec>[^"'`]+)(?P=quote)""",
    re.VERBOSE,
)
SIDECAR_SPEC = re.compile(r"(?:^|[\/])sidecar(?:[\/]|$)")


def _inside_allowed(rel: Path) -> bool:
    return any(rel.parts[: len(allowed)] == allowed for allowed in ALLOWED_DIRS)


def _walk(root: Path, *, extra_skip: frozenset[str] = frozenset()) -> list[Path]:
    """Every file under root. Skipped and dot directories are never entered:
    dependency trees are large, and .claude/ holds other checkouts of this repo."""
    found: list[Path] = []
    for current, dirs, files in os.walk(root):
        at_root = Path(current) == root
        dirs[:] = [
            name for name in dirs
            if name not in SKIP_DIRS and name not in extra_skip and not name.startswith(".")
            and not (at_root and name in ROOT_SKIP_DIRS)
        ]
        found.extend(Path(current, name) for name in files)
    return sorted(found)


def _normalize(crate: object) -> str:
    return str(crate).strip().lower().replace("_", "-")


def _is_iroh(crate: str) -> bool:
    name = _normalize(crate)
    return name == "iroh" or name.startswith("iroh-")


def _dependency_tables(manifest: dict[str, object]) -> list[dict[str, object]]:
    tables: list[dict[str, object]] = []

    def collect(owner: object) -> None:
        if not isinstance(owner, dict):
            return
        for key in DEPENDENCY_TABLES:
            table = owner.get(key)
            if isinstance(table, dict):
                tables.append(table)

    collect(manifest)
    workspace = manifest.get("workspace")
    if isinstance(workspace, dict) and isinstance(workspace.get("dependencies"), dict):
        tables.append(workspace["dependencies"])
    targets = manifest.get("target")
    if isinstance(targets, dict):
        for target in targets.values():
            collect(target)
    return tables


def _names_iroh(manifest: dict[str, object]) -> bool:
    for table in _dependency_tables(manifest):
        for key, spec in table.items():
            if _is_iroh(key):
                return True
            # `alias = { package = "iroh" }` renames the crate it depends on.
            if isinstance(spec, dict) and _is_iroh(spec.get("package", "")):
                return True
    return False


def scan_cargo(root: Path) -> list[str]:
    violations: list[str] = []
    for file_path in _walk(root, extra_skip=frozenset(CARGO_SKIP_DIRS)):
        if file_path.name != "Cargo.toml":
            continue
        rel = file_path.relative_to(root)
        if rel.parts == (*BRIDGE_CRATE_DIR, "Cargo.toml"):
            continue
        try:
            manifest = tomllib.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
            violations.append(f"{rel}: cannot parse manifest: {type(error).__name__}")
            continue
        if _names_iroh(manifest):
            violations.append(f"{rel}: iroh dependency outside {BRIDGE_CARGO}")
    return violations


def scan_javascript(root: Path) -> list[str]:
    violations: list[str] = []
    for file_path in _walk(root):
        if file_path.suffix not in SUFFIXES:
            continue
        rel = file_path.relative_to(root)
        allowed = _inside_allowed(rel)
        try:
            text = file_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            violations.append(f"{rel}: cannot scan source: {type(error).__name__}")
            continue
        lines = text.splitlines()
        hits: dict[int, str] = {}
        for number, line in enumerate(lines, start=1):
            if RETIRED_BINDING in line:
                hits[number] = f"the retired {RETIRED_BINDING} binding"
            elif not allowed and BRIDGE_BINARY in line:
                hits[number] = f"{BRIDGE_BINARY} named outside the transport directories"
        if allowed:
            # Matched over the whole text, so a specifier wrapped onto the line after
            # `require(` is still seen. The reported line is the specifier's.
            for match in MODULE_REF.finditer(text):
                if SIDECAR_SPEC.search(match.group("spec")):
                    number = text.count("\n", 0, match.start("spec")) + 1
                    hits.setdefault(number, "sidecar imported inside the transport directories")
        for number in sorted(hits):
            shown = lines[number - 1].strip()[:160]
            violations.append(f"{rel}:{number}: {shown}  [{hits[number]}]")
    return violations


def scan(root: Path) -> list[str]:
    return scan_cargo(root) + scan_javascript(root)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=ROOT, help="tree to scan (tests use a temp dir)"
    )
    args = parser.parse_args(argv)

    violations = scan(args.root.resolve())
    if violations:
        print(
            "FAIL: team transport boundary: iroh outside the bridge crate, the retired "
            f"{RETIRED_BINDING} binding, {BRIDGE_BINARY} outside the transport directories, "
            "or sidecar imported inside them"
        )
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: team transport boundary check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
