"""Fail if the team transport escapes the shape the team program settled on.

The transport is the Rust binary `jenny-team-bridge`, built from
native/jenny-team-bridge/. This check fails when:

1. a Cargo.toml other than that crate's names an `iroh` crate (`iroh` or
   `iroh-*`) in any dependency table;
2. any JavaScript source names the retired Node binding `@number0/iroh`;
3. any JavaScript source outside server/team/transport/ and
   services/team/transport/ names `jenny-team-bridge` (only those two
   directories may locate or spawn the binary);
4. a JavaScript file inside those two directories imports from sidecar/;
5. a Cargo.toml other than that crate's names the `portmapper` crate, that crate's
   own manifest depends on it under another name, a Rust file in that crate other
   than src/portmap.rs names it, or src/portmap.rs re-exports it with `pub use`
   (TEAM_INTERNET_SPEC I2);
6. the crate's iroh dependency could turn on iroh's own port mapper: iroh's
   default features (which include it) or its `portmapper` feature;
7. a Python file under sidecar/ai/, or sidecar/protocol.py, imports `server` or
   `services.team`, names a `server/team` or `services/team` path, or uses team
   vocabulary in code: `team` as a word in an identifier or a string literal, or
   `member_id` / `node_id` (AGENTS.md: "`sidecar/ai/` gains no team knowledge").
   Comments and docstrings are not code. `lease` and `pool` are generic words and
   pass. SIDECAR_ALLOWED lists the few literals that exist today, each with a reason;
8. the crate's src/ names a relay or an address lookup iroh would add on its own
   (any preset but `presets::Minimal`, `N0`, `RelayMode::Default`, `RelayMode::Staging`,
   `default_relay_map`, `iroh::defaults`, `defaults::prod`, `defaults::staging`,
   `proxy_from_env`, `address_lookup`, `iroh.link`): the owner's one relay is all (slice 5-4);
9. iroh's `test-utils` feature (the loopback test relay) is asked for anywhere but the
   crate's `[dev-dependencies]`, including through a `[features]` entry;
10. the test-only relay trust could reach the shipped binary: src/main.rs names the
    `RunOptions` seam that carries it, `insecure_skip_verify` appears in src/, or
    scripts/packaging/build_team_bridge.py turns on a cargo feature;
11. the crate depends on `iroh-relay` (the token-checking test relay) anywhere but its
    `[dev-dependencies]`, or names `iroh_relay` in src/;
12. the crate's `iroh` or `iroh-relay` dependency inherits from a workspace
    (`workspace = true`): rules 6, 9 and 11 read only the crate's own tables.
"""
from __future__ import annotations

import argparse
import ast
import io
import os
import re
import tokenize
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
PORTMAPPER = "portmapper"
PORTMAP_SOURCE = (*BRIDGE_CRATE_DIR, "src", "portmap.rs")

MODULE_REF = re.compile(
    r"""(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+|\bexport\s+[^;\n]*?\bfrom\s+)
        (?P<quote>["'`])(?P<spec>[^"'`]+)(?P=quote)""",
    re.VERBOSE,
)
SIDECAR_SPEC = re.compile(r"(?:^|[\/])sidecar(?:[\/]|$)")
# Rule 7: the sidecar files that must know nothing of the team.
SIDECAR_AI_DIR = ("sidecar", "ai")
SIDECAR_PROTOCOL = ("sidecar", "protocol.py")
# `team` as a word: not inside a longer lower-case word ("steam", "teamwork"), any case, plural too.
TEAM_WORD = re.compile(r"(?<![A-Za-z])(?:team|Team|TEAM)s?(?![a-z])")
TEAM_IDS = re.compile(r"(?<![A-Za-z0-9])(?:member|node)_ids?(?![A-Za-z0-9])")
TEAM_PATH = re.compile(r"(?:server|services)[\\/]team\b")
IDENTIFIER_WORDS = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+")
# (relative path, literal text it may contain): why that literal is not team vocabulary.
SIDECAR_ALLOWED = {
    ("sidecar/ai/mcp/builtin_command_discovery.py", "Microsoft/TeamFoundation/Team Explorer/Git/cmd/git.exe"):
        "the Git that Visual Studio bundles: a product folder name, not team vocabulary",
}
PUB_USE_PORTMAPPER = re.compile(r"\bpub(?:\s*\([^)]*\))?\s+use\s+(?:::)?portmapper\b")
# Rule 8: in the bridge crate's src/ only (its tests may build any endpoint they like).
IROH_EXTRAS = re.compile(
    r"\bN0\b|presets::(?!Minimal\b)|RelayMode::(?:Default|Staging)\b|\bdefault_relay_map\b"
    r"|\biroh::defaults\b|\bdefaults::(?:prod|staging)\b|\bproxy_from_env\b|\baddress_lookup\b"
    r"|iroh\.link"
)
# Rule 9.
TEST_UTILS = "test-utils"
# Rule 10: the seam is `RunOptions::relay_tls`, which only the crate's tests set.
MAIN_SOURCE = (*BRIDGE_CRATE_DIR, "src", "main.rs")
MAIN_TRUST = re.compile(r"\b(?:RunOptions|relay_tls|CaTlsConfig|run_host_with|run_member_with)\b|insecure")
SKIP_VERIFY = "insecure_skip_verify"
PACKAGING_SCRIPT = ("scripts", "packaging", "build_team_bridge.py")
# Rule 11.
IROH_RELAY = "iroh-relay"
IROH_RELAY_IN_RUST = "iroh_relay"
PACKAGING_FEATURES = re.compile(r"""--features|--all-features|["']-F["']|test[-_]utils""")


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


