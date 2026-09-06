"""Fail if a doc-bearing code surface changed without a paired doc update.

Enforces the source-of-truth doctrine codified in
``docs/process/DOC_AS_CODE.md``: when an Electron IPC channel, sidecar
JSON-RPC method, persisted schema, ``turn_events[]`` kind, public tool id,
or packaging-manifest surface changes, the matching documentation or
domain manifest must update in the same diff.

The ``ui-ux`` domain is intentionally excluded from fallback enforcement.
Renderer surface paths (``index.html``, ``renderer/``, ``styles/``,
``comet/``) do not require a same-task ``docs/manifests/ui-ux.md`` or
``docs/ui/*_UI_MAP.md`` update. That manifest and its UI maps are
refreshed on explicit user request via a dedicated reconciliation task,
not paired with each renderer edit.

The check follows the same source-of-changed-files priority as
``check_workspace_manifest.py``:

1. ``--changed-file`` repeatable arguments
2. ``JENNYGC3_CHANGED_FILES`` environment variable
3. ``git diff --name-only --diff-filter=ACDMR`` against the merge base with
   ``origin/main`` (falling back to local ``main``), plus
   ``git status --porcelain`` for uncommitted work

If none of those resolve a list, the check passes with a WARN explaining
how to enable enforcement. Mirrors the manifest check's fallback so
exported / no-git workspaces are not blocked.

Allowlist: when the HEAD commit message contains ``[skip-doc]`` the check
passes with an INFO line. The marker is observable in ``git log`` and
cannot be accidentally bypassed by tooling defaults.
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

ROOT = Path(__file__).resolve().parents[2]
CHANGED_FILES_ENV = "JENNYGC3_CHANGED_FILES"
# origin/main first: on a checkout of local main itself, merge-base against
# local main is HEAD and the diff is empty, so every commit-range-driven check
# passes vacuously. The pushed base is the meaningful comparison point; local
# main remains the fallback for clones without a remote.
DEFAULT_MERGE_BASE_REFS = ("origin/main", "main")
SKIP_MARKER = "[skip-doc]"
DOMAIN_MANIFESTS = (
    "docs/manifests/ui-ux.md",
    "docs/manifests/electron-wiring.md",
    "docs/manifests/sidecar-runtime.md",
    "docs/manifests/plugin-system.md",
)
# Subset of DOMAIN_MANIFESTS whose 'paths:' fall through to the fallback
# violation rule. ui-ux is excluded because that manifest (and the UI-map
# pages it covers) is refreshed on explicit user request, not paired with
# each renderer edit. See docs/process/DOC_AS_CODE.md.
FALLBACK_ENFORCED_MANIFESTS = (
    "docs/manifests/electron-wiring.md",
    "docs/manifests/sidecar-runtime.md",
    "docs/manifests/plugin-system.md",
)
FRONTMATTER_PATTERN = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)

# Hand-curated mapping: when a surface key matches (exact path or glob),
# at least one of the listed paired-doc patterns must also appear in the
# diff. A doc pattern that ends in ``/`` matches any file under that
# prefix; otherwise the pattern is treated as a glob through ``fnmatch``.
SURFACE_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "sidecar/protocol.py",
        (
            "docs/manifests/sidecar-runtime.md",
            "docs/operations/*.md",
            "docs/process/DOC_AS_CODE.md",
        ),
    ),
    (
        "services/plugins/*",
        (
            "docs/manifests/plugin-system.md",
            "PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md",
        ),
    ),
    (
        "config/plugins/*",
        (
            "docs/manifests/plugin-system.md",
            "PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md",
        ),
    ),
    (
        "sidecar/ai/plugins/*",
        (
            "docs/manifests/plugin-system.md",
            "PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md",
        ),
    ),
    (
        "sidecar/ai/tools/builtins/*.py",
        (
            "docs/TOOLS.md",
            "services/tools/tool-manifest.json",
        ),
    ),
    (
        "services/backend/canonical-turn-event-collector.js",
        (
            "docs/operations/turn-diagnostic-schema.md",
            "docs/manifests/electron-wiring.md",
        ),
    ),
    (
        "services/scheduler-task-registry.js",
        (
            "docs/operations/SUB_AGENT_SCHEDULING.md",
            "docs/operations/SUB_AGENT_DESIGN.md",
            "docs/manifests/electron-wiring.md",
        ),
    ),
    (
        "services/scheduler-service.js",
        (
            "docs/operations/SUB_AGENT_SCHEDULING.md",
            "docs/operations/SUB_AGENT_DESIGN.md",
            "docs/manifests/electron-wiring.md",
        ),
    ),
    (
        "services/scheduler-schema-version.js",
        (
            "docs/operations/SUB_AGENT_SCHEDULING.md",
            "docs/manifests/electron-wiring.md",
        ),
    ),
    (
        "preload.js",
        (
            "docs/manifests/electron-wiring.md",
            "docs/operations/CONCURRENCY_MODEL.md",
        ),
    ),
    (
        "services/tools/tool-manifest.json",
        (
            "docs/TOOLS.md",
            "docs/manifests/electron-wiring.md",
        ),
    ),
)


@dataclass(frozen=True)
class SurfaceViolation:
    changed_path: str
    paired_docs: tuple[str, ...]


def _normalize_repo_path(raw_path: str | os.PathLike[str]) -> str:
    token = str(raw_path or "").strip().replace("\\", "/")
    while token.startswith("./"):
        token = token[2:]
    return token


def _path_matches_pattern(candidate: str, pattern: str) -> bool:
    normalized = _normalize_repo_path(candidate)
    if not normalized or not pattern:
        return False
    if pattern.endswith("/"):
        return normalized.startswith(pattern)
    return fnmatch.fnmatchcase(normalized, pattern)


def _run_git_command(arguments: Sequence[str]) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except OSError as error:
        return 1, "", str(error)
    return completed.returncode, completed.stdout, completed.stderr


def _parse_changed_paths(lines: str) -> list[str]:
    changed: list[str] = []
    seen: set[str] = set()
    for raw_line in lines.splitlines():
        normalized = _normalize_repo_path(raw_line)
        if not normalized or normalized in seen:
            continue
        changed.append(normalized)
        seen.add(normalized)
    return changed


def _parse_status_paths(lines: str) -> list[str]:
    changed: list[str] = []
    seen: set[str] = set()
    for raw_line in lines.splitlines():
        line = raw_line.rstrip("\n")
        if len(line) < 4:
            continue
        path_text = line[3:].strip()
        if not path_text:
            continue
        if " -> " in path_text:
            path_text = path_text.split(" -> ", maxsplit=1)[1]
        normalized = _normalize_repo_path(path_text)
        if not normalized or normalized in seen:
            continue
        candidate = ROOT / normalized
        if candidate.is_dir():
            for child in candidate.rglob("*"):
                if not child.is_file():
                    continue
                child_normalized = _normalize_repo_path(child.relative_to(ROOT))
                if not child_normalized or child_normalized in seen:
                    continue
                changed.append(child_normalized)
                seen.add(child_normalized)
            continue
        changed.append(normalized)
        seen.add(normalized)
    return changed


def _collect_git_changed_files(
    base_ref: str | None, head_ref: str | None
) -> tuple[list[str], str | None]:
    if not (ROOT / ".git").exists():
        return [], f"no .git metadata under {_normalize_repo_path(str(ROOT))}"

    return_code, stdout, stderr = _run_git_command(["rev-parse", "--is-inside-work-tree"])
    if return_code != 0 or stdout.strip().lower() != "true":
        detail = stderr.strip() or stdout.strip() or "not a git work tree"
        return [], f"git repository check failed: {detail}"

    if base_ref or head_ref:
        base = (base_ref or "HEAD~1").strip() or "HEAD~1"
        head = (head_ref or "HEAD").strip() or "HEAD"
        return_code, stdout, stderr = _run_git_command(
            ["diff", "--name-only", "--diff-filter=ACDMR", f"{base}...{head}"]
        )
        if return_code != 0:
            detail = stderr.strip() or stdout.strip() or "git diff failed"
            return [], f"git diff failed for range {base}...{head}: {detail}"
        return _parse_changed_paths(stdout), None

    merge_base_changed: list[str] = []
    merge_base_errors: list[str] = []
    for merge_base_ref in DEFAULT_MERGE_BASE_REFS:
        merge_base_code, merge_base_stdout, merge_base_stderr = _run_git_command(
            ["merge-base", merge_base_ref, "HEAD"]
        )
        if merge_base_code != 0 or not merge_base_stdout.strip():
            detail = merge_base_stderr.strip() or merge_base_stdout.strip() or "git merge-base failed"
            merge_base_errors.append(
                f"git merge-base failed for {merge_base_ref} and HEAD: {detail}"
            )
            continue

        merge_base_commit = merge_base_stdout.strip()
        diff_code, diff_stdout, diff_stderr = _run_git_command(
            ["diff", "--name-only", "--diff-filter=ACDMR", f"{merge_base_commit}...HEAD"]
        )
        if diff_code == 0:
            merge_base_changed = _parse_changed_paths(diff_stdout)
            merge_base_errors = []
            break
        detail = diff_stderr.strip() or diff_stdout.strip() or "git diff failed"
        merge_base_errors.append(
            f"git diff from merge-base {merge_base_commit}...HEAD failed: {detail}"
        )
    merge_base_error = "; ".join(merge_base_errors) or None

    status_code, status_stdout, status_stderr = _run_git_command(
        ["status", "--porcelain", "--untracked-files=normal"]
    )
    if status_code != 0:
        if merge_base_changed:
            return merge_base_changed, None
        detail = status_stderr.strip() or status_stdout.strip() or "git status failed"
        if merge_base_error is not None:
            return [], f"{merge_base_error}; git status failed: {detail}"
        return [], f"git status failed: {detail}"

    status_changed = _parse_status_paths(status_stdout)
    if merge_base_changed:
        combined: list[str] = []
        seen: set[str] = set()
        for item in [*merge_base_changed, *status_changed]:
            if item and item not in seen:
                combined.append(item)
                seen.add(item)
        return combined, None
    return status_changed, None


def _collect_changed_files(args: argparse.Namespace) -> tuple[str, list[str], str | None]:
    explicit = [
        _normalize_repo_path(path) for path in args.changed_file if _normalize_repo_path(path)
    ]
    if explicit:
        deduped: list[str] = []
        seen: set[str] = set()
        for item in explicit:
            if item in seen:
                continue
            deduped.append(item)
            seen.add(item)
        return "explicit", deduped, None

    env_changed = _parse_changed_paths(os.environ.get(CHANGED_FILES_ENV, ""))
    if env_changed:
        return "env", env_changed, None

    changed, fallback_reason = _collect_git_changed_files(args.base_ref, args.head_ref)
    return "git", changed, fallback_reason


def _read_head_commit_message() -> str:
    if not (ROOT / ".git").exists():
        return ""
    return_code, stdout, _stderr = _run_git_command(["log", "-1", "--pretty=%B"])
    if return_code != 0:
        return ""
    return stdout


def _has_skip_marker() -> bool:
    return SKIP_MARKER in _read_head_commit_message()


def _worktree_has_changes() -> bool:
    return_code, stdout, _stderr = _run_git_command(
        ["status", "--porcelain", "--untracked-files=normal"]
    )
    if return_code != 0:
        # Fail closed: an unknown worktree state must not license a bypass.
        return True
    return bool(_parse_status_paths(stdout))


def _skip_marker_applies(args: argparse.Namespace, source: str) -> bool:
    """Whether HEAD's [skip-doc] marker may waive THIS change set.

    The marker lives in HEAD's commit message, so it can only speak for what HEAD
    itself introduced. Three change sets it must never waive, because whoever wrote
    that message never saw them:

    - ``--changed-file`` / ``JENNYGC3_CHANGED_FILES`` input, which is someone else's
      list of paths and has no relationship to HEAD at all;
    - an explicit ``--base-ref``/``--head-ref`` range, which need not contain HEAD;
    - uncommitted working-tree changes -- which is EVERY pre-commit run. The hook
      fires before the new commit exists, so HEAD is the PREVIOUS commit, and its
      marker was waiving the commit being made. Programs that tag many commits
      [skip-doc] therefore had the bypass live on the very next commit, every time.

    Consequence worth knowing: at pre-commit the marker is inert by construction.
    It is honoured when validating committed history on a clean tree (CI, or a
    manual run after committing). The pre-commit escape hatch is ``git commit
    --no-verify``, which .git/hooks/pre-commit documents.
    """
    if source != "git" or args.base_ref or args.head_ref:
        return False
    if _worktree_has_changes():
        return False
    return _has_skip_marker()


def _load_manifest_paths(manifest_path: str) -> tuple[str, ...]:
    """Return the ``paths:`` entries from a domain manifest.

    Lightweight YAML parser — only handles the list-of-strings shape that
    workspace manifests are contracted to use. Mirrors the parse helpers in
    ``check_workspace_manifest.py`` but is intentionally minimal here.
    """
    full_path = ROOT / manifest_path
    if not full_path.exists():
        return ()
    text = full_path.read_text(encoding="utf-8", errors="replace")
    match = FRONTMATTER_PATTERN.match(text)
    if not match:
        return ()
    block = match.group(1)
    paths: list[str] = []
    in_paths = False
    for raw_line in block.splitlines():
        if raw_line.startswith("paths:"):
            in_paths = True
            continue
        if in_paths:
            stripped = raw_line.lstrip()
            if not raw_line.startswith(" ") and not raw_line.startswith("\t"):
                break
            if stripped.startswith("- "):
                value = stripped[2:].strip()
                if (value.startswith("'") and value.endswith("'")) or (
                    value.startswith('"') and value.endswith('"')
                ):
                    value = value[1:-1]
                if value:
                    paths.append(_normalize_repo_path(value))
            elif stripped == "":
                continue
            else:
                break
    return tuple(paths)


def _classify_surface_pairings(
    changed_files: Sequence[str],
) -> tuple[list[SurfaceViolation], set[str]]:
    """Walk SURFACE_RULES once, returning the unpaired changes and the paired ones.

    The fallback rule needs the second half to answer "is this path already
    documented?", and deriving it from a second copy of this loop is how the two
    answers drift apart. Only the FIRST matching surface key applies to a path --
    the ``break`` is part of the contract, not an optimisation.
    """
    violations: list[SurfaceViolation] = []
    satisfied: set[str] = set()
    for changed in changed_files:
        for surface_key, paired_docs in SURFACE_RULES:
            if not _path_matches_pattern(changed, surface_key):
                continue
            if any(
                _path_matches_pattern(candidate, paired)
                for candidate in changed_files
                for paired in paired_docs
            ):
                satisfied.add(changed)
            else:
                violations.append(
                    SurfaceViolation(changed_path=changed, paired_docs=paired_docs)
                )
            break
    return violations, satisfied


def _find_surface_violations(changed_files: Sequence[str]) -> list[SurfaceViolation]:
    return _classify_surface_pairings(changed_files)[0]


def _find_fallback_violations(changed_files: Sequence[str]) -> list[str]:
    """Report changes under an enforced manifest that nothing in the diff documents.

    Judged per OWNING manifest. The previous rule returned [] the moment any
    ``docs/**`` path appeared anywhere in the change set, so a single unrelated doc
    edit -- a typo fix in TESTING_STRATEGY.md -- waived every fallback violation in
    the same diff, including undocumented backend changes it had nothing to do with.

    A path is documented when EITHER its owning manifest page changed, OR it already
    satisfied one of its SURFACE_RULES pairings. The second clause is what keeps a
    builtin tool paired with docs/TOOLS.md passing without also demanding the
    sidecar-runtime manifest it happens to sit under.
    """
    _, satisfied_by_surface = _classify_surface_pairings(changed_files)
    fallback: list[str] = []
    seen: set[str] = set()
    for manifest_path in FALLBACK_ENFORCED_MANIFESTS:
        if manifest_path in changed_files:
            continue
        manifest_paths = _load_manifest_paths(manifest_path)
        if not manifest_paths:
            continue
        for changed in changed_files:
            if changed in seen:
                continue
            if changed.startswith("docs/"):
                continue
            if changed in satisfied_by_surface:
                continue
            if any(_path_matches_pattern(changed, target) for target in manifest_paths):
                fallback.append(
                    f"{changed} falls under {manifest_path} 'paths:' "
                    f"but neither {manifest_path} nor a paired doc changed in the diff"
                )
                seen.add(changed)
    return fallback


def _format_violation(violation: SurfaceViolation) -> str:
    paired_list = ", ".join(violation.paired_docs)
    return (
        f"{violation.changed_path} changed but none of the paired docs were updated: "
        f"{paired_list}"
    )


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--changed-file",
        action="append",
        default=[],
        help="Explicit changed repo-relative path (repeatable)",
    )
    parser.add_argument("--base-ref", default=None, help="Optional git base ref for diff collection")
    parser.add_argument("--head-ref", default=None, help="Optional git head ref for diff collection")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)

    source, changed_files, fallback_reason = _collect_changed_files(args)
    if fallback_reason is not None:
        print("PASS: doc-as-code pairing")
        print(
            "WARN: doc-as-code pairing not enforced: "
            f"{fallback_reason}; provide --changed-file or {CHANGED_FILES_ENV} "
            "to validate doc-bearing surfaces in exported/no-git workspaces"
        )
        return 0

    if _skip_marker_applies(args, source):
        print("PASS: doc-as-code pairing")
        print(f"INFO: skipped via {SKIP_MARKER} marker on HEAD commit")
        return 0

    surface_violations = _find_surface_violations(changed_files)
    fallback_violations = _find_fallback_violations(changed_files)

    if surface_violations or fallback_violations:
        print("FAIL: doc-as-code pairing")
        for violation in surface_violations:
            print(f"  - {_format_violation(violation)}")
        for line in fallback_violations:
            print(f"  - {line}")
        print(
            f"INFO: '{SKIP_MARKER}' in the HEAD commit message waives this check only "
            "when validating committed history on a clean tree; it does not apply to "
            "a pre-commit run, whose changes HEAD does not yet contain"
        )
        return 1

    print("PASS: doc-as-code pairing")
    print(
        "INFO: doc-as-code pairing validated "
        f"for {len(changed_files)} changed file(s) from {source}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