def _shipped_tables(manifest: dict[str, object]) -> list[dict[str, object]]:
    """Every dependency table of the manifest except `[dev-dependencies]`."""
    shipped = [manifest.get("dependencies"), manifest.get("build-dependencies")]
    targets = manifest.get("target")
    if isinstance(targets, dict):
        for target in targets.values():
            if isinstance(target, dict):
                shipped += [target.get("dependencies"), target.get("build-dependencies")]
    return [table for table in shipped if isinstance(table, dict)]


def _inherits_iroh(manifest: dict[str, object]) -> bool:
    """True when an `iroh` or `iroh-relay` entry, in any table, says `workspace = true`."""
    for table in _dependency_tables(manifest):
        for key, spec in table.items():
            if not isinstance(spec, dict) or spec.get("workspace") is not True:
                continue
            if {_normalize(key), _normalize(spec.get("package", key))} & {"iroh", IROH_RELAY}:
                return True
    return False


def _ships_iroh_relay(manifest: dict[str, object]) -> bool:
    """True when `iroh-relay` (by key or `package`) is in a table other than `[dev-dependencies]`."""
    for table in _shipped_tables(manifest):
        for key, spec in table.items():
            name = spec.get("package", key) if isinstance(spec, dict) else key
            if _normalize(key) == IROH_RELAY or _normalize(name) == IROH_RELAY:
                return True
    return False


def _iroh_test_utils(manifest: dict[str, object]) -> bool:
    """True when an iroh dependency outside `[dev-dependencies]` asks for `test-utils`, or a
    `[features]` entry turns it on."""
    for table in _shipped_tables(manifest):
        for key, spec in table.items():
            name = spec.get("package", key) if isinstance(spec, dict) else key
            features = spec.get("features", []) if isinstance(spec, dict) else []
            if _normalize(name) == "iroh" and any(
                _normalize(feature) == TEST_UTILS for feature in features if isinstance(feature, str)
            ):
                return True
    features = manifest.get("features")
    if isinstance(features, dict):
        for enables in features.values():
            if isinstance(enables, list) and any(
                isinstance(item, str) and _normalize(item).endswith(f"/{TEST_UTILS}") for item in enables
            ):
                return True
    return False


def _names(manifest: dict[str, object], is_crate) -> bool:
    for table in _dependency_tables(manifest):
        for key, spec in table.items():
            if is_crate(key):
                return True
            # `alias = { package = "iroh" }` renames the crate it depends on.
            if isinstance(spec, dict) and is_crate(spec.get("package", "")):
                return True
    return False


def _is_portmapper(crate: str) -> bool:
    return _normalize(crate) == PORTMAPPER


def _renames_portmapper(manifest: dict[str, object]) -> bool:
    """True when a dependency's package is portmapper under another key (`pm = { package =
    "portmapper" }`): the Rust scan looks for the literal name, so a rename would hide it."""
    for table in _dependency_tables(manifest):
        for key, spec in table.items():
            if isinstance(spec, dict) and _is_portmapper(spec.get("package", "")):
                if not _is_portmapper(key):
                    return True
    return False


def _iroh_maps_ports(manifest: dict[str, object]) -> bool:
    """True when an iroh dependency of the bridge crate keeps iroh's default features
    (they include its port mapper) or asks for its `portmapper` feature."""
    for table in _dependency_tables(manifest):
        for key, spec in table.items():
            name = spec.get("package", key) if isinstance(spec, dict) else key
            if _normalize(name) != "iroh":
                continue
            if not isinstance(spec, dict):
                return True
            defaults = spec.get("default-features", spec.get("default_features", True))
            features = spec.get("features", [])
            if defaults is not False or not isinstance(features, list):
                return True
            if any(_normalize(feature) in {PORTMAPPER, "default"} for feature in features):
                return True
    return False


def scan_cargo(root: Path) -> list[str]:
    violations: list[str] = []
    for file_path in _walk(root, extra_skip=frozenset(CARGO_SKIP_DIRS)):
        if file_path.name != "Cargo.toml":
            continue
        rel = file_path.relative_to(root)
        try:
            manifest = tomllib.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
            violations.append(f"{rel}: cannot parse manifest: {type(error).__name__}")
            continue
        if rel.parts == (*BRIDGE_CRATE_DIR, "Cargo.toml"):
            if _iroh_maps_ports(manifest):
                violations.append(f"{rel}: iroh's portmapper feature must stay off")
            if _renames_portmapper(manifest):
                violations.append(f"{rel}: portmapper renamed; it must keep its own name")
            if _iroh_test_utils(manifest):
                violations.append(f"{rel}: iroh's test-utils feature outside [dev-dependencies]")
            if _ships_iroh_relay(manifest):
                violations.append(f"{rel}: iroh-relay outside [dev-dependencies]")
            if _inherits_iroh(manifest):
                violations.append(f"{rel}: iroh crate inherited from a workspace")
            continue
        if _names(manifest, _is_iroh):
            violations.append(f"{rel}: iroh dependency outside {BRIDGE_CARGO}")
        if _names(manifest, _is_portmapper):
            violations.append(f"{rel}: portmapper dependency outside {BRIDGE_CARGO}")
    return violations


def _rust_line_hit(rel: Path, line: str) -> str | None:
    """Rules 5, 7 and 9 for one line of a bridge crate Rust file."""
    if rel.parts == PORTMAP_SOURCE:
        if PUB_USE_PORTMAPPER.search(line):
            return "portmapper re-exported"
    elif PORTMAPPER in line:
        return "portmapper named outside src/portmap.rs"
    in_src = rel.parts[: len(BRIDGE_CRATE_DIR) + 1] == (*BRIDGE_CRATE_DIR, "src")
    if not in_src:
        return None
    if IROH_EXTRAS.search(line):
        return "relay or lookup iroh would add"
    if IROH_RELAY_IN_RUST in line:
        return "iroh_relay named in src/"
    if SKIP_VERIFY in line or (rel.parts == MAIN_SOURCE and MAIN_TRUST.search(line)):
        return "test-only relay trust reachable"
    return None


def scan_packaging(root: Path) -> list[str]:
    """Rule 10: the packaging script builds the binary with no cargo feature."""
    script = root.joinpath(*PACKAGING_SCRIPT)
    if not script.is_file():
        return []
    try:
        lines = script.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        return [f"{script.relative_to(root)}: cannot scan source: {type(error).__name__}"]
    rel = script.relative_to(root)
    return [
        f"{rel}:{number}: {line.strip()[:160]}  [test-only relay trust reachable]"
        for number, line in enumerate(lines, start=1)
        if PACKAGING_FEATURES.search(line)
    ]


def scan_rust(root: Path) -> list[str]:
    """The bridge crate's Rust files: `portmapper` outside src/portmap.rs, `pub use portmapper`
    in it, and in src/ a relay or lookup iroh would add or the test-only relay trust."""
    violations: list[str] = []
    for file_path in _walk(root, extra_skip=frozenset(CARGO_SKIP_DIRS)):
        rel = file_path.relative_to(root)
        if file_path.suffix != ".rs" or rel.parts[: len(BRIDGE_CRATE_DIR)] != BRIDGE_CRATE_DIR:
            continue
        try:
            lines = file_path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError) as error:
            violations.append(f"{rel}: cannot scan source: {type(error).__name__}")
            continue
        for number, line in enumerate(lines, start=1):
            hit = _rust_line_hit(rel, line)
            if hit:
                violations.append(f"{rel}:{number}: {line.strip()[:160]}  [{hit}]")
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


def _in_sidecar_scope(rel: Path) -> bool:
    return rel.suffix == ".py" and (
        rel.parts[: len(SIDECAR_AI_DIR)] == SIDECAR_AI_DIR or rel.parts == SIDECAR_PROTOCOL
    )


def _docstring_starts(tree: ast.AST) -> set[tuple[int, int]]:
    """Where each module, class and function docstring starts: a docstring is a comment."""
    starts: set[tuple[int, int]] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                    and isinstance(first.value.value, str):
                starts.add((first.lineno, first.col_offset))
    return starts


def _team_imports(tree: ast.AST) -> list[int]:
    lines: list[int] = []
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        if any(name == "server" or name.startswith("server.") or name == "services.team"
               or name.startswith("services.team.") for name in names):
            lines.append(node.lineno)
    return lines


def _identifier_is_team(name: str) -> bool:
    words = [word.lower() for word in IDENTIFIER_WORDS.findall(name)]
    return any(word in {"team", "teams"} for word in words) or bool(TEAM_IDS.search(name))


def _string_is_team(rel: Path, text: str) -> bool:
    for (path, literal) in SIDECAR_ALLOWED:
        if rel.as_posix() == path and literal in text:
            text = text.replace(literal, "")
    return bool(TEAM_WORD.search(text) or TEAM_IDS.search(text) or TEAM_PATH.search(text))


def scan_sidecar(root: Path) -> list[str]:
    """Rule 7: team imports and team vocabulary in sidecar/ai/ and sidecar/protocol.py."""
    violations: list[str] = []
    sidecar = root / "sidecar"
    if not sidecar.is_dir():
        return violations
    string_tokens = {tokenize.STRING, getattr(tokenize, "FSTRING_MIDDLE", tokenize.STRING)}
    for file_path in _walk(sidecar):
        rel = file_path.relative_to(root)
        if not _in_sidecar_scope(rel):
            continue
        try:
            text = file_path.read_text(encoding="utf-8")
            tree = ast.parse(text)
            tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
        except (OSError, UnicodeError, SyntaxError, tokenize.TokenError) as error:
            violations.append(f"{rel}: cannot scan source: {type(error).__name__}")
            continue
        lines = text.splitlines()
        hits: dict[int, str] = {number: "team import in sidecar" for number in _team_imports(tree)}
        docstrings = _docstring_starts(tree)
        for token in tokens:
            number = token.start[0]
            if token.type == tokenize.NAME and _identifier_is_team(token.string):
                hits.setdefault(number, "team vocabulary in sidecar")
            elif token.type in string_tokens and token.start not in docstrings \
                    and _string_is_team(rel, token.string):
                hits.setdefault(number, "team vocabulary in sidecar")
        for number in sorted(hits):
            shown = lines[number - 1].strip()[:160]
            violations.append(f"{rel}:{number}: {shown}  [{hits[number]}]")
    return violations


def scan(root: Path) -> list[str]:
    return (
        scan_cargo(root)
        + scan_rust(root)
        + scan_packaging(root)
        + scan_javascript(root)
        + scan_sidecar(root)
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=ROOT, help="tree to scan (tests use a temp dir)"
    )
    args = parser.parse_args(argv)

    violations = scan(args.root.resolve())
    if violations:
        print(
            "FAIL: team transport boundary: iroh or portmapper outside the bridge crate, "
            "iroh's own port mapper turned on, portmapper outside src/portmap.rs, a relay or "
            "lookup iroh would add, iroh's test-utils, iroh-relay or the test-only relay trust reachable "
            "from the shipped binary, the retired "
            f"{RETIRED_BINDING} binding, {BRIDGE_BINARY} outside the transport directories, "
            "sidecar imported inside them, or team knowledge in sidecar/ai or sidecar/protocol.py"
        )
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: team transport boundary check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
